import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

import { resolveDoctorBin, probeVerdict, EXIT_CODE, navMatch } from '../scripts/ci-health.ts';
import {
  findAnchor,
  findAnchorTarget,
  canPatch,
  patchSelectorsJson,
  readSelectorsKey,
  isLegacyGroup,
  legacyPathFor
} from '../scripts/anchor-patcher.ts';
import {
  classifyCandidates,
  isStructurallyBlind,
  patchableAnchorIds,
  findCollateralRegressions,
  selectorKeyConsumers
} from '../scripts/auto-heal.ts';
import { orderedBranches, presenceSelector } from '../selectors.ts';
import { UI_ANCHORS } from '../ui-anchors.ts';
import { REPO_ROOT } from '../repo-root.ts';

// Regression coverage for the 2026-07-25 audit: three layers of the health
// apparatus each reported success while asserting nothing.
//   * ci-health spawned `bin/designer`, which does not exist -> `designer doctor`
//     never ran for ~2 months and reported exitCode -1 forever (#130).
//   * auto-heal ran daily with conclusion "success" while unable to patch a
//     single anchor, because centralizing selectors into selectors.json removed
//     the inline string literals its AST patcher rewrites (#129 item 0).
// The through-line: "never ran" was indistinguishable from "healthy". These
// tests make each layer assert its own capability.

// --- the artifact must say WHICH page it measured ---
// Redaction maps every project UUID to the same `<redacted>` token, so a reader
// of the committed artifact cannot tell a canary hit from a canary miss. That
// ambiguity is why five green session phases could not be trusted once the
// canary turned out to be deleted. navMatch is computed pre-redaction.

test('navMatch distinguishes two different projects', () => {
  const a = 'https://claude.ai/design/p/6c5115ec-b27c-46b8-a7d9-1b09df042eff';
  const b = 'https://claude.ai/design/p/a9f7ac92-1cc3-480f-93b9-ea91d5ae55c5';
  assert.equal(navMatch(a, b), false, 'landing on another project must not read as reaching the canary');
  assert.equal(navMatch(a, a), true);
});

test('navMatch ignores query strings and case, which are not a different project', () => {
  const bare = 'https://claude.ai/design/p/6C5115EC-b27c-46b8-a7d9-1b09df042eff';
  const withFile = 'https://claude.ai/design/p/6c5115ec-b27c-46b8-a7d9-1b09df042eff?file=Page.html';
  assert.equal(navMatch(bare, withFile), true, 'an opened file is the same project');
});

test('navMatch still decides the home phase, which has no /p/ segment', () => {
  assert.equal(navMatch('https://claude.ai/design', 'https://claude.ai/design'), true);
  assert.equal(navMatch('https://claude.ai/design', 'https://claude.ai/login?returnTo=%2Fdesign'), false);
});

test('a failed navigation (empty landedOn) never reads as a match', () => {
  assert.equal(navMatch('https://claude.ai/design/p/6c5115ec-b27c-46b8-a7d9-1b09df042eff', ''), false);
});

// --- #130: the doctor spawn path ---

test('resolveDoctorBin points at a file that actually exists', () => {
  const bin = resolveDoctorBin();
  assert.ok(fs.existsSync(bin), `resolved doctor bin does not exist: ${bin}`);
});

test('resolveDoctorBin is executable (spawnSync would otherwise EACCES)', () => {
  const bin = resolveDoctorBin();
  assert.doesNotThrow(() => fs.accessSync(bin, fs.constants.X_OK), `doctor bin is not executable: ${bin}`);
});

test('resolveDoctorBin tracks package.json bin, not a guessed filename', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  const declared = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin.designer;
  assert.equal(resolveDoctorBin(), path.join(REPO_ROOT, declared));
  // The exact bug: the old code joined 'bin', 'designer' and that path is absent.
  assert.ok(!fs.existsSync(path.join(REPO_ROOT, 'bin', 'designer')), 'bin/designer exists — update this regression test');
});

test('importing ci-health does not run the probe (module must be side-effect free)', () => {
  // If the import at the top of this file had launched Chrome and driven
  // claude.ai, the suite would hang or mutate today's artifact. Reaching this
  // assertion at all is the check.
  assert.equal(typeof resolveDoctorBin, 'function');
});

// --- #129 item 0: auto-heal must know what it can and cannot patch ---

const ALWAYS = () => true;
const NEVER = () => false;

test('a candidate that cannot be patched is classified apart from one in cooldown', () => {
  // The 9-day bug in one assertion: the old triage logged both as "complex or
  // in cooldown" and skipped. One resolves itself; the other never will.
  const c = classifyCandidates(['stuck', 'waiting'], {
    canPatch: (id) => id !== 'stuck',
    inCooldown: (id) => id === 'waiting',
    isValidId: ALWAYS
  });
  assert.deepEqual(c.unpatchable, ['stuck']);
  assert.deepEqual(c.cooling, ['waiting']);
  assert.deepEqual(c.eligible, []);
});

test('isStructurallyBlind fires when work is queued and nothing is patchable', () => {
  const blind = classifyCandidates(['a', 'b'], { canPatch: NEVER, inCooldown: NEVER, isValidId: ALWAYS });
  assert.equal(isStructurallyBlind(blind), true, 'unpatchable backlog must be loud');
});

test('isStructurallyBlind does NOT fire for a pure cooldown wait', () => {
  // Cooldown is a healthy, self-resolving state — escalating it would train
  // everyone to ignore the alarm, which is how we got here.
  const cooling = classifyCandidates(['a'], { canPatch: ALWAYS, inCooldown: ALWAYS, isValidId: ALWAYS });
  assert.equal(isStructurallyBlind(cooling), false);
});

test('isStructurallyBlind does NOT fire when something is still healable', () => {
  const mixed = classifyCandidates(['ok', 'stuck'], {
    canPatch: (id) => id === 'ok',
    inCooldown: NEVER,
    isValidId: ALWAYS
  });
  assert.deepEqual(mixed.eligible, ['ok']);
  assert.equal(isStructurallyBlind(mixed), false);
});

test('an id failing shape validation is quarantined, never healed', () => {
  const c = classifyCandidates(['evil; rm -rf /'], { canPatch: ALWAYS, inCooldown: NEVER, isValidId: NEVER });
  assert.deepEqual(c.invalid, ['evil; rm -rf /']);
  assert.deepEqual(c.eligible, []);
});

