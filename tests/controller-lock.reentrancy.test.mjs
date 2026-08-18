import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../repo-root.ts';

const raw = fs.readFileSync(path.join(REPO_ROOT, 'designer-controller.ts'), 'utf8');

// Match CODE, not prose. These files carry dense incident comments that name the
// very APIs under test ("...calls listFiles(), which navigates (openGuarded)"),
// so a source scan that includes comments reports the explanation as a
// violation — the same read-the-prose-not-the-code mistake these tests exist to
// catch elsewhere.
const stripComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const src = stripComments(raw);

/**
 * Slice between two landmarks, THROWING if either is missing.
 *
 * `indexOf` returning -1 makes `slice(a, -1)` run to end-of-file, which turned
 * one of these tests into a 47k-character no-op that still passed — after the
 * comment-stripper deleted the doc-comment it was slicing on. A landmark that
 * moved must fail the test, not silently widen it.
 */
function between(text, startMark, endMark) {
  const a = text.indexOf(startMark);
  assert.ok(a >= 0, `slice landmark not found: ${startMark}`);
  const b = text.indexOf(endMark, a + startMark.length);
  assert.ok(b > a, `slice end landmark not found after start: ${endMark}`);
  return text.slice(a, b);
}

// The lock's three load-bearing properties. Each is asserted structurally
// because the behaviour needs a live browser; the acquire/release arithmetic
// itself is unit-tested in controller-lock.acquire.test.mjs.

test('the lock resource is the SESSION (the active tab), not the key or the project', () => {
  const body = src.slice(src.indexOf('private _lockKey()'), src.indexOf('private _busyHolder()'));
  assert.match(body, /this\.browser\.driverId/, 'lock keys on the driver session');
  assert.ok(!/designUrl/.test(body), 'project root must NOT scope the lock — openGuarded navigates the ACTIVE tab');
  assert.ok(!/this\.key/.test(body), 'controller key must not scope the lock — keys share one session in CDP mode');
});

