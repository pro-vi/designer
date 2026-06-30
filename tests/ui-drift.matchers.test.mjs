import assert from 'node:assert/strict';
import test from 'node:test';

import { isPreviewIframeSrc, previewIframeVariant } from '../preview-host.ts';
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

// Regression coverage for the 2026-06-30 signed-in detection drift (issue #73
// inbox): the redesigned "What will you design today?" home dropped ALL
// data-testids, so the old chat-composer-input signed-in marker false-failed as
// "signed out" even for fully signed-in users. The fix re-anchors detection on
// the account-menu avatar (present on home AND session) and teaches the health
// probe to distinguish real selector drift from a genuine login wall.
//
// `evalValue(expr)` is the only browser method these anchor checks call; a stub
// that decides truthiness from the evaluated expression text exercises them
// without a live page.
const anchor = (id) => {
  const a = UI_ANCHORS.find((x) => x.id === id);
  if (!a) throw new Error(`anchor not found: ${id}`);
  return a;
};
const stubBrowser = (decide) => ({ evalValue: async (expr) => decide(expr) });

test('login.signedIn: account-menu marker on a /design URL => signed in (home or session)', async () => {
  const b = stubBrowser((expr) => expr.includes('Account menu'));
  const r = await anchor('login.signedIn').check(b, 'https://claude.ai/design');
  assert.equal(r.ok, true);
});

test('login.signedIn: marker missing but app shell rendering => SELECTOR DRIFT, not signed out', async () => {
  // account-menu probe fails; the shell-present probe (textarea / project links /
  // heading) succeeds — exactly the redesigned-home drift state.
  const b = stubBrowser((expr) => !expr.includes('Account menu'));
  const r = await anchor('login.signedIn').check(b, 'https://claude.ai/design');
  assert.equal(r.ok, false);
  assert.match(r.detail, /SELECTOR DRIFT/);
  assert.doesNotMatch(r.detail, /designer setup/); // must NOT send the user to re-login
});

test('login.signedIn: no marker and no app shell => genuinely signed out', async () => {
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

test('home.creator anchors the sole home <textarea> (home dropped all data-testids)', async () => {
  const b = stubBrowser((expr) => expr.includes('textarea'));
  const r = await anchor('home.creator').check(b, 'https://claude.ai/design');
  assert.equal(r.ok, true);
});

test('home.createButton anchors button[title="Create"], not the in-session chat-send-button', async () => {
  const b = stubBrowser((expr) => expr.includes('Create'));
  const r = await anchor('home.createButton').check(b, 'https://claude.ai/design');
  assert.equal(r.ok, true);
});
