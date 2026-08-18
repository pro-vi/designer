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
import { fileURLToPath } from 'node:url';
import { createBrowser, type Browser } from '../browser.ts';
import { withTabLock } from '../designer-controller.ts';
import { runHealth, UI_ANCHORS, type ProbeResult } from '../ui-anchors.ts';
import { REPO_ROOT } from '../repo-root.ts';
import { getSelectors } from '../selectors.ts';
import { classifyInterstitial, INTERSTITIAL_PROBE_EXPR, type InterstitialKind, type InterstitialProbe } from '../interstitials.ts';

const SEL = getSelectors();

const CDP_PORT = process.env.DESIGNER_CDP || '9222';
const CHROME_PROFILE = path.join(os.homedir(), '.chrome-designer-profile');
const CHROME_APP = '/Applications/Google Chrome.app';

// Two-phase probe targets. Home covers home.* anchors + any-state anchors;
// session covers session.* / share.* anchors + any-state again (we concatenate
// rather than dedup so a state-sensitive regression in either phase shows up
// loudly). 15s adaptive wait — claude.ai/design's SPA usually paints in 2-4s;
// 15s is the runner-cold-load ceiling before we proceed and let anchors fail.
const HOME_URL = 'https://claude.ai/design';
// Readiness gates, resolved from selectors.json rather than inlined. These were
// hardcoded literals until 2026-07, and the home one ([data-testid="project-creator"])
// had been dead since a redesign — so every run burned the full BROWSER_TIMEOUT_MS
// waiting for an element that could never appear, then proceeded WITHOUT a
// readiness guarantee. adaptiveWait only logs on timeout, so the probe looked
// healthy the whole time. Sourcing them here means a drift repair in
// selectors.json fixes the gate too, instead of leaving a second stale copy.
const HOME_READY_SEL = SEL.home.creator;
const SESSION_READY_SEL = SEL.composer.promptTextarea;
const BROWSER_TIMEOUT_MS = 15_000;

interface DoctorRun {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Non-null when the process never launched (ENOENT, EACCES, timeout kill). */
  spawnError: string | null;
}

// Resolve the CLI entry point from package.json's `bin` map instead of guessing
// the filename. This spawned `bin/designer` (no extension) from 2026-05 until
// 2026-07-25; the real file is `bin/designer.mjs`, so every run failed ENOENT,
// `r.status` came back null, `?? -1` rendered it as exitCode -1, and r.error was
// discarded — which is why stdout AND stderr were both empty. `designer doctor`,
// i.e. the entire tooling-state half of this probe, had never once executed.
// Reading the path from the manifest means a rename can't silently re-break it.
export function resolveDoctorBin(repoRoot: string = REPO_ROOT): string {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
    bin?: string | Record<string, string>;
  };
  const rel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.designer;
  if (!rel) throw new Error('package.json declares no `bin` entry for designer');
  return path.join(repoRoot, rel);
}

function runDoctor(): DoctorRun {
  // Shell out so we get the same view a human would running `designer doctor`.
  // Doctor has no --json today; we capture raw text and the exit code.
  const bin = resolveDoctorBin();
  const r = spawnSync(bin, ['doctor'], { encoding: 'utf8', timeout: 60_000 });
  return {
    exitCode: r.status ?? -1,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    // A failure to LAUNCH is not an exit code. Keep it distinguishable in the
    // artifact so "never ran" can never again read the same as "ran and was
    // unhappy" — that ambiguity is what hid this bug for two months.
    //
    // Scrubbed HERE rather than at payload-assembly time, because Node embeds the
    // absolute executable path in spawn errors ("spawnSync /Users/<name>/.../bin/
    // designer ENOENT") and this string reaches THREE public sinks: the
    // world-downloadable artifact, the run summary line, and the ::warning
    // annotation. Scrubbing only the artifact would leak the runner's username
    // into the workflow log instead — exactly in the failure case this records.
    spawnError: r.error ? scrubArtifact(`${(r.error as NodeJS.ErrnoException).code ?? 'ERROR'}: ${r.error.message}`) : null
  };
}