test('patchableAnchorIds reports reality — every reported id resolves to a real target', () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'ui-anchors.ts'), 'utf8');
  const json = fs.readFileSync(path.join(REPO_ROOT, 'selectors.json'), 'utf8');
  const ids = UI_ANCHORS.map((a) => a.id);
  const patchable = patchableAnchorIds(src, ids);

  // No claiming coverage it lacks: every id reported patchable must resolve to
  // a target that can actually be written — a literal with real offsets, or a
  // selectors.json key that already holds a string.
  for (const id of patchable) {
    const t = findAnchorTarget(src, id);
    assert.ok(t, `${id} reported patchable but findAnchorTarget returned null`);
    if (t.kind === 'literal') {
      assert.ok(t.literalEnd > t.literalStart, `${id}: literal span is empty`);
    } else {
      assert.equal(
        typeof readSelectorsKey(json, t.path),
        'string',
        `${id} resolves to selectors.json ${t.path.join('.')}, which holds no string`
      );
    }
  }

  // This assertion was `=== 0` until patcher V2 (#129 item 0.3): every anchor
  // reads SEL.*, and the literal-only patcher could rewrite none of them, so
  // auto-heal ran blind. V2 resolves SEL.* to its selectors.json key, so the
  // count must now be non-zero — if it returns to 0, auto-heal has gone blind
  // again and that is the alarm.
  assert.ok(
    patchable.length > 0,
    'auto-heal can patch NOTHING — patcher V2 has regressed and every heal will no-op'
  );
});

test('the legacy branch is never the patch target', () => {
  // checkWithLegacy(b, canonical, legacy, label): rewriting the legacy argument
  // would erase the record of what the selector used to be, which is the only
  // thing that lets a drifted page report `degraded` instead of `fail`.
  const src = `
    export const UI_ANCHORS = [
      { id: 'x.legacy', category: 'home', description: 'd', requires: 'home',
        check: async (b) => checkWithLegacy(b, SEL.home.createButton, SEL.homeLegacy?.createButton, 'x') }
    ];`;
  const t = findAnchorTarget(src, 'x.legacy');
  assert.deepEqual(t, { kind: 'selectors-key', path: ['home', 'createButton'] });
});

test('a non-SEL object is not mistaken for a contract key', () => {
  const src = `
    export const UI_ANCHORS = [
      { id: 'x.other', category: 'home', description: 'd', requires: 'home',
        check: async (b) => ({ ok: await hasSelector(b, OTHER.home.creator) }) }
    ];`;
  assert.equal(findAnchorTarget(src, 'x.other'), null, 'only SEL.* is a selectors.json key');
});

test('complex checks stay unpatchable — there is no single selector to swap', () => {
  const src = `
    export const UI_ANCHORS = [
      { id: 'x.walker', category: 'home', description: 'd', requires: 'home',
        check: async (b) => ({ ok: await hasButtonMatching(b, /Create/i) }) },
      { id: 'x.guarded', category: 'session', description: 'd', requires: 'session',
        check: async (b, url) => { if (!/file=/.test(url)) return { ok: true, status: 'skip' };
                                   return { ok: await hasSelector(b, SEL.composer.promptTextarea) }; } }
    ];`;
  assert.equal(findAnchorTarget(src, 'x.walker'), null);
  assert.equal(findAnchorTarget(src, 'x.guarded'), null, 'a block body with a URL guard is not a plain selector check');
});

// --- patcher V2: writing selectors.json ---

test('selectors.json is byte-identical under a JSON round-trip', () => {
  // patchSelectorsJson works by parse -> mutate -> stringify. That is only
  // safe-by-construction while this holds: if the file ever gains a different
  // formatting, a patch would reformat the whole contract in the same commit
  // and bury the one-line change auto-heal actually intended.
  const raw = fs.readFileSync(path.join(REPO_ROOT, 'selectors.json'), 'utf8');
  assert.equal(JSON.stringify(JSON.parse(raw), null, 2) + '\n', raw);
});

test('patchSelectorsJson changes exactly the targeted key and nothing else', () => {
  const raw = fs.readFileSync(path.join(REPO_ROOT, 'selectors.json'), 'utf8');
  const out = patchSelectorsJson(raw, ['home', 'creator'], '[data-testid="new-composer"]');
  const before = JSON.parse(raw);
  const after = JSON.parse(out);
  assert.equal(after.home.creator, '[data-testid="new-composer"]');
  before.home.creator = '[data-testid="new-composer"]';
  assert.deepEqual(after, before, 'no other key may move');
  assert.ok(out.endsWith('\n'), 'trailing newline preserved');
});

test('patchSelectorsJson fails closed on an absent or non-string key', () => {
  const raw = fs.readFileSync(path.join(REPO_ROOT, 'selectors.json'), 'utf8');
  // Never invent a contract entry.
  assert.throws(() => patchSelectorsJson(raw, ['home', 'noSuchKey'], 'x'), /absent|expected a string/);
  // Never overwrite a nested object with a string.
  assert.throws(() => patchSelectorsJson(raw, ['home'], 'x'), /expected a string/);
  assert.throws(() => patchSelectorsJson(raw, [], 'x'), /empty key path/);
});

test('a quoted selector survives the round-trip intact', () => {
  const raw = fs.readFileSync(path.join(REPO_ROOT, 'selectors.json'), 'utf8');
  const tricky = 'button.om-grid-tile:has(img[src*="/grid-thumbs/wireframe."])';
  const out = patchSelectorsJson(raw, ['home', 'creator'], tricky);
  assert.equal(JSON.parse(out).home.creator, tricky, 'double quotes must not corrupt the value');
});

// --- patcher V2: the collateral-regression gate ---

const res = (id, status, phase) => ({ id, category: 'home', description: 'd', requires: 'any', status, phase });

test('a patch that breaks a previously-working anchor is caught', () => {
  const before = [res('target', 'fail'), res('other', 'ok')];
  const after = [res('target', 'ok'), res('other', 'fail')];
  assert.deepEqual(findCollateralRegressions(before, after, 'target'), ['other']);
});

test('the patched anchor recovering is not itself a regression', () => {
  const before = [res('target', 'fail'), res('other', 'ok')];
  const after = [res('target', 'ok'), res('other', 'ok')];
  assert.deepEqual(findCollateralRegressions(before, after, 'target'), []);
});

test('an anchor that was already failing is not counted as collateral', () => {
  // It was broken before the patch; blaming the patch for it would revert good
  // heals whenever two anchors happened to be down at once.
  const before = [res('target', 'fail'), res('other', 'fail')];
  const after = [res('target', 'ok'), res('other', 'fail')];
  assert.deepEqual(findCollateralRegressions(before, after, 'target'), []);
});

// NOTE: this file used to assert that ok -> skip is NOT counted, on the reading
// that an inconclusive re-probe is absence of evidence. An adversarial probe
// refuted it: `skip` is exactly how the anchors that exercise a key in
// production report patch-induced breakage. The corrected rules are the two
// tests directly below ("silenced into SKIP" / "ALREADY skipping").

