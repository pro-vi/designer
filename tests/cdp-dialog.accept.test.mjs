import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldAcceptBeforeUnload } from '../cdp-dialog.ts';

// The beforeunload auto-accept guard (2026-06-30): claude.ai's design-canvas
// raises a native "Leave site? Changes you made may not be saved." modal when the
// editor is dirty; with it up, designer's create/resume Page.navigate hangs
// forever. The accepter answers Page.javascriptDialogOpening of type 'beforeunload'
// with accept:true. shouldAcceptBeforeUnload is the pure decision — it must answer
// ONLY the navigation-guard modal, never an alert/confirm/prompt (content dialogs
// that aren't ours to auto-answer), and never a non-dialog event.

test('accepts the beforeunload navigation-guard dialog', () => {
  assert.equal(shouldAcceptBeforeUnload('Page.javascriptDialogOpening', { type: 'beforeunload' }), true);
  // extra fields (message/url/defaultPrompt) don't change the decision
  assert.equal(
    shouldAcceptBeforeUnload('Page.javascriptDialogOpening', { type: 'beforeunload', message: '', url: 'https://claude.ai/design' }),
    true
  );
});

test('does NOT auto-answer content dialogs (alert/confirm/prompt)', () => {
  for (const type of ['alert', 'confirm', 'prompt']) {
    assert.equal(shouldAcceptBeforeUnload('Page.javascriptDialogOpening', { type }), false, `${type} must not be auto-accepted`);
  }
});

test('ignores non-dialog CDP events', () => {
  assert.equal(shouldAcceptBeforeUnload('Page.loadEventFired', { type: 'beforeunload' }), false, 'wrong method must not match');
  assert.equal(shouldAcceptBeforeUnload('Network.responseReceived', {}), false);
});

test('is defensive on malformed params (no throw, no false-accept)', () => {
  assert.equal(shouldAcceptBeforeUnload('Page.javascriptDialogOpening', null), false);
  assert.equal(shouldAcceptBeforeUnload('Page.javascriptDialogOpening', undefined), false);
  assert.equal(shouldAcceptBeforeUnload('Page.javascriptDialogOpening', {}), false, 'no type => not the guard modal');
  assert.equal(shouldAcceptBeforeUnload('Page.javascriptDialogOpening', 'beforeunload'), false, 'non-object params');
});
