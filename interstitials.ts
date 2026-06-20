// Interstitial detection for claude.ai/design.
//
// The 2026-06 design UI interrupts the automated flow with transient overlays
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

export type InterstitialKind = 'token-banner' | 'transient-error' | 'cloudflare';

export type InterstitialAction = 'click-continue' | 'reload' | 'await-human';

export interface InterstitialProbe {
  /** document.body.innerText (the caller may truncate it). */
  bodyText: string;
  /** Trimmed textContent of every <button> currently in the DOM. */
  buttonTexts: string[];
}

export interface InterstitialReport {
  /** True when the page carries no unresolved interstitial. */
  ok: boolean;
  /** Interstitials acted on, in the order they were cleared. */
  handled: InterstitialKind[];
  /** An interstitial still present after handling (e.g. an unsolved Cloudflare
   *  challenge, or one whose action target vanished), or null when clear. */
  blocked: InterstitialKind | null;
}

// Cloudflare bot-check / "verify you are human" takeover. The most blocking of
// the three — it replaces the app shell and can't be auto-solved, only waited
// out (it often self-clears) or handed to a human.
export const CLOUDFLARE_RE =
  /verify you are human|performing security verification|review the security of your connection|checking your browser before|needs to review the security/i;

// Transient "Something went wrong" error page. Require a corroborating action
// phrase so an unrelated inline "something went wrong" string elsewhere on the
// page doesn't trip a needless reload.
export const TRANSIENT_ERROR_RE = /something went wrong/i;
export const TRANSIENT_ERROR_CORROBORANT_RE = /try again|back to projects/i;

// Context-save nudge: "Start a new chat to save 483k tokens of context" with
// New chat / Continue here. We click "Continue here" to keep the session's
// context — "New chat" would discard it.
export const TOKEN_BANNER_RE = /start a new chat to save\b|save \d+k tokens of context/i;
export const CONTINUE_HERE_TEXT = 'Continue here';

function hasContinueHere(buttonTexts: string[]): boolean {
  const want = CONTINUE_HERE_TEXT.toLowerCase();
  return buttonTexts.some((t) => (t || '').trim().toLowerCase() === want);
}

/**
 * Classify the most pressing interstitial present, or null when the page is
 * clear. Order is by severity: a Cloudflare takeover hides everything beneath
 * it, so it's checked first; the token banner is the most benign (the composer
 * stays usable beneath it) so it's checked last. The token banner additionally
 * requires its "Continue here" button to be present — the phrase alone (e.g.
 * echoed in chat history) is not enough to act on.
 */
export function classifyInterstitial(probe: InterstitialProbe): InterstitialKind | null {
  const body = probe.bodyText || '';
  if (CLOUDFLARE_RE.test(body)) return 'cloudflare';
  if (TRANSIENT_ERROR_RE.test(body) && TRANSIENT_ERROR_CORROBORANT_RE.test(body)) return 'transient-error';
  if (TOKEN_BANNER_RE.test(body) && hasContinueHere(probe.buttonTexts)) return 'token-banner';
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
