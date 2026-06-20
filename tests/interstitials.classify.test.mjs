import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyInterstitial, plannedAction, CONTINUE_HERE_TEXT } from '../interstitials.ts';

// A normal in-session page (composer + chat) carries none of the interstitials.
test('a clean session page classifies as no interstitial', () => {
  assert.equal(
    classifyInterstitial({
      bodyText: 'Claude\nHere is your design. direction-dock.html 12 pages Tweaks Present Share Export',
      buttonTexts: ['Send', 'Share', 'Export', 'Tweaks']
    }),
    null
  );
});

test('the 495k-token banner classifies as token-banner when Continue here is present', () => {
  assert.equal(
    classifyInterstitial({
      bodyText: 'Start a new chat to save 483k tokens of context',
      buttonTexts: ['New chat', CONTINUE_HERE_TEXT, 'Send']
    }),
    'token-banner'
  );
});

test('the token-banner phrase WITHOUT a Continue here button does not classify', () => {
  // The phrase can echo in chat history; only an actionable button means act.
  assert.equal(
    classifyInterstitial({
      bodyText: 'earlier I saw "Start a new chat to save 483k tokens of context" in the nudge',
      buttonTexts: ['Send', 'Share']
    }),
    null
  );
});

test('token-banner detection is case-insensitive and matches varied counts', () => {
  for (const n of ['1k', '12k', '999k']) {
    assert.equal(
      classifyInterstitial({
        bodyText: `START A NEW CHAT TO SAVE ${n} TOKENS OF CONTEXT`,
        buttonTexts: ['Continue here']
      }),
      'token-banner'
    );
  }
});

test('"Something went wrong" needs a corroborating action phrase to classify', () => {
  // Bare phrase (could appear inline anywhere) → no needless reload.
  assert.equal(
    classifyInterstitial({ bodyText: 'Something went wrong in the generated copy', buttonTexts: [] }),
    null
  );
  // With "Try again" → transient-error.
  assert.equal(
    classifyInterstitial({
      bodyText: 'Something went wrong\nPlease try again in a moment',
      buttonTexts: ['Try again']
    }),
    'transient-error'
  );
  // With "Back to projects" → transient-error.
  assert.equal(
    classifyInterstitial({
      bodyText: 'Something went wrong\nBack to projects',
      buttonTexts: ['Back to projects']
    }),
    'transient-error'
  );
});

test('the Cloudflare bot-check classifies as cloudflare', () => {
  assert.equal(
    classifyInterstitial({
      bodyText: 'claude.ai\nVerify you are human by completing the action below.',
      buttonTexts: []
    }),
    'cloudflare'
  );
  assert.equal(
    classifyInterstitial({
      bodyText: 'Performing security verification…',
      buttonTexts: []
    }),
    'cloudflare'
  );
});

test('Cloudflare wins over a co-present token banner (severity order)', () => {
  assert.equal(
    classifyInterstitial({
      bodyText: 'Verify you are human\nStart a new chat to save 483k tokens of context',
      buttonTexts: ['Continue here']
    }),
    'cloudflare'
  );
});

test('plannedAction maps each kind to its handling strategy', () => {
  assert.equal(plannedAction('token-banner'), 'click-continue');
  assert.equal(plannedAction('transient-error'), 'reload');
  assert.equal(plannedAction('cloudflare'), 'await-human');
});

test('empty / degraded probe is treated as clear', () => {
  assert.equal(classifyInterstitial({ bodyText: '', buttonTexts: [] }), null);
});
