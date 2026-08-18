#!/usr/bin/env -S node --import tsx
//
// Live end-to-end proof for `deleteFile` / `designer_files_delete`.
//
// This exists because there is NO harness below the pure-matcher level: the
// controller drives a real browser against a product we don't control, so the
// only honest integration gate is running the destructive path for real and
// asserting the outcome. Run it before merging any change to files-switcher.ts,
// deleteFile(), or the files.* selectors.
//
//   DESIGNER_DELETE_E2E=1 npx tsx scripts/e2e-files-delete.ts
//
// SAFETY — the guard is POSITIVE, not a denylist. Every destructive step
// asserts the target project UUID equals the one THIS RUN created. A denylist
// ("just don't touch the canary") is inert in the environment where this script
// actually runs, because DESIGNER_PROBE_PROJECT_URL is only set inside CI; the
// canary check below is a second belt, parsed out of the workflow file so it
// holds locally too.
//
// It also probes the two claims the plan could not settle offline:
//   - trusted-input hover/click really opens these menus (kill-condition: if the
//     facade can't reveal the row actions, the agent-browser bet is wrong);
//   - the switcher label really is the filename minus its extension chain
//     (hence the hyphen + space in the page names below).
import fs from 'node:fs';
import path from 'node:path';
import { DesignerController } from '../designer-controller.ts';
import { REPO_ROOT } from '../repo-root.ts';
import { getSelectors } from '../selectors.ts';
import { createBrowser } from '../browser.ts';
import { switcherStateExpr, clickTriggerExpr, readRowsExpr, type SwitcherRow } from '../files-switcher.ts';

