import fs from 'node:fs';
import path from 'node:path';
import { ensureCdpUp } from './cdp-ensure.ts';

// CDP network trace recorder — spike-grade groundwork for the future
// network-first run-state observer (RUNNING/FINISHED/STALLED/BLOCKED).
//
// Attaches a second CDP client directly to the design tab's page target
// (agent-browser keeps driving the page through its own client; CDP allows
// multiple simultaneous clients) and streams Network/Page events to JSONL.
//
// Uses the native global WebSocket (stable since Node 22.4). The package
// declares engines >=22 so runtime code can use it without a `ws` dependency.
//
// Known blind spot: the claudeusercontent.com preview iframe is an
// out-of-process frame — its document fetches never reach this page target's
// Network domain. Generation API traffic originates in the main frame, which
// is what we're here for. Upgrade path if traces show a gap:
// Target.setAutoAttach({flatten:true}) + per-session Network.enable; send()
// and event handling already tolerate a sessionId field for that reason.

const DEFAULT_PORT = process.env.DESIGNER_CDP || '9222';
const DESIGN_URL_PATTERN = /^https:\/\/claude\.ai\/design/;
const REDACT_KEY_PATTERN = /^(cookie|set-cookie|authorization|proxy-authorization|x-api-key)$/i;
const STREAMABLE_RESOURCE_TYPES = new Set(['XHR', 'Fetch', 'EventSource']);
// URLs whose request/response bodies we never capture — auth/session exchanges
// can carry credentials as plaintext JSON values that header-key redaction
// can't see. The generation traffic we care about (OmeletteService) is not here.
const AUTH_URL_DENYLIST =
  /\/(oauth|auth|login|logout|sign[_-]?in|sign[_-]?out|sign[_-]?up|register|token|sessions?|account|credential|password|mfa|totp|verify)\b/i;

// Value-level secret scrub for captured *bodies* (postData, response bodies, WS
// frame payloads). redact() only matches header *key names*; a token sitting in
// a JSON value or form field is a value blob it can't reach. Best-effort: catch
// the common token shapes before they hit disk. Exported for testability.
export function scrubSecrets(s: string): string {
  return s
    .replace(/eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, '[redacted-jwt]')
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[redacted-key]')
    .replace(
      /(["']?(?:access[_-]?token|refresh[_-]?token|id[_-]?token|session[_-]?key|sessionKey|api[_-]?key|client[_-]?secret|secret|password|passwd|pwd)["']?\s*[:=]\s*["']?)[^"'&,;\s}]+/gi,
      '$1[redacted]'
    )
    .replace(/\bsessionKey=[^;"'\s&]+/gi, 'sessionKey=[redacted]')
    .replace(/\b([Bb]earer)\s+[A-Za-z0-9._~+/=-]{12,}/g, '$1 [redacted]');
}

export interface CdpTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
}

export type TraceEvent =
  | { ts: number; kind: 'cdp'; method: string; sessionId?: string; params: unknown }
  | {
      ts: number;
      kind: 'body';
      requestId: string;
      url: string;
      source: 'getResponseBody' | 'streamBuffered';
      base64?: string;
      truncated: boolean;
      bytes: number;
    }
  | { ts: number; kind: 'dom-sample'; sample: unknown }
  | {
      ts: number;
      kind: 'recorder';
      event: 'attach' | 'detach' | 'reconnect' | 'gap' | 'marker' | 'error';
      detail?: unknown;
    };

export interface TraceSummary {
  durationMs: number;
  total: number;
  byMethod: Record<string, number>;
  droppedByMethod: Record<string, number>;
  reconnects: number;
  bodyCaptures: number;
}

export interface AttachOptions {
  outFile: string;
  port?: string;
  urlPattern?: RegExp;
  preferUrlPrefix?: string | null;
  captureBodiesFor?: RegExp;
  maxBodyBytesPerRequest?: number;
  reconnect?: boolean;
}

export interface CdpSessionOptions {
  port?: string;
  urlPattern?: RegExp;
  preferUrlPrefix?: string | null;
  reconnect?: boolean;
}

type ResolvedCdpSessionOptions = Required<Omit<CdpSessionOptions, 'preferUrlPrefix'>> & {
  preferUrlPrefix: string | null;
};

// Events persisted verbatim (post-redaction). Everything else — notably the
// Network.*ExtraInfo pair, which carries real Cookie/Set-Cookie headers — is
// only counted in droppedByMethod.
const PERSIST_METHODS = new Set([
  'Network.requestWillBeSent',
  'Network.responseReceived',
  'Network.dataReceived',
  'Network.loadingFinished',
  'Network.loadingFailed',
  'Network.requestServedFromCache',
  'Network.eventSourceMessageReceived',
  'Network.webSocketCreated',
  'Network.webSocketWillSendHandshakeRequest',
  'Network.webSocketHandshakeResponseReceived',
  'Network.webSocketFrameSent',
  'Network.webSocketFrameReceived',
  'Network.webSocketClosed',
  'Page.frameNavigated',
  'Page.frameStartedLoading',
  'Page.frameStoppedLoading',
  'Page.lifecycleEvent'
]);

function asRec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function isCdpTarget(v: unknown): v is CdpTarget {
  const r = asRec(v);
  return (
    typeof r.id === 'string' &&
    typeof r.type === 'string' &&
    typeof r.title === 'string' &&
    typeof r.url === 'string' &&
    typeof r.webSocketDebuggerUrl === 'string'
  );
}

/** Deep-walk redaction of sensitive header keys. Exported for testability. */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = REDACT_KEY_PATTERN.test(k) ? '[redacted]' : redact(v);
    }
    return out;
  }
  return value;
}