test('degraded counts as working on both sides', () => {
  const before = [res('target', 'fail'), res('other', 'degraded')];
  const after = [res('target', 'degraded'), res('other', 'fail')];
  assert.deepEqual(findCollateralRegressions(before, after, 'target'), ['other'],
    'degraded-before -> fail-after is still a break');
});

test('the PR names the other consumers of a patched key', () => {
  // The collateral gate only sees what an ANCHOR asserts. Most keys are read by
  // one anchor plus production, so the reviewer is the real backstop for those
  // — they need to be told what else moved.
  const files = { 'a.ts': 'await hasSelector(b, SEL.home.creator)', 'b.ts': 'this.selectors.home.creator', 'c.ts': 'nothing' };
  const got = selectorKeyConsumers(['home', 'creator'], (f) => files[f] ?? null, ['a.ts', 'b.ts', 'c.ts']);
  assert.equal(got.length, 2, 'both readers reported, the unrelated file omitted');
  assert.match(got.join(' '), /a\.ts/);
  assert.match(got.join(' '), /b\.ts/);
});

test('selectorKeyConsumers finds the real production readers of home.creator', () => {
  // Against the actual repo: home.creator is read by exactly one anchor, but
  // createSession waits on it too. That asymmetry is the documented limit of
  // the collateral gate, so it must be true in practice, not just in a stub.
  const got = selectorKeyConsumers(['home', 'creator'], (f) => {
    try {
      return fs.readFileSync(path.join(REPO_ROOT, f), 'utf8');
    } catch {
      return null;
    }
  });
  assert.match(got.join(' '), /designer-controller\.ts/, 'production reads this key — a bad patch changes tool behaviour');
});

test('an anchor silenced into SKIP by the patch IS a regression', () => {
  // The reason this flipped from "not counted" to "counted": `skip` is how the
  // anchors that exercise a key in PRODUCTION report patch-induced breakage.
  // Patch composer.promptTextarea to a present-but-wrong editable element and
  // session.promptTextarea (a presence check) goes ok, while
  // network.turnRpcContract fills the wrong element, never sees the send button
  // enable, and returns {ok:true, status:'skip'}. Reading that as absence of
  // evidence let the patch land while the real submit path was broken.
  const before = [res('target', 'fail'), res('network.turnRpcContract', 'ok')];
  const after = [res('target', 'ok'), res('network.turnRpcContract', 'skip')];
  assert.deepEqual(findCollateralRegressions(before, after, 'target'), ['network.turnRpcContract']);
});

test('an anchor that was ALREADY skipping is still not counted', () => {
  // The lenient rule survives only for anchors that were inconclusive before
  // the patch — otherwise a phase skipped for unrelated reasons reverts a good
  // heal every time.
  const before = [res('target', 'fail'), res('other', 'skip')];
  const after = [res('target', 'ok'), res('other', 'skip')];
  assert.deepEqual(findCollateralRegressions(before, after, 'target'), []);
});

test('an anchor that vanished from the re-probe is counted, not ignored', () => {
  const before = [res('target', 'fail'), res('other', 'ok')];
  const after = [res('target', 'ok')];
  assert.deepEqual(findCollateralRegressions(before, after, 'target'), ['other']);
});

// --- the legacy contract is refused structurally, not positionally ---

test('a *Legacy key path is never a patch target', () => {
  // Today nothing produces this shape — extractCanonicalSelectorArg reads
  // argument index 1, the canonical one. That makes the "never erase the
  // superseded selector" invariant depend on argument ORDER. Refuse on the key
  // path itself so a reordering or a direct hasSelector(b, SEL.homeLegacy.x)
  // cannot reach the writer.
  const src = `
    export const UI_ANCHORS = [
      { id: 'x.direct', category: 'home', description: 'd', requires: 'home',
        check: async (b) => ({ ok: await hasSelector(b, SEL.homeLegacy.createButton) }) }
    ];`;
  assert.equal(findAnchorTarget(src, 'x.direct'), null, 'legacy blocks are not patchable');
  assert.equal(isLegacyGroup('homeLegacy'), true);
  assert.equal(isLegacyGroup('home'), false);
  assert.deepEqual(legacyPathFor(['home', 'createButton']), ['homeLegacy', 'createButton']);
  assert.equal(legacyPathFor(['homeLegacy', 'createButton']), null);
});

// --- the theme's preventive check: human-facing claims must match reality ---

test('no auto-heal message claims selectors.json anchors are unpatchable', () => {
  // patcher V2 made that false, but the structural-blindness drift-PR comment
  // still said it — sending a maintainer to build the capability that had just
  // shipped, while the real remaining limit went unnamed. Blindness is the loud
  // trustworthy signal; a wrong explanation degrades it.
  const src = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'auto-heal.ts'), 'utf8');
  assert.ok(
    !/outside its reach/.test(src),
    'auto-heal still tells the human that SEL.* anchors are outside the patcher — untrue since V2'
  );
});

test('CONSUMER_FILES covers every file that reads a selector key', () => {
  // The PR body's "also read by" line is the reviewer's primary signal for a
  // single-reader key. A hardcoded list that misses a plain `SEL.a.b` reader is
  // a different gap from the passed-down-object one the docstring admits.
  const src = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'auto-heal.ts'), 'utf8');
  const listed = new Set([...src.matchAll(/^\s*'([\w./-]+\.ts)',?$/gm)].map((m) => m[1]));
  // Scan CODE, not prose: two-level access (`SEL.group.key`) with comments
  // stripped. A one-level pattern also matches the literal "selectors.json",
  // and anchor-patcher.ts documents key paths in comments without ever reading
  // one. Done in Node rather than shelling to rg so CI does not need it.
  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      if (['node_modules', 'dist', '.git', 'tests', 'artifacts'].includes(e.name)) return [];
      const p = path.join(dir, e.name);
      return e.isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
    });
  const readers = walk(REPO_ROOT)
    .map((abs) => ({ rel: path.relative(REPO_ROOT, abs), src: fs.readFileSync(abs, 'utf8') }))
    .filter(({ rel }) => rel !== 'selectors.ts')
    .filter(({ src }) => {
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      return /\bSEL\.[a-z]\w*\.[a-z]|\bthis\.selectors\.[a-z]\w*\.[a-z]/.test(code);
    })
    .map(({ rel }) => rel);
  const missing = readers.filter((f) => !listed.has(f));
  assert.deepEqual(missing, [], `CONSUMER_FILES omits selector readers: ${missing.join(', ')}`);
});

// --- the OAuth credential must actually authenticate ---

