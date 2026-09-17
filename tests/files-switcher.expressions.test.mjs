import test from 'node:test';
import assert from 'node:assert/strict';
import { readRowsExpr, switcherStateExpr, readSwitcherRowsVerified, STAMP_ATTR, STAMP_MOUNT } from '../files-switcher.ts';
import { getSelectors } from '../selectors.ts';

const SEL = getSelectors();

// The page expressions are the PRODUCERS of the signals every other test
// consumes. Testing the consumers only is how the mount-reuse detector could be
// deleted with the whole suite green — so execute the expressions themselves
// against a stub DOM.

function makeEl(text = '', attrs = {}) {
  const a = { ...attrs };
  const el = {
    innerText: text,
    children: [],
    getAttribute: (k) => (k in a ? a[k] : null),
    setAttribute: (k, v) => { a[k] = v; },
    attrs: a
  };
  return el;
}

/** A stub page: one popover container holding `labels` rows. */
function makeDom({ labels = [], names = null, triggerAttrs = null, buttons = [] } = {}) {
  const container = makeEl();
  const rows = labels.map((l, i) => {
    // `names` mirrors the live 2026-09-16 surface: rows carry the full filename
    // (index.html) in data-name while the visible label stays extension-less.
    const attrs = names ? (names[i] === null || names[i] === undefined ? {} : { 'data-name': names[i] }) : {};
    const r = makeEl(`${l}\nEdited now`, attrs);
    r.parentElement = container;
    return r;
  });
  container.children = rows;
  const trigger = triggerAttrs === null ? null : makeEl('', triggerAttrs);
  const buttonEls = buttons.map((b) => makeEl(b));
  return {
    container,
    document: {
      querySelectorAll: (sel) => {
        if (sel === SEL.files.switcherRow) return rows;
        if (sel === 'button') return buttonEls;
        return [];
      },
      querySelector: (sel) => (sel === SEL.files.switcherTrigger ? trigger : null)
    }
  };
}

const evalExpr = (expr, document) => new Function('document', `return ${expr};`)(document);

test('readRowsExpr reports a FRESH mount as not reused, and stamps it', () => {
  const { container, document } = makeDom({ labels: ['index', 'about'] });
  const out = evalExpr(readRowsExpr(SEL.files), document);
  assert.equal(out.reused, false, 'first read of a mount is fresh');
  assert.deepEqual(out.rows.map((r) => r.label), ['index', 'about']);
  // The ROWS carry the mark, not their container — see the re-parenting test.
  for (const r of container.children) {
    assert.equal(r.getAttribute(STAMP_ATTR), STAMP_MOUNT, 'each observed row is stamped as read');
  }
});

test('readRowsExpr reports a RE-READ of the same subtree as reused', () => {
  // This is the mutation the harness caught surviving: if the expression stops
  // computing `reused`, repeated reads of one stale mount look like independent
  // observations and two of them can carry a verdict.
  const { document } = makeDom({ labels: ['index'] });
  const first = evalExpr(readRowsExpr(SEL.files), document);
  const second = evalExpr(readRowsExpr(SEL.files), document);
  assert.equal(first.reused, false);
  assert.equal(second.reused, true, 're-reading the same container must be flagged');
});

test('reuse survives RE-PARENTING — identity is the node, not its container', () => {
  // The mutation: move the observed subtree under a new parent between reads.
  // A container-keyed stamp calls that fresh; a node-keyed one does not.
  const { container, document } = makeDom({ labels: ['index', 'about'] });
  const first = evalExpr(readRowsExpr(SEL.files), document);
  assert.equal(first.reused, false);
  const newParent = makeEl();
  for (const r of container.children) r.parentElement = newParent;
  newParent.children = container.children;
  const second = evalExpr(readRowsExpr(SEL.files), document);
  assert.equal(second.reused, true, 're-parented rows are still the same observation');
});

test('a partially-refreshed list is NOT treated as reused', () => {
  // One old row plus one new row is a real change; requiring EVERY node to be
  // stamped keeps that classified as a fresh observation.
  const a = makeDom({ labels: ['index'] });
  evalExpr(readRowsExpr(SEL.files), a.document);
  const stale = a.container.children[0];
  const b = makeDom({ labels: ['about'] });
  b.container.children.unshift(stale);
  const rowsB = b.container.children;
  b.document.querySelectorAll = (sel) => (sel === SEL.files.switcherRow ? rowsB : []);
  assert.equal(evalExpr(readRowsExpr(SEL.files), b.document).reused, false);
});

test('readRowsExpr treats a genuinely NEW mount as fresh again', () => {
  const a = makeDom({ labels: ['index'] });
  evalExpr(readRowsExpr(SEL.files), a.document);
  const b = makeDom({ labels: ['index'] }); // new container = real remount
  const out = evalExpr(readRowsExpr(SEL.files), b.document);
  assert.equal(out.reused, false, 'a fresh subtree must not be mistaken for a reuse');
});

test('switcherStateExpr trusts aria-expanded over row count', () => {
  const open = makeDom({ labels: [], triggerAttrs: { 'aria-expanded': 'true' } });
  assert.equal(evalExpr(switcherStateExpr(SEL.files), open.document), 'open-empty');
  const shut = makeDom({ labels: [], triggerAttrs: { 'aria-expanded': 'false' } });
  assert.equal(evalExpr(switcherStateExpr(SEL.files), shut.document), 'closed');
});

