---
title: designer_files_delete — agent-driven deletion of outdated project files
objective: Let an agent (via MCP) or a human (via CLI) safely delete a named file from a claude.ai/design project, so messy multi-file projects can be cleaned without hand-driving the UI
type: feat
status: completed
date: 2026-07-26
origin: live-probe session 2026-07-26 (throwaway destructive rehearsal) + 3-lane repo exploration + 3-lane adversarial verification (v2 incorporates all verified findings)
---

# designer_files_delete — Deep blueprint (v2, post-adversarial-review)

> **Shipped, with corrections.** The result union below is HISTORICAL: five
> review rounds against the live product removed `still-present` and
> `unverified` in favour of a single post-dispatch `outcome-unknown`, because a
> laggy file-list scrape cannot prove non-deletion. The shipped contract is in
> `DeleteFileResult` (designer-controller.ts) and the reasoning in
> `docs/adr/0001-destructive-ui-automation-safety.md`. Read those, not this,
> for current behaviour.

## Ground truth (live-probe, 2026-07-26, destructively verified on a throwaway project)

- `[data-testid="files-switcher-trigger"]` opens the "Pages" popover; each file renders as `[data-testid="files-switcher-row"]`. Row text = display label + "Edited X ago" — **no extension** ("index", "Delete Test"). Rows exist **only while the popover is open**.
- Hovering a row (real mouse only) reveals `button[aria-label="Duplicate"|"Rename"|"More actions"]`.
- "More actions" opens a `role=menu` with exactly **Download** and **Delete** (no testids observed on items — text-identified).
- Delete raises a dialog naming the full filename: `Delete file? Delete "Canvas.dc.html"? Cancel / Delete`. Post-confirm the row is gone.
- Synthetic `element.click()` silently no-ops on some of these menus; agent-browser trusted input works everywhere.
- The switcher is the **unified** file surface: present in both the `.dc.html` canvas view and the plain-HTML canary. The legacy "Design Files" flat panel (`file-panel.ts`) is plain-HTML-only — **the two surfaces are different and must never be mixed in one flow**.
- Project-title menu carries Rename / Duplicate project / Delete project (production scope: none; e2e cleanup only).

## Architecture Decision

