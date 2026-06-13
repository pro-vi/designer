import assert from 'node:assert/strict';
import test from 'node:test';
import { OMELETTE_TURN_SERVICE, RunStateObserver } from '../run-state.ts';

const target = {
  id: 'target-1',
  type: 'page',
  title: 'Designer',
  url: 'https://claude.ai/design/p/test',
  webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/target-1'
};

function fakeSocket() {
  const listeners = new Map();
  const socket = {
    closeCount: 0,
    sent: [],
    addEventListener(type, cb) {
      const cbs = listeners.get(type) || [];
      cbs.push(cb);
      listeners.set(type, cbs);
    },
    removeEventListener(type, cb) {
      const cbs = listeners.get(type) || [];
      listeners.set(type, cbs.filter((x) => x !== cb));
    },
    send(raw) {
      const msg = JSON.parse(raw);
      this.sent.push(msg);
      queueMicrotask(() => {
        for (const cb of listeners.get('message') || []) cb({ data: JSON.stringify({ id: msg.id, result: {} }) });
      });
    },
    close() {
      this.closeCount++;
      for (const cb of listeners.get('close') || []) cb({});
    }
  };
  return socket;
}

function harness() {
  let now = 1_000;
  const socket = fakeSocket();
  const observer = new RunStateObserver(socket, target, { now: () => now, reconnect: false });
  return {
    observer,
    socket,
    advance(ms) {
      now += ms;
    },
    get now() {
      return now;
    }
  };
}

test('activity marks running, silence marks stalled, and later activity recovers', () => {
  const h = harness();
  h.observer.beginRun();
  h.advance(10);
  h.observer.consumeSignalForTest({ kind: 'chat-open' });
  assert.equal(h.observer.state, 'running');

  h.advance(26);
  h.observer.tickForTest({ stallMs: 25, hardTimeoutMs: 100 });
  assert.equal(h.observer.state, 'stalled');

  h.observer.consumeSignalForTest({ kind: 'heartbeat' });
  assert.equal(h.observer.state, 'running');
});

test('release is ignored until a prior run signal and then finishes', async () => {
  const h = harness();
  h.observer.beginRun();
  h.observer.consumeSignalForTest({ kind: 'release' });
  assert.equal(h.observer.state, 'running');

  const done = h.observer.awaitTerminal({ stallMs: 25, hardTimeoutMs: 100 });
  h.advance(5);
  h.observer.consumeSignalForTest({ kind: 'heartbeat' });
  h.advance(5);
  h.observer.consumeSignalForTest({ kind: 'release' });

  assert.deepEqual(await done, { terminal: 'finished', elapsedMs: 10 });
  assert.equal(h.observer.state, 'finished');
  assert.equal(h.socket.closeCount, 1);
  assert.equal(h.observer.closeCountForTest(), 1);
});

test('release from stalled finishes and late failures cannot flip the latch', async () => {
  const h = harness();
  h.observer.beginRun();
  h.observer.consumeSignalForTest({ kind: 'chat-open' });
  h.advance(30);
  h.observer.tickForTest({ stallMs: 25, hardTimeoutMs: 100 });
  assert.equal(h.observer.state, 'stalled');

  const done = h.observer.awaitTerminal({ stallMs: 25, hardTimeoutMs: 100 });
  h.observer.consumeSignalForTest({ kind: 'release' });
  h.observer.consumeSignalForTest({ kind: 'critical-error', rpc: 'Chat', status: 500 });
  h.observer.consumeSignalForTest({ kind: 'release' });

  assert.deepEqual(await done, { terminal: 'finished', elapsedMs: 30 });
  assert.equal(h.observer.state, 'finished');
  assert.equal(h.socket.closeCount, 1);
});

