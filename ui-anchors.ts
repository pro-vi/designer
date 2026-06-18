import type { Browser } from './browser.ts';
import { RunStateObserver } from './run-state.ts';
import { isPreviewIframeSrc, previewIframeVariant } from './preview-host.ts';

// Every UI anchor this MCP depends on to work. Grouped by the surface state
// they live on. A regression in Claude Design's UI will trip one or more of
// these; `designer health` walks all of them and reports what broke.

export type AnchorCategory = 'home' | 'session' | 'share' | 'pattern';
export type AnchorState = 'home' | 'session' | 'any';
export type ProbeStatus = 'ok' | 'fail' | 'skip';
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

async function hasButtonMatching(browser: Browser, pattern: RegExp): Promise<boolean> {
  return !!(await browser
    .evalValue<boolean>(
      `(() => { const re = new RegExp(${JSON.stringify(pattern.source)}, ${JSON.stringify(pattern.flags)}); return Array.from(document.querySelectorAll('button')).some(b => re.test((b.textContent || '').trim())); })()`
    )
    .catch(() => false));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function submitTurnRpcCanary(browser: Browser): Promise<{ ok: boolean; detail?: string }> {
  const prompt =
    'Health check: answer in chat only with the single word ok. Do not create, modify, or delete files.';
  const filled = await browser
    .evalValue<boolean>(
      `(() => {
        const el = document.querySelector('[data-testid="chat-composer-input"]');
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
          const b = document.querySelector('[data-testid="chat-send-button"], button[title^="Send ("]');
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
        const b = document.querySelector('[data-testid="chat-send-button"], button[title^="Send ("]');
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
  if ((process.env.DESIGNER_CDP ?? '9222') === '') {
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
      // On a design surface, the signed-in app shell renders the chat composer
      // (chat-composer-input) on BOTH the home (creation composer, post-2026-06
      // redesign #61) and inside a session. Its absence here means the login
      // wall is being served at the /design URL — fail loudly.
      if (/claude\.ai\/design/.test(url)) {
        const signedIn = await hasSelector(b, '[data-testid="chat-composer-input"]');
        return signedIn
          ? { ok: true }
          : { ok: false, detail: `login wall rendered at ${url.slice(0, 80)} (no app shell) — signed out. Run: designer setup` };
      }
      // Off the claude.ai/design surface entirely (e.g. an unrelated tab) —
      // sign-in can't be judged from this tab, so don't false-fail.
      return { ok: true, detail: `not on a claude.ai/design surface (url=${url.slice(0, 60)}) — sign-in not checked here` };
    }
  },

  // --- home page ---
  // 2026-06 redesign (#61): the home is composer-driven — no project-name input
  // and no wireframe/high-fi toggle. Creation = seed the chat composer
  // (chat-composer-input) + click "Start project" (chat-send-button, same
  // testids as the in-session composer/send). The old home.nameInput anchor was
  // dropped (no equivalent); home.wireframeButton/highFiButton are repurposed to
  // the surviving creation-type cards (text-only buttons) so they still detect
  // drift of the creation UI. Captured live from Chrome 149.
  {
    id: 'home.creator',
    category: 'home',
    description: 'creation composer (chat-composer-input)',
    requires: 'home',
    check: async (b) => ({ ok: await hasSelector(b, '[data-testid="chat-composer-input"]') })
  },
  {
    id: 'home.wireframeButton',
    category: 'home',
    description: 'Product wireframe creation-type card',
    requires: 'home',
    check: async (b) => ({ ok: await hasButtonMatching(b, /^Product wireframe/) })
  },
  {
    id: 'home.highFiButton',
    category: 'home',
    description: 'Prototype creation-type card',
    requires: 'home',
    check: async (b) => ({ ok: await hasButtonMatching(b, /^Prototype/) })
  },
  {
    id: 'home.createButton',
    category: 'home',
    description: '"Start project" create button (chat-send-button)',
    requires: 'home',
    check: async (b) => ({ ok: await hasSelector(b, '[data-testid="chat-send-button"], button[title^="Send ("]') })
  },
  {
    id: 'home.projectsList',
    category: 'home',
    description: 'project list (>=1 /design/p/ link)',
    requires: 'home',
    check: async (b) => ({ ok: await hasSelector(b, 'a[href*="/design/p/"]') })
  },
  {
    id: 'home.projectCard',
    category: 'home',
    description: 'project card (a[href*="/design/p/"])',
    requires: 'home',
    check: async (b) => ({ ok: await hasSelector(b, 'a[href*="/design/p/"]') })
  },

  // --- inside a session (after /design/p/{uuid}) ---
  {
    id: 'session.promptTextarea',
    category: 'session',
    description: 'chat composer textarea',
    requires: 'session',
    check: async (b) => ({ ok: await hasSelector(b, '[data-testid="chat-composer-input"]') })
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
            const el = document.querySelector('[data-testid="chat-composer-input"]');
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
    // now only identifiable by its title="Send (Enter)". Match either.
    check: async (b) => ({ ok: await hasSelector(b, '[data-testid="chat-send-button"], button[title^="Send ("]') })
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
      return { ok: await hasSelector(b, '[data-testid="html-viewer-iframe"]') };
    }
  },
  {
    id: 'session.chatMessages',
    category: 'session',
    description: 'chat-messages container',
    requires: 'session',
    check: async (b) => ({ ok: await hasSelector(b, '[data-testid="chat-messages"]') })
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
      const src = await b.evalValue<string>(
        `(() => { const el = document.querySelector('[data-testid="html-viewer-iframe"]'); return (el && el.src) || ''; })()`
      ).catch(() => '');
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
    // visible in the daily health probe. It does not attach CDP (that needs a
    // live signed-in session); the capture itself is covered by the turn-RPC
    // canary + the unit tests.
    id: 'network.previewBootstrap',
    category: 'pattern',
    description: 'preview iframe regime (bootstrap-subdomain => OOPIF CDP capture; signed-token => node fetch)',
    requires: 'session',
    check: async (b, url) => {
      if (!/[?&]file=/.test(url)) return { ok: true, detail: '(no file open — preview regime not checked)' };
      const src = await b
        .evalValue<string>(
          `(() => { const el = document.querySelector('[data-testid="html-viewer-iframe"]'); return (el && el.src) || ''; })()`
        )
        .catch(() => '');
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
    // Legacy id (kept to avoid resetting the persisted streak counter). The
    // original check asserted a 'You\n' / 'Claude\n' text prefix on each
    // chat turn, but Claude's May 2026 chat redesign removed the in-text
    // speaker label — turns are now visually distinguished by wrapper
    // styling, not by a text prefix. Replace with an assertion against
    // Claude's intentional `data-index="N"` API on each turn row: matching
    // [data-index="1"] confirms the conversation has >=2 turns AND that the
    // indexing API still exists. Shape is now simple-hasSelector so future
    // drift of this anchor is auto-heal-patchable.
    id: 'session.chatTurnPrefix',
    category: 'pattern',
    description: 'chat-messages renders >=2 turn rows (data-index API)',
    requires: 'session',
    check: async (b) => ({ ok: await hasSelector(b, '[data-testid="chat-messages"] [data-index="1"]') })
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
    id: 'share.handoffMenuItem',
    category: 'share',
    description: 'Handoff-to-Claude-Code action (Share → Send to… tab → Claude Code row, or the legacy dropdown item)',
    requires: 'session',
    check: async (b) => {
      const opened = await b.evalValue<boolean>(
        `(() => { const btn = Array.from(document.querySelectorAll('button')).find(x => (x.textContent||'').trim() === 'Share'); if (!btn) return false; btn.click(); return true; })()`
      ).catch(() => false);
      if (!opened) return { ok: false, detail: 'Share button not clickable' };
      await new Promise((r) => setTimeout(r, 400));
      // Legacy layout (pre 2026-06): direct "Handoff to Claude Code" menu item.
      let found = await hasButtonMatching(b, /handoff to claude code/i);
      if (!found) {
        // 2026-06 layout: Share opens a tabbed dialog; handoff lives under the
        // "Send to…" tab as a "Claude Code" destination row with a Send button.
        // Only assert the row exists — clicking Send would mint a handoff link.
        const tabClicked = await b.evalValue<boolean>(
          `(() => { const tab = Array.from(document.querySelectorAll('button[role="tab"]')).find(t => /send to/i.test(t.textContent || '')); if (!tab) return false; tab.click(); return true; })()`
        ).catch(() => false);
        if (tabClicked) {
          await new Promise((r) => setTimeout(r, 400));
          found = await b.evalValue<boolean>(
            `(() => {
              const sends = Array.from(document.querySelectorAll('button')).filter(x => (x.textContent || '').trim() === 'Send');
              return sends.some(x => {
                let row = x;
                for (let i = 0; i < 3 && row.parentElement; i++) row = row.parentElement;
                return /claude code/i.test(row.textContent || '');
              });
            })()`
          ).catch(() => false);
        }
      }
      // close dialog/dropdown
      await b.evalValue<boolean>(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`).catch(() => null);
      return { ok: found, detail: found ? undefined : 'Share opened but no Claude Code handoff action (checked legacy item and Send to… tab)' };
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

      // The file-list panel renders a few seconds after navigation; scraping
      // immediately races it — the recurring false "0 filenames" the daily probe
      // filed (#64/#65/#68), even though `designer files` and a live scrape find
      // the files once the panel is up. Retry with a bounded settle before
      // concluding a regression.
      let files: string[] = [];
      for (let attempt = 0; attempt < 6; attempt++) {
        const result = await scrape();
        files = Array.isArray(result.files) ? result.files : [];
        if (files.length > 0) break;
        if (attempt < 5) await sleep(1000);
      }
      if (files.length === 0) {
        // With no file open the file-list panel may legitimately be absent — don't
        // hard-fail a soft anchor on an inconclusive state; only a populated
        // session (a file open) is expected to list filenames.
        if (!/[?&]file=/.test(url)) {
          return { ok: true, status: 'skip', detail: 'no file open; file-list panel not rendered — inconclusive' };
        }
        return { ok: false, detail: 'found 0 filenames after ~5s settle — scraper regex or DOM layout regressed' };
      }
      const match = url.match(/[?&]file=([^&]+)/);
      if (match && match[1]) {
        // Claude Design's URL bar form-encodes spaces as '+'. decodeURIComponent
        // only handles %xx, so normalize '+' → ' ' first before comparing
        // against the scraper's text-node output (which uses real spaces).
        const activeFile = decodeURIComponent(match[1].replace(/\+/g, ' '));
        if (!files.includes(activeFile)) {
          return {
            ok: false,
            detail: `active file "${activeFile}" not in scrape ([${files.slice(0, 3).join(', ')}...]) — scraper missing files`
          };
        }
      }
      return { ok: true, detail: `${files.length} file(s) detected` };
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
