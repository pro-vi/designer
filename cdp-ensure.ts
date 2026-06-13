import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { defaultChromeBin, isChromeRunning, QUIT_CHROME_HINT } from './cross-platform.ts';

const PORT = process.env.DESIGNER_CDP || '9222';
const PROFILE = path.join(os.homedir(), '.chrome-designer-profile');
const CHROME_BIN = process.env.CHROME_BIN || defaultChromeBin();

async function isCdpUp(): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Make sure a debug Chrome is listening on CDP before the first tool call.
// Auto-launch is gated on three conditions:
//   1. CDP is down (no existing debug server)
//   2. The dedicated profile exists (user already consented once via `designer setup`)
//   3. No non-debug Chrome is running (launching would either no-op or steal focus)
// Otherwise: return an actionable error the caller can surface to the user.
export async function ensureCdpUp(): Promise<void> {
  // Respect the explicit opt-out (DESIGNER_CDP=''): never probe or auto-launch
  // the debug Chrome for a user who chose the agent-browser session-managed flow.
  // Throwing here makes any stray CdpSession.attach() degrade to null cleanly.
  if (process.env.DESIGNER_CDP === '') {
    throw new Error("CDP explicitly disabled (DESIGNER_CDP=''); using the agent-browser session-managed flow.");
  }
  if (await isCdpUp()) return;

  if (!fs.existsSync(PROFILE)) {
    throw new Error(
      `CDP not up on :${PORT} and no dedicated Chrome profile at ${PROFILE}. Run: designer setup`
    );
  }

  if (isChromeRunning()) {
    throw new Error(
      `CDP not up on :${PORT} and a non-debug Chrome is already running. ${QUIT_CHROME_HINT} Then retry, or run: designer setup`
    );
  }

  if (!fs.existsSync(CHROME_BIN)) {
    throw new Error(
      `CDP not up on :${PORT} and Chrome not found at ${CHROME_BIN}. Set CHROME_BIN or install Chrome.`
    );
  }

  const child = spawn(
    CHROME_BIN,
    ['--remote-debugging-port=' + PORT, '--user-data-dir=' + PROFILE, 'https://claude.ai/design'],
    { detached: true, stdio: 'ignore' }
  );
  child.unref();

  for (let i = 0; i < 40; i++) {
    await sleep(500);
    if (await isCdpUp()) return;
  }
  throw new Error(
    `Auto-launched Chrome but CDP didn't come up on :${PORT} within 20s. Check that the launched window survived, or run designer setup.`
  );
}
