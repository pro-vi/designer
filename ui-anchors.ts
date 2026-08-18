import type { Browser } from './browser.ts';
import { RunStateObserver } from './run-state.ts';
import { isPreviewIframeSrc, previewIframeVariant, isBootstrapShellHtml } from './preview-host.ts';
import { isCdpEnabled } from './cdp-env.ts';
import { OopifHtmlReader } from './oopif-reader.ts';
import { OPEN_FILES_PANEL_EXPR } from './file-panel.ts';
import {
  switcherStateExpr,
  clickTriggerExpr,
  readRowsExpr,
  rowSelector,
  stampRowExpr,
  stampMenuDeleteExpr,
  clearStampsExpr,
  dialogPresentExpr,
  MENU_ITEM_DELETE,
  MENU_ITEM_DOWNLOAD,
  type SwitcherRow
} from './files-switcher.ts';
import { getSelectors, orderedBranches, presenceSelector } from './selectors.ts';

// Every UI anchor this MCP depends on to work. Grouped by the surface state
// they live on. A regression in Claude Design's UI will trip one or more of
// these; `designer health` walks all of them and reports what broke.
//
// Anchors read their DOM selectors from the shared selectors.json (via SEL)
// rather than hardcoding literals, so `designer health` validates the SAME
// contract the controller's verbs use — a drift repair in selectors.json can't
// leave a stale health probe behind (the login.signedIn class of bug).
const SEL = getSelectors();

export type AnchorCategory = 'home' | 'session' | 'share' | 'pattern';
export type AnchorState = 'home' | 'session' | 'any';
// `degraded` = the canonical selector is GONE but a superseded legacy branch
// still matches. The tool keeps working, so this is not a `fail` (it must not
// open drift PRs or go red), but it is emphatically not `ok` either — before
// this existed the legacy branch was packed into the same comma-OR selector and
// simply kept the anchor green, hiding the canonical rot from the daily probe.
export type ProbeStatus = 'ok' | 'degraded' | 'fail' | 'skip';

/**
 * Typed predicates over ProbeStatus, exported so every consumer classifies the
 * same way. Written as exhaustive switches: adding a status value makes these a
 * COMPILE error instead of a silent misclassification somewhere downstream.
 *
 * Widening the union to include `degraded` without making its consumers total is
 * how two separate decision points went wrong — a verdict that ignored it, and a
 * re-probe that reverted a working patch because the anchor was not literally
 * 'ok'.
 */
export function isFailing(s: ProbeStatus): boolean {
  switch (s) {
    case 'fail':
      return true;
    case 'ok':
    case 'degraded':
    case 'skip':
      return false;
  }
}

/** True when the anchor is working — including via a superseded selector. */
export function isWorking(s: ProbeStatus): boolean {
  switch (s) {
    case 'ok':
    case 'degraded':
      return true;
    case 'fail':
    case 'skip':
      return false;
  }
}
export type ProbePhase = 'home' | 'session';

export interface ProbeResult {
  id: string;
  category: AnchorCategory;
  description: string;
  requires: AnchorState;
  status: ProbeStatus;
  detail?: string;
  // Present only when runHealth was invoked with an explicit `opts.phase` —
  // tags which navigation state the result was captured in. `any`-anchors
  // probe in both phases, so the same id may appear twice with different
  // phase tags.
  phase?: ProbePhase;
}

interface AnchorDef {
  id: string;
  category: AnchorCategory;
  description: string;
  requires: AnchorState;
  check: (browser: Browser, currentUrl: string) => Promise<{ ok: boolean; status?: ProbeStatus; detail?: string }>;
}

async function hasSelector(browser: Browser, sel: string): Promise<boolean> {
  return !!(await browser
    .evalValue<boolean>(`!!document.querySelector(${JSON.stringify(sel)})`)
    .catch(() => false));
}

/**
 * Probe a canonical selector, falling back to a superseded one ONLY to
 * distinguish "still works via the old shape" from "gone entirely".
 *
 * Ordered on purpose: packing both into one `querySelector('A, B')` would return
 * whichever comes first in document order — not the canonical match — and would
 * report plain `ok` either way, which is exactly how legacy branches masked
 * canonical rot from the daily probe.
 */
async function checkWithLegacy(
  browser: Browser,
  canonical: string,
  legacy: string | null | undefined,
  label: string
): Promise<{ ok: boolean; status?: ProbeStatus; detail?: string }> {
  if (await hasSelector(browser, canonical)) return { ok: true };
  if (legacy && (await hasSelector(browser, legacy))) {
    return {
      ok: true,
      status: 'degraded',
      detail: `canonical ${label} selector (${canonical}) is GONE; still matching the superseded branch (${legacy}). Re-capture the canonical selector — the tool works today but this is unrepaired drift.`
    };
  }
  return { ok: false, detail: `neither canonical (${canonical}) nor legacy (${legacy ?? 'none'}) matched` };
}

// True on a `.dc.html` DESIGN-CANVAS session (a Figma-like editor — dc-tool-*,
// dc-mode-* toolbars; live-verified 2026-06-30). The canvas is a different surface
// than the plain-HTML file view the flat DOM scrapers target: it collapses the
// chat into a closed overlay (so chat-messages renders 0 turn rows) and hides the
// project files behind a page switcher (so the flat filename scrape finds none).
// The designer tool doesn't support the canvas editor, so the soft scrape anchors
// SKIP here (inconclusive in this view) rather than false-fail as "drift" — the
// same stance as their existing "no file open -> skip" guards. Plain-HTML sessions
// have no dc-* toolbar, so they still run the scrapers and catch real regressions.
async function isCanvasEditorView(browser: Browser): Promise<boolean> {
  return !!(await browser
    .evalValue<boolean>(`!!document.querySelector('[data-testid^="dc-tool-"], [data-testid^="dc-mode-"]')`)
    .catch(() => false));
}

async function hasButtonMatching(browser: Browser, pattern: RegExp): Promise<boolean> {
  return !!(await browser
    .evalValue<boolean>(
      `(() => { const re = new RegExp(${JSON.stringify(pattern.source)}, ${JSON.stringify(pattern.flags)}); return Array.from(document.querySelectorAll('button')).some(b => re.test((b.textContent || '').trim())); })()`
    )
    .catch(() => false));
}

// The design-preview iframe's src. Shared by the preview anchors below
// (iframeSrcPattern / previewBootstrap / oopifPreviewRead) so they read the
// element the same way. '' when absent (caller decides skip vs fail).
async function getPreviewIframeSrc(browser: Browser): Promise<string> {
  return (
    (await browser
      .evalValue<string>(
        `(() => { const el = document.querySelector(${JSON.stringify(SEL.preview.iframeOrContainer)}); return (el && el.src) || ''; })()`
      )
      .catch(() => '')) || ''
  );
}

/**
 * Hover the first switcher row, open its action menu, and check the menu the
 * way PRODUCTION checks it — then stop. Never clicks Delete: the canary is
 * single-file, so deleting its page would destroy the surface every other
 * session.* anchor needs.
 */
