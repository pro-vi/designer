import type { Selectors } from './selectors.ts';

// The "Pages" files switcher — the surface `deleteFile` drives, the
// `session.filesSwitcher` health anchor probes, and the delete e2e exercises.
//
// ONE source for all three, for the reason file-panel.ts exists: production and
// the probe once drifted apart and the probe went green while production
// silently no-op'd (PR #77). Every expression below is a FUNCTION of the
// selectors block, not a frozen string, so selectors.json stays the live source
// and a drift repair there propagates here without a second edit.
//
// Captured live 2026-07-26 (CDP probe + destructive rehearsal on a throwaway
// project). Two facts drive the whole design:
//
//   1. Rows exist ONLY while the popover is open, so "no rows" is ambiguous
//      between "popover shut" and "project empty" — it can never be read as
//      proof that a delete succeeded (see the cardinality settle in
//      designer-controller.deleteFile).
//   2. The menu items and the confirm dialog's buttons carry NO testids. They
//      are located by exact text INSIDE the page, and the verified node is
//      stamped with a `data-designer-target` attribute so the caller's trusted
//      click lands on the very node the assertion just checked. Verify-here /
//      click-there is the failure mode that deletes the wrong file.
//
// WHY this is shaped this way — including the approaches tried and refuted
// against the live product — is docs/adr/0001-destructive-ui-automation-safety.md.
//
// Actuation rule: expressions here READ and STAMP. The one exception is
// `clickTriggerExpr`, a synthetic OPENER fallback for the popover — needed
// because trusted clicks silently no-op on some page states. A synthetic click
// is never used on a destructive control; those are stamped here and clicked by
// the controller, which proves the resulting state change either way.

/**
 * The confirm dialog's filename echo, as ONE rule shared by the page
 * expression and the Node-side matcher below. It is interpolated into the
 * in-page source and compiled here, so the tests that assert the fail-closed
 * behaviour bind the rule production actually runs. Two copies of this drifted
 * once already (first-match-wins in the page vs exactly-one in Node), which is
 * precisely the probe-green/production-silent split PR #77 warns about.
 */
export const CONFIRM_ECHO_RE_SRC = 'Delete\\s+"([^"]+)"';

/** Attribute the stamping expressions write; the caller clicks the stamped node. */
export const STAMP_ATTR = 'data-designer-target';
export const STAMP_ROW = 'row';
/**
 * Marks a popover subtree this process has already read.
 *
 * Read independence cannot be inferred from "we called close() then open()":
 * if the app reuses the same DOM subtree, or close is a no-op, every later poll
 * re-reads one stale mount and N reads masquerade as N observations. So the
 * reader STAMPS the container it read; finding that stamp still present next
 * time proves the subtree was reused, and the read is reported as such rather
 * than counted.
 */
export const STAMP_MOUNT = 'mount-read';
export const STAMP_MENU_DELETE = 'menu-delete';
export const STAMP_CONFIRM_DELETE = 'confirm-delete';
export const STAMP_CONFIRM_CANCEL = 'confirm-cancel';

/** CSS selector for a stamped node. */
export const stampedSelector = (value: string): string => `[${STAMP_ATTR}="${value}"]`;

/** View-invariant menu/dialog TEXT (not selectors — these elements have no testids). */
export const MENU_ITEM_DELETE = 'Delete';
export const MENU_ITEM_DOWNLOAD = 'Download';
export const DIALOG_BUTTON_CANCEL = 'Cancel';
export const DIALOG_BUTTON_DELETE = 'Delete';
/** Popover chrome — present whether or not the popover lists any rows. */
export const MENU_NEW_BLANK_PAGE = 'New blank page';

export interface SwitcherRow {
  label: string;
  editedText: string | null;
}

/**
 * FALLBACK opener: a synthetic click on the popover trigger.
 *
 * The preferred path is the facade's trusted click, but on some page states
 * that reports success and does nothing at all (live 2026-07-26: selector
 * click, hover-then-click and coordinate click all no-oped while this opened
 * the popover immediately). React delegates handlers from the document root,
 * which is why the synthetic path still lands.
 *
 * Safe here precisely because opening a file list is not destructive. Never use
 * a synthetic click to actuate a destructive control — those are stamped and
 * clicked by the controller, which proves the state change afterwards.
 */