function pkgVersion(): string {
  const p = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  return p.version as string;
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

// Scrub privacy-sensitive substrings before serializing to the artifact JSON
// (which is uploaded as a public-repo artifact, world-downloadable for 30 days).
// The signed-in Claude session can land Chrome on URLs containing private
// project UUIDs, ?file= deep links, and per-user absolute paths under $HOME.
// Strategy: redact UUID-shaped path segments (/p/<uuid> + similar), drop query
// strings + fragments from URLs, and replace absolute home-dir paths with a
// stable token so reading the artifact later still tells a maintainer
// "doctor saw <something under home>" without exposing the username.
/** Test seam: the scrubber is the privacy boundary, so it is asserted directly. */
export const scrubForTest = (s: string): string => scrubArtifact(s);

/**
 * Scrub EVERY string in a payload, recursively.
 *
 * The artifact used to be scrubbed field by field — `chromeUrl`, `canary`,
 * `homeNav` and the `doctor` block each opted in by hand — so a field that
 * forgot to opt in published raw. Two did: `diagnostics.url` and
 * `health.results[].detail` both shipped unredacted project UUIDs (and the
 * `?file=` query the scrubber exists to strip) in every world-downloadable
 * artifact. Scrubbing the assembled payload instead makes redaction the
 * DEFAULT, so the next field added is covered without anyone remembering.
 *
 * Safe over the whole tree: scrubArtifact is idempotent (verified across URL,
 * home-path and already-scrubbed inputs), and it only rewrites UUID path
 * segments, URL query/fragments, and home directories — none of which occur in
 * the anchor `id` / `status` values auto-heal reads back out of this artifact.
 */
export function scrubDeep<T>(value: T): T {
  if (typeof value === 'string') return scrubArtifact(value) as unknown as T;
  if (Array.isArray(value)) return value.map(scrubDeep) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = scrubDeep(v);
    return out as unknown as T;
  }
  return value;
}

/**
 * The probe's verdict, as three distinct outcomes rather than a boolean.
 *
 *   ok         — anchors green AND the tooling half actually ran
 *   drift      — UI anchors regressed; this is the selectors-drift-PR path
 *   incomplete — the probe could not fully run (doctor never launched, or
 *                reported a broken toolchain). NOT drift: opening a drift PR for
 *                it would misfile a tooling fault as a claude.ai redesign.
 *
 * Exists because a two-state exit code forced a false choice: exit 0 let a
 * half-broken probe read as green (and `Close stale drift PRs on green` would
 * then close a legitimate open drift PR), while exit 2 would have misclassified
 * it as UI drift. The workflow gates on this value, not on the raw step outcome.
 */
export type ProbeVerdict = 'ok' | 'drift' | 'incomplete';

export function probeVerdict(input: { anchorFail: boolean; doctorSpawnError: string | null; doctorExitCode: number }): ProbeVerdict {
  // Anchor drift wins: it is the signal the drift PR exists to carry, and it is
  // actionable even when the toolchain is also unhappy.
  if (input.anchorFail) return 'drift';
  // ONLY a failure to launch means the probe did not run. A non-zero doctor exit
  // deliberately does NOT gate.
  //
  // Reproduced 2026-07-26 rather than argued: doctor was run against a CDP Chrome
  // with NO design tab open and exited 0 — that check is status 'warn' (⚠), not
  // 'fail'. An earlier revision of this comment claimed it fired routinely after
  // an ensureCdp relaunch; that was wrong, and this corrects it.
  //
  // Doctor's six real 'fail' branches: node_modules missing, agent-browser
  // missing, selectors.json missing, CDP HTTP error, signed-out, MCP
  // registration. Only the LAST is orthogonal to whether this probe is valid,
  // and the rest are already covered without the exit code — signed-out fails the
  // login.signedIn anchor (-> drift), and a missing selectors.json or
  // agent-browser makes the probe itself throw (-> incomplete).
  //
  // So gating on the exit code buys almost nothing while risking a block on
  // `Close stale drift PRs on green` for an unrelated Claude Code registration
  // fault. A non-zero exit is surfaced in the artifact + an ::error annotation:
  // information, not a gate.
  if (input.doctorSpawnError !== null) return 'incomplete';
  return 'ok';
}

/** Exit codes: 0 ok · 2 drift · 3 threw (main().catch) · 4 incomplete. */
export const EXIT_CODE: Record<ProbeVerdict, number> = { ok: 0, drift: 2, incomplete: 4 };

function ghOutput(key: string, value: string): void {
  const target = process.env.GITHUB_OUTPUT;
  if (!target) {
    console.log(`[ci-health] (no GITHUB_OUTPUT) ${key}=${value}`);
    return;
  }
  fs.appendFileSync(target, `${key}=${value}\n`);
}

