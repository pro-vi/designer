import assert from 'node:assert/strict';
import test from 'node:test';
import { captureOopifHtml, OopifHtmlReader } from '../oopif-reader.ts';
import { isPreviewIframeSrc } from '../preview-host.ts';

// The bug (review #4, live-verified): in the 2026-06 bootstrap regime the
// preview iframe is a CROSS-ORIGIN out-of-process frame (OOPIF). A node-side
// fetch of its filename-agnostic `<uuid>.claudeusercontent.com/_bootstrap` URL
// returns the SAME ~1146-byte unauthenticated loader shell for every file —
// never the rendered HTML. The fix reads the OOPIF's rendered DOM via CDP
// (Target.setAutoAttach{flatten:true} -> match child by isPreviewIframeSrc ->
// Runtime.evaluate(outerHTML, returnByValue) on the CHILD sessionId).
//
// captureOopifHtml is the PURE, CI-testable orchestrator: it owns the CDP
// command sequence but takes an INJECTED send primitive + an injected
// attachedTargets() snapshot, so it runs with no live browser.

const SHELL = '<html><head></head><body><script src="/_bootstrap-loader.js"></script></body></html>';
const SRC_A = 'https://abc-uuid.claudeusercontent.com/_bootstrap?file=a';
const SRC_B = 'https://abc-uuid.claudeusercontent.com/_bootstrap?file=b';

// A fake CDP send that records every call and serves scripted child responses
// keyed by sessionId. childHtml maps sessionId -> outerHTML for Runtime.evaluate.
function fakeSend({ childHtml = {}, domHtml = {}, throwOn = null, evalException = new Set() } = {}) {
  const calls = [];
  const send = async (method, params, sessionId) => {
    calls.push({ method, params, sessionId });
    if (throwOn && method === throwOn) throw new Error(`scripted reject for ${method}`);
    if (method === 'Target.setAutoAttach') return {};
    if (method === 'Runtime.evaluate') {
      if (sessionId && evalException.has(sessionId)) {
        return { result: { type: 'undefined' }, exceptionDetails: { text: 'boom' } };
      }
      const html = sessionId ? childHtml[sessionId] : undefined;
      // No sessionId => evaluated on the PARENT page => would return shell.
      if (html === undefined) return { result: { type: 'string', value: sessionId ? '' : SHELL } };
      return { result: { type: 'string', value: html } };
    }
    if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
    if (method === 'DOM.getOuterHTML') {
      const html = sessionId ? domHtml[sessionId] : undefined;
      return { outerHTML: html ?? '' };
    }
    return {};
  };
  send.calls = calls;
  return send;
}

const childA = { sessionId: 'sidA', url: SRC_A, type: 'iframe' };
const childB = { sessionId: 'sidB', url: SRC_B, type: 'iframe' };
const noise = { sessionId: 'sidX', url: 'about:blank', type: 'iframe' };
const analytics = { sessionId: 'sidY', url: 'https://analytics.example.com/p', type: 'page' };

test('captureOopifHtml returns the OOPIF rendered HTML for the matching preview child', async () => {
  const send = fakeSend({ childHtml: { sidA: '<html><!--file-A-marker--></html>' } });
  const html = await captureOopifHtml(send, {
    attachedTargets: () => [noise, childA, analytics],
    isPreviewUrl: isPreviewIframeSrc,
    wantUrl: SRC_A,
    waitForAttachMs: 50
  });
  assert.equal(html, '<html><!--file-A-marker--></html>');
});

test('ROUTING: Runtime.evaluate is sent on the OOPIF child sessionId, not the parent page', async () => {
  const send = fakeSend({ childHtml: { sidA: '<html><!--file-A-marker--></html>' } });
  await captureOopifHtml(send, {
    attachedTargets: () => [childA],
    isPreviewUrl: isPreviewIframeSrc,
    wantUrl: SRC_A,
    waitForAttachMs: 50
  });
  const evalCall = send.calls.find((c) => c.method === 'Runtime.evaluate');
  assert.ok(evalCall, 'Runtime.evaluate must be sent');
  assert.equal(evalCall.sessionId, 'sidA', 'must carry the OOPIF child sessionId or it reads the parent shell');
});

test('DIVERGENCE: two distinct files yield distinct non-shell HTML (the bug being fixed)', async () => {
  const send = fakeSend({
    childHtml: {
      sidA: '<html><body>file-A-marker</body></html>',
      sidB: '<html><body>file-B-marker</body></html>'
    }
  });
  const opts = {
    attachedTargets: () => [childA, childB],
    isPreviewUrl: isPreviewIframeSrc,
    waitForAttachMs: 50
  };
  const htmlA = await captureOopifHtml(send, { ...opts, wantUrl: SRC_A });
  const htmlB = await captureOopifHtml(send, { ...opts, wantUrl: SRC_B });
  assert.notEqual(htmlA, htmlB, 'distinct files must produce distinct HTML');
  assert.notEqual(htmlA, SHELL);
  assert.notEqual(htmlB, SHELL);
  assert.ok(htmlA.includes('file-A-marker'));
  assert.ok(htmlB.includes('file-B-marker'));
});

test('records setAutoAttach{autoAttach:true,flatten:true} and tears down with autoAttach:false', async () => {
  const send = fakeSend({ childHtml: { sidA: '<html>A</html>' } });
  await captureOopifHtml(send, {
    attachedTargets: () => [childA],
    isPreviewUrl: isPreviewIframeSrc,
    wantUrl: SRC_A,
    waitForAttachMs: 50
  });
  const auto = send.calls.filter((c) => c.method === 'Target.setAutoAttach');
  assert.ok(auto.some((c) => c.params?.autoAttach === true && c.params?.flatten === true), 'must arm autoAttach with flatten');
  assert.ok(auto.some((c) => c.params?.autoAttach === false), 'must tear down autoAttach');
});

