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
{
  const url = process.env.DESIGNER_PROBE_PROJECT_URL ?? '';
  const ok = /^https:\/\/claude\.ai\/design\/p\/[a-f0-9-]+/i.test(url);
  report(ok, 'canary project URL', ok ? url : `"${url}" (expected https://claude.ai/design/p/<uuid>)`);
  if (!ok) {
    failures.push(
      `DESIGNER_PROBE_PROJECT_URL is unset or malformed ("${url}") — the session.* / share.* anchors can't be exercised. ` +
        `Set it to a stable single-file canary project.`
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
