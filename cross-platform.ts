import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, type SpawnOptions, type SpawnSyncOptions } from 'node:child_process';

export const IS_WIN = process.platform === 'win32';
export const IS_MAC = process.platform === 'darwin';

// On Windows, npm-installed CLIs are `.cmd`/`.ps1` shims that `spawn` cannot
// resolve without `shell: true`. On macOS/Linux they are real executables.
// Use this for commands that come from npm (npm, agent-browser, claude, etc.)
// or system tools that may not be on PATH as a real binary on Windows.
export function shimSpawnOpts<T extends SpawnOptions | SpawnSyncOptions>(opts: T = {} as T): T {
  return IS_WIN ? ({ ...opts, shell: true } as T) : opts;
}

// Returns the `which` / `where` command name for the current OS.
export const WHICH = IS_WIN ? 'where' : 'which';

// Default Chrome binary path per OS. Override with the CHROME_BIN env var.
export function defaultChromeBin(): string {
  if (IS_WIN) {
    const candidates = [
      path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env['LOCALAPPDATA'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ];
    for (const c of candidates) if (c && fs.existsSync(c)) return c;
    return candidates[0] ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  }
  if (IS_MAC) return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  // Linux defaults
  for (const c of ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']) {
    if (fs.existsSync(c)) return c;
  }
  return '/usr/bin/google-chrome';
}

// Cross-platform "is a non-debug Chrome currently running?" check.
// Used to refuse auto-launching debug Chrome when it would either no-op or
// fight with an existing user session.
export function isChromeRunning(): boolean {
  if (IS_WIN) {
    // tasklist is shipped with Windows. /FI filters by image name; /NH suppresses headers.
    const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq chrome.exe', '/NH', '/FO', 'CSV'], shimSpawnOpts({ stdio: 'pipe' }));
    if (r.status !== 0) return false;
    const out = r.stdout?.toString() || '';
    // tasklist prints "INFO: No tasks..." on stdout when nothing matches.
    return out.toLowerCase().includes('chrome.exe');
  }
  if (IS_MAC) {
    const r = spawnSync('pgrep', ['-f', 'Google Chrome.app/Contents/MacOS/Google Chrome'], { stdio: 'pipe' });
    return r.status === 0 && (r.stdout?.toString().trim().length ?? 0) > 0;
  }
  // Linux
  const r = spawnSync('pgrep', ['-f', 'chrome'], { stdio: 'pipe' });
  return r.status === 0 && (r.stdout?.toString().trim().length ?? 0) > 0;
}

// User-friendly "press X to quit Chrome" hint per OS.
export const QUIT_CHROME_HINT = IS_WIN
  ? 'Close all Chrome windows (or end chrome.exe in Task Manager).'
  : IS_MAC
    ? 'Cmd+Q on the Chrome menu, then close Activity Monitor entries if any.'
    : 'Close all Chrome windows or `pkill chrome`.';
