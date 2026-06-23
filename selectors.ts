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

let _cached: Selectors | null = null;

// Memoized: selectors are immutable config, so resolve (read + override-merge)
// once per process and share the result across all consumers.
export function getSelectors(): Selectors {
  if (!_cached) _cached = loadSelectors();
  return _cached;
}