async function probeRowMenu(
  b: Browser,
  entryCount: number
): Promise<{ ok: boolean; status?: ProbeStatus; detail?: string }> {
  // Row actions are hover-revealed and need TRUSTED input; a synthetic
  // mouseover would not reveal them.
  const stampedRow = await b.evalValue<string>(stampRowExpr(SEL.files, 0)).catch(() => 'error');
  if (stampedRow !== 'stamped') return { ok: false, detail: `could not address the first switcher row (${stampedRow})` };
  const rowSel = rowSelector();
  await b.hover(rowSel).catch(() => null);
  await sleep(400);
  const moreSel = `${rowSel} ${SEL.files.rowMoreActions}`;
  if (!(await b.isVisible(moreSel).catch(() => false))) {
    await b.hover(rowSel).catch(() => null);
    await sleep(500);
  }
  if (!(await b.isVisible(moreSel).catch(() => false))) {
    return { ok: false, detail: `row actions did not reveal on hover (${SEL.files.rowMoreActions} not visible)` };
  }

  // Open the menu the way PRODUCTION opens it: trusted click, then a synthetic
  // fallback. deleteFile has had that fallback all along; this probe had only
  // the trusted half, so when trusted clicks stopped actuating these controls
  // the probe failed daily (#138-#143) while deletion kept working — a probe
  // STRICTER than production, which is the PR #77 split running the other way.
  // The synthetic click is safe here for the same reason clickTriggerExpr is:
  // opening a menu is not destructive. Delete is still never clicked.
  const readItems = async (): Promise<string[]> =>
    (await b
      .evalValue<string[]>(
        `(() => Array.from(document.querySelectorAll('[role="menu"] [role="menuitem"], [role="menu"] button'))
           .map((e) => (e.textContent || '').trim()).filter(Boolean))()`
      )
      .catch(() => [] as string[])) || [];

  await b.click(moreSel).catch(() => null);
  await sleep(600);
  let items = await readItems();
  let openedSynthetically = false;
  if (items.length === 0) {
    const res = await b
      .evalValue<string>(
        `(() => { const e = document.querySelector(${JSON.stringify(moreSel)}); if (!e) return 'absent'; e.click(); return 'clicked'; })()`
      )
      .catch(() => 'error');
    await sleep(800);
    if (res === 'clicked') {
      items = await readItems();
      openedSynthetically = items.length > 0;
    }
  }
  if (items.length === 0) {
    return { ok: false, detail: 'row "More actions" opened no role=menu items (trusted click and synthetic fallback both)' };
  }
  if (!items.includes(MENU_ITEM_DOWNLOAD)) {
    return { ok: false, detail: `row menu missing "${MENU_ITEM_DOWNLOAD}" (items: ${items.join(', ')})` };
  }

  // Accept EXACTLY what production accepts. `items.includes('Delete')` is looser
  // than the delete flow's rule (exactly one exact-text match inside an open
  // menu), so a duplicate or stale item would keep this anchor green while every
  // deletion refused with 'menu-unavailable'. Run the real resolver — it only
  // stamps an attribute, it never clicks. #F9.
  const menuResolves = await b.evalValue<string>(stampMenuDeleteExpr()).catch(() => 'error');
  const opener = openedSynthetically ? '; opened via the synthetic fallback (trusted click no-opped)' : '';
  if (menuResolves === 'stamped') {
    return { ok: true, detail: `${entryCount} row(s); menu offers ${items.join(', ')}${opener}` };
  }
  if (items.includes(MENU_ITEM_DELETE)) {
    return {
      ok: false,
      detail: `menu shows "${MENU_ITEM_DELETE}" but production's resolver refuses it (${menuResolves}) — deletion would fail with menu-unavailable`
    };
  }
  // A one-page project plausibly cannot delete its last page. The canary is
  // single-file by policy, so treat that as degraded rather than a daily
  // false-fail.
  if (entryCount === 1) {
    return {
      ok: true,
      status: 'degraded',
      detail: `single-page project — no "${MENU_ITEM_DELETE}" item offered (items: ${items.join(', ')})${opener}`
    };
  }
  return { ok: false, detail: `row menu missing "${MENU_ITEM_DELETE}" (items: ${items.join(', ')})` };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Ordered canonical-then-legacy branches for the composer send button, embedded
// into the in-page snippets below. Splitting composer.sendButton into
// canonical + composerLegacy made the canonical selector alone insufficient here:
// ui-anchors itself records that data-testid="chat-send-button" was dropped in
// the 2026-06 build, so a raw canonical lookup finds nothing on the live UI.
// Resolved in order rather than comma-joined, so a stale duplicate earlier in
// the document cannot win the click.
const SEND_BRANCHES_JSON = JSON.stringify(orderedBranches(SEL.composer.sendButton, SEL.composerLegacy?.sendButton));

async function submitTurnRpcCanary(browser: Browser): Promise<{ ok: boolean; detail?: string }> {
  const prompt =
    'Health check: answer in chat only with the single word ok. Do not create, modify, or delete files.';
  const filled = await browser
    .evalValue<boolean>(
      `(() => {
        const el = document.querySelector(${JSON.stringify(SEL.composer.promptTextarea)});
        if (!el) return false;
        const text = ${JSON.stringify(prompt)};
        if (el instanceof HTMLTextAreaElement) {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
          setter.call(el, text);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.focus();
          return true;
        }
        if (el.isContentEditable) {
          el.focus();
          const sel = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(el);
          sel.removeAllRanges();
          sel.addRange(range);
          const dt = new DataTransfer();
          dt.setData('text/plain', text);
          const unhandled = el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
          if (unhandled) document.execCommand('insertText', false, text);
          return true;
        }
        return false;
      })()`
    )
    .catch(() => false);
  if (!filled) return { ok: false, detail: 'composer not fillable for canary prompt' };

  for (let i = 0; i < 30; i++) {
    const disabled = await browser
      .evalValue<boolean>(
        `(() => {
          let b = null;
          for (const s of ${SEND_BRANCHES_JSON}) { b = document.querySelector(s); if (b) break; }
          return !b || b.disabled || b.getAttribute('aria-disabled') === 'true';
        })()`
      )
      .catch(() => true);
    if (!disabled) break;
    await sleep(150);
  }

  const clicked = await browser
    .evalValue<boolean>(
      `(() => {
        let b = null;
        for (const s of ${SEND_BRANCHES_JSON}) { b = document.querySelector(s); if (b) break; }
        if (!b || b.disabled || b.getAttribute('aria-disabled') === 'true') return false;
        b.click();
        return true;
      })()`
    )
    .catch(() => false);
  return clicked ? { ok: true } : { ok: false, detail: 'send button unavailable for canary prompt' };
}

async function checkTurnRpcContract(_browser: Browser, currentUrl: string): Promise<{ ok: boolean; status?: ProbeStatus; detail?: string }> {
  if (process.env.DESIGNER_TURN_RPC_CANARY !== '1') {
    return { ok: true, status: 'skip', detail: 'turn-RPC canary disabled (DESIGNER_TURN_RPC_CANARY!=1)' };
  }
  if (!isCdpEnabled()) {
    return { ok: true, status: 'skip', detail: "CDP disabled (DESIGNER_CDP=''); turn-RPC canary not probed" };
  }
  const observer = await RunStateObserver.attach({ preferUrlPrefix: currentUrl.split('?')[0] || null });
  if (!observer) {
    return { ok: true, status: 'skip', detail: 'CDP observer unavailable; turn-RPC canary not probed' };
  }

  try {
    observer.beginRun();
    const submitted = await submitTurnRpcCanary(_browser);
    if (!submitted.ok) return { ok: true, status: 'skip', detail: submitted.detail };

    const terminal = await observer.awaitTerminal({ stallMs: 25_000, hardTimeoutMs: 75_000 });
    const summary = observer.signalSummary();
    const detail =
      `heartbeat x${summary.heartbeat}, release ${summary.release > 0 ? 'seen' : 'missing'}, ` +
      `chat x${summary.chatOpen}, chunks x${summary.chatChunk}, terminal=${terminal.terminal}` +
      (summary.observedRpcPaths.length ? `, observed=[${summary.observedRpcPaths.join(', ')}]` : ', observed=[]');
    return {
      // A healthy fast chat-only turn can finish before the first RenewTurn
      // (~14.5s in, per trace findings), so heartbeat>0 is not a contract
      // requirement — gate on the discrete signals (chat opened + released +
      // finished). heartbeat count stays visible in `detail` as soft signal.
      ok: terminal.terminal === 'finished' && summary.release > 0 && summary.chatOpen > 0,
      detail
    };
  } finally {
    observer.close();
  }
}

export const UI_ANCHORS: AnchorDef[] = [
  // --- login state (first so a signed-out session tops the report) ---
  {
    // Issue #32: signed out, `designer health` showed only skips/cryptic
    // fails and read as "everything OK". This anchor calls the signed-out
    // state out explicitly.
    //
    // A URL-only check is not enough: a logged-out visit to claude.ai/design
    // sometimes redirects to /login, but sometimes renders the login wall AT
    // the /design URL with no /login substring (the #16 false positive that
    // setup's DOM-based verifier exists to catch — see setup.ts). So gate on
    // the DOM app-shell marker setup uses, not the URL alone.
    id: 'login.signedIn',
    category: 'pattern',
    description: 'signed in (claude.ai is rendering the app shell, not the login wall)',
    requires: 'any',
    check: async (b, url) => {
      // Explicit login wall in the URL — unambiguously signed out.
      if (/claude\.ai\/login/.test(url)) {
        return { ok: false, detail: `signed out — Chrome is on the login wall (${url.slice(0, 80)}). Run: designer setup` };
      }
      // On a design surface, the signed-in app shell renders a composer-or-create
      // affordance: in-session that's the chat composer (chat-composer-input);
      // on the 2026-06-22 re-drifted home it's a plain <textarea> + a
      // `button[title="Create"]` (the chat-composer-input testid was stripped from
      // the home — see selectors.json `_drift`). Accept EITHER. We key the home arm
      // on the design-specific Create button, not a bare <textarea>, so a login
      // wall / re-auth page that happens to render some textarea can't false-pass
      // this signed-in check (the #16/#32 false-positive this anchor guards). Its
      // absence means the login wall is served at the /design URL — fail loudly.
      if (/claude\.ai\/design/.test(url)) {
        if (await hasSelector(b, SEL.login.signedInIndicator ?? '')) return { ok: true };
        // Legacy arm: `button[title="Create"]` used to be packed into the same
        // comma-OR as the composer testids. It is weaker evidence of auth than a
        // composer (an action button could plausibly render on an unauthenticated
        // shell), so it no longer counts as a clean pass — but it still beats
        // sending the user to re-login. Keep it, mark it degraded.
        const legacyMarker = SEL.loginLegacy?.signedInIndicator;
        if (legacyMarker && (await hasSelector(b, legacyMarker))) {
          return {
            ok: true,
            status: 'degraded',
            detail: `signed-in marker matched only the superseded branch (${legacyMarker}); canonical composer testids absent. This branch is WEAK evidence of authentication (an action button could plausibly render on an unauthenticated shell), so treat sign-in as unconfirmed: re-capture login.signedInIndicator first, and only if the composer is genuinely absent while signed in does \`designer setup\` apply.`
          };
        }
        // The signed-in marker is absent. Before reporting "signed out" (which
        // sends the user to re-login), check for an unambiguous signed-in-home
        // landmark the login wall never renders — a project link or the home
        // heading. If one is present, the app shell IS up and the MARKER has
        // drifted, not the session: say so, so the fix is "re-capture
        // login.signedInIndicator", not a fruitless re-login. This is the
        // self-diagnosis the 2026-06-29 inbox (#73) asked for, after a prior home
        // redesign sent the reporter chasing a non-existent auth problem.
        //
        // Deliberately NOT keyed on a bare <textarea> (unlike the create-flow
        // anchors): a re-auth/login page can render a textarea, and this arm must
        // not call a genuine login wall "drift". Project links and the home
        // heading only render for a signed-in home — the same anti-false-positive
        // stance the signed-in arm takes by keying on the Create button.
        const shellPresent = await b
          .evalValue<boolean>(
            `!!(document.querySelector('a[href*="/design/p/"]') || /what will you design today/i.test(document.body ? document.body.innerText : ''))`
          )
          .catch(() => false);
        return shellPresent
          ? {
              ok: false,
              detail: `app shell IS rendering at ${url.slice(0, 80)} but the signed-in marker (${SEL.login.signedInIndicator}) is missing — likely SELECTOR DRIFT, not signed out. Re-capture login.signedInIndicator in selectors.json; do NOT re-login.`
            }
          : { ok: false, detail: `login wall rendered at ${url.slice(0, 80)} (no app shell) — signed out. Run: designer setup` };
      }
      // Off the claude.ai/design surface entirely (e.g. an unrelated tab) —
      // sign-in can't be judged from this tab, so don't false-fail.
      return { ok: true, detail: `not on a claude.ai/design surface (url=${url.slice(0, 60)}) — sign-in not checked here` };
    }
  },

  // --- home page ---
  // 2026-07 home, re-captured live 2026-07-24 from Chrome 150 (signed-in profile)
  // after nine consecutive daily drift PRs (#118–#126). Still composer-driven, but
  // every home anchor is now keyed on a data-testid — the two that regressed were
  // the two keyed on a tag name and a visible label:
  //   * home.creator was the bare tag `textarea`; the home now renders ZERO
  //     textareas (the composer is a ProseMirror contenteditable div).
  //   * home.highFiButton matched the label "Prototype", which was renamed to
  //     "Mobile app design" — the third rename of that card's label, against zero
  //     moves of its `carousel-type-prototype` testid.
  // So the creation-type cards are selector anchors now, not text matchers. The
  // old home.nameInput anchor stays dropped (no equivalent). The cards remain off
  // the create path (they only set the Template pill) — drift sentinels only.
  //
  // 2026-08-01: the `carousel-type-*` testids were then removed outright (five
  // consecutive drift PRs, #138-#143 — the home now renders zero
  // [data-testid*=carousel] nodes). Re-keyed onto the one per-card identifier the
  // renames do not touch: the thumbnail asset slug, `img.om-grid-thumb[src*=
  // "/grid-thumbs/<kind>."]`. That slug reuses the dead testids' own vocabulary,
  // so `prototype` still names the card whose visible label is now "Mobile app
  // design". The dead testids move to homeLegacy, which makes a rollback read
  // `degraded` instead of `fail`. See `_cards` in selectors.json for the capture.
  {
    id: 'home.creator',
    category: 'home',
    description: 'creation composer (contenteditable [data-testid="home-composer-input"])',
    requires: 'home',
    check: async (b) => ({ ok: await hasSelector(b, SEL.home.creator) })
  },
  {
    id: 'home.wireframeButton',
    category: 'home',
    description: 'Wireframe creation-type card (thumbnail slug /grid-thumbs/wireframe.)',
    requires: 'home',
    check: async (b) =>
      checkWithLegacy(b, SEL.home.wireframeButton, SEL.homeLegacy?.wireframeButton, 'home.wireframeButton')
  },
  {
    id: 'home.highFiButton',
    category: 'home',
    description: 'Prototype creation-type card (thumbnail slug /grid-thumbs/prototype.)',
    requires: 'home',
    check: async (b) =>
      checkWithLegacy(b, SEL.home.highFiButton, SEL.homeLegacy?.highFiButton, 'home.highFiButton')
  },
  {
    id: 'home.createButton',
    category: 'home',
    description: 'creation submit button ([data-testid="home-composer-send"])',
    requires: 'home',
    check: async (b) => checkWithLegacy(b, SEL.home.createButton, SEL.homeLegacy?.createButton, 'home.createButton')
  },
  {
    id: 'home.projectsList',
    category: 'home',
    description: 'project list ([data-testid="projects-list"])',
    requires: 'home',
    check: async (b) => checkWithLegacy(b, SEL.home.projectsList, SEL.homeLegacy?.projectsList, 'home.projectsList')
  },
  {
    id: 'home.projectLink',
    category: 'home',
    // The selector `listProjects()` actually scrapes. It had NO anchor: the
    // probe read green off projectsList/projectCard while `designer list` could
    // return []. `home.projectCard` carries the link only as a LEGACY branch,
    // which checkWithLegacy never evaluates while the canonical row matches — so
    // it could not stand in for this.
    description: 'per-project link (a[href*="/design/p/"]) — the listProjects scrape target',
    requires: 'home',
    check: async (b) => ({ ok: await hasSelector(b, SEL.home.projectLink) })
  },
  {
    id: 'home.projectCard',
    category: 'home',
    description: 'project row ([data-testid="project-row"])',
    requires: 'home',
    check: async (b) => checkWithLegacy(b, SEL.home.projectCard, SEL.homeLegacy?.projectCard, 'home.projectCard')
  },

  // --- inside a session (after /design/p/{uuid}) ---
  {
    id: 'session.promptTextarea',
    category: 'session',
    description: 'chat composer textarea',
    requires: 'session',
    check: async (b) => ({ ok: await hasSelector(b, SEL.composer.promptTextarea) })
  },
  {
    // Existence (above) isn't enough — _submitPrompt can only fill a composer
    // that is a <textarea> or a contenteditable element, and it branches on
    // exactly that. The 2026-06 build shipped the composer as a ProseMirror
    // contenteditable <div>; if it drifts to a shape that's neither (a bare
    // wrapper, a web component, a readonly node), submission silently stalls
    // and callers fall back to driving the page by hand. That's the regression
    // fract-ai hit on a pre-0.3.9 build (designer/.inbox 2026-06-10). This
    // anchor asserts the composer is in a shape _submitPrompt actually handles.
    //
    // Scope: this checks the composer's SHAPE, not that a paste actually lands
    // (verifying that would mean typing into a live session). A contenteditable
    // whose editor rejects synthetic paste would still pass here.
    //
    // Maintenance: this is a block-bodied evalValue check, so it is NOT
    // auto-heal-patchable (anchor-patcher's canPatch only rewrites the simple
    // `hasSelector(b, '<sel>')` shape). The chat-composer-input selector is
    // duplicated from session.promptTextarea above — if it drifts, auto-heal
    // will self-heal promptTextarea but skip this one; update the selector in
    // the eval below by hand to match. (Same limitation as the other rich
    // anchors here: hasButtonMatching, iframeSrcPattern, fileListScrape.)
    id: 'session.composerFillable',
    category: 'session',
    description: 'composer is fillable (textarea or contenteditable, per _submitPrompt)',
    requires: 'session',
    check: async (b) => {
      type ComposerShape = { found: boolean; tag?: string; contentEditable?: boolean; fillable?: boolean };
      const shape: ComposerShape = await b
        .evalValue<ComposerShape>(
          `(() => {
            const el = document.querySelector(${JSON.stringify(SEL.composer.promptTextarea)});
            if (!el) return { found: false };
            const fillable = el instanceof HTMLTextAreaElement || el.isContentEditable;
            return { found: true, tag: el.tagName, contentEditable: el.isContentEditable, fillable };
          })()`
        )
        .catch((): ComposerShape => ({ found: false }));
      if (!shape.found) return { ok: false, detail: 'composer not found' };
      if (shape.fillable) {
        return { ok: true, detail: shape.contentEditable ? 'contenteditable' : `<${(shape.tag || '').toLowerCase()}>` };
      }
      return {
        ok: false,
        detail: `composer is <${(shape.tag || '?').toLowerCase()}> — neither textarea nor contenteditable; _submitPrompt cannot fill it (composer shape drifted)`
      };
    }
  },
  {
    id: 'session.sendButton',
    category: 'session',
    description: 'send button',
    requires: 'session',
    // The 2026-06 build dropped data-testid="chat-send-button"; the button is
    // now only identifiable by its title="Send (Enter)". These were packed into
    // ONE comma-OR selector, so this anchor reported a clean `ok` while matching
    // only the superseded branch — the exact masking `degraded` exists to
    // surface, sitting live in the repo that introduced it.
    check: async (b) => checkWithLegacy(b, SEL.composer.sendButton, SEL.composerLegacy?.sendButton, 'composer.sendButton')
  },
  {
    id: 'session.htmlViewerIframe',
    category: 'session',
    description: 'html-viewer-iframe (design preview)',
    requires: 'session',
    check: async (b, url) => {
      // The iframe only renders when a file is open. Without ?file= in the URL,
      // its absence is expected, not a regression.
      if (!/[?&]file=/.test(url)) return { ok: true, detail: '(no file open — iframe not expected)' };
      return { ok: await hasSelector(b, SEL.preview.iframeOrContainer) };
    }
  },
  {
    id: 'session.chatMessages',
    category: 'session',
    description: 'chat-messages container',
    requires: 'session',
    check: async (b) => ({ ok: await hasSelector(b, SEL.messages.chatMessagesContainer) })
  },
  {
    id: 'network.turnRpcContract',
    category: 'pattern',
    description: 'OmeletteService Chat/RenewTurn/ReleaseTurn network contract',
    requires: 'session',
    check: checkTurnRpcContract
  },
  {
    id: 'session.iframeSrcPattern',
    category: 'pattern',
    description: 'iframe src serves from claudeusercontent.com (signed-token or bootstrap-subdomain)',
    requires: 'session',
    check: async (b, url) => {
      if (!/[?&]file=/.test(url)) return { ok: true, detail: '(no file open — iframe not expected)' };
      const src = await getPreviewIframeSrc(b);
      if (!src) return { ok: false, detail: 'file param present but iframe missing src' };
      const ok = isPreviewIframeSrc(src);
      return { ok, detail: ok ? `variant=${previewIframeVariant(src)}` : `src=${src.slice(0, 120)}...` };
    }
  },
  {
    // Drift sentinel for the OOPIF preview-HTML capture path (issue #61 / review
    // #4). fetchServedHtml branches on previewIframeVariant: signed-token keeps
    // the legacy node fetch; bootstrap-subdomain reads the cross-origin OOPIF's
    // rendered DOM over CDP. This anchor records which regime the live preview
    // is in so a swing back to signed-token (or to an unrecognized 'other'
    // shape) — which would silently route capture down the wrong path — is
    // visible in the daily health probe. This anchor records the regime only;
    // the sibling `session.oopifPreviewRead` below actually attaches CDP and
    // verifies the bootstrap-subdomain capture returns rendered HTML.
    id: 'network.previewBootstrap',
    category: 'pattern',
    description: 'preview iframe regime (bootstrap-subdomain => OOPIF CDP capture; signed-token => node fetch)',
    requires: 'session',
    check: async (b, url) => {
      if (!/[?&]file=/.test(url)) return { ok: true, detail: '(no file open — preview regime not checked)' };
      const src = await getPreviewIframeSrc(b);
      if (!src) return { ok: false, detail: 'file param present but iframe missing src' };
      if (!isPreviewIframeSrc(src)) return { ok: false, detail: `preview left claudeusercontent.com: ${src.slice(0, 120)}` };
      const variant = previewIframeVariant(src);
      return {
        ok: variant === 'bootstrap-subdomain' || variant === 'signed-token',
        detail:
          variant === 'bootstrap-subdomain'
            ? 'variant=bootstrap-subdomain (OOPIF CDP capture path)'
            : variant === 'signed-token'
              ? 'variant=signed-token (legacy node-fetch path)'
              : `variant=other — unrecognized preview src shape (${src.slice(0, 120)}); capture path may be wrong`
      };
    }
  },
  {
    // End-to-end check of the OOPIF capture itself. iframeSrcPattern /
    // previewBootstrap only inspect the src STRING — the CDP auto-attach read
    // could silently return the ~1.1KB loader shell (or null) while both pass,
    // handing snapshot/fetch/iterate empty HTML (inbox finding #3). This anchor
    // attaches its own OopifHtmlReader (like checkTurnRpcContract attaches a
    // RunStateObserver) and asserts the read returns rendered HTML, not the
    // shell. Only the bootstrap-subdomain regime uses the OOPIF path; the
    // signed-token / 'other' regimes use a node fetch, so they skip here.
    id: 'session.oopifPreviewRead',
    category: 'pattern',
    description: 'OOPIF CDP read returns rendered preview HTML (not the bootstrap loader shell)',
    requires: 'session',
    check: async (b, url) => {
      // Gate on a RENDERED preview iframe, not on ?file= in the URL: the daily-
      // health canary (DESIGNER_PROBE_PROJECT_URL) is a BARE project URL, and
      // claude.ai auto-opens a default file + renders its preview there — so a
      // ?file= gate would skip the OOPIF check in exactly the CI run it exists to
      // protect (PR #77 Codex P2). Wait briefly for the iframe to paint after nav.
      let src = await getPreviewIframeSrc(b);
      for (let i = 0; i < 6 && !isPreviewIframeSrc(src); i++) {
        await sleep(500);
        src = await getPreviewIframeSrc(b);
      }
      if (!isPreviewIframeSrc(src)) return { ok: true, status: 'skip', detail: 'no preview iframe rendered (no file open)' };
      const variant = previewIframeVariant(src);
      if (variant !== 'bootstrap-subdomain')
        return { ok: true, status: 'skip', detail: `variant=${variant} — node-fetch path, OOPIF read not used` };
      if (!isCdpEnabled()) return { ok: true, status: 'skip', detail: "CDP disabled (DESIGNER_CDP=''); OOPIF read not probed" };

      // By here CDP is enabled AND the preview is on the bootstrap-subdomain
      // (OOPIF) path — so an attach failure is NOT inconclusive. Production
      // fetchServedHtml uses the same reader and falls back to EMPTY html on
      // attach failure, so snapshot/fetch/iterate would silently get no content.
      // Fail the probe (don't skip) — this is the exact regression it exists to
      // catch (PR #77 Codex P2).
      const reader = await OopifHtmlReader.attach({ preferUrlPrefix: url || null }).catch(() => null);
      if (!reader)
        return { ok: false, detail: 'OOPIF reader attach failed while CDP is enabled on the bootstrap-subdomain path — snapshot/fetch/iterate would get empty HTML' };
      try {
        const html = await reader.readPreviewHtml().catch(() => null);
        if (!html)
          return { ok: false, detail: 'OOPIF read returned null — CDP capture path broken (snapshot/fetch/iterate would get empty HTML)' };
        if (isBootstrapShellHtml(html))
          return { ok: false, detail: `OOPIF read returned the bootstrap loader shell (${html.length}B), not rendered HTML` };
        return { ok: true, detail: `read ${html.length}B of rendered HTML via OOPIF CDP capture` };
      } finally {
        reader.close();
      }
    }
  },
  {
    // Legacy id (kept to avoid resetting the persisted streak counter). The
    // original check asserted a 'You\n' / 'Claude\n' text prefix on each
    // chat turn, but Claude's May 2026 chat redesign removed the in-text
    // speaker label — turns are now distinguished by Claude's intentional
    // `data-index="N"` API on each turn row.
    //
    // It originally matched the SPECIFIC `[data-index="1"]`, but the chat list
    // is VIRTUALIZED: once a conversation grows past the render window, only a
    // sliding window of rows is in the DOM (live-probed indices were 8–15 with
    // 0/1 evicted), so `[data-index="1"]` vanishes even though there are clearly
    // >=2 turns — a recurring false drift, same class as fileListScrape (#69).
    // Assert the COUNT of `[data-index]` rows instead: any window of a >=2-turn
    // chat renders >=2 rows, so count>=2 confirms both "the indexing API exists"
    // and ">=2 turns" without depending on which window is visible. Soft anchor:
    // a 1-turn chat (count 1) is a short conversation, not drift -> skip; a
    // missing API/testid after settle is the real drift signal -> fail.
    id: 'session.chatTurnPrefix',
    category: 'pattern',
    description: 'chat-messages renders >=2 turn rows (data-index API)',
    requires: 'session',
    check: async (b) => {
      const countRows = (): Promise<number> =>
        b
          .evalValue<number>(
            `(() => { const cm = document.querySelector(${JSON.stringify(SEL.messages.chatMessagesContainer)}); if (!cm) return -1; return cm.querySelectorAll('[data-index]').length; })()`
          )
          .catch(() => -1);
      // The chat renders progressively after navigation; settle before judging.
      let n = -1;
      for (let attempt = 0; attempt < 6; attempt++) {
        n = await countRows();
        if (n >= 2) break;
        if (attempt < 5) await sleep(1000);
      }
      if (n >= 2) return { ok: true };
      if (n === 1)
        return { ok: true, status: 'skip', detail: 'only 1 turn row (short conversation) — data-index API present, >=2 unverifiable' };
      if (n === 0) {
        // A design-canvas (.dc.html) session collapses the chat into a closed
        // overlay, so chat-messages renders with 0 turn rows — that's the view,
        // not drift. Skip rather than false-fail (plain-HTML sessions still fail
        // here on real data-index API drift).
        if (await isCanvasEditorView(b))
          return { ok: true, status: 'skip', detail: 'design-canvas view — chat collapsed in a closed overlay; turn rows not rendered (not drift)' };
        return { ok: false, detail: 'chat-messages present but 0 [data-index] rows after ~5s settle — turn-row data-index API drifted' };
      }
      return { ok: false, detail: 'chat-messages testid not found after ~5s settle — testid drifted' };
    }
  },

  // --- share dialog (formerly the Export dropdown; moved under Share ~2026-04-19) ---
  {
    id: 'share.shareButton',
    category: 'share',
    description: 'Share button (opens the dropdown containing handoff/export actions)',
    requires: 'session',
    check: async (b) => ({ ok: await hasButtonMatching(b, /^Share$/) })
  },
  {
    // Id kept (not renamed) to preserve the persisted health-streak counter.
    // Validates the path `designer handoff` actually takes: the same-origin
    // project export endpoint returns a zip. The old check clicked the Share
    // dialog and asserted "claude code" TEXT existed — which false-passed (it
    // stayed green while handoff threw) because it never exercised the real
    // mechanism (PR: handoff Share-redesign rework).
    id: 'share.handoffMenuItem',
    category: 'share',
    description: 'Project export endpoint (/design/v1/design/projects/<id>/download) returns a zip — the path designer handoff fetches',
    requires: 'session',
    check: async (b, url) => {
      const m = url.match(/\/design\/p\/([a-f0-9-]+)/i);
      if (!m || !m[1]) return { ok: true, status: 'skip', detail: 'not in a /design/p/<uuid> session' };
      const projectId = m[1];
      // In-page GET (auth + Cloudflare just work there); read headers, cancel the
      // body so health doesn't pull the multi-MB zip every run. Bounded by an
      // abort deadline so a hung endpoint can't stall the whole health sweep.
      const probeOnce = (): Promise<{ status: number; ct: string; err?: string }> =>
        b
          .evalValue<{ status: number; ct: string; err?: string }>(
            `(async () => {
            const ctrl = new AbortController();
            const to = setTimeout(() => ctrl.abort(), 15000);
            try {
              const r = await fetch('/design/v1/design/projects/' + ${JSON.stringify(projectId)} + '/download', { headers: { Accept: '*/*' }, signal: ctrl.signal });
              const o = { status: r.status, ct: r.headers.get('content-type') || '' };
              try { await r.body.cancel(); } catch {}
              return o;
            } catch (e) { return { status: 0, ct: '', err: String((e && e.message) || e) }; }
            finally { clearTimeout(to); }
          })()`
          )
          .catch(() => ({ status: 0, ct: '', err: 'eval failed' }));
      // Accept zip OR octet-stream: _downloadProjectZip validates by PK magic and
      // ignores content-type, so a 200 octet-stream is a real success — don't go
      // red where the download would succeed (the inverse of the old false-pass).
      const good = (r: { status: number; ct: string }) => r.status === 200 && /(zip|octet-stream)/i.test(r.ct);
      // The export zip is built lazily server-side, so a freshly-touched project's
      // /download can transiently 404 ("export not ready yet") for a few seconds
      // then serve 200 — live-verified 2026-06-30 (the same project 404'd then
      // 200'd minutes apart). A single GET flapped the daily probe red; retry with
      // a bounded settle (same pattern as fileListScrape/chatTurnPrefix) so only a
      // PERSISTENT failure is reported.
      let res = await probeOnce();
      for (let attempt = 0; attempt < 3 && !good(res); attempt++) {
        await sleep(1500);
        res = await probeOnce();
      }
      const ok = good(res);
      return {
        ok,
        detail: ok ? `200 ${res.ct}` : `download endpoint status=${res.status} ct=${res.ct}${res.err ? ' err=' + res.err : ''} (after retries)`
      };
    }
  },

  // --- URL / pattern anchors ---
  {
    id: 'pattern.sessionUrl',
    category: 'pattern',
    description: 'session URL matches /design/p/<uuid>',
    requires: 'any',
    check: async (_b, url) => {
      const inSession = /\/design\/p\/[a-f0-9-]+/i.test(url);
      return { ok: inSession || /claude\.ai\/design\/?(\?|$)/.test(url), detail: `url=${url.slice(0, 100)}` };
    }
  },
  {
    id: 'pattern.fileQueryParam',
    category: 'pattern',
    description: '?file=<name> opens a specific file (URL-based file switching)',
    requires: 'session',
    check: async (_b, url) => {
      const ok = /[?&]file=/.test(url);
      return { ok: true, detail: ok ? 'file param present' : '(no file open — not a regression)' };
    }
  },
  {
    id: 'session.fileListScrape',
    category: 'session',
    description: 'filename text nodes detectable (listFiles scrape still works)',
    requires: 'session',
    check: async (b, url) => {
      const scrape = (): Promise<{ files: string[] }> =>
        b
          .evalValue<{ files: string[] }>(
            `(() => {
            const seen = new Set();
            const files = [];
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
            let node;
            while ((node = walker.nextNode())) {
              const t = (node.textContent || '').trim();
              if (!/^[A-Za-z0-9 _.()\\-]+\\.(html|js|css|jsx|tsx|ts|md|json|svg)$/i.test(t)) continue;
              if (t.length > 80 || seen.has(t)) continue;
              seen.add(t);
              files.push(t);
            }
            return { files };
          })()`
          )
          .catch(() => ({ files: [] as string[] }));

      // Production listFilesDetailed OPENS the "Design Files" panel before
      // scraping; this anchor used to scrape the bare page, so on a project whose
      // panel wasn't already rendered (e.g. a single-file standalone — PR #75/#76
      // hit "Signup Wireframes (standalone)") it found 0 and false-failed while
      // `designer files` worked. Open the panel first so the anchor exercises the
      // same path. Idempotent + best-effort (matches listFilesDetailed).
      // Shared, idempotent opener (file-panel.ts) — identical to the production
      // listFilesDetailed opener so this probe exercises the real path.
      const openFilesPanel = (): Promise<boolean> => b.evalValue<boolean>(OPEN_FILES_PANEL_EXPR).catch(() => false);

      // Open the panel ONCE up front. Clicking it on every retry would toggle an
      // already-open panel closed mid-settle (oscillation — review below-gate);
      // the panel header renders immediately, its file rows a beat later, so one
      // click + the retry-scrape settle covers the late render. The file-list
      // panel renders a few seconds after navigation; scraping immediately races
      // it — the recurring false "0 filenames" the daily probe filed
      // (#64/#65/#68), even though `designer files` and a live scrape find the
      // files once the panel is up. Retry with a bounded settle before concluding
      // a regression.
      await openFilesPanel();
      let files: string[] = [];
      for (let attempt = 0; attempt < 6; attempt++) {
        await sleep(attempt === 0 ? 300 : 700);
        const result = await scrape();
        files = Array.isArray(result.files) ? result.files : [];
        if (files.length > 0) break;
      }
      if (files.length === 0) {
        // With no file open the file-list panel may legitimately be absent — don't
        // hard-fail a soft anchor on an inconclusive state; only a populated
        // session (a file open) is expected to list filenames.
        if (!/[?&]file=/.test(url)) {
          return { ok: true, status: 'skip', detail: 'no file open; file-list panel not rendered — inconclusive' };
        }
        // A design-canvas (.dc.html) session keeps its pages behind a switcher
        // ("<name> / N pages"), not a flat Design Files list — so the flat
        // filename scrape (and `designer files`, which shares it) finds none. That's
        // the canvas surface, which the tool doesn't target; skip rather than
        // false-fail (plain-HTML sessions still fail here on a real scraper regression).
        if (await isCanvasEditorView(b)) {
          return { ok: true, status: 'skip', detail: 'design-canvas view — files are behind the page switcher, not a flat list; flat scrape N/A' };
        }
        return { ok: false, detail: 'found 0 filenames after ~5s settle — scraper regex or DOM layout regressed' };
      }
      // The anchor's invariant is "the scraper still detects filenames" — ≥1
      // filename means the regex + DOM walk work. Whether the URL's ?file=
      // appears among them is NOT a reliable sub-assertion: the panel lists the
      // authoritative project files, and the active ?file= can legitimately be
      // absent from it (a stale/virtual URL file — observed live: ?file=
      // direction-dock.html while the panel lists casefile-*.html). So treat an
      // active-file mismatch as informational, not a failure.
      const match = url.match(/[?&]file=([^&]+)/);
      if (match && match[1]) {
        // Claude Design's URL bar form-encodes spaces as '+'. decodeURIComponent
        // only handles %xx, so normalize '+' → ' ' first before comparing
        // against the scraper's text-node output (which uses real spaces).
        const activeFile = decodeURIComponent(match[1].replace(/\+/g, ' '));
        if (!files.includes(activeFile)) {
          return {
            ok: true,
            detail: `${files.length} file(s) detected; active "${activeFile}" not among them (URL file may be stale/virtual)`
          };
        }
      }
      return { ok: true, detail: `${files.length} file(s) detected` };
    }
  },

  {
    id: 'session.filesSwitcher',
    category: 'session',
    description: 'Pages switcher rows + per-row action menu (the deleteFile path) still resolve',
    requires: 'session',
    // Walks every selector `deleteFile` actuates, and STOPS at the open menu —
    // it never clicks Delete. The daily canary is deliberately single-file
    // (daily-health.yml), so a probe that actually deleted would destroy the
    // surface every other session.* anchor needs.
    //
    // Uses the same expressions production runs (files-switcher.ts) for the
    // file-panel.ts reason: a probe with its own copy of the DOM steps can stay
    // green while production silently no-ops (PR #77).
    check: async (b) => {
      // This anchor runs only in the SESSION phase, i.e. on a project page —
      // where the trigger is a production-required selector. Skipping on its
      // absence let the exact drift this probe exists to catch stay green.
      // Only a page that is not a project surface at all is inconclusive.
      if (!(await hasSelector(b, SEL.files.switcherTrigger))) {
        const onProject = /\/design\/p\/[a-f0-9-]+/i.test(await b.url().catch(() => ''));
        if (!onProject) {
          return { ok: true, status: 'skip', detail: 'not on a project page — no switcher surface to probe' };
        }
        return {
          ok: false,
          detail: `files-switcher trigger (${SEL.files.switcherTrigger}) is absent on a project page — deleteFile and designer_files_delete cannot run`
        };
      }

      let entryCount = -1;
      // Set during cleanup when the probe CHANGED the canary. It overrides the
      // provisional verdict, so a probe that damaged the surface it protects can
      // never report green — hovering a row reveals Duplicate and Rename right
      // beside More actions, and a stray hit makes the single-file canary
      // multi-file, which flakes session.fileListScrape from then on. #F11.
      let mutated: string | null = null;
      let verdict: { ok: boolean; status?: ProbeStatus; detail?: string };

      try {
        if ((await b.evalValue<string>(switcherStateExpr(SEL.files)).catch(() => 'error')) === 'closed') {
          await b.click(SEL.files.switcherTrigger).catch(() => null);
          await sleep(700);
          // Trusted click silently no-ops on some page states; fall back.
          if ((await b.evalValue<string>(switcherStateExpr(SEL.files)).catch(() => 'error')) === 'closed') {
            await b.evalValue(clickTriggerExpr(SEL.files)).catch(() => null);
          }
        }
        await sleep(700);
        const opened = (await b.evalValue<string>(switcherStateExpr(SEL.files)).catch(() => 'error')) || 'error';
        if (opened !== 'open') {
          verdict = { ok: false, detail: `switcher trigger present but would not open (${opened})` };
        } else {
          const read = await b
            .evalValue<{ rows: SwitcherRow[]; reused: boolean }>(readRowsExpr(SEL.files))
            .catch(() => null);
          const rows = read?.rows ?? [];
          entryCount = rows.length;
          if (rows.length === 0) {
            verdict = { ok: true, status: 'skip', detail: 'switcher opened but listed 0 rows — inconclusive' };
          } else {
            verdict = await probeRowMenu(b, entryCount);
          }
        }
      } catch (e) {
        verdict = { ok: false, detail: `switcher probe threw: ${(e as Error).message}` };
      } finally {
        // Cardinality check FIRST, while the popover is still open. Rows only
        // exist while it is open, so a count taken after Escape is 0 for a
        // perfectly healthy canary — comparing two counts measured under
        // different page conditions is exactly the bug this check reports.
        if (entryCount >= 0) {
          const stillOpen = (await b.evalValue<string>(switcherStateExpr(SEL.files)).catch(() => 'error')) === 'open';
          const now = stillOpen
            ? await b
                .evalValue<number>(`document.querySelectorAll(${JSON.stringify(SEL.files.switcherRow)}).length`)
                .catch(() => -1)
            : -1;
          // -1 = not comparable (popover already closed, or read failed).
          // Absence of evidence is not evidence of mutation.
          if (now >= 0 && now !== entryCount) {
            mutated = `probe changed the project's file count (${entryCount} → ${now}) — the canary may need repair`;
          }
        }
        // Clear our own stamps before leaving; the probe must not persist a
        // mutation on someone else's page.
        await b.evalValue(clearStampsExpr()).catch(() => null);
        await b.press('Escape').catch(() => null);
        await sleep(250);
        if ((await b.evalValue<string>(switcherStateExpr(SEL.files)).catch(() => 'error')) === 'open') {
          await b.click(SEL.files.switcherTrigger).catch(() => null);
          await sleep(300);
          if ((await b.evalValue<string>(switcherStateExpr(SEL.files)).catch(() => 'error')) === 'open') {
            await b.evalValue(clickTriggerExpr(SEL.files)).catch(() => null);
          }
        }
        await sleep(250);
      }

      if (mutated) return { ok: false, detail: `${mutated}${verdict.detail ? ` (probe result: ${verdict.detail})` : ''}` };
      return verdict;
    }
  },

  {
    id: 'session.filesSwitcherRestored',
    category: 'session',
    description: 'no delete dialog or open switcher left behind by the switcher probe',
    requires: 'session',
    // Runs right after session.filesSwitcher and proves it cleaned up. Also the
    // consumer that anchors files.confirmDialog / filesLegacy.confirmDialog —
    // asserting the selector resolves to NOTHING is the only non-destructive way
    // to probe a dialog that can only be raised by a real deletion.
    check: async (b) => {
      // A failed read is NOT "clean" — mapping it to false would let this
      // anchor, whose whole job is proving cleanup, assert a page state it
      // never actually read (the PR #77 shape).
      const dialogSel = presenceSelector(SEL.files.confirmDialog, SEL.filesLegacy?.confirmDialog);
      const dialogOpen = await b
        .evalValue<boolean>(dialogPresentExpr(SEL.files, SEL.filesLegacy?.confirmDialog))
        .catch(() => null);
      if (dialogOpen === null) {
        return { ok: true, status: 'skip', detail: 'could not read page state after the switcher probe — inconclusive' };
      }
      if (dialogOpen) {
        return { ok: false, detail: `a confirm dialog is open (${dialogSel}) — the switcher probe left the page mid-flow` };
      }
      const rows = await b
        .evalValue<number>(`document.querySelectorAll(${JSON.stringify(SEL.files.switcherRow)}).length`)
        .catch(() => null);
      if (rows === null) {
        return { ok: true, status: 'skip', detail: 'could not read switcher state after the probe — inconclusive' };
      }
      const stamps = await b
        .evalValue<number>(`document.querySelectorAll('[data-designer-target]').length`)
        .catch(() => null);
      if (stamps !== null && stamps > 0) {
        return { ok: false, detail: `${stamps} designer stamp attribute(s) left on the page after the switcher probe` };
      }
      // A popover left open is a restoration FAILURE, not degraded: `degraded`
      // means "works via a superseded selector", and isWorking() treats it as
      // green. An open popover poisons every anchor that runs after this one,
      // which is exactly what this probe exists to catch. #F10.
      if (rows > 0) {
        return { ok: false, detail: `switcher popover still open (${rows} rows) after probe cleanup — later session anchors will read a dirty page` };
      }
      return { ok: true, detail: 'no dialog, switcher closed' };
    }
  }
];

export async function runHealth(
  browser: Browser,
  opts: { phase?: ProbePhase } = {}
): Promise<ProbeResult[]> {
  const currentUrl = (await browser.url().catch(() => '')) || '';

  // When `opts.phase` is supplied the caller has already navigated to the
  // matching surface — filter strictly by that phase, tag every result with
  // it, and suppress skips (a `home`-only anchor probed during a `session`
  // phase isn't a skip-with-detail, it's just not part of this phase's run).
  // When omitted, fall back to URL-inferred state for back-compat with
  // single-phase callers (cli.ts `designer health`).
  if (opts.phase) {
    const phase = opts.phase;
    const results: ProbeResult[] = [];
    for (const a of UI_ANCHORS) {
      const applicable =
        a.requires === 'any' ||
        (phase === 'home' && a.requires === 'home') ||
        (phase === 'session' && a.requires === 'session');
      if (!applicable) continue;
      const base = {
        id: a.id,
        category: a.category,
        description: a.description,
        requires: a.requires,
        phase
      };
      try {
        const r = await a.check(browser, currentUrl);
        results.push({ ...base, status: r.status ?? (r.ok ? 'ok' : 'fail'), detail: r.detail });
      } catch (e) {
        results.push({ ...base, status: 'fail', detail: `threw: ${(e as Error).message}` });
      }
    }
    return results;
  }

  // Legacy URL-inferred path. Single-phase callers see the same behavior as
  // before — skips emitted for anchors that don't match the inferred state,
  // no `phase` field on results.
  const inSession = /\/design\/p\/[a-f0-9-]+/i.test(currentUrl);
  const onHome = /\/design\/?$/.test(currentUrl) || currentUrl.endsWith('/design');
  const state: 'home' | 'session' | 'other' = inSession ? 'session' : onHome ? 'home' : 'other';

  const results: ProbeResult[] = [];
  for (const a of UI_ANCHORS) {
    const base = { id: a.id, category: a.category, description: a.description, requires: a.requires };
    const applicable =
      a.requires === 'any' ||
      (a.requires === 'home' && state === 'home') ||
      (a.requires === 'session' && state === 'session');
    if (!applicable) {
      results.push({ ...base, status: 'skip', detail: `needs ${a.requires} state; current=${state}` });
      continue;
    }
    try {
      const r = await a.check(browser, currentUrl);
      results.push({ ...base, status: r.status ?? (r.ok ? 'ok' : 'fail'), detail: r.detail });
    } catch (e) {
      results.push({ ...base, status: 'fail', detail: `threw: ${(e as Error).message}` });
    }
  }
  return results;
}
