import { CdpSession, type CdpSessionOptions, type CdpTarget } from './cdp-trace.ts';

export const OMELETTE_TURN_SERVICE = 'anthropic.omelette.api.v1alpha.OmeletteService';
export const TURN_RPCS = ['Chat', 'RenewTurn', 'ReleaseTurn'] as const;

export type TurnRpc = (typeof TURN_RPCS)[number];
export type CriticalRunRpc = 'Chat' | 'RenewTurn';

export type RunSignal =
  | { kind: 'chat-open'; requestId?: string }
  | { kind: 'chat-chunk'; requestId?: string }
  | { kind: 'heartbeat'; requestId?: string }
  | { kind: 'release'; requestId?: string }
  | { kind: 'critical-error'; rpc: CriticalRunRpc; status: number | 'failed' }
  | { kind: 'observer-lost' };

function asRec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function eventWallMs(params: Record<string, unknown>): number | null {
  const syntheticTraceTs = num(params.ts);
  if (syntheticTraceTs !== null) return syntheticTraceTs;
  const wallTime = num(params.wallTime);
  return wallTime !== null ? wallTime * 1000 : null;
}

function requestId(params: Record<string, unknown>): string | undefined {
  return typeof params.requestId === 'string' ? params.requestId : undefined;
}

export function turnRpcFromUrl(url: string): TurnRpc | null {
  if (!url) return null;
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    // Some tests pass path fragments directly.
  }
  const escapedService = OMELETTE_TURN_SERVICE.replace(/\./g, '\\.');
  const match = path.match(new RegExp(`(?:^|/)${escapedService}/(Chat|RenewTurn|ReleaseTurn)(?:$|[/?#])`));
  if (!match?.[1]) return null;
  return TURN_RPCS.includes(match[1] as TurnRpc) ? (match[1] as TurnRpc) : null;
}

export function observedRpcPathFromUrl(url: string): string | null {
  if (!url) return null;
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    // Some tests pass path fragments directly.
  }
  const serviceIdx = path.indexOf(`${OMELETTE_TURN_SERVICE}/`);
  if (serviceIdx >= 0) return path.slice(serviceIdx);
  const idx = path.indexOf('OmeletteService/');
  return idx >= 0 ? path.slice(idx) : null;
}

export function isTurnRpcUrl(url: string): boolean {
  return turnRpcFromUrl(url) !== null;
}

function urlFromParams(method: string, params: Record<string, unknown>): string {
  if (typeof params.requestUrl === 'string') return params.requestUrl;
  if (typeof params.url === 'string') return params.url;
  if (method === 'Network.requestWillBeSent') {
    const req = asRec(params.request);
    return typeof req.url === 'string' ? req.url : '';
  }
  if (method === 'Network.responseReceived') {
    const resp = asRec(params.response);
    return typeof resp.url === 'string' ? resp.url : '';
  }
  return '';
}

function isCriticalRpc(rpc: TurnRpc | null): rpc is CriticalRunRpc {
  return rpc === 'Chat' || rpc === 'RenewTurn';
}

export function classifyEvent(method: string, rawParams: unknown, runStartTs: number): RunSignal | null {
  const params = asRec(rawParams);
  const wallMs = eventWallMs(params);
  if (wallMs !== null && wallMs < runStartTs) return null;

  const url = urlFromParams(method, params);
  const rpc = turnRpcFromUrl(url);

  if (method === 'Network.requestWillBeSent') {
    if (rpc === 'Chat') return { kind: 'chat-open', requestId: requestId(params) };
    if (rpc === 'RenewTurn') return { kind: 'heartbeat', requestId: requestId(params) };
    if (rpc === 'ReleaseTurn') return { kind: 'release', requestId: requestId(params) };
    return null;
  }

  if (method === 'Network.dataReceived' && rpc === 'Chat') {
    return { kind: 'chat-chunk', requestId: requestId(params) };
  }

  if (method === 'Network.responseReceived') {
    const response = asRec(params.response);
    const status = num(response.status);
    if (status !== null && status >= 400 && isCriticalRpc(rpc)) {
      return { kind: 'critical-error', rpc, status };
    }
    return null;
  }

  if (method === 'Network.loadingFailed' && isCriticalRpc(rpc)) {
    return { kind: 'critical-error', rpc, status: 'failed' };
  }

  return null;
}

