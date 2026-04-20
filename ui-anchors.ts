import type { Browser } from './browser.ts';

// Every UI anchor this MCP depends on to work. Grouped by the surface state
// they live on. A regression in Claude Design's UI will trip one or more of
// these; `designer health` walks all of them and reports what broke.

export type AnchorCategory = 'home' | 'session' | 'share' | 'pattern';
export type AnchorState = 'home' | 'session' | 'any';
export type ProbeStatus = 'ok' | 'fail' | 'skip';

export interface ProbeResult {
  id: string;
  category: AnchorCategory;
  description: string;
  requires: AnchorState;
  status: ProbeStatus;
  detail?: string;
}

interface AnchorDef {
  id: string;
  category: AnchorCategory;
  description: string;
  requires: AnchorState;
  check: (browser: Browser, currentUrl: string) => Promise<{ ok: boolean; detail?: string }>;
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

export const UI_ANCHORS: AnchorDef[] = [
  // --- home page ---
  {
    id: 'home.creator',
    category: 'home',
    description: 'project-creator container',
    requires: 'home',
    check: async (b) => ({ ok: await hasSelector(b, '[data-testid="project-creator"]') })
  },
  {
    id: 'home.nameInput',
    category: 'home',
    description: 'project-name input',
    requires: 'home',
    check: async (b) => ({ ok: await hasSelector(b, 'input[placeholder="Project name"]') })
  },
  {
    id: 'home.wireframeButton',
    category: 'home',
    description: 'Wireframe fidelity button',
    requires: 'home',
    check: async (b) => ({ ok: await hasButtonMatching(b, /^Wireframe/) })
  },
  {
    id: 'home.highFiButton',
    category: 'home',
    description: 'High fidelity button',
    requires: 'home',
    check: async (b) => ({ ok: await hasButtonMatching(b, /^High fidelity/) })
  },
  {
    id: 'home.createButton',
    category: 'home',
    description: 'create-project button',
    requires: 'home',
    check: async (b) => ({ ok: await hasSelector(b, '[data-testid="create-project-button"]') })
  },
  {
    id: 'home.projectsList',
    category: 'home',
    description: 'projects-list container',
    requires: 'home',
    check: async (b) => ({ ok: await hasSelector(b, '[data-testid="projects-list"]') })
  },
  {
    id: 'home.projectCard',
    category: 'home',
    description: 'project-card (at least one)',
    requires: 'home',
    check: async (b) => ({ ok: await hasSelector(b, '[data-testid="project-card"]') })
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
    id: 'session.sendButton',
    category: 'session',
    description: 'send button',
    requires: 'session',
    check: async (b) => ({ ok: await hasSelector(b, '[data-testid="chat-send-button"]') })
  },
  {
    id: 'session.htmlViewerIframe',
    category: 'session',
    description: 'html-viewer-iframe (design preview)',
    requires: 'session',
    check: async (b) => ({ ok: await hasSelector(b, '[data-testid="html-viewer-iframe"]') })
  },
  {
    id: 'session.chatMessages',
    category: 'session',
    description: 'chat-messages container',
    requires: 'session',
    check: async (b) => ({ ok: await hasSelector(b, '[data-testid="chat-messages"]') })
  },
  {
    id: 'session.iframeSrcPattern',
    category: 'pattern',
    description: 'iframe src is claudeusercontent.com with signed ?t= token',
    requires: 'session',
    check: async (b) => {
      const src = await b.evalValue<string>(
        `(() => { const el = document.querySelector('[data-testid="html-viewer-iframe"]'); return (el && el.src) || ''; })()`
      ).catch(() => '');
      if (!src) return { ok: false, detail: 'no iframe src (is a file open?)' };
      const ok = /claudeusercontent\.com/.test(src) && /[?&]t=/.test(src);
      return { ok, detail: ok ? undefined : `src=${src.slice(0, 120)}...` };
    }
  },
  {
    id: 'session.chatTurnPrefix',
    category: 'pattern',
    description: "chat turns prefixed with 'You\\n' / 'Claude\\n'",
    requires: 'session',
    check: async (b) => {
      const sample = await b.evalValue<string>(
        `(() => { const c = document.querySelector('[data-testid="chat-messages"]'); const inner = c && c.children[0]; if (!inner) return ''; return Array.from(inner.children).slice(0, 3).map(d => (d.innerText||'').slice(0, 40)).join('|'); })()`
      ).catch(() => '');
      if (!sample) return { ok: false, detail: 'no chat turns' };
      const ok = /(^|\|)(You|Claude)(\\n|\n|$)/.test(sample) || /You\n|Claude\n/.test(sample);
      return { ok, detail: ok ? undefined : `first turns: ${sample.slice(0, 120)}` };
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
    id: 'share.handoffMenuItem',
    category: 'share',
    description: 'Handoff-to-Claude-Code menu item (inside Share dropdown)',
    requires: 'session',
    check: async (b) => {
      const opened = await b.evalValue<boolean>(
        `(() => { const btn = Array.from(document.querySelectorAll('button')).find(x => (x.textContent||'').trim() === 'Share'); if (!btn) return false; btn.click(); return true; })()`
      ).catch(() => false);
      if (!opened) return { ok: false, detail: 'Share button not clickable' };
      await new Promise((r) => setTimeout(r, 400));
      const found = await hasButtonMatching(b, /handoff to claude code/i);
      // close dropdown
      await b.evalValue<boolean>(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`).catch(() => null);
      return { ok: found, detail: found ? undefined : 'Share opened but no Handoff-to-Claude-Code item' };
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
  }
];

export async function runHealth(
  browser: Browser,
  opts: { sessionProbeUrl?: string } = {}
): Promise<ProbeResult[]> {
  const currentUrl = (await browser.url().catch(() => '')) || '';
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
      results.push({ ...base, status: r.ok ? 'ok' : 'fail', detail: r.detail });
    } catch (e) {
      results.push({ ...base, status: 'fail', detail: `threw: ${(e as Error).message}` });
    }
  }
  return results;
}