export function clickTriggerExpr(f: Selectors['files']): string {
  return `(() => {
    const t = document.querySelector(${JSON.stringify(f.switcherTrigger)});
    if (!t) return 'no-trigger';
    t.click();
    return 'clicked';
  })()`;
}

/**
 * READ the popover's state — 'open' | 'closed' | 'no-trigger'. It never clicks;
 * the caller opens it (trusted click first, `clickTriggerExpr` as fallback).
 *
 * Two reasons the open is the caller's job. A blind toggle would CLOSE an
 * already-open popover, and during a settle poll an empty list reads as "the
 * file is gone" (the file-panel.ts PR #77 lesson). And how it was opened has
 * consequences: a synthetic open can leave the row menu's `fixed inset-0`
 * dismissal scrim mounted above the later confirm dialog, which the delete flow
 * handles by dismissing the popover before confirming (scrimDismissPointExpr).
 */
export function switcherStateExpr(f: Selectors['files']): string {
  return `(() => {
    const rows = document.querySelectorAll(${JSON.stringify(f.switcherRow)}).length;
    if (rows > 0) return 'open';
    // Open-ness must NOT be inferred from the row count alone: a project whose
    // last file was just deleted has an OPEN popover with zero rows, and calling
    // that 'closed' made the opener toggle it shut and thrash (each cycle costs
    // ~2s of sleeps and never recovers). The popover's own chrome is the signal.
    // Structural first: an expanded trigger is the product's own statement.
    const trigger = document.querySelector(${JSON.stringify(f.switcherTrigger)});
    const expanded = trigger && trigger.getAttribute('aria-expanded');
    if (expanded === 'true') return 'open-empty';
    if (expanded === 'false') return 'closed';
    // Text fallback for a build that exposes no aria-expanded. If the label ever
    // changes this stops matching — which must NOT read as 'closed', because a
    // wrong 'closed' makes the opener toggle a live popover shut. Unknown is the
    // safe value: the settle treats it as inconclusive and the verb collapses to
    // outcome-unknown rather than inventing a verdict.
    const chrome = Array.from(document.querySelectorAll('button')).some(
      (b) => (b.textContent || '').trim() === ${JSON.stringify(MENU_NEW_BLANK_PAGE)}
    );
    if (chrome) return 'open-empty';
    if (!trigger) return 'no-trigger';
    return 'unknown';
  })()`;
}

/**
 * Read the rows as `{label, editedText}`. Row text is "<label>\n<Edited X ago>"
 * — the label carries NO extension, which is why the confirm dialog (the only
 * surface naming the full filename) is the deletion authority, not this list.
 */
export function readRowsExpr(f: Selectors['files']): string {
  return `(() => {
    const nodes = Array.from(document.querySelectorAll(${JSON.stringify(f.switcherRow)}));
    // Independence probe, keyed on the identity of the ROW NODES themselves —
    // not their container. A container stamp is defeated by re-parenting: move
    // the same rows under a new parent and a stale read looks fresh. The nodes
    // are the thing being read, so they carry the mark.
    //
    // Zero rows cannot be marked, and need not be: that read is only meaningful
    // for the last-file case, where the popover is re-opened each poll anyway.
    const reused = nodes.length > 0 && nodes.every((n) => n.getAttribute('${STAMP_ATTR}') === '${STAMP_MOUNT}');
    nodes.forEach((n) => n.setAttribute('${STAMP_ATTR}', '${STAMP_MOUNT}'));
    const rows = nodes.map((r) => {
      const raw = (r.innerText || '').trim();
      const lines = raw.split('\\n').map((s) => s.trim()).filter(Boolean);
      if (lines.length > 1) return { label: lines[0], editedText: lines[1] };
      // Single-line fallback: strip a trailing "Edited … ago" off the blob.
      const m = raw.match(/^(.*?)\\s*(Edited\\s.+\\sago)$/i);
      return m ? { label: m[1].trim(), editedText: m[2] } : { label: raw, editedText: null };
    });
    return { rows, reused };
  })()`;
}

