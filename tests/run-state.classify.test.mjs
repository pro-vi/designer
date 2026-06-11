import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyEvent, observedRpcPathFromUrl, OMELETTE_TURN_SERVICE, turnRpcFromUrl } from '../run-state.ts';

const start = Date.now();
const base = `https://claude.ai/api/${OMELETTE_TURN_SERVICE}`;

function req(requestId, rpc, at = start + 1) {
  return {
    method: 'Network.requestWillBeSent',
    params: {
      ts: at,
      requestId,
      request: { url: `${base}/${rpc}`, method: 'POST' }
    }
  };
}

function replay(events, runStartTs = start) {
  const urls = new Map();
  const signals = [];
  for (const ev of events) {
    const params = { ...ev.params };
    if (ev.method === 'Network.requestWillBeSent' && typeof params.requestId === 'string') {
      const url = params.request?.url;
      if (typeof url === 'string') urls.set(params.requestId, url);
    } else if (typeof params.requestId === 'string' && urls.has(params.requestId)) {
      params.requestUrl = urls.get(params.requestId);
    }
    const signal = classifyEvent(ev.method, params, runStartTs);
    if (signal) signals.push(signal);
  }
  return signals;
}

test('classifies a successful turn lifecycle from trace-shaped events', () => {
  const signals = replay([
    req('chat-1', 'Chat'),
    { method: 'Network.dataReceived', params: { ts: start + 2, requestId: 'chat-1', dataLength: 10 } },
    req('renew-1', 'RenewTurn', start + 10_000),
    req('renew-2', 'RenewTurn', start + 20_000),
    req('release-1', 'ReleaseTurn', start + 25_000)
  ]);

  assert.equal(signals.filter((s) => s.kind === 'chat-open').length, 1);
  assert.equal(signals.filter((s) => s.kind === 'chat-chunk').length, 1);
  assert.equal(signals.filter((s) => s.kind === 'heartbeat').length, 2);
  assert.equal(signals.filter((s) => s.kind === 'release').length, 1);
});

test('ignores stale events before the run start timestamp', () => {
  const signal = classifyEvent('Network.requestWillBeSent', req('old-release', 'ReleaseTurn', start - 1).params, start);
  assert.equal(signal, null);
});

test('classifies critical RPC failures and ignores non-critical failures', () => {
  const chatFailure = classifyEvent(
    'Network.loadingFailed',
    { ts: start + 1, requestId: 'chat-1', requestUrl: `${base}/Chat`, errorText: 'net::ERR_FAILED' },
    start
  );
  assert.deepEqual(chatFailure, { kind: 'critical-error', rpc: 'Chat', status: 'failed' });

  const updateConflict = classifyEvent(
    'Network.responseReceived',
    {
      ts: start + 1,
      requestId: 'update-1',
      response: { url: `${base.replace('/OmeletteService', '')}/ProjectService/UpdateProjectData`, status: 409 }
    },
    start
  );
  assert.equal(updateConflict, null);
});

test('renamed turn RPCs fail classification but remain visible for health detail', () => {
  const renamed = `${base}/CompleteTurn`;
  assert.equal(turnRpcFromUrl(renamed), null);
  assert.equal(observedRpcPathFromUrl(renamed), `${OMELETTE_TURN_SERVICE}/CompleteTurn`);
});
