import { CdpSession, type CdpSessionOptions, type CdpTarget } from './cdp-trace.ts';
import { isPreviewIframeSrc } from './preview-host.ts';

// OOPIF preview-HTML reader (issue #61 / PR #66 review #4, live-verified; hardened
// per PR #67 review).
//
// The 2026-06 redesign serves the design preview from a per-project
// `<uuid>.claudeusercontent.com/_bootstrap` iframe with NO signed token. It is
// CROSS-ORIGIN to claude.ai, so it loads as an out-of-process iframe (OOPIF):
//   - a node-side fetch (no claude.ai cookies) returns the same ~1146-byte
//     unauthenticated loader shell for every file — never the rendered HTML;
//   - the parent page JS cannot read iframe.contentDocument (cross-origin).
// The rendered DOM only exists inside the OOPIF, reachable via CDP:
//   Target.setAutoAttach{flatten:true} -> match the child by
//   isPreviewIframeSrc(targetInfo.url) -> serialize on the CHILD sessionId.
//   `flatten:true` multiplexes child-session traffic over the single page-target
//   socket CdpSession already opens; send()/onMessage/onEvent already thread the
//   sessionId envelope (cdp-trace.ts) — the upgrade path that file's header reserved.
//
// Hardening (PR #67 review):
//   - DOM.getDocument+DOM.getOuterHTML is the PRIMARY serializer (no page-world
//     execution context to depend on or be spoofed by); Runtime.evaluate is the
//     fallback.
//   - Child selection is strict: the project's single preview-host OOPIF is used
//     only when UNIQUE — zero or many (old+new during a switch) yields null, never
//     an arbitrary/stale frame served as the requested file. (The OOPIF document
//     URL is per-file, `/serve/<filename>`, not the iframe element's `_bootstrap`.)
//   - Every CDP call is timeout-bounded, so a live-but-silent socket degrades to
//     null instead of hanging forever.
//   - Target.targetInfoChanged keeps a child's URL current (about:blank -> _bootstrap,
//     or _bootstrap -> navigated away), keyed by targetId.
// ANY failure degrades to null so callers fall back to the legacy node fetch.

export type CdpSendFn = (method: string, params?: unknown, sessionId?: string) => Promise<unknown>;

export interface AttachedChild {
  sessionId: string;
  url: string;
  type: string;
  // Present when populated from Target.attachedToTarget; used to correlate
  // Target.targetInfoChanged URL updates. The pure orchestrator ignores it.
  targetId?: string;
}

export interface CaptureOopifHtmlOpts {
  attachedTargets: () => AttachedChild[];
  isPreviewUrl: (u: string) => boolean;
  waitForAttachMs?: number;
  pollMs?: number;
  sendTimeoutMs?: number;
  now?: () => number;
}

function asRec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function evaluatedString(result: unknown): string | null {
  const rec = asRec(result);
  // An exceptionDetails means the evaluate threw — treat as no value.
  if (rec.exceptionDetails) return null;
  const inner = asRec(rec.result);
  return typeof inner.value === 'string' && inner.value.length > 0 ? inner.value : null;
}

// Pick the preview child. The project renders its preview in a SINGLE OOPIF, so a
// unique preview-host child is unambiguously THE preview. Zero, or many (e.g. old
// and new preview coexisting during a file switch), -> null, so we never serve an
// arbitrary or stale frame as the requested file (PR #67 review).
//
// NOTE (live-verified): the OOPIF *document* URL is per-file
// (`…claudeusercontent.com/.../serve/<filename>?…`) — the `_bootstrap` is only the
// iframe element's src; the loader navigates the frame to the real serve URL. So
// matching the child against getIframeSrc() (`_bootstrap`) is wrong; host+uniqueness
// is the correct signal. A future multi-preview disambiguation can match the active
// file via that `/serve/<filename>` path, but single-preview is the steady state.
function pickPreviewChild(children: AttachedChild[], isPreviewUrl: (u: string) => boolean): AttachedChild | null {
  // type === 'iframe' guards against a same-origin worker/service-worker on
  // claudeusercontent.com counting as a second "preview" and flooring the read to
  // null (#67 review) — the preview is an iframe document, not a worker target.
  const previews = children.filter((c) => typeof c.url === 'string' && c.type === 'iframe' && isPreviewUrl(c.url));
  const only = previews[0];
  return previews.length === 1 && only ? only : null;
}

/**
 * PURE orchestrator for reading a cross-origin preview OOPIF's rendered HTML.
 * Owns the CDP command sequence but not the socket; every call is timeout-bounded
 * and bounded polling uses opts.now. Returns the serialized outerHTML string, or
 * null on no-match / no-value / timeout / any throw — never throws, never hangs.
 */