export async function listTargets(port: string = DEFAULT_PORT): Promise<CdpTarget[]> {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) });
  if (!res.ok) throw new Error(`CDP /json/list on :${port} returned ${res.status}`);
  const body: unknown = await res.json();
  if (!Array.isArray(body)) throw new Error(`CDP /json/list on :${port} returned a non-array payload`);
  return body.filter(isCdpTarget);
}

export async function findDesignTarget({
  port = DEFAULT_PORT,
  urlPattern = DESIGN_URL_PATTERN,
  preferUrlPrefix = null
}: {
  port?: string;
  urlPattern?: RegExp;
  preferUrlPrefix?: string | null;
} = {}): Promise<CdpTarget> {
  const targets = await listTargets(port);
  const candidates = targets.filter((t) => t.type === 'page' && urlPattern.test(t.url) && t.webSocketDebuggerUrl);
  if (candidates.length === 0) {
    throw new Error(`No page target matching ${urlPattern} on CDP :${port}. Open claude.ai/design first.`);
  }
  if (preferUrlPrefix) {
    // Exact URL first: the home URL (https://claude.ai/design) is a *prefix* of
    // every /design/p/<uuid> tab, so a startsWith match alone could bind to an
    // arbitrary project tab instead of the exact tab the caller is on (#66).
    const exact = candidates.find((t) => t.url === preferUrlPrefix);
    if (exact) return exact;
    const preferred = candidates.find((t) => t.url.startsWith(preferUrlPrefix));
    if (preferred) return preferred;
  }
  const only = candidates[0];
  if (candidates.length === 1 && only) return only;
  throw new Error(
    `Multiple design tabs match — pass --target-url to disambiguate:\n` +
      candidates.map((t) => `  ${t.url}`).join('\n')
  );
}

export abstract class CdpSession {
  protected ws: WebSocket;
  protected target: CdpTarget;
  protected readonly sessionOpts: ResolvedCdpSessionOptions;
  protected stopped = false;
  protected reconnects = 0;

  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private socketClosed = false;
  private nextId = 0;

  protected constructor(ws: WebSocket, target: CdpTarget, opts: CdpSessionOptions = {}) {
    this.ws = ws;
    this.target = target;
    this.sessionOpts = {
      port: opts.port ?? DEFAULT_PORT,
      urlPattern: opts.urlPattern ?? DESIGN_URL_PATTERN,
      preferUrlPrefix: opts.preferUrlPrefix ?? null,
      reconnect: opts.reconnect ?? true
    };
    this.wire(ws);
  }