test('an OAuth bearer token carries the beta header the API requires', async () => {
  // The heal call had never once run: triage could not reach it while the
  // patcher was blind, and the moment V2 made it reachable it would have 401'd.
  // The SDK sends `Authorization: Bearer <token>` and nothing else for a
  // caller-supplied authToken, but the API requires `anthropic-beta:
  // oauth-2025-04-20` alongside it. Assert on the WIRE rather than on the
  // source, because the failure is in what the SDK omits, not in what we wrote.
  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  const { OAUTH_API_BETA_HEADER } = await import('../scripts/auto-heal.ts');
  const http = await import('node:http');

  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.headers);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: 'm', content: [], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const baseURL = `http://127.0.0.1:${server.address().port}`;

  try {
    // Token auth — the configuration the workflow actually runs.
    const byToken = new Anthropic({
      authToken: 'test-oauth-token',
      defaultHeaders: { 'anthropic-beta': OAUTH_API_BETA_HEADER },
      baseURL,
      maxRetries: 0
    });
    await byToken.messages.create({ model: 'm', max_tokens: 1, messages: [{ role: 'user', content: 'x' }] });
    assert.match(seen[0].authorization ?? '', /^Bearer /, 'token auth goes on Authorization, not x-api-key');
    assert.equal(
      seen[0]['anthropic-beta'],
      OAUTH_API_BETA_HEADER,
      'an OAuth bearer token without oauth-2025-04-20 is rejected by /v1/messages'
    );

    // API-key auth — the header is unnecessary and must not be required.
    const byKey = new Anthropic({ apiKey: 'test-key', baseURL, maxRetries: 0 });
    await byKey.messages.create({ model: 'm', max_tokens: 1, messages: [{ role: 'user', content: 'x' }] });
    assert.equal(seen[1]['x-api-key'], 'test-key');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('auto-heal attaches the OAuth beta header only when the token is the credential', () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'scripts/auto-heal.ts'), 'utf8');
  assert.match(
    src,
    /authToken && !apiKey \? \{ defaultHeaders: \{ 'anthropic-beta': OAUTH_API_BETA_HEADER \} \}/,
    'the header must ride on the token path, and not be sent when an API key wins resolution'
  );
});

test('a fail in EITHER phase makes an any-state anchor failing', () => {
  // `any` anchors probe twice. A patch that breaks only the session phase must
  // not be excused by the home phase still passing.
  const before = [res('other', 'ok', 'home'), res('other', 'ok', 'session')];
  const after = [res('other', 'ok', 'home'), res('other', 'fail', 'session')];
  assert.deepEqual(findCollateralRegressions(before, after, 'target'), ['other']);
});

test('findAnchor rejects a selector-key anchor rather than silently mispatching', () => {
  // `hasSelector(b, SEL.home.creator)` is a PropertyAccessExpression, not a
  // string literal. The patcher must return null (not guess), so auto-heal can
  // report blindness instead of pretending success.
  const src = `
    export const UI_ANCHORS = [
      { id: 'x.viaSelectorKey', category: 'home', description: 'd', requires: 'home',
        check: async (b) => ({ ok: await hasSelector(b, SEL.home.creator) }) },
      { id: 'x.viaLiteral', category: 'home', description: 'd', requires: 'home',
        check: async (b) => ({ ok: await hasSelector(b, '[data-testid="literal"]') }) }
    ];`;
  assert.equal(findAnchor(src, 'x.viaSelectorKey'), null, 'selector-key anchor must not be reported patchable');
  assert.equal(findAnchor(src, 'x.viaLiteral')?.currentSelector, '[data-testid="literal"]');
});

// --- #129 items 1+2: legacy branches must degrade, not mask ---

const anchor = (id) => {
  const a = UI_ANCHORS.find((x) => x.id === id);
  if (!a) throw new Error(`anchor not found: ${id}`);
  return a;
};
// The stub decides from the evaluated expression, so "which selector is present"
// is expressed as a predicate over the probe source.
const stubBrowser = (present) => ({ evalValue: async (expr) => present.some((s) => expr.includes(s)) });

test('canonical selector present => plain ok', async () => {
  const b = stubBrowser(['home-composer-send']);
  const r = await anchor('home.createButton').check(b, 'https://claude.ai/design');
  assert.equal(r.ok, true);
  assert.equal(r.status, undefined, 'canonical match must not be marked degraded');
});

test('canonical GONE but legacy present => degraded, not ok', async () => {
  // This is the whole point: the old comma-OR selector reported a clean `ok`
  // here, so the canonical selector could rot indefinitely without a signal.
  const b = stubBrowser(['Create']);
  const r = await anchor('home.createButton').check(b, 'https://claude.ai/design');
  assert.equal(r.ok, true, 'tool still works, so this must not fail the run');
  assert.equal(r.status, 'degraded');
  assert.match(r.detail, /canonical/i);
});

test('neither branch present => fail', async () => {
  const b = stubBrowser([]);
  const r = await anchor('home.createButton').check(b, 'https://claude.ai/design');
  assert.equal(r.ok, false);
});

test('projectsList degrades onto the bare project-link branch', async () => {
  const b = stubBrowser(['design/p/']);
  const r = await anchor('home.projectsList').check(b, 'https://claude.ai/design');
  assert.equal(r.status, 'degraded', 'a stray project link must not read as a healthy list container');
});

test('login.signedIn degrades on the weaker Create-button marker instead of claiming signed-out', async () => {
  const b = stubBrowser(['Create']);
  const r = await anchor('login.signedIn').check(b, 'https://claude.ai/design');
  assert.equal(r.ok, true);
  assert.equal(r.status, 'degraded');
  // NOT a hard ban on naming `designer setup` here: this branch concedes the
  // marker is weak evidence, so forbidding the words forced the text to assert
  // more certainty than the check has. What must hold is that re-capture is
  // named FIRST and setup only as a conditional secondary.
  assert.match(r.detail, /re-capture login\.signedInIndicator/i, 'must lead with re-capture, not re-login');
  assert.match(r.detail, /WEAK evidence/, 'must state the marker is weak evidence rather than assert authentication');
});

// --- branch resolution helpers ---

test('orderedBranches keeps canonical first and drops a duplicate legacy', () => {
  assert.deepEqual(orderedBranches('#a', '#b'), ['#a', '#b']);
  assert.deepEqual(orderedBranches('#a', '#a'), ['#a'], 'identical legacy is not a second branch');
  assert.deepEqual(orderedBranches('#a', null), ['#a']);
});

test('presenceSelector joins branches for existence-only checks', () => {
  assert.equal(presenceSelector('#a', '#b'), '#a, #b');
  assert.equal(presenceSelector('#a', null), '#a');
});

test('no canonical selector smuggles a comma-OR legacy branch back in', () => {
  // Guards the regression directly: if someone re-packs a fallback into a
  // canonical selector, querySelector's document-order semantics silently
  // return again and the anchors stop degrading.
  const sel = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'selectors.json'), 'utf8'));
  for (const [key, value] of Object.entries(sel.home)) {
    assert.ok(!String(value).includes(','), `home.${key} packs multiple branches into one selector: ${value}`);
  }
});