test('critical errors block from running and stalled states', async () => {
  const running = harness();
  running.observer.beginRun();
  const runningDone = running.observer.awaitTerminal({ stallMs: 25, hardTimeoutMs: 100 });
  running.observer.consumeSignalForTest({ kind: 'critical-error', rpc: 'Chat', status: 500 });
  assert.deepEqual(await runningDone, { terminal: 'blocked', elapsedMs: 0, reason: 'Chat HTTP 500' });

  const stalled = harness();
  stalled.observer.beginRun();
  stalled.observer.consumeSignalForTest({ kind: 'heartbeat' });
  stalled.advance(30);
  stalled.observer.tickForTest({ stallMs: 25, hardTimeoutMs: 100 });
  assert.equal(stalled.observer.state, 'stalled');
  const stalledDone = stalled.observer.awaitTerminal({ stallMs: 25, hardTimeoutMs: 100 });
  stalled.observer.consumeSignalForTest({ kind: 'critical-error', rpc: 'RenewTurn', status: 'failed' });
  assert.deepEqual(await stalledDone, { terminal: 'blocked', elapsedMs: 30, reason: 'RenewTurn failed' });
});

test('silence hard-timeout latches from running and stalled states', async () => {
  const running = harness();
  running.observer.beginRun();
  const runningDone = running.observer.awaitTerminal({ stallMs: 25, hardTimeoutMs: 100 });
  running.advance(101);
  running.observer.tickForTest({ stallMs: 25, hardTimeoutMs: 100 });
  assert.deepEqual(await runningDone, { terminal: 'timeout', elapsedMs: 101, reason: 'silent for 101ms' });

  const stalled = harness();
  stalled.observer.beginRun();
  stalled.advance(30);
  stalled.observer.tickForTest({ stallMs: 25, hardTimeoutMs: 100 });
  assert.equal(stalled.observer.state, 'stalled');
  const stalledDone = stalled.observer.awaitTerminal({ stallMs: 25, hardTimeoutMs: 100 });
  stalled.advance(71);
  stalled.observer.tickForTest({ stallMs: 25, hardTimeoutMs: 100 });
  assert.deepEqual(await stalledDone, { terminal: 'timeout', elapsedMs: 101, reason: 'silent for 101ms' });
});

test('observer-lost latches and explicit close remains idempotent', async () => {
  const h = harness();
  h.observer.beginRun();
  const done = h.observer.awaitTerminal({ stallMs: 25, hardTimeoutMs: 100 });
  h.advance(7);
  h.observer.consumeSignalForTest({ kind: 'observer-lost' });
  h.observer.close();
  h.observer.close();

  assert.deepEqual(await done, { terminal: 'observer-lost', elapsedMs: 7 });
  assert.equal(h.socket.closeCount, 1);
  assert.equal(h.observer.closeCountForTest(), 1);
});

test('onEvent tracks Chat request ids so dataReceived becomes chat-chunk', async () => {
  const h = harness();
  const base = `https://claude.ai/api/${OMELETTE_TURN_SERVICE}`;
  h.observer.beginRun();
  h.observer.onEvent('Network.requestWillBeSent', {
    ts: h.now,
    requestId: 'chat-1',
    request: { url: `${base}/Chat`, method: 'POST' }
  });
  h.advance(3);
  h.observer.onEvent('Network.dataReceived', { requestId: 'chat-1', dataLength: 42 });
  assert.equal(h.observer.state, 'running');

  const done = h.observer.awaitTerminal({ stallMs: 25, hardTimeoutMs: 100 });
  h.advance(4);
  h.observer.onEvent('Network.requestWillBeSent', {
    ts: h.now,
    requestId: 'release-1',
    request: { url: `${base}/ReleaseTurn`, method: 'POST' }
  });
  assert.deepEqual(await done, { terminal: 'finished', elapsedMs: 7 });
});

