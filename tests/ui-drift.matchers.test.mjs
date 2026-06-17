import assert from 'node:assert/strict';
import test from 'node:test';

import { isPreviewIframeSrc, previewIframeVariant } from '../ui-anchors.ts';
import { SESSION_URL_RE } from '../designer-controller.ts';

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