// --- PR #131 review (Codex P2 x2) ---

// A home dir survives scrubbing only as the literal `<redacted>` token.
const LEAKED_MACOS = /\/Users\/(?!<redacted>)[^/\s]+/;
const LEAKED_LINUX = /\/home\/(?!<redacted>)[^/\s]+/;

test('the scrubber redacts home-dir paths in spawn errors', async () => {
  // Node embeds the absolute executable path in spawn errors. The health
  // artifact is world-downloadable for 30 days, and the same string also reaches
  // the run summary + a ::warning annotation, so the scrub happens at the source.
  //
  // Synthetic inputs on purpose: asserting against THIS checkout's real path
  // would make the test pass or fail on where the repo happens to live (it would
  // fail outright in a /workspace or Windows checkout), which is the
  // green-by-accident failure this whole PR is about.
  const { scrubForTest } = await import('../scripts/ci-health.ts');
  for (const raw of [
    'ENOENT: spawnSync /Users/alice/dev/designer/bin/designer ENOENT',
    'ENOENT: spawnSync /home/runner/work/designer/designer/bin/designer ENOENT'
  ]) {
    const scrubbed = scrubForTest(raw);
    assert.doesNotMatch(scrubbed, LEAKED_MACOS, `macOS username leaked from: ${raw}`);
    assert.doesNotMatch(scrubbed, LEAKED_LINUX, `Linux username leaked from: ${raw}`);
    assert.match(scrubbed, /ENOENT/, 'scrubbing must preserve the diagnostic');
  }
});

test('a real spawn failure is publishable — no unredacted home dir, whatever the checkout path', async () => {
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(path.join(REPO_ROOT, 'bin', 'designer'), ['doctor']);
  assert.ok(r.error, 'expected ENOENT for the extensionless path');
  // No precondition on the raw message's shape — the invariant is about what
  // gets PUBLISHED, and it must hold from any checkout location.
  const { scrubForTest } = await import('../scripts/ci-health.ts');
  const published = scrubForTest(`${r.error.code}: ${r.error.message}`);
  assert.doesNotMatch(published, LEAKED_MACOS, 'macOS username leaked');
  assert.doesNotMatch(published, LEAKED_LINUX, 'Linux username leaked');
  assert.match(published, /ENOENT/, 'scrubbing must preserve the diagnostic');
});

test('every ProbeStatus is rendered distinctly by the CLI health reporter', () => {
  // Guards the enum-widening gap: `degraded` was added to ProbeStatus but the
  // `designer health` reporter still hardcoded ok/fail/skip, so counts did not
  // add up to results.length and degraded shared an icon with skip.
  const cli = fs.readFileSync(path.join(REPO_ROOT, 'cli.ts'), 'utf8');
  for (const status of ['ok', 'degraded', 'fail', 'skip']) {
    assert.ok(
      cli.includes(`counts['${status}']`),
      `cli.ts health output does not account for the '${status}' status — totals will not add up`
    );
  }
  // Distinct glyphs: degraded must not collapse into the skip fallback.
  const icons = cli.match(/const icon = \(s: string\) => \(([^;]+)\);/);
  assert.ok(icons, 'icon renderer not found — update this test');
  assert.match(icons[1], /'degraded'/, "degraded has no glyph of its own");
});

// --- PR #131 review round 3: the probe needs a third outcome ---

test('a clean run with a working doctor is ok', () => {
  assert.equal(probeVerdict({ anchorFail: false, doctorSpawnError: null, doctorExitCode: 0 }), 'ok');
});

test('anchor regressions are drift — the selectors-drift-PR path', () => {
  assert.equal(probeVerdict({ anchorFail: true, doctorSpawnError: null, doctorExitCode: 0 }), 'drift');
});

test('a doctor that never launched is incomplete, NOT green and NOT drift', () => {
  // The bug this closes: exit 0 made `Close stale drift PRs on green` fire while
  // half the probe was broken, so a legitimate open drift PR could be
  // auto-closed. Exit 2 would have been just as wrong — it would file a tooling
  // fault as a claude.ai redesign.
  const v = probeVerdict({ anchorFail: false, doctorSpawnError: 'ENOENT: ...', doctorExitCode: -1 });
  assert.equal(v, 'incomplete');
  assert.notEqual(v, 'ok');
  assert.notEqual(v, 'drift');
});

test('a NON-ZERO doctor exit does not gate the workflow', () => {
  // Deliberate, on reproduced evidence: doctor run against a CDP Chrome with no
  // design tab exits 0 (that check is 'warn', not 'fail'). Of doctor's six real
  // 'fail' branches only MCP-registration is orthogonal to probe validity, and
  // the rest are already covered — signed-out fails login.signedIn (-> drift),
  // a missing selectors.json/agent-browser makes the probe throw (-> incomplete).
  // Gating on the exit code therefore buys ~nothing and risks blocking stale-PR
  // cleanup on an unrelated Claude Code registration fault.
  assert.equal(probeVerdict({ anchorFail: false, doctorSpawnError: null, doctorExitCode: 2 }), 'ok');
  // A failure to LAUNCH is still incomplete — that is the case where the
  // tooling half genuinely did not run.
  assert.equal(probeVerdict({ anchorFail: false, doctorSpawnError: 'ENOENT: ...', doctorExitCode: -1 }), 'incomplete');
});

test('anchor drift outranks a broken doctor — the actionable signal wins', () => {
  // Both broken: still file the drift PR. Drift is what a human can act on, and
  // the doctor fault is recorded in the artifact either way.
  assert.equal(probeVerdict({ anchorFail: true, doctorSpawnError: 'ENOENT: ...', doctorExitCode: -1 }), 'drift');
});

test('each verdict maps to a distinct exit code, and only ok is zero', () => {
  assert.equal(EXIT_CODE.ok, 0);
  assert.notEqual(EXIT_CODE.drift, 0);
  assert.notEqual(EXIT_CODE.incomplete, 0);
  assert.notEqual(EXIT_CODE.drift, EXIT_CODE.incomplete, 'drift and incomplete must be distinguishable');
  assert.equal(new Set(Object.values(EXIT_CODE)).size, 3);
});

