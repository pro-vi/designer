#!/usr/bin/env -S node --import tsx
// Analyze a trace-spike capture: per-request lifecycles, stream-kind verdict,
// chunk-gap stats (candidate STALLED thresholds), and network-quiet vs
// DOM-stable correlation (grounds the future FINISHED classifier).
import fs from 'node:fs';
import path from 'node:path';

interface Chunk {
  mono: number; // CDP monotonic seconds
  bytes: number;
  encodedBytes: number;
}

interface ReqLifecycle {
  requestId: string;
  url: string;
  method: string;
  resourceType: string | null;
  mimeType: string | null;
  status: number | null;
  hasContentLength: boolean;
  sentMono: number | null;
  sentWall: number | null;
  responseMono: number | null;
  finishedMono: number | null;
  failed: string | null;
  fromCache: boolean;
  chunks: Chunk[];
  sseMessages: number;
}

interface WsLifecycle {
  requestId: string;
  url: string;
  framesSent: number;
  framesReceived: number;
  bytesReceived: number;
  closed: boolean;
}

interface DomSample {
  ts: number;
  sample: Record<string, unknown>;
}

interface Marker {
  ts: number;
  name: string;
  detail: Record<string, unknown>;
}

function asRec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function normalizeEndpoint(url: string): string {
  try {
    const u = new URL(url);
    const p = u.pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ':id').replace(/\/\d{4,}/g, '/:n');
    return u.origin + p;
  } catch {
    return url.slice(0, 120);
  }
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx] ?? 0;
}

function ms(n: number): string {
  return `${Math.round(n)}ms`;
}