test('switcherStateExpr says unknown — never closed — when nothing can tell', () => {
  // Chrome label renamed AND no aria-expanded: the answer must degrade safely.
  const d = makeDom({ labels: [], triggerAttrs: {}, buttons: ['Neue leere Seite'] });
  assert.equal(evalExpr(switcherStateExpr(SEL.files), d.document), 'unknown');
});

test('switcherStateExpr reports open when rows are present', () => {
  const d = makeDom({ labels: ['index'], triggerAttrs: {} });
  assert.equal(evalExpr(switcherStateExpr(SEL.files), d.document), 'open');
});

test('readRowsExpr surfaces data-name as the real filename, null when absent', () => {
  // Since 2026-09-16 the switcher is the only file surface on plain-HTML
  // sessions; listFiles keys on data-name ("index.html"), never on the
  // extension-less label. The expression must carry it through — and report
  // null (not a label) when a build exposes no data-name, so the controller's
  // all-or-nothing rule can refuse label-shaped lists.
  const withNames = makeDom({ labels: ['about', 'index'], names: ['about.html', 'index.html'] });
  const out = evalExpr(readRowsExpr(SEL.files), withNames.document);
  assert.deepEqual(out.rows.map((r) => r.name), ['about.html', 'index.html']);
  assert.deepEqual(out.rows.map((r) => r.label), ['about', 'index'], 'label stays extension-less');

  const mixed = makeDom({ labels: ['about', 'index'], names: [null, 'index.html'] });
  const out2 = evalExpr(readRowsExpr(SEL.files), mixed.document);
  assert.equal(out2.rows[0].name, null, 'a row without data-name reports null');
  assert.equal(out2.rows[1].name, 'index.html');
});

test('readRowsExpr keeps label/editedText parsing intact alongside name', () => {
  const out = evalExpr(readRowsExpr(SEL.files), makeDom({ labels: ['solo'] }).document);
  assert.deepEqual(out.rows, [{ label: 'solo', editedText: 'Edited now', name: null }]);
});

// --- 2026-09-16 gate: behavioral anchors for the shared read lifecycle (F3/F4) ---

/** Minimal stub satisfying SwitcherReadBrowser, scripted per-call. */
function stubBrowser(script) {
  let i = 0;
  const calls = { clicks: 0, escapes: 0, exprs: [] };
  const b = {
    calls,
    click: async () => { calls.clicks++; },
    press: async () => { calls.escapes++; },
    evalValue: async (js) => {
      calls.exprs.push(js.slice(0, 40));
      const step = script[Math.min(i, script.length - 1)];
      i++;
      const r = typeof step === 'function' ? step(js) : step;
      if (r && typeof r === 'object' && 'throw' in r) throw new Error(r.throw);
      return r;
    }
  };
  return b;
}

test('readSwitcherRowsVerified: open → read → verified close, no Escape', async () => {
  // state closed → (trusted click) → open → read rows → state open → (close click) → closed
  const b = stubBrowser(['closed', 'open', { rows: [{ label: 'index', editedText: null, name: 'index.html' }], reused: false }, 'open', 'closed', 'closed']);
  const read = await readSwitcherRowsVerified(b, SEL.files);
  assert.deepEqual(read?.rows.map((r) => r.name), ['index.html']);
  assert.equal(b.calls.escapes, 0, 'no Escape when the trusted close verifies');
});

test('readSwitcherRowsVerified: close fails → synthetic fails → Escape fires, unverified warns', async () => {
  const warns = [];
  const origWarn = console.warn;
  console.warn = (m) => warns.push(String(m));
  try {
    // closed → open → read → still open (close no-ops every time)
    const b = stubBrowser(['closed', 'open', { rows: [], reused: false }, 'open', 'open', 'open', 'open', 'open']);
    await readSwitcherRowsVerified(b, SEL.files);
    assert.ok(b.calls.escapes >= 1, 'Escape escalation must fire');
    assert.ok(warns.some((w) => w.includes('restoration unverified')), 'unverified postcondition must warn');
  } finally {
    console.warn = origWarn;
  }
});

test('readSwitcherRowsVerified: popover never opens → null read, no Escape, no warn', async () => {
  const warns = [];
  const origWarn = console.warn;
  console.warn = (m) => warns.push(String(m));
  try {
    const b = stubBrowser(['closed', 'closed', 'closed', 'closed']);
    const read = await readSwitcherRowsVerified(b, SEL.files);
    assert.equal(read, null);
    assert.equal(b.calls.escapes, 0);
    // final state read is 'closed' — no warn
    assert.equal(warns.filter((w) => w.includes('switcher')).length, 0);
  } finally {
    console.warn = origWarn;
  }
});

test('readSwitcherRowsVerified: dead transport in cleanup → unverified warns (error state is not a pass)', async () => {
  const warns = [];
  const origWarn = console.warn;
  console.warn = (m) => warns.push(String(m));
  try {
    // closed → open → read ok → then every state eval throws (transport dead)
    const b = stubBrowser(['closed', 'open', { rows: [], reused: false }, { throw: 'transport dead' }, { throw: 'transport dead' }, { throw: 'transport dead' }]);
    const read = await readSwitcherRowsVerified(b, SEL.files);
    assert.deepEqual(read?.rows, [], 'the read itself is still returned');
    assert.ok(warns.some((w) => w.includes('state=error')), 'error state must warn as unverified, not pass silently');
  } finally {
    console.warn = origWarn;
  }
});