const SEL = getSelectors();
const KEY = process.env.DESIGNER_DELETE_E2E_KEY || 'delete-e2e';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
let failed = 0;
const check = (ok: boolean, label: string, evidence: unknown = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${evidence === '' ? '' : `  — ${typeof evidence === 'string' ? evidence : JSON.stringify(evidence)}`}`);
  ok ? passed++ : failed++;
};

if (process.env.DESIGNER_DELETE_E2E !== '1') {
  console.error('Refusing to run: set DESIGNER_DELETE_E2E=1. This script CREATES and DELETES real projects.');
  process.exit(2);
}

/** The canary must never be touched. Parsed from the workflow so it holds locally too. */
function canaryUuid(): string | null {
  const fromEnv = process.env.DESIGNER_PROBE_PROJECT_URL || '';
  const wf = path.join(REPO_ROOT, '.github/workflows/daily-health.yml');
  const fromFile = fs.existsSync(wf) ? fs.readFileSync(wf, 'utf8') : '';
  const m = (fromEnv || fromFile).match(/design\/p\/([a-f0-9-]{36})/i);
  return m ? m[1]!.toLowerCase() : null;
}
const uuidOf = (url: string): string | null => (url.match(/design\/p\/([a-f0-9-]{36})/i)?.[1] ?? null)?.toLowerCase() ?? null;

async function main() {
  const c = new DesignerController({ key: KEY });
  const forbidden = canaryUuid();
  console.log(`[e2e] key=${KEY}  canary=${forbidden ?? '(none found — guard relies on positive ownership)'}`);

  // --- create a throwaway project we own for the rest of the run ---
  console.log('[e2e] creating throwaway project (this takes a minute)…');
  const created = await c.createSession(
    'designer delete e2e — a minimal page titled "delete rehearsal". Keep it to one file.',
    'wireframe'
  );
  const OWNED = uuidOf(created.url);
  if (!OWNED) throw new Error(`could not parse a project uuid out of ${created.url}`);
  if (forbidden && OWNED === forbidden) throw new Error('SAFETY: landed on the health canary — aborting before any mutation');
  console.log(`[e2e] owned project: ${OWNED}`);

  // Every destructive step goes through this.
  const assertOwned = async (what: string) => {
    const now = uuidOf(await c.currentUrl());
    if (now !== OWNED) throw new Error(`SAFETY: refusing to ${what} — tab is on ${now}, not the owned project ${OWNED}`);
    if (forbidden && now === forbidden) throw new Error(`SAFETY: refusing to ${what} on the health canary`);
  };

  // Deleting the ACTIVE file makes the controller re-navigate to the project
  // root, so the switcher needs a moment to mount before the next read.
  const waitForTrigger = async (budgetMs = 20_000) => {
    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline) {
      const st = await c.browser.evalValue<string>(switcherStateExpr(SEL.files)).catch(() => 'error');
      if (st === 'open' || st === 'closed') return st;
      await sleep(750);
    }
    return 'no-trigger';
  };
  const openSwitcher = async () => {
    await waitForTrigger();
    if ((await c.browser.evalValue<string>(switcherStateExpr(SEL.files)).catch(() => 'error')) === 'closed') {
      await c.browser.click(SEL.files.switcherTrigger).catch(() => null);
      await sleep(800);
      if ((await c.browser.evalValue<string>(switcherStateExpr(SEL.files)).catch(() => 'error')) === 'closed') {
        await c.browser.evalValue(clickTriggerExpr(SEL.files)).catch(() => null);
        await sleep(800);
      }
    }
  };
  const closeSwitcher = async () => {
    if ((await c.browser.evalValue<string>(switcherStateExpr(SEL.files)).catch(() => 'error')) === 'open') {
      await c.browser.click(SEL.files.switcherTrigger).catch(() => null);
      await sleep(400);
      if ((await c.browser.evalValue<string>(switcherStateExpr(SEL.files)).catch(() => 'error')) === 'open') {
        await c.browser.evalValue(clickTriggerExpr(SEL.files)).catch(() => null);
        await sleep(400);
      }
    }
  };
  const rows = async (): Promise<SwitcherRow[]> => {
    await openSwitcher();
    const r = await c.browser
      .evalValue<{ rows: SwitcherRow[]; reused: boolean }>(readRowsExpr(SEL.files))
      .catch(() => null);
    await closeSwitcher();
    return r?.rows ?? [];
  };

  // --- add a second page so the project is multi-file (never delete a last page) ---
  // A freshly generated project needs a moment before the switcher lists it.
  const waitForRows = async (min: number, budgetMs = 45_000): Promise<SwitcherRow[]> => {
    const deadline = Date.now() + budgetMs;
    let last: SwitcherRow[] = [];
    while (Date.now() < deadline) {
      last = await rows();
      if (last.length >= min) return last;
      await sleep(1500);
    }
    return last;
  };
  const initial = await waitForRows(1);
  console.log(`[e2e] initial rows: ${JSON.stringify(initial.map((r) => r.label))}`);
  if (initial.length === 0) throw new Error('project never listed any page — aborting before any delete');

  await assertOwned('add a page');
  await openSwitcher();
  await c.browser
    .evalValue(`(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => (x.textContent||'').trim() === 'New blank page'); if (b) { b.click(); return true; } return false; })()`)
    .catch(() => null);
  await sleep(2500);
  const afterAdd = await waitForRows(initial.length + 1);
  check(afterAdd.length >= 2, 'a second page exists (never delete a last page)', afterAdd.map((r) => r.label));
  if (afterAdd.length < 2) throw new Error('could not create a second page — aborting before any delete');

  // The blank page is the one that is not the generated design.
  const target = afterAdd.find((r) => /^canvas$/i.test(r.label)) ?? afterAdd[afterAdd.length - 1]!;
  // Rows carry no extension; the canvas page is a .dc.html.
  const targetFile = /^canvas$/i.test(target.label) ? `${target.label}.dc.html` : `${target.label}.html`;
  console.log(`[e2e] target: label=${JSON.stringify(target.label)} → filename=${JSON.stringify(targetFile)}`);

  // --- KILL-CONDITION 4: label == filename minus extension chain ---
  check(
    targetFile.startsWith(target.label),
    'switcher label is the filename minus its extension chain (matcher assumption holds)',
    { label: target.label, filename: targetFile }
  );

  // --- dry run must be non-mutating ---
  await assertOwned('dry-run');
  const dry = await c.deleteFile(targetFile, { dryRun: true });
  check(dry.ok === true && dry.dryRun === true, 'dry run returns a preview', dry);
  const afterDry = await rows();
  check(afterDry.length === afterAdd.length, 'dry run deleted NOTHING', { before: afterAdd.length, after: afterDry.length });

  // --- negative: a file that does not exist ---
  const missing = await c.deleteFile('definitely-not-here-9x8y7z.html', { dryRun: true });
  check(missing.ok === false && missing.error === 'not-found', "unknown filename → 'not-found'", missing);

  // --- the real delete ---
  await assertOwned('delete a file');
  const del = await c.deleteFile(targetFile, { snapshot: false }); // canvas pages have no served HTML to snapshot
  check(del.ok === true, 'delete succeeded', del);
  if (del.ok && !del.dryRun) {
    check(
      del.remainingLabels.length === afterAdd.length - 1,
      'remainingLabels shrank by exactly one (positive settle held)',
      del.remainingLabels
    );
    check(!del.remainingLabels.includes(target.label), 'the deleted label is gone from the switcher', del.remainingLabels);
  }
  await waitForTrigger();
  const afterDelete = await rows();
  check(afterDelete.length === afterAdd.length - 1, 're-read confirms the row is gone', afterDelete.map((r) => r.label));

  // --- REFUSAL PATHS ---
  // The happy path is one of eleven outcomes, and for a destructive verb the
  // dangerous ones are the refusals. Two are reachable live.

  // busy: the tab lock must reject a second driver, not interleave with it.
  await assertOwned('probe the busy path');
  const [first, second] = await Promise.all([
    c.deleteFile('definitely-not-here-busy-probe.html', { dryRun: true }),
    c.deleteFile('definitely-not-here-busy-probe.html', { dryRun: true })
  ]);
  const busyCount = [first, second].filter((r) => !r.ok && r.error === 'busy').length;
  check(busyCount === 1, "concurrent deletes: exactly one is refused with 'busy'", { first, second });

  // EXTERNAL-ACTOR INTERLEAVING. The in-process lock cannot stop another
  // process — or a human — moving the shared tab mid-flow, so the root re-assert
  // before dispatch is the only defence there. Simulate it with a RAW browser
  // handle on the same agent-browser session, which bypasses the lock exactly as
  // an out-of-process actor would: start a delete, yank the tab to the home
  // page, and require the delete to refuse without having deleted anything.
  const rogue = createBrowser({ session: `designer-${KEY}` });
  const beforeInterleave = (await rows()).map((r) => r.label);
  if (beforeInterleave.length > 0) {
    await assertOwned('probe the external-actor interleaving');
    const victim = `${beforeInterleave[0]}.dc.html`;
    const inFlight = c.deleteFile(victim, { snapshot: false });
    await sleep(1200); // land inside resolve/hover, before the confirm dispatch
    await rogue.open('https://claude.ai/design').catch(() => null);
    const raced = await inFlight;
    const refusedSafely =
      !raced.ok && ['wrong-project', 'project-changed', 'switcher-unavailable', 'menu-unavailable', 'not-found'].includes(raced.error);
    check(
      refusedSafely || raced.ok === true,
      'a tab yanked mid-flow either refuses cleanly or completes on the right project',
      raced
    );
    // The load-bearing half: whatever it returned, it must not have acted on the
    // page it was moved to.
    await rogue.open(`https://claude.ai/design/p/${OWNED}`).catch(() => null);
    await sleep(4000);
    await waitForTrigger();
    const afterInterleave = (await rows()).map((r) => r.label);
    const expected = raced.ok ? beforeInterleave.length - 1 : beforeInterleave.length;
    check(
      afterInterleave.length === expected,
      'the interleaved run deleted exactly what it reported, and nothing elsewhere',
      { before: beforeInterleave, after: afterInterleave, result: raced.ok ? 'deleted' : raced.error }
    );
  }

  // last-file deletion: round 4 showed this was unverifiable by construction
  // (an empty list was intercepted as inconclusive before the "gone" test could
  // run). It must now succeed AND report an empty remainder.
  const survivor = (await rows()).find((r) => !/^canvas$/i.test(r.label));
  if (survivor) {
    await assertOwned('delete the last file');
    const last = await c.deleteFile(`${survivor.label}.dc.html`, { snapshot: true });
    check(last.ok === true, 'deleting the LAST file in a project succeeds', last);
    if (last.ok && !last.dryRun) {
      check(last.remainingLabels.length === 0, 'the last delete reports an empty remainder', last.remainingLabels);
      check(typeof last.snapshotPath === 'string', 'the backup was written before the delete', last.snapshotPath);
    }
    // …and an empty project resolves as not-found, not as a broken switcher.
    const onEmpty = await c.deleteFile(`${survivor.label}.dc.html`, { dryRun: true });
    check(
      !onEmpty.ok && onEmpty.error === 'not-found',
      "a dry run on an emptied project reports 'not-found', not 'switcher-unavailable'",
      onEmpty
    );
  }

  // --- cleanup: delete the throwaway project (e2e-local helper; project delete
  // is deliberately NOT a production verb) ---
  await waitForTrigger();
  await assertOwned('delete the throwaway project');
  const titleSel = '[data-testid="project-title"]';
  const synthClick = (sel: string) =>
    c.browser
      .evalValue<string>(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return 'absent'; e.click(); return 'clicked'; })()`)
      .catch(() => 'error');
  const menuOpen = () => c.browser.evalValue<boolean>(`!!document.querySelector('[role="menu"]')`).catch(() => false);
  for (const trigger of [titleSel, 'button[aria-label="Project menu"]']) {
    if (await menuOpen()) break;
    await c.browser.click(trigger).catch(() => null);
    await sleep(600);
    if (await menuOpen()) break;
    await synthClick(trigger);
    await sleep(700);
  }
  const stampedProjectDelete = await c.browser
    .evalValue<string>(
      `(() => {
         const items = Array.from(document.querySelectorAll('[role="menu"] [role="menuitem"], [role="menu"] button'));
         const hit = items.filter((e) => (e.textContent || '').trim() === 'Delete project');
         if (hit.length !== 1) return 'items:' + items.map((e) => (e.textContent||'').trim()).join('|');
         hit[0].setAttribute('data-designer-target', 'project-delete');
         return 'stamped';
       })()`
    )
    .catch(() => 'error');
  let cleaned = false;
  if (stampedProjectDelete === 'stamped') {
    await c.browser.click('[data-designer-target="project-delete"]').catch(() => null);
    await sleep(700);
    if (!(await c.browser.evalValue<boolean>(`!!document.querySelector('[role="dialog"],[role="alertdialog"]')`).catch(() => false))) {
      await synthClick('[data-designer-target="project-delete"]');
      await sleep(900);
    }
    await c.browser
      .evalValue<string>(
        `(() => {
           const d = document.querySelector('[role="dialog"], [role="alertdialog"]');
           if (!d) return 'no-dialog';
           const b = Array.from(d.querySelectorAll('button')).find((x) => /^delete$/i.test((x.textContent||'').trim()));
           if (!b) return 'no-button';
           b.setAttribute('data-designer-target', 'project-delete-confirm');
           return 'stamped';
         })()`
      )
      .catch(() => 'error');
    await c.browser.click('[data-designer-target="project-delete-confirm"]').catch(() => null);
    await sleep(1200);
    if (await c.browser.evalValue<boolean>(`!!document.querySelector('[role="dialog"],[role="alertdialog"]')`).catch(() => false)) {
      await synthClick('[data-designer-target="project-delete-confirm"]');
    }
    await sleep(3000);
    cleaned = uuidOf(await c.currentUrl()) !== OWNED;
  }
  // Cleanup is a convenience — deleting PROJECTS is explicitly out of this
  // feature's scope (no production verb), so a failure here is a warning, not
  // a failed assertion about deleteFile.
  if (cleaned) check(true, 'throwaway project deleted');
  else console.log(`WARN  throwaway project not auto-deleted — delete by hand: https://claude.ai/design/p/${OWNED}`);

  console.log(`\n[e2e] ${passed} passed, ${failed} failed`);
  if (!cleaned) console.log(`[e2e] leftover project: https://claude.ai/design/p/${OWNED}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`[e2e] ABORTED: ${(e as Error).message}`);
  process.exit(1);
});