function main(): void {
  const argPath = process.argv[2];
  if (!argPath) {
    console.error('Usage: trace-analyze.ts <traceDir | trace.jsonl>');
    process.exit(1);
  }
  const dir = argPath.endsWith('.jsonl') ? path.dirname(argPath) : argPath;
  const jsonlPath = argPath.endsWith('.jsonl') ? argPath : path.join(dir, 'trace.jsonl');
  const manifestPath = path.join(dir, 'manifest.json');
  let manifest: Record<string, unknown> = {};
  if (fs.existsSync(manifestPath)) {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      manifest = asRec(parsed);
    } catch {
      manifest = {};
    }
  }

  const reqs = new Map<string, ReqLifecycle>();
  const sockets = new Map<string, WsLifecycle>();
  const domSamples: DomSample[] = [];
  const markers: Marker[] = [];
  let monoToWallOffset: number | null = null; // wallTime - timestamp, seconds
  let firstTs = Infinity;
  let lastTs = 0;
  let totalLines = 0;

  for (const line of fs.readFileSync(jsonlPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    totalLines++;
    let ev: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      ev = asRec(parsed);
    } catch {
      continue;
    }
    const ts = num(ev.ts) ?? 0;
    if (ts) {
      firstTs = Math.min(firstTs, ts);
      lastTs = Math.max(lastTs, ts);
    }
    if (ev.kind === 'dom-sample') {
      domSamples.push({ ts, sample: asRec(ev.sample) });
      continue;
    }
    if (ev.kind === 'recorder') {
      const detail = asRec(ev.detail);
      if (ev.event === 'marker') markers.push({ ts, name: String(detail.name || ''), detail });
      continue;
    }
    if (ev.kind !== 'cdp') continue;
    const method = String(ev.method || '');
    const p = asRec(ev.params);
    const requestId = typeof p.requestId === 'string' ? p.requestId : null;

    if (method === 'Network.requestWillBeSent' && requestId) {
      const req = asRec(p.request);
      const mono = num(p.timestamp);
      const wall = num(p.wallTime);
      if (mono !== null && wall !== null && monoToWallOffset === null) monoToWallOffset = wall - mono;
      reqs.set(requestId, {
        requestId,
        url: String(req.url || ''),
        method: String(req.method || 'GET'),
        resourceType: typeof p.type === 'string' ? p.type : null,
        mimeType: null,
        status: null,
        hasContentLength: false,
        sentMono: mono,
        sentWall: wall,
        responseMono: null,
        finishedMono: null,
        failed: null,
        fromCache: false,
        chunks: [],
        sseMessages: 0
      });
    } else if (requestId && reqs.has(requestId)) {
      const r = reqs.get(requestId)!;
      if (method === 'Network.responseReceived') {
        const resp = asRec(p.response);
        r.mimeType = typeof resp.mimeType === 'string' ? resp.mimeType : null;
        r.status = num(resp.status);
        r.responseMono = num(p.timestamp);
        const headers = asRec(resp.headers);
        r.hasContentLength = Object.keys(headers).some((k) => k.toLowerCase() === 'content-length');
      } else if (method === 'Network.dataReceived') {
        r.chunks.push({
          mono: num(p.timestamp) ?? 0,
          bytes: num(p.dataLength) ?? 0,
          encodedBytes: num(p.encodedDataLength) ?? 0
        });
      } else if (method === 'Network.loadingFinished') {
        r.finishedMono = num(p.timestamp);
      } else if (method === 'Network.loadingFailed') {
        r.failed = String(p.errorText || 'failed') + (p.canceled === true ? ' (canceled)' : '');
        r.finishedMono = num(p.timestamp);
      } else if (method === 'Network.requestServedFromCache') {
        r.fromCache = true;
      } else if (method === 'Network.eventSourceMessageReceived') {
        r.sseMessages++;
      }
    }
    if (method === 'Network.webSocketCreated' && requestId) {
      sockets.set(requestId, {
        requestId,
        url: String(p.url || ''),
        framesSent: 0,
        framesReceived: 0,
        bytesReceived: 0,
        closed: false
      });
    } else if (requestId && sockets.has(requestId)) {
      const s = sockets.get(requestId)!;
      if (method === 'Network.webSocketFrameSent') s.framesSent++;
      if (method === 'Network.webSocketFrameReceived') {
        s.framesReceived++;
        const resp = asRec(p.response);
        s.bytesReceived += typeof resp.payloadData === 'string' ? resp.payloadData.length : num(resp.payloadBytes) ?? 0;
      }
      if (method === 'Network.webSocketClosed') s.closed = true;
    }
  }

  const monoToWall = (mono: number | null): number | null =>
    mono !== null && monoToWallOffset !== null ? (mono + monoToWallOffset) * 1000 : null;

  const streamKind = (r: ReqLifecycle): string => {
    if (r.sseMessages > 0 || r.mimeType === 'text/event-stream') return 'sse';
    const span =
      r.chunks.length >= 2 ? (r.chunks[r.chunks.length - 1]?.mono ?? 0) - (r.chunks[0]?.mono ?? 0) : 0;
    if (r.chunks.length >= 3 && span > 1 && !r.hasContentLength) return 'fetch-chunked';
    return 'plain';
  };

  // Endpoint rollup
  const endpoints = new Map<string, { hits: number; methods: Set<string>; kinds: Set<string>; bytes: number; sentWalls: number[] }>();
  for (const r of reqs.values()) {
    const key = normalizeEndpoint(r.url);
    const e = endpoints.get(key) || { hits: 0, methods: new Set(), kinds: new Set(), bytes: 0, sentWalls: [] };
    e.hits++;
    e.methods.add(r.method);
    e.kinds.add(streamKind(r));
    e.bytes += r.chunks.reduce((a, c) => a + c.encodedBytes, 0);
    const w = monoToWall(r.sentMono);
    if (w !== null) e.sentWalls.push(w);
    endpoints.set(key, e);
  }

  // Main generation request
  const iterStart = markers.find((m) => m.name === 'iterate-start')?.ts ?? null;
  let main_: ReqLifecycle | null = null;
  let mainScore = -1;
  for (const r of reqs.values()) {
    if (!/^https:\/\/claude\.ai\//.test(r.url)) continue;
    if (r.method !== 'POST') continue;
    const span = r.responseMono !== null && r.finishedMono !== null ? r.finishedMono - r.responseMono : 0;
    let score = span * 1000 + r.chunks.length;
    const w = monoToWall(r.sentMono);
    if (iterStart !== null && w !== null && w >= iterStart - 1000 && w <= iterStart + 5000) score += 100_000;
    if (score > mainScore) {
      mainScore = score;
      main_ = r;
    }
  }

  const lines: string[] = [];
  const out = (s = ''): void => {
    lines.push(s);
  };

  const m = manifest as { scenario?: string; iterate?: { failureMode?: string | null; elapsedMs?: number } | null };
  out(`# Trace summary — ${m.scenario ?? path.basename(dir)}`);
  out();
  out(`- file: \`${jsonlPath}\``);
  out(`- span: ${((lastTs - firstTs) / 1000).toFixed(1)}s | lines: ${totalLines} | requests: ${reqs.size} | sockets: ${sockets.size} | dom-samples: ${domSamples.length}`);
  if (m.iterate) out(`- iterate: failureMode=${m.iterate.failureMode} elapsed=${Math.round((m.iterate.elapsedMs ?? 0) / 1000)}s`);
  for (const mk of markers) out(`- marker \`${mk.name}\` @ +${((mk.ts - firstTs) / 1000).toFixed(1)}s`);
  out();

  out(`## Endpoints`);
  out();
  out(`| endpoint | hits | methods | kind | bytes | periodicity |`);
  out(`|---|---|---|---|---|---|`);
  const sortedEndpoints = [...endpoints.entries()].sort((a, b) => b[1].bytes - a[1].bytes || b[1].hits - a[1].hits);
  for (const [ep, e] of sortedEndpoints) {
    const walls = e.sentWalls.sort((x, y) => x - y);
    const gaps: number[] = [];
    for (let i = 1; i < walls.length; i++) gaps.push((walls[i] ?? 0) - (walls[i - 1] ?? 0));
    gaps.sort((x, y) => x - y);
    const period = gaps.length >= 2 ? `~${(pct(gaps, 50) / 1000).toFixed(1)}s` : '';
    out(
      `| ${ep.replace(/^https:\/\//, '')} | ${e.hits} | ${[...e.methods].join(',')} | ${[...e.kinds].join(',')} | ${e.bytes} | ${period} |`
    );
  }
  out();

  if (main_) {
    const kind = streamKind(main_);
    out(`## Main generation request`);
    out();
    out(`**Verdict: generation streams via \`${kind}\` at \`${main_.method} ${normalizeEndpoint(main_.url)}\`** (status ${main_.status}, mime ${main_.mimeType})`);
    out();
    const t0 = main_.sentMono ?? 0;
    out(`- request sent: t0${iterStart !== null && monoToWall(t0) !== null ? ` (+${((monoToWall(t0)! - iterStart) / 1000).toFixed(1)}s after iterate-start)` : ''}`);
    if (main_.responseMono !== null) out(`- response headers: t0+${ms((main_.responseMono - t0) * 1000)}`);
    if (main_.finishedMono !== null) out(`- loading finished: t0+${((main_.finishedMono - t0)).toFixed(1)}s${main_.failed ? ` (FAILED: ${main_.failed})` : ''}`);
    out(`- chunks: ${main_.chunks.length} | total encoded bytes: ${main_.chunks.reduce((a, c) => a + c.encodedBytes, 0)}`);
    out();
    const gaps: number[] = [];
    for (let i = 1; i < main_.chunks.length; i++) {
      gaps.push(((main_.chunks[i]?.mono ?? 0) - (main_.chunks[i - 1]?.mono ?? 0)) * 1000);
    }
    if (gaps.length) {
      const sorted = [...gaps].sort((a, b) => a - b);
      const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      out(`### Inter-chunk gaps (candidate STALLED thresholds)`);
      out();
      out(`max ${ms(sorted[sorted.length - 1] ?? 0)} | p95 ${ms(pct(sorted, 95))} | p50 ${ms(pct(sorted, 50))} | mean ${ms(mean)}`);
      out();
      out(`→ a STALLED detector needs its no-chunk timeout comfortably above max (e.g. ${Math.ceil(((sorted[sorted.length - 1] ?? 0) * 3) / 1000)}s).`);
      out();
    }

    // Network-quiet vs DOM-stable
    const lastChunkWall = monoToWall(main_.chunks[main_.chunks.length - 1]?.mono ?? null);
    const finishedWall = monoToWall(main_.finishedMono);
    out(`### Network-quiet vs DOM-stable`);
    out();
    if (lastChunkWall !== null) out(`- last chunk of main request: +${((lastChunkWall - firstTs) / 1000).toFixed(1)}s`);
    if (finishedWall !== null) out(`- main request finished: +${((finishedWall - firstTs) / 1000).toFixed(1)}s`);
    let lastTurnChange: number | null = null;
    let lastIframeChange: number | null = null;
    let prevTurns: unknown = null;
    let prevIframe: unknown = null;
    for (const d of domSamples) {
      if (d.sample.chatTurnCount !== prevTurns) {
        if (prevTurns !== null) lastTurnChange = d.ts;
        prevTurns = d.sample.chatTurnCount;
      }
      if (d.sample.iframeSrc !== prevIframe) {
        if (prevIframe !== null) lastIframeChange = d.ts;
        prevIframe = d.sample.iframeSrc;
      }
    }
    if (lastTurnChange !== null) out(`- last chatTurnCount change (dom): +${((lastTurnChange - firstTs) / 1000).toFixed(1)}s`);
    if (lastIframeChange !== null) out(`- last iframeSrc change (dom): +${((lastIframeChange - firstTs) / 1000).toFixed(1)}s`);
    const stopSeen = domSamples.filter((d) => d.sample.stopProbe).length;
    out(`- dom-samples with a visible stop/cancel button: ${stopSeen}/${domSamples.length}`);
    const probes = domSamples.map((d) => d.sample.stopProbe).filter(Boolean) as Array<Record<string, unknown>>;
    if (probes.length) out(`- stop-button probe: \`${JSON.stringify(probes[0]).slice(0, 300)}\``);
    out();
  } else {
    out(`## Main generation request`);
    out();
    out(`(none identified — expected for idle/quota traces)`);
    out();
  }

  // Turn lifecycle — claude.ai/design holds a server-side turn lease while an
  // agent run is active: RenewTurn polls ~10s apart for the whole run, Chat
  // streams come in segments (one per agent step), ReleaseTurn fires once at
  // the end. ReleaseTurn is the discrete FINISHED candidate.
  const byRpc = (name: string): ReqLifecycle[] =>
    [...reqs.values()]
      .filter((r) => r.url.includes(`OmeletteService/${name}`))
      .sort((a, b) => (a.sentMono ?? 0) - (b.sentMono ?? 0));
  const renews = byRpc('RenewTurn');
  const releases = byRpc('ReleaseTurn');
  const chats = byRpc('Chat');
  if (renews.length || releases.length || chats.length) {
    out(`## Turn lifecycle (OmeletteService)`);
    out();
    if (chats.length) {
      out(`Chat segments: ${chats.length}`);
      for (const c of chats.slice(0, 40)) {
        const w = monoToWall(c.sentMono);
        const dur = c.responseMono !== null && c.finishedMono !== null ? c.finishedMono - c.responseMono : 0;
        out(
          `- +${w !== null ? ((w - firstTs) / 1000).toFixed(1) : '?'}s dur=${dur.toFixed(1)}s chunks=${c.chunks.length} bytes=${c.chunks.reduce((a, ch) => a + ch.encodedBytes, 0)}${c.failed ? ` FAILED: ${c.failed}` : ''}`
        );
      }
      out();
    }
    if (renews.length >= 2) {
      const walls = renews.map((r) => monoToWall(r.sentMono)).filter((w): w is number => w !== null);
      const gaps: number[] = [];
      for (let i = 1; i < walls.length; i++) gaps.push((walls[i] ?? 0) - (walls[i - 1] ?? 0));
      gaps.sort((a, b) => a - b);
      const firstW = walls[0] ?? 0;
      const lastW = walls[walls.length - 1] ?? 0;
      out(
        `RenewTurn: ${renews.length} calls, median gap ${(pct(gaps, 50) / 1000).toFixed(1)}s, first +${((firstW - firstTs) / 1000).toFixed(1)}s, last +${((lastW - firstTs) / 1000).toFixed(1)}s`
      );
    }
    for (const rel of releases) {
      const w = monoToWall(rel.sentMono);
      out(`ReleaseTurn: +${w !== null ? ((w - firstTs) / 1000).toFixed(1) : '?'}s ← discrete FINISHED candidate`);
    }
    const iterDone = markers.find((mk) => mk.name === 'iterate-done')?.ts ?? null;
    if (releases.length && iterDone !== null) {
      const w = monoToWall(releases[releases.length - 1]?.sentMono ?? null);
      if (w !== null)
        out(
          `→ ReleaseTurn led the controller's HTML-stability verdict (iterate-done) by ${((iterDone - w) / 1000).toFixed(1)}s`
        );
    }
    out();
  }

  if (sockets.size) {
    out(`## WebSockets`);
    out();
    for (const s of sockets.values()) {
      out(`- ${s.url.slice(0, 100)} — frames sent ${s.framesSent} / recv ${s.framesReceived}, recv bytes ${s.bytesReceived}${s.closed ? ', closed' : ''}`);
    }
    out();
  }

  const failed = [...reqs.values()].filter((r) => r.failed);
  if (failed.length) {
    out(`## Failed requests`);
    out();
    for (const r of failed) out(`- ${r.method} ${normalizeEndpoint(r.url)} — ${r.failed}`);
    out();
  }

  const md = lines.join('\n');
  const outPath = path.join(dir, 'summary.md');
  fs.writeFileSync(outPath, md);
  console.log(md);
  console.log(`\n(written to ${outPath})`);
}

main();
