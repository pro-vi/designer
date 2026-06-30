import { CdpSession, asRec, type CdpTarget, type CdpSessionOptions } from './cdp-trace.ts';

// Auto-dismisses the native "Leave site? Changes you made may not be saved."
// beforeunload modal that claude.ai's design-canvas raises when its editor is
// dirty (unsaved edits + recent user activation). Live-verified 2026-06-30: with
// that modal up, designer's create/resume navigation (agent-browser's
// browser.open -> Page.navigate) blocks FOREVER, because the navigate waits for a
// button click that nothing makes — the create-flow hang.
//
// A CDP client with the Page domain enabled receives Page.javascriptDialogOpening
// and can answer it with Page.handleJavaScriptDialog. The dialog is target-global,
// so THIS client dismisses it even though agent-browser (a separate CDP client on
// the same tab) issued the navigate that triggered it.
//
// accept:true == clicking "Leave". That discards whatever the dirty flag tracks,
// which is the right call here: (a) navigating away is the EXPLICIT intent of
// create/resume; (b) claude.ai persists design content server-side (generations
// save; the export reflects saved state), so the dirty flag is ephemeral editor/
// view state, not the user's work; and (c) auto-CANCEL would keep the page and
// defeat the navigation entirely — accept is the only answer that lets designer
// navigate at all. Callers arm it around ONE navigation and close() it right after,
// and it only answers `beforeunload` (never alert/confirm/prompt, which aren't
// ours to decide). CDP-gated by the caller, like every other CDP entry point.

// Pure decision: is this CDP event the beforeunload navigation-guard modal we
// auto-accept? Kept separate from the socket so it is unit-testable without CDP.
// Only `beforeunload` — an alert/confirm/prompt carries content semantics this
// guard must not answer blind.
export function shouldAcceptBeforeUnload(method: string, params: unknown): boolean {
  if (method !== 'Page.javascriptDialogOpening') return false;
  return asRec(params).type === 'beforeunload';
}

// Bound a CDP call so a live-but-silent socket can't hang the guard. The base
// CdpSession.send() has no timeout (only the WS *open* is bounded), so a wedged
// Chrome that never answers Page.enable would otherwise hang attach() BEFORE the
// navigation even starts — strictly worse than a plain open() (second-opinion
// 2026-06-30, H3). Reject on timeout so attach()'s catch degrades to no-guard.
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export class BeforeUnloadAccepter extends CdpSession {
  private accepted = 0;

  constructor(ws: WebSocket, target: CdpTarget, opts: CdpSessionOptions = {}) {
    // reconnect:false — a one-shot guard around a single navigation. The tab
    // target keeps its targetId across the navigation, so the socket stays live;
    // a genuine gap just ends the guard (the next navigation re-arms it).
    super(ws, target, { ...opts, reconnect: false });
  }

  static async attach(opts: CdpSessionOptions = {}): Promise<BeforeUnloadAccepter | null> {
    if (typeof WebSocket === 'undefined') return null;
    let accepter: BeforeUnloadAccepter | null = null;
    try {
      // tolerateDuplicateUrl DEFAULTS FALSE here (unlike the read-only OOPIF
      // reader): for a dialog accepter, a WRONG-tab pick is materially worse than
      // no guard — it would arm auto-accept on an unrelated tab AND miss the real
      // dialog (second-opinion 2026-06-30, H3). On a duplicate-URL ambiguity,
      // connectTarget throws -> we degrade to no-guard (a plain open), never an
      // arbitrary tab. Callers can still override.
      const resolved: CdpSessionOptions = { tolerateDuplicateUrl: false, ...opts };
      const { ws, target } = await BeforeUnloadAccepter.connectTarget(resolved);
      accepter = new BeforeUnloadAccepter(ws, target, resolved);
      await accepter.start();
      return accepter;
    } catch {
      // Close the socket if start() (the bounded Page.enable) failed/timed out, so
      // a failed attach can't leak a half-open Page-enabled client on a tab.
      accepter?.close();
      return null;
    }
  }

  async start(): Promise<void> {
    await this.enableDomains();
  }

  // Only Page is needed; skip the base's Network buffering for a one-shot guard.
  // Bounded so a wedged-but-open socket degrades to no-guard instead of hanging
  // the navigation before it starts (second-opinion 2026-06-30, H3).
  protected override async enableDomains(): Promise<void> {
    await withTimeout(this.send('Page.enable'), 2000, 'Page.enable');
  }

  // Count of dialogs auto-accepted this session (diagnostic / test signal).
  get acceptedCount(): number {
    return this.accepted;
  }

  protected onEvent(method: string, params: unknown): void {
    if (!shouldAcceptBeforeUnload(method, params)) return;
    this.accepted++;
    // Fire-and-forget: dismiss so the blocked Page.navigate proceeds. A reject
    // (socket already closing) is harmless — the navigation either completed or
    // will be re-armed next time.
    void this.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
  }
}