  protected static async connectTarget(opts: CdpSessionOptions = {}): Promise<{ ws: WebSocket; target: CdpTarget }> {
    await ensureCdpUp();
    const target = await findDesignTarget({
      port: opts.port ?? DEFAULT_PORT,
      urlPattern: opts.urlPattern,
      preferUrlPrefix: opts.preferUrlPrefix ?? null
    });
    const ws = await this.openSocket(target.webSocketDebuggerUrl);
    return { ws, target };
  }

  protected static openSocket(url: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const onOpen = () => {
        cleanup();
        resolve(ws);
      };
      const onError = () => {
        cleanup();
        reject(new Error(`Failed to open CDP WebSocket ${url}`));
      };
      const cleanup = () => {
        ws.removeEventListener('open', onOpen);
        ws.removeEventListener('error', onError);
      };
      ws.addEventListener('open', onOpen);
      ws.addEventListener('error', onError);
    });
  }

  targetInfo(): { url: string; wsUrl: string; port: string } {
    return { url: this.target.url, wsUrl: this.target.webSocketDebuggerUrl, port: this.sessionOpts.port };
  }

  protected async enableDomains(): Promise<void> {
    await this.send('Network.enable', { maxTotalBufferSize: 100_000_000, maxResourceBufferSize: 50_000_000 });
  }

  protected send(method: string, params?: unknown, sessionId?: string): Promise<unknown> {
    const id = ++this.nextId;
    const msg: Record<string, unknown> = { id, method };
    if (params !== undefined) msg.params = params;
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.ws.send(JSON.stringify(msg));
      } catch (e) {
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  close(): void {
    this.closeSocket();
  }

  protected closeSocket(): boolean {
    if (this.socketClosed) return false;
    this.socketClosed = true;
    this.stopped = true;
    this.rejectPending(new Error('CDP WebSocket closed'));
    try {
      this.ws.close();
    } catch {
      /* already closed */
    }
    return true;
  }

  protected onSocketGap(_detail: { reason: string }): void {}
  protected onSocketReconnected(_target: CdpTarget): void {}
  protected onSocketReconnectFailed(_detail: { gaveUpAfterMs: number }): void {}
  protected abstract onEvent(method: string, params: unknown, sessionId?: string): void;

  private wire(ws: WebSocket): void {
    ws.addEventListener('message', (ev: MessageEvent) => {
      this.onMessage(typeof ev.data === 'string' ? ev.data : String(ev.data));
    });
    ws.addEventListener('close', () => {
      void this.handleClose();
    });
  }

  private onMessage(raw: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
    const rec = msg as Record<string, unknown>;
    if (typeof rec.id === 'number') {
      const p = this.pending.get(rec.id);
      if (!p) return;
      this.pending.delete(rec.id);
      if (rec.error) p.reject(new Error(`CDP ${JSON.stringify(rec.error)}`));
      else p.resolve(rec.result);
      return;
    }
    const method = typeof rec.method === 'string' ? rec.method : '';
    if (!method) return;
    this.onEvent(method, rec.params, typeof rec.sessionId === 'string' ? rec.sessionId : undefined);
  }

  private rejectPending(error: Error): void {
    for (const [, p] of this.pending) p.reject(error);
    this.pending.clear();
  }

  private async handleClose(): Promise<void> {
    this.rejectPending(new Error('CDP WebSocket closed'));
    if (this.stopped) return;
    this.onSocketGap({ reason: 'socket-closed' });
    if (!this.sessionOpts.reconnect) return;
    for (let i = 0; i < 30 && !this.stopped; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        const target = await findDesignTarget({
          port: this.sessionOpts.port,
          urlPattern: this.sessionOpts.urlPattern,
          preferUrlPrefix: this.sessionOpts.preferUrlPrefix
        });
        const ws = await CdpSession.openSocket(target.webSocketDebuggerUrl);
        this.ws = ws;
        this.target = target;
        this.wire(ws);
        await this.enableDomains();
        this.reconnects++;
        this.onSocketReconnected(target);
        return;
      } catch {
        // target not back yet — keep polling
      }
    }
    if (!this.stopped) this.onSocketReconnectFailed({ gaveUpAfterMs: 30_000 });
  }
}

