import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { REPO_ROOT } from './repo-root.ts';

const SKILL_SRC = path.join(REPO_ROOT, 'skills', 'designer-loop', 'SKILL.md');
const SKILL_DEST_DIR = path.join(os.homedir(), '.claude', 'skills', 'designer-loop');
const SKILL_DEST = path.join(SKILL_DEST_DIR, 'SKILL.md');
const CHROME_BIN = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEFAULT_PORT = process.env.DESIGNER_CDP || '9222';
const PROFILE = path.join(os.homedir(), '.chrome-designer-profile');

type Status = 'ok' | 'wait' | 'fail';

function log(stage: string, status: Status, msg: string): void {
  const icon = status === 'ok' ? '✓' : status === 'wait' ? '·' : '✗';
  console.log(`${icon} [${stage}] ${msg}`);
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function isCdpUp(port: string): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function getDesignTab(port: string): Promise<{ url: string; title: string } | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    const tabs = (await res.json()) as Array<{ url?: string; title?: string }>;
    for (const t of tabs) {
      if (t.url && /claude\.ai\/design/.test(t.url) && !/login/i.test(t.url)) {
        return { url: t.url, title: t.title || '' };
      }
    }
    return null;
  } catch {
    return null;
  }
}

function chromeRunning(): boolean {
  const r = spawnSync('pgrep', ['-f', 'Google Chrome.app/Contents/MacOS/Google Chrome'], { stdio: 'pipe' });
  return r.status === 0 && (r.stdout?.toString().trim().length ?? 0) > 0;
}

async function pollUntil(
  name: string,
  fn: () => Promise<boolean> | boolean,
  opts: { intervalMs: number; timeoutMs: number; reminder: string; hint60s?: string }
): Promise<boolean> {
  const start = Date.now();
  let emittedReminder = false;
  let emittedHint = false;
  let dots = 0;
  while (Date.now() - start < opts.timeoutMs) {
    if (await fn()) {
      if (dots > 0) process.stdout.write('\n');
      return true;
    }
    const elapsed = Date.now() - start;
    if (!emittedReminder) {
      log(name, 'wait', opts.reminder);
      emittedReminder = true;
    } else {
      process.stdout.write('.');
      dots++;
    }
    if (!emittedHint && opts.hint60s && elapsed > 60_000) {
      process.stdout.write('\n');
      dots = 0;
      log(name, 'wait', opts.hint60s);
      emittedHint = true;
    }
    await sleep(opts.intervalMs);
  }
  if (dots > 0) process.stdout.write('\n');
  return false;
}

function lockfileHash(p: string): string | null {
  try {
    return createHash('sha1').update(fs.readFileSync(p)).digest('hex');
  } catch {
    return null;
  }
}

async function step1NpmInstall(): Promise<boolean> {
  const nm = path.join(REPO_ROOT, 'node_modules');
  const rootLock = path.join(REPO_ROOT, 'package-lock.json');
  const innerLock = path.join(nm, '.package-lock.json');
  // Installed mode: shipped tarball has no package-lock.json. If node_modules
  // exists, npm already placed deps — nothing to verify.
  if (!fs.existsSync(rootLock)) {
    if (fs.existsSync(nm)) {
      log('deps', 'ok', 'installed-mode (no package-lock to verify)');
      return true;
    }
    log('deps', 'fail', 'no package-lock.json and no node_modules — reinstall the package');
    return false;
  }
  if (fs.existsSync(nm)) {
    const a = lockfileHash(rootLock);
    const b = lockfileHash(innerLock);
    if (a && b && a === b) {
      log('deps', 'ok', 'node_modules in sync with package-lock');
      return true;
    }
    log('deps', 'wait', b ? 'lockfile mismatch; reinstalling...' : 'no inner lockfile; reinstalling to sync...');
  } else {
    log('deps', 'wait', 'running npm install...');
  }
  const r = spawnSync('npm', ['install'], { cwd: REPO_ROOT, stdio: 'inherit' });
  if (r.status !== 0) {
    log('deps', 'fail', `npm install exited ${r.status}`);
    return false;
  }
  log('deps', 'ok', 'installed');
  return true;
}

function step2AgentBrowser(): boolean {
  const r = spawnSync('agent-browser', ['--version'], { stdio: 'pipe' });
  if (r.status !== 0) {
    log('agent-browser', 'fail', 'not found on PATH. Install: brew install agent-browser  OR  npm i -g agent-browser');
    return false;
  }
  log('agent-browser', 'ok', r.stdout?.toString().trim() || 'present');
  return true;
}

