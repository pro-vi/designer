import { CdpSession, type CdpSessionOptions, type CdpTarget } from './cdp-trace.ts';
import { isPreviewIframeSrc } from './preview-host.ts';

// OOPIF preview-HTML reader (issue #61 / PR #66 review #4, live-verified).
//
// The 2026-06 redesign serves the design preview from a per-project
// `<uuid>.claudeusercontent.com/_bootstrap` iframe with NO signed token. It is
// CROSS-ORIGIN to claude.ai, so it loads as an out-of-process iframe (OOPIF):
//   - a node-side fetch (no claude.ai cookies) returns the same ~1146-byte
//     unauthenticated loader shell for every file — never the rendered HTML;
//   - the parent page JS cannot read iframe.contentDocument (cross-origin).
// The rendered DOM only exists inside the OOPIF, reachable via CDP:
//   Target.setAutoAttach{flatten:true} -> match the child by
//   isPreviewIframeSrc(targetInfo.url) -> Runtime.evaluate(outerHTML,
//   returnByValue) on the CHILD sessionId. `flatten:true` multiplexes the
//   child-session traffic over the single page-target socket CdpSession already
//   opens; send()/onMessage/onEvent already thread the sessionId envelope
//   (cdp-trace.ts) — this is the upgrade path that file's header reserved.
//
// captureOopifHtml is the PURE orchestrator (no socket/timer ownership) so the
// command sequence is unit-testable against a fake send + fake target snapshot.
// OopifHtmlReader is the short-lived (reconnect:false) CdpSession that wires it
// to a live page target. ANY failure degrades to null so callers fall back to
// the legacy node fetch and behave exactly as before.

export type CdpSendFn = (method: string, params?: unknown, sessionId?: string) => Promise<unknown>;

export interface AttachedChild {
  sessionId: string;
  url: string;
  type: string;
}

export interface CaptureOopifHtmlOpts {
  attachedTargets: () => AttachedChild[];
  isPreviewUrl: (u: string) => boolean;
  wantUrl?: string;
  waitForAttachMs?: number;
  pollMs?: number;
  now?: () => number;
}

function asRec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function evaluatedString(result: unknown): string | null {
  const rec = asRec(result);
  // An exceptionDetails means the evaluate threw — treat as no value so the
  // caller falls through to the DOM fallback.
  if (rec.exceptionDetails) return null;
  const inner = asRec(rec.result);
  return typeof inner.value === 'string' ? inner.value : null;
}

// Pick the preview child: isPreviewUrl is the PRIMARY key (type labels for
// OOPIFs drift across Chrome versions, so type is a soft hint only). When the
// exact preview src is known, prefer the child whose url matches it.
function pickPreviewChild(children: AttachedChild[], isPreviewUrl: (u: string) => boolean, wantUrl?: string): AttachedChild | null {
  const previews = children.filter((c) => typeof c.url === 'string' && isPreviewUrl(c.url));
  if (previews.length === 0) return null;
  if (wantUrl) {
    const exact = previews.find((c) => c.url === wantUrl);
    if (exact) return exact;
  }
  return previews[0] ?? null;
}

/**
 * PURE orchestrator for reading a cross-origin preview OOPIF's rendered HTML.
 * Owns the CDP command sequence but not the socket or timers (bounded polling
 * via opts.now). Returns the rendered outerHTML string, or null on no-match /
 * no-value / any throw — never throws.
 */
