import assert from 'node:assert/strict';
import test from 'node:test';
import { selectDesignTarget } from '../cdp-trace.ts';

const tab = (id, url) => ({ id, type: 'page', title: id, url, webSocketDebuggerUrl: `ws://x/${id}` });

const SESSION = 'https://claude.ai/design/p/09b4d839-ff85-44ac-bb6a-19d8fce4ec3b?file=report-view.html';

test('exact preferUrlPrefix match binds that tab', () => {
  const t = selectDesignTarget([tab('a', SESSION), tab('b', 'https://claude.ai/design')], { preferUrlPrefix: SESSION });
  assert.equal(t.id, 'a');
});

test('duplicate exact-URL tabs throw by default (write-path safety)', () => {
  const dups = [tab('rendered', SESSION), tab('idle', SESSION)];
  assert.throws(() => selectDesignTarget(dups, { preferUrlPrefix: SESSION }), /Multiple tabs open at exactly/);
});

test('duplicate exact-URL tabs are tolerated for read-only callers — bind the active-first (#json/list order) one', () => {
  // /json/list orders most-recently-active first, so the first candidate is the
  // tab whose preview actually rendered. This is the daily-health OOPIF confound.
  const dups = [tab('rendered', SESSION), tab('idle', SESSION)];
  const t = selectDesignTarget(dups, { preferUrlPrefix: SESSION, tolerateDuplicateUrl: true });
  assert.equal(t.id, 'rendered');
});

test('tolerateDuplicateUrl does NOT loosen the home-prefix startsWith guard', () => {
  // Home URL is a prefix of every project tab; an exact match must still win over
  // a bare startsWith, even with tolerance on.
  const home = 'https://claude.ai/design';
  const cands = [tab('proj', SESSION), tab('home', home)];
  const t = selectDesignTarget(cands, { preferUrlPrefix: home, tolerateDuplicateUrl: true });
  assert.equal(t.id, 'home');
});

test('single candidate with no preferUrlPrefix binds it', () => {
  const t = selectDesignTarget([tab('solo', SESSION)]);
  assert.equal(t.id, 'solo');
});

test('multiple candidates with no preferUrlPrefix throw the disambiguation error', () => {
  assert.throws(
    () => selectDesignTarget([tab('a', SESSION), tab('b', 'https://claude.ai/design')]),
    /pass --target-url to disambiguate/
  );
});
