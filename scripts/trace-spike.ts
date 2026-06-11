#!/usr/bin/env -S node --import tsx
// Trace spike: record CDP network traffic from the claude.ai/design tab while
// scenarios run, to learn how the surface streams generation traffic. Output
// grounds the future network-first run-state observer. See cdp-trace.ts.
import fs from 'node:fs';
import path from 'node:path';
import { DesignerController, type IterateResult } from '../designer-controller.ts';
import { CdpTraceRecorder, type TraceSummary } from '../cdp-trace.ts';
import { artifactsRoot } from '../artifact-store.ts';
import { getSession } from '../session-store.ts';

const USAGE = `Usage:
  trace-spike.ts quota   [--seconds 60]                 capture quota banner + short idle trace
  trace-spike.ts idle    [--minutes 3]                  baseline noise trace
  trace-spike.ts success "<prompt>" [--key K] [--name N] [--fidelity highfi|wireframe] [--decisive] [--sample-ms 1500]
  trace-spike.ts noop    ["<prompt>"] [--key K]         chat-only prompt (expects no file change)
  trace-spike.ts watch   [--key K]                      record until Ctrl-C (opportunistic capture)

Traces land in artifacts/trace/<scenario>-<ts>/{trace.jsonl,manifest.json}.`;

interface Flags {
  [k: string]: string | boolean;
}

