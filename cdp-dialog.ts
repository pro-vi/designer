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
    try {
      // tolerateDuplicateUrl: a duplicate tab at the same URL must not throw — the
      // guard is best-effort; a wrong/failed pick simply means the navigation isn't
      // guarded (degrades to the prior behavior), never a crash.
      const resolved: CdpSessionOptions = { tolerateDuplicateUrl: true, ...opts };
      const { ws, target } = await BeforeUnloadAccepter.connectTarget(resolved);
      const accepter = new BeforeUnloadAccepter(ws, target, resolved);
      await accepter.start();
      return accepter;
    } catch {
      return null;
    }
  }

  async start(): Promise<void> {
    await this.enableDomains();
  }

  // Only Page is needed; skip the base's Network buffering for a one-shot guard.
  protected override async enableDomains(): Promise<void> {
    await this.send('Page.enable');
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