**Approach:** Drive the flow through the `Browser` facade (agent-browser trusted input), extended with `hover()`. All DOM expressions are **functions parameterized by `Selectors['files']`** in a new `files-switcher.ts`, consumed identically by production, the health anchor, and the e2e. `deleteFile()` on `DesignerController` returns a discriminated union and owns **both** dry-run and destructive modes (one resolution path). Safety keystones, in order: root-pin (never actuate off the bound project), refuse-on-ambiguity (before any hover), **verify-and-stamp** (one page expression asserts the dialog's filename echo and stamps the verified button node; the facade clicks only the stamped selector), snapshot-as-precondition, and a **positive cardinality settle** (row set shrinks by exactly one; empty reads are inconclusive, never success).

**Rationale (consistency > simplicity > maintainability > testability):** agent-browser ships the trusted `hover`/`click`/`find` primitives the probe proved necessary — a raw-CDP input driver (rejected) duplicates that, adds `isCdpEnabled` gate obligations, and contradicts the per-operation-CDP house style. Verify-and-stamp removes the verify-A/click-B gap without depending on product attributes the menus don't carry. One `deleteFile` code path for dry-run and delete is what makes `confirm:false` a truthful preview (the adversarial pass proved a `listFilesDetailed`-based preview lies on canvas projects and disagrees on names).

**Trade-offs accepted:** per-step child-process spawns (facade convention; `run(['find',…])`/batch is the fallback if hover state proves unstable across spawns — decided in U4 against the live surface); stamping writes a transient `data-designer-*` attribute into the page (a DOM write, not a synthetic click — removed on completion).

**ADR-precursor:** decision = "trusted input + parameterized shared expressions + verify-and-stamp click binding; synthetic clicks banned for destructive flows." Rejected: raw-CDP input driver (duplicative, gate-hostile); `_clickButtonByText` reuse (synthetic + unscoped — can reach "Delete project"); `listFilesDetailed`-based dry-run (different surface, different name shape, empty on canvas). The `DESIGNER_CDP=''` compatibility argument from v1 is **struck** — `_ensureInSession → ensureReady` calls `ensureCdpUp` ungated (`designer-controller.ts:499`), so the verb hard-fails under the opt-out like `iterate`/`handoff`; the decision rests on the probe-proven synthetic-click failure alone.

## Result union (single source, used by controller, MCP, CLI)

```
DeleteFileResult =
  | { ok: true;  file; deletedLabel; remainingLabels: string[]; snapshotPath: string | null; activeFileReset: boolean }
  | { ok: false; error: 'busy' | 'wrong-project' | 'switcher-unavailable' | 'not-found' | 'ambiguous'
                       | 'menu-unavailable' | 'confirm-mismatch' | 'dialog-stuck' | 'snapshot-failed'
                       | 'project-changed' | 'still-present' | 'unverified';
      file; detail?: string; candidates?: string[]; dialogFile?: string | null; snapshotPath?: string | null }
Dry-run: { ok: true; dryRun: true; wouldDelete: string | null; ambiguous: boolean; rows: string[] }
```

## High-Level Technical Design

```
deleteFile(fileName, {dryRun?, snapshot? = true})

acquire single-flight gate (shared with iterate/ask)   ──held──▶ 'busy'
_ensureInSession()                                     // NO pin semantics — returns early on ANY /design/p/ tab
ROOT-PIN (mandatory, copied from listFilesDetailed:1113-1126 / handoff:1564):
  targetRoot = getSession(key).designUrl.split('?')[0]  (throw precondition if absent)
  if currentUrl().split('?')[0] !== targetRoot → openGuarded(targetRoot) + waitLoad + settle
  re-verify; still off-project → 'wrong-project'
capture activeFileParam = decodeURIComponent((?file= of current URL).replace(/\+/g,' '))   // BEFORE any mutation
resolve (shared by dry-run and delete):
  open switcher (openSwitcherExpr(SEL.files)); rows = readRowsExpr → [{label, editedText}]
  matches = matchRows(rows, fileName)          // normalized-key compare (see U2)
  0 → close popover → 'not-found' (rows in detail)     2+ → close popover → 'ambiguous' + candidates
dryRun → close popover → return {dryRun report}        // stops here; provably no hover
snapshot (INSIDE the gate): fetchFile(fileName); require ok && bytes>0 && write ok
  else 'snapshot-failed' (delete NOT attempted; caller may retry with snapshot:false)
  re-run ROOT-PIN + resolve after snapshot (fetchFile may navigate)
preCount = rows.length; preLabelCount = matches.length  // == 1 here
hover matched row (browser.hover on nth-row selector) → 'More actions' revealed (1 retry) → real click
assert menu open; stamp the menuitem whose exact text == 'Delete' within the OPEN menu
  (stampMenuDeleteExpr: verify + set data-designer-target="menu-delete" on that node)
  missing/multiple → Escape → 'menu-unavailable'
click '[data-designer-target="menu-delete"]' (facade, trusted)
verify-and-stamp dialog (verifyConfirmDialogExpr):
  find SEL.files.confirmDialog; extract quoted name via anchored /Delete\s+"([^"]+)"\?/ (exactly one capture)
  capture === fileName (strict ===)?
    no  → stamp cancel button → click it → assert dialog gone (else Escape; still there → 'dialog-stuck')
          → 'confirm-mismatch' + dialogFile
    yes → stamp delete button (same expression, same node tree) → ROOT re-assert → click stamped delete
SETTLE (positive, cardinality-based; absolute cap 15s):
  each poll: assert root unchanged ('project-changed' on mismatch); ensure popover open (re-open if closed);
  read rows. rows.length === 0 OR popover unopenable → INCONCLUSIVE (counts toward neither)
  success read: rows.length === preCount - 1 AND matchRows(rows,fileName).length === preLabelCount - 1
  2 consecutive success reads → confirmed
  cap with target still present at preLabelCount → 'still-present'
  cap with only inconclusive reads → 'unverified'   // NEVER ok:true from empty reads
post-success:
  if activeFileParam === fileName:
    openGuarded(targetRoot); upsertSession(key, designUrl/lastUrl stripped of ?file=)   // else stored session resumes to a dead file
  appendHistory({kind:'file-delete', file, at}); remove stamp attributes; close popover
  → { ok:true, remainingLabels (from the last good read), snapshotPath, activeFileReset }
finally: release gate; best-effort Escape-close of any open menu/popover/dialog
```

Named invariants (U4 Verification): `_exclusiveOp !== null` iff an exclusive verb is mid-flight (release in `finally`); no actuation occurs unless `currentUrl().split('?')[0] === targetRoot` (re-asserted immediately before the confirm click and on every settle poll); a `confirm-mismatch` return implies the dialog was dismissed (else `dialog-stuck`); `{ok:true}` implies ≥2 consecutive positive-cardinality reads — never an empty read; `snapshot:true` (default) and no snapshot file ⇒ nothing was deleted.

## Implementation Units

### U1. `files` selector block

- **Goal:** Centralize the new DOM selectors; satisfy the real contract tests.
- **Requirements:** R1
- **Dependencies:** None
- **Files:** Modify: `selectors.json`, `selectors.ts`, `tests/health-apparatus.contract.test.mjs` (exemption lists only)
- **Approach:** `files` block: `switcherTrigger`, `switcherRow`, `rowMoreActions` (`button[aria-label="More actions"]`), `confirmDialog` — **single-branch** `[role="dialog"]`; put `[role="alertdialog"]` in a `filesLegacy` block resolved via `orderedBranches()` (comma-OR contract test at `tests/health-apparatus.contract.test.mjs:539` bans multi-branch values). **No `rowRename`/`rowDuplicate`** (dead selectors fail the anchored-or-exempt test at `:551`; they arrive with the follow-up verbs). `confirmDialog` is consumed by U9's absent-after-Escape assertion (anchoring it) — else add to `UNANCHORED_OK:523` with rationale. Menu items and dialog buttons carry no product testids (probe-verified) — they are **not** selectors; they're located by the verify-and-stamp expressions (U2) and clicked via stamped `data-designer-target` selectors.
- **Patterns to follow:** `homeLegacy`/`composerLegacy` block shape (`selectors.ts:88-102`).
- **Test scenarios:** contract tests stay green: no comma-OR values (`:539`), every selector anchored or exempt (`:551`). *Test expectation beyond that: none — data.*
- **Verification:** `npm run check` + `npm test` green with the two named contract tests passing.

### U2. `files-switcher.ts` — parameterized expressions + pure matchers (+ tests + glob)

- **Goal:** One seam production/anchor/e2e all execute; the only unit-testable logic. Owns its test-glob edit so it verifies standalone.
- **Requirements:** R1, R2, R4
- **Dependencies:** U1
- **Files:** Create: `files-switcher.ts` (repo root — tsconfig includes only root+scripts), `tests/files-switcher.matchers.test.mjs`; Modify: `package.json` (append `tests/files-switcher.*.test.mjs` to the **`node --import tsx --test`** command — not the bare `node --test` one)
- **Approach:** Export **functions, not consts** — `openSwitcherExpr(f: Selectors['files'])`, `readRowsExpr(f)`, `stampMenuDeleteExpr()`, `verifyConfirmDialogExpr(f, fileName, mode: 'delete'|'cancel')`, `closeSwitcherExpr(f)` — selector values interpolated via `JSON.stringify` (the `designer-controller.ts:447` pattern), so `selectors.json` stays the live source and the literals cannot drift apart from it. Row shape fixed: `Array<{label: string; editedText: string | null}>`; extraction rule: split `innerText` on newline, `label = lines[0].trim()`, `editedText = lines[1] ?? null`; single-line fallback strips trailing `/\s*Edited\s.+\sago$/i`. Pure functions: `displayLabelFor(filename)` (strip full extension chain), `normalizeLabel(s)` (lowercase, `[-_]+`→space, collapse whitespace — tolerates humanized labels), `matchRows(rows, filename)` (normalized compare; returns indices), `parseConfirmDialog(text)` → `{dialogFile: string | null}` via anchored `/Delete\s+"([^"]+)"\?/` requiring exactly one match, `dialogNamesFile(text, filename)` → strict `===` on the parsed capture. Only view-invariant TEXT literals ('Download', 'Delete', 'Cancel') live here.
- **Patterns to follow:** `file-panel.ts` (shared-seam rationale, PR #77); pure-decision testing (`cdp-dialog.ts:32`).
- **Test scenarios:** *Happy:* `displayLabelFor("a.dc.html")==="a"`; `dialogNamesFile('Delete "Canvas.dc.html"?', "Canvas.dc.html")===true`. *Edge (both containment directions — the fail-open trap):* `dialogNamesFile('Delete "old-index.html"?', "index.html")===false` AND `dialogNamesFile('Delete "index.html"?', "old-index.html")===false`; two same-label files → `matchRows` returns both; "index" vs "index2" no cross-match; humanized label "Delete Test" matches `delete-test.dc.html` via `normalizeLabel`; single-line row text parses. *Error:* no quoted token → `dialogFile:null` (fail closed); two quoted tokens → null.
- **Verification:** new test file visibly executes under `npm test` and passes.

### U3. Facade: `hover()` + `find()`

- **Goal:** Trusted input primitives the flow needs and the facade lacks.
- **Requirements:** R3
- **Dependencies:** None
- **Files:** Modify: `browser.ts`
- **Approach:** `hover(sel)` → `run(['hover', sel])`; `find(locator, value, action, extra?)` → `run(['find', …])` (row-by-index and role-scoped fallbacks). Doc-comment: destructive flows use facade input only; synthetic `evalValue` clicks are banned there (probe-proven silent no-op) — stamping attributes via `evalValue` is permitted (DOM write, not a click).
- **Patterns to follow:** `browser.ts:158-166`.
- **Test scenarios:** none — thin CLI mapping (house convention).
- **Verification:** `npm run check`; exercised live by U7.

### U4. `DesignerController.deleteFile()` + single-flight gate

- **Goal:** The verb, both modes, all safety keystones.
- **Requirements:** R4, R5, R6, R8
- **Dependencies:** U1, U2, U3
- **Files:** Modify: `designer-controller.ts`
- **Approach:** Per High-Level Design, with these bindings: gate = private `_exclusiveOp: string | null` + `_withExclusive(name, fn)` (release in `finally`) wrapping `iterate`/`ask`/`deleteFile` — `deleteFile` returns `'busy'`; `iterate`/`ask` throw a named Error (their precondition style). Root-pin is an explicit block (the flow's second step) — `_ensureInSession()` alone is **not** a pin (it returns early on any `/design/p/` tab). Row hover targets the matched index via an nth-child selector on `SEL.files.switcherRow` (or `find nth` fallback). Snapshot (default on) runs inside the gate via `fetchFile` and **blocks** the delete on failure (`'snapshot-failed'`); after it, root-pin + resolve re-run. `remainingLabels` come from the last positive settle read only. Active-file case: compare `activeFileParam` (captured pre-mutation, `+`/URI-decoded) to `fileName`; on match, `openGuarded(targetRoot)` **and** `upsertSession` with `?file=` stripped from `designUrl`/`lastUrl` (a stale stored URL otherwise resumes every future session onto a dead file). `appendHistory({kind:'file-delete'})`.
- **Patterns to follow:** pin `designer-controller.ts:1113-1126` + `:1564-1565`; union style `openFile:1181` (cited alone — `fetchFile` is not a discriminated union; `deleteFile` deliberately tightens `error` to a literal union, a strengthening not an existing convention); history `:988,1602`; absolute-cap settle discipline `run-state.ts:333-345`.
- **Test scenarios:** logic carried by U2's pure tests (no controller harness exists — accepted, compensated by U7). *Integration (live, U7):* happy, dry-run non-mutation, `not-found`, `ambiguous`, `busy` during iterate, active-file reset.
- **Verification:** the five named invariants above; `npm run check`.

### U5. MCP tool `designer_files_delete`

- **Goal:** Agent surface; dry-run default; first annotated destructive tool.
- **Requirements:** R7, R8
- **Dependencies:** U4
- **Files:** Modify: `mcp-server.ts`
- **Approach:** Register after `designer_list`. `inputSchema: { key, filename, confirm (default false), snapshot (default true) }`. Handler is a thin passthrough: `confirm:false` → `deleteFile(filename, {dryRun:true})`; `confirm:true` → `deleteFile(filename, {snapshot})`. **No `listFilesDetailed` anywhere in this tool** — preview and action share one code path by construction. `annotations: {destructiveHint: true, idempotentHint: false, readOnlyHint: false}`. Description (house long-contract prose) states: dry-run default; the dialog-echo guarantee; `remainingLabels` are switcher display labels, not filenames; snapshot-blocking semantics and the `snapshot:false` override; "re-check with confirm:false after errors".
- **Patterns to follow:** `mcp-server.ts:89-116` result reshaping; `:118-154` precondition-return style.
- **Test scenarios:** live via U7 (dry-run non-mutation asserted; ambiguous refusal asserted).
- **Verification:** `designer mcp serve` lists seven tools; dry-run provably non-mutating.

### U6. CLI verb `files-delete`

- **Goal:** Human surface, consent-gated, correct exit codes.
- **Requirements:** R7
- **Dependencies:** U4
- **Files:** Modify: `cli.ts`
- **Approach:** `case 'files-delete'`: filename from `flags._`; **`--yes` parser collision handled** — if `typeof flags.yes === 'string'`, push that value back onto `flags._` before joining (the hand-rolled parser eats the following positional). Empty filename → Usage error (exit 1). No `--yes` → print dry-run report, exit 0. With `--yes` → run delete, `process.exitCode = r.ok ? 0 : 1`. Register in all three surfaces: switch case, `TOP_HELP` destructive line, `HELP['files-delete']` (document filename-before-flag ordering). Add a real parity test to `tests/cli-metadata.test.mjs`: grep `cli.ts` for `case '<verb>':` labels, assert each appears in `TOP_HELP` and as a `HELP` key.
- **Patterns to follow:** `cli.ts:159-165` (`open-file`), `:148-158` (`files`).
- **Test scenarios:** parity test above (now genuinely gates the new verb); `--yes preceding filename` works; string-valued `--yes` handled.
- **Verification:** `designer files-delete --help` renders; parity test green.

### U7. Live e2e script (throwaway rehearsal, scripted)

- **Goal:** The destructive path proven end-to-end on the real product — the integration gate substituting for the missing harness.
- **Requirements:** R6, R9
- **Dependencies:** U4, U5, U6
- **Files:** Create: `scripts/e2e-files-delete.ts`
- **Approach:** Gated `DESIGNER_DELETE_E2E=1`. **Positive ownership guard:** the script only ever deletes (files or project) under the project UUID **it created this run** — captured from its own create step; additionally parses the canary URL out of `.github/workflows/daily-health.yml` and refuses it, and refuses single-file projects. Uses controller/CLI surfaces (`createSession`/`designer create` path + `SEL.home.*` — no hardcoded testids). Steps: create throwaway (file names include a hyphen and a space — probing the label≍filename claim), add blank page, `files-delete` dry-run (assert non-mutating + row still present), `--yes` delete blank page (assert `ok:true`, `remainingLabels` correct, URL `?file=` cleared when active), `not-found` case, `ambiguous` case if same-label creatable cheaply, then delete the throwaway project via a script-local stamped-click helper on the title menu (accepted, deliberate scope: e2e-only helper, no production selectors; on failure prints the URL for manual cleanup — recorded in the PR body either way).
- **Patterns to follow:** tonight's scratchpad probes productionized; `scripts/ci-preflight.ts:82-88` refuse-on-absence style.
- **Test scenarios:** the script is the scenario set; each assertion prints PASS/FAIL with evidence.
- **Verification:** one green run pre-merge, recorded in the PR body (labels observed, dialog echo observed, kill-conditions checked).

### U8. Docs + entry-point inventories

- **Goal:** Docs stop lying; the discipline is written down.
- **Requirements:** R10
- **Dependencies:** U5, U6
- **Files:** Modify: `README.md` (MCP table "six"→"seven", CLI verb), `CLAUDE.md` (Entry-points lists: add `files-delete` verb + `designer_files_delete` tool; Gotchas: switcher = unified file surface vs legacy panel; destructive discipline = trusted input + verify-and-stamp + root-pin + positive settle; canary anchor stops before the dialog), `skills/designer-loop/SKILL.md` (one-line mention if trivial).
- **Test scenarios:** none — docs.
- **Verification:** README table lists the tool; CLAUDE.md entry-points current.

### U9. Health anchor `session.filesSwitcher`

- **Goal:** Daily drift coverage for every load-bearing selector, walked non-destructively, leaving no dirty state.
- **Requirements:** R2
- **Dependencies:** U1, U2, U3
- **Files:** Modify: `ui-anchors.ts`
- **Approach:** Block-bodied check (patchable-scan-safe by construction): trigger present → open via `openSwitcherExpr(SEL.files)` → ≥1 row → `browser.hover` first row → `rowMoreActions` visible → open menu → assert 'Download' present via a `[role="menuitem"]`-scoped read (not `hasButtonMatching` — unscoped). **'Delete' item: when `rows.length === 1` treat absence as `status:'degraded'`** with detail "single-page canary — last page may not offer Delete" (plausible product rule; verify against live canary before merging as a hard assert). **Never click Delete.** `finally`: Escape (menu), Escape/trigger (popover), then assert popover closed (`switcherRow` count 0) **and row count unchanged from entry** (a stray Duplicate misclick would make the canary multi-file and flake `session.fileListScrape` per `daily-health.yml:41-48`) — restoration failure → `status:'fail'` with detail, never silent. Also assert `SEL.files.confirmDialog` absent at exit (anchors the selector per U1). Order after `session.fileListScrape` in `UI_ANCHORS`.
- **Patterns to follow:** `ui-anchors.ts:735-826` (shared-expr use, bounded retries, skip stances, block body).
- **Test scenarios:** contract tests green; stub-browser-style check that the anchor consumes `SEL.files.*` if cheap to add.
- **Verification:** `designer health` live run: anchor ok (or degraded per the one-row rule), page state clean afterwards.

## Scope Boundaries

- **Non-goals:** project deletion in production surfaces (e2e-local cleanup helper only); Rename/Duplicate/Download verbs; batch delete; undo/trash (snapshot is the mitigation); migrating `listFiles*` off the legacy panel; gating `designer-controller.ts:499` (`ensureCdpUp` in `ensureReady`) — documented, not fixed here.

### Deferred to Follow-Up Work

- `files-rename` / `files-duplicate` / `files-download` on the same anchors (re-add `rowRename`/`rowDuplicate` selectors then).
- Unified-switcher migration for `listFiles*` (would make canvas projects listable).
- Production project-delete verb.
- Cross-process tab lock (lockfile keyed by agent-browser session under `stateDir()`) — the in-process gate covers the MCP/CLI single-process reality; multi-process concurrent driving remains the documented CLAUDE.md gap, now narrowed.

## System-Wide Impact

- **Interaction graph:** `deleteFile` → `_ensureInSession` → ungated `ensureCdpUp` (`:499`): under `DESIGNER_CDP=''` the verb throws like `iterate`/`handoff`. Accepted and documented (CLAUDE.md gotcha, U8).
- **Error propagation:** union codes flow verbatim through CLI (JSON, exit code) and MCP (`textResult`); precondition throws surface as MCP tool errors (existing behavior).
- **State lifecycle risks:** the gate is new shared controller state — `finally`-released, `iff` invariant tested by inspection + U7; stamped attributes are transient and removed; session-store rewrite on active-file delete is the only persistent-state write beyond history.
- **API surface parity:** CLI + MCP added together; `designer-loop` skill touched only if trivial (U8).
- **Unchanged invariants:** `iterate`/`ask` semantics when not concurrent; `FailureMode` untouched; legacy file-panel listing untouched; existing anchors untouched; no new CDP clients.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Label↔filename mismatch (humanized labels) | `normalizeLabel` matching + U7 probes hyphen/space names (kill-condition 4); dialog strict-`===` remains the authority |
| Same-label files | `'ambiguous'` refusal before any hover; cardinality settle makes the single-match path correct, not accidentally correct |
| Verify-A/click-B | stamp-then-click: assertion and click target are the same DOM node by construction |
| Hover state lost across spawns | back-to-back hover→click; `find`/batch fallback (U4 decision point, both facade-native) |
| Empty-read false success | positive cardinality settle; empty/unopenable reads inconclusive; `'unverified'` cap code |
| Popover/dialog left open poisoning later anchors or verbs | `finally` restoration in both U4 and U9, asserted not assumed |
| Canary damage | U9 stops at menu-open, restoration asserts row count unchanged; U7 positive-ownership guard + canary-URL parse + single-file refusal |
| Selector drift | U9 daily walk; selectors.json central; auto-heal patchable (block-bodied check) |
| No controller harness | U2 pure tests + U7 live gate, run pre-merge and recorded in the PR |

## Disconfirming Evidence / Probe Gates

1. **Trusted-input reliability** — U7 e2e; kill: 3 consecutive runs where facade hover/click can't open the menu → resurrect the CDP input driver knowingly.
2. **Dialog always echoes the exact filename** — U7 asserts the anchored-regex parse on every run; kill: any run with a missing/reformatted echo → the mismatch guard is unsound → block merge, re-probe.
3. **Switcher present in both views** — U9 (plain canary) + U7 (canvas throwaway); divergence → per-view selector split.
4. **Row label == filename minus extension chain** — U7 creates hyphen/space names and asserts `matchRows` resolves them; kill: humanized labels beyond `normalizeLabel`'s reach → matching must move to a dialog-echo-verified enumeration design (explicitly NOT built in v1).

## Bug-trace cross-check

| Requirement / adversarial finding | Contract clause | Match? |
|---|---|---|
| Empty-read false success (safety blocker 1) | Positive cardinality settle + `'unverified'` | ✓ |
| Suffix-containment fail-open (safety blocker 2) | Anchored regex + strict `===`, both directions tested | ✓ |
| Unbound Delete clicks (safety blocker 3) | Verify-and-stamp; no positional/unscoped text clicks | ✓ |
| Ambiguity contradiction (3 lanes) | `'ambiguous'` refusal before hover; risk table aligned | ✓ |
| Same-label settle false-negative | Cardinality (not presence) settle | ✓ |
| Snapshot silent-empty / outside gate | Blocking precondition inside gate; bytes>0 required | ✓ |
| Dry-run on wrong surface (3 lanes) | One `deleteFile` path, `dryRun` flag; no `listFilesDetailed` | ✓ |
| `_ensureInSession` is not a pin (2 lanes) | Explicit root-pin block + `'wrong-project'`; invariant named | ✓ |
| Active-file wedges stored session | `upsertSession` strip + pre-mutation capture + decode | ✓ |
| Canary single-file Delete-item false-fail | `degraded` stance on one-row case | ✓ |
| Canary guard inert locally | Positive ownership + workflow-file parse + refusal-on-absence | ✓ |
| Contract tests (comma-OR, anchored-or-exempt) | U1 single-branch + legacy block + U9 consumption | ✓ |
| `--yes` parser collision / exit codes | U6 explicit handling + parity test | ✓ |
| Test glob / tsconfig traps | U2 owns glob edit; root-level module | ✓ |