test('the workflow gates on the verdict, never on the raw step outcome', () => {
  // `outcome` is only success/failure, so it cannot separate drift from a broken
  // probe — and the probe step runs with continue-on-error, so a bare outcome
  // check let an incomplete run pass as green.
  const wf = fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/daily-health.yml'), 'utf8');
  for (const v of ['ok', 'drift', 'incomplete']) {
    assert.ok(wf.includes(`steps.probe.outputs.verdict == '${v}'`), `no workflow step handles verdict '${v}'`);
  }
  // Scoped to `if:` CONDITIONS, not the whole file — naming `outcome` inside a
  // diagnostic message is fine; gating on it is what cannot happen, because
  // outcome collapses drift and a broken probe into one `failure`.
  const lines = wf.split('\n');
  const conditions = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)if:(.*)$/);
    if (!m) continue;
    let cond = m[2];
    const indent = m[1].length;
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j];
      if (!next.trim()) break;
      const nextIndent = next.length - next.trimStart().length;
      if (nextIndent <= indent) break;
      cond += ' ' + next.trim();
    }
    conditions.push(cond);
  }
  assert.ok(conditions.length >= 3, 'expected at least the three verdict gates');
  for (const c of conditions) {
    assert.ok(!c.includes('steps.probe.outcome'), `a gate still keys on step outcome: ${c.trim().slice(0, 80)}`);
  }
});

// --- PR #131 review round 4: no exit path may skip the verdict ---

test('every process exit in ci-health goes through exitWith', () => {
  // The regression this closes: the CDP-unreachable path and the main().catch
  // handler exited without publishing a verdict. With `continue-on-error: true`
  // on the probe step, an unset verdict left all gates false and the job GREEN —
  // strictly worse than before, when a bare non-zero exit at least went red.
  const src = fs.readFileSync(path.join(REPO_ROOT, 'scripts/ci-health.ts'), 'utf8');
  const bare = src
    .split('\n')
    .map((line, i) => ({ line: line.trim(), n: i + 1 }))
    .filter(({ line }) => line.includes('process.exit('))
    // The single legitimate call is the one inside exitWith itself.
    .filter(({ n }) => {
      const fnStart = src.slice(0, src.indexOf('function exitWith')).split('\n').length;
      return !(n >= fnStart && n <= fnStart + 8);
    });
  assert.deepEqual(bare, [], `these exits bypass exitWith and would publish no verdict: ${JSON.stringify(bare)}`);
});

test('the workflow fails closed on an unrecognized or missing verdict', () => {
  const wf = fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/daily-health.yml'), 'utf8');
  // A hard kill (OOM / runner timeout) writes no output at all, so the guard
  // cannot live in the script — the workflow must reject anything unknown.
  for (const v of ['ok', 'drift', 'incomplete']) {
    assert.ok(wf.includes(`steps.probe.outputs.verdict != '${v}'`), `backstop does not exclude the known verdict '${v}'`);
  }
});

test('CDP-unreachable is incomplete, never drift', () => {
  // A dead browser is an environment fault. It used to exit 2, which opened a
  // selectors-drift PR blaming claude.ai for a Chrome that would not start.
  const src = fs.readFileSync(path.join(REPO_ROOT, 'scripts/ci-health.ts'), 'utf8');
  // Anchored on the FAIL log specifically — an earlier line logs the benign
  // "attempting relaunch" case with nearly the same wording.
  const at = src.indexOf('FAIL — CDP unreachable on');
  assert.notEqual(at, -1, 'CDP-unreachable failure log not found — update this test');
  const cdpBlock = src.slice(at, at + 600);
  assert.match(cdpBlock, /exitWith\('incomplete'\)/, 'CDP-unreachable must resolve to incomplete');
});

test('the auto-heal workflow fails the job when triage reports structural blindness', () => {
  // ::error is an annotation; it does not change a step's outcome. Without an
  // explicit gate the workflow still concluded success in exactly the
  // blind-while-anchors-fail scenario this PR exists to surface.
  const wf = fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/auto-heal.yml'), 'utf8');
  const GATE = "steps.triage.outputs.blind == 'true'";
  assert.ok(wf.includes(GATE), 'no workflow gate on blindness — auto-heal would stay green while blind');
  assert.match(wf.slice(wf.indexOf(GATE), wf.indexOf(GATE) + 500), /exit 1/, 'the blind gate must actually fail the job');
});

test('the blind reason string is emitted by triage exactly as the workflow expects', () => {
  // Guards the two halves drifting apart: a renamed reason would silently make
  // the gate dead, restoring the green-while-blind behaviour.
  const src = fs.readFileSync(path.join(REPO_ROOT, 'scripts/auto-heal.ts'), 'utf8');
  assert.match(src, /ghOutput\('reason', 'blind-unpatchable'\)/, 'triage no longer emits the reason the workflow gates on');
});

test('no health-apparatus script keeps its own hardcoded readiness selector', () => {
  // There were two stale copies of these gates — ci-health.ts and auto-heal.ts —
  // and the home one pointed at `project-creator`, dead since a redesign. Both
  // burned the full timeout waiting for an element that could never appear and
  // then proceeded with no readiness guarantee.
  for (const f of ['scripts/ci-health.ts', 'scripts/auto-heal.ts']) {
    const src = fs.readFileSync(path.join(REPO_ROOT, f), 'utf8');
    const decls = src.match(/^const (?:HOME|SESSION)_READY_SEL = .*$/gm) || [];
    assert.ok(decls.length > 0, `${f}: readiness selectors not found — update this test`);
    for (const d of decls) {
      assert.ok(/= SEL\./.test(d), `${f} hardcodes a readiness selector instead of reading selectors.json: ${d}`);
    }
  }
});

// --- PR #131 review round 6 ---

test('blindness is classified before the wholesale-redesign early return', () => {
  // The gap: >=5 failing anchors returned reason=wholesale-redesign BEFORE the
  // classification ran, so a wholesale regression in which nothing was
  // patchable never reported blindness — the worst case (many anchors down,
  // auto-heal powerless) stayed green.
  const src = fs.readFileSync(path.join(REPO_ROOT, 'scripts/auto-heal.ts'), 'utf8');
  const classifyAt = src.indexOf('const classified = classifyCandidates(');
  const wholesaleAt = src.indexOf('candidates.length >= WHOLESALE_THRESHOLD');
  assert.notEqual(classifyAt, -1);
  assert.notEqual(wholesaleAt, -1);
  assert.ok(classifyAt < wholesaleAt, 'classification must run before the wholesale early return');
});

