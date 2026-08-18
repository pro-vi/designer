import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createBrowser, type Browser } from './browser.ts';
import { sessionDir, saveIteration, type IterationRecord } from './artifact-store.ts';
import { upsertSession, appendHistory, getSession, type StoredSession } from './session-store.ts';
import { getSelectors, orderedBranches, presenceSelector, type Selectors } from './selectors.ts';
import { ensureCdpUp } from './cdp-ensure.ts';
import { RunStateObserver } from './run-state.ts';
import { OopifHtmlReader } from './oopif-reader.ts';
import { isPreviewIframeSrc, previewIframeVariant } from './preview-host.ts';
import { isCdpEnabled } from './cdp-env.ts';
import { BeforeUnloadAccepter } from './cdp-dialog.ts';
import {
  classifyInterstitial,
  plannedAction,
  isBlockingInterstitial,
  CONTINUE_HERE_TEXT,
  INTERSTITIAL_PROBE_EXPR,
  type InterstitialKind,
  type InterstitialProbe,
  type InterstitialReport
} from './interstitials.ts';
import { OPEN_FILES_PANEL_EXPR } from './file-panel.ts';
import {
  switcherStateExpr,
  clickTriggerExpr,
  readRowsExpr,
  rowSelector,
  stampRowExpr,
  stampMenuDeleteExpr,
  verifyConfirmDialogExpr,
  dialogPresentExpr,
  clearStampsExpr,
  hitTestStatusExpr,
  centerOfExpr,
  scrimDismissPointExpr,
  stampedSelector,
  matchingRowIndexes,
  foldSettleRead,
  classifySettleRead,
  shouldCloseSwitcher,
  type SettleCounters,
  displayLabelFor,
  STAMP_MENU_DELETE,
  STAMP_CONFIRM_DELETE,
  STAMP_CONFIRM_CANCEL,
  type SwitcherRow
} from './files-switcher.ts';
import { unzipSync } from 'fflate';

export interface ChatTurn {
  role: 'assistant' | 'user' | 'unknown';
  text: string;
}

/**
 * Why a delete refused.
 *
 * Every code means NOTHING WAS DELETED **except** `outcome-unknown`, which is
 * returned for every unproven outcome once a confirm click has been dispatched.
 *
 * There is deliberately no post-dispatch code asserting the file survived. The
 * only evidence for that would be the file list, which is the soft virtualized
 * surface this repo treats as corroboration only — it lags the delete, so "the
 * row is still there" cannot outrank "Delete was clicked and the dialog
 * closed". After a dispatch the outcome is PROVEN gone or UNKNOWN. #F4, and the
 * round-4 disconfirmation that showed the two-consecutive-reads bar was being
 * cleared by repeated reads of a single stale popover mount.
 */
export type DeleteFileError =
  | 'busy'
  | 'wrong-project'
  | 'switcher-unavailable'
  | 'not-found'
  | 'ambiguous'
  | 'menu-unavailable'
  | 'confirm-mismatch'
  | 'dialog-stuck'
  | 'snapshot-failed'
  | 'project-changed'
  | 'outcome-unknown';

export type DeleteFileResult =
  | {
      ok: true;
      /** Discriminant: false = the file is GONE. A dry run never deletes. */
      dryRun: false;
      file: string;
      deletedLabel: string;
      /** Switcher DISPLAY labels (no extensions) of what remains. */
      remainingLabels: string[];
      snapshotPath: string | null;
      activeFileReset: boolean;
      /** Non-fatal cleanup/bookkeeping problems AFTER a proven deletion. */
      warnings?: string[];
    }
  | {
      ok: true;
      dryRun: true;
      file: string;
      /** The switcher LABEL that matched — extensions are not shown there. */
      wouldDelete: string | null;
      ambiguous: boolean;
      rows: string[];
      /**
       * False always: a preview matches on the display label, and the label
       * hides the extension. `index.html` and `index.css` share the label
       * `index`, so a dry run cannot tell them apart. Only the confirm dialog
       * names the full filename, and reaching it means opening a destructive
       * dialog — which a preview must not do. The real delete verifies the name
       * there and refuses with 'confirm-mismatch' if it differs.
       */
      filenameVerified: false;
      note: string;
    }
  | {
      ok: false;
      error: DeleteFileError;
      file: string;
      detail?: string;
      /** Switcher labels, for 'not-found' / 'ambiguous'. */
      candidates?: string[];
      /** What the confirm dialog actually named, for 'confirm-mismatch'. */
      dialogFile?: string | null;
      snapshotPath?: string | null;
    };

export interface SessionStatus {
  key: string;
  stored: StoredSession | null;
  currentUrl: string;
  inSession: boolean;
  onHome: boolean;
  availableFiles: string[];
  /**
   * How much `availableFiles` is worth. 'visible-only' = scraped from the page
   * without navigating, so an empty array may mean "panel closed", not "no
   * files"; 'other-project' = the shared tab is on a different project, so the
   * list is deliberately empty; 'raced' = the tab moved between sampling the
   * URL and scraping, so the read could not be attributed and was discarded;
   * 'not-in-session' = no project open.
   */
  filesScope: 'visible-only' | 'other-project' | 'raced' | 'not-in-session';
  // True when the latest turn is Claude punting with the "Claude has some questions →"
  // teaser. The questions UI itself is ephemeral — it disappears on refresh and has no
  // stable DOM contract — so we don't try to scrape and answer them. Caller should
  // surface this to a human, or re-prompt with `decisive: true` to bypass.
  /**
   * True/false when the read could be attributed to THIS key's project; `null`
   * when it could not (no session, or the tab moved mid-read — see filesScope
   * 'raced'). A plain `false` would read as "definitely not awaiting", which is
   * the same unearned certainty this verb removes everywhere else.
   */
  awaitingClarification: boolean | null;
}

export type FailureMode = null | 'timeout' | 'unstable' | 'no_change' | 'stalled' | 'blocked';

interface GenerationDone {
  ok: boolean;
  elapsedMs: number;
  url?: string;
  iframeSrc?: string;
  htmlBytes?: number;
  html?: string;
  error?: string;
  reason?: string;
}

export interface IterateResult {
  done: { ok: boolean; elapsedMs: number; failureMode: FailureMode };
  changed: boolean;
  /** Live claude.ai/design URL for the human — interactive, tweaks work. Default taste path. */
  url: string;
  activeFile: string | null;
  newFiles: string[];
  removedFiles: string[];
  htmlPath: string | null;
  screenshotPath: string | null;
  htmlBytes: number;
  htmlHash: string | null;
  chatReply: string | null;
}

export interface AskResult {
  ok: boolean;
  elapsedMs: number;
  reply: string | null;
  failureMode: null | 'timeout';
}

export interface HandoffResult {
  ok: true;
  projectId: string;
  projectUrl: string;
  bundleDir: string;
  /** Alias of bundleDir (the bundle root). Kept so downstream consumers that
   *  expected a slug subdir keep resolving; the new export zip is flat. */
  slugDir: string;
  /** Where the unzipped design files live (bundleDir/project). */
  projectDir: string;
  /** Self-generated from the live chat — the export zip no longer ships the
   *  README/transcript the old tar.gz did. */
  decisionRecordPath: string;
  decisionRecordBytes: number;
  /** Chat turns captured into the decision record. */
  decisionRecordTurns: number;
  /** True when no chat turns were captured — the record is header-only (the
   *  caller advertises a verbatim transcript, so surface the gap). */
  decisionRecordEmpty: boolean;
  zipPath: string;
  zipBytes: number;
  /** Design files under project/ (NOT the zip or the record). */
  files: string[];
  repaired: RepairReport;
}

export interface RepairReport {
  renamed: Array<{ from: string; to: string }>;
  skipped: string[];
}

const DESIGN_HOME = 'https://claude.ai/design';

// A claude.ai/design session URL: /design/p/<uuid>. Capture group 1 is the
// project id. Used by isInSession()-style checks and `adopt` (binding an
// already-open project tab to a key, bypassing the create-flow home).
export const SESSION_URL_RE = /^https:\/\/claude\.ai\/design\/p\/([a-f0-9-]+)/i;

// Appended to every designer_prompt payload. The live MCP surface
// (listFiles / openFile / newFiles diff) scrapes a flat root from the
// file panel; files nested under folders stay invisible until handoff.
// Enforcing flat layout here keeps the live flow honest. Users who genuinely
// want nested layouts should explicitly contradict this in their prompt and
// rely on `designer_handoff` for authoritative file access.
const FLAT_LAYOUT_SUFFIX = '\n\nFile layout: keep all generated files at the project root. No subfolders.';
const DECISIVE_SUFFIX =
  '\n\nIf you would otherwise stop to ask clarifying questions, do not. Choose the most defensible answer for each axis yourself and proceed. Note your assumption in a one-line `<!-- assumed: ... -->` comment at the top of the relevant file so I can override on the next turn.';

/**
 * In-process exclusion for every operation that navigates or otherwise mutates
 * a design tab.
 *
 * THE RESOURCE IS THE SESSION'S ACTIVE TAB, so the lock is keyed by
 * `browser.driverId` — the agent-browser session that owns it. Two earlier
 * shapes were both wrong:
 *  - per controller INSTANCE (#134 F3): in CDP mode agent-browser scopes its
 *    daemon session by ENDPOINT (`designer-cdp-<port>`), so every key shares one
 *    session and the lock serialized nothing.
 *  - per (session + project root): `openGuarded` calls `browser.open()` on
 *    whichever tab is ACTIVE — it does not select a tab first — and
 *    `selectDesignTab` changes which tab that is. A navigation issued for
 *    project B therefore moves the tab project A is mid-flight on, so scoping by
 *    project let exactly the interleaving this exists to prevent through.
 *
 * Parallel `--key` work is genuinely serialized by this, and that is correct
 * rather than a regression: with one active tab per session those operations
 * were never safe concurrently, they merely failed silently instead of loudly.
 *
 * Re-entrant per OPERATION via AsyncLocalStorage, not per instance: deleteFile
 * legitimately calls fetchFile -> openFile, which must not deadlock, while two
 * genuinely concurrent calls — even on the same controller — still exclude each
 * other because they run in different async contexts.
 *
 * Remaining gap, documented not closed: in-process only. Two designer PROCESSES
 * against one Chrome is the cross-latch gap CLAUDE.md documents; that needs a
 * lockfile.
 */
const DRIVER_LOCKS = new Map<string, string>();

/**
 * Acquire the tab lock, or report who holds it. Extracted so the acquire/release
 * decision is unit-testable rather than only reachable through a live browser —
 * the same standard applied to decodeConsent in this series.
 *
 * Synchronous by construction: check and set happen in one tick, so two async
 * callers cannot both observe the lock free.
 */
export function tryAcquireDriverLock(locks: Map<string, string>, driver: string, label: string): string | null {
  const held = locks.get(driver);
  if (held) return held;
  locks.set(driver, label);
  DRIVER_EPOCHS.set(driver, (DRIVER_EPOCHS.get(driver) ?? 0) + 1);
  return null;
}

/**
 * Monotonic count of tab-driving operations started, PER DRIVER.
 *
 * Lock-free readers use it to detect that something drove *their* tab during a
 * read. URL equality alone cannot: the tab can go A→B→A between two samples and
 * compare equal while the reads either side came from different projects. Any
 * in-process navigation goes through the lock, so a changed epoch is a reliable
 * "your read may be mixed" signal.
 *
 * Keyed by driverId, not global. Under DESIGNER_CDP='' each key gets its own
 * agent-browser session and therefore its own tab, so a process-wide counter
 * made key B's activity invalidate key A's status read of a tab B could not
 * touch — defeating the parallel isolation that mode exists to provide. The
 * epoch must be as narrow as the resource it stands for, which is the same
 * lesson the lock itself took three attempts to learn.
 *
 * Out-of-process actors do not bump it — the documented cross-process gap,
 * where URL equality remains the belt.
 */
const DRIVER_EPOCHS = new Map<string, number>();
export const driverEpoch = (driver: string): number => DRIVER_EPOCHS.get(driver) ?? 0;

export function releaseDriverLock(locks: Map<string, string>, driver: string): void {
  locks.delete(driver);
}

/** Lock keys held by the operation running in the current async context. */
const LOCK_CTX = new AsyncLocalStorage<Set<string>>();

/**
 * Run `fn` holding the tab lock for `browser`, for callers that hold a Browser
 * rather than a controller.
 *
 * `runHealth` is the reason this is public: the switcher anchor hovers, clicks,
 * presses Escape and toggles the popover, and both `designer health` (cli.ts)
 * and the daily CI probe hand it a raw browser — so the probe was driving the
 * shared tab outside the lock and could close the popover in the middle of a
 * delete's settle. The invariant cannot live at the controller boundary alone
 * when the resource handle escapes it.
 */
export async function withTabLock<T>(browser: Browser, name: string, fn: () => Promise<T>): Promise<T> {
  const resource = browser.driverId;
  const inherited = LOCK_CTX.getStore();
  if (inherited?.has(resource)) return fn();
  const held = tryAcquireDriverLock(DRIVER_LOCKS, resource, name);
  if (held) throw new Error(`designer is busy: ${held} is already driving the browser tab`);
  const store = new Set(inherited ?? []);
  store.add(resource);
  try {
    return await LOCK_CTX.run(store, fn);
  } finally {
    store.delete(resource);
    releaseDriverLock(DRIVER_LOCKS, resource);
  }
}

export class DesignerController {
  readonly key: string;
  readonly selectors: Selectors;
  readonly browser: Browser;
  private _preSendHtml = '';

  constructor({ key, headed = true }: { key?: string; headed?: boolean } = {}) {
    this.key = key || 'default';
    this.selectors = getSelectors();
    this.browser = createBrowser({ session: `designer-${this.key}`, headed });
  }

  async currentUrl(): Promise<string> {
    return (await this.browser.url().catch(() => '')) || '';
  }

  // browser.open() with the design-canvas "Leave site? Changes you made may not be
  // saved." beforeunload modal auto-dismissed for the duration of the navigation.
  // A dirty .dc canvas tab otherwise wedges Page.navigate forever — nothing clicks
  // the modal — which is the create/resume hang (live-verified 2026-06-30). The
  // accepter is a separate CDP client on the SAME tab; it answers the target-global
  // dialog so agent-browser's navigate proceeds. Best-effort + CDP-gated: with
  // DESIGNER_CDP='' (or an attach failure) it degrades to a plain open() — the
  // prior behavior, never worse. We bind it to the CURRENT tab (the one about to
  // be navigated, which is the one that holds the dirty canvas).
  private async openGuarded(url: string): Promise<void> {
    // Only guard when we can bind the accepter to a DEFINITE single design tab —
    // the one about to be navigated. With CDP off, an unknown current URL, or a
    // non-design tab, attaching with a null/loose prefix could land on an arbitrary
    // tab and arm auto-accept there (second-opinion 2026-06-30, H3). In those cases
    // just open plainly: no dirty design canvas is at risk anyway.
    const cur = await this.currentUrl();
    if (!isCdpEnabled() || !/claude\.ai\/design/.test(cur)) {
      await this.browser.open(url);
      return;
    }
    // Exact-URL match + the accepter's tolerateDuplicateUrl:false default: if
    // duplicate tabs make the target ambiguous, attach returns null and we degrade
    // to a plain open rather than guess the wrong tab. attach is internally bounded
    // (Page.enable can't hang it), so this can never wedge before browser.open.
    const accepter = await BeforeUnloadAccepter.attach({ preferUrlPrefix: cur }).catch(() => null);
    try {
      await this.browser.open(url);
    } finally {
      // Telemetry: surface when we actually dismissed a "Leave site?" modal, since
      // accept discards the canvas's dirty state — make the (rare) destructive
      // moment observable rather than silent.
      if (accepter && accepter.acceptedCount > 0) {
        console.warn(
          `[designer] auto-dismissed ${accepter.acceptedCount} "Leave site?" dialog(s) navigating ${cur.slice(0, 60)} -> ${url.slice(0, 60)}`
        );
      }
      accepter?.close();
    }
  }