async function step3Chrome(port: string): Promise<boolean> {
  if (await isCdpUp(port)) {
    log('chrome', 'ok', `CDP already up on :${port}`);
    return true;
  }
  if (chromeRunning()) {
    log('chrome', 'wait', 'A non-debug Chrome is running. Quit it (Cmd+Q on the Chrome menu, then close Activity Monitor entries if any). I am polling.');
    const quit = await pollUntil('chrome', () => !chromeRunning(), {
      intervalMs: 1000,
      timeoutMs: 5 * 60_000,
      reminder: 'Still waiting for Chrome to fully quit. Cmd+Q on Chrome.'
    });
    if (!quit) {
      log('chrome', 'fail', 'Timed out waiting for Chrome to quit. Quit manually then re-run setup.');
      return false;
    }
  }
  log('chrome', 'wait', `Launching debug Chrome on :${port} with --user-data-dir=${PROFILE}`);
  if (!fs.existsSync(CHROME_BIN)) {
    log('chrome', 'fail', `Chrome not found at ${CHROME_BIN}. Set CHROME_BIN to override.`);
    return false;
  }
  const child = spawn(CHROME_BIN, ['--remote-debugging-port=' + port, '--user-data-dir=' + PROFILE, 'https://claude.ai/design'], {
    detached: true,
    stdio: 'ignore'
  });
  child.unref();
  const up = await pollUntil('chrome', () => isCdpUp(port), {
    intervalMs: 800,
    timeoutMs: 30_000,
    reminder: `Waiting for CDP at :${port}...`
  });
  if (!up) {
    log('chrome', 'fail', 'Chrome launched but CDP did not come up. Try `./scripts/designer-chrome.sh` manually.');
    return false;
  }
  log('chrome', 'ok', `CDP up on :${port}`);
  return true;
}

async function step4SignIn(port: string): Promise<boolean> {
  const tab = await getDesignTab(port);
  if (tab) {
    log('login', 'ok', `Signed in. Tab on ${tab.url.replace(/\?.*$/, '')}`);
    return true;
  }
  log('login', 'wait', 'Sign in to Claude in the debug Chrome window I just opened, then navigate to claude.ai/design. I am polling.');
  const ok = await pollUntil('login', async () => (await getDesignTab(port)) !== null, {
    intervalMs: 2000,
    timeoutMs: 10 * 60_000,
    reminder: 'Still waiting for a tab on claude.ai/design (not on /login).',
    hint60s: "If Chrome shows a Google 'new device' or 2FA prompt, complete that first — setup is waiting on you."
  });
  if (!ok) {
    log('login', 'fail', 'Timed out waiting for sign-in. Re-run setup when ready.');
    return false;
  }
  log('login', 'ok', 'Signed in.');
  return true;
}

function step5Skill(): boolean {
  if (fs.existsSync(SKILL_DEST)) {
    let detail = `Already at ${SKILL_DEST}`;
    try {
      if (fs.lstatSync(SKILL_DEST_DIR).isSymbolicLink()) {
        detail = `Already at ${SKILL_DEST_DIR} → ${fs.realpathSync(SKILL_DEST_DIR)} (bootstrap-managed, leaving alone)`;
      }
    } catch {}
    log('skill', 'ok', detail);
    return true;
  }
  if (!fs.existsSync(SKILL_SRC)) {
    log('skill', 'fail', `Source missing at ${SKILL_SRC}; reclone repo?`);
    return false;
  }
  fs.mkdirSync(SKILL_DEST_DIR, { recursive: true });
  fs.copyFileSync(SKILL_SRC, SKILL_DEST);
  log('skill', 'ok', `Copied to ${SKILL_DEST}`);
  return true;
}

function step6Mcp(port: string): boolean {
  const claudeBin = spawnSync('which', ['claude'], { stdio: 'pipe' });
  if (claudeBin.status !== 0) {
    log('mcp', 'wait', 'claude CLI not on PATH; skipping MCP registration. Install Claude Code to register.');
    return true;
  }
  const list = spawnSync('claude', ['mcp', 'list'], { stdio: 'pipe' });
  const stdout = list.stdout?.toString() || '';
  if (/(\s|^)designer\b/i.test(stdout)) {
    log('mcp', 'ok', 'Already registered.');
    return true;
  }
  const wrapper = path.join(REPO_ROOT, 'bin', 'designer');
  if (!fs.existsSync(wrapper)) {
    log('mcp', 'fail', `Missing wrapper ${wrapper}`);
    return false;
  }
  const cmd = ['mcp', 'add', '--scope', 'user', '--transport', 'stdio', 'designer', '--', 'env', `DESIGNER_CDP=${port}`, wrapper, 'mcp', 'serve'];
  log('mcp', 'wait', `Registering: claude ${cmd.join(' ')}`);
  const reg = spawnSync('claude', cmd, { stdio: 'inherit' });
  if (reg.status !== 0) {
    log('mcp', 'fail', `claude mcp add exited ${reg.status}. Run manually:\n   claude ${cmd.join(' ')}`);
    return false;
  }
  log('mcp', 'ok', 'Registered.');
  return true;
}

export async function runSetup(): Promise<number> {
  console.log(`designer setup — port=${DEFAULT_PORT}, profile=${PROFILE}\n`);

  if (!(await step1NpmInstall())) return 1;
  if (!step2AgentBrowser()) return 1;
  if (!(await step3Chrome(DEFAULT_PORT))) return 1;
  if (!(await step4SignIn(DEFAULT_PORT))) return 1;
  if (!step5Skill()) return 1;
  if (!step6Mcp(DEFAULT_PORT)) return 1;

  console.log('\n✓ designer is ready. Verify:  designer doctor');
  console.log(`  (or: DESIGNER_CDP=${DEFAULT_PORT} tsx cli.ts doctor)`);
  if (!process.env.DESIGNER_CDP) {
    console.log(`\nTip: export DESIGNER_CDP=${DEFAULT_PORT} in your shell rc if you'll invoke the CLI directly (MCP callers don't need this).`);
  }
  return 0;
}
