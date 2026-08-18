import assert from 'node:assert/strict';
import test from 'node:test';

import { chromeRunningProbe, LINUX_CHROME_PROCESS_NAMES } from '../cross-platform.ts';

// Regression coverage for #114: on Linux the probe was `pgrep -f chrome`, which
// matches the whole command line. setup.ts treats a match as "a non-debug Chrome
// is running", then polls for five minutes and hard-fails — so a stray
// chromedriver made `designer setup` unusable, and quitting Chrome could not fix
// it because Chrome was never what matched.
//
// The names and truncations asserted below were observed on debian:stable-slim
// with procps, running one process per name.

// Stand-in for `pgrep -x <ere>`: anchored match against the process NAME.
const pgrepExactMatches = (name) => new RegExp(`^(?:${LINUX_CHROME_PROCESS_NAMES})$`).test(name);

test('the Linux probe anchors on the process name, not the command line', () => {
  const { cmd, args } = chromeRunningProbe('linux');
  assert.equal(cmd, 'pgrep');
  assert.ok(args.includes('-x'), 'must use -x (name match)');
  assert.ok(!args.includes('-f'), '-f matches the full command line and reintroduces #114');
});

test('a real Chrome or Chromium main process still matches', () => {
  // `chromium-browse` is what Linux reports for chromium-browser: process names
  // truncate at 15 chars, so the untruncated spelling would match nothing.
  for (const name of ['chrome', 'chromium', 'chromium-browse', 'google-chrome']) {
    assert.equal(pgrepExactMatches(name), true, name);
  }
});

test('near-miss processes no longer block setup', () => {
  // chrome_crashpad is itself the 15-char truncation of chrome_crashpad_handler,
  // which can outlive a Chrome quit — the case that made the timeout unfixable.
  for (const name of ['chromedriver', 'chrome-sandbox', 'chrome_crashpad', 'chrome_crashpad_handler']) {
    assert.equal(pgrepExactMatches(name), false, name);
  }
});

test('an editor or shell merely naming a chrome file does not match', () => {
  for (const name of ['vim', 'node', 'bash']) assert.equal(pgrepExactMatches(name), false, name);
});

test('the macOS and Windows branches are unchanged', () => {
  const mac = chromeRunningProbe('darwin');
  assert.equal(mac.cmd, 'pgrep');
  assert.deepEqual(mac.args, ['-f', 'Google Chrome.app/Contents/MacOS/Google Chrome']);

  const win = chromeRunningProbe('win32');
  assert.equal(win.cmd, 'tasklist');
  assert.deepEqual(win.args, ['/FI', 'IMAGENAME eq chrome.exe', '/NH', '/FO', 'CSV']);
});