  async isOnHome(): Promise<boolean> {
    const u = await this.currentUrl();
    return /\/design\/?$/.test(u) || u.endsWith('/design');
  }

  async isInSession(): Promise<boolean> {
    const u = await this.currentUrl();
    return /\/design\/p\/[a-f0-9-]+/i.test(u);
  }

  async getStatus(): Promise<SessionStatus> {
    const stored = getSession(this.key);
    const url = await this.currentUrl();
    const inSession = /\/design\/p\/[a-f0-9-]+/i.test(url);
    // Read-only by construction. This used to call listFiles(), which navigates
    // (openGuarded) and — once tab access became locked — threw 'busy' for the
    // length of any generation, swallowed into an empty array. A status read
    // that silently reports "no files" is worse than one that reports what is
    // actually on screen, and designer_session status is documented as a pure
    // read that is safe to call at any time. Review of e038462.
    // Scope the read to THIS key's project. Dropping listFiles() also dropped
    // the pin it carried ("Navigate to THIS key's project; being in any /p/
    // session isn't enough"), so a status call could report whatever project the
    // shared tab happened to be on as this key's inventory. We cannot navigate
    // here — status must stay lock-free — so we report only when the tab is
    // already on the right project, and say so when it is not.
    const targetRoot = stored?.designUrl?.split('?')[0];
    const onThisKeysProject = !!targetRoot && url.split('?')[0] === targetRoot;
    // Sample, scrape, RE-SAMPLE. Status is deliberately lock-free, and the
    // scrape is a separate agent-browser process, so another key's locked
    // operation can navigate the shared tab in between — which would report
    // that project's filenames under this key's currentUrl. Attribute the read
    // or discard it; never label a racing read 'visible-only'. Codex review,
    // PR #134.
    let availableFiles: string[] = [];
    let awaitingClarification: boolean | null = null;
    let raced = false;
    if (inSession && onThisKeysProject) {
      const epochBefore = driverEpoch(this.browser.driverId);
      // BOTH page reads are gated and attributed together. Fixing only the file
      // scrape left its sibling reading another project's last chat turn and
      // reporting it as this key's awaitingClarification — the same defect, one
      // field over. Codex review, PR #134.
      const scraped = await this._scrapeVisibleFiles();
      const clarifying = await this.detectAwaitingClarification();
      const rootAfter = (await this.currentUrl()).split('?')[0];
      // Both guards: the URL must still match AND no tab-driving operation may
      // have started meanwhile. Equality alone is defeated by A→B→A — the reads
      // either side can come from different projects while the endpoints
      // compare equal.
      if (rootAfter === targetRoot && driverEpoch(this.browser.driverId) === epochBefore) {
        availableFiles = scraped;
        awaitingClarification = clarifying;
      } else {
        raced = true;
      }
    }
    // The list is whatever the page is currently showing: it is empty both for a
    // project with no files and for one whose file panel is closed. Callers that
    // need an authoritative answer must use designer_list / handoff.
    const filesScope: SessionStatus['filesScope'] = !inSession
      ? 'not-in-session'
      : !onThisKeysProject
        ? 'other-project'
        : raced
          ? 'raced'
          : 'visible-only';
    return {
      key: this.key,
      stored,
      currentUrl: url,
      inSession,
      onHome: /\/design\/?$/.test(url) || url.endsWith('/design'),
      availableFiles,
      filesScope,
      awaitingClarification
    };
  }

  // Heuristic only. The questions popover is ephemeral, but the teaser text stays
  // in the chat turn body. If the most recent turn is from Claude and contains the
  // teaser, treat the session as blocked on a clarification. Returns false if the
  // page is mid-stream (we'd race the textnode walk against React's commit phase).
  private async detectAwaitingClarification(): Promise<boolean> {
    const turns = await this.getChatTurns().catch(() => [] as ChatTurn[]);
    if (turns.length === 0) return false;
    const last = turns[turns.length - 1];
    if (!last || last.role !== 'assistant') return false;
    return /Claude has some questions/i.test(last.text);
  }

  private async _sessionBody({
    action = 'status',
    name,
    fidelity = 'wireframe'
  }: {
    action?: 'status' | 'ensure_ready' | 'resume' | 'create' | 'adopt' | 'clear';
    name?: string;
    fidelity?: 'wireframe' | 'highfi';
  } = {}): Promise<unknown> {
    if (action === 'status') return this.getStatus();
    if (action === 'ensure_ready') {
      const r = await this.ensureReady();
      return { ...r, status: await this.getStatus() };
    }
    if (action === 'clear') {
      // clearInterstitials acts on the currently-bound CDP tab; in a multi-key
      // workflow that may be a DIFFERENT project. Select THIS key's stored tab
      // first (scoped, activate-only — no navigation, so it won't hijack another
      // key's tab) so the clear targets the requested session (PR #77 Codex P2).
      if (isCdpEnabled()) await ensureCdpUp();
      const picked = await this.selectMatchingTab().catch(() => ({ matched: false, candidates: 0 }));
      // candidates===0 means NO tab matches this key — selectMatchingTab didn't
      // activate anything, so the browser is still bound to whatever was active.
      // Refuse rather than clear (click/reload) an unrelated key's tab (PR #77
      // Codex P2). candidates>0 means this key's tab is bound (matched, or
      // present-but-masked by the very interstitial we're here to clear) → proceed.
      if (picked.candidates === 0) {
        const report: InterstitialReport = { ok: true, handled: [], blocked: null };
        return { ...report, matched: false, note: 'no live tab matches this key — nothing to clear', status: await this.getStatus() };
      }
      const r = await this.clearInterstitials();
      return { ...r, status: await this.getStatus() };
    }
    if (action === 'resume') {
      const stored = getSession(this.key);
      if (!stored?.designUrl) throw new Error(`No stored session for key=${this.key}. Use action='create' with a name.`);
      const r = await this.resumeSession();
      return { ...r, status: await this.getStatus() };
    }
    if (action === 'create') {
      if (!name) throw new Error("action='create' requires a name.");
      const r = await this.createSession(name, fidelity);
      return { ...r, status: await this.getStatus() };
    }
    if (action === 'adopt') {
      const r = await this.adoptSession(name);
      return { ...r, status: await this.getStatus() };
    }
    throw new Error(`Unknown action: ${action}`);
  }

  // Bind a project you opened by hand (a live /design/p/<uuid> tab) to this
  // key — the supported path around the redesigned creation-cards home, whose
  // anchors drift wholesale (issue #61). `name` is optional metadata only.
  //
  // Safety (PR #66 review): adopt must never silently bind the WRONG project.
  // With more than one /design/p/<uuid> tab open (normal during parallel --key
  // work), there's no key↔tab correlation to pick the right one, so refuse and
  // list them rather than guess by active-first. We also bind from the VALIDATED
  // candidate URL, not a currentUrl() re-read after activateTab (which could race
  // to a different tab).
  private async _adoptSessionBody(name?: string): Promise<{ ok: true; url: string; uuid: string; adopted: true; name?: string }> {
    await ensureCdpUp();

    const candidates = await this.candidateTabs((u) => SESSION_URL_RE.test(u));
    if (candidates.length > 1) {
      const list = candidates.map((t) => `  - ${t.url}`).join('\n');
      throw new Error(
        `adopt can't choose among ${candidates.length} open /design/p/<uuid> tabs:\n${list}\n` +
          `Leave only the target project open (close the others), then retry — adopt won't guess which one this key (${this.key}) means.`
      );
    }

    // Use the validated candidate URL; fall back to the already-bound tab when no
    // dedicated session tab is open (agent-browser may already be on a /p/ URL).
    const top = candidates[0];
    const url = top?.url || (await this.currentUrl());
    const m = url.match(SESSION_URL_RE);
    if (!m) {
      throw new Error(
        `No /design/p/<uuid> tab to adopt — open a project by hand in the CDP-attached Chrome first. current url=${url || 'none'}`
      );
    }
    // Bind agent-browser to the adopted tab for subsequent prompt/handoff. If
    // activation races or fails, the stored designUrl (from the validated URL
    // above) is still correct — ensureReady re-binds by it later.
    if (top) await this.browser.activateTab(top.index).catch(() => null);

    const designUrl = url.split('?')[0] || url;
    const uuid = m[1] ?? '';
    upsertSession(this.key, { designUrl, lastUrl: url, ...(name ? { name } : {}) });
    appendHistory(this.key, { kind: 'session_adopt', url: designUrl, ...(name ? { name } : {}) });
    return { ok: true, url: designUrl, uuid, adopted: true, ...(name ? { name } : {}) };
  }

  // Page tabs whose URL satisfies `match`, ordered active-first then by index
  // ascending — the candidate ordering both adoptSession and selectMatchingTab
  // rely on. Degrades to [] if the CDP tabs() call fails.
  private async candidateTabs(match: (url: string) => boolean): Promise<Awaited<ReturnType<Browser['tabs']>>> {
    const tabs = await this.browser.tabs().catch(() => [] as Awaited<ReturnType<Browser['tabs']>>);
    return tabs
      .filter((t) => t.type === 'page' && t.url && match(t.url))
      .sort((a, b) => Number(b.active) - Number(a.active) || a.index - b.index);
  }

  // Pick the live claude.ai/design tab among possibly many CDP pages, switch
  // agent-browser's binding to it, and verify readiness via DOM anchors.
  // Activates/focuses the matched tab (that's its job) but performs NO
  // session-store mutation — so read-only callers like `designer health` can
  // correct tab drift before probing without persisting state. (Health probing
  // whatever tab happens to be active — a localhost dev app, say — is the
  // tab-drift failure it exists to catch.) Returns the count of candidates
  // considered (for error messaging). No-ops (matched:false, candidates:0) when
  // no design tab is open, leaving the current binding untouched.
  private async _selectDesignTabBody(): Promise<{ matched: boolean; candidates: number }> {
    const stored = getSession(this.key);
    const targetRoot = stored?.designUrl?.split('?')[0];
    const candidates = await this.candidateTabs((u) =>
      targetRoot ? u.startsWith(targetRoot) : /^https:\/\/claude\.ai\/design(\/|$|\?)/.test(u)
    );
    if (candidates.length === 0) return { matched: false, candidates: 0 };

    for (const cand of candidates) {
      await this.browser.activateTab(cand.index).catch(() => null);
      const composerOk = await this.browser.isVisible(this.selectors.composer.promptTextarea).catch(() => false);
      const homeOk = this._signedInMarker()
        ? await this.browser.isVisible(this._signedInMarker()).catch(() => false)
        : false;
      if (composerOk || homeOk) return { matched: true, candidates: candidates.length };
    }
    return { matched: false, candidates: candidates.length };
  }

  // selectDesignTab + record the bound tab as this key's lastUrl. The mutating
  // variant used by the write verbs (clear / ensureReady).
  private async selectMatchingTab(): Promise<{ matched: boolean; candidates: number }> {
    const r = await this.selectDesignTab();
    if (r.matched) upsertSession(this.key, { lastUrl: await this.currentUrl() });
    return r;
  }

  // --- interstitial pre-flight (see interstitials.ts) -----------------------
  // claude.ai/design interrupts the flow with content-only overlays that carry
  // no data-testid: the 495k-token "Continue here" banner, a transient "Something
  // went wrong" page, and the Cloudflare bot-check. Verbs run clearInterstitials()
  // through ensureReady so these don't silently stall automation or get misread
  // as a finished / context-ceilinged generation.

  // Read the page content the classifier needs in a single eval, via the shared
  // INTERSTITIAL_PROBE_EXPR (same shape as the CI diagnostic). Returns null when
  // the read FAILS — distinct from a successfully-read clear page — so callers
  // never mistake "couldn't read" for "no interstitial" (review #5a).
  async _probeInterstitial(): Promise<InterstitialProbe | null> {
    return this.browser.evalValue<InterstitialProbe>(INTERSTITIAL_PROBE_EXPR).catch(() => null);
  }

  // The configured token-banner button text, threaded into every classify call so
  // detection and the click stay on one source of truth (review #3b).
  private get _classifyOpts(): { continueHere?: string } {
    return { continueHere: this.selectors.interstitials?.continueHere };
  }

  // Classify the page now. Returns null on an unreadable page (probe failure) OR
  // a clear page — callers that must distinguish the two re-probe explicitly.
  private async _classifyNow(): Promise<InterstitialKind | null> {
    const probe = await this._probeInterstitial();
    return probe ? classifyInterstitial(probe, this._classifyOpts) : null;
  }

  // Detect and clear interstitials on the currently-bound tab. Loops because
  // clearing one can reveal another (a reload can land back on the token banner),
  // and each action re-probes to CONFIRM before counting it handled. Blocking
  // kinds (cloudflare, transient-error) that survive are reported `blocked`; the
  // token banner is non-blocking (the shell stays usable) so it never blocks a
  // verb even if its button can't be clicked (review #3 / #6). In CDP mode,
  // ensureCdpUp first so the standalone `designer clear` fails loud on a dead
  // Chrome instead of a false recovery (review #5b) — but GATE it on isCdpEnabled
  // so the documented DESIGNER_CDP='' opt-out (where ensureCdpUp throws by design)
  // still works: the probe/click/reload run over agent-browser, not CDP, so the
  // clear itself needs no CDP. Without this gate, the createSession pre-flight
  // would break `create` in the opt-out flow (PR #77 Codex P2).
  private async _clearInterstitialsBody({
    maxPasses = 4,
    cloudflareWaitMs = 25_000,
    pollMs = 1500
  }: { maxPasses?: number; cloudflareWaitMs?: number; pollMs?: number } = {}): Promise<InterstitialReport> {
    if (isCdpEnabled()) await ensureCdpUp();
    const handled: InterstitialKind[] = [];
    for (let pass = 0; pass < maxPasses; pass++) {
      const kind = await this._classifyNow();
      if (!kind) return { ok: true, handled, blocked: null };
      const action = plannedAction(kind);

      if (action === 'click-continue') {
        // Benign banner: try to dismiss, but never block the verb on it.
        const text = this.selectors.interstitials?.continueHere || CONTINUE_HERE_TEXT;
        const clicked = await this._clickButtonByText(new RegExp(`^${escapeRegExp(text)}$`, 'i')).catch(() => false);
        if (clicked) {
          await new Promise((r) => setTimeout(r, 600));
          if ((await this._classifyNow()) !== kind) {
            handled.push(kind);
            appendHistory(this.key, { kind: 'interstitial', interstitial: kind, action });
            continue; // cleared — loop to catch any newly-revealed interstitial
          }
        }
        appendHistory(this.key, {
          kind: 'interstitial',
          interstitial: kind,
          action: clicked ? 'uncleared-nonblocking' : 'continue-button-missing'
        });
        return { ok: true, handled, blocked: null };
      }

      if (action === 'reload') {
        const u = await this.currentUrl();
        if (!u) break; // can't reload an unknown URL (review #4) — fall to residual
        appendHistory(this.key, { kind: 'interstitial', interstitial: kind, action });
        await this.openGuarded(u).catch(() => null);
        // 'load', not 'networkidle' — the SPA's persistent connections never go
        // idle, so networkidle would burn the full timeout each pass (review #4).
        await this.browser.waitLoad('load').catch(() => null);
        await new Promise((r) => setTimeout(r, 800));
        continue; // confirm on the next pass's probe
      }

      if (action === 'await-human') {
        // Cloudflare can't be solved programmatically; wait for it to self-clear
        // before declaring it blocked — it frequently resolves on its own.
        const cleared = await this._waitForInterstitialClear(kind, cloudflareWaitMs, pollMs);
        appendHistory(this.key, { kind: 'interstitial', interstitial: kind, action: cleared ? 'cleared-after-wait' : 'blocked' });
        if (cleared) {
          handled.push(kind);
          continue;
        }
        return { ok: false, handled, blocked: kind };
      }

      // Exhaustiveness: a new InterstitialAction must be handled above, not fall
      // silently into one of the branches (review below-gate).
      const _exhaustive: never = action;
      return _exhaustive;
    }
    // maxPasses exhausted (e.g. a transient error that survived every reload).
    const residual = await this._classifyNow();
    if (residual && isBlockingInterstitial(residual)) return { ok: false, handled, blocked: residual };
    return { ok: true, handled, blocked: null };
  }

