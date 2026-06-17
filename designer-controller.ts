import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { xspawn } from './cross-platform.ts';
import { createBrowser, type Browser } from './browser.ts';
import { sessionDir, saveIteration, type IterationRecord } from './artifact-store.ts';
import { upsertSession, appendHistory, getSession, type StoredSession } from './session-store.ts';
import { REPO_ROOT } from './repo-root.ts';
import { ensureCdpUp } from './cdp-ensure.ts';
import { RunStateObserver } from './run-state.ts';
import { OopifHtmlReader } from './oopif-reader.ts';
import { isPreviewIframeSrc, previewIframeVariant } from './preview-host.ts';

export interface Selectors {
  login: { signedInIndicator: string | null };
  home: {
    creator: string;
    nameInput: string;
    wireframeButtonText: string;
    highFiButtonText: string;
    createButton: string;
    projectsList: string;
    projectCard: string;
  };
  composer: {
    promptTextarea: string;
    sendButton: string;
    stopButton: string | null;
    attachButton?: string;
    modelButton?: string;
  };
  preview: {
    iframeOrContainer: string;
    exportButtonText: string;
    shareButtonText: string;
    emptyStateHeading: string;
  };
  messages: {
    chatMessagesContainer: string;
    generatingIndicator: string | null;
  };
  [k: string]: unknown;
}

export interface ChatTurn {
  role: 'assistant' | 'user' | 'unknown';
  text: string;
}

export interface SessionStatus {
  key: string;
  stored: StoredSession | null;
  currentUrl: string;
  inSession: boolean;
  onHome: boolean;
  availableFiles: string[];
  // True when the latest turn is Claude punting with the "Claude has some questions →"
  // teaser. The questions UI itself is ephemeral — it disappears on refresh and has no
  // stable DOM contract — so we don't try to scrape and answer them. Caller should
  // surface this to a human, or re-prompt with `decisive: true` to bypass.
  awaitingClarification: boolean;
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
  handoffUrl: string;
  bundleDir: string;
  slugDir: string;
  readmePath: string;
  readmeBytes: number;
  tarballPath: string;
  tarballBytes: number;
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

function loadSelectors(): Selectors {
  const base = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'selectors.json'), 'utf8')) as Selectors;
  const overridePath = path.join(os.homedir(), '.designer', 'selectors.override.json');
  if (fs.existsSync(overridePath)) {
    try {
      return deepMerge(base, JSON.parse(fs.readFileSync(overridePath, 'utf8'))) as Selectors;
    } catch (e) {
      console.warn(`[designer] failed to parse ${overridePath}: ${(e as Error).message}`);
    }
  }
  return base;
}

function deepMerge(a: unknown, b: unknown): unknown {
  if (Array.isArray(a) || Array.isArray(b)) return b ?? a;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return b ?? a;
  const out: Record<string, unknown> = { ...(a as Record<string, unknown>) };
  for (const k of Object.keys(b as Record<string, unknown>))
    out[k] = deepMerge((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]);
  return out;
}

export class DesignerController {
  readonly key: string;
  readonly selectors: Selectors;
  readonly browser: Browser;
  private _preSendHtml = '';

  constructor({ key, headed = true }: { key?: string; headed?: boolean } = {}) {
    this.key = key || 'default';
    this.selectors = loadSelectors();
    this.browser = createBrowser({ session: `designer-${this.key}`, headed });
  }