export interface RunTerminal {
  terminal: 'finished' | 'blocked' | 'timeout' | 'observer-lost';
  elapsedMs: number;
  reason?: string;
}

export type RunObserverState = 'idle' | 'running' | 'stalled' | 'finished' | 'blocked' | 'timeout' | 'observer-lost';

export interface RunStateObserverOptions extends CdpSessionOptions {
  now?: () => number;
}

export interface RunSignalSummary {
  chatOpen: number;
  chatChunk: number;
  heartbeat: number;
  release: number;
  criticalError: number;
  observerLost: number;
  observedRpcPaths: string[];
}

export class RunStateObserver extends CdpSession {
  private readonly now: () => number;
  private currentState: 'idle' | 'running' | 'stalled' = 'idle';
  private runStartTs = 0;
  private lastActivity = 0;
  private priorRunSignals = 0;
  private terminalResult: RunTerminal | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private readonly waiters: Array<(terminal: RunTerminal) => void> = [];
  private readonly requestUrls = new Map<string, string>();
  private readonly observedRpcPaths = new Set<string>();
  private readonly signalCounts = {
    chatOpen: 0,
    chatChunk: 0,
    heartbeat: 0,
    release: 0,
    criticalError: 0,
    observerLost: 0
  };
  private closeCount = 0;

  constructor(ws: WebSocket, target: CdpTarget, opts: RunStateObserverOptions = {}) {
    super(ws, target, opts);
    this.now = opts.now ?? (() => Date.now());
  }

  static async attach(opts: RunStateObserverOptions = {}): Promise<RunStateObserver | null> {
    if (typeof WebSocket === 'undefined') return null;
    try {
      const { ws, target } = await RunStateObserver.connectTarget(opts);
      const observer = new RunStateObserver(ws, target, opts);
      await observer.start();
      return observer;
    } catch {
      return null;
    }
  }

  async start(): Promise<void> {
    await this.enableDomains();
  }

  beginRun(): void {
    if (this.terminalResult) return;
    this.runStartTs = this.now();
    this.lastActivity = this.runStartTs;
    this.priorRunSignals = 0;
    this.requestUrls.clear();
    this.observedRpcPaths.clear();
    this.resetSignalCounts();
    this.currentState = 'running';
  }

  get state(): RunObserverState {
    if (this.terminalResult) return this.terminalResult.terminal;
    return this.currentState;
  }