test('every triage exit publishes a blind flag', () => {
  // Same lesson as the ci-health verdict: a gate keyed on an output only works
  // if every exit sets it, or the unset case silently gates to green.
  const src = fs.readFileSync(path.join(REPO_ROOT, 'scripts/auto-heal.ts'), 'utf8');
  const start = src.indexOf('function triage()');
  const end = src.indexOf('// ---- heal ----');
  assert.ok(start > 0 && end > start, 'triage() bounds not found — update this test');
  const triage = src.slice(start, end);
  const reasons = (triage.match(/ghOutput\('reason',/g) || []).length;
  const blinds = (triage.match(/ghOutput\('blind',/g) || []).length;
  const heals = (triage.match(/ghOutput\('action', 'heal'\)/g) || []).length;
  assert.ok(reasons > 0, 'no triage reasons found — update this test');
  assert.equal(blinds, reasons + heals, `every exit must publish blind: ${reasons} reasons + ${heals} heal vs ${blinds} blind flags`);
});

test('the auto-heal gate keys on blind, not on a single reason slot', () => {
  const wf = fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/auto-heal.yml'), 'utf8');
  assert.ok(wf.includes("steps.triage.outputs.blind == 'true'"), 'gate must key on the dedicated blind output');
  // reason can only hold one value, so wholesale-redesign would mask blindness.
  assert.ok(!wf.includes("reason == 'blind-unpatchable'"), 'gate still keys on the mutually-exclusive reason slot');
});

test('project names are chosen by source priority, not string length', () => {
  // A control link ("Open") is SHORTER than the real name, so shortest-wins
  // picked the button label on exactly the multi-link row the dedupe exists for.
  const src = fs.readFileSync(path.join(REPO_ROOT, 'designer-controller.ts'), 'utf8');
  // Anchor on the scrape block's own start/end markers, not on a neighbouring
  // method signature — a rename moved that boundary and silently emptied the
  // slice, turning this assertion into a no-op that still "passed" the regex.
  const scrapeStart = src.indexOf('const LINK_SEL =');
  const scrape = src.slice(scrapeStart, src.indexOf('_listFilesBody(', scrapeStart));
  assert.ok(scrape.length > 200, 'scrape slice is empty — the boundary marker moved');
  assert.ok(!/sort\(\(x, y\) => x\.length - y\.length\)/.test(scrape), 'shortest-wins heuristic is back');
  assert.match(scrape, /NAME_SOURCES = \['rowCell', 'ariaLabel', 'anchorText'\]/, 'source priority order changed');
});

// --- Seam 1: redaction is the default, not per-field opt-in ---

const LEAK_UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

test('scrubDeep redacts the fields that shipped raw (diagnostics.url, results[].detail)', async () => {
  const { scrubDeep } = await import('../scripts/ci-health.ts');
  // Shape lifted from a REAL published artifact (health/drift-2026-07-24) that
  // leaked a project UUID in both of these fields.
  const payload = {
    diagnostics: { url: 'https://claude.ai/design/p/6c5115ec-b27c-46b8-a7d9-1b09df042eff?file=index.html', htmlBytes: 68796 },
    health: {
      results: [
        { id: 'pattern.sessionUrl', status: 'ok', detail: 'url=https://claude.ai/design/p/6c5115ec-b27c-46b8-a7d9-1b09df042eff?file=index.html' }
      ]
    }
  };
  const out = scrubDeep(payload);
  assert.doesNotMatch(JSON.stringify(out), LEAK_UUID, 'a project UUID survived the publish boundary');
  assert.doesNotMatch(out.diagnostics.url, /\?file=/, 'query string must be stripped');
  // Conservation: auto-heal keys on these, so scrubbing must not touch them.
  assert.equal(out.health.results[0].id, 'pattern.sessionUrl');
  assert.equal(out.health.results[0].status, 'ok');
  assert.equal(out.diagnostics.htmlBytes, 68796, 'non-string values must pass through');
});

test('scrubDeep covers a field nobody remembered to opt in', async () => {
  const { scrubDeep } = await import('../scripts/ci-health.ts');
  // The point of the seam: a NEW field is redacted without being wired up.
  const out = scrubDeep({ someFutureField: { nested: ['/Users/alice/x', 'https://claude.ai/design/p/6c5115ec-b27c-46b8-a7d9-1b09df042eff'] } });
  assert.doesNotMatch(JSON.stringify(out), LEAK_UUID);
  assert.doesNotMatch(JSON.stringify(out), /\/Users\/(?!<redacted>)[^/"\s]+/);
});

test('scrubDeep is safe on the degenerate shapes (null diagnostics, empty results)', async () => {
  const { scrubDeep } = await import('../scripts/ci-health.ts');
  assert.deepEqual(scrubDeep({ diagnostics: null, health: { results: [] } }), { diagnostics: null, health: { results: [] } });
});

test('the artifact is written through the scrubber, not the raw payload', () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'scripts/ci-health.ts'), 'utf8');
  assert.match(src, /writeFileSync\(outFile, JSON\.stringify\(scrubDeep\(payload\)/, 'the write boundary must scrub');
});

// --- Theme A: enforce the selector contract over ALL of selectors.json ---
// The prior guard iterated `sel.home` only, so login.*, composer.*, preview.*
// and messages.* were unguarded — and a live violation was sitting in
// composer.sendButton, whose two branches ui-anchors.ts itself documents as
// canonical + superseded.

// Values allowed to contain a comma, with the reason. A comma is otherwise a
// packed canonical+legacy pair, which querySelector resolves by document order.
const MULTI_BRANCH_OK = {
  'login.signedInIndicator':
    'genuine cross-surface disjunction (in-session composer OR home composer), not canonical+legacy — and presence-only, so which one matches is irrelevant'
};

// Selector keys with no ui-anchors.ts anchor, with the reason each is exempt.
// Anything NOT listed here must be anchored: an unanchored selector on a scrape
// path is how `home.projectLink` drove listProjects with the probe blind to it.
const UNANCHORED_OK = {
  'composer.stopButton': 'null in the current capture — nothing to probe',
  'composer.attachButton': 'not on any scrape path; unused affordance',
  'composer.modelButton': 'not on any scrape path; unused affordance',
  'preview.exportButtonText': 'label text, not a selector; share.shareButton covers the surface',
  'preview.shareButtonText': 'label text, not a selector; share.shareButton covers the surface',
  'preview.emptyStateHeading': 'label text used for an empty-state assertion, not a probe',
  'messages.generatingIndicator': 'null in the current capture — nothing to probe',
  'interstitials.continueHere': 'button label; interstitials.ts owns detection and is unit-tested'
};

const selectorGroups = () => {
  const sel = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'selectors.json'), 'utf8'));
  return Object.entries(sel).filter(([g, v]) => !g.startsWith('_') && v && typeof v === 'object');
};

test('no selector packs multiple branches into one comma-OR value', () => {
  const offenders = [];
  for (const [group, entries] of selectorGroups()) {
    for (const [k, v] of Object.entries(entries)) {
      if (k.startsWith('_') || typeof v !== 'string') continue;
      const key = `${group}.${k}`;
      if (v.includes(',') && !MULTI_BRANCH_OK[key]) offenders.push(`${key} = ${v}`);
    }
  }
  assert.deepEqual(offenders, [], `packed comma-OR selectors (document-order hazard + masks degraded): ${offenders.join(' | ')}`);
});

