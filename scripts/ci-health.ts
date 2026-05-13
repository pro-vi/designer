#!/usr/bin/env -S node --import tsx
// Daily-health orchestrator. Invoked by .github/workflows/daily-health.yml on
// the self-hosted Mac mini runner where real Chrome + the dedicated profile
// live. Combines `designer doctor` (tooling state) + `designer health` (UI
// anchors) + a diagnostic a11y snapshot into one artifact.
//
// Output: artifacts/health/<YYYY-MM-DD>.json. Exit code 2 on any health fail.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createBrowser, type Browser } from '../browser.ts';
import { runHealth, type ProbeResult } from '../ui-anchors.ts';
import { REPO_ROOT } from '../repo-root.ts';

const CDP_PORT = process.env.DESIGNER_CDP || '9222';
const CHROME_PROFILE = path.join(os.homedir(), '.chrome-designer-profile');
const CHROME_APP = '/Applications/Google Chrome.app';

// Two-phase probe targets. Home covers home.* anchors + any-state anchors;
// session covers session.* / share.* anchors + any-state again (we concatenate
// rather than dedup so a state-sensitive regression in either phase shows up
// loudly). 15s adaptive wait — claude.ai/design's SPA usually paints in 2-4s;
// 15s is the runner-cold-load ceiling before we proceed and let anchors fail.
const HOME_URL = 'https://claude.ai/design';
const HOME_READY_SEL = '[data-testid="project-creator"]';
const SESSION_READY_SEL = '[data-testid="chat-composer-input"]';
const BROWSER_TIMEOUT_MS = 15_000;

interface DoctorRun {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runDoctor(): DoctorRun {
  // Shell out so we get the same view a human would running `designer doctor`.
  // Doctor has no --json today; we capture raw text and the exit code.
  const bin = path.join(REPO_ROOT, 'bin', 'designer');
  const r = spawnSync(bin, ['doctor'], { encoding: 'utf8', timeout: 60_000 });
  return {
    exitCode: r.status ?? -1,
    stdout: r.stdout || '',
    stderr: r.stderr || ''
  };
}

function pkgVersion(): string {
  const p = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  return p.version as string;
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function ensureDir(p: string): void {
  fs.mkdirSync(p, { recursive: true });
}

interface CdpStatus {
  alive: boolean;
  attemptedRestart: boolean;
  detail: string;
}

async function pingCdp(): Promise<{ ok: boolean; detail: string }> {
  // CDP exposes /json/version unauthenticated when --remote-debugging-port is
  // bound. A 200 with a Browser field is the canonical "yes, we're alive".
  // Use a short timeout — CDP either answers in <1s or it's not there.
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 2000);
    const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`, { signal: ac.signal });
    clearTimeout(t);
    if (!r.ok) return { ok: false, detail: `HTTP ${r.status}` };
    const j = await r.json().catch(() => null) as { Browser?: string } | null;
    return { ok: !!j?.Browser, detail: j?.Browser || 'no Browser field' };
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
}

async function ensureCdp(): Promise<CdpStatus> {
  // Most likely failure mode at first daily run: Mac mini rebooted, debug
  // Chrome not relaunched. Try a narrow restart — same flags `designer setup`
  // would use, but without touching auth state. If still dead after one
  // attempt, fail loud rather than chase deeper recovery.
  const first = await pingCdp();
  if (first.ok) return { alive: true, attemptedRestart: false, detail: first.detail };

  console.log(`[ci-health] CDP unreachable on :${CDP_PORT} (${first.detail}) — attempting narrow Chrome relaunch`);
  spawn('open', [
    '-na',
    CHROME_APP,
    '--args',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${CHROME_PROFILE}`
  ], { detached: true, stdio: 'ignore' }).unref();

  // Chrome takes ~2-5s to bind the CDP port. Poll up to 15s.
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const r = await pingCdp();
    if (r.ok) return { alive: true, attemptedRestart: true, detail: r.detail };
  }
  const final = await pingCdp();
  return { alive: false, attemptedRestart: true, detail: final.detail };
}

async function adaptiveWait(browser: Browser, sel: string, label: string): Promise<void> {
  // Wraps agent-browser `wait <selector>` (driven by AGENT_BROWSER_DEFAULT_TIMEOUT
  // = BROWSER_TIMEOUT_MS). On timeout we log + proceed — downstream anchor
  // checks will fail loudly with their own detail strings, which is more
  // useful than aborting the whole run on a slow paint.
  try {
    await browser.waitFor(sel);
  } catch (e) {
    console.log(`[ci-health] ${label} ready-selector ${sel} not seen within ${BROWSER_TIMEOUT_MS}ms — proceeding (${(e as Error).message})`);
  }
}