interface RequestInfo {
  url: string;
  resourceType: string | null;
  mimeType: string | null;
  streamed: boolean;
  bodyBytes: number;
  bodyFetched: boolean;
}

export class CdpTraceRecorder extends CdpSession {
  private readonly opts: Required<Omit<AttachOptions, 'preferUrlPrefix'>> & { preferUrlPrefix: string | null };
  private readonly out: fs.WriteStream;
  private readonly requests = new Map<string, RequestInfo>();
  private readonly wsSocketUrls = new Map<string, string>();
  private readonly pendingBodies = new Set<Promise<void>>();
  private startedAt = Date.now();
  private total = 0;
  private bodyCaptures = 0;
  private ended = false;
  private byMethod: Record<string, number> = {};
  private droppedByMethod: Record<string, number> = {};

  private constructor(ws: WebSocket, target: CdpTarget, opts: AttachOptions) {
    super(ws, target, opts);
    this.opts = {
      outFile: opts.outFile,
      port: opts.port ?? DEFAULT_PORT,
      urlPattern: opts.urlPattern ?? DESIGN_URL_PATTERN,
      preferUrlPrefix: opts.preferUrlPrefix ?? null,
      captureBodiesFor: opts.captureBodiesFor ?? /^https:\/\/claude\.ai\//,
      maxBodyBytesPerRequest: opts.maxBodyBytesPerRequest ?? 2 * 1024 * 1024,
      reconnect: opts.reconnect ?? true
    };
    fs.mkdirSync(path.dirname(opts.outFile), { recursive: true });
    this.out = fs.createWriteStream(opts.outFile, { flags: 'a' });
    // Swallow stream errors (disk full, write-after-end races) — an unhandled
    // 'error' event on the stream would otherwise crash the process.
    this.out.on('error', () => {});
  }

  static async attach(opts: AttachOptions): Promise<CdpTraceRecorder> {
    if (typeof WebSocket === 'undefined') {
      throw new Error('Native WebSocket unavailable — cdp-trace requires Node >= 22.');
    }
    const { ws, target } = await CdpTraceRecorder.connectTarget(opts);
    return new CdpTraceRecorder(ws, target, opts);
  }

  async start(): Promise<void> {
    this.startedAt = Date.now();
    await this.enableDomains();
    this.writeLine({
      ts: Date.now(),
      kind: 'recorder',
      event: 'attach',
      detail: { targetUrl: this.target.url, wsUrl: this.target.webSocketDebuggerUrl }
    });
  }

  protected override async enableDomains(): Promise<void> {
    await super.enableDomains();
    await this.send('Page.enable');
    await this.send('Page.setLifecycleEventsEnabled', { enabled: true });
  }

  marker(name: string, detail?: unknown): void {
    this.writeLine({ ts: Date.now(), kind: 'recorder', event: 'marker', detail: { name, ...asRec(detail) } });
  }

  record(ev: TraceEvent): void {
    this.writeLine({ ...ev, ts: ev.ts || Date.now() });
  }

  async stop(): Promise<TraceSummary> {
    this.stopped = true;
    // Give in-flight body fetches a moment to land, then move on.
    await Promise.race([
      Promise.allSettled([...this.pendingBodies]),
      new Promise((r) => setTimeout(r, 3000))
    ]);
    this.writeLine({ ts: Date.now(), kind: 'recorder', event: 'detach' });
    this.close();
    // Mark ended before end() so any late body-fetch .catch (rejected by close())
    // is a no-op in writeLine rather than a write-after-end stream error.
    this.ended = true;
    await new Promise<void>((resolve) => this.out.end(resolve));
    return {
      durationMs: Date.now() - this.startedAt,
      total: this.total,
      byMethod: this.byMethod,
      droppedByMethod: this.droppedByMethod,
      reconnects: this.reconnects,
      bodyCaptures: this.bodyCaptures
    };
  }