  private async _waitForInterstitialClear(kind: InterstitialKind, timeoutMs: number, pollMs: number): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, pollMs));
      const probe = await this._probeInterstitial();
      // A FAILED read (null probe) is NOT "cleared" — keep waiting (review #5a).
      // Only a successful read that classifies as a different kind (or clear)
      // means the challenge is gone; the outer loop handles whatever's now on top.
      if (probe && classifyInterstitial(probe, this._classifyOpts) !== kind) {
        return true;
      }
    }
    return false;
  }

  private _interstitialError(kind: InterstitialKind, candidates: number): Error {
    const suffix = candidates > 0 ? ` (checked ${candidates} tab(s))` : '';
    if (kind === 'cloudflare') {
      return new Error(
        `Cloudflare bot-check is up on claude.ai/design and didn't clear${suffix}. ` +
          `Solve it in the CDP-attached Chrome, then retry.`
      );
    }
    return new Error(`Unresolved interstitial '${kind}' on claude.ai/design${suffix}.`);
  }

  private async _ensureReadyBody(): Promise<{ ok: true; url: string; inSession: boolean; interstitials?: InterstitialReport }> {
    await ensureCdpUp();

    const picked = await this.selectMatchingTab();
    if (picked.matched) {
      // The token banner leaves the composer visible, so a tab can match with an
      // interstitial still up — clear it before any verb runs against the page.
      const interstitials = await this.clearInterstitials();
      if (interstitials.blocked) throw this._interstitialError(interstitials.blocked, picked.candidates);
      return { ok: true, url: await this.currentUrl(), inSession: await this.isInSession(), interstitials };
    }

    // selectMatchingTab matches on a visible composer/home anchor — but a
    // transient-error or Cloudflare overlay HIDES those anchors, so a real design
    // tab can be masked. Before falling back to opening home, activate the best
    // design tab and try clearing; a successful clear re-exposes the anchors.
    //
    // SCOPE to the stored project (mirror selectMatchingTab): an unscoped /design
    // filter would activate the lowest-index design tab — potentially an UNRELATED
    // project — and a later clear/fall-through could silently bind this key to it
    // (review #2, cross-project contamination). Only widen to any /design tab when
    // this key has no stored project to be wrong about.
    const recoveryRoot = getSession(this.key)?.designUrl?.split('?')[0];
    const designTabs = await this.candidateTabs((u) =>
      recoveryRoot ? u.startsWith(recoveryRoot) : /^https:\/\/claude\.ai\/design(\/|$|\?)/.test(u)
    );
    const recoveryTab = designTabs[0];
    if (recoveryTab) {
      await this.browser.activateTab(recoveryTab.index).catch(() => null);
      const report = await this.clearInterstitials();
      if (report.blocked) throw this._interstitialError(report.blocked, designTabs.length);
      if (report.handled.length > 0) {
        const retry = await this.selectMatchingTab();
        if (retry.matched) {
          return { ok: true, url: await this.currentUrl(), inSession: await this.isInSession(), interstitials: report };
        }
      }
    }

    // No live design tab matched. Fall back to opening home and re-checking.
    if (picked.candidates === 0) {
      const u = await this.currentUrl();
      if (!/claude\.ai\/design/.test(u)) {
        await this.openGuarded(DESIGN_HOME);
        await this.browser.waitLoad('networkidle').catch(() => null);
      }
    }

    const interstitials = await this.clearInterstitials();
    if (interstitials.blocked) throw this._interstitialError(interstitials.blocked, picked.candidates);

    const homeOk = this._signedInMarker()
      ? await this.browser.isVisible(this._signedInMarker()).catch(() => false)
      : false;
    const sessionOk = await this.browser.isVisible(this.selectors.composer.promptTextarea).catch(() => false);
    if (!homeOk && !sessionOk) {
      const suffix = picked.candidates > 0 ? ` (checked ${picked.candidates} tab(s))` : '';
      throw new Error(`Not signed in to claude.ai/design, or on an unrecognized page${suffix}. Sign in in the CDP-attached Chrome.`);
    }
    upsertSession(this.key, { lastUrl: await this.currentUrl() });
    return { ok: true, url: await this.currentUrl(), inSession: await this.isInSession(), interstitials };
  }

  private async _createSessionBody(
    name: string,
    fidelity: 'wireframe' | 'highfi' = 'wireframe',
    { timeoutMs = 20 * 60_000, stabilityMs = 4000 }: { timeoutMs?: number; stabilityMs?: number } = {}
  ): Promise<{ ok: true; url: string; name: string; fidelity: string }> {
    // 2026-07 home (re-drifted again — re-captured live 2026-07-24, Chrome 150):
    // the home is composer-driven, but the composer is no longer a <textarea> at
    // all — it is a ProseMirror contenteditable div (`home.creator` =
    // [data-testid="home-composer-input"]; placeholder rotates, never key on it)
    // with a separate submit (`home.createButton` =
    // [data-testid="home-composer-send"], same element as button[title="Create"]).
    // _submitPrompt's contenteditable branch drives it. It is still NOT the
    // in-session chat-composer-input / chat-send-button — those testids exist only
    // in-session. So `name` becomes the seed prompt. The redesign removed the
    // wireframe/high-fi toggle, so `fidelity` is folded into the seed as a
    // directive (and still stored) — otherwise highfi and wireframe creates would
    // behave identically while the session claimed a fidelity that was never
    // applied (#66 review). The creation-type cards (carousel-type-*) set the
    // Template pill but are off the seed path. Verified live against the home.
    //
    // `name` is the composer seed, so it must be non-empty — a whitespace-only
    // name leaves the send button disabled and would otherwise spin the full
    // navigation poll before failing with a misleading message.
    if (!name?.trim()) throw new Error('create requires a non-empty name (used as the project seed prompt).');
    await this.openGuarded(DESIGN_HOME);
    await this.browser.waitLoad('networkidle').catch(() => null);
    // createSession opens home directly (not via ensureReady), so run the same
    // interstitial pre-flight — a Cloudflare check or transient error on home
    // would otherwise stall waitFor(creator) with a misleading timeout.
    const interstitials = await this.clearInterstitials();
    if (interstitials.blocked) throw this._interstitialError(interstitials.blocked, 0);
    await this.browser.waitFor(this.selectors.home.creator);

    const fidelityHint =
      fidelity === 'highfi'
        ? '\n\nBuild this as a high-fidelity, visually polished design.'
        : '\n\nBuild this as a low-fidelity wireframe.';
    // The seed IS the first generation now, so apply the same flat-layout contract
    // sendPrompt() appends to every prompt — otherwise the create run can produce
    // nested folders the flat live file-list/openFile scrape can't see (#66 review).
    const seed = name + fidelityHint + FLAT_LAYOUT_SUFFIX;
    this._preSendHtml = '';

    // The composer-create kicks off a real generation. Return only once it has
    // settled, using the same network-first completion signal as iterate(), so the
    // documented next step (`designer prompt`) can't interleave with the create run
    // (#66 review). Honors the DESIGNER_CDP='' opt-out: with no observer we can't
    // wait reliably (the HTML waiter is degraded under the bootstrap iframe), so we
    // navigate and proceed best-effort — the next prompt's send-enable wait resyncs.
    //
    // Bind the observer to THIS exact home tab (findDesignTarget exact-matches the
    // URL). The home URL is a prefix of every /design/p/<uuid> tab, so a loose
    // prefix could otherwise bind to a different project's tab in multi-tab/
    // parallel-key workflows (#66). The tab keeps its CDP target across the SPA
    // navigation to /p/, so the observer follows it.
    const cdpEnabled = isCdpEnabled();
    const homeUrl = await this.currentUrl();
    let observer: RunStateObserver | null = cdpEnabled
      ? await RunStateObserver.attach({ preferUrlPrefix: homeUrl })
      : null;
    try {
      observer?.beginRun();
      // Reuse the composer fill+submit, pointed at the HOME composer
      // (contenteditable + "Create"), not the in-session defaults. Note the home
      // Create button is always enabled, so the enable-wait is a no-op here — the
      // synchronous fill above is what guarantees the seed text is present before
      // the click.
      await this._submitPrompt(seed, {
        textarea: this.selectors.home.creator,
        sendButton: orderedBranches(this.selectors.home.createButton, this.selectors.homeLegacy?.createButton)
      });

      let inSession = false;
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 500));
        if ((inSession = await this.isInSession())) break;
      }
      if (!inSession) throw new Error('Project creation did not navigate to a /p/ url in time.');

      // Wait for the seed generation to finish. Tolerate observer-lost/timeout —
      // the project exists either way; don't fail create over an imperfect wait.
      if (observer) await this._waitForGenerationDoneNetwork(observer, { timeoutMs, stabilityMs }).catch(() => null);
    } finally {
      observer?.close();
      observer = null;
    }

    const url = await this.currentUrl();
    upsertSession(this.key, { designUrl: url, name, fidelity, lastUrl: url });
    appendHistory(this.key, { kind: 'session_create', name, fidelity, url });
    return { ok: true, url, name, fidelity };
  }

  private async _resumeSessionBody(): Promise<{ ok: true; url: string }> {
    const stored = getSession(this.key);
    if (!stored?.designUrl) throw new Error(`No designUrl stored for key=${this.key}. Create one first.`);
    await this.openGuarded(stored.designUrl);
    await this.browser.waitLoad('networkidle').catch(() => null);
    return { ok: true, url: stored.designUrl };
  }

  // Fill the composer and click send. Defaults to the in-session composer
  // (contenteditable + chat-send-button); pass `sel` to drive a different
  // composer — the home create surface is a plain <textarea> + button[title="Create"]
  // (see createSession). The fill branch already handles both <textarea> (native
  // value setter) and contenteditable (synthetic paste), so only the selectors differ.
  // Presence-only marker for "is this tab a signed-in claude.ai/design surface".
  // Canonical + legacy joined is safe HERE because the caller only asks whether
  // one is present, never which element to act on.
  _signedInMarker(): string {
    return presenceSelector(this.selectors.login.signedInIndicator, this.selectors.loginLegacy?.signedInIndicator);
  }

  async _submitPrompt(prompt: string, sel?: { textarea?: string; sendButton?: string | string[] }): Promise<void> {
    const promptTextarea = sel?.textarea ?? this.selectors.composer.promptTextarea;
    const sendButton =
      sel?.sendButton ?? orderedBranches(this.selectors.composer.sendButton, this.selectors.composerLegacy?.sendButton);
    // Ordered branches, resolved in-page one at a time. A comma-joined list
    // would hand back whichever matched first in DOCUMENT ORDER — so a stale or
    // hidden duplicate earlier in the page could win over the canonical control
    // and we would click the wrong button.
    const sendButtons = Array.isArray(sendButton) ? sendButton.filter(Boolean) : [sendButton];
    const sendButtonsJson = JSON.stringify(sendButtons);
    await this.browser.waitFor(promptTextarea);
    // The composer has shipped as both a React-controlled <textarea> and a
    // ProseMirror contenteditable <div> — branch on what's actually there.
    await this.browser.evalValue<boolean>(
      `(() => {
        const el = document.querySelector(${JSON.stringify(promptTextarea)});
        if (!el) throw new Error('composer input not found');
        const text = ${JSON.stringify(prompt)};
        if (el instanceof HTMLTextAreaElement) {
          // Bypass React's value ownership via the native setter, then fire a
          // bubbling input event.
          const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
          setter.call(el, text);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.focus();
          return true;
        }
        if (el.isContentEditable) {
          // Deliver the text as a synthetic paste so the editor's own paste
          // pipeline updates its internal state; execCommand('insertText')
          // flattens multi-line prompts into one paragraph.
          el.focus();
          const sel = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(el);
          sel.removeAllRanges();
          sel.addRange(range);
          const dt = new DataTransfer();
          dt.setData('text/plain', text);
          const unhandled = el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
          if (unhandled) {
            // No editor intercepted the paste — plain contenteditable fallback.
            document.execCommand('insertText', false, text);
          }
          return true;
        }
        throw new Error('composer input is neither textarea nor contenteditable: ' + el.tagName);
      })()`
    );
    // Wait until the composer is actually ready to submit: the send/create button
    // is enabled AND the input holds the text we just wrote. In-session, "enabled"
    // already implies content (send disables when empty); but the home "Create"
    // button is always enabled, so the content check is what prevents firing an
    // empty submit there — a fill that didn't register would otherwise submit
    // blank and spin the navigation poll into a misleading timeout.
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 150));
      const ready = await this.browser.evalValue<boolean>(
        `(() => {
          const el = document.querySelector(${JSON.stringify(promptTextarea)});
          const hasText = !!el && (el instanceof HTMLTextAreaElement ? el.value : (el.textContent || '')).trim().length > 0;
          let b = null;
          for (const s of ${sendButtonsJson}) { b = document.querySelector(s); if (b) break; }
          const enabled = !!b && !b.disabled && b.getAttribute('aria-disabled') !== 'true';
          return hasText && enabled;
        })()`
      );
      if (ready) break;
    }
    await this.browser.evalValue<boolean>(
      `(() => {
        let b = null;
        for (const s of ${sendButtonsJson}) { b = document.querySelector(s); if (b) break; }
        if (!b) throw new Error('send button not found (tried: ' + ${sendButtonsJson}.join(' | ') + ')');
        b.click();
        return true;
      })()`
    );
  }

  async sendPrompt(
    prompt: string,
    { decisive = false, onBeforeSubmit }: { decisive?: boolean; onBeforeSubmit?: () => void } = {}
  ): Promise<{ ok: true }> {
    const before = await this.fetchServedHtml();
    this._preSendHtml = before.html;
    const effective = prompt + FLAT_LAYOUT_SUFFIX + (decisive ? DECISIVE_SUFFIX : '');
    onBeforeSubmit?.();
    await this._submitPrompt(effective);
    const suffixApplied = decisive ? 'flat_layout+decisive' : 'flat_layout';
    appendHistory(this.key, { kind: 'prompt', prompt, suffixApplied });
    return { ok: true };
  }

  async waitForGenerationDone({
    timeoutMs = 20 * 60_000,
    stabilityMs = 4000,
    pollMs = 1500
  }: { timeoutMs?: number; stabilityMs?: number; pollMs?: number } = {}): Promise<GenerationDone> {
    return this._waitForGenerationDoneHtml({ timeoutMs, stabilityMs, pollMs });
  }

  async _waitForGenerationDoneHtml({
    timeoutMs = 20 * 60_000,
    stabilityMs = 4000,
    pollMs = 1500
  }: { timeoutMs?: number; stabilityMs?: number; pollMs?: number } = {}): Promise<GenerationDone> {
    // One reader for the whole poll loop (reused per poll), not one per poll (#67).
    return this.withPreviewReader(async (readServed) => {
      const start = Date.now();
      const preHtml = this._preSendHtml || '';
      let lastHtml = '';
      let lastLen = -1;
      let stableSince = 0;
      let sawChange = false;

      while (Date.now() - start < timeoutMs) {
        const { html, src } = await readServed();
        const len = html.length;
        if (!preHtml) {
          if (len > 0) sawChange = true;
        } else if (html && html !== preHtml) {
          sawChange = true;
        }
        if (sawChange) {
          if (len === lastLen && html === lastHtml) {
            if (!stableSince) stableSince = Date.now();
            if (Date.now() - stableSince > stabilityMs) {
              const url = await this.currentUrl();
              return { ok: true, elapsedMs: Date.now() - start, url, iframeSrc: src, htmlBytes: len, html };
            }
          } else {
            stableSince = 0;
          }
        }
        lastHtml = html;
        lastLen = len;
        await new Promise((r) => setTimeout(r, pollMs));
      }
      return { ok: false, error: 'timeout', elapsedMs: Date.now() - start };
    });
  }

  async _waitForGenerationDoneNetwork(
    observer: RunStateObserver,
    {
      timeoutMs = 20 * 60_000,
      stabilityMs = 4000,
      pollMs = 1500
    }: { timeoutMs?: number; stabilityMs?: number; pollMs?: number } = {}
  ): Promise<GenerationDone> {
    const terminal = await observer.awaitTerminal({ hardTimeoutMs: timeoutMs });
    if (terminal.terminal === 'observer-lost') {
      return { ok: false, error: 'observer-lost', elapsedMs: terminal.elapsedMs, reason: terminal.reason };
    }
    if (terminal.terminal === 'blocked') {
      return { ok: false, error: 'blocked', elapsedMs: terminal.elapsedMs, reason: terminal.reason };
    }
    if (terminal.terminal === 'timeout') {
      return { ok: false, error: 'stalled', elapsedMs: terminal.elapsedMs, reason: terminal.reason };
    }

    // ReleaseTurn can lead served-HTML readiness by up to ~10s on small edits —
    // the preview keeps propagating after the turn completes (trace findings:
    // ReleaseTurn led HTML byte-stability by 5–10s on edit/tweak runs). So poll
    // a bounded window for the preview to byte-stabilize instead of trusting the
    // first fetch. Crucially we do NOT require a change from _preSendHtml: a
    // chat-only run legitimately keeps it, and forcing a change would reintroduce
    // the timeout blind spot this observer exists to fix.
    // One reader for the whole settle loop (reused per poll), not one per poll (#67).
    return this.withPreviewReader(async (readServed) => {
      let { html, src } = await readServed();
      const preHtml = this._preSendHtml || '';
      const settleDeadline = Date.now() + Math.min(timeoutMs, Math.max(stabilityMs, 12_000));
      let stableSince = Date.now();
      while (Date.now() < settleDeadline) {
        await new Promise((r) => setTimeout(r, pollMs));
        const next = await readServed();
        if (next.html !== html) {
          html = next.html;
          src = next.src;
          stableSince = Date.now();
        } else if (html !== preHtml && Date.now() - stableSince >= stabilityMs) {
          break; // changed and now byte-stable for stabilityMs → settled
        }
      }
      const url = await this.currentUrl();
      return { ok: true, elapsedMs: terminal.elapsedMs, url, iframeSrc: src, htmlBytes: html.length, html };
    });
  }

  private async _snapshotDesignBody({
    html: knownHtml,
    iframeSrc: knownSrc
  }: { html?: string | null; iframeSrc?: string } = {}): Promise<{
    html: string | null;
    screenshotPath: string | null;
    url: string;
    iframeSrc: string;
  }> {
    let iframeSrc = knownSrc || (await this.getIframeSrc());
    let html: string | null = knownHtml ?? null;
    if (html == null && isPreviewIframeSrc(iframeSrc)) {
      // Route through fetchServedHtml (OOPIF capture in the bootstrap regime, node
      // fetch otherwise) so the snapshot command and iterate()'s post-gen snapshot
      // get real HTML. NOTE: `iframeSrc` here is the iframe ELEMENT's src (the
      // `_bootstrap` loader); the captured `html` is the OOPIF document
      // (`/serve/<filename>`). They are intentionally not the same URL — `src` is
      // the element locator, not a fetchable handle for `html` (#67 review #5).
      const served = await this.fetchServedHtml();
      if (served.html) html = served.html;
      if (served.src) iframeSrc = served.src;
    }
    const dir = sessionDir(this.key);
    const shotPath = path.join(dir, `shot-${Date.now()}.png`);
    const shotOk = await this.browser
      .screenshot(shotPath, { full: true })
      .then(() => true)
      .catch(() => false);
    const url = await this.currentUrl();
    return { html, screenshotPath: shotOk ? shotPath : null, url, iframeSrc };
  }

  /**
   * Serialize the verbs that DRIVE the tab (generation waits and destructive
   * edits). CLAUDE.md has required single-flight per design tab since the
   * observer landed, but until now that was prose only — nothing enforced it.
   * Concurrency here is not theoretical: a delete landing inside iterate()'s
   * pre/post listFiles window shows up as a bogus `removedFiles` entry
   * attributed to the generation, and deleting the open file mid-run tears down
   * the preview iframe the settle loop is reading.
   *
   * See DRIVER_LOCKS above for the lock identity and the known gaps.
   */

  // --- tab-driving entry points -------------------------------------------
  // Every operation below navigates or otherwise mutates the session's ACTIVE
  // TAB, so each one takes the tab lock (see DRIVER_LOCKS). They are re-entrant,
  // so an outer verb may call any of them while holding the lock. Read-only
  // verbs (currentUrl / getStatus / getChatTurns / getIframeSrc /
  // fetchServedHtml / isInSession / isOnHome) deliberately do NOT lock.

  async session(opts: Parameters<DesignerController['_sessionBody']>[0]): ReturnType<DesignerController['_sessionBody']> {
    // 'status' is documented as a pure read that is safe to call at any time —
    // including while a 20-minute generation holds the tab — so it must NOT take
    // the lock (which rejects rather than queues). Every other action navigates.
    if ((opts?.action ?? 'status') === 'status') return this._sessionBody(opts);
    return this._withExclusive('session', () => this._sessionBody(opts));
  }

  async ensureReady(): ReturnType<DesignerController['_ensureReadyBody']> {
    return this._withExclusive('ensureReady', () => this._ensureReadyBody());
  }

  async createSession(
    ...args: Parameters<DesignerController['_createSessionBody']>
  ): ReturnType<DesignerController['_createSessionBody']> {
    return this._withExclusive('createSession', () => this._createSessionBody(...args));
  }

  async resumeSession(): ReturnType<DesignerController['_resumeSessionBody']> {
    return this._withExclusive('resumeSession', () => this._resumeSessionBody());
  }

  async adoptSession(
    ...args: Parameters<DesignerController['_adoptSessionBody']>
  ): ReturnType<DesignerController['_adoptSessionBody']> {
    return this._withExclusive('adoptSession', () => this._adoptSessionBody(...args));
  }

  async clearInterstitials(
    ...args: Parameters<DesignerController['_clearInterstitialsBody']>
  ): ReturnType<DesignerController['_clearInterstitialsBody']> {
    return this._withExclusive('clearInterstitials', () => this._clearInterstitialsBody(...args));
  }

  async selectDesignTab(): ReturnType<DesignerController['_selectDesignTabBody']> {
    return this._withExclusive('selectDesignTab', () => this._selectDesignTabBody());
  }

  async listProjects(): ReturnType<DesignerController['_listProjectsBody']> {
    return this._withExclusive('listProjects', () => this._listProjectsBody());
  }

  async listFiles(): ReturnType<DesignerController['_listFilesBody']> {
    return this._withExclusive('listFiles', () => this._listFilesBody());
  }

  async listFilesDetailed(): ReturnType<DesignerController['_listFilesDetailedBody']> {
    return this._withExclusive('listFilesDetailed', () => this._listFilesDetailedBody());
  }

  async openFile(
    ...args: Parameters<DesignerController['_openFileBody']>
  ): ReturnType<DesignerController['_openFileBody']> {
    return this._withExclusive('openFile', () => this._openFileBody(...args));
  }

  async fetchFile(
    ...args: Parameters<DesignerController['_fetchFileBody']>
  ): ReturnType<DesignerController['_fetchFileBody']> {
    return this._withExclusive('fetchFile', () => this._fetchFileBody(...args));
  }

  async handoff(
    ...args: Parameters<DesignerController['_handoffBody']>
  ): ReturnType<DesignerController['_handoffBody']> {
    return this._withExclusive('handoff', () => this._handoffBody(...args));
  }

  /**
   * Switch to `filename` (optional) and snapshot it, as ONE locked operation.
   *
   * Callers used to do `openFile()` then `snapshotDesign()`, which took and
   * released the lock twice: a concurrent verb could move the tab between them,
   * so the snapshot was read off a different page while the response still named
   * the requested file. Compound operations need one window, not two.
   */
  async snapshotFile(
    filename?: string
  ): Promise<{ swap: Awaited<ReturnType<DesignerController['_openFileBody']>> | null } & Awaited<ReturnType<DesignerController['_snapshotDesignBody']>>> {
    return this._withExclusive('snapshotFile', async () => {
      const swap = filename ? await this._openFileBody(filename) : null;
      const snap = await this._snapshotDesignBody({});
      return { swap, ...snap };
    });
  }
  // --- end tab-driving entry points ----------------------------------------

  /** Lock identity: the session whose ACTIVE TAB every navigation mutates. */
  private _lockKey(): string {
    return this.browser.driverId;
  }

  /** Who holds the tab, or null — null also when THIS operation already holds it. */
  private _busyHolder(): string | null {
    const resource = this._lockKey();
    if (LOCK_CTX.getStore()?.has(resource)) return null;
    return DRIVER_LOCKS.get(resource) ?? null;
  }

  // Re-entrant for the SAME operation: an outer verb that already holds the tab
  // may call inner verbs freely (deleteFile -> fetchFile -> openFile). One
  // implementation, shared with the standalone withTabLock above.
  private async _withExclusive<T>(name: string, fn: () => Promise<T>): Promise<T> {
    return withTabLock(this.browser, `${name}[${this.key}]`, fn);
  }


  async _ensureInSession(): Promise<void> {
    await this.ensureReady();
    if (await this.isInSession()) return;
    const stored = getSession(this.key);
    if (!stored?.designUrl) throw new Error(`No active session for key=${this.key}. Call createSession first.`);
    await this.resumeSession();
    // ensureReady's pre-flight cleared the home/current page, but this cold-start
    // just navigated to the stored project — an interstitial on the PROJECT page
    // itself (token banner, transient error, Cloudflare) would otherwise reach the
    // verb that called us. Clear again on the resumed page (PR #77 Codex P2).
    const interstitials = await this.clearInterstitials();
    if (interstitials.blocked) throw this._interstitialError(interstitials.blocked, 1);
  }

  async iterate(
    prompt: string,
    opts: { file?: string; timeoutMs?: number; stabilityMs?: number; decisive?: boolean } = {}
  ): Promise<IterateResult> {
    return this._withExclusive('iterate', () => this._iterateBody(prompt, opts));
  }

  private async _iterateBody(
    prompt: string,
    { file, timeoutMs, stabilityMs, decisive }: { file?: string; timeoutMs?: number; stabilityMs?: number; decisive?: boolean } = {}
  ): Promise<IterateResult> {
    await this._ensureInSession();
    if (file) await this.openFile(file);

    const preFiles = await this.listFiles().catch((): string[] => []);
    const preChatCount = (await this.getChatTurns()).length;

    const waitBudgetMs = timeoutMs ?? 20 * 60_000;
    // Honor the documented CDP opt-out: DESIGNER_CDP='' means "use the
    // agent-browser session-managed flow" (browser.ts resolves it the same way
    // via ??). Attaching the observer would otherwise route an opted-out user
    // through the CDP layer, which resolves '' to :9222 and can auto-launch the
    // debug Chrome (ensureCdpUp). When disabled, fall through to the HTML waiter.
    const cdpEnabled = isCdpEnabled();
    let observer: RunStateObserver | null = cdpEnabled
      ? await RunStateObserver.attach({
          preferUrlPrefix: (await this.currentUrl()).split('?')[0] || null
        })
      : null;
    let done: GenerationDone;
    try {
      await this.sendPrompt(prompt, { decisive, onBeforeSubmit: () => observer?.beginRun() });
      if (observer) {
        done = await this._waitForGenerationDoneNetwork(observer, { timeoutMs: waitBudgetMs, stabilityMs });
        if (done.error === 'observer-lost') {
          const fallback = await this._waitForGenerationDoneHtml({
            timeoutMs: Math.max(1, waitBudgetMs - done.elapsedMs),
            stabilityMs
          });
          done = { ...fallback, elapsedMs: done.elapsedMs + fallback.elapsedMs };
        }
      } else {
        done = await this._waitForGenerationDoneHtml({ timeoutMs: waitBudgetMs, stabilityMs });
      }
    } finally {
      observer?.close();
      observer = null;
    }

    const postFiles = await this.listFiles().catch((): string[] => []);
    const postTurns = await this.getChatTurns();
    const lastTurn = postTurns[postTurns.length - 1];
    const chatReply =
      postTurns.length > preChatCount && lastTurn && lastTurn.role === 'assistant'
        ? lastTurn.text.replace(/^Claude(?:\n+)?/, '').trim()
        : null;

    const newFiles = postFiles.filter((f) => !preFiles.includes(f));
    const removedFiles = preFiles.filter((f) => !postFiles.includes(f));

    const snap = await this._snapshotDesignBody({ html: done.html, iframeSrc: done.iframeSrc });
    const htmlHash = snap.html ? hashHex(snap.html) : null;
    const activeFile = extractFileParam(snap.url);

    let failureMode: FailureMode = null;
    if (!done.ok) {
      if (done.error === 'timeout') failureMode = 'timeout';
      else if (done.error === 'stalled') failureMode = 'stalled';
      else if (done.error === 'blocked') failureMode = 'blocked';
      else failureMode = 'unstable';
    } else if (snap.html && snap.html === this._preSendHtml && newFiles.length === 0) failureMode = 'no_change';

    const fidelity = getSession(this.key)?.fidelity || null;
    const record: IterationRecord = saveIteration(this.key, {
      prompt,
      fidelity,
      html: snap.html,
      screenshotPath: snap.screenshotPath,
      url: snap.url,
      meta: { done: { ok: done.ok, elapsedMs: done.elapsedMs }, failureMode, activeFile, newFiles, htmlHash }
    });
    appendHistory(this.key, { kind: 'iteration', record: record.files, newFiles });

    return {
      done: { ok: done.ok, elapsedMs: done.elapsedMs, failureMode },
      changed: !!(snap.html && snap.html !== this._preSendHtml) || newFiles.length > 0,
      url: snap.url,
      activeFile,
      newFiles,
      removedFiles,
      htmlPath: record.files.html || null,
      screenshotPath: record.files.screenshot || null,
      htmlBytes: snap.html ? snap.html.length : 0,
      htmlHash,
      chatReply
    };
  }

  private async _listProjectsBody(): Promise<Array<{ name: string | null; sub: string | null; url: string | null }>> {
    await this.openGuarded(DESIGN_HOME);
    await this.browser.waitLoad('networkidle').catch(() => null);
    // Presence-only wait, so canonical+legacy may be probed together — otherwise
    // a degraded home (canonical list testid gone) burns the full timeout before
    // proceeding, even though the scrape below would have worked.
    await this.browser
      .waitFor(presenceSelector(this.selectors.home.projectsList, this.selectors.homeLegacy?.projectsList))
      .catch(() => null);
    const json = await this.browser.evalValue<Array<{ name: string | null; sub: string | null; url: string | null }>>(
      `(() => {
        // 2026-07 redesign: projects moved from a flat list of text-bearing links
        // to a <section data-testid="projects-list"> of <tr data-testid=
        // "project-row">. The row's <a href="/design/p/<uuid>"> is now an EMPTY
        // overlay link — reading its text (what the 2026-06 scrape did) yielded
        // null for every project. The name lives in the row's first cell and is
        // mirrored onto the anchor's aria-label.
        const LINK_SEL = ${JSON.stringify(this.selectors.home.projectLink)};
        const ROW_SEL = ${JSON.stringify(this.selectors.home.projectCard)};

        // Parse the uuid from the PATHNAME, not a substring of the whole href:
        // a settings/breadcrumb link, or any URL carrying a project link in a
        // query param, would otherwise match and contribute its own text as a
        // project name.
        const idOf = (a) => {
          const raw = a.getAttribute('href') || '';
          let pathname = raw;
          try { pathname = new URL(a.href || raw, document.baseURI).pathname; } catch (e) { /* keep raw */ }
          // Optional trailing slash, but NOT arbitrary subroutes. The review
          // proposed (?:\\/|$), which would also admit /design/p/<uuid>/settings —
          // re-opening the decoy vector an earlier round closed, where a nav or
          // breadcrumb link outside any row becomes a phantom project named
          // after its own link text.
          const m = pathname.match(/^\\/design\\/p\\/([0-9a-f-]{8,})\\/?$/i);
          return m ? m[1] : null;
        };

        // Name candidates, tagged with WHERE they came from. Source is what
        // decides, not string length: a control link ("Open", "Settings") is
        // shorter than the real name, so a shortest-wins rule picks the button
        // label on exactly the multi-link row this function exists to handle.
        //
        // Priority, most to least authoritative:
        //   rowCell    — the row's name column; shared by every link in the row,
        //                so multi-link rows converge on one answer
        //   ariaLabel  — mirrors the name on the overlay link
        //   anchorText — the legacy flat-list layout, where the name WAS the
        //                link text; also the most likely to be a control label,
        //                hence last.
        const NAME_SOURCES = ['rowCell', 'ariaLabel', 'anchorText'];
        const candidatesFrom = (a) => {
          // closest() with a comma list returns the NEAREST ancestor matching
          // EITHER branch — so a nested <tr> would beat the real project row.
          // Try the specific row first, only then the generic tag.
          const row = a.closest(ROW_SEL) || a.closest('tr');
          const firstCell = row ? row.querySelector('td') : null;
          return {
            rowCell: firstCell ? (firstCell.textContent || '').trim() : '',
            ariaLabel: (a.getAttribute('aria-label') || '').trim(),
            anchorText: (a.textContent || '').trim()
          };
        };

        // Collect ALL candidates per uuid before choosing. The previous version
        // marked a uuid seen at first sight, so when a row carried more than one
        // anchor (an icon/thumbnail link before the named overlay link) the
        // nameless one won and the good one was skipped forever — emitting
        // name:null for a project whose name was right there.
        const byId = new Map();
        for (const a of Array.from(document.querySelectorAll(LINK_SEL))) {
          const id = idOf(a);
          if (!id) continue;
          const href = a.href || a.getAttribute('href') || '';
          const entry = byId.get(id) || { url: href, sources: {} };
          if (!entry.url) entry.url = href;
          const c = candidatesFrom(a);
          // First non-empty value per source wins; later links only fill gaps,
          // so one link's missing aria-label cannot erase another's.
          for (const k of NAME_SOURCES) if (!entry.sources[k] && c[k]) entry.sources[k] = c[k];
          byId.set(id, entry);
        }

        const out = [];
        for (const [, entry] of byId) {
          let name = null;
          for (const k of NAME_SOURCES) {
            if (entry.sources[k]) { name = entry.sources[k]; break; }
          }
          out.push({ name: name || null, sub: null, url: entry.url });
        }
        return out;
      })()`
    ).catch(() => []);
    return Array.isArray(json) ? json : [];
  }

  /**
   * Filenames visible on the CURRENT page. Never navigates and never opens the
   * panel, so it is safe to call while another operation holds the tab — it
   * reports what is on screen, which may be empty if the file panel is closed.
   * For an authoritative list use listFiles()/listFilesDetailed().
   */
  private async _scrapeVisibleFiles(): Promise<string[]> {
    return (
      (await this.browser
        .evalValue<string[]>(
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
            return files;
          })()`
        )
        .catch(() => [] as string[])) || []
    );
  }

  private async _listFilesBody(): Promise<string[]> {
    const { files } = await this.listFilesDetailed();
    return files;
  }

  // Returns top-level files + whether folders were detected in the panel.
  // The live panel shows folders collapsed and doesn't expose an API we can
  // auth against (/files endpoint is 401, no aria-expanded on rows, clicks
  // don't expand programmatically). When folders are present, the caller
  // should fall back to designer_handoff for an authoritative list.
  private async _listFilesDetailedBody(): Promise<{ files: string[]; folders: string[]; authoritative: boolean }> {
    // Navigate to THIS key's project if we're not already there. Being in
    // any /p/ session isn't enough — a different key's files would be
    // returned against the currently-visible project by mistake.
    const stored = getSession(this.key);
    const currentUrl = await this.currentUrl();
    const targetRoot = stored?.designUrl?.split('?')[0];
    const currentRoot = currentUrl.split('?')[0];
    if (!targetRoot) {
      throw new Error(`No designUrl stored for key=${this.key}. createSession or resumeSession first.`);
    }
    if (currentRoot !== targetRoot) {
      await this.openGuarded(stored.designUrl!);
      await this.browser.waitLoad('networkidle').catch(() => null);
      await new Promise((r) => setTimeout(r, 1500));
    }

    // Open the Design Files dialog to get the richer file/folder listing, via the
    // shared idempotent opener (file-panel.ts) — the SAME expression the
    // session.fileListScrape health anchor uses, so the probe can't pass while
    // this silently no-ops. It clicks the label (React root delegation; the old
    // walk-up-for-non-null-.onclick never fired) and is OPEN-ONLY so the before/
    // after listFiles() calls in iterate() don't toggle it shut mid-run (PR #77
    // Codex P2).
    await this.browser.evalValue<boolean>(OPEN_FILES_PANEL_EXPR).catch(() => null);
    await new Promise((r) => setTimeout(r, 600));

    const result = await this.browser.evalValue<{ files: string[]; folders: string[]; designFilesLabelVisible: boolean }>(
      `(() => {
        // Walk all text nodes — Claude's file panel wraps filenames in styled-
        // component <div>s whose class hashes change across deploys. Tag-based
        // scraping misses them; text-node walking is resilient.
        const seen = new Set();
        const files = [];
        let designFilesLabelVisible = false;
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          const t = (node.textContent || '').trim();
          if (t === 'Design Files') designFilesLabelVisible = true;
          if (!/^[A-Za-z0-9 _.()\\-]+\\.(html|js|css|jsx|tsx|ts|md|json|svg)$/i.test(t)) continue;
          if (t.length > 80 || seen.has(t)) continue;
          seen.add(t);
          files.push(t);
        }
        // Folders: rows whose sibling text is 'Folder' (a Claude-side label).
        // Still tag-based since folder rows are structurally different —
        // revisit if this breaks.
        const folderSet = new Set();
        const divs = Array.from(document.querySelectorAll('div'));
        for (const d of divs) {
          if (d.onclick === null) continue;
          const lines = (d.innerText || '').trim().split('\\n').map((l) => l.trim());
          if (lines.length >= 2 && lines[1] === 'Folder' && lines[0] && lines[0].length < 40) {
            folderSet.add(lines[0]);
          }
        }
        return { files, folders: Array.from(folderSet), designFilesLabelVisible };
      })()`
    ).catch(() => ({ files: [] as string[], folders: [] as string[], designFilesLabelVisible: false }));

    const files = Array.isArray(result.files) ? result.files : [];
    const folders = Array.isArray(result.folders) ? result.folders : [];
    // Empty rail under a visible "Design Files" label means we scraped the
    // wrong tab or the panel didn't open — don't tell callers it's truth.
    const emptyButLabelVisible = files.length === 0 && result.designFilesLabelVisible === true;
    return {
      files,
      folders,
      authoritative: !emptyButLabelVisible && folders.length === 0
    };
  }

  private async _openFileBody(filename: string): Promise<{ ok: true; file: string; url: string } | { ok: false; error: string; file: string; url: string }> {
    const stored = getSession(this.key);
    const baseUrl = stored?.designUrl || (await this.currentUrl()).split('?')[0] || '';
    if (!/\/design\/p\//.test(baseUrl)) throw new Error('No project open for this key.');
    const wanted = encodeURIComponent(filename);
    const fileParamOf = (u: string): string | null => {
      try {
        return new URL(u).searchParams.get('file');
      } catch {
        return null;
      }
    };

    const targetRoot = baseUrl.split('?')[0];
    // Already on THIS project's tab showing the requested file with a live
    // preview — no swap needed (re-opening the same file, e.g. repeated
    // `prompt --file X`). Must compare the project root too, not just the file
    // param: with parallel keys, Chrome can be on project B's tab with the same
    // ?file=index.html, and skipping the open would silently target B (#66).
    const curUrl = await this.currentUrl();
    const before = await this.getIframeSrc();
    if (curUrl.split('?')[0] === targetRoot && fileParamOf(curUrl) === filename && isPreviewIframeSrc(before)) {
      return { ok: true, file: filename, url: curUrl };
    }

    const target = `${targetRoot}?file=${wanted}`;
    await this.openGuarded(target);

    // Readiness across two UI generations — and the file-switch false-positive
    // Codex flagged on #66:
    //  - legacy: the signed iframe src embedded the filename (src.includes(wanted)).
    //  - current (issue #61): EVERY file is served from the same per-project
    //    <uuid>.claudeusercontent.com/_bootstrap src — the filename is not in the
    //    src and there is no active-file DOM marker (verified live). So a present
    //    claudeusercontent iframe alone is NOT proof the requested file rendered:
    //    on a switch A→B the URL updates before React swaps, so the caller would
    //    otherwise be handed A's still-mounted preview while asking for B.
    // Switching tears the iframe down (src → '') and remounts it (~1.2s). Require
    // that teardown + restabilize, plus the URL carrying the requested file, before
    // declaring success. `before === ''` means nothing was mounted (no stale preview
    // to clear). Only HTML renders in the iframe; .css/.md/.js settle to an empty
    // preview, so for those a torn-down-then-stable-empty state is the success signal.
    const expectsPreview = /\.html?$/i.test(filename);
    let sawTeardown = before === '';
    let lastSrc = before;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const src = await this.getIframeSrc();
      if (src.includes(wanted)) return { ok: true, file: filename, url: await this.currentUrl() };
      if (src !== before) sawTeardown = true;
      const url = await this.currentUrl();
      if (fileParamOf(url) === filename && sawTeardown && src === lastSrc) {
        if (expectsPreview && isPreviewIframeSrc(src)) return { ok: true, file: filename, url };
        if (!expectsPreview && src === '') return { ok: true, file: filename, url };
      }
      lastSrc = src;
    }
    // Window exhausted. For NON-HTML files an empty preview is the legitimate
    // end-state, so accept once the URL took the requested file and the prior
    // preview cleared. For HTML, never settling on a claudeusercontent iframe is a
    // real failure — do NOT mask a non-rendering preview (a soft ok here would
    // hand callers empty/stale content); fail loud with iframe-swap-timeout.
    const url = await this.currentUrl();
    if (!expectsPreview && fileParamOf(url) === filename && sawTeardown) {
      return { ok: true, file: filename, url };
    }
    return { ok: false, error: 'iframe-swap-timeout', file: filename, url };
  }

  private async _fetchFileBody(filename: string): Promise<{ ok: boolean; file: string; iframeSrc?: string; html: string; htmlBytes: number; error?: string }> {
    const swap = await this.openFile(filename);
    if (!swap.ok) return { ok: false, error: swap.error, file: filename, html: '', htmlBytes: 0 };
    const { html, src } = await this.fetchServedHtml();
    return { ok: true, file: filename, iframeSrc: src, html, htmlBytes: html.length };
  }

  /**
   * Delete ONE named file from this key's project, or preview what would be
   * deleted (`dryRun`). Drives the "Pages" switcher — the unified file surface
   * present in both the plain-HTML and .dc.html canvas views.
   *
   * The product has no undo, so every step is written to fail CLOSED:
   *
   *  - ROOT-PIN. `_ensureInSession` returns early on ANY /design/p/ tab, so it
   *    is not a pin. The project root is re-asserted before the confirm click
   *    and on every settle poll ('wrong-project' / 'project-changed').
   *  - REFUSE ON AMBIGUITY. Switcher rows carry no extension, so
   *    "Canvas.dc.html" and "Canvas.html" render the same label. Two matches =>
   *    'ambiguous' before anything is hovered — never a guess.
   *  - VERIFY-AND-STAMP. The confirm dialog is the only surface naming the full
   *    filename. One page expression parses its quoted name, compares with
   *    `===`, and stamps the button to click, so the node that was verified is
   *    the node that gets clicked (no verify-here / click-there gap).
   *  - TRUSTED INPUT. Hover + clicks go through the facade (real CDP input);
   *    synthetic element.click() silently no-ops on some of these menus.
   * Full reasoning, and the alternatives that were refuted live:
   * docs/adr/0001-destructive-ui-automation-safety.md
   *
   *  - POSITIVE SETTLE. Rows exist only while the popover is open, so "no rows"
   *    is NOT proof of deletion. Success requires the row set to shrink by
   *    exactly one; empty/unreadable reads are inconclusive and cap out as
   *    'outcome-unknown' rather than a false ok.
   */
  async deleteFile(
    fileName: string,
    opts: { dryRun?: boolean; snapshot?: boolean } = {}
  ): Promise<DeleteFileResult> {
    const heldBy = this._busyHolder();
    if (heldBy) {
      return { ok: false, error: 'busy', file: fileName, detail: `${heldBy} is already driving this tab` };
    }
    return this._withExclusive('deleteFile', () => this._deleteFileBody(fileName, opts));
  }

  private async _deleteFileBody(
    fileName: string,
    { dryRun = false, snapshot = true }: { dryRun?: boolean; snapshot?: boolean } = {}
  ): Promise<DeleteFileResult> {
    const F = this.selectors.files;
    const legacyDialog = this.selectors.filesLegacy?.confirmDialog;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    await this._ensureInSession();

    // --- ROOT-PIN ---
    const stored = getSession(this.key);
    const targetRoot = stored?.designUrl?.split('?')[0];
    if (!targetRoot) throw new Error(`No designUrl stored for key=${this.key}. createSession or resumeSession first.`);
    const pinToProject = async (): Promise<boolean> => {
      if ((await this.currentUrl()).split('?')[0] === targetRoot) return true;
      await this.openGuarded(stored!.designUrl!);
      await this.browser.waitLoad('load').catch(() => null);
      await sleep(1200);
      return (await this.currentUrl()).split('?')[0] === targetRoot;
    };
    if (!(await pinToProject())) {
      return { ok: false, error: 'wrong-project', file: fileName, detail: `tab is not on ${targetRoot}` };
    }

    // Capture the active file BEFORE mutating: the app may rewrite ?file= as a
    // side effect of the delete, so a post-hoc read reports the wrong file.
    // Mirror openFile's reader exactly (designer-controller openFile: plain
    // searchParams.get). URLSearchParams already percent-decodes and already
    // maps '+' to space; a second decodeURIComponent on top corrupts names
    // containing a literal '%' and makes the two readers disagree.
    const fileParamOf = (u: string): string | null => {
      try {
        return new URL(u).searchParams.get('file');
      } catch {
        return null;
      }
    };
    const activeFileBefore = fileParamOf(await this.currentUrl());

    const readRows = async (): Promise<{ rows: SwitcherRow[]; reused: boolean } | null> =>
      await this.browser.evalValue<{ rows: SwitcherRow[]; reused: boolean }>(readRowsExpr(F)).catch(() => null);
    // Trusted open/close. The trigger is clicked through the facade, never via
    // an in-page synthetic click — see switcherStateExpr for why that matters
    // (a synthetic open strands the row menu's scrim above the confirm dialog).
    const switcherState = async (): Promise<string> =>
      (await this.browser.evalValue<string>(switcherStateExpr(F)).catch(() => 'error')) || 'error';
    // Reports whether the popover was actually RE-MOUNTED (we found it closed
    // and opened it) as well as its state. Zero-row reads cannot carry the node
    // stamp, so for the last-file case this is the only independence signal
    // there is: without it, one mounted empty popover supplies two apparently
    // fresh 'gone' observations.
    const openSwitcherTracked = async (): Promise<{ state: string; remounted: boolean }> => {
      let st = await switcherState();
      if (st !== 'closed') return { state: st, remounted: false };
      const st2 = await openFromClosed();
      return { state: st2, remounted: true };
    };
    const openFromClosed = async (): Promise<string> => {
      // Trusted click first — it leaves the cleanest overlay state.
      await this.browser.click(F.switcherTrigger).catch(() => null);
      await sleep(700);
      let st = await switcherState();
      if (st !== 'closed') return st;
      // …but on some page states every trusted variant reports success and
      // does nothing (live 2026-07-26). Fall back to the synthetic open; the
      // scrim it can strand is handled before the confirm click.
      await this.browser.evalValue(clickTriggerExpr(F)).catch(() => null);
      await sleep(800);
      return switcherState();
    };
    const openSwitcher = async (): Promise<string> => (await openSwitcherTracked()).state;
    const closeSwitcher = async () => {
      // 'open-empty' is open too. Treating it as already-closed left the last
      // file's popover mounted across polls, which is exactly how two reads of
      // one mount looked independent.
      const st = await switcherState();
      if (!shouldCloseSwitcher(st)) return;
      await this.browser.click(F.switcherTrigger).catch(() => null);
      await sleep(400);
      if (shouldCloseSwitcher(await switcherState())) await this.browser.evalValue(clickTriggerExpr(F)).catch(() => null);
    };
    const clearStamps = async () => {
      await this.browser.evalValue(clearStampsExpr()).catch(() => null);
    };
    // Click a stamped node once it is genuinely the topmost element at its own
    // click point. Modal dialogs animate in behind a full-screen backdrop, and
    // the facade REFUSES to click through a covering element (reporting it
    // instead of hitting the wrong target) — so waiting for hit-testability is
    // what makes this deterministic instead of a race against an animation.
    /**
     * Actuate a STAMPED node, then prove the intended state change happened.
     *
     * Click mechanism is deliberately layered, because on this app neither
     * mechanism is reliable alone (all measured live 2026-07-26):
     *   1. facade trusted click — real input, cleanest semantics, but on some
     *      page states it reports success and does nothing at all;
     *   2. …after dismissing the switcher popover's stranded `fixed inset-0`
     *      scrim, which otherwise covers the confirm dialog so NOTHING (facade,
     *      coordinate, or raw CDP) can reach it;
     *   3. synthetic `el.click()` on the stamped node — React delegates from the
     *      document root, so this lands even when trusted input no-ops.
     *
     * Safety does not rest on the mechanism. Clicking the WRONG element is
     * prevented by verify-and-stamp (the node clicked is the node just
     * verified); a click that lands NOWHERE is caught by `verify` here and, for
     * the delete itself, by the positive cardinality settle — which is why a
     * no-op can never be reported as success.
     */
    const actuate = async (
      stamp: string,
      { verify, revalidate, budgetMs = 3500 }: { verify: () => Promise<boolean>; revalidate?: () => Promise<boolean>; budgetMs?: number }
    ): Promise<{ fail: string | null; dispatched: boolean }> => {
      const sel = stampedSelector(stamp);
      // Set the instant a click is ISSUED, never after it is observed to work.
      // "The dialog was not seen closing" is not "nothing was dispatched": the
      // click may have landed and committed while the observation failed, which
      // is the whole reason the caller needs to know. Review of #134 fixes.
      let dispatched = false;
      const trusted = async (): Promise<void> => {
        const hit = (await this.browser.evalValue<string>(hitTestStatusExpr(sel)).catch(() => 'error')) || 'error';
        if (hit === 'hittable') {
          // Revalidate here too. The window is short — the caller's root guard
          // fires immediately before — but "checked before EVERY dispatch" has
          // to be true of every dispatch, including the fast one, or the claim
          // is prose. One extra eval on a destructive path is cheap.
          if (revalidate && !(await revalidate())) return;
          dispatched = true;
          await this.browser.click(sel).catch(() => null);
          return;
        }
        if (!hit.startsWith('covered:')) return;
        const pt = await this.browser
          .evalValue<{ x: number; y: number } | null>(scrimDismissPointExpr(F, legacyDialog))
          .catch(() => null);
        if (!pt) return;
        // This click is aimed at the scrim, but it IS a real dispatch into a
        // page holding a live confirm dialog — if the scrim unmounts between the
        // point being chosen and the click landing, it can reach the dialog.
        // Treating it as non-dispatch is how 'dialog-stuck' could be claimed
        // after a click. Review of e038462.
        dispatched = true;
        await this.browser.clickAt(pt.x, pt.y).catch(() => null);
        await sleep(600);
        if (revalidate && !(await revalidate())) return;
        if ((await this.browser.evalValue<string>(hitTestStatusExpr(sel)).catch(() => 'error')) === 'hittable') {
          dispatched = true;
          await this.browser.click(sel).catch(() => null);
        }
      };

      await trusted();
      const deadline = Date.now() + budgetMs;
      while (Date.now() < deadline) {
        if (await verify()) return { fail: null, dispatched };
        await sleep(300);
      }
      // Trusted input did not take. Re-confirm we are still acting on the right
      // thing, then dispatch synthetically to the same stamped node.
      if (revalidate && !(await revalidate())) return { fail: 'revalidate-failed-before-synthetic', dispatched };
      // The synthetic click can commit too — mark dispatched BEFORE issuing it.
      dispatched = true;
      const res = await this.browser
        .evalValue<string>(
          `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return 'absent'; e.click(); return 'clicked'; })()`
        )
        .catch(() => 'error');
      if (res !== 'clicked') return { fail: `synthetic click ${res}`, dispatched };
      const deadline2 = Date.now() + budgetMs;
      while (Date.now() < deadline2) {
        if (await verify()) return { fail: null, dispatched };
        await sleep(300);
      }
      return { fail: 'no state change after trusted and synthetic click', dispatched };
    };

    // --- RESOLVE (identical path for dry-run and delete, so a preview can
    // never disagree with the action it is previewing) ---
    const resolve = async (): Promise<
      { ok: true; rows: SwitcherRow[]; matches: number[] } | { ok: false; error: 'switcher-unavailable' }
    > => {
      const opened = await openSwitcher();
      // 'open-empty' is a successful read of a project with no files — it must
      // resolve to 'not-found', not to "the switcher is broken". Rejecting it
      // made a dry run on an emptied project report switcher-unavailable, and
      // that is the state the docs tell callers to inspect after an uncertain
      // delete.
      if (opened !== 'open' && opened !== 'open-empty') {
        return { ok: false, error: 'switcher-unavailable' };
      }
      const read = await readRows();
      if (!read) return { ok: false, error: 'switcher-unavailable' };
      return { ok: true, rows: read.rows, matches: matchingRowIndexes(read.rows, fileName) };
    };

    // A confirm dialog left open by an earlier interrupted run blocks every
    // click on the page (its scrim covers even the switcher trigger). Clear it
    // before doing anything else.
    if (await this.browser.evalValue<boolean>(dialogPresentExpr(F, legacyDialog)).catch(() => false)) {
      await this.browser.press('Escape').catch(() => null);
      await sleep(500);
      if (await this.browser.evalValue<boolean>(dialogPresentExpr(F, legacyDialog)).catch(() => false)) {
        return { ok: false, error: 'dialog-stuck', file: fileName, detail: 'a modal dialog was already open and would not dismiss' };
      }
    }

    let resolved = await resolve();
    if (!resolved.ok) return { ok: false, error: 'switcher-unavailable', file: fileName };
    if (resolved.matches.length === 0) {
      await closeSwitcher();
      return { ok: false, error: 'not-found', file: fileName, candidates: resolved.rows.map((r) => r.label) };
    }
    if (resolved.matches.length > 1) {
      await closeSwitcher();
      return {
        ok: false,
        error: 'ambiguous',
        file: fileName,
        detail: 'two or more files share this display label; the switcher hides extensions',
        candidates: resolved.matches.map((i) => resolved.ok ? resolved.rows[i]!.label : '')
      };
    }

    if (dryRun) {
      const rows = resolved.rows.map((r) => r.label);
      await closeSwitcher();
      return {
        ok: true,
        dryRun: true,
        file: fileName,
        wouldDelete: rows[resolved.matches[0]!] ?? null,
        ambiguous: false,
        rows,
        filenameVerified: false,
        note: `matched on the switcher label ${JSON.stringify(rows[resolved.matches[0]!] ?? '')}, which hides the extension — a different file sharing that label would also match here. The delete itself verifies the full name against the confirm dialog and refuses with 'confirm-mismatch' if it differs.`
      };
    }

    // --- SNAPSHOT (blocking precondition; there is no undo) ---
    let snapshotPath: string | null = null;
    if (snapshot) {
      await closeSwitcher();
      const fetched = await this.fetchFile(fileName).catch(() => null);
      if (!fetched?.ok || !fetched.htmlBytes) {
        return {
          ok: false,
          error: 'snapshot-failed',
          file: fileName,
          detail: fetched?.error || 'served HTML was empty; re-run with snapshot:false to delete anyway'
        };
      }
      const dir = sessionDir(this.key);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      snapshotPath = path.join(dir, `deleted-${stamp}-${fileName.replace(/[^\w.-]+/g, '_')}`);
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(snapshotPath, fetched.html);
      } catch (e) {
        // The snapshot is a precondition, so a write failure refuses the delete
        // through the declared union rather than throwing past it. #F8.
        return {
          ok: false,
          error: 'snapshot-failed',
          file: fileName,
          detail: `could not write the backup to ${snapshotPath}: ${(e as Error).message}`
        };
      }
      // fetchFile navigates (openFile) — re-pin and re-resolve before acting.
      if (!(await pinToProject())) return { ok: false, error: 'wrong-project', file: fileName, snapshotPath };
      resolved = await resolve();
      if (!resolved.ok) return { ok: false, error: 'switcher-unavailable', file: fileName, snapshotPath };
      if (resolved.matches.length !== 1) {
        await closeSwitcher();
        return {
          ok: false,
          error: resolved.matches.length === 0 ? 'not-found' : 'ambiguous',
          file: fileName,
          snapshotPath,
          candidates: resolved.rows.map((r) => r.label)
        };
      }
    }

    const preCount = resolved.rows.length;
    const preLabelCount = resolved.matches.length; // == 1 here
    const rowIndex = resolved.matches[0]!;

    try {
      // --- REVEAL + OPEN MENU (trusted input only) ---
      // Stamp the row first: the popover interleaves rows with other elements,
      // so an index-based CSS selector does not address them (e2e 2026-07-26).
      const rowStamp = await this.browser.evalValue<string>(stampRowExpr(F, rowIndex)).catch(() => 'error');
      if (rowStamp !== 'stamped') {
        return { ok: false, error: 'switcher-unavailable', file: fileName, detail: `could not address row ${rowIndex} (${rowStamp})`, snapshotPath };
      }
      const rowSel = rowSelector();
      await this.browser.hover(rowSel).catch(() => null);
      await sleep(400);
      const moreSel = `${rowSel} ${F.rowMoreActions}`;
      if (!(await this.browser.isVisible(moreSel).catch(() => false))) {
        await this.browser.hover(rowSel).catch(() => null); // one retry: pointer state can be lost between spawns
        await sleep(500);
      }
      if (!(await this.browser.isVisible(moreSel).catch(() => false))) {
        return { ok: false, error: 'menu-unavailable', file: fileName, detail: 'row actions did not reveal on hover', snapshotPath };
      }
      // Open the row menu, proving it opened rather than assuming it did.
      const menuStamped = async (): Promise<boolean> =>
        (await this.browser.evalValue<string>(stampMenuDeleteExpr()).catch(() => 'error')) === 'stamped';
      await this.browser.click(moreSel).catch(() => null);
      await sleep(600);
      if (!(await menuStamped())) {
        const res = await this.browser
          .evalValue<string>(`(() => { const e = document.querySelector(${JSON.stringify(moreSel)}); if (!e) return 'absent'; e.click(); return 'clicked'; })()`)
          .catch(() => 'error');
        await sleep(800);
        if (res !== 'clicked' || !(await menuStamped())) {
          await this.browser.press('Escape').catch(() => null);
          return { ok: false, error: 'menu-unavailable', file: fileName, detail: 'row menu did not open, or did not offer exactly one Delete', snapshotPath };
        }
      }
      const menuClick = await actuate(STAMP_MENU_DELETE, {
        verify: async () => await this.browser.evalValue<boolean>(dialogPresentExpr(F, legacyDialog)).catch(() => false)
      });
      const menuClickFail = menuClick.fail;
      if (menuClickFail) {
        await this.browser.press('Escape').catch(() => null);
        return { ok: false, error: 'menu-unavailable', file: fileName, detail: `Delete menu item did not raise the confirm dialog (${menuClickFail})`, snapshotPath };
      }
      await sleep(400);

      // --- VERIFY-AND-STAMP THE DIALOG ---
      // Dismiss whatever modal is up and PROVE it went away. Returning
      // 'confirm-mismatch' asserts nothing was deleted; that claim is only
      // honest if the dialog is actually gone.
      const dismissAndProve = async (): Promise<boolean> => {
        await this.browser.press('Escape').catch(() => null);
        await sleep(500);
        if (!(await this.browser.evalValue<boolean>(dialogPresentExpr(F, legacyDialog)).catch(() => true))) return true;
        await this.browser.press('Escape').catch(() => null);
        await sleep(500);
        return !(await this.browser.evalValue<boolean>(dialogPresentExpr(F, legacyDialog)).catch(() => true));
      };

      const verdict = await this.browser
        .evalValue<{ found: boolean; dialogFile: string | null; matched: boolean; stamped: string | null }>(
          verifyConfirmDialogExpr(F, legacyDialog, fileName)
        )
        .catch(() => null);
      if (!verdict?.found || verdict.stamped === null) {
        // The buttons could not be identified (e.g. the product renamed them),
        // so there is nothing safe to click — dismiss and prove it.
        // A null verdict means the READ failed, not that the page is clean —
        // a modal may well be up. Only "the expression ran and saw no dialog"
        // justifies assuming there is nothing to dismiss. #F7.
        const dismissed = verdict === null || verdict.found ? await dismissAndProve() : true;
        return {
          ok: false,
          error: dismissed ? 'confirm-mismatch' : 'dialog-stuck',
          file: fileName,
          dialogFile: verdict?.dialogFile ?? null,
          detail: verdict === null
            ? 'could not read the confirm dialog'
            : !verdict.found
            ? 'confirm dialog did not appear'
            : dismissed
              ? 'confirm dialog buttons could not be identified; dialog dismissed, nothing deleted'
              : 'confirm dialog buttons could not be identified AND the dialog would not dismiss — check the tab by hand',
          snapshotPath
        };
      }
      if (!verdict.matched) {
        // The dialog names a DIFFERENT file — cancel and prove the dialog closed.
        await actuate(STAMP_CONFIRM_CANCEL, {
          verify: async () => !(await this.browser.evalValue<boolean>(dialogPresentExpr(F, legacyDialog)).catch(() => true))
        });
        await sleep(400);
        let stillOpen = await this.browser.evalValue<boolean>(dialogPresentExpr(F, legacyDialog)).catch(() => true);
        if (stillOpen) stillOpen = !(await dismissAndProve());
        return {
          ok: false,
          error: stillOpen ? 'dialog-stuck' : 'confirm-mismatch',
          file: fileName,
          dialogFile: verdict.dialogFile,
          detail: stillOpen
            ? 'dialog named the wrong file AND would not dismiss — nothing was clicked beyond Cancel; check the tab by hand'
            : `dialog named ${JSON.stringify(verdict.dialogFile)}, not ${JSON.stringify(fileName)}; nothing deleted`,
          snapshotPath
        };
      }

      // Last guard before the irreversible click.
      if ((await this.currentUrl()).split('?')[0] !== targetRoot) {
        await this.browser.press('Escape').catch(() => null);
        return { ok: false, error: 'project-changed', file: fileName, detail: 'tab left the bound project mid-flow', snapshotPath };
      }
      const confirmClick = await actuate(STAMP_CONFIRM_DELETE, {
        // The dialog closing is the proof the click landed; the settle below is
        // what proves the FILE actually went away.
        verify: async () => !(await this.browser.evalValue<boolean>(dialogPresentExpr(F, legacyDialog)).catch(() => true)),
        // Re-checked immediately before EVERY dispatch, trusted or synthetic.
        // The pre-click root guard above is not enough on its own: actuate()
        // can wait seconds before the synthetic fallback, and the tab is shared
        // across keys, so both the project AND the filename echo have to still
        // be right at the moment of the click. #F1.
        revalidate: async () => {
          if ((await this.currentUrl()).split('?')[0] !== targetRoot) return false;
          const again = await this.browser
            .evalValue<{ matched: boolean }>(verifyConfirmDialogExpr(F, legacyDialog, fileName))
            .catch(() => null);
          return again?.matched === true;
        }
      });
      // ---------------------------------------------------------------------
      // COMMIT BOUNDARY — drawn at the first DISPATCH, not at actuate()'s
      // return. A click that was issued may have committed even though the
      // dialog was never observed closing, so from here nothing may claim
      // "nothing was deleted". #F4, and the review of that fix.
      // ---------------------------------------------------------------------
      const unknown = (detail: string): DeleteFileResult => ({
        ok: false,
        error: 'outcome-unknown',
        file: fileName,
        detail: `${detail} — ${
          confirmClick.dispatched
            ? 'a confirm click was dispatched, so the file MAY be deleted'
            : 'the dialog closed without an observed dispatch, so this run cannot account for the outcome'
        }; re-run with dryRun to see the current list`,
        snapshotPath
      });

      if (confirmClick.fail) {
        await this.browser.press('Escape').catch(() => null);
        // Only a confirm that was NEVER dispatched leaves a clean guarantee.
        if (!confirmClick.dispatched) {
          return { ok: false, error: 'dialog-stuck', file: fileName, detail: `confirm button never became clickable (${confirmClick.fail})`, snapshotPath };
        }
        return unknown(`the confirm dialog did not close after the click (${confirmClick.fail})`);
      }

      // --- POSITIVE SETTLE ---
      // Each poll must be a fresh OBSERVATION, not a fresh timestamp. The opener
      // early-returns when the popover is already open, so without closing it
      // first every later poll re-read the same mounted DOM subtree — measured
      // as ~1 real observation per 15 of the "two consecutive reads" the verdict
      // was built on. Close, reopen, then read.
      const deadline = Date.now() + 15_000;
      let counters: SettleCounters = { consecutive: 0, presentStreak: 0 };
      let lastGoodRows: SwitcherRow[] | null = null;
      while (Date.now() < deadline) {
        await sleep(600);
        if ((await this.currentUrl()).split('?')[0] !== targetRoot) {
          return unknown('the tab navigated away from the project during the settle');
        }
        await closeSwitcher();
        const { state, remounted } = await openSwitcherTracked();
        const open = state === 'open' || state === 'open-empty';
        const observed = open ? await readRows() : null;
        if ((await this.currentUrl()).split('?')[0] !== targetRoot) {
          return unknown('the tab navigated away while the file list was being read');
        }
        const read = classifySettleRead(
          observed?.rows ?? null,
          fileName,
          preCount,
          preLabelCount,
          open,
          observed?.reused ?? false,
          remounted
        );
        counters = foldSettleRead(counters, read);
        if (read.kind === 'gone') lastGoodRows = observed?.rows ?? [];
        if (counters.consecutive >= 2) break;
      }

      // The loop can also exit by DEADLINE. Falling through from there reports
      // ok:true with no evidence at all — present, reused, unreadable and
      // malformed reads alike. This guard was lost when the settle block was
      // rewritten (the replaced span ended at the section marker below, and the
      // guard sat between the loop and it), and nothing caught it: the e2e's
      // happy path always breaks out on consecutive >= 2, so the deadline exit
      // is never taken there.
      if (counters.consecutive < 2 || !lastGoodRows) {
        return unknown('the file list never settled into two consistent, independent reads');
      }

      // --- POST-SUCCESS ---
      let activeFileReset = false;
      const warnings: string[] = [];
      // The snapshot step calls fetchFile → openFile, which navigates the tab to
      // ?file=<fileName>. So the pre-flight sample is not enough: re-read the
      // tab's file param as it stands now, or a snapshot-first delete leaves the
      // stored session resuming onto a file that no longer exists.
      const activeFileNow = fileParamOf(await this.currentUrl());
      const tabOnDeleted = activeFileBefore === fileName || activeFileNow === fileName;
      // The STORED url can name the deleted file even when the tab never did:
      // createSession persists the raw post-generation URL, which carries
      // `?file=<name>`, and resumeSession opens it verbatim. Deleting that file
      // while the tab happens to show a different one left designUrl pointing at
      // a corpse — every later resume reopened it. Codex review, PR #134.
      const storedNamesDeleted = fileParamOf(stored?.designUrl ?? '') === fileName;
      if (tabOnDeleted || storedNamesDeleted) {
        // Only navigate when the TAB is the problem; a stale stored URL just
        // needs rewriting, and moving the tab for it would be gratuitous.
        let arrived = true;
        if (tabOnDeleted) {
          await this.openGuarded(targetRoot).catch(() => null);
          await this.browser.waitLoad('load').catch(() => null);
          // Prove we actually arrived before claiming the reset or rewriting
          // stored state — swallowing the navigation error and reporting
          // activeFileReset:true left the tab on a deleted file's URL. #F6.
          arrived = (await this.currentUrl()).split('?')[0] === targetRoot;
        }
        if (arrived) {
          // targetRoot is `string` (narrowed by the !targetRoot throw above) and
          // is by construction stored.designUrl minus its query — no casts.
          const strip = (u?: string | null): string | undefined => (u ? u.split('?')[0] : undefined);
          try {
            upsertSession(this.key, { designUrl: targetRoot, lastUrl: strip(stored?.lastUrl) });
            activeFileReset = true;
          } catch (e) {
            warnings.push(`stored session not updated (${(e as Error).message}); it still points at the deleted file`);
          }
        } else {
          warnings.push('the tab is still on the deleted file URL — navigate to the project root by hand');
        }

      }
      // The deletion is already committed; a failed history write must not turn
      // a completed non-idempotent operation into a reported failure. #F5.
      try {
        appendHistory(this.key, { kind: 'file-delete', file: fileName, at: new Date().toISOString() });
      } catch (e) {
        warnings.push(`history not recorded (${(e as Error).message})`);
      }
      return {
        ok: true,
        dryRun: false,
        file: fileName,
        deletedLabel: displayLabelFor(fileName),
        remainingLabels: (lastGoodRows ?? []).map((r) => r.label),
        snapshotPath,
        activeFileReset,
        ...(warnings.length ? { warnings } : {})
      };
    } finally {
      await clearStamps();
      await closeSwitcher();
    }
  }

  async getChatTurns(): Promise<ChatTurn[]> {
    return (
      (await this.browser
        .evalValue<ChatTurn[]>(
          `(() => {
            const c = document.querySelector(${JSON.stringify(this.selectors.messages.chatMessagesContainer)});
            const inner = c && c.children[0];
            if (!inner) return [];
            return Array.from(inner.children).map((d) => {
              const txt = (d.innerText || '').trim();
              // Role signal: Claude's replies carry a feedback widget
              // ([data-msgfb], thumbs up/down) and user turns don't. The 2026-06
              // chat DOM dropped the "Claude"/"You" text prefixes the old check
              // keyed off (kept as a fallback for older builds). In this two-party
              // chat a non-assistant turn is the human, so default to 'user'.
              const isAssistant = !!d.querySelector('[data-msgfb]') || /^Claude(\\n|$)/.test(txt);
              return { role: isAssistant ? 'assistant' : 'user', text: txt };
            });
          })()`
        )
        .catch(() => [] as ChatTurn[])) || []
    );
  }

  async ask(
    prompt: string,
    opts: { file?: string; timeoutMs?: number; stabilityMs?: number; pollMs?: number } = {}
  ): Promise<AskResult> {
    return this._withExclusive('ask', () => this._askBody(prompt, opts));
  }

  private async _askBody(
    prompt: string,
    { file, timeoutMs = 5 * 60_000, stabilityMs = 2500, pollMs = 1000 }: { file?: string; timeoutMs?: number; stabilityMs?: number; pollMs?: number } = {}
  ): Promise<AskResult> {
    await this._ensureInSession();
    if (file) await this.openFile(file);
    const beforeCount = (await this.getChatTurns()).length;
    await this._submitPrompt(prompt);
    appendHistory(this.key, { kind: 'ask', prompt });

    const start = Date.now();
    let lastText = '';
    let stableSince = 0;

    while (Date.now() - start < timeoutMs) {
      const turns = await this.getChatTurns();
      if (turns.length >= beforeCount + 2) {
        const last = turns[turns.length - 1];
        if (last && last.role === 'assistant') {
          if (last.text === lastText && last.text.length > 0) {
            if (!stableSince) stableSince = Date.now();
            if (Date.now() - stableSince > stabilityMs) {
              const reply = last.text
                .replace(/^Claude(?:\n+)?/, '')
                .replace(/^(?:Searching|Reading|Thinking)\s*\n+/i, '')
                .trim();
              appendHistory(this.key, { kind: 'ask_reply', textBytes: reply.length });
              return { ok: true, elapsedMs: Date.now() - start, reply, failureMode: null };
            }
          } else {
            stableSince = 0;
            lastText = last.text;
          }
        }
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    return { ok: false, elapsedMs: Date.now() - start, reply: null, failureMode: 'timeout' };
  }

  async getIframeSrc(): Promise<string> {
    const src = await this.browser
      .evalValue<string>(
        `(() => { const el = document.querySelector(${JSON.stringify(this.selectors.preview.iframeOrContainer)}); return (el && el.src) || ''; })()`
      )
      .catch(() => '');
    return src || '';
  }

  // Node-side fetch of the preview src. The LEGACY signed-token regime
  // (`claudeusercontent.com/...?t=<token>`) authorizes this fetch and returns
  // the file's real rendered HTML. The 2026-06 bootstrap regime does NOT (see
  // fetchServedHtml) — there the fetch returns the same ~1.1KB unauthenticated
  // loader shell for every file, so this is only the fallback floor.
  private async _fetchServedHtmlNode(src: string): Promise<{ src: string; html: string }> {
    try {
      const res = await fetch(src, { headers: { Accept: 'text/html' } });
      if (!res.ok) return { src, html: '' };
      return { src, html: await res.text() };
    } catch {
      return { src, html: '' };
    }
  }

  // Reads the design preview's served HTML. The preview iframe addressing has
  // two regimes (preview-host.ts/previewIframeVariant):
  //
  //   - signed-token (legacy): a node fetch of the `?t=<token>` URL is
  //     authorized and returns the file's real rendered HTML — keep it.
  //   - bootstrap-subdomain (2026-06, issue #61): the src is a filename-agnostic
  //     `<uuid>.claudeusercontent.com/_bootstrap` with NO token. A node fetch
  //     (no claude.ai cookies) returns the same ~1.1KB unauthenticated loader
  //     shell for EVERY file — never the rendered HTML. The rendered DOM lives
  //     only inside the cross-origin out-of-process iframe (OOPIF), which the
  //     parent page JS can't read. So read it over CDP via OopifHtmlReader
  //     (review #4, live-verified). Honors the DESIGNER_CDP='' opt-out and
  //     degrades to the node fetch on any failure, so every existing caller
  //     (snapshot, iterate's post-gen snapshot, the no_change signal, and the
  //     _waitForGenerationDoneHtml fallback) behaves at least as before.
  //
  // CONTRACT: "served HTML" here is the preview's RENDERED DOM (outerHTML in the
  // bootstrap regime; the served response body in the signed-token regime), NOT
  // the on-disk source file. For the byte-stability / no_change / snapshot uses
  // that is exactly right (they care what the preview shows). A caller that needs
  // authoritative file SOURCE must use `handoff` (the Share/Export bundle), not
  // this. Returns html:'' (never the loader shell) when no real HTML is readable.
  async fetchServedHtml(sharedReader?: OopifHtmlReader | null): Promise<{ src: string; html: string }> {
    const src = await this.getIframeSrc();
    if (!src || !isPreviewIframeSrc(src)) return { src: '', html: '' };

    const variant = previewIframeVariant(src);
    if (variant === 'bootstrap-subdomain') {
      // A node fetch of a bootstrap src returns ONLY the ~1.1KB loader shell,
      // never the file — so the OOPIF read is the only real source here. On any
      // failure (or the DESIGNER_CDP='' opt-out) return EMPTY, never the shell, so
      // callers (snapshot, the no_change signal, the byte-stability settle) treat
      // it as "no sample" instead of byte-comparing or saving a loader as the
      // captured artifact (#67 review).
      const cdpEnabled = isCdpEnabled();
      if (!cdpEnabled) return { src, html: '' };
      // A poll loop passes a shared reader (attached once via withPreviewReader)
      // to amortize the WS-open/connect cost across polls and avoid a connect
      // storm (#67 review perf); a live reader reuses in ~8ms/read. One-shot
      // callers pass nothing → attach-and-close a fresh reader here.
      if (sharedReader) {
        const html = await sharedReader.readPreviewHtml().catch(() => null);
        return { src, html: html || '' };
      }
      const reader = await this.attachPreviewReader();
      if (reader) {
        try {
          const html = await reader.readPreviewHtml().catch(() => null);
          if (html) return { src, html };
        } finally {
          reader.close();
        }
      }
      return { src, html: '' };
    }

    // signed-token / 'other': the node fetch is authoritative (real rendered HTML).
    return this._fetchServedHtmlNode(src);
  }

  // Attach ONE OopifHtmlReader for the duration of a served-HTML poll loop and
  // reuse it per poll (each readPreviewHtml re-arms in ~8ms), instead of opening a
  // fresh CDP socket per poll — amortizes the WS-open/connect cost and avoids the
  // connect storm on long settle/fallback loops (#67 review perf). The reader is
  // best-effort: if attach fails or the regime isn't bootstrap, fetchServedHtml
  // falls back to its own per-call path. Closed in finally.
  private async withPreviewReader<T>(
    run: (readServed: () => Promise<{ src: string; html: string }>) => Promise<T>
  ): Promise<T> {
    const reader = isCdpEnabled() ? await this.attachPreviewReader() : null;
    try {
      return await run(() => this.fetchServedHtml(reader));
    } finally {
      reader?.close();
    }
  }

  // Attach an OopifHtmlReader bound to the current tab. The FULL current URL
  // (with ?file=) is passed so findDesignTarget exact-matches the agent-browser-
  // driven tab — two same-project tabs on different files must not cross-bind
  // (#67 review). Degrades to null on any failure (caller falls back to the node
  // fetch / treats it as no sample).
  private async attachPreviewReader(): Promise<OopifHtmlReader | null> {
    return OopifHtmlReader.attach({ preferUrlPrefix: (await this.currentUrl()) || null }).catch(() => null);
  }

  // Fetch the project's export zip via the authenticated, same-origin endpoint
  // the Share→Export "Download" button hits — `/design/v1/design/projects/<id>
  // /download` (returns application/zip). The 2026-06-21 redesign removed the old
  // public `api.anthropic.com/v1/design/h/<id>` tar.gz URL and replaced it with a
  // browser download that needs a trusted gesture CDP can't fire — but the bytes
  // come from a plain GET. We do it IN-PAGE (auth + Cloudflare just work there; a
  // node-side fetch with copied cookies 403s) and transfer the bytes out as
  // base64. Throws on non-200 / non-zip so the caller surfaces a clear failure.
  private async _downloadProjectZip(projectId: string): Promise<Buffer> {
    // Origin guard: the in-page fetch is same-origin, so if the bound tab has
    // drifted off claude.ai (tab drift is real — it bit this very session) the
    // '/design/v1/...' path would resolve against the wrong app and 404. Refuse
    // rather than return junk.
    const url = await this.currentUrl();
    if (!/^https:\/\/claude\.ai\/design\//.test(url)) {
      throw new Error(`Active tab is not on claude.ai/design (${url || 'unknown'}) — refusing to fetch the export from the wrong origin.`);
    }
    // In-page authed GET with an abort deadline; returns {status, bytes, b64} or
    // {status, err}. Bytes are carried out as chunked base64 (byte-exact); the
    // server byte count comes back too so we can detect a truncated transfer.
    const expr = (timeoutMs: number) => `(async () => {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), ${timeoutMs});
      try {
        const r = await fetch('/design/v1/design/projects/' + ${JSON.stringify(projectId)} + '/download', { headers: { Accept: '*/*' }, signal: ctrl.signal });
        if (!r.ok) return { status: r.status };
        const bytes = new Uint8Array(await r.arrayBuffer());
        let bin = '';
        const CH = 0x8000;
        for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
        return { status: 200, bytes: bytes.length, b64: btoa(bin) };
      } catch (e) { return { status: 0, err: String((e && e.message) || e) }; }
      finally { clearTimeout(to); }
    })()`;

    // Bounded retry: fail fast on auth/not-found, retry transient (abort/0/429/5xx).
    let lastErr = 'unknown';
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await this.browser
        .evalValue<{ status: number; bytes?: number; b64?: string; err?: string }>(expr(25_000))
        .catch((e): { status: number; bytes?: number; b64?: string; err?: string } => ({ status: 0, err: String((e as Error)?.message || e) }));
      if (res.status === 200 && typeof res.b64 === 'string') {
        const buf = Buffer.from(res.b64, 'base64');
        if (typeof res.bytes === 'number' && buf.length !== res.bytes) {
          lastErr = `truncated transfer (${buf.length} of ${res.bytes} bytes)`; // retry
        } else if (buf.length < 100 || buf.subarray(0, 2).toString('latin1') !== 'PK') {
          throw new Error(`Project download is not a zip (${buf.length} bytes).`);
        } else {
          return buf;
        }
      } else {
        lastErr = res.err ? res.err : `HTTP ${res.status}`;
        if (res.status === 401 || res.status === 403 || res.status === 404) {
          throw new Error(`Project download failed (HTTP ${res.status}). Are you signed in to claude.ai/design?`);
        }
      }
      if (attempt < 2) await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
    throw new Error(`Project download failed after 3 attempts: ${lastErr}.`);
  }

  // Capture the FULL chat transcript despite virtualization (claude.ai mounts only
  // the visible rows). Scroll the chat history top→bottom, accumulating turns keyed
  // by data-index so rows that unmount as we scroll are still kept. Best-effort: if
  // the scroll container isn't found, degrades to the visible window.
  private async _collectChatTurns(): Promise<ChatTurn[]> {
    const collected = new Map<number, ChatTurn>();
    const scrape = async (): Promise<void> => {
      const rows = await this.browser
        .evalValue<Array<{ idx: number; role: 'assistant' | 'user'; text: string }>>(
          `(() => {
            const c = document.querySelector(${JSON.stringify(this.selectors.messages.chatMessagesContainer)});
            const inner = c && c.children[0];
            if (!inner) return [];
            return Array.from(inner.children).map((d) => {
              const idx = parseInt(d.getAttribute('data-index') || '-1', 10);
              const txt = (d.innerText || '').trim();
              const isAssistant = !!d.querySelector('[data-msgfb]') || /^Claude(\\n|$)/.test(txt);
              return { idx, role: isAssistant ? 'assistant' : 'user', text: txt };
            });
          })()`
        )
        .catch(() => [] as Array<{ idx: number; role: 'assistant' | 'user'; text: string }>);
      for (const r of rows) if (r.idx >= 0 && r.text) collected.set(r.idx, { role: r.role, text: r.text });
    };
    const scroll = (dir: 'top' | 'down'): Promise<number> =>
      this.browser
        .evalValue<number>(
          `(() => {
            let s = document.querySelector(${JSON.stringify(this.selectors.messages.chatMessagesContainer)});
            for (let i = 0; i < 8 && s; i++) { if (s.scrollHeight > s.clientHeight + 4) break; s = s.parentElement; }
            if (!s) return -1;
            if (${JSON.stringify(dir)} === 'top') s.scrollTop = 0; else s.scrollTop = Math.min(s.scrollTop + s.clientHeight, s.scrollHeight);
            return s.scrollTop;
          })()`
        )
        .catch(() => -1);

    await scroll('top');
    await new Promise((r) => setTimeout(r, 400));
    let lastTop = -2;
    let stable = 0;
    for (let i = 0; i < 40; i++) {
      await scrape();
      const top = await scroll('down');
      if (top < 0) break; // no scroller — single visible-window pass
      await new Promise((r) => setTimeout(r, 250));
      if (top === lastTop) {
        if (++stable >= 2) break;
      } else {
        stable = 0;
        lastTop = top;
      }
    }
    await scrape();
    return [...collected.entries()].sort((a, b) => a[0] - b[0]).map(([, t]) => t);
  }

  private async _handoffBody({ openFile }: { openFile?: string } = {}): Promise<HandoffResult> {
    await this._ensureInSession();
    if (openFile) await this.openFile(openFile);

    const baseUrl = getSession(this.key)?.designUrl || (await this.currentUrl());
    const m = baseUrl.match(SESSION_URL_RE);
    if (!m || !m[1]) throw new Error(`No /design/p/<uuid> project bound to key=${this.key} to hand off.`);
    const projectId = m[1];
    const projectUrl = baseUrl.split('?')[0] ?? baseUrl;

    // Cross-project guard: the in-page chat scrape AND the export fetch run on the
    // ACTIVE tab. _ensureInSession returns early on any /design/p/ tab and tab
    // drift is real, so the active tab can be a DIFFERENT project than the bound
    // one — which would pair project B's chat with project A's files. Pin the tab
    // to the bound project first so both come from one project.
    const curId = (await this.currentUrl()).match(SESSION_URL_RE)?.[1];
    if (curId !== projectId) await this.resumeSession();

    // The export zip dropped the README + chat transcript the old tar.gz carried,
    // so regenerate the decision record from the live chat (virtualization-aware).
    const turns = await this._collectChatTurns().catch((): ChatTurn[] => []);
    const decisionRecord = renderDecisionRecord(turns, projectId, projectUrl);

    const zip = await this._downloadProjectZip(projectId);

    // Build the bundle atomically: assemble in a temp dir, rename into place only
    // on full success, so a crash/partial extract never leaves a half-built bundle
    // that `tasting` would pick up as the latest complete handoff.
    const dir = sessionDir(this.key);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const bundleDir = path.join(dir, `handoff-${stamp}`);
    const tmpDir = path.join(dir, `.handoff-${stamp}.tmp`);
    const tmpProject = path.join(tmpDir, 'project');
    fs.mkdirSync(tmpProject, { recursive: true });
    try {
      // Extract in-process (no external `unzip` — absent on Windows / minimal CI).
      const entries = unzipSync(new Uint8Array(zip));
      let extracted = 0;
      for (const [name, data] of Object.entries(entries)) {
        if (!name || name.endsWith('/')) continue;
        const dest = path.join(tmpProject, name);
        if (dest !== tmpProject && !dest.startsWith(tmpProject + path.sep)) continue; // zip-slip guard
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, Buffer.from(data));
        extracted++;
      }
      if (extracted === 0) throw new Error('export zip contained no files');
      fs.writeFileSync(path.join(tmpDir, 'bundle.zip'), zip);
      fs.writeFileSync(path.join(tmpDir, 'decision-record.md'), decisionRecord);
      const repaired = repairEmDashLinks(tmpProject);
      fs.renameSync(tmpDir, bundleDir); // commit

      const projectDir = path.join(bundleDir, 'project');
      // Design inventory = project/ only (the zip + record aren't design files).
      const files = listAllFiles(projectDir).map((p) => path.relative(bundleDir, p));
      appendHistory(this.key, { kind: 'handoff', projectId, bundleDir, fileCount: files.length, turns: turns.length, repaired });
      return {
        ok: true,
        projectId,
        projectUrl,
        bundleDir,
        slugDir: bundleDir,
        projectDir,
        decisionRecordPath: path.join(bundleDir, 'decision-record.md'),
        decisionRecordBytes: Buffer.byteLength(decisionRecord),
        decisionRecordTurns: turns.length,
        decisionRecordEmpty: turns.length === 0,
        zipPath: path.join(bundleDir, 'bundle.zip'),
        zipBytes: zip.length,
        files,
        repaired
      };
    } catch (e) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      throw e;
    }
  }

  async _clickButtonByText(pattern: RegExp | string): Promise<boolean> {
    const re = pattern instanceof RegExp ? pattern : new RegExp(pattern);
    return this.browser.evalValue<boolean>(
      `(() => {
        const re = new RegExp(${JSON.stringify(re.source)}, ${JSON.stringify(re.flags)});
        const btn = Array.from(document.querySelectorAll('button')).find(b => re.test((b.textContent || '').trim()));
        if (!btn) throw new Error('button not found: ' + ${JSON.stringify(re.source)});
        btn.click();
        return true;
      })()`
    );
  }

  /** Closes the browser session — the most destructive tab mutation there is. */
  async close(): Promise<void> {
    return this._withExclusive('close', () => this._closeBody());
  }

  private async _closeBody(): Promise<void> {
    await this.browser.close().catch(() => null);
  }
}