/**
 * Stamp the nth MATCHING row so the caller can hover/click it by a stable
 * selector. Rows are 0-indexed in match order.
 *
 * Deliberately not `:nth-of-type(n)`: that counts siblings of the same TAG, and
 * the popover interleaves the rows with other elements ("New blank page" button,
 * a header div), so `[data-testid=…]:nth-of-type(1)` matches nothing at all.
 * The 2026-07-26 e2e caught exactly that — hover silently found no element and
 * the delete reported 'menu-unavailable'.
 */
export function stampRowExpr(f: Selectors['files'], index: number): string {
  return `(() => {
    document.querySelectorAll('[${STAMP_ATTR}="${STAMP_ROW}"]').forEach((n) => n.removeAttribute('${STAMP_ATTR}'));
    const rows = Array.from(document.querySelectorAll(${JSON.stringify(f.switcherRow)}));
    const row = rows[${index}];
    if (!row) return 'no-row:' + rows.length;
    row.setAttribute('${STAMP_ATTR}', '${STAMP_ROW}');
    return 'stamped';
  })()`;
}

/** Selector for the stamped row (see stampRowExpr). */
export const rowSelector = (): string => stampedSelector(STAMP_ROW);

/**
 * Assert the row-actions menu is open and stamp its "Delete" item.
 * Requires EXACTLY one exact-text match inside an open [role="menu"] — an
 * unscoped text search can reach the project menu's "Delete project" (probe
 * finding), and a loose match would let a future item ("Delete all") through.
 */
export function stampMenuDeleteExpr(): string {
  return `(() => {
    document.querySelectorAll('[${STAMP_ATTR}="${STAMP_MENU_DELETE}"]').forEach((n) => n.removeAttribute('${STAMP_ATTR}'));
    const menus = Array.from(document.querySelectorAll('[role="menu"]'));
    if (menus.length === 0) return 'no-menu';
    const items = menus.flatMap((m) => Array.from(m.querySelectorAll('[role="menuitem"], button')));
    if (items.length === 0) return 'no-items';
    const hits = items.filter((e) => (e.textContent || '').trim() === ${JSON.stringify(MENU_ITEM_DELETE)});
    if (hits.length !== 1) return 'items:' + items.map((e) => (e.textContent || '').trim()).join('|');
    hits[0].setAttribute('${STAMP_ATTR}', '${STAMP_MENU_DELETE}');
    return 'stamped';
  })()`;
}

/**
 * Read the confirm dialog, verify its filename echo, and stamp the button the
 * caller should click. Returns the parsed dialog filename either way so a
 * mismatch can be reported with evidence.
 *
 * The stamp is what makes this safe: the node whose text was just verified is
 * the node that gets clicked. Positional CSS (`button:first-of-type`) would let
 * an added close button turn the REFUSAL path into a deletion.
 */