  protected override onEvent(method: string, rawParams: unknown, sessionId?: string): void {
    if (!PERSIST_METHODS.has(method)) {
      this.droppedByMethod[method] = (this.droppedByMethod[method] || 0) + 1;
      return;
    }
    const params = asRec(rawParams);
    this.trackRequest(method, params);
    const shaped = this.shapePayloads(method, params);
    const ev: TraceEvent = { ts: Date.now(), kind: 'cdp', method, params: redact(shaped) };
    if (sessionId) ev.sessionId = sessionId;
    this.writeLine(ev);
    this.byMethod[method] = (this.byMethod[method] || 0) + 1;

    if (method === 'Network.responseReceived') this.maybeStreamContent(params);
    if (method === 'Network.loadingFinished') this.maybeFetchBody(params);
  }

  private trackRequest(method: string, params: Record<string, unknown>): void {
    const requestId = typeof params.requestId === 'string' ? params.requestId : null;
    if (!requestId) return;
    if (method === 'Network.requestWillBeSent') {
      const req = asRec(params.request);
      this.requests.set(requestId, {
        url: String(req.url || ''),
        resourceType: typeof params.type === 'string' ? params.type : null,
        mimeType: null,
        streamed: false,
        bodyBytes: 0,
        bodyFetched: false
      });
    } else if (method === 'Network.responseReceived') {
      const info = this.requests.get(requestId);
      if (info) {
        const resp = asRec(params.response);
        info.mimeType = typeof resp.mimeType === 'string' ? resp.mimeType : null;
        if (typeof params.type === 'string') info.resourceType = params.type;
      }
    } else if (method === 'Network.webSocketCreated') {
      this.wsSocketUrls.set(requestId, String(params.url || ''));
    }
  }

  /** Strip or size-cap payload-bearing fields before persistence. */
  private shapePayloads(method: string, params: Record<string, unknown>): Record<string, unknown> {
    if (method === 'Network.requestWillBeSent') {
      const req = asRec(params.request);
      if (typeof req.postData === 'string') {
        // Off-origin: strip entirely. Kept (claude.ai) bodies are value-scrubbed
        // so a credential in a sign-in/token POST body never lands verbatim.
        if (!this.opts.captureBodiesFor.test(String(req.url || ''))) {
          return { ...params, request: { ...req, postData: undefined, postDataBytes: req.postData.length } };
        }
        return { ...params, request: { ...req, postData: scrubSecrets(req.postData) } };
      }
      return params;
    }
    if (method === 'Network.webSocketFrameSent' || method === 'Network.webSocketFrameReceived') {
      const requestId = String(params.requestId || '');
      const socketUrl = this.wsSocketUrls.get(requestId) || '';
      const resp = asRec(params.response);
      if (typeof resp.payloadData === 'string') {
        if (!this.opts.captureBodiesFor.test(socketUrl)) {
          return { ...params, response: { ...resp, payloadData: undefined, payloadBytes: resp.payloadData.length } };
        }
        return { ...params, response: { ...resp, payloadData: scrubSecrets(resp.payloadData) } };
      }
      return params;
    }
    if (method === 'Network.dataReceived' && typeof params.data === 'string') {
      const requestId = String(params.requestId || '');
      const info = this.requests.get(requestId);
      const bytes = Math.floor((params.data.length * 3) / 4);
      if (info) {
        if (info.bodyBytes + bytes > this.opts.maxBodyBytesPerRequest) {
          return { ...params, data: undefined, dataDroppedBytes: bytes, truncated: true };
        }
        info.bodyBytes += bytes;
      }
      return params;
    }
    return params;
  }