/**
 * The ONLY way this script may terminate. Every exit publishes a verdict first.
 *
 * The workflow gates on `verdict`, so an exit path that skips it leaves the
 * output unset — and with `continue-on-error: true` on the probe step, all three
 * gates then evaluate false and the job finishes GREEN. Routing every exit
 * through here is what keeps "the probe died early" from reading as "the probe
 * passed". `code` defaults to the verdict's canonical exit code; the throw path
 * overrides it to keep 3 distinguishable in logs.
 */
function exitWith(verdict: ProbeVerdict, code: number = EXIT_CODE[verdict]): never {
  ghOutput('verdict', verdict);
  console.log(`[ci-health] verdict=${verdict}`);
  process.exit(code);
}

function scrubArtifact(s: string): string {
  if (!s) return s;
  return s
    // /p/<hex-uuid> → /p/<redacted>. Matches both project UUIDs and any other
    // /<single-letter>/<uuid> shape Claude Design may add later.
    .replace(/\/[a-z]\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi, (m) => m.slice(0, 3) + '<redacted>')
    // Strip query strings and fragments from URLs (claude.ai/design?file=foo).
    .replace(/(https?:\/\/[^\s?#]+)[?#][^\s]*/g, '$1')
    // macOS home dirs (/Users/<name>/...) and Linux (/home/<name>/...).
    // Two passes per platform: the first handles usernames CONTAINING SPACES by
    // consuming up to the next path separator (a macOS full-name home like
    // "/Users/Provi Last/…" otherwise leaked the surname, since [^/\s] stops at
    // the space). It requires a following '/' so it cannot run away over prose.
    // The second catches the trailing-segment form with no following slash.
    .replace(/\/Users\/[^\/\n"]+?(?=\/)/g, '/Users/<redacted>')
    .replace(/\/home\/[^\/\n"]+?(?=\/)/g, '/home/<redacted>')
    .replace(/\/Users\/[^\/\s"]+/g, '/Users/<redacted>')
    .replace(/\/home\/[^\/\s"]+/g, '/home/<redacted>');
}

/**
 * Redaction collapses every project UUID to the same `<redacted>` token, so a
 * scrubbed `{target, landedOn}` pair cannot answer the one question a reader
 * asks first: did the probe actually reach the project it aimed at? Two
 * different projects and one project read identically.
 *
 * That ambiguity is not hypothetical. The canary project was deleted while five
 * daily runs reported session anchors green, and the artifact could not say
 * whether those anchors had been probing the canary or whatever project the
 * shared debug Chrome happened to be parked on. So compare BEFORE scrubbing and
 * record the verdict as its own field — it leaks nothing the URL didn't already
 * disclose, and `landedElsewhere` is exactly the signal that distinguishes
 * "claude.ai drifted" from "the probe measured the wrong page".
 */
export function navMatch(target: string, landedOn: string): boolean {
  const idOf = (u: string): string | null => {
    const m = u.match(/\/design\/p\/([0-9a-f-]{8,})/i);
    return m?.[1] ? m[1].toLowerCase() : null;
  };
  const a = idOf(target);
  const b = idOf(landedOn);
  // Both project URLs: same project or not. Otherwise fall back to comparing
  // the path-only forms, so the home phase (no /p/ segment) still gets a verdict.
  if (a && b) return a === b;
  const pathOnly = (u: string): string => u.replace(/[?#].*$/, '').replace(/\/+$/, '');
  return pathOnly(target) === pathOnly(landedOn);
}

function scrubNav(
  n: { target: string; landedOn: string; error?: string } | null
): (NonNullable<typeof n> & { landedElsewhere: boolean }) | null {
  if (!n) return null;
  return {
    target: scrubArtifact(n.target),
    landedOn: scrubArtifact(n.landedOn),
    landedElsewhere: !navMatch(n.target, n.landedOn),
    ...(n.error !== undefined ? { error: scrubArtifact(n.error) } : {})
  };
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

function updateStreak(outDir: string, results: ProbeResult[]): void {
  const streakPath = path.join(outDir, 'streak.json');
  let streak: Record<string, number> = {};
  if (fs.existsSync(streakPath)) {
    try {
      const raw = fs.readFileSync(streakPath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        // Only keep numeric values; anything else is corrupt + gets dropped.
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof v === 'number' && Number.isFinite(v) && v >= 0) streak[k] = v;
        }
      }
    } catch (e) {
      console.log(`[ci-health] streak.json unreadable (${(e as Error).message}); resetting`);
      streak = {};
    }
  }

  // Group results by id. `any`-anchors run in both phases — a fail in either
  // phase wins; ok-in-all-probed-phases resets to 0. Skipped anchors do not
  // influence the streak (they didn't really probe).
  const verdict = new Map<string, 'fail' | 'ok'>();
  for (const r of results) {
    if (r.status === 'skip') continue;
    const prev = verdict.get(r.id);
    if (r.status === 'fail') {
      verdict.set(r.id, 'fail'); // fail wins over ok
    } else if ((r.status === 'ok' || r.status === 'degraded') && prev !== 'fail') {
      // `degraded` resets the streak like `ok`. It is unrepaired drift, but the
      // anchor is NOT in this run's `fail` set, so auto-heal could never select
      // it as a candidate — counting it as a fail would grow a streak that can
      // never be acted on and could push the count past WHOLESALE_THRESHOLD,
      // causing a false wholesale-redesign bail. Degradation is surfaced via the
      // artifact + a workflow warning instead.
      verdict.set(r.id, 'ok');
    }
  }

  for (const [id, v] of verdict) {
    if (v === 'fail') {
      streak[id] = (streak[id] ?? 0) + 1;
    } else {
      streak[id] = 0;
    }
  }

  // Prune orphans: keys for anchors that no longer EXIST. `home.nameInput: 2`
  // survived long after that anchor was dropped, and auto-heal iterates streak
  // entries as candidates, so stale keys are noise in the one signal it reads.
  //
  // Keyed on the full UI_ANCHORS registry, NOT on this run's results: a run that
  // skips the session phase (DESIGNER_PROBE_PROJECT_URL unset) produces no
  // session.* results, and pruning on that would erase every live session streak.
  const known = new Set(UI_ANCHORS.map((a) => a.id));
  for (const id of Object.keys(streak)) {
    if (!known.has(id)) {
      console.log(`[ci-health] pruning orphan streak key ${id} (no longer a declared anchor)`);
      delete streak[id];
    }
  }

  // Best-effort write: a transient I/O failure here would (un-caught)
  // bubble to main().catch() and replace the canonical probe-fail exit code
  // 2 with a generic-throw exit code 3, changing the workflow's
  // steps.probe.outcome semantics. The streak file is auto-heal's input
  // signal, not the probe's contract — log + proceed.
  try {
    fs.writeFileSync(streakPath, JSON.stringify(streak, null, 2) + '\n');
  } catch (e) {
    console.log(`[ci-health] streak.json write failed (${(e as Error).message}); continuing`);
    return;
  }
  const flagged = Object.entries(streak).filter(([, n]) => n >= 2);
  if (flagged.length > 0) {
    console.log(`[ci-health] streak >= 2: ${flagged.map(([id, n]) => `${id}=${n}`).join(', ')}`);
  }
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

// Which interstitial overlay (if any) is on the page Chrome ended on. Recorded
// in every artifact so a wall of anchor failures isn't misattributed to selector
// drift when the real cause was a transient overlay (token banner / "Something
// went wrong" / Cloudflare bot-check) — the "misread" failure mode the live
// pre-flight (designer clear) addresses for verbs. Diagnostic only: never fails
// the run. Reuses the same classifier the pre-flight uses (interstitials.ts).
async function probeInterstitial(browser: Browser): Promise<InterstitialKind | null> {
  // Shared INTERSTITIAL_PROBE_EXPR keeps this diagnostic and the live pre-flight
  // (designer-controller) classifying identically — including the appShellPresent
  // guard, without which transcript text would false-classify here too.
  //
  // Note: unlike the controller's _classifyNow, this does NOT thread a
  // selectors.override.json `continueHere` override, so an operator with a
  // custom token-banner button label would see it recorded as null here. That's
  // acceptable — this field is diagnostic-only (never fails the run), and CI runs
  // the published selectors, not a local override (PR #77 Claude review).
  const probe = await browser.evalValue<InterstitialProbe>(INTERSTITIAL_PROBE_EXPR).catch(() => null);
  return probe ? classifyInterstitial(probe) : null;
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();

  // Re-probe mode (set by auto-heal heal) writes to a suffixed filename and
  // skips updateStreak so a heal-verification run does not overwrite the
  // canonical daily-health artifact or perturb the streak counter mid-day.
  const isReprobe = process.env.DESIGNER_REPROBE === '1';
  const artifactName = isReprobe ? `${todayUtc()}.reprobe.json` : `${todayUtc()}.json`;

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
    fs.writeFileSync(path.join(outDir, artifactName), JSON.stringify(payload, null, 2));
    console.error(`[ci-health] FAIL — CDP unreachable on :${CDP_PORT} (${cdp.detail}); restart attempted=${cdp.attemptedRestart}`);
    // `incomplete`, not `drift`: Chrome being unreachable is an environment
    // fault and must never be filed as a claude.ai redesign — the same stance
    // the workflow's preflight step already takes. Previously this exited 2,
    // which opened a selectors-drift PR for a dead browser.
    exitWith('incomplete');
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
  // Same reason as the CLI path: the switcher anchor drives the tab, so the
  // probe takes the tab lock rather than racing anything else in this process.
  const homeResults = await withTabLock(browser, 'health[ci:home]', () => runHealth(browser, { phase: 'home' }));

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
      // A silent redirect is the difference between "claude.ai drifted" and
      // "we measured a different project". A deleted canary still answers on
      // its own /design/p/<uuid> URL with a "Project not found" body, so the
      // URL alone will not catch that — but a redirect elsewhere is caught
      // here, and the readiness wait above already failed loudly for the
      // not-found case. Warn rather than throw: the anchors' own verdicts
      // remain the contract, this just stops them being read as canary truth.
      if (!navMatch(probeUrl, landedOn)) {
        console.log(
          `::warning title=canary navigation landed elsewhere::session anchors did NOT probe DESIGNER_PROBE_PROJECT_URL — every session.* result below describes a different page. Fix the canary before reading them as claude.ai drift.`
        );
      }
    } catch (e) {
      sessionNav = { target: probeUrl, landedOn: '', error: (e as Error).message };
      console.log(`[ci-health] canary navigation failed — ${(e as Error).message}; session anchors will fail loudly`);
    }
    // Session health owns the mutating turn-RPC canary. It sends a chat-only
    // prompt against DESIGNER_PROBE_PROJECT_URL and verifies the live
    // OmeletteService Chat/RenewTurn/ReleaseTurn contract.
    process.env.DESIGNER_TURN_RPC_CANARY ??= '1';
    sessionResults = await withTabLock(browser, 'health[ci:session]', () => runHealth(browser, { phase: 'session' }));
  } else {
    console.log('[ci-health] DESIGNER_PROBE_PROJECT_URL unset — skipping session phase');
  }

  const results: ProbeResult[] = [...homeResults, ...sessionResults];
  const counts = {
    ok: results.filter((r) => r.status === 'ok').length,
    // `degraded` = working only via a superseded selector branch. Reported
    // separately and deliberately NOT folded into `fail`: it must not open drift
    // PRs or turn the run red (the tool still works), but it must never again be
    // invisible the way a comma-OR fallback made it.
    degraded: results.filter((r) => r.status === 'degraded').length,
    fail: results.filter((r) => r.status === 'fail').length,
    skip: results.filter((r) => r.status === 'skip').length
  };
  const fail = counts.fail > 0;
  const url = (await browser.url().catch(() => '')) || '';

  const diag = fail ? await maybeSnapshot(browser) : null;
  // Captured on whichever page Chrome ended on (session if probeUrl set, else
  // home) — same final-state semantics as maybeSnapshot.
  const interstitial = await probeInterstitial(browser);

  const payload = {
    ok: !fail,
    generatedAt: startedAt,
    finishedAt: new Date().toISOString(),
    designerVersion: pkgVersion(),
    chromeUrl: scrubArtifact(url),
    // `canary` retains its V1 shape (session-navigation record) for back-compat
    // with the drift PR body + any existing artifact reader. The home-phase
    // navigation is captured in `homeNav` alongside it.
    canary: scrubNav(sessionNav),
    homeNav: scrubNav(homeNav),
    doctor: {
      exitCode: doctor.exitCode,
      stdout: scrubArtifact(doctor.stdout),
      stderr: scrubArtifact(doctor.stderr),
      spawnError: doctor.spawnError
    },
    health: {
      ok: !fail,
      counts,
      results
    },
    interstitial,
    diagnostics: diag
  };

  const outDir = path.join(REPO_ROOT, 'artifacts', 'health');
  ensureDir(outDir);
  const outFile = path.join(outDir, artifactName);
  // Single privacy boundary: everything published goes through the scrubber
  // here, rather than each field opting in individually upstream.
  fs.writeFileSync(outFile, JSON.stringify(scrubDeep(payload), null, 2));

  // Streak tracker — input to the auto-heal workflow's N=2 gate. Dedups
  // across phases (a pattern.* anchor probed in both home + session counts
  // as one fail-day if either phase failed, one ok-day only if both passed).
  // Anchors not probed this run keep their existing streak value untouched.
  // Skipped in re-probe mode: auto-heal verifies its patch against a fresh
  // probe in the same UTC day, and we don't want that verification run to
  // double-increment fail-streaks or reset a streak the daily-health run
  // already booked.
  if (!isReprobe) {
    updateStreak(outDir, results);
  } else {
    console.log('[ci-health] re-probe mode — skipping updateStreak + writing to .reprobe.json');
  }

  // One-line summary for the workflow log.
  const doctorSummary = doctor.spawnError ? `doctor DID NOT RUN (${doctor.spawnError})` : `doctor exit ${doctor.exitCode}`;
  const summary = `[ci-health] ${payload.ok ? 'OK' : 'FAIL'} — health ${counts.ok} ok / ${counts.degraded} degraded / ${counts.fail} fail / ${counts.skip} skip · ${doctorSummary} · v${payload.designerVersion}`;
  console.log(summary);
  if (counts.degraded > 0) {
    const degraded = results.filter((r) => r.status === 'degraded');
    console.log(
      `::warning title=${counts.degraded} anchor(s) running on superseded selectors::${degraded.map((r) => r.id).join(', ')} — the canonical selector is gone; re-capture before the legacy branch goes too`
    );
    console.log(degraded.map((r) => `  ${r.id} — ${r.detail || r.description}`).join('\n'));
  }
  // A doctor that never launched is a broken probe, not a passing one. It still
  // does NOT flip `payload.ok` (that stays the UI-anchor verdict, so a tooling
  // fault can never open a selectors-drift PR) — instead it produces the
  // `incomplete` verdict below, which is a THIRD workflow path. An annotation
  // alone does not change a step's outcome, so warning-only left a half-broken
  // probe reading as green to `Close stale drift PRs on green`.
  if (doctor.spawnError) {
    console.log(`::error title=designer doctor did not run::${doctor.spawnError} — the tooling-state half of this probe was skipped`);
  } else if (doctor.exitCode !== 0) {
    console.log(`::error title=designer doctor reported a broken toolchain::exit ${doctor.exitCode} — see the doctor block in the health artifact`);
  }
  if (fail) {
    const failed = results.filter((r) => r.status === 'fail').map((r) => `  ${r.id} — ${r.detail || r.description}`);
    console.log(failed.join('\n'));
  }
  console.log(`[ci-health] wrote ${path.relative(REPO_ROOT, outFile)}`);

  // Published so the workflow can refuse to close a drift PR while anchors are
  // running on superseded selectors. Deliberately NOT folded into the verdict:
  // degraded means the tool still works, and making it non-`ok` would fail the
  // daily job for a working system — the same trap as gating on doctor's exit
  // code. It withholds the green-only cleanup action instead.
  ghOutput('degraded', String(counts.degraded));
  const verdict = probeVerdict({
    anchorFail: fail,
    doctorSpawnError: doctor.spawnError,
    doctorExitCode: doctor.exitCode
  });
  // The workflow gates on this, not on the raw step outcome — `outcome` only has
  // success/failure, which cannot separate "UI drifted" from "probe broke".
  exitWith(verdict);
}

// Only orchestrate when executed as a script. Without this guard, merely
// IMPORTING this module (e.g. a unit test reaching for resolveDoctorBin) runs
// the full probe: launches Chrome, drives claude.ai, and overwrites today's
// artifact. Testability is the point — the doctor-path bug survived two months
// partly because nothing here could be exercised without a browser.
// realpath BOTH sides: import.meta.url is already resolved through symlinks, so
// comparing it to a raw argv[1] makes the guard silently false under a symlinked
// checkout (or an npm-linked bin) — the script would then be imported-but-never-run.
// Latent today (both workflows invoke by relative path), cheap to make robust.
const entry = process.argv[1] ? fs.realpathSync(process.argv[1]) : '';
const invokedDirectly = entry !== '' && fs.realpathSync(fileURLToPath(import.meta.url)) === entry;
if (invokedDirectly) {
  main().catch((e: Error) => {
    console.error(`[ci-health] threw: ${e.message}`);
    // An exception means the probe did not finish, so the workflow must see
    // `incomplete` rather than an unset verdict (which would gate to green).
    // Exit code stays 3 so "threw" remains distinguishable from a clean
    // incomplete verdict in the logs.
    exitWith('incomplete', 3);
  });
}
