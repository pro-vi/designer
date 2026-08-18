import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { REPO_ROOT } from './repo-root.ts';

// Single source of truth for the claude.ai/design DOM contract.
//
// Every consumer — the controller's verbs, the `designer health` anchors
// (ui-anchors.ts), and the `designer setup` sign-in verifier — reads selectors
// from HERE, so a drift repair in selectors.json (or a user override) propagates
// everywhere at once. The previous design hardcoded the same literals
// independently in each file, which drifted apart on every claude.ai redesign
// (e.g. login.signedIn kept probing a chat-composer-input testid the home had
// dropped). Keep DOM selectors in selectors.json, not inline literals.
// Canonical vs legacy. A comma-separated CSS list is not an ordered fallback —
// `querySelector('A, B')` returns whichever matches first in DOCUMENT ORDER. So
// canonical entries stay single-branch and superseded forms live in the
// `*Legacy` blocks, resolved explicitly and in order (see resolveBranches).
// This keeps a health anchor from staying green on the legacy branch after the
// canonical selector has rotted.
export interface Selectors {
  login: { signedInIndicator: string | null };
  loginLegacy?: { signedInIndicator?: string | null };
  homeLegacy?: {
    createButton?: string;
    projectsList?: string;
    projectCard?: string;
    wireframeButton?: string;
    highFiButton?: string;
  };
  composerLegacy?: { sendButton?: string };
  home: {
    creator: string;
    nameInput: string;
    // Creation-type cards. Twice re-keyed, each time onto whatever the product
    // was NOT renaming: label literals → `carousel-type-<kind>` testids (2026-07)
    // → the thumbnail asset slug `/grid-thumbs/<kind>.` (2026-08, when the
    // testids were removed outright). The slug is the surviving name for a card
    // whose label has now churned three times; see `_cards` in selectors.json.
    wireframeButton: string;
    highFiButton: string;
    createButton: string;
    projectsList: string;
    /** The project ROW container (canonical). */
    projectCard: string;
    /** The per-project link carrying the /design/p/<uuid> href. */
    projectLink: string;
  };
  composer: {
    promptTextarea: string;
    sendButton: string;
    stopButton: string | null;
    attachButton?: string;
    modelButton?: string;
  };
  // The "Pages" files switcher — the unified file surface (plain-HTML AND
  // .dc.html canvas views). Menu items / dialog buttons carry no testids and are
  // NOT selectors here: files-switcher.ts locates them by text inside
  // verify-and-stamp expressions and clicks the stamped node.
  files: {
    switcherTrigger: string;
    switcherRow: string;
    /** Hover-revealed per-row action button (aria-label keyed). */
    rowMoreActions: string;
    /** The file-delete confirm dialog container (canonical single-branch). */
    confirmDialog: string;
  };
  filesLegacy?: { confirmDialog?: string };
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
  // Content-only interstitial overlays have no stable testid; detection regexes
  // live in interstitials.ts. This optional block lets the one actionable button
  // text be overridden alongside the other anchors (~/.designer/selectors.override.json).
  interstitials?: { continueHere?: string };
  [k: string]: unknown;
}

function deepMerge(a: unknown, b: unknown): unknown {
  if (Array.isArray(a) || Array.isArray(b)) return b ?? a;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return b ?? a;
  const out: Record<string, unknown> = { ...(a as Record<string, unknown>) };
  for (const k of Object.keys(b as Record<string, unknown>))
    out[k] = deepMerge((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]);
  return out;
}

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

/**
 * Canonical-first, legacy-second, as an ORDERED list. Use when the caller acts
 * on the element (clicks it, fills it) — `querySelector('A, B')` would return
 * whichever is first in document order, which is not necessarily the canonical
 * one, and a stale duplicate could win.
 */
export function orderedBranches(canonical: string, legacy?: string | null): string[] {
  return legacy && legacy !== canonical ? [canonical, legacy] : [canonical];
}

/**
 * Canonical + legacy joined for a PRESENCE-only test ("is any of these here?").
 * Safe precisely because the caller does not care which element comes back.
 * Never use this to pick an element to act on — see orderedBranches.
 */
export function presenceSelector(canonical: string | null | undefined, legacy?: string | null): string {
  return [canonical, legacy].filter(Boolean).join(', ');
}

let _cached: Selectors | null = null;

// Memoized: selectors are immutable config, so resolve (read + override-merge)
// once per process and share the result across all consumers.
export function getSelectors(): Selectors {
  if (!_cached) _cached = loadSelectors();
  return _cached;
}
