import test from 'node:test';
import assert from 'node:assert/strict';
import { readRowsExpr, switcherStateExpr, STAMP_ATTR, STAMP_MOUNT } from '../files-switcher.ts';
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
function makeDom({ labels = [], triggerAttrs = null, buttons = [] } = {}) {
  const container = makeEl();
  const rows = labels.map((l) => { const r = makeEl(`${l}\nEdited now`); r.parentElement = container; return r; });
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