async function maybeSnapshot(browser: Browser): Promise<{ url: string; htmlBytes: number; screenshotPath?: string } | null> {
  // Only fired when health regressed — gives a human enough state to diagnose
  // a Claude Design selector drift without us having to ssh into the runner.
  // In two-phase mode this captures whichever page Chrome ended on (session
  // when probeUrl is set, home otherwise). Consult `health.results[].phase`
  // to know which phase a specific failure came from.
  try {
    const url = (await browser.url().catch(() => '')) || '';
    const html = await browser.evalValue<string>('document.documentElement.outerHTML').catch(() => '');
    const dir = path.join(REPO_ROOT, 'artifacts', 'health', todayUtc());
    ensureDir(dir);
    const htmlPath = path.join(dir, 'page.html');
    fs.writeFileSync(htmlPath, typeof html === 'string' ? html : '');
    const shotPath = path.join(dir, 'page.png');
    await browser.screenshot(shotPath, { full: true }).catch(() => null);
    return {
      url,
      htmlBytes: typeof html === 'string' ? html.length : 0,
      screenshotPath: fs.existsSync(shotPath) ? path.relative(REPO_ROOT, shotPath) : undefined
    };
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();

  // CDP must be alive before doctor or runHealth — both fail confusingly
  // (timeouts, "browser is null") if Chrome never launched after reboot.
  // Surface that failure mode explicitly with one shot at recovery.
  const cdp = await ensureCdp();
  if (!cdp.alive) {
    const payload = {
      ok: false,
      generatedAt: startedAt,
      finishedAt: new Date().toISOString(),
      designerVersion: pkgVersion(),
      reason: 'cdp-unreachable',
      cdp,
      hint: `Chrome with --remote-debugging-port=${CDP_PORT} could not be reached or relaunched. On the runner, run \`designer setup\` interactively to re-establish the session, then re-run this workflow.`
    };
    const outDir = path.join(REPO_ROOT, 'artifacts', 'health');
    ensureDir(outDir);
    fs.writeFileSync(path.join(outDir, `${todayUtc()}.json`), JSON.stringify(payload, null, 2));
    console.error(`[ci-health] FAIL — CDP unreachable on :${CDP_PORT} (${cdp.detail}); restart attempted=${cdp.attemptedRestart}`);
    process.exit(2);
  }
  console.log(`[ci-health] CDP alive — ${cdp.detail}${cdp.attemptedRestart ? ' (restarted)' : ''}`);

  const doctor = runDoctor();

  const browser = createBrowser({ session: 'designer-default', timeoutMs: BROWSER_TIMEOUT_MS });

  // Phase 1 — home page. Covers home.* anchors + the one `any`-state anchor
  // (pattern.sessionUrl). Always runs; the home page is reachable without a
  // canary project, and home-state regressions are exactly what today's
  // single-phase probe was missing.
  let homeNav: { target: string; landedOn: string; error?: string } | null = null;
  try {
    await browser.open(HOME_URL);
    await adaptiveWait(browser, HOME_READY_SEL, 'home');
    const landedOn = (await browser.url().catch(() => '')) || '';
    homeNav = { target: HOME_URL, landedOn };
    console.log(`[ci-health] navigated to home — landed=${landedOn}`);
  } catch (e) {
    homeNav = { target: HOME_URL, landedOn: '', error: (e as Error).message };
    console.log(`[ci-health] home navigation failed — ${(e as Error).message}; home anchors will fail loudly`);
  }
  const homeResults = await runHealth(browser, { phase: 'home' });

  // Phase 2 — session (canary project). Covers session.* / share.* anchors
  // + the `any`-state anchor again. Only runs when DESIGNER_PROBE_PROJECT_URL
  // is set. Workflow sets it to a project the user commits to keeping
  // around; if it 404s or vanishes, session anchors fail loudly which is
  // the signal to pick a new canary.
  const probeUrl = process.env.DESIGNER_PROBE_PROJECT_URL;
  let sessionNav: { target: string; landedOn: string; error?: string } | null = null;
  let sessionResults: ProbeResult[] = [];
  if (probeUrl) {
    try {
      await browser.open(probeUrl);
      await adaptiveWait(browser, SESSION_READY_SEL, 'session');
      const landedOn = (await browser.url().catch(() => '')) || '';
      sessionNav = { target: probeUrl, landedOn };
      console.log(`[ci-health] navigated to canary — landed=${landedOn}`);
    } catch (e) {
      sessionNav = { target: probeUrl, landedOn: '', error: (e as Error).message };
      console.log(`[ci-health] canary navigation failed — ${(e as Error).message}; session anchors will fail loudly`);
    }
    sessionResults = await runHealth(browser, { phase: 'session' });
  } else {
    console.log('[ci-health] DESIGNER_PROBE_PROJECT_URL unset — skipping session phase');
  }

  const results: ProbeResult[] = [...homeResults, ...sessionResults];
  const counts = {
    ok: results.filter((r) => r.status === 'ok').length,
    fail: results.filter((r) => r.status === 'fail').length,
    skip: results.filter((r) => r.status === 'skip').length
  };
  const fail = counts.fail > 0;
  const url = (await browser.url().catch(() => '')) || '';

  const diag = fail ? await maybeSnapshot(browser) : null;

  const payload = {
    ok: !fail,
    generatedAt: startedAt,
    finishedAt: new Date().toISOString(),
    designerVersion: pkgVersion(),
    chromeUrl: url,
    // `canary` retains its V1 shape (session-navigation record) for back-compat
    // with the drift PR body + any existing artifact reader. The home-phase
    // navigation is captured in `homeNav` alongside it.
    canary: sessionNav,
    homeNav,
    doctor,
    health: {
      ok: !fail,
      counts,
      results
    },
    diagnostics: diag
  };

  const outDir = path.join(REPO_ROOT, 'artifacts', 'health');
  ensureDir(outDir);
  const outFile = path.join(outDir, `${todayUtc()}.json`);
  fs.writeFileSync(outFile, JSON.stringify(payload, null, 2));

  // One-line summary for the workflow log.
  const summary = `[ci-health] ${payload.ok ? 'OK' : 'FAIL'} — health ${counts.ok} ok / ${counts.fail} fail / ${counts.skip} skip · doctor exit ${doctor.exitCode} · v${payload.designerVersion}`;
  console.log(summary);
  if (fail) {
    const failed = results.filter((r) => r.status === 'fail').map((r) => `  ${r.id} — ${r.detail || r.description}`);
    console.log(failed.join('\n'));
  }
  console.log(`[ci-health] wrote ${path.relative(REPO_ROOT, outFile)}`);

  if (fail) process.exit(2);
}

main().catch((e: Error) => {
  console.error(`[ci-health] threw: ${e.message}`);
  process.exit(3);
});