  // Streaming responses (SSE / chunked fetch with no Content-Length) lose
  // their bodies once the stream is consumed — getResponseBody after the
  // fact usually fails. Network.streamResourceContent (experimental) asks
  // Chrome to buffer + forward chunks as base64 on dataReceived. Best-effort:
  // on older Chrome the command just rejects and chunk timing remains the
  // primary record.
  private maybeStreamContent(params: Record<string, unknown>): void {
    const requestId = typeof params.requestId === 'string' ? params.requestId : null;
    if (!requestId) return;
    const info = this.requests.get(requestId);
    if (!info || info.streamed) return;
    if (!this.opts.captureBodiesFor.test(info.url)) return;
    if (AUTH_URL_DENYLIST.test(info.url)) return;
    if (!info.resourceType || !STREAMABLE_RESOURCE_TYPES.has(info.resourceType)) return;
    const resp = asRec(params.response);
    const headers = asRec(resp.headers);
    const hasContentLength = Object.keys(headers).some((k) => k.toLowerCase() === 'content-length');
    const isSse = info.mimeType === 'text/event-stream';
    if (!isSse && hasContentLength) return;

    info.streamed = true;
    const p = this.send('Network.streamResourceContent', { requestId })
      .then((result) => {
        const buffered = String(asRec(result).bufferedData || '');
        const bytes = Math.floor((buffered.length * 3) / 4);
        const truncated = bytes > this.opts.maxBodyBytesPerRequest;
        info.bodyBytes += Math.min(bytes, this.opts.maxBodyBytesPerRequest);
        this.bodyCaptures++;
        this.writeLine({
          ts: Date.now(),
          kind: 'body',
          requestId,
          url: info.url,
          source: 'streamBuffered',
          base64: truncated ? buffered.slice(0, Math.ceil((this.opts.maxBodyBytesPerRequest * 4) / 3)) : buffered,
          truncated,
          bytes
        });
      })
      .catch(() => {
        info.streamed = false; // let loadingFinished try getResponseBody instead
      })
      .finally(() => this.pendingBodies.delete(p));
    this.pendingBodies.add(p);
  }

  private maybeFetchBody(params: Record<string, unknown>): void {
    const requestId = typeof params.requestId === 'string' ? params.requestId : null;
    if (!requestId || this.stopped) return;
    const info = this.requests.get(requestId);
    if (!info || info.streamed || info.bodyFetched) return;
    if (!this.opts.captureBodiesFor.test(info.url)) return;
    if (AUTH_URL_DENYLIST.test(info.url)) return;
    if (!info.resourceType || !STREAMABLE_RESOURCE_TYPES.has(info.resourceType)) return;

    info.bodyFetched = true;
    const p = this.send('Network.getResponseBody', { requestId })
      .then((result) => {
        const r = asRec(result);
        const isB64 = r.base64Encoded === true;
        // Text bodies are value-scrubbed before persistence; base64 (binary)
        // bodies are opaque, so the auth-URL denylist above is their guard.
        const body = isB64 ? String(r.body || '') : scrubSecrets(String(r.body || ''));
        const bytes = isB64 ? Math.floor((body.length * 3) / 4) : body.length;
        const truncated = bytes > this.opts.maxBodyBytesPerRequest;
        const cap = isB64 ? Math.ceil((this.opts.maxBodyBytesPerRequest * 4) / 3) : this.opts.maxBodyBytesPerRequest;
        this.bodyCaptures++;
        this.writeLine({
          ts: Date.now(),
          kind: 'body',
          requestId,
          url: info.url,
          source: 'getResponseBody',
          base64: isB64 ? (truncated ? body.slice(0, cap) : body) : Buffer.from(truncated ? body.slice(0, cap) : body).toString('base64'),
          truncated,
          bytes
        });
      })
      .catch((e: Error) => {
        this.writeLine({
          ts: Date.now(),
          kind: 'recorder',
          event: 'error',
          detail: { op: 'getResponseBody', requestId, url: info.url, message: e.message }
        });
      })
      .finally(() => this.pendingBodies.delete(p));
    this.pendingBodies.add(p);
  }

  protected override onSocketGap(): void {
    this.writeLine({ ts: Date.now(), kind: 'recorder', event: 'gap', detail: { reason: 'socket-closed' } });
  }

  protected override onSocketReconnected(target: CdpTarget): void {
    this.writeLine({ ts: Date.now(), kind: 'recorder', event: 'reconnect', detail: { targetUrl: target.url } });
  }

  protected override onSocketReconnectFailed(detail: { gaveUpAfterMs: number }): void {
    this.writeLine({ ts: Date.now(), kind: 'recorder', event: 'error', detail: { op: 'reconnect', ...detail } });
  }

  private writeLine(ev: TraceEvent): void {
    if (this.ended) return; // a late body-fetch .catch can fire after stop() ended the stream
    this.out.write(JSON.stringify(ev) + '\n');
    this.total++;
  }
}