export function verifyConfirmDialogExpr(f: Selectors['files'], legacyDialog: string | undefined, fileName: string): string {
  const dialogSelectors = [f.confirmDialog, legacyDialog].filter(Boolean) as string[];
  return `(() => {
    const clear = () => document.querySelectorAll('[${STAMP_ATTR}="${STAMP_CONFIRM_DELETE}"], [${STAMP_ATTR}="${STAMP_CONFIRM_CANCEL}"]')
      .forEach((n) => n.removeAttribute('${STAMP_ATTR}'));
    clear();
    const sels = ${JSON.stringify(dialogSelectors)};
    let dialog = null;
    for (const s of sels) { const d = document.querySelector(s); if (d) { dialog = d; break; } }
    if (!dialog) return { found: false, dialogFile: null, matched: false, stamped: null };
    const text = (dialog.innerText || '').trim();
    // Anchored capture — NOT a substring test. \`text.includes(fileName)\` is
    // satisfied by a dialog naming "old-index.html" when the caller asked for
    // "index.html", i.e. it fails OPEN in the one direction that destroys data.
    //
    // EXACTLY one quoted token or null, compiled from the SAME source string as
    // parseConfirmDialog below, so the shipped rule and the tested rule cannot
    // drift (they did once: first-match-wins here vs exactly-one there, which
    // let this path authorize a delete the tests believed was refused).
    const all = Array.from(text.matchAll(new RegExp(${JSON.stringify(CONFIRM_ECHO_RE_SRC)}, 'g')));
    const dialogFile = all.length === 1 ? all[0][1] : null;
    const matched = dialogFile !== null && dialogFile === ${JSON.stringify(fileName)};
    const buttons = Array.from(dialog.querySelectorAll('button'));
    const byText = (t) => buttons.filter((b) => (b.textContent || '').trim() === t);
    const wanted = matched ? ${JSON.stringify(DIALOG_BUTTON_DELETE)} : ${JSON.stringify(DIALOG_BUTTON_CANCEL)};
    const hits = byText(wanted);
    if (hits.length !== 1) {
      return { found: true, dialogFile, matched, stamped: null,
               buttons: buttons.map((b) => (b.textContent || '').trim()) };
    }
    const stamp = matched ? '${STAMP_CONFIRM_DELETE}' : '${STAMP_CONFIRM_CANCEL}';
    hits[0].setAttribute('${STAMP_ATTR}', stamp);
    return { found: true, dialogFile, matched, stamped: stamp };
  })()`;
}

/** Is any confirm dialog still on screen? (post-cancel assertion) */
export function dialogPresentExpr(f: Selectors['files'], legacyDialog: string | undefined): string {
  const sels = [f.confirmDialog, legacyDialog].filter(Boolean) as string[];
  return `(() => ${JSON.stringify(sels)}.some((s) => !!document.querySelector(s)))()`;
}

/**
 * What would a real click at this element's centre actually hit?
 *
 * Returns a STATUS STRING — 'hittable' | 'absent' | 'zero-size' | 'no-hit' |
 * 'covered:<what>' — never a boolean: every one of those values is truthy, so a
 * predicate-shaped name would invite `if (await ...) click()`, which green-lights
 * a destructive click in exactly the states this exists to detect.
 *
 * Radix-style dialogs animate in behind a `fixed inset-0` backdrop, so for a
 * few hundred ms the button exists and is "visible" while the overlay still
 * owns its click point. agent-browser correctly REFUSES to click through that
 * (it reports the covering element rather than dispatching to the wrong
 * target), so the flow must wait for hit-testability rather than for mere
 * presence — polling this is what makes the confirm click deterministic.
 */
export function hitTestStatusExpr(sel: string): string {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return 'absent';
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return 'zero-size';
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (!top) return 'no-hit';
    return (top === el || el.contains(top) || top.contains(el)) ? 'hittable' : 'covered:' + (top.className || top.tagName);
  })()`;
}

/**
 * A viewport point that lands on the switcher popover's dismissal scrim and
 * NOT on the confirm dialog — clicking it closes the popover so the dialog
 * underneath becomes clickable.
 *
 * Why this is needed: the popover has to stay open to read rows, so its
 * `fixed inset-0` dismissal layer (z-3499, pointer-events:auto, empty) is still
 * mounted when the confirm dialog opens *beneath* it at z-3000. Every click on
 * that dialog — facade selector click, agent-browser coordinate click, and raw
 * CDP `Input.dispatchMouseEvent` alike — lands on the scrim instead, so the
 * delete silently never happens. Dismissing the popover first unmounts the
 * scrim and leaves the dialog open and intact (verified live 2026-07-26).
 *
 * Returns null if no covering scrim is present (nothing to dismiss) or if no
 * safe point exists, so the caller can proceed / fail closed rather than
 * clicking somewhere unknown.
 */
export function scrimDismissPointExpr(f: Selectors['files'], legacyDialog: string | undefined): string {
  const sels = [f.confirmDialog, legacyDialog].filter(Boolean) as string[];
  return `(() => {
    let dialog = null;
    for (const s of ${JSON.stringify(sels)}) { const d = document.querySelector(s); if (d) { dialog = d; break; } }
    if (!dialog) return null;
    const dr = dialog.getBoundingClientRect();
    // Corners first — the dialog is centred, so these are the safest points.
    const candidates = [[6, 6], [window.innerWidth - 6, 6], [6, window.innerHeight - 6], [window.innerWidth - 6, window.innerHeight - 6]];
    for (const [x, y] of candidates) {
      if (x >= dr.left && x <= dr.right && y >= dr.top && y <= dr.bottom) continue; // inside the dialog
      const el = document.elementFromPoint(x, y);
      if (!el) continue;
      if (dialog.contains(el)) continue;         // would hit the dialog
      if (!el.matches('div.fixed.inset-0')) continue; // only ever click a scrim
      return { x, y };
    }
    return null;
  })()`;
}

/** Viewport centre of a stamped node, for a coordinate-addressed trusted click. */
export function centerOfExpr(sel: string): string {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`;
}

