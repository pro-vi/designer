import test from 'node:test';
import assert from 'node:assert/strict';
import { UI_ANCHORS } from '../ui-anchors.ts';
import { getSelectors } from '../selectors.ts';

const SEL = getSelectors();
const anchor = UI_ANCHORS.find((a) => a.id === 'session.filesSwitcher');

/** Minimal Browser stub: only what this anchor touches. */
const stub = ({ url = 'https://claude.ai/design/p/abc12345-1111-2222-3333-444455556666', present = [] } = {}) => ({
  url: async () => url,
  evalValue: async (expr) => {
    if (expr.includes('querySelector(') && expr.includes('!!')) {
      return present.some((p) => expr.includes(p));
    }
    return null;
  },
  hover: async () => '',
  click: async () => '',
  press: async () => '',
  isVisible: async () => false
});

test('the switcher anchor FAILS when its trigger is gone from a project page', async () => {
  // The selector is production-required: without it deleteFile cannot run.
  // Returning 'skip' here let exactly the drift this probe exists to catch stay
  // green — the anchor would report healthy while the feature was dead.
  const r = await anchor.check(stub({ present: [] }), '');
  assert.equal(r.ok, false, 'a missing trigger on a project page is drift, not an inconclusive probe');
  assert.match(r.detail, /files-switcher-trigger|cannot run/, 'the failure names the selector and the consequence');
});

test('the switcher anchor SKIPS when the page is not a project at all', async () => {
  const r = await anchor.check(stub({ url: 'https://claude.ai/design', present: [] }), '');
  assert.equal(r.ok, true);
  assert.equal(r.status, 'skip', 'no project surface is genuinely inconclusive');
});

/**
 * Page stub where TRUSTED clicks do nothing and only a synthetic `el.click()`
 * actuates — the live 2026-08-01 behaviour of claude.ai/design. Production's
 * deleteFile has always fallen back to a synthetic click; this probe did not,
 * so it failed five consecutive daily runs (#138-#143) while deletion worked.
 *
 * The stub tracks whether each surface was opened synthetically, so a probe that
 * only issues trusted clicks can never reach the menu.
 */
const trustedClickIsDead = ({ menuItems = ['Download', 'Delete'] } = {}) => {
  const state = { popoverOpen: false, menuOpen: false, trustedClicks: 0, syntheticClicks: 0 };
  const browser = {
    state,
    url: async () => 'https://claude.ai/design/p/abc12345-1111-2222-3333-444455556666',
    hover: async () => '',
    press: async () => {
      state.menuOpen = false;
      state.popoverOpen = false;
      return '';
    },
    // Trusted click: counted, deliberately inert.
    click: async () => {
      state.trustedClicks += 1;
      return '';
    },
    isVisible: async () => state.popoverOpen,
    evalValue: async (expr) => {
      // Synthetic opener for the popover (clickTriggerExpr) and for the row menu.
      if (expr.includes("return 'clicked'")) {
        state.syntheticClicks += 1;
        if (expr.includes('files-switcher-trigger')) state.popoverOpen = true;
        else state.menuOpen = true;
        return 'clicked';
      }
      if (expr.includes('!!document.querySelector') && expr.includes('files-switcher-trigger')) return true;
      // switcherStateExpr
      if (expr.includes("return 'open'") && expr.includes("return 'closed'")) {
        return state.popoverOpen ? 'open' : 'closed';
      }
      // readRowsExpr
      if (expr.includes('mount-read')) {
        return { rows: state.popoverOpen ? [{ label: 'Page', editedText: 'Edited 1h ago' }] : [], reused: false };
      }
      // stampRowExpr
      if (expr.includes("'stamped'") && expr.includes('data-designer-target="row"')) {
        return state.popoverOpen ? 'stamped' : 'no-row:0';
      }
      // Row-count cardinality read.
      if (expr.includes('.length') && expr.includes('files-switcher-row')) return state.popoverOpen ? 1 : 0;
      // readItems inside probeRowMenu.
      if (expr.includes('[role="menu"] [role="menuitem"]')) return state.menuOpen ? menuItems : [];
      // stampMenuDeleteExpr
      if (expr.includes("'no-menu'")) {
        if (!state.menuOpen) return 'no-menu';
        return menuItems.filter((t) => t === 'Delete').length === 1 ? 'stamped' : `items:${menuItems.join('|')}`;
      }
      return null;
    }
  };
  return browser;
};

test('the switcher probe opens the row menu synthetically when the trusted click no-ops', async () => {
  const b = trustedClickIsDead();
  const r = await anchor.check(b, '');
  assert.equal(r.ok, true, 'a page where only synthetic clicks land is what production already handles');
  assert.ok(b.state.trustedClicks > 0, 'the trusted click is still tried FIRST');
  assert.ok(b.state.syntheticClicks > 0, 'the synthetic fallback is what actually opens the menu');
  assert.match(r.detail, /synthetic fallback/, 'the report says the trusted click no-opped rather than hiding it');
});

test('the switcher probe still FAILS when neither click opens the menu', async () => {
  // The fallback must not become a way to pass without ever seeing a menu.
  const b = trustedClickIsDead();
  const inert = { ...b, evalValue: async (expr) => (expr.includes("return 'clicked'") && !expr.includes('files-switcher-trigger') ? 'absent' : b.evalValue(expr)) };
  const r = await anchor.check(inert, '');
  assert.equal(r.ok, false, 'no menu by any means is real drift');
  assert.match(r.detail, /no role=menu items/);
});
