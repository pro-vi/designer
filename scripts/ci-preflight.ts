import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Environment preflight for the daily-health probe.
//
// It asserts the probe can ACTUALLY DO ITS JOB — before the anchor sweep runs — so
// that a broken PROBE ENVIRONMENT fails loud and DISTINCT (a red CI job + a
// notification) instead of masquerading as claude.ai UI drift (a selectors-drift
// PR). That masquerade is exactly what let the chronic Node-20 bug hide for weeks:
// on Node <22 the native global WebSocket is undefined, so the in-process CDP
// readers (OopifHtmlReader / RunStateObserver) return null and every CDP anchor
// false-failed — indistinguishable, to a human skimming the daily PR, from Claude
// moving a button.
//
// Wire-up (daily-health.yml): this runs as its OWN step WITHOUT continue-on-error,
// BEFORE `Run health probe`. A non-zero exit fails the job and stops it there, so
// the probe + `Open selectors-drift PR` steps never run — no misleading drift PR.
// Anchor (content) failures still flow through the probe step into a drift PR;
// only ENVIRONMENT failures are diverted here.

interface Pkg {
  engines?: { node?: string };
}

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as Pkg;

const failures: string[] = [];
function report(ok: boolean, name: string, detail: string): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} — ${detail}`);
}

// 1. Node runtime satisfies the declared engine AND exposes native WebSocket.
//    This is THE check that would have caught the Node-20 regression on day one.
{
  const engines = pkg.engines?.node ?? '>=22';
  const floorMajor = Number.parseInt((engines.match(/\d+/) ?? ['22'])[0], 10);
  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
  const wsPresent = 'WebSocket' in globalThis;
  const ok = nodeMajor >= floorMajor && wsPresent;
  report(ok, 'node runtime', `node ${process.versions.node}, engines "${engines}", WebSocket ${wsPresent ? 'present' : 'MISSING'}`);
  if (!ok) {
    failures.push(
      `Node ${process.versions.node} does not satisfy engines "${engines}" or lacks the native global WebSocket. ` +
        `The in-process CDP readers need Node >=22 — on older Node they return null and every CDP anchor false-fails. ` +
        `Fix the runner/workflow Node (see .nvmrc), do NOT read this as UI drift.`
    );
  }
}

// 2. CDP endpoint reachable — the signed-in debug Chrome must be up on the port.
{
  const raw = process.env.DESIGNER_CDP;
  const port = raw && raw.length > 0 ? raw : '9222';
  let ok = false;
  let detail = `port ${port}`;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      const body = (await res.json()) as { Browser?: string };
      ok = true;
      detail = `port ${port}, ${body.Browser ?? 'Chrome'}`;
    } else {
      detail = `port ${port}, HTTP ${res.status}`;
    }
  } catch (e) {
    detail = `port ${port}, ${(e as Error).message}`;
  }
  report(ok, 'CDP endpoint', detail);
  if (!ok) {
    failures.push(
      `No CDP endpoint answered on port ${port} — the signed-in debug Chrome isn't running (or DESIGNER_CDP points elsewhere). ` +
        `Start the Chrome profile before the probe; this is an environment problem, not UI drift.`
    );
  }
}

// 3. Canary project URL is set and well-formed (the session/share anchors need it).
const canaryUrl = process.env.DESIGNER_PROBE_PROJECT_URL ?? '';
{
  const ok = /^https:\/\/claude\.ai\/design\/p\/[a-f0-9-]+/i.test(canaryUrl);
  report(ok, 'canary project URL', ok ? canaryUrl : `"${canaryUrl}" (expected https://claude.ai/design/p/<uuid>)`);
  if (!ok) {
    failures.push(
      `DESIGNER_PROBE_PROJECT_URL is unset or malformed ("${canaryUrl}") — the session.* / share.* anchors can't be exercised. ` +
        `Set it to a stable single-file canary project.`
    );
  }
}

