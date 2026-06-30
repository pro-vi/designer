import assert from 'node:assert/strict';
import test from 'node:test';
import { captureOopifHtml, OopifHtmlReader } from '../oopif-reader.ts';
import { isPreviewIframeSrc } from '../preview-host.ts';

// The bug (review #4, live-verified): in the 2026-06 bootstrap regime the preview
// iframe is a CROSS-ORIGIN out-of-process frame (OOPIF). A node-side fetch of the
// iframe element's `_bootstrap` src returns the SAME ~1146-byte unauthenticated
// loader shell for every file — never the rendered HTML. The fix reads the OOPIF's
// rendered DOM via CDP (Target.setAutoAttach{flatten:true} -> the unique preview-
// host child -> serialize on the CHILD sessionId).
//
// Hardened per PR #67 review: DOM.getOuterHTML is the PRIMARY serializer (Runtime
// .evaluate is the fallback); selection is the UNIQUE preview-host child (zero or
// many -> null, never an arbitrary/stale frame); every CDP call is timeout-bounded;
// targetInfoChanged keeps child URLs current. (Live note: the OOPIF *document* URL
// is per-file `.../serve/<filename>`, not the iframe element's `_bootstrap` — so
// host+uniqueness, not URL-equality with getIframeSrc(), is the right signal.)
//
// captureOopifHtml is the PURE, CI-testable orchestrator: it owns the CDP command
// sequence but takes an INJECTED send + an injected attachedTargets() snapshot.

const SHELL = '<html><head></head><body><script src="/_bootstrap-loader.js"></script></body></html>';
// Per-file OOPIF document URLs (the real shape: .../serve/<filename>).
const SRC_A = 'https://abc-uuid.claudeusercontent.com/v1/design/projects/abc-uuid/serve/a.html?srcmap=1';
const SRC_B = 'https://abc-uuid.claudeusercontent.com/v1/design/projects/abc-uuid/serve/b.html?srcmap=1';

