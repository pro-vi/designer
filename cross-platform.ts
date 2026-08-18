import fs from 'node:fs';
import path from 'node:path';
import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from 'node:child_process';
import crossSpawn from 'cross-spawn';

export const IS_WIN = process.platform === 'win32';
export const IS_MAC = process.platform === 'darwin';

// Drop-in replacements for `child_process.spawn` / `spawnSync`.
//
// On Windows, npm-installed CLIs are `<name>.cmd` shims (sometimes `.ps1`)
// that Node ≥ 21 refuses to spawn directly (security policy: `EINVAL`), and
// that misbehave under `shell: true` when args contain shell metacharacters
// (parens, quotes, redirects — common in JS code passed to `agent-browser eval`).
//
// `cross-spawn` resolves shim paths and invokes them via `cmd /c` with proper
// argv quoting. Used by 100M+ npm packages; this is the standard fix.
//
// On macOS/Linux it's a passthrough to `child_process` — no behavior change.
export const xspawn = crossSpawn;
export const xspawnSync = crossSpawn.sync;

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
  for (const c of ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']) {
    if (fs.existsSync(c)) return c;
  }
  return '/usr/bin/google-chrome';
}

// Process NAMES a real Chrome/Chromium main process carries on Linux, as an
// anchored `pgrep -x` alternation. Two constraints shaped this list (#114):
//
//  - Linux truncates a process name to 15 chars, so `chromium-browser` is only
//    ever visible as `chromium-browse`. Matching the untruncated spelling finds
//    nothing.
//  - The names must stay near-miss free, because `setup.ts` treats a match as
//    "a non-debug Chrome is running", polls five minutes, then hard-fails. The
//    excluded neighbours are `chromedriver`, `chrome-sandbox`, and
//    `chrome_crashpad` (itself the truncation of `chrome_crashpad_handler`,
//    which can outlive a Chrome quit).
//
// Verified on debian:stable-slim + procps against processes carrying each name.
export const LINUX_CHROME_PROCESS_NAMES = 'chrome|chromium|chromium-browse|google-chrome';

// The probe argv behind isChromeRunning(), separated so the per-OS decision is
// testable without spawning anything. Takes the platform explicitly so one test
// process can assert all three branches.
export function chromeRunningProbe(platform: NodeJS.Platform = process.platform): {
  cmd: string;
  args: string[];
} {
  if (platform === 'win32') {
    return { cmd: 'tasklist', args: ['/FI', 'IMAGENAME eq chrome.exe', '/NH', '/FO', 'CSV'] };
  }
  if (platform === 'darwin') {
    // Full-path match: specific enough that no near-miss collides.
    return { cmd: 'pgrep', args: ['-f', 'Google Chrome.app/Contents/MacOS/Google Chrome'] };
  }
  // `-x` anchors against the process NAME. The previous `-f chrome` matched the
  // whole command line, which both over-matched (any argv naming a chrome* file
  // blocked setup for five minutes) and under-matched (`chromium` does not
  // contain the substring `chrome`, so a real Chromium was never detected).
  return { cmd: 'pgrep', args: ['-x', LINUX_CHROME_PROCESS_NAMES] };
}

// Cross-platform "is a non-debug Chrome currently running?" check.
export function isChromeRunning(): boolean {
  const { cmd, args } = chromeRunningProbe();
  const r = nodeSpawnSync(cmd, args, { stdio: 'pipe' });
  if (IS_WIN) {
    if (r.status !== 0) return false;
    return (r.stdout?.toString() || '').toLowerCase().includes('chrome.exe');
  }
  return r.status === 0 && (r.stdout?.toString().trim().length ?? 0) > 0;
}

// User-friendly "press X to quit Chrome" hint per OS.
export const QUIT_CHROME_HINT = IS_WIN
  ? 'Close all Chrome windows (or end chrome.exe in Task Manager).'
  : IS_MAC
    ? 'Cmd+Q on the Chrome menu, then close Activity Monitor entries if any.'
    : 'Close all Chrome windows or `pkill chrome`.';

// Re-export node's native spawn for callers that explicitly need it
// (e.g. spawning Chrome itself, where path is fully resolved already).
export { nodeSpawn, nodeSpawnSync };