export async function captureOopifHtml(send: CdpSendFn, opts: CaptureOopifHtmlOpts): Promise<string | null> {
  const now = opts.now ?? (() => Date.now());
  const waitForAttachMs = opts.waitForAttachMs ?? 1500;
  const pollMs = opts.pollMs ?? 25;
  const sendTimeoutMs = opts.sendTimeoutMs ?? 4000;

  // Bound every CDP call: a live-but-silent socket must degrade to null, not hang
  // forever (PR #67 review). A synchronous throw from `send` becomes a rejection.
  const sendT = (method: string, params?: unknown, sessionId?: string): Promise<unknown> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('cdp-send-timeout')), sendTimeoutMs);
    });
    const call = (async () => send(method, params, sessionId))();
    return Promise.race([call, timeout]).finally(() => clearTimeout(timer));
  };

  let armed = false;
  try {
    // (a) arm auto-attach. flatten:true is LOAD-BEARING — without it Chrome routes
    // child traffic via the deprecated nested sendMessageToTarget the base send()
    // does not speak. waitForDebuggerOnStart:false so OOPIFs aren't paused.
    await sendT('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    armed = true;

    // (b) bounded-poll the injected snapshot for the unique preview child.
    const deadline = now() + waitForAttachMs;
    let child = pickPreviewChild(opts.attachedTargets(), opts.isPreviewUrl);
    while (!child && now() < deadline) {
      await new Promise((r) => setTimeout(r, pollMs));
      child = pickPreviewChild(opts.attachedTargets(), opts.isPreviewUrl);
    }
    if (!child) return null;

    // (c) PRIMARY: DOM serialization on the CHILD session. No page-world execution
    // context to depend on or be spoofed by; DOM.getDocument implicitly enables the
    // DOM domain, and depth:0 fetches just the root node before getOuterHTML
    // serializes the tree.
    try {
      const doc = asRec(await sendT('DOM.getDocument', { depth: 0, pierce: false }, child.sessionId));
      const root = asRec(doc.root);
      const nodeId = typeof root.nodeId === 'number' ? root.nodeId : null;
      if (nodeId !== null) {
        const outer = asRec(await sendT('DOM.getOuterHTML', { nodeId }, child.sessionId));
        if (typeof outer.outerHTML === 'string' && outer.outerHTML.length > 0) return outer.outerHTML;
      }
    } catch {
      // fall through to the Runtime fallback
    }

    // (d) FALLBACK: page-world Runtime.evaluate on the CHILD sessionId (without it
    // the eval runs in the parent page and returns the shell). For builds/states
    // where the DOM route returns nothing.
    const evalRes = await sendT(
      'Runtime.evaluate',
      { expression: 'document.documentElement.outerHTML', returnByValue: true, awaitPromise: false },
      child.sessionId
    );
    return evaluatedString(evalRes);
  } catch {
    return null;
  } finally {
    // (e) bounded, self-contained teardown — never let cleanup throw or hang.
    if (armed) {
      try {
        await sendT('Target.setAutoAttach', { autoAttach: false, waitForDebuggerOnStart: false, flatten: true });
      } catch {
        /* best-effort */
      }
    }
  }
}

export class OopifHtmlReader extends CdpSession {
  // Keyed by sessionId; each entry also carries targetId for targetInfoChanged.
  private readonly childTargets = new Map<string, AttachedChild>();

  constructor(ws: WebSocket, target: CdpTarget, opts: CdpSessionOptions = {}) {
    // One-shot reader: PIN reconnect:false (a mid-capture gap degrades to null ->
    // node-fetch fallback; there is no one-shot terminal to recover). Pinned last
    // so a caller can't accidentally route the base reconnect path into the no-op
    // enableDomains() (#67 review, below-gate).
    super(ws, target, { ...opts, reconnect: false });
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
      const targetId = typeof info.targetId === 'string' ? info.targetId : undefined;
      if (sessionId) this.childTargets.set(sessionId, { sessionId, url, type, targetId });
      return;
    }
    if (method === 'Target.targetInfoChanged') {
      // A child can attach as about:blank then navigate to _bootstrap (would be a
      // false null), or attach as _bootstrap then navigate away (would be stale
      // wrong-content). Keep the stored URL current, correlated by targetId (#67).
      const info = asRec(p.targetInfo);
      const targetId = typeof info.targetId === 'string' ? info.targetId : '';
      if (!targetId) return;
      for (const child of this.childTargets.values()) {
        if (child.targetId === targetId) {
          if (typeof info.url === 'string') child.url = info.url;
          if (typeof info.type === 'string') child.type = info.type;
        }
      }
      return;
    }
    if (method === 'Target.detachedFromTarget') {
      const sessionId = typeof p.sessionId === 'string' ? p.sessionId : '';
      if (sessionId) this.childTargets.delete(sessionId);
    }
  }

  async readPreviewHtml(): Promise<string | null> {
    return captureOopifHtml(this.send.bind(this), {
      attachedTargets: () => [...this.childTargets.values()],
      isPreviewUrl: isPreviewIframeSrc
    });
  }
}