// A fake CDP send recording every call and serving scripted child responses keyed
// by sessionId. domHtml feeds the PRIMARY DOM.getOuterHTML path; childHtml feeds
// the Runtime.evaluate FALLBACK. hangOn never resolves (timeout coverage).
function fakeSend({ domHtml = {}, childHtml = {}, throwOn = new Set(), hangOn = new Set(), evalException = new Set() } = {}) {
  const calls = [];
  const send = async (method, params, sessionId) => {
    calls.push({ method, params, sessionId });
    if (hangOn.has(method)) return new Promise(() => {}); // never resolves
    if (throwOn.has(method)) throw new Error(`scripted reject for ${method}`);
    if (method === 'Target.setAutoAttach') return {};
    if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
    if (method === 'DOM.getOuterHTML') return { outerHTML: (sessionId && domHtml[sessionId]) || '' };
    if (method === 'Runtime.evaluate') {
      if (sessionId && evalException.has(sessionId)) {
        return { result: { type: 'undefined' }, exceptionDetails: { text: 'boom' } };
      }
      const html = sessionId ? childHtml[sessionId] : undefined;
      // No sessionId => evaluated on the PARENT page => would return the shell.
      if (html === undefined) return { result: { type: 'string', value: sessionId ? '' : SHELL } };
      return { result: { type: 'string', value: html } };
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

const base = { isPreviewUrl: isPreviewIframeSrc, waitForAttachMs: 50 };

test('captureOopifHtml returns the OOPIF rendered HTML for the unique preview child (DOM primary)', async () => {
  const send = fakeSend({ domHtml: { sidA: '<html><!--file-A-marker--></html>' } });
  const html = await captureOopifHtml(send, { ...base, attachedTargets: () => [noise, childA, analytics] });
  assert.equal(html, '<html><!--file-A-marker--></html>');
});

test('ROUTING: the serializer is sent on the OOPIF child sessionId, not the parent page', async () => {
  const send = fakeSend({ domHtml: { sidA: '<html><!--file-A-marker--></html>' } });
  await captureOopifHtml(send, { ...base, attachedTargets: () => [childA] });
  const domCall = send.calls.find((c) => c.method === 'DOM.getOuterHTML');
  assert.ok(domCall, 'DOM.getOuterHTML must be sent (primary path)');
  assert.equal(domCall.sessionId, 'sidA', 'must carry the OOPIF child sessionId or it reads the parent shell');
});

test('DIVERGENCE: distinct files (each its own preview) yield distinct non-shell HTML', async () => {
  const send = fakeSend({
    domHtml: { sidA: '<html><body>file-A-marker</body></html>', sidB: '<html><body>file-B-marker</body></html>' }
  });
  const htmlA = await captureOopifHtml(send, { ...base, attachedTargets: () => [childA] });
  const htmlB = await captureOopifHtml(send, { ...base, attachedTargets: () => [childB] });
  assert.notEqual(htmlA, htmlB, 'distinct files must produce distinct HTML');
  assert.notEqual(htmlA, SHELL);
  assert.notEqual(htmlB, SHELL);
  assert.ok(htmlA.includes('file-A-marker'));
  assert.ok(htmlB.includes('file-B-marker'));
});

test('records setAutoAttach{autoAttach:true,flatten:true} and tears down with autoAttach:false', async () => {
  const send = fakeSend({ domHtml: { sidA: '<html>A</html>' } });
  await captureOopifHtml(send, { ...base, attachedTargets: () => [childA] });
  const auto = send.calls.filter((c) => c.method === 'Target.setAutoAttach');
  assert.ok(auto.some((c) => c.params?.autoAttach === true && c.params?.flatten === true), 'must arm autoAttach with flatten');
  assert.ok(auto.some((c) => c.params?.autoAttach === false), 'must tear down autoAttach');
});

test('STRICT: multiple preview children for DIFFERENT files (old+new mid-switch) -> null, never a guess', async () => {
  const send = fakeSend({ domHtml: { sidA: '<html>A</html>', sidB: '<html>B</html>' } });
  const html = await captureOopifHtml(send, { ...base, attachedTargets: () => [childA, childB], waitForAttachMs: 30 });
  assert.equal(html, null, 'distinct serve filenames cannot be disambiguated -> null, not an arbitrary/stale frame');
});

test('DC DUAL-FRAME: two preview children for the SAME file (.dc.html token + _omeo frames) -> read one', async () => {
  // A .dc.html canvas renders the SAME file in two OOPIFs differing only in query
  // (a signed ?t= token frame and an _omeo frame), both identical content. The
  // old strict uniqueness floored this to null -> empty snapshot/iterate capture
  // (live regression 2026-06-30). Same /serve/<filename> => duplicate renders =>
  // pick one and read it, rather than bail.
  const SRC_A_TOKEN = 'https://abc-uuid.claudeusercontent.com/v1/design/projects/abc-uuid/serve/a.html?t=tok.abc.123&srcmap=1';
  const childAToken = { sessionId: 'sidAt', url: SRC_A_TOKEN, type: 'iframe' };
  const send = fakeSend({ domHtml: { sidA: '<html><body>dc-A-marker</body></html>', sidAt: '<html><body>dc-A-marker</body></html>' } });
  const html = await captureOopifHtml(send, { ...base, attachedTargets: () => [childA, childAToken], waitForAttachMs: 30 });
  assert.ok(html, 'two frames of the SAME file must read one, not null');
  assert.ok(html.includes('dc-A-marker'), 'must return the file content, not the shell');
  assert.notEqual(html, SHELL);
});

test('STRICT: a same-origin worker on claudeusercontent.com is ignored (iframe-type only)', async () => {
  // A generated preview can spawn a worker/service-worker on the same origin; it
  // must not count as a second "preview" and floor the read to null (#67 review).
  const worker = { sessionId: 'sidW', url: 'https://abc-uuid.claudeusercontent.com/worker.js', type: 'worker' };
  const send = fakeSend({ domHtml: { sidA: '<html><body>real</body></html>' } });
  const html = await captureOopifHtml(send, { ...base, attachedTargets: () => [worker, childA] });
  assert.equal(html, '<html><body>real</body></html>', 'the iframe doc is read; the same-origin worker is filtered out');
});

test('NEGATIVE: no preview child -> returns null (caller falls back), no throw', async () => {
  const send = fakeSend({});
  const html = await captureOopifHtml(send, { ...base, attachedTargets: () => [noise, analytics], waitForAttachMs: 30 });
  assert.equal(html, null);
});

test('FALLBACK: DOM serialization empty -> Runtime.evaluate on the same child session', async () => {
  // No domHtml -> DOM.getOuterHTML returns '' -> falls through to Runtime.
  const send = fakeSend({ childHtml: { sidA: '<html><body>runtime-fallback-A</body></html>' } });
  const html = await captureOopifHtml(send, { ...base, attachedTargets: () => [childA] });
  assert.equal(html, '<html><body>runtime-fallback-A</body></html>');
  const evalCall = send.calls.find((c) => c.method === 'Runtime.evaluate');
  assert.equal(evalCall?.sessionId, 'sidA');
});

test('FALLBACK: DOM.getDocument throws -> Runtime fallback still serves the child', async () => {
  const send = fakeSend({ throwOn: new Set(['DOM.getDocument']), childHtml: { sidA: '<html>rt</html>' } });
  const html = await captureOopifHtml(send, { ...base, attachedTargets: () => [childA] });
  assert.equal(html, '<html>rt</html>');
});

test('NEGATIVE: empty DOM AND empty/exception Runtime -> null', async () => {
  const send = fakeSend({ evalException: new Set(['sidA']) }); // no domHtml, eval throws
  const html = await captureOopifHtml(send, { ...base, attachedTargets: () => [childA] });
  assert.equal(html, null);
});

test('NEGATIVE: a send rejection anywhere in the read -> returns null, never throws', async () => {
  const send = fakeSend({ throwOn: new Set(['DOM.getDocument', 'Runtime.evaluate']) });
  const html = await captureOopifHtml(send, { ...base, attachedTargets: () => [childA] });
  assert.equal(html, null);
});

test('BOUNDED: a hanging CDP call times out -> null (never hangs)', async () => {
  const send = fakeSend({ hangOn: new Set(['DOM.getDocument', 'Runtime.evaluate']) });
  const started = Date.now();
  const html = await captureOopifHtml(send, { ...base, attachedTargets: () => [childA], waitForAttachMs: 30, sendTimeoutMs: 40 });
  assert.equal(html, null);
  assert.ok(Date.now() - started < 2000, 'must degrade quickly, not hang');
});

test('a non-preview child (about:blank / analytics) is ignored', async () => {
  const send = fakeSend({ domHtml: { sidA: '<html><body>real</body></html>' } });
  const html = await captureOopifHtml(send, { ...base, attachedTargets: () => [noise, childA] });
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

// A fake socket that auto-replies to id-bearing sends, and lets the test push CDP
// events (Target.attachedToTarget, etc.) through the message channel.
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

// DOM-primary onSend: serve DOM.getDocument/getOuterHTML for the given child session.
function domOnSend(childSessionId, html) {
  return (msg) => {
    if (msg.method === 'DOM.getDocument') return { root: { nodeId: 1 } };
    if (msg.method === 'DOM.getOuterHTML') return { outerHTML: msg.sessionId === childSessionId ? html : '' };
    return {};
  };
}

test('OopifHtmlReader: onEvent buffers attachedToTarget and readPreviewHtml reads via the child session', async () => {
  const socket = fakeSocket({ onSend: domOnSend('child-sess', '<html><body>subclass-A</body></html>') });
  const reader = new OopifHtmlReader(socket, target, { reconnect: false });
  socket.emit({
    method: 'Target.attachedToTarget',
    params: { sessionId: 'child-sess', targetInfo: { targetId: 't1', url: SRC_A, type: 'iframe' } }
  });
  const html = await reader.readPreviewHtml();
  assert.equal(html, '<html><body>subclass-A</body></html>');
  reader.close();
  const auto = socket.sent.filter((m) => m.method === 'Target.setAutoAttach');
  assert.ok(auto.some((m) => m.params?.autoAttach === false), 'teardown must disable autoAttach');
});

test('OopifHtmlReader: targetInfoChanged updates a blank->preview child so it becomes readable', async () => {
  const socket = fakeSocket({ onSend: domOnSend('child-sess', '<html><body>after-nav</body></html>') });
  const reader = new OopifHtmlReader(socket, target, { reconnect: false });
  // attaches as about:blank (not a preview host yet), then navigates to the serve URL.
  socket.emit({
    method: 'Target.attachedToTarget',
    params: { sessionId: 'child-sess', targetInfo: { targetId: 't1', url: 'about:blank', type: 'iframe' } }
  });
  socket.emit({
    method: 'Target.targetInfoChanged',
    params: { targetInfo: { targetId: 't1', url: SRC_A, type: 'iframe' } }
  });
  const html = await reader.readPreviewHtml();
  assert.equal(html, '<html><body>after-nav</body></html>', 'stale about:blank URL must be updated via targetInfoChanged');
  reader.close();
});

test('OopifHtmlReader: detachedFromTarget drops a stale session so it is not read', async () => {
  const socket = fakeSocket({ onSend: domOnSend('child-sess', '<html>stale</html>') });
  const reader = new OopifHtmlReader(socket, target, { reconnect: false });
  socket.emit({
    method: 'Target.attachedToTarget',
    params: { sessionId: 'child-sess', targetInfo: { targetId: 't1', url: SRC_A, type: 'iframe' } }
  });
  socket.emit({ method: 'Target.detachedFromTarget', params: { sessionId: 'child-sess' } });
  const html = await reader.readPreviewHtml();
  assert.equal(html, null, 'a detached OOPIF session must not be evaluated against');
  reader.close();
});
