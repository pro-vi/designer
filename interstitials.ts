// Interstitial detection for claude.ai/design.
//
// The 2026-06 design UI interrupts the automated flow with content-only overlays
// that carry no stable data-testid or ARIA role — they can only be matched by
// their visible content. Each verb runs a pre-flight (DesignerController.
// clearInterstitials, wired through ensureReady) so automation doesn't silently
// stall on a banner, misread a frozen view as "done", or call a transient error
// a context ceiling. Captured live 2026-06-19 against Chrome 149.
//
// Detection lives here — pure and unit-tested — so the copy heuristics have one
// source of truth; the DOM/CDP glue (probe + click/reload/wait) stays in the
// controller. This mirrors preview-host.ts / run-state.ts: classify in a tested
// module, act in the controller.
//
// STRUCTURAL GUARD (review #1): the two TAKEOVER kinds (cloudflare,
// transient-error) replace the whole app shell, so they're classified ONLY when
// the shell is gone — `appShellPresent === false`. Without this, a design session
// whose chat transcript mentions "verify you are human" (an auth/CAPTCHA mockup)
// or "something went wrong … try again" (a Claude apology) would be misread as a
// real overlay and hard-block every verb. The token banner is benign (it sits
// over a live shell) and is gated on its own action button instead.

export type InterstitialKind = 'token-banner' | 'transient-error' | 'cloudflare';

export type InterstitialAction = 'click-continue' | 'reload' | 'await-human';

export interface InterstitialProbe {
  /** document.body.innerText (the caller may truncate it). */
  bodyText: string;
  /** Trimmed textContent of every <button> currently in the DOM. */
  buttonTexts: string[];
  /** True when the app shell (composer or chat-messages) is rendered. A real
   *  Cloudflare / "Something went wrong" takeover removes it; the token banner
   *  leaves it. Distinguishes a true overlay from transcript text mentioning
   *  the same phrases. */
  appShellPresent: boolean;
}

export interface InterstitialReport {
  /** True when the page carries no unresolved BLOCKING interstitial. A residual
   *  token banner (benign — shell stays usable) is still ok:true. */
  ok: boolean;
  /** Interstitials confirmed cleared (re-probed), in order. */
  handled: InterstitialKind[];
  /** A BLOCKING interstitial still present after handling (unsolved Cloudflare,
   *  or a transient error that survived reloads), or null. Never token-banner —
   *  that's non-blocking. */
  blocked: InterstitialKind | null;
}

export interface ClassifyOpts {
  /** Override the token-banner action-button text (selectors.interstitials.
   *  continueHere). Threaded so detection and the click stay on ONE source of
   *  truth — otherwise an operator override would let the click target drift
   *  from what the classifier gates on (review #3b). */
  continueHere?: string;
}

// A single DOM read producing the InterstitialProbe shape. Exported as the ONE
// source so the live pre-flight (designer-controller) and the CI diagnostic
// (ci-health) probe identically — including the appShellPresent guard (review
// #5 / below-gate dedup). Evaluated via browser.evalValue.
export const INTERSTITIAL_PROBE_EXPR = `(() => ({
  bodyText: ((document.body && document.body.innerText) || '').slice(0, 20000),
  buttonTexts: Array.from(document.querySelectorAll('button'))
    .map((b) => (b.textContent || '').trim())
    .filter(Boolean)
    .slice(0, 300),
  appShellPresent: !!document.querySelector('[data-testid="chat-composer-input"], [data-testid="chat-messages"]')
}))()`;

// Cloudflare bot-check / "verify you are human" takeover. The most blocking of
// the three — it replaces the app shell and can't be auto-solved, only waited
// out (it often self-clears) or handed to a human.
export const CLOUDFLARE_RE =
  /verify you are human|performing security verification|review the security of your connection|checking your browser before|needs to review the security/i;

// Transient "Something went wrong" error page. Gated on app-shell-absence AND a
// real action button (review #1) so an inline "something went wrong" string in
// the transcript can't trip a reload storm.
export const TRANSIENT_ERROR_RE = /something went wrong/i;
export const TRANSIENT_ERROR_BUTTON_RE = /^(try again|back to projects)$/i;

// Context-save nudge: "Start a new chat to save 483k tokens of context" with
// New chat / Continue here. We click "Continue here" to keep the session's
// context — "New chat" would discard it.
export const TOKEN_BANNER_RE = /start a new chat to save\b|save \d+k tokens of context/i;
export const CONTINUE_HERE_TEXT = 'Continue here';

function hasButtonText(buttonTexts: string[], text: string): boolean {
  const want = text.trim().toLowerCase();
  return buttonTexts.some((t) => (t || '').trim().toLowerCase() === want);
}

function hasButtonMatching(buttonTexts: string[], re: RegExp): boolean {
  return buttonTexts.some((t) => re.test((t || '').trim()));
}

/**
 * Classify the most pressing interstitial present, or null when the page is
 * clear. Order is by severity: a Cloudflare takeover hides everything beneath
 * it, so it's checked first; the token banner is the most benign (the composer
 * stays usable beneath it) so it's checked last. Takeover kinds require the app
 * shell to be ABSENT (see module header); the token banner requires its action
 * button to be present (the phrase alone — e.g. echoed in chat — is not enough).
 */
export function classifyInterstitial(probe: InterstitialProbe, opts: ClassifyOpts = {}): InterstitialKind | null {
  const body = probe.bodyText || '';
  const buttons = probe.buttonTexts || [];
  if (!probe.appShellPresent) {
    if (CLOUDFLARE_RE.test(body)) return 'cloudflare';
    if (TRANSIENT_ERROR_RE.test(body) && hasButtonMatching(buttons, TRANSIENT_ERROR_BUTTON_RE)) return 'transient-error';
  }
  if (TOKEN_BANNER_RE.test(body) && hasButtonText(buttons, opts.continueHere || CONTINUE_HERE_TEXT)) return 'token-banner';
  return null;
}

/** The handling strategy for each interstitial kind. */
export function plannedAction(kind: InterstitialKind): InterstitialAction {
  switch (kind) {
    case 'token-banner':
      return 'click-continue';
    case 'transient-error':
      return 'reload';
    case 'cloudflare':
      return 'await-human';
  }
}

/** Blocking interstitials make a verb impossible; the token banner does not
 *  (the shell stays usable beneath it), so a residual one is never fatal. */
export function isBlockingInterstitial(kind: InterstitialKind): boolean {
  return kind !== 'token-banner';
}