  async currentUrl(): Promise<string> {
    return (await this.browser.url().catch(() => '')) || '';
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
    const availableFiles = inSession ? await this.listFiles().catch(() => []) : [];
    const awaitingClarification = inSession ? await this.detectAwaitingClarification() : false;
    return {
      key: this.key,
      stored,
      currentUrl: url,
      inSession,
      onHome: /\/design\/?$/.test(url) || url.endsWith('/design'),
      availableFiles,
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

  async session({
    action = 'status',
    name,
    fidelity = 'wireframe'
  }: { action?: 'status' | 'ensure_ready' | 'resume' | 'create' | 'adopt'; name?: string; fidelity?: 'wireframe' | 'highfi' } = {}): Promise<unknown> {
    if (action === 'status') return this.getStatus();
    if (action === 'ensure_ready') {
      const r = await this.ensureReady();
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
  async adoptSession(name?: string): Promise<{ ok: true; url: string; uuid: string; adopted: true; name?: string }> {
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
  // Returns the count of candidates considered (for error messaging).
  private async selectMatchingTab(): Promise<{ matched: boolean; candidates: number }> {
    const stored = getSession(this.key);
    const targetRoot = stored?.designUrl?.split('?')[0];
    const candidates = await this.candidateTabs((u) =>
      targetRoot ? u.startsWith(targetRoot) : /^https:\/\/claude\.ai\/design(\/|$|\?)/.test(u)
    );
    if (candidates.length === 0) return { matched: false, candidates: 0 };

    for (const cand of candidates) {
      await this.browser.activateTab(cand.index).catch(() => null);
      const composerOk = await this.browser.isVisible(this.selectors.composer.promptTextarea).catch(() => false);
      const homeOk = this.selectors.login.signedInIndicator
        ? await this.browser.isVisible(this.selectors.login.signedInIndicator).catch(() => false)
        : false;
      if (composerOk || homeOk) {
        upsertSession(this.key, { lastUrl: await this.currentUrl() });
        return { matched: true, candidates: candidates.length };
      }
    }
    return { matched: false, candidates: candidates.length };
  }

  async ensureReady(): Promise<{ ok: true; url: string; inSession: boolean }> {
    await ensureCdpUp();

    const picked = await this.selectMatchingTab();
    if (picked.matched) {
      return { ok: true, url: await this.currentUrl(), inSession: await this.isInSession() };
    }

    // No live design tab matched. Fall back to opening home and re-checking.
    if (picked.candidates === 0) {
      const u = await this.currentUrl();
      if (!/claude\.ai\/design/.test(u)) {
        await this.browser.open(DESIGN_HOME);
        await this.browser.waitLoad('networkidle').catch(() => null);
      }
    }

    const homeOk = this.selectors.login.signedInIndicator
      ? await this.browser.isVisible(this.selectors.login.signedInIndicator).catch(() => false)
      : false;
    const sessionOk = await this.browser.isVisible(this.selectors.composer.promptTextarea).catch(() => false);
    if (!homeOk && !sessionOk) {
      const suffix = picked.candidates > 0 ? ` (checked ${picked.candidates} tab(s))` : '';
      throw new Error(`Not signed in to claude.ai/design, or on an unrecognized page${suffix}. Sign in in the CDP-attached Chrome.`);
    }
    upsertSession(this.key, { lastUrl: await this.currentUrl() });
    return { ok: true, url: await this.currentUrl(), inSession: await this.isInSession() };
  }

  async createSession(
    name: string,
    fidelity: 'wireframe' | 'highfi' = 'wireframe',
    { timeoutMs = 20 * 60_000, stabilityMs = 4000 }: { timeoutMs?: number; stabilityMs?: number } = {}
  ): Promise<{ ok: true; url: string; name: string; fidelity: string }> {
    // 2026-06 redesign (#61): the home is composer-driven. There's no longer a
    // project-name input or a wireframe/high-fi toggle — you seed an intent in
    // the chat composer (`home.creator`, the same data-testid as the in-session
    // composer) and click "Start project" (`home.createButton`, the same
    // data-testid as the in-session send button). So `name` becomes the seed
    // prompt. The redesign removed the wireframe/high-fi toggle, so `fidelity` is
    // folded into the seed as a directive (and still stored) — otherwise highfi
    // and wireframe creates would behave identically while the session claimed a
    // fidelity that was never applied (#66 review). The creation-type cards
    // (Slides / Prototype / Product wireframe / …) are text-only buttons left as a
    // follow-up. Verified live against the redesigned home.
    //
    // `name` is the composer seed, so it must be non-empty — a whitespace-only
    // name leaves the send button disabled and would otherwise spin the full
    // navigation poll before failing with a misleading message.
    if (!name?.trim()) throw new Error('create requires a non-empty name (used as the project seed prompt).');
    await this.browser.open(DESIGN_HOME);
    await this.browser.waitLoad('networkidle').catch(() => null);
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
    const cdpEnabled = (process.env.DESIGNER_CDP ?? '9222') !== '';
    const homeUrl = await this.currentUrl();
    let observer: RunStateObserver | null = cdpEnabled
      ? await RunStateObserver.attach({ preferUrlPrefix: homeUrl })
      : null;
    try {
      observer?.beginRun();
      // Reuse the battle-tested composer fill+submit (contenteditable ProseMirror;
      // waits for the send button to enable before clicking "Start project").
      await this._submitPrompt(seed);

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

  async resumeSession(): Promise<{ ok: true; url: string }> {
    const stored = getSession(this.key);
    if (!stored?.designUrl) throw new Error(`No designUrl stored for key=${this.key}. Create one first.`);
    await this.browser.open(stored.designUrl);
    await this.browser.waitLoad('networkidle').catch(() => null);
    return { ok: true, url: stored.designUrl };
  }

  async _submitPrompt(prompt: string): Promise<void> {
    const { promptTextarea, sendButton } = this.selectors.composer;
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
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 150));
      const disabled = await this.browser.evalValue<boolean>(
        `(() => { const b = document.querySelector(${JSON.stringify(sendButton)}); return !b || b.disabled || b.getAttribute('aria-disabled') === 'true'; })()`
      );
      if (!disabled) break;
    }
    await this.browser.evalValue<boolean>(
      `(() => {
        const b = document.querySelector(${JSON.stringify(sendButton)});
        if (!b) throw new Error('send button not found');
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
    const start = Date.now();
    const preHtml = this._preSendHtml || '';
    let lastHtml = '';
    let lastLen = -1;
    let stableSince = 0;
    let sawChange = false;

    while (Date.now() - start < timeoutMs) {
      const { html, src } = await this.fetchServedHtml();
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
    let { html, src } = await this.fetchServedHtml();
    const preHtml = this._preSendHtml || '';
    const settleDeadline = Date.now() + Math.min(timeoutMs, Math.max(stabilityMs, 12_000));
    let stableSince = Date.now();
    while (Date.now() < settleDeadline) {
      await new Promise((r) => setTimeout(r, pollMs));
      const next = await this.fetchServedHtml();
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
  }

  async snapshotDesign({
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
      // Route through the single fixed reader (OOPIF capture in the bootstrap
      // regime, node fetch otherwise) so the snapshot command, iterate()'s
      // post-gen snapshot, the no_change signal, and the HTML completion
      // fallback all inherit the fix. fetchServedHtml re-reads the live iframe
      // src; adopt it so a returned src reflects what was actually read.
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

  async _ensureInSession(): Promise<void> {
    await this.ensureReady();
    if (await this.isInSession()) return;
    const stored = getSession(this.key);
    if (!stored?.designUrl) throw new Error(`No active session for key=${this.key}. Call createSession first.`);
    await this.resumeSession();
  }

  async iterate(
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
    const cdpEnabled = (process.env.DESIGNER_CDP ?? '9222') !== '';
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

    const snap = await this.snapshotDesign({ html: done.html, iframeSrc: done.iframeSrc });
    const htmlHash = snap.html ? hashHex(snap.html) : null;
    const activeFile = extractFileParam(snap.url);

    let failureMode: FailureMode = null;
    if (!done.ok) {
      if (done.error === 'timeout') failureMode = 'timeout';
      else if (done.error === 'stalled') failureMode = 'stalled';
      else if (done.error === 'blocked') failureMode = 'blocked';
      else failureMode = 'unstable';
    } else if (snap.html === this._preSendHtml && newFiles.length === 0) failureMode = 'no_change';

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

  async listProjects(): Promise<Array<{ name: string | null; sub: string | null; url: string | null }>> {
    await this.browser.open(DESIGN_HOME);
    await this.browser.waitLoad('networkidle').catch(() => null);
    await this.browser.waitFor(this.selectors.home.projectsList).catch(() => null);
    const json = await this.browser.evalValue<Array<{ name: string | null; sub: string | null; url: string | null }>>(
      `(() => {
        // 2026-06 redesign (#61): there's no project-card data-testid. Each
        // project is an <a href="/design/p/<uuid>"> with the project name as its
        // text; dedupe by uuid (a card can wrap more than one anchor).
        const links = Array.from(document.querySelectorAll('a[href*="/design/p/"]'));
        const seen = new Set();
        const out = [];
        for (const a of links) {
          const href = a.href || a.getAttribute('href') || '';
          const m = href.match(/\\/design\\/p\\/([a-f0-9-]+)/i);
          if (!m || seen.has(m[1])) continue;
          seen.add(m[1]);
          out.push({ name: (a.textContent || '').trim() || null, sub: null, url: href });
        }
        return out;
      })()`
    ).catch(() => []);
    return Array.isArray(json) ? json : [];
  }

  async listFiles(): Promise<string[]> {
    const { files } = await this.listFilesDetailed();
    return files;
  }

  // Returns top-level files + whether folders were detected in the panel.
  // The live panel shows folders collapsed and doesn't expose an API we can
  // auth against (/files endpoint is 401, no aria-expanded on rows, clicks
  // don't expand programmatically). When folders are present, the caller
  // should fall back to designer_handoff for an authoritative list.
  async listFilesDetailed(): Promise<{ files: string[]; folders: string[]; authoritative: boolean }> {
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
      await this.browser.open(stored.designUrl!);
      await this.browser.waitLoad('networkidle').catch(() => null);
      await new Promise((r) => setTimeout(r, 1500));
    }

    // Open the Design Files dialog to get the richer file/folder listing.
    // Idempotent — if already open, the click is a no-op (or toggles; we
    // accept the occasional toggle as the tradeoff for not probing state).
    await this.browser.evalValue<boolean>(
      `(() => {
        const spans = Array.from(document.querySelectorAll('span'));
        const label = spans.find(s => s.children.length === 0 && (s.textContent || '').trim() === 'Design Files');
        if (!label) return false;
        let row = label;
        while (row && row.onclick === null) row = row.parentElement;
        if (row) row.click();
        return true;
      })()`
    ).catch(() => null);
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

  async openFile(filename: string): Promise<{ ok: true; file: string; url: string } | { ok: false; error: string; file: string; url: string }> {
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
    await this.browser.open(target);

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

  async fetchFile(filename: string): Promise<{ ok: boolean; file: string; iframeSrc?: string; html: string; htmlBytes: number; error?: string }> {
    const swap = await this.openFile(filename);
    if (!swap.ok) return { ok: false, error: swap.error, file: filename, html: '', htmlBytes: 0 };
    const { html, src } = await this.fetchServedHtml();
    return { ok: true, file: filename, iframeSrc: src, html, htmlBytes: html.length };
  }

  async getChatTurns(): Promise<ChatTurn[]> {
    return (
      (await this.browser
        .evalValue<ChatTurn[]>(
          `(() => {
            const c = document.querySelector('[data-testid="chat-messages"]');
            const inner = c && c.children[0];
            if (!inner) return [];
            return Array.from(inner.children).map((d) => {
              const txt = (d.innerText || '').trim();
              const isAssistant = /^Claude(\\n|$)/.test(txt);
              const isUser = /^You(\\n|$)/.test(txt);
              return { role: isAssistant ? 'assistant' : isUser ? 'user' : 'unknown', text: txt };
            });
          })()`
        )
        .catch(() => [] as ChatTurn[])) || []
    );
  }

  async ask(
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
  async fetchServedHtml(): Promise<{ src: string; html: string }> {
    const src = await this.getIframeSrc();
    if (!src || !isPreviewIframeSrc(src)) return { src: '', html: '' };

    const variant = previewIframeVariant(src);
    const cdpEnabled = (process.env.DESIGNER_CDP ?? '9222') !== '';
    if (variant === 'bootstrap-subdomain' && cdpEnabled) {
      const reader = await OopifHtmlReader.attach({
        preferUrlPrefix: (await this.currentUrl()).split('?')[0] || null
      }).catch(() => null);
      if (reader) {
        try {
          const html = await reader.readPreviewHtml(src).catch(() => null);
          if (html) return { src, html };
        } finally {
          reader.close();
        }
      }
    }

    // signed-token, 'other', CDP opt-out, or any CDP failure: node fetch floor.
    return this._fetchServedHtmlNode(src);
  }

  async handoff({ openFile }: { openFile?: string } = {}): Promise<HandoffResult> {
    await this._ensureInSession();
    if (openFile) await this.openFile(openFile);

    // Claude.ai/design moved Export actions under the Share dropdown
    // (~2026-04-19). Try Share first; fall back to Export for older builds.
    const opened = await this._clickButtonByText(/^Share$/).catch(() => null);
    if (!opened) await this._clickButtonByText(/^Export$/);
    await new Promise((r) => setTimeout(r, 400));
    // ~2026-06: Share opens a tabbed dialog; handoff lives under the
    // "Send to…" tab as a "Claude Code" destination row. Older builds had a
    // direct "Handoff to Claude Code" menu item — keep it as the fallback.
    const viaSendTo = await this._clickClaudeCodeSendTo().catch(() => false);
    if (!viaSendTo) await this._clickButtonByText(/handoff to claude code/i);

    let handoffUrl = '';
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 300));
      const text = await this._dialogText();
      const match = String(text || '').match(/https:\/\/api\.anthropic\.com\/v1\/design\/h\/[A-Za-z0-9_-]+(?:\?[^\s]*)?/);
      if (match && match[0]) {
        handoffUrl = match[0];
        break;
      }
    }
    if (!handoffUrl) throw new Error('Handoff URL did not appear in the dialog.');

    await this.browser
      .evalValue<boolean>(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
      .catch(() => null);

    const dir = sessionDir(this.key);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const bundleDir = path.join(dir, `handoff-${stamp}`);
    fs.mkdirSync(bundleDir, { recursive: true });
    const tgzPath = path.join(bundleDir, 'bundle.tar.gz');

    const res = await fetch(handoffUrl);
    if (!res.ok) throw new Error(`Handoff fetch failed: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(tgzPath, buf);

    await new Promise<void>((resolve, reject) => {
      const child = xspawn('tar', ['-xzf', tgzPath, '-C', bundleDir], { stdio: 'pipe' });
      let err = '';
      child.stderr!.on('data', (d: Buffer) => (err += d.toString()));
      child.on('close', (code: number | null) =>
        code === 0 ? resolve() : reject(new Error(`tar exited ${code}: ${err}`))
      );
    });

    const entries = fs.readdirSync(bundleDir).filter((e) => e !== 'bundle.tar.gz');
    const projectSlug = entries.find((e) => fs.statSync(path.join(bundleDir, e)).isDirectory());
    const slugDir = projectSlug ? path.join(bundleDir, projectSlug) : bundleDir;
    const repaired = repairEmDashLinks(path.join(slugDir, 'project'));
    const readmePath = path.join(slugDir, 'README.md');
    const readme = fs.existsSync(readmePath) ? fs.readFileSync(readmePath, 'utf8') : null;
    const files = listAllFiles(slugDir).map((p) => path.relative(bundleDir, p));

    appendHistory(this.key, { kind: 'handoff', url: handoffUrl, bundleDir, fileCount: files.length, repaired });
    return {
      ok: true,
      handoffUrl,
      bundleDir,
      slugDir,
      readmePath,
      readmeBytes: readme ? readme.length : 0,
      tarballPath: tgzPath,
      tarballBytes: buf.length,
      files,
      repaired
    };
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

  // Navigate the tabbed Share dialog (2026-06 layout): "Send to…" tab →
  // "Claude Code" destination row → its Send button. The row's Send button
  // has no testid and its label text ("Claude Code", "Hand off the project
  // to your terminal") lives in sibling elements, so match by walking up to
  // the row container. Returns false if the tab or row isn't there, so the
  // caller can fall back to the legacy direct menu item.
  async _clickClaudeCodeSendTo(): Promise<boolean> {
    const tabClicked = await this.browser.evalValue<boolean>(
      `(() => {
        const tab = Array.from(document.querySelectorAll('button[role="tab"]')).find(t => /send to/i.test(t.textContent || ''));
        if (!tab) return false;
        tab.click();
        return true;
      })()`
    );
    if (!tabClicked) return false;
    await new Promise((r) => setTimeout(r, 400));
    return this.browser.evalValue<boolean>(
      `(() => {
        const sends = Array.from(document.querySelectorAll('button')).filter(b => (b.textContent || '').trim() === 'Send');
        const target = sends.find(b => {
          let row = b;
          for (let i = 0; i < 3 && row.parentElement; i++) row = row.parentElement;
          return /claude code/i.test(row.textContent || '');
        });
        if (!target) return false;
        target.click();
        return true;
      })()`
    );
  }

  async _dialogText(): Promise<string> {
    return (
      (await this.browser
        .evalValue<string>(
          `(() => {
            const dlg = document.querySelector('[role=dialog]');
            return (dlg && dlg.innerText) || '';
          })()`
        )
        .catch(() => '')) || ''
    );
  }

  async close(): Promise<void> {
    await this.browser.close().catch(() => null);
  }
}

function hashHex(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
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