export async function captureOopifHtml(send: CdpSendFn, opts: CaptureOopifHtmlOpts): Promise<string | null> {
  const now = opts.now ?? (() => Date.now());
  const waitForAttachMs = opts.waitForAttachMs ?? 1500;
  const pollMs = opts.pollMs ?? 25;
  let armed = false;
  try {
    // (a) arm auto-attach. flatten:true is LOAD-BEARING — without it Chrome
    // routes child traffic via the deprecated nested sendMessageToTarget the
    // base send() does not speak. waitForDebuggerOnStart:false so OOPIFs aren't
    // paused.
    await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    armed = true;

    // (b) bounded-poll the injected snapshot for the preview child.
    const deadline = now() + waitForAttachMs;
    let child = pickPreviewChild(opts.attachedTargets(), opts.isPreviewUrl, opts.wantUrl);
    while (!child && now() < deadline) {
      await new Promise((r) => setTimeout(r, pollMs));
      child = pickPreviewChild(opts.attachedTargets(), opts.isPreviewUrl, opts.wantUrl);
    }
    if (!child) return null;

    // (c) PRIMARY: Runtime.evaluate(outerHTML) on the CHILD sessionId. Sending
    // without the sessionId would silently evaluate in the parent page and
    // return the shell — the routing assertion the unit test guards.
    const evalRes = await send(
      'Runtime.evaluate',
      { expression: 'document.documentElement.outerHTML', returnByValue: true, awaitPromise: false },
      child.sessionId
    );
    const value = evaluatedString(evalRes);
    if (value) return value;

    // (d) FALLBACK: empty/exception -> DOM.getDocument + DOM.getOuterHTML on the
    // same child session.
    await send('DOM.enable', undefined, child.sessionId);
    const doc = asRec(await send('DOM.getDocument', { depth: -1, pierce: false }, child.sessionId));
    const root = asRec(doc.root);
    const nodeId = typeof root.nodeId === 'number' ? root.nodeId : null;
    if (nodeId === null) return null;
    const outer = asRec(await send('DOM.getOuterHTML', { nodeId }, child.sessionId));
    return typeof outer.outerHTML === 'string' && outer.outerHTML.length > 0 ? outer.outerHTML : null;
  } catch {
    return null;
  } finally {
    // (e) ALWAYS tear down auto-attach (best-effort).
    if (armed) {
      await send('Target.setAutoAttach', { autoAttach: false, waitForDebuggerOnStart: false, flatten: true }).catch(() => {});
    }
  }
}

export class OopifHtmlReader extends CdpSession {
  private readonly childTargets = new Map<string, AttachedChild>();

  constructor(ws: WebSocket, target: CdpTarget, opts: CdpSessionOptions = {}) {
    // One-shot reader: default reconnect:false (a mid-capture gap degrades to
    // null -> node-fetch fallback; there is no one-shot terminal to recover).
    super(ws, target, { reconnect: false, ...opts });
  }

  static async attach(opts: CdpSessionOptions = {}): Promise<OopifHtmlReader | null> {
    if (typeof WebSocket === 'undefined') return null;
    try {
      const { ws, target } = await OopifHtmlReader.connectTarget(opts);
      return new OopifHtmlReader(ws, target, opts);
    } catch {
      return null;
    }
  }

  // No Network.enable for a one-shot OOPIF read; captureOopifHtml issues the
  // Target.setAutoAttach itself so the pure unit owns the full sequence.
  protected override async enableDomains(): Promise<void> {}

  protected onEvent(method: string, params: unknown, _sessionId?: string): void {
    const p = asRec(params);
    if (method === 'Target.attachedToTarget') {
      const sessionId = typeof p.sessionId === 'string' ? p.sessionId : '';
      const info = asRec(p.targetInfo);
      const url = typeof info.url === 'string' ? info.url : '';
      const type = typeof info.type === 'string' ? info.type : '';
      if (sessionId) this.childTargets.set(sessionId, { sessionId, url, type });
      return;
    }
    if (method === 'Target.detachedFromTarget') {
      const sessionId = typeof p.sessionId === 'string' ? p.sessionId : '';
      if (sessionId) this.childTargets.delete(sessionId);
    }
  }

  async readPreviewHtml(wantUrl: string): Promise<string | null> {
    return captureOopifHtml(this.send.bind(this), {
      attachedTargets: () => [...this.childTargets.values()],
      isPreviewUrl: isPreviewIframeSrc,
      wantUrl
    });
  }
}