test('re-entrancy is per async OPERATION, not per controller instance', () => {
  // The single implementation lives in the standalone withTabLock; the
  // controller delegates to it (asserted separately).
  const body = between(src, 'export async function withTabLock', 'export class DesignerController');
  assert.match(body, /LOCK_CTX\.getStore\(\)/, 're-entrancy is decided from the async context');
  assert.match(body, /LOCK_CTX\.run\(/, 'the held set is propagated to nested calls');
  // An instance flag would let two concurrent calls on ONE controller both
  // proceed — the MCP server caches one controller per key, so that is reachable.
  assert.ok(!/this\._held|this\._depth/.test(body), 'must not use an instance-level re-entrancy flag');
});

// Methods that may mutate the tab without locking, each with the reason. A
// PUBLIC method reaching a mutation and absent from this list fails the test
// below — the point is that a future author cannot add one silently, which a
// hand-maintained "must lock" list could not catch (it only checked names it
// already knew).
const MUTATION_OK = {
  _openGuarded: 'the navigation primitive itself; every caller is wrapped',
  openGuarded: 'the navigation primitive itself; every caller is wrapped',
  _submitPrompt: 'private; only reached from iterate/ask bodies, which hold the lock',
  sendPrompt: 'thin private-ish wrapper over _submitPrompt, same callers',
  _clickButtonByText: 'private helper; only reached from locked bodies',
  _waitForInterstitialClear: 'private; reached from clearInterstitials body',
  // NOTE: no entry here may mean "this method takes the lock" — that must be
  // ASSERTED, not exempted. Removing the lock from snapshotFile/iterate/ask/
  // deleteFile used to keep the suite green precisely because they were listed.
};

// Inverted on purpose: enumerating MUTATORS meant every facade method someone
// forgot (browser.close, browser.reload, run(['open',…]), an evalValue that
// clicks) was invisible. Enumerate the small, stable READ-ONLY surface instead,
// and treat every other browser call — plus navigation and in-page clicks — as a
// mutation.
const READ_ONLY_BROWSER = new Set([
  'url', 'title', 'tabs', 'cookies', 'snapshot', 'snapshotText', 'getText',
  'getAttr', 'getHtml', 'isVisible', 'waitFor', 'waitLoad', 'screenshot', 'eval', 'evalValue'
]);
function mutatesTab(body) {
  if (/openGuarded\(|activateTab\(/.test(body)) return true;
  // An evalValue that clicks is still a mutation, however it is dressed up.
  if (/evalValue\([^)]*click|clickTriggerExpr\(|\.click\(\)/.test(body)) return true;
  for (const m of body.matchAll(/\bbrowser\.([A-Za-z_][A-Za-z0-9_]*)\(/g)) {
    if (!READ_ONLY_BROWSER.has(m[1])) return true;
  }
  return /\brun\(\[\s*'(open|click|hover|press|fill|type|reload|close|mouse|tab)'/.test(body);
}
const MUTATORS = { test: mutatesTab };

/** Split the controller class into (methodName -> body) by top-level members. */
function methodBodies(source) {
  const out = {};
  const re = /^  (?:private |protected )?(?:async )?(?:get )?([A-Za-z_][A-Za-z0-9_]*)\s*[(<]/gm;
  const hits = [...source.matchAll(re)];
  hits.forEach((m, i) => {
    const end = i + 1 < hits.length ? hits[i + 1].index : source.length;
    out[m[1]] = source.slice(m.index, end);
  });
  return out;
}

test('every method that mutates the tab either locks or is explicitly exempt', () => {
  const bodies = methodBodies(src);
  const offenders = [];
  for (const [name, body] of Object.entries(bodies)) {
    if (!MUTATORS.test(body)) continue;
    if (Object.prototype.hasOwnProperty.call(MUTATION_OK, name)) continue;
    // A body that IS the implementation behind a wrapper is fine — the wrapper
    // holds the lock. Those are named _xxxBody by convention.
    if (/^_.*Body$/.test(name)) {
      const verb = name.replace(/^_/, '').replace(/Body$/, '');
      // Containment, not existence: the wrapper named `verb` must itself take
      // the lock AND call this body. A file-wide substring match let the string
      // live at any other call site while the public verb ran unlocked.
      const wrapper = bodies[verb];
      if (
        wrapper &&
        new RegExp(`_withExclusive\\('${verb}'`).test(wrapper) &&
        new RegExp(`this\\._${verb}Body\\(`).test(wrapper)
      )
        continue;
      offenders.push(`${name} (no ${verb}() wrapper that locks and calls it)`);
      continue;
    }
    if (new RegExp(`_withExclusive\\('${name}'`).test(bodies[name] ?? '')) continue;
    offenders.push(name);
  }
  assert.deepEqual(
    offenders,
    [],
    `these methods drive the tab without the lock and are not exempt: ${offenders.join(', ')}`
  );
});

test('status stays lock-free — it is documented as safe to call at any time', () => {
  const body = between(src, 'async session(opts:', 'async ensureReady()');
  assert.match(body, /=== 'status'\) return this\._sessionBody/, "action='status' must bypass the lock");
  // …and it must be genuinely read-only, or bypassing the lock reopens a
  // navigation escape.
  const status = between(src, 'async getStatus()', 'private async detectAwaitingClarification');
  assert.match(status, /_scrapeVisibleFiles/, 'getStatus must not call the navigating listFiles');
  assert.ok(!/openGuarded|this\.listFiles\(/.test(status), 'getStatus must not navigate');
});

test('the commit boundary begins at the first dispatch, not at actuate()s return', () => {
  const body = stripComments(between(raw, 'const actuate = async', '--- RESOLVE'));
  assert.match(body, /dispatched: boolean/, 'actuate reports whether it issued a click');
  // COMPLETENESS, not a count: `>= 2` passed with two of the four sites deleted.
  // Every click issued anywhere in actuate must be preceded by the flag.
  const clickSites = [...body.matchAll(/this\.browser\.(click|clickAt)\(|e\.click\(\)/g)];
  assert.ok(clickSites.length >= 3, `expected actuate to have several click sites, found ${clickSites.length}`);
  for (const m of clickSites) {
    const before = body.slice(Math.max(0, m.index - 260), m.index);
    assert.match(before, /dispatched = true;/, `click site at ${m.index} is not preceded by dispatched = true`);
  }
});

test('the settle uses the shared counter reducer rather than ad-hoc arithmetic', () => {
  // The arithmetic itself is unit-tested in files-switcher.settle.test.mjs;
  // this only proves the controller routes through it.
  // Slice by the comment landmarks in RAW source, then strip comments inside it.
  const body = stripComments(between(raw, 'POSITIVE SETTLE', 'POST-SUCCESS'));
  assert.match(body, /classifySettleRead\(/, 'the observation is classified by the tested classifier');
  assert.match(body, /foldSettleRead\(/, 'every observation goes through the reducer');
  assert.match(body, /counters\.consecutive >= 2/, 'success needs two consecutive reads');
  // Each poll must be a fresh MOUNT, or "consecutive reads" are re-reads of one
  // stale subtree — which is how a deleted file kept reading as present.
  assert.match(body, /closeSwitcher\(\)[\s\S]{0,200}openSwitcherTracked\(\)/, 'each settle read remounts the popover');
  // The VARIABLE must reach the classifier — passing a literal `true` here is a
  // wiring defect that no pure test can see.
  assert.match(body, /const \{ state, remounted \} = await openSwitcherTracked\(\)/, 'the opener reports real remounts');
  assert.match(body, /observed\?\.reused \?\? false,\s*\n\s*remounted\s*\n\s*\)/, 'remounted is passed through, not hardcoded');
  // Falling out of the loop on the DEADLINE is not success. This guard was
  // deleted once by a block rewrite and nothing caught it.
  assert.match(body, /counters\.consecutive < 2 \|\| !lastGoodRows/, 'deadline exit must not reach POST-SUCCESS');
  assert.ok(!/sawTargetPresent/.test(body), 'the single-read latch is gone');
});

// The invariant cannot be enforced at the controller boundary alone, because
// `browser` is a public field and runHealth takes one. Every place that hands a
// raw Browser to something that clicks must take the lock itself.
test('the health walk drives the tab under the lock, not around it', async () => {
  const cli = stripComments(fs.readFileSync(path.join(REPO_ROOT, 'cli.ts'), 'utf8'));
  const ci = stripComments(fs.readFileSync(path.join(REPO_ROOT, 'scripts/ci-health.ts'), 'utf8'));
  for (const [name, source] of [['cli.ts', cli], ['scripts/ci-health.ts', ci]]) {
    const calls = [...source.matchAll(/runHealth\(/g)];
    assert.ok(calls.length > 0, `${name} should call runHealth`);
    for (const m of calls) {
      const before = source.slice(Math.max(0, m.index - 120), m.index);
      assert.match(before, /withTabLock\(/, `${name}: runHealth at ${m.index} is not inside withTabLock`);
    }
  }
});

test('there is ONE lock implementation, not a controller copy and a standalone copy', () => {
  const impls = [...src.matchAll(/tryAcquireDriverLock\(DRIVER_LOCKS/g)];
  assert.equal(impls.length, 1, 'a second acquire path would drift from the first');
  assert.match(src.slice(src.indexOf('private async _withExclusive')), /return withTabLock\(/, 'the controller delegates');
});

// A decision record nobody can find is not a record. This repo keeps rationale
// in code comments, so a separate doc only earns its place if the code and the
// README point at it — and it drifted from the shipped union once already.
test('ADR 0001 is reachable from the code and the README it governs', async () => {
  const adr = 'docs/adr/0001-destructive-ui-automation-safety.md';
  assert.ok(fs.existsSync(path.join(REPO_ROOT, adr)), 'the ADR exists');
  const readme = fs.readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8');
  assert.match(readme, /docs\/adr\/0001/, 'README links the ADR — it is the only shipped doc');
  for (const f of ['files-switcher.ts', 'designer-controller.ts']) {
    const source = fs.readFileSync(path.join(REPO_ROOT, f), 'utf8');
    assert.match(source, /docs\/adr\/0001/, `${f} points at the ADR at the point of use`);
  }
});