// 4. The canary project still EXISTS.
//
// Shape was the only thing checked here until 2026-08-02, and shape survives
// deletion: a deleted project keeps answering on its own /design/p/<uuid> URL,
// serving a "Project not found" body. Both canaries had in fact been deleted
// while the preflight passed — so the session anchors were being read as UI
// drift when the real cause was that the page under them was gone. A dead
// canary is an ENVIRONMENT failure, which is precisely what this file exists
// to separate from claude.ai drift.
//
// Checked through the live CDP Chrome rather than a bare fetch: claude.ai/design
// is a signed-in SPA, so an unauthenticated request cannot distinguish
// "deleted" from "not logged in".
if (canaryUrl && !failures.length) {
  const { createBrowser } = await import('../browser.ts');
  const NOT_FOUND_RE = /project not found|may have been deleted|you might not have access/i;
  let ok = false;
  let detail = canaryUrl;
  try {
    const browser = createBrowser({ session: 'designer-default', timeoutMs: 20_000 });
    await browser.open(canaryUrl);
    // The composer is the session-phase readiness marker every session anchor
    // needs; waiting on it also gives the SPA time to render the not-found body.
    await browser.waitFor('[data-testid="chat-composer-input"]').catch(() => undefined);
    const probe = await browser
      .evalValue<{ text: string; composer: boolean }>(
        `(() => ({ text: (document.body ? document.body.innerText : '').slice(0, 400),
                   composer: !!document.querySelector('[data-testid="chat-composer-input"]') }))()`
      )
      .catch(() => null);
    if (!probe) {
      detail = `${canaryUrl} — could not read the page`;
    } else if (NOT_FOUND_RE.test(probe.text)) {
      detail = `${canaryUrl} — claude.ai says the project is gone`;
    } else if (!probe.composer) {
      detail = `${canaryUrl} — loaded, but no chat composer rendered`;
    } else {
      ok = true;
      detail = `${canaryUrl} — loads, composer present`;
    }
  } catch (e) {
    detail = `${canaryUrl} — ${(e as Error).message}`;
  }
  report(ok, 'canary project exists', detail);
  if (!ok) {
    failures.push(
      `The canary project did not load a usable session (${detail}). Every session.* / share.* anchor would fail ` +
        `for that reason alone — do NOT read those failures as UI drift. Create a fresh single-file project and ` +
        `update DESIGNER_PROBE_PROJECT_URL in BOTH .github/workflows/daily-health.yml and auto-heal.yml.`
    );
  }
}

// 5. Both workflows name the SAME canary.
//
// auto-heal re-probes to decide whether its patch worked, and that verification
// is only meaningful against the page the original probe measured. The two
// values were kept in sync "by convention" and had silently diverged — pointing
// at two different (both deleted) projects. Convention is not a check.
{
  const read = (wf: string): string | null => {
    const p = path.join(repoRoot, '.github', 'workflows', wf);
    if (!fs.existsSync(p)) return null;
    const m = fs.readFileSync(p, 'utf8').match(/DESIGNER_PROBE_PROJECT_URL:\s*(\S+)/);
    return m?.[1] ?? null;
  };
  const daily = read('daily-health.yml');
  const heal = read('auto-heal.yml');
  const ok = daily != null && heal != null && daily === heal;
  report(ok, 'canary URL agrees across workflows', ok ? `both = ${daily}` : `daily-health=${daily ?? 'missing'} auto-heal=${heal ?? 'missing'}`);
  if (!ok) {
    failures.push(
      `daily-health.yml and auto-heal.yml name different canary projects (${daily ?? 'missing'} vs ${heal ?? 'missing'}). ` +
        `auto-heal verifies its patch by re-probing, so a mismatch verifies against the wrong page.`
    );
  }
}

if (failures.length > 0) {
  console.error('\nPREFLIGHT FAILED — the probe ENVIRONMENT is broken (this is NOT claude.ai UI drift):');
  for (const f of failures) console.error(`  • ${f}`);
  console.error('\nResolve the environment above. Do not treat a preflight failure as a selectors-drift signal.');
  process.exit(1);
}

console.log('\npreflight ok — environment can run the probe');