/** Remove every stamp this module writes (cleanup; never throws). */
export function clearStampsExpr(): string {
  return `(() => { document.querySelectorAll('[${STAMP_ATTR}]').forEach((n) => n.removeAttribute('${STAMP_ATTR}')); return true; })()`;
}

// --- pure matchers (the unit-testable seam) ---

/**
 * Filename → the label the switcher shows: the full extension chain is dropped
 * ("home.dc.html" → "home"). Only the LAST run of extensions is stripped, so a
 * dotted stem ("v1.2-notes.html") keeps its dots.
 */
export function displayLabelFor(filename: string): string {
  if (typeof filename !== 'string') return '';
  return filename.replace(/(\.[A-Za-z0-9]+)+$/, '') || filename;
}

/**
 * Comparison key tolerant of humanized labels: the product may render
 * "delete-test.html" as "Delete Test". Lowercase, separators → space, collapse.
 * The dialog echo stays STRICT — this normalization is for locating a row, never
 * for authorizing a deletion.
 */
export function normalizeLabel(s: string): string {
  if (typeof s !== 'string') return '';
  return s.toLowerCase().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** INDICES of rows whose label matches the filename. 0 = not found, 2+ = ambiguous. */
export function matchingRowIndexes(rows: SwitcherRow[], filename: string): number[] {
  const want = normalizeLabel(displayLabelFor(filename));
  const indexes: number[] = [];
  if (!Array.isArray(rows)) return indexes;
  rows.forEach((r, i) => {
    // The rows come from a page we do not control, so a malformed element must
    // not throw: after an irreversible dispatch a throw escapes the declared
    // result union entirely, losing the snapshot path and the "MAY be deleted"
    // warning. Skip what cannot be read.
    if (!r || typeof r.label !== 'string') return;
    const label = normalizeLabel(r.label);
    // Accept the label with or without an extension chain — some views render
    // the full filename in the row.
    if (label === want || normalizeLabel(displayLabelFor(r.label)) === want) indexes.push(i);
  });
  return indexes;
}

/**
 * Extract the filename the confirm dialog names. Requires exactly one quoted
 * token; anything else is null (fail closed).
 */
export function parseConfirmDialog(text: string): { dialogFile: string | null } {
  if (typeof text !== 'string') return { dialogFile: null };
  const all = [...text.matchAll(new RegExp(CONFIRM_ECHO_RE_SRC, 'g'))];
  return { dialogFile: all.length === 1 ? (all[0]?.[1] ?? null) : null };
}

/**
 * Does the dialog name EXACTLY this file? Strict equality on the parsed capture
 * — never containment, in either direction.
 */
export function dialogNamesFile(text: string, filename: string): boolean {
  const { dialogFile } = parseConfirmDialog(text);
  return dialogFile !== null && dialogFile === filename;
}

// --- settle arithmetic (pure, so the evidence rule is tested not asserted) ---

export type SettleRead =
  | { kind: 'inconclusive' }            // list unreadable / popover shut
  | { kind: 'gone' }                    // row set shrank by exactly one
  | { kind: 'present' }                 // target still listed, full cardinality
  | { kind: 'other' };                  // some other shape

export interface SettleCounters {
  consecutive: number;   // consecutive 'gone' reads -> success at 2
  presentStreak: number; // consecutive 'present' reads (evidence, never a clean verdict)
}

/**
 * Turn a raw settle observation into a SettleRead.
 *
 * This mapping used to live inline in the controller while only the reducer
 * below was tested — so reclassifying an unreadable read as 'present' passed
 * every test while reintroducing a false "nothing was deleted" verdict. The
 * classifier is the half that decides; it belongs next to the reducer.
 *
 * `popoverOpen` distinguishes "the list is empty" from "the list is unreadable":
 * with the last file deleted, zero rows on an OPEN popover is the success
 * observation, not an inconclusive one.
 */
export function classifySettleRead(
  rows: SwitcherRow[] | null,
  fileName: string,
  preCount: number,
  preLabelCount: number,
  popoverOpen: boolean,
  reusedMount = false,
  /**
   * True only when this read followed an actual closed→open transition.
   * Zero-row reads carry no node stamp, so for the last-file case this is the
   * ONLY independence signal: without it, one mounted empty popover supplies
   * two apparently fresh 'gone' observations and success needs no second look.
   */
  remounted = true
): SettleRead {
  // A re-read of a subtree we already counted is not new evidence, whatever it
  // says. This is what makes "two consecutive reads" mean two observations.
  if (reusedMount) return { kind: 'inconclusive' };
  if (rows === null || !Array.isArray(rows)) return { kind: 'inconclusive' };
  if (rows.length === 0) {
    if (!popoverOpen) return { kind: 'inconclusive' };
    // An empty list read off a popover we did not just remount is a re-read of
    // the same mount wearing a different hat.
    if (!remounted) return { kind: 'inconclusive' };
    // Open, empty and freshly mounted: a real observation. Only 'gone' if we
    // expected exactly one file.
    return preCount === 1 && preLabelCount === 1 ? { kind: 'gone' } : { kind: 'other' };
  }
  const stillThere = matchingRowIndexes(rows, fileName).length;
  if (rows.length === preCount - 1 && stillThere === preLabelCount - 1) return { kind: 'gone' };
  if (rows.length === preCount && stillThere === preLabelCount) return { kind: 'present' };
  return { kind: 'other' };
}

/**
 * Fold one settle observation into the counters.
 *
 * Both streaks require TWO CONSECUTIVE supporting reads, and an inconclusive
 * read breaks BOTH. Resetting only the success counter once let a
 * "nothing was deleted" verdict be satisfied by two reads separated by an
 * unreadable one — that verdict has since been removed entirely, because a
 * laggy read cannot support one, but the symmetry is kept: `presentStreak` is
 * evidence for the caller, never a clean claim.
 */
export function foldSettleRead(c: SettleCounters, read: SettleRead): SettleCounters {
  switch (read.kind) {
    case 'gone':
      return { consecutive: c.consecutive + 1, presentStreak: 0 };
    case 'present':
      return { consecutive: 0, presentStreak: c.presentStreak + 1 };
    case 'inconclusive':
    case 'other':
      return { consecutive: 0, presentStreak: 0 };
    default: {
      // Total by construction: an unknown kind returned `undefined`, and the
      // NEXT fold threw a TypeError that escaped the declared result union —
      // after an irreversible click.
      const _exhaustive: never = read;
      void _exhaustive;
      return { consecutive: 0, presentStreak: 0 };
    }
  }
}

/**
 * Should the caller close the popover before re-reading?
 *
 * Pure because the answer is a decision, not an action: treating 'open-empty'
 * as already-closed left the last file's popover mounted across polls, so two
 * reads of one mount looked independent. Any open-ish state must be closed.
 */
export function shouldCloseSwitcher(state: string): boolean {
  return state === 'open' || state === 'open-empty';
}