function parseArgv(argv: string[]): { positional: string[]; flags: Flags } {
  const positional: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a) continue;
    if (a.startsWith('--')) {
      const name = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[name] = next;
        i++;
      } else {
        flags[name] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const NOOP_PROMPT =
  'Answer in chat only — do not create, modify, or delete any files: briefly describe what the current design does.';

interface Manifest {
  scenario: string;
  key: string;
  prompt: string | null;
  startedAt: string;
  endedAt: string | null;
  aborted: boolean;
  node: string;
  cdp: { url: string; wsUrl: string; port: string } | null;
  iterate: {
    failureMode: string | null;
    ok: boolean;
    elapsedMs: number;
    changed: boolean;
    newFiles: string[];
    removedFiles: string[];
    activeFile: string | null;
    htmlBytes: number;
    chatReplyBytes: number;
  } | null;
  quota: { bannerText: string | null; bannerHtmlPath: string | null; screenshotPath: string | null } | null;
  summary: TraceSummary | null;
}

function buildSampleJs(c: DesignerController): string {
  const sel = c.selectors;
  return `(() => {
    const q = (s) => { try { return document.querySelector(s); } catch { return null; } };
    const vis = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const composer = q(${JSON.stringify(sel.composer.promptTextarea)});
    const send = q(${JSON.stringify(sel.composer.sendButton)});
    const iframe = q(${JSON.stringify(sel.preview.iframeOrContainer)});
    const msgs = q(${JSON.stringify(sel.messages.chatMessagesContainer)});
    let chatTurnCount = 0; let lastTurnRole = null;
    if (msgs) {
      const turns = msgs.querySelectorAll('[data-index]');
      chatTurnCount = turns.length;
      const last = turns[turns.length - 1];
      if (last) {
        const t = (last.innerText || '').trim();
        lastTurnRole = t.startsWith('Claude') ? 'assistant' : t.startsWith('You') ? 'user' : 'unknown';
      }
    }
    // selectors.json has composer.stopButton: null — probe generically so the
    // trace doubles as selector discovery for the real stop button.
    let stopProbe = null;
    for (const b of Array.from(document.querySelectorAll('button'))) {
      const label = ((b.getAttribute('aria-label') || '') + ' ' + (b.textContent || '')).trim();
      if (/\\b(stop|cancel)\\b/i.test(label) && vis(b)) {
        stopProbe = {
          label: label.slice(0, 80),
          testid: b.getAttribute('data-testid'),
          outerHTML: b.outerHTML.slice(0, 400)
        };
        break;
      }
    }
    return {
      url: location.href,
      iframeSrc: iframe && iframe.src ? iframe.src : null,
      composerVisible: vis(composer),
      sendVisible: vis(send),
      sendDisabled: send ? (send.disabled === true || send.getAttribute('aria-disabled') === 'true') : null,
      chatTurnCount,
      lastTurnRole,
      stopProbe
    };
  })()`;
}

const QUOTA_BANNER_JS = `(() => {
  // Find the smallest element whose text mentions a percentage AND
  // weekly-limit language — that's the usage banner.
  const all = Array.from(document.querySelectorAll('div, section, aside'));
  let best = null;
  for (const el of all) {
    const t = (el.innerText || '').trim();
    if (!t || t.length > 600) continue;
    if (!/\\d+\\s*%/.test(t)) continue;
    if (!/week|usage|limit|resets/i.test(t)) continue;
    if (!best || t.length < (best.innerText || '').trim().length) best = el;
  }
  if (!best) return { found: false, text: null, outerHTML: null };
  return { found: true, text: (best.innerText || '').trim(), outerHTML: best.outerHTML.slice(0, 8000) };
})()`;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  const { positional, flags } = parseArgv(process.argv.slice(2));
  const scenario = positional[0] || '';
  if (!['quota', 'idle', 'success', 'noop', 'watch'].includes(scenario)) {
    console.log(USAGE);
    process.exit(scenario ? 1 : 0);
  }

  const key = String(flags.key || 'trace-spike');
  const sampleMs = Number(flags['sample-ms'] || (scenario === 'idle' || scenario === 'watch' ? 5000 : 1500));
  const controller = new DesignerController({ key });

  const ready = await controller.ensureReady();
  console.log(`ready: ${ready.url}`);

  // success/noop need a project session; enter it BEFORE attaching so the
  // recorder binds to the session URL (same-origin SPA navigation keeps the
  // CDP target alive either way, but the trace stays scoped to one scenario).
  let prompt: string | null = null;
  if (scenario === 'success' || scenario === 'noop') {
    prompt = positional[1] || (scenario === 'noop' ? NOOP_PROMPT : null);
    if (!prompt) {
      console.error('success requires a prompt argument');
      process.exit(1);
    }
    const stored = getSession(key);
    if (stored?.designUrl) {
      await controller.resumeSession();
    } else if (scenario === 'noop') {
      console.error(`No stored session for key=${key} — run a success scenario first so noop has a design to ask about.`);
      process.exit(1);
    } else {
      const name = String(flags.name || 'aurora-trace');
      const fidelity = flags.fidelity === 'wireframe' ? 'wireframe' : 'highfi';
      const created = await controller.createSession(name, fidelity);
      console.log(`created session: ${created.url}`);
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(artifactsRoot(), 'trace', `${scenario}-${stamp}`);
  fs.mkdirSync(outDir, { recursive: true });

  const targetUrlFlag = typeof flags['target-url'] === 'string' ? String(flags['target-url']) : null;
  const recorder = await CdpTraceRecorder.attach({
    outFile: path.join(outDir, 'trace.jsonl'),
    preferUrlPrefix: getSession(key)?.designUrl?.split('?')[0] || null,
    ...(targetUrlFlag ? { urlPattern: new RegExp('^' + escapeRegExp(targetUrlFlag)) } : {})
  });
  await recorder.start();
  console.log(`recording → ${outDir}`);

  const manifest: Manifest = {
    scenario,
    key,
    prompt,
    startedAt: new Date().toISOString(),
    endedAt: null,
    aborted: false,
    node: process.version,
    cdp: recorder.targetInfo(),
    iterate: null,
    quota: null,
    summary: null
  };

  const sampleJs = buildSampleJs(controller);
  let samplerInFlight = false;
  const sampler = setInterval(() => {
    if (samplerInFlight) return;
    samplerInFlight = true;
    controller.browser
      .evalValue(sampleJs)
      .then((sample) => recorder.record({ ts: Date.now(), kind: 'dom-sample', sample }))
      .catch(() => null)
      .finally(() => {
        samplerInFlight = false;
      });
  }, sampleMs);

  let finished = false;
  const finalize = async (aborted: boolean): Promise<void> => {
    if (finished) return;
    finished = true;
    clearInterval(sampler);
    manifest.aborted = aborted;
    manifest.endedAt = new Date().toISOString();
    manifest.summary = await recorder.stop();
    fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    console.log(`\ntrace: ${path.join(outDir, 'trace.jsonl')}`);
    console.log(`manifest: ${path.join(outDir, 'manifest.json')}`);
    console.log(
      `events: ${manifest.summary.total} | bodies: ${manifest.summary.bodyCaptures} | reconnects: ${manifest.summary.reconnects}`
    );
  };
  process.on('SIGINT', () => {
    void finalize(true).then(() => process.exit(130));
  });

  try {
    if (scenario === 'quota') {
      const screenshotPath = path.join(outDir, 'quota-banner.png');
      await controller.browser.screenshot(screenshotPath, { full: true }).catch((e: Error) => {
        console.warn(`screenshot failed: ${e.message}`);
        return '';
      });
      const banner = await controller.browser
        .evalValue<{ found: boolean; text: string | null; outerHTML: string | null }>(QUOTA_BANNER_JS)
        .catch(() => ({ found: false, text: null, outerHTML: null }));
      let bannerHtmlPath: string | null = null;
      if (banner.found && banner.outerHTML) {
        bannerHtmlPath = path.join(outDir, 'quota-banner.html');
        fs.writeFileSync(bannerHtmlPath, banner.outerHTML);
      }
      manifest.quota = {
        bannerText: banner.text,
        bannerHtmlPath,
        screenshotPath: fs.existsSync(screenshotPath) ? screenshotPath : null
      };
      console.log(banner.found ? `banner: ${banner.text}` : 'banner: NOT FOUND (see screenshot)');
      const seconds = Number(flags.seconds || 60);
      recorder.marker('quota-idle-start', { seconds });
      await sleep(seconds * 1000);
      recorder.marker('quota-idle-end');
    } else if (scenario === 'idle') {
      const minutes = Number(flags.minutes || 3);
      recorder.marker('idle-start', { minutes });
      await sleep(minutes * 60_000);
      recorder.marker('idle-end');
    } else if (scenario === 'success' || scenario === 'noop') {
      recorder.marker('iterate-start', { prompt, decisive: flags.decisive === true });
      const result: IterateResult = await controller.iterate(prompt!, { decisive: flags.decisive === true });
      recorder.marker('iterate-done', {
        failureMode: result.done.failureMode,
        elapsedMs: result.done.elapsedMs,
        changed: result.changed,
        newFiles: result.newFiles
      });
      manifest.iterate = {
        failureMode: result.done.failureMode,
        ok: result.done.ok,
        elapsedMs: result.done.elapsedMs,
        changed: result.changed,
        newFiles: result.newFiles,
        removedFiles: result.removedFiles,
        activeFile: result.activeFile,
        htmlBytes: result.htmlBytes,
        chatReplyBytes: result.chatReply ? result.chatReply.length : 0
      };
      console.log(
        `iterate: ok=${result.done.ok} failureMode=${result.done.failureMode} elapsed=${Math.round(result.done.elapsedMs / 1000)}s newFiles=[${result.newFiles.join(', ')}]`
      );
      // The usage banner renders contextually in the chat flow after prompt
      // activity (it is absent from home and idle sessions) — probe for it
      // while it has a chance of being visible.
      const banner = await controller.browser
        .evalValue<{ found: boolean; text: string | null; outerHTML: string | null }>(QUOTA_BANNER_JS)
        .catch(() => ({ found: false, text: null, outerHTML: null }));
      if (banner.found && banner.outerHTML) {
        const bannerHtmlPath = path.join(outDir, 'quota-banner.html');
        fs.writeFileSync(bannerHtmlPath, banner.outerHTML);
        manifest.quota = { bannerText: banner.text, bannerHtmlPath, screenshotPath: null };
        console.log(`quota banner captured: ${banner.text}`);
      }
      // Let any trailing telemetry/persistence requests land in the trace.
      await sleep(5000);
    } else if (scenario === 'watch') {
      recorder.marker('watch-start');
      console.log('watching — Ctrl-C to stop');
      await new Promise(() => {
        /* resolved only via SIGINT handler */
      });
    }
  } finally {
    await finalize(false);
  }
}

main().catch(async (e: Error) => {
  console.error(e.message);
  process.exit(1);
});