test('pre-begin and stale request ids do not count as this run activity', () => {
  const h = harness();
  const base = `https://claude.ai/api/${OMELETTE_TURN_SERVICE}`;
  h.observer.onEvent('Network.requestWillBeSent', {
    ts: h.now,
    requestId: 'old-chat-before-begin',
    request: { url: `${base}/Chat`, method: 'POST' }
  });
  h.observer.beginRun();
  h.observer.onEvent('Network.dataReceived', { requestId: 'old-chat-before-begin', dataLength: 42 });
  h.observer.onEvent('Network.requestWillBeSent', {
    ts: h.now - 1,
    requestId: 'old-chat-after-begin',
    request: { url: `${base}/Chat`, method: 'POST' }
  });
  h.observer.onEvent('Network.dataReceived', { requestId: 'old-chat-after-begin', dataLength: 42 });
  h.observer.consumeSignalForTest({ kind: 'release' });

  assert.equal(h.observer.state, 'running');
  assert.deepEqual(h.observer.signalSummary(), {
    chatOpen: 0,
    chatChunk: 0,
    heartbeat: 0,
    release: 1,
    criticalError: 0,
    observerLost: 0,
    observedRpcPaths: []
  });
});

test('a CDP gap during an active run degrades to observer-lost (missed-release safety)', async () => {
  const h = harness();
  h.observer.beginRun();
  h.observer.consumeSignalForTest({ kind: 'chat-open' });
  assert.equal(h.observer.state, 'running');

  const done = h.observer.awaitTerminal({ stallMs: 25, hardTimeoutMs: 100 });
  h.advance(5);
  h.observer.socketGapForTest();

  assert.deepEqual(await done, { terminal: 'observer-lost', elapsedMs: 5 });
  assert.equal(h.observer.state, 'observer-lost');
});

test('a CDP gap before the run begins does not latch the observer', () => {
  const h = harness();
  h.observer.socketGapForTest();
  assert.equal(h.observer.state, 'idle');

  h.observer.beginRun();
  h.observer.consumeSignalForTest({ kind: 'chat-open' });
  assert.equal(h.observer.state, 'running');
});

test('absolute wall-clock cap latches a heartbeating-but-unreleased run', async () => {
  const h = harness();
  h.observer.beginRun();
  const done = h.observer.awaitTerminal({ stallMs: 25, hardTimeoutMs: 100 });
  // Keep silence below the stall window while elapsed crosses the hard cap.
  h.advance(90);
  h.observer.consumeSignalForTest({ kind: 'heartbeat' });
  h.advance(15);
  h.observer.tickForTest({ stallMs: 25, hardTimeoutMs: 100 });

  assert.deepEqual(await done, {
    terminal: 'timeout',
    elapsedMs: 105,
    reason: 'exceeded 100ms wall-clock budget (elapsed 105ms)'
  });
});

test('a stale critical-error (no prior run requestWillBeSent) does not block', () => {
  const h = harness();
  const base = `https://claude.ai/api/${OMELETTE_TURN_SERVICE}`;
  h.observer.beginRun();
  h.observer.consumeSignalForTest({ kind: 'chat-open' });
  // A late 4xx for a Chat request never seen this run — wallTime-less, so the
  // classify stale-guard can't catch it; the run-membership guard must.
  h.observer.onEvent('Network.responseReceived', {
    requestId: 'stale-chat',
    response: { url: `${base}/Chat`, status: 500 }
  });
  assert.equal(h.observer.state, 'running');
});

test('a current-run critical-error responseReceived latches blocked', async () => {
  const h = harness();
  const base = `https://claude.ai/api/${OMELETTE_TURN_SERVICE}`;
  h.observer.beginRun();
  const done = h.observer.awaitTerminal({ stallMs: 25, hardTimeoutMs: 100 });
  h.observer.onEvent('Network.requestWillBeSent', {
    ts: h.now,
    requestId: 'chat-9',
    request: { url: `${base}/Chat`, method: 'POST' }
  });
  h.observer.onEvent('Network.responseReceived', {
    requestId: 'chat-9',
    response: { url: `${base}/Chat`, status: 500 }
  });
  assert.deepEqual(await done, { terminal: 'blocked', elapsedMs: 0, reason: 'Chat HTTP 500' });
});

test('observer-lost before beginRun reports elapsedMs 0 (not epoch millis)', async () => {
  const h = harness();
  h.observer.consumeSignalForTest({ kind: 'observer-lost' });
  assert.deepEqual(await h.observer.awaitTerminal({ stallMs: 25, hardTimeoutMs: 100 }), {
    terminal: 'observer-lost',
    elapsedMs: 0
  });
});
