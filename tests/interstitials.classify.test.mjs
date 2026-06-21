import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyInterstitial, plannedAction, isBlockingInterstitial, CONTINUE_HERE_TEXT } from '../interstitials.ts';

// Probe builder — defaults to a healthy session (app shell present) so each test
// states only what it varies. Takeover kinds require appShellPresent:false.
function probe({ bodyText = '', buttonTexts = [], appShellPresent = true } = {}) {
  return { bodyText, buttonTexts, appShellPresent };
}

test('a clean session page classifies as no interstitial', () => {
  assert.equal(
    classifyInterstitial(
      probe({
        bodyText: 'Claude\nHere is your design. direction-dock.html 12 pages Tweaks Present Share Export',
        buttonTexts: ['Send', 'Share', 'Export', 'Tweaks']
      })
    ),
    null
  );
});

test('the 495k-token banner classifies as token-banner when Continue here is present', () => {
  assert.equal(
    classifyInterstitial(
      probe({
        bodyText: 'Start a new chat to save 483k tokens of context',
        buttonTexts: ['New chat', CONTINUE_HERE_TEXT, 'Send']
      })
    ),
    'token-banner'
  );
});

test('the token-banner phrase WITHOUT a Continue here button does not classify', () => {
  // The phrase can echo in chat history; only an actionable button means act.
  assert.equal(
    classifyInterstitial(
      probe({
        bodyText: 'earlier I saw "Start a new chat to save 483k tokens of context" in the nudge',
        buttonTexts: ['Send', 'Share']
      })
    ),
    null
  );
});

test('token-banner detection is case-insensitive and matches varied counts', () => {
  for (const n of ['1k', '12k', '999k']) {
    assert.equal(
      classifyInterstitial(probe({ bodyText: `START A NEW CHAT TO SAVE ${n} TOKENS OF CONTEXT`, buttonTexts: ['Continue here'] })),
      'token-banner'
    );
  }
});

// --- Structural guard (review #1): takeover kinds require app-shell-absent -----

test('transcript text that MENTIONS a takeover is NOT classified while the shell is up', () => {
  // A user designing an auth/CAPTCHA screen; Claude's reply is in body.innerText.
  assert.equal(
    classifyInterstitial(
      probe({
        bodyText: 'Claude\nFor the CAPTCHA screen add a "Verify you are human" heading and a checkbox.',
        buttonTexts: ['Send', 'Share'],
        appShellPresent: true
      })
    ),
    null,
    'cloudflare phrase in transcript must not block a healthy session'
  );
  // A Claude apology in the transcript with a "Try again" affordance.
  assert.equal(
    classifyInterstitial(
      probe({
        bodyText: 'Claude\nSomething went wrong on my end — let me try again.',
        buttonTexts: ['Try again', 'Send'],
        appShellPresent: true
      })
    ),
    null,
    'transient-error phrase in transcript must not trigger a reload storm'
  );
});

test('a real Cloudflare takeover (shell gone) classifies as cloudflare', () => {
  assert.equal(
    classifyInterstitial(probe({ bodyText: 'claude.ai\nVerify you are human by completing the action below.', appShellPresent: false })),
    'cloudflare'
  );
  assert.equal(classifyInterstitial(probe({ bodyText: 'Performing security verification…', appShellPresent: false })), 'cloudflare');
});

test('transient-error requires shell-absent AND a real action button', () => {
  // Shell gone + phrase + button → transient-error.
  assert.equal(
    classifyInterstitial(probe({ bodyText: 'Something went wrong', buttonTexts: ['Try again'], appShellPresent: false })),
    'transient-error'
  );
  assert.equal(
    classifyInterstitial(probe({ bodyText: 'Something went wrong', buttonTexts: ['Back to projects'], appShellPresent: false })),
    'transient-error'
  );
  // Shell gone + phrase but NO action button → not classified (avoid blind reload).
  assert.equal(classifyInterstitial(probe({ bodyText: 'Something went wrong', buttonTexts: [], appShellPresent: false })), null);
});

test('Cloudflare wins over a co-present token banner (severity order)', () => {
  assert.equal(
    classifyInterstitial(
      probe({
        bodyText: 'Verify you are human\nStart a new chat to save 483k tokens of context',
        buttonTexts: ['Continue here'],
        appShellPresent: false
      })
    ),
    'cloudflare'
  );
});

// --- Override threading (review #3b): detection honors selectors override ------

test('a configured continueHere override is honored by the classifier', () => {
  const p = probe({ bodyText: 'Start a new chat to save 200k tokens of context', buttonTexts: ['Weiter hier', 'Neuer Chat'] });
  // Default text would miss the renamed button → null.
  assert.equal(classifyInterstitial(p), null);
  // With the override, the same page classifies as token-banner.
  assert.equal(classifyInterstitial(p, { continueHere: 'Weiter hier' }), 'token-banner');
});

test('plannedAction maps each kind to its handling strategy', () => {
  assert.equal(plannedAction('token-banner'), 'click-continue');
  assert.equal(plannedAction('transient-error'), 'reload');
  assert.equal(plannedAction('cloudflare'), 'await-human');
});

test('isBlockingInterstitial: token-banner is benign, takeovers block', () => {
  assert.equal(isBlockingInterstitial('token-banner'), false);
  assert.equal(isBlockingInterstitial('transient-error'), true);
  assert.equal(isBlockingInterstitial('cloudflare'), true);
});

test('empty / degraded probe is treated as clear', () => {
  assert.equal(classifyInterstitial(probe({})), null);
});