function hashHex(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// The export zip no longer ships the README + chat transcript the old tar.gz
// did, so reconstruct a decision record from the live chat turns (every prompt +
// reply, verbatim) — the "why" a coding agent needs alongside the files.
function renderDecisionRecord(turns: ChatTurn[], projectId: string, projectUrl: string): string {
  // getChatTurns role-detects off the turn text starting with "Claude"/"You";
  // the current chat DOM dropped those text labels (turns carry only data-index),
  // so roles can come back all-'unknown'. Don't mislabel them "Note" — fall back
  // to sequential "Turn N" and flag the gap. (Role attribution is a separate
  // getChatTurns drift, tracked independently.)
  const attributed = turns.some((t) => t.role !== 'unknown');
  const out = [
    '# Design handoff — decision record',
    '',
    `Project: ${projectUrl}`,
    `Project ID: ${projectId}`,
    `Captured: ${new Date().toISOString()}`,
    ''
  ];
  if (!turns.length) {
    out.push('## Conversation', '', '_(no chat turns captured)_');
    return out.join('\n');
  }
  out.push('## Conversation (verbatim — the decisions behind the design)');
  if (!attributed) {
    out.push('', '_Speaker labels unavailable (claude.ai dropped role markers from the chat DOM); turns are shown in order._');
  }
  out.push('');
  turns.forEach((t, i) => {
    const role = t.role === 'assistant' ? 'Claude' : t.role === 'user' ? 'You' : `Turn ${i + 1}`;
    out.push(`### ${role}`, '', t.text.trim(), '');
  });
  return out.join('\n');
}

function extractFileParam(url: string): string | null {
  try {
    return new URL(url).searchParams.get('file');
  } catch {
    return null;
  }
}

// Claude's handoff pipeline (as of 2026-04) writes em-dashes (—, U+2014) into
// the index.html hrefs but saves on-disk filenames with regular hyphens (-).
// We detect this mismatch and rename files to match the hrefs. Safe if fixed
// upstream: if the href already resolves, we leave everything alone.
function repairEmDashLinks(projectDir: string): RepairReport {
  const report: RepairReport = { renamed: [], skipped: [] };
  if (!fs.existsSync(projectDir)) return report;
  const indexPath = path.join(projectDir, 'index.html');
  if (!fs.existsSync(indexPath)) return report;

  const indexHtml = fs.readFileSync(indexPath, 'utf8');
  const hrefs = new Set<string>();
  for (const m of indexHtml.matchAll(/href="([^"#?]+\.html)"/g)) {
    const raw = m[1];
    if (!raw) continue;
    try {
      hrefs.add(decodeURIComponent(raw));
    } catch {
      hrefs.add(raw);
    }
  }

  for (const wanted of hrefs) {
    const wantedPath = path.join(projectDir, wanted);
    if (fs.existsSync(wantedPath)) continue;
    const candidate = wanted.replace(/\u2014/g, '-').replace(/\s-\s/g, ' - ');
    const candidatePath = path.join(projectDir, candidate);
    if (candidate !== wanted && fs.existsSync(candidatePath)) {
      fs.renameSync(candidatePath, wantedPath);
      report.renamed.push({ from: candidate, to: wanted });
    } else {
      report.skipped.push(wanted);
    }
  }
  return report;
}

function listAllFiles(root: string): string[] {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length) {
    const cur = stack.pop();
    if (!cur) continue;
    for (const entry of fs.readdirSync(cur)) {
      const p = path.join(cur, entry);
      const st = fs.statSync(p);
      if (st.isDirectory()) stack.push(p);
      else out.push(p);
    }
  }
  return out;
}
