#!/usr/bin/env -S node --import tsx
// Daily-health orchestrator. Invoked by .github/workflows/daily-health.yml on
// the self-hosted Mac mini runner where real Chrome + the dedicated profile
// live. Combines `designer doctor` (tooling state) + `designer health` (UI
// anchors) + a diagnostic a11y snapshot into one artifact.
//
// Output: artifacts/health/<YYYY-MM-DD>.json. Exit code 2 on any health fail.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createBrowser } from '../browser.ts';
import { runHealth } from '../ui-anchors.ts';
import { REPO_ROOT } from '../repo-root.ts';

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

async function maybeSnapshot(): Promise<{ url: string; htmlBytes: number; screenshotPath?: string } | null> {
  // Only fired when health regressed — gives a human enough state to diagnose
  // a Claude Design selector drift without us having to ssh into the runner.
  try {
    const browser = createBrowser({ session: 'designer-default' });
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
  const doctor = runDoctor();

  const browser = createBrowser({ session: 'designer-default' });
  const results = await runHealth(browser);
  const counts = results.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] || 0) + 1;
    return acc;
  }, {});
  const fail = results.some((r) => r.status === 'fail');
  const url = (await browser.url().catch(() => '')) || '';

  const diag = fail ? await maybeSnapshot() : null;

  const payload = {
    ok: !fail,
    generatedAt: startedAt,
    finishedAt: new Date().toISOString(),
    designerVersion: pkgVersion(),
    chromeUrl: url,
    doctor,
    health: {
      ok: !fail,
      counts: { ok: counts['ok'] || 0, fail: counts['fail'] || 0, skip: counts['skip'] || 0 },
      results
    },
    diagnostics: diag
  };

  const outDir = path.join(REPO_ROOT, 'artifacts', 'health');
  ensureDir(outDir);
  const outFile = path.join(outDir, `${todayUtc()}.json`);
  fs.writeFileSync(outFile, JSON.stringify(payload, null, 2));

  // One-line summary for the workflow log.
  const summary = `[ci-health] ${payload.ok ? 'OK' : 'FAIL'} — health ${counts['ok'] || 0} ok / ${counts['fail'] || 0} fail / ${counts['skip'] || 0} skip · doctor exit ${doctor.exitCode} · v${payload.designerVersion}`;
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