test('NEGATIVE: no preview child matches -> returns null (caller falls back), no throw', async () => {
  const send = fakeSend({});
  const html = await captureOopifHtml(send, {
    attachedTargets: () => [noise, analytics],
    isPreviewUrl: isPreviewIframeSrc,
    waitForAttachMs: 30
  });
  assert.equal(html, null);
});

test('FALLBACK: Runtime.evaluate exception -> DOM.getOuterHTML on the same child session', async () => {
  const send = fakeSend({
    evalException: new Set(['sidA']),
    domHtml: { sidA: '<html><body>dom-fallback-A</body></html>' }
  });
  const html = await captureOopifHtml(send, {
    attachedTargets: () => [childA],
    isPreviewUrl: isPreviewIframeSrc,
    wantUrl: SRC_A,
    waitForAttachMs: 50
  });
  assert.equal(html, '<html><body>dom-fallback-A</body></html>');
  const domCall = send.calls.find((c) => c.method === 'DOM.getOuterHTML');
  assert.equal(domCall?.sessionId, 'sidA');
});

test('NEGATIVE: empty evaluate value AND empty DOM fallback -> null', async () => {
  const send = fakeSend({ evalException: new Set(['sidA']), domHtml: { sidA: '' } });
  const html = await captureOopifHtml(send, {
    attachedTargets: () => [childA],
    isPreviewUrl: isPreviewIframeSrc,
    wantUrl: SRC_A,
    waitForAttachMs: 50
  });
  assert.equal(html, null);
});

test('NEGATIVE: send rejects -> returns null, never throws', async () => {
  const send = fakeSend({ throwOn: 'Runtime.evaluate', childHtml: { sidA: '<html>A</html>' } });
  const html = await captureOopifHtml(send, {
    attachedTargets: () => [childA],
    isPreviewUrl: isPreviewIframeSrc,
    wantUrl: SRC_A,
    waitForAttachMs: 50
  });
  assert.equal(html, null);
});

test('a non-preview child (about:blank / analytics) is ignored even when present first', async () => {
  const send = fakeSend({ childHtml: { sidA: '<html><body>real</body></html>', sidX: '<html>blank</html>' } });
  const html = await captureOopifHtml(send, {
    attachedTargets: () => [noise, childA],
    isPreviewUrl: isPreviewIframeSrc,
    waitForAttachMs: 50
  });
  assert.equal(html, '<html><body>real</body></html>');
});

// ---- Subclass test: OopifHtmlReader over a fake WebSocket (real onMessage/onEvent wiring) ----

const target = {
  id: 'target-1',
  type: 'page',
  title: 'Designer',
  url: 'https://claude.ai/design/p/test',
  webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/target-1'
};

// A fake socket that auto-replies to id-bearing sends, and lets the test push
// CDP events (Target.attachedToTarget, etc.) through the message channel.
function fakeSocket({ onSend } = {}) {
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
      const reply = onSend ? onSend(msg) : {};
      queueMicrotask(() => {
        for (const cb of listeners.get('message') || []) {
          cb({ data: JSON.stringify({ id: msg.id, result: reply ?? {} }) });
        }
      });
    },
    emit(event) {
      for (const cb of listeners.get('message') || []) cb({ data: JSON.stringify(event) });
    },
    close() {
      this.closeCount++;
      for (const cb of listeners.get('close') || []) cb({});
    }
  };
  return socket;
}

test('OopifHtmlReader: onEvent buffers attachedToTarget and readPreviewHtml reads via the child session', async () => {
  const childUrl = SRC_A;
  const onSend = (msg) => {
    if (msg.method === 'Runtime.evaluate' && msg.sessionId === 'child-sess') {
      return { result: { type: 'string', value: '<html><body>subclass-A</body></html>' } };
    }
    if (msg.method === 'Runtime.evaluate') {
      // parent-session evaluate would return the shell — must not be used.
      return { result: { type: 'string', value: SHELL } };
    }
    return {};
  };
  const socket = fakeSocket({ onSend });
  const reader = new OopifHtmlReader(socket, target, { reconnect: false });
  // simulate the OOPIF attaching
  socket.emit({
    method: 'Target.attachedToTarget',
    params: { sessionId: 'child-sess', targetInfo: { url: childUrl, type: 'iframe' } }
  });
  const html = await reader.readPreviewHtml(childUrl);
  assert.equal(html, '<html><body>subclass-A</body></html>');
  reader.close();
  const auto = socket.sent.filter((m) => m.method === 'Target.setAutoAttach');
  assert.ok(auto.some((m) => m.params?.autoAttach === false), 'teardown must disable autoAttach');
});

test('OopifHtmlReader: detachedFromTarget drops a stale session so it is not read', async () => {
  const socket = fakeSocket({
    onSend: (msg) => (msg.method === 'Runtime.evaluate' ? { result: { type: 'string', value: '<html>stale</html>' } } : {})
  });
  const reader = new OopifHtmlReader(socket, target, { reconnect: false });
  socket.emit({
    method: 'Target.attachedToTarget',
    params: { sessionId: 'child-sess', targetInfo: { url: SRC_A, type: 'iframe' } }
  });
  socket.emit({ method: 'Target.detachedFromTarget', params: { sessionId: 'child-sess' } });
  const html = await reader.readPreviewHtml(SRC_A);
  assert.equal(html, null, 'a detached OOPIF session must not be evaluated against');
  reader.close();
});
