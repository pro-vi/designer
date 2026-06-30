import assert from 'node:assert/strict';
import test from 'node:test';

import { isPreviewIframeSrc, previewIframeVariant, isBootstrapShellHtml } from '../preview-host.ts';
import { SESSION_URL_RE } from '../designer-controller.ts';
import { UI_ANCHORS } from '../ui-anchors.ts';

// Regression coverage for the 2026-06 claude.ai/design entry-layer drift
// (issue #61): the preview iframe moved off the signed `?t=` token onto a
// per-project `<uuid>.claudeusercontent.com/_bootstrap` subdomain.

const SIGNED = 'https://claudeusercontent.com/abc123/index.html?t=eyJhbGciOiJ';
const BOOTSTRAP = 'https://72e73856-7b63-4aed-b95a-caca5e3c0e05.claudeusercontent.com/_bootstrap?v=2';

test('isPreviewIframeSrc accepts both the legacy signed-token and new bootstrap-subdomain forms', () => {
  assert.equal(isPreviewIframeSrc(SIGNED), true, 'legacy signed ?t= form');
  assert.equal(isPreviewIframeSrc(BOOTSTRAP), true, 'new per-project _bootstrap subdomain');
});

test('isPreviewIframeSrc rejects a preview that left claudeusercontent.com (real drift)', () => {
  assert.equal(isPreviewIframeSrc(''), false);
  assert.equal(isPreviewIframeSrc('https://claude.ai/design/p/abc'), false);
  assert.equal(isPreviewIframeSrc('https://evil.example.com/?t=x'), false);
});

test('isPreviewIframeSrc is a hostname check, not a substring match (host-spoof drift)', () => {
  // Suffix-attached host — substring match would wrongly accept these.
  assert.equal(isPreviewIframeSrc('https://claudeusercontent.com.evil.test/_bootstrap'), false);
  assert.equal(isPreviewIframeSrc('https://evil-claudeusercontent.com/_bootstrap'), false);
  // claudeusercontent.com only in the path/query, not the host.
  assert.equal(isPreviewIframeSrc('https://evil.test/?u=claudeusercontent.com'), false);
  assert.equal(isPreviewIframeSrc('https://evil.test/claudeusercontent.com/x'), false);
  // Genuine apex + subdomain still accepted.
  assert.equal(isPreviewIframeSrc('https://claudeusercontent.com/abc?t=tok'), true);
  assert.equal(isPreviewIframeSrc('https://72e7.claudeusercontent.com/_bootstrap'), true);
});

test('previewIframeVariant labels which addressing scheme matched', () => {
  assert.equal(previewIframeVariant(SIGNED), 'signed-token');
  assert.equal(previewIframeVariant(BOOTSTRAP), 'bootstrap-subdomain');
  assert.equal(previewIframeVariant('https://sub.claudeusercontent.com/foo.html'), 'other');
});

// The OOPIF read probe (session.oopifPreviewRead) fails when the capture returns
// the loader shell instead of rendered HTML; isBootstrapShellHtml is that check.
test('isBootstrapShellHtml detects the loader shell by its postMessage init signature', () => {
  const shell =
    '<!doctype html><meta charset=utf-8><title>.</title><script>(function(){var ALLOWED=["https://claude.ai"];window.addEventListener("message",function(e){if(e.data&&e.data.type==="omelette-preview-init"){}});})()</script>';
  assert.equal(isBootstrapShellHtml(shell), true);
});

test('isBootstrapShellHtml treats rendered HTML and empty/no-sample as not-a-shell', () => {
  assert.equal(isBootstrapShellHtml('<!doctype html><html><body><h1>Casefile Overview</h1></body></html>'), false);
  assert.equal(isBootstrapShellHtml(''), false); // "no sample" must not read as a shell
  // Defensive on non-string input (reader returns null → caller handles separately).
  assert.equal(isBootstrapShellHtml(/** @type {any} */ (null)), false);
});

test('isBootstrapShellHtml is size-bounded — a large design documenting the protocol is not a shell', () => {
  // A rendered design that legitimately mentions the marker (e.g. a doc explaining
  // omelette-preview-init) but is far larger than the ~1.1KB loader → not a shell.
  const bigDesign = '<!doctype html><html><body>' + 'x'.repeat(5000) + 'omelette-preview-init</body></html>';
  assert.equal(isBootstrapShellHtml(bigDesign), false);
});

test('SESSION_URL_RE matches a /design/p/<uuid> tab and captures the project id', () => {
  const url = 'https://claude.ai/design/p/72e73856-7b63-4aed-b95a-caca5e3c0e05?file=index.html';
  const m = url.match(SESSION_URL_RE);
  assert.ok(m, 'should match a session URL');
  assert.equal(m[1], '72e73856-7b63-4aed-b95a-caca5e3c0e05');
});

test('SESSION_URL_RE rejects the home and non-design URLs', () => {
  assert.equal(SESSION_URL_RE.test('https://claude.ai/design'), false);
  assert.equal(SESSION_URL_RE.test('https://claude.ai/design/'), false);
  assert.equal(SESSION_URL_RE.test('https://claude.ai/chat/p/abc'), false);
  assert.equal(SESSION_URL_RE.test('https://example.com/design/p/abc'), false);
});

// login.signedIn health diagnostic (inbox #73 proposal #3): when the signed-in
// marker is missing but the app shell IS rendering, the probe must say "selector
// DRIFT, not signed out" rather than sending the user to re-login — the dead end
// the fract-ai report hit on a stale build. The verdict stays `fail` either way;
// only the guidance changes. `evalValue(expr)` is the sole browser call these
// checks make, so a stub that decides from the evaluated expression exercises
// them without a live page.
const anchor = (id) => {
  const a = UI_ANCHORS.find((x) => x.id === id);
  if (!a) throw new Error(`anchor not found: ${id}`);
  return a;
};
const stubBrowser = (decide) => ({ evalValue: async (expr) => decide(expr) });

test('login.signedIn: signed-in marker present on /design => ok', async () => {
  // The marker probe (signedInIndicator) matches; shell probe never reached.
  const b = stubBrowser((expr) => /chat-composer-input|title="Create"/.test(expr));
  const r = await anchor('login.signedIn').check(b, 'https://claude.ai/design');
  assert.equal(r.ok, true);
});

test('login.signedIn: marker missing but app shell rendering => SELECTOR DRIFT, not signed out', async () => {
  // Marker probe fails; the shell probe (project link / home heading) succeeds.
  const b = stubBrowser((expr) => /what will you design|design\/p\//.test(expr));
  const r = await anchor('login.signedIn').check(b, 'https://claude.ai/design');
  assert.equal(r.ok, false);
  assert.match(r.detail, /SELECTOR DRIFT/);
  assert.doesNotMatch(r.detail, /designer setup/); // must NOT send the user to re-login
});

test('login.signedIn: marker missing and no app shell => genuinely signed out', async () => {
  const b = stubBrowser(() => false);
  const r = await anchor('login.signedIn').check(b, 'https://claude.ai/design');
  assert.equal(r.ok, false);
  assert.match(r.detail, /signed out/);
});

test('login.signedIn: explicit /login URL => signed out without probing the DOM', async () => {
  let touched = false;
  const b = stubBrowser(() => {
    touched = true;
    return true;
  });
  const r = await anchor('login.signedIn').check(b, 'https://claude.ai/login?returnTo=%2Fdesign');
  assert.equal(r.ok, false);
  assert.equal(touched, false, 'URL login wall is decided without a DOM probe');
});