  awaitTerminal({ stallMs = 25_000, hardTimeoutMs = 20 * 60_000 }: { stallMs?: number; hardTimeoutMs?: number } = {}): Promise<RunTerminal> {
    if (this.terminalResult) return Promise.resolve(this.terminalResult);
    this.armWatchdog(stallMs, hardTimeoutMs);
    this.checkSilence(stallMs, hardTimeoutMs);
    if (this.terminalResult) return Promise.resolve(this.terminalResult);
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  override close(): void {
    this.clearWatchdog();
    if (this.closeSocket()) this.closeCount++;
  }

  signalSummary(): RunSignalSummary {
    return {
      ...this.signalCounts,
      observedRpcPaths: [...this.observedRpcPaths].sort()
    };
  }

  closeCountForTest(): number {
    return this.closeCount;
  }

  consumeSignalForTest(signal: RunSignal): void {
    this.consumeSignal(signal);
  }

  tickForTest({ stallMs = 25_000, hardTimeoutMs = 20 * 60_000 }: { stallMs?: number; hardTimeoutMs?: number } = {}): void {
    this.checkSilence(stallMs, hardTimeoutMs);
  }

  protected override onEvent(method: string, rawParams: unknown, _sessionId?: string): void {
    if (this.currentState === 'idle' && !this.terminalResult) return;
    const params = this.enrichParams(method, rawParams);
    const signal = classifyEvent(method, params, this.runStartTs);
    if (signal) this.consumeSignal(signal);
  }

  protected override onSocketReconnectFailed(): void {
    this.consumeSignal({ kind: 'observer-lost' });
  }

  private enrichParams(method: string, rawParams: unknown): Record<string, unknown> {
    const params = { ...asRec(rawParams) };
    const id = requestId(params);
    if (method === 'Network.requestWillBeSent' && id) {
      const wallMs = eventWallMs(params);
      if (wallMs !== null && wallMs < this.runStartTs) return params;
      const req = asRec(params.request);
      const url = typeof req.url === 'string' ? req.url : '';
      if (url) {
        this.requestUrls.set(id, url);
        const rpcPath = observedRpcPathFromUrl(url);
        if (rpcPath) this.observedRpcPaths.add(rpcPath);
      }
    } else if (id && !params.requestUrl) {
      const url = this.requestUrls.get(id);
      if (url) params.requestUrl = url;
    }
    return params;
  }

  private consumeSignal(signal: RunSignal): void {
    if (this.terminalResult) return;
    this.countSignal(signal);
    if (signal.kind === 'observer-lost') {
      this.latch('observer-lost');
      return;
    }
    if (this.currentState === 'idle') return;

    if (signal.kind === 'chat-open' || signal.kind === 'chat-chunk' || signal.kind === 'heartbeat') {
      this.lastActivity = this.now();
      this.priorRunSignals++;
      this.currentState = 'running';
      return;
    }

    if (signal.kind === 'release') {
      if (this.priorRunSignals === 0) return;
      this.latch('finished');
      return;
    }

    if (signal.kind === 'critical-error') {
      this.latch('blocked', `${signal.rpc} ${signal.status === 'failed' ? 'failed' : `HTTP ${signal.status}`}`);
    }
  }

  private countSignal(signal: RunSignal): void {
    if (signal.kind === 'chat-open') this.signalCounts.chatOpen++;
    else if (signal.kind === 'chat-chunk') this.signalCounts.chatChunk++;
    else if (signal.kind === 'heartbeat') this.signalCounts.heartbeat++;
    else if (signal.kind === 'release') this.signalCounts.release++;
    else if (signal.kind === 'critical-error') this.signalCounts.criticalError++;
    else if (signal.kind === 'observer-lost') this.signalCounts.observerLost++;
  }

  private resetSignalCounts(): void {
    this.signalCounts.chatOpen = 0;
    this.signalCounts.chatChunk = 0;
    this.signalCounts.heartbeat = 0;
    this.signalCounts.release = 0;
    this.signalCounts.criticalError = 0;
    this.signalCounts.observerLost = 0;
  }

  private checkSilence(stallMs: number, hardTimeoutMs: number): void {
    if (this.terminalResult || this.currentState === 'idle') return;
    const silence = this.now() - this.lastActivity;
    if (silence > hardTimeoutMs) {
      this.latch('timeout', `silent for ${silence}ms`);
    } else if (silence > stallMs) {
      this.currentState = 'stalled';
    }
  }

  private armWatchdog(stallMs: number, hardTimeoutMs: number): void {
    if (this.watchdog) return;
    const intervalMs = Math.max(250, Math.min(1000, stallMs, hardTimeoutMs));
    this.watchdog = setInterval(() => this.checkSilence(stallMs, hardTimeoutMs), intervalMs);
  }

  private clearWatchdog(): void {
    if (!this.watchdog) return;
    clearInterval(this.watchdog);
    this.watchdog = null;
  }

  private latch(terminal: RunTerminal['terminal'], reason?: string): void {
    if (this.terminalResult) return;
    this.terminalResult = {
      terminal,
      elapsedMs: Math.max(0, this.now() - this.runStartTs),
      ...(reason ? { reason } : {})
    };
    this.clearWatchdog();
    this.close();
    const waiters = this.waiters.splice(0);
    for (const resolve of waiters) resolve(this.terminalResult);
  }
}