test('every selector is either anchored in ui-anchors.ts or explicitly exempt', () => {
  // Normalize optional chaining so `SEL.homeLegacy?.createButton` counts.
  const anchors = fs.readFileSync(path.join(REPO_ROOT, 'ui-anchors.ts'), 'utf8').replace(/\?\./g, '.');
  const unanchored = [];
  for (const [group, entries] of selectorGroups()) {
    for (const k of Object.keys(entries)) {
      if (k.startsWith('_')) continue;
      const key = `${group}.${k}`;
      if (!anchors.includes(key) && !UNANCHORED_OK[key]) unanchored.push(key);
    }
  }
  assert.deepEqual(unanchored, [], `selectors with no health anchor and no documented exemption: ${unanchored.join(', ')}`);
});

// --- Theme B: ProbeStatus consumers must be total over the union ---

test('isFailing / isWorking classify every ProbeStatus, and degraded is working', async () => {
  const { isFailing, isWorking } = await import('../ui-anchors.ts');
  assert.equal(isFailing('fail'), true);
  for (const s of ['ok', 'degraded', 'skip']) assert.equal(isFailing(s), false, `${s} must not read as failing`);
  // The F10 defect: degraded means the anchor WORKS via a superseded branch, so
  // a re-probe returning it must not revert a patch that succeeded.
  assert.equal(isWorking('degraded'), true);
  assert.equal(isWorking('ok'), true);
  assert.equal(isWorking('fail'), false);
  assert.equal(isWorking('skip'), false);
});

test('auto-heal judges the PATCHED anchor strictly and every other anchor by the shared predicate', () => {
  // This test used to assert the opposite for the patched anchor — that
  // `status !== 'ok'` was the bug, because "degraded means the anchor WORKS via
  // a superseded branch, so the patch did its job". That held while only
  // `hasSelector`-shaped anchors were patchable: those return ok or fail and
  // can never be degraded. Patcher V2 made checkWithLegacy anchors patchable,
  // and for those `degraded` means the CANONICAL selector — the exact string
  // auto-heal just wrote — is absent and only the legacy branch matched. So on
  // the patched anchor `degraded` is proof the patch did NOT work, and
  // accepting it shipped a selector the verification had just refuted.
  //
  // The two questions stayed different: `degraded` still counts as working for
  // every other anchor in the collateral gate, where a neighbour running on its
  // legacy branch is genuinely functional.
  const src = fs.readFileSync(path.join(REPO_ROOT, 'scripts/auto-heal.ts'), 'utf8');
  assert.match(
    src,
    /entriesForAnchor\.filter\(\(r\) => r\.status !== 'ok'\)/,
    'the patched anchor must require plain ok — degraded means the written canonical selector is absent'
  );
  assert.match(src, /isFailing\(r\.status\)/, 'every other anchor must still go through the shared predicate');
  assert.match(src, /isWorking\(r\.status\)/, 'and through its dual, so widening ProbeStatus is a compile error');
});

test('a degraded run does not close the drift PR that documents the rot', () => {
  const wf = fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/daily-health.yml'), 'utf8');
  const gate = wf.slice(wf.indexOf('Close stale drift PRs on green'));
  assert.match(gate, /steps\.probe\.outputs\.degraded == '0'/, 'stale-close must be withheld while anchors are degraded');
});

test('the degraded count is published for the workflow to gate on', () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'scripts/ci-health.ts'), 'utf8');
  assert.match(src, /ghOutput\('degraded', String\(counts\.degraded\)\)/);
});

test('the scrubber redacts a home dir whose username contains spaces', async () => {
  // /Users/<first> <last>/ leaked the surname: [^/\s] stops at the space, so
  // only the first token was redacted.
  const { scrubForTest } = await import('../scripts/ci-health.ts');
  assert.equal(scrubForTest('/Users/Provi Last/x/bin/designer'), '/Users/<redacted>/x/bin/designer');
  assert.equal(scrubForTest('/home/runner work/y/z'), '/home/<redacted>/y/z');
  // Still handles the trailing-segment form, and does not run away over prose.
  assert.equal(scrubForTest('spawnSync /Users/provi ENOENT'), 'spawnSync /Users/<redacted> ENOENT');
  assert.equal(scrubForTest('no path here at all'), 'no path here at all');
});

test('the direct-invocation guard compares realpaths on both sides', () => {
  // import.meta.url is already symlink-resolved; comparing it to a raw argv[1]
  // makes the guard silently false under a symlinked checkout, so the script
  // would be imported but never run.
  for (const f of ['scripts/ci-health.ts', 'scripts/auto-heal.ts']) {
    const src = fs.readFileSync(path.join(REPO_ROOT, f), 'utf8');
    assert.match(src, /realpathSync\(fileURLToPath\(import\.meta\.url\)\)/, `${f}: import side not realpath'd`);
    assert.match(src, /fs\.realpathSync\(process\.argv\[1\]\)/, `${f}: argv side not realpath'd`);
  }
});

test('idOf admits a trailing slash but still rejects project subroutes', () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'designer-controller.ts'), 'utf8');
  const m = src.match(/pathname\.match\(\/(.+?)\/i\)/);
  assert.ok(m, 'idOf regex not found — update this test');
  // The pattern lives inside a TS template literal, so a source `\\\\/` reaches
  // the page as `\/`. Collapse it back so the real boundary is exercised.
  const re = new RegExp(m[1].replace(/\\\\\//g, '/'), 'i');
  const uuid = '11111111-1111-1111-1111-111111111111';
  assert.ok(re.test(`/design/p/${uuid}`), 'bare project path must match');
  assert.ok(re.test(`/design/p/${uuid}/`), 'trailing slash must match (#F8)');
  assert.ok(!re.test(`/design/p/${uuid}/settings`), 'subroutes must NOT match — they become phantom projects');
});

test('the turn-RPC canary resolves the send button through both branches', () => {
  // Residual found sweeping my own #F1 fix: splitting composer.sendButton into
  // canonical + legacy left the canary querying the CANONICAL selector raw —
  // and ui-anchors itself records that data-testid="chat-send-button" was
  // dropped in the 2026-06 build, so the canary would have found nothing.
  const src = fs.readFileSync(path.join(REPO_ROOT, 'ui-anchors.ts'), 'utf8');
  const start = src.indexOf('async function submitTurnRpcCanary');
  const end = src.indexOf('async function checkTurnRpcContract');
  assert.ok(start > 0 && end > start, 'canary bounds not found — update this test');
  const canary = src.slice(start, end);
  assert.ok(
    !/querySelector\(\$\{JSON\.stringify\(SEL\.composer\.sendButton\)\}\)/.test(canary),
    'canary still queries the canonical send button raw — it would miss the live legacy branch'
  );
  assert.match(canary, /SEND_BRANCHES_JSON/, 'canary must resolve ordered branches');
});
