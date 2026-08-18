// AST-driven mutator for the selector an anchor probes. Finds an anchor block by
// `id` and resolves WHERE that selector actually lives, which is one of two
// places.
//
// V1 — an inline string literal in ui-anchors.ts:
//   check: async (b) => ({ ok: await hasSelector(b, '<sel>') })
// Rewritten in place, preserving the rest of the file byte-for-byte.
//
// V2 — a key in selectors.json, reached through the shared `SEL` object:
//   check: async (b) => ({ ok: await hasSelector(b, SEL.home.creator) })
//   check: async (b) => checkWithLegacy(b, SEL.home.createButton, SEL.homeLegacy?.createButton, '…')
// Resolved to a key PATH (['home','creator']) for the caller to rewrite in
// selectors.json. V2 exists because centralizing selectors there — a correct
// decision — removed every literal V1 could rewrite, so auto-heal could not
// patch a single anchor for months while reporting success (#129 item 0).
//
// The two are deliberately different `kind`s rather than one uniform target,
// because they carry different risk. A V1 patch touches the health probe only.
// A V2 patch touches the contract EVERY consumer reads — the controller's verbs
// and the sign-in verifier as much as the probe — so its caller owes a
// whole-suite non-regression check that V1 never needed.
//
// Still rejected: `hasButtonMatching`, custom `evalValue` walkers, and
// block-bodied checks with URL guards. Those have no single selector to swap.

import ts from 'typescript';

export interface AnchorMatch {
  kind: 'literal';
  /** Byte offset of the string-literal node start (INCLUDING opening quote). */
  literalStart: number;
  /** Byte offset of the string-literal node end (EXCLUSIVE; one past closing quote). */
  literalEnd: number;
  /** The quote character used by the original literal: `'`, `"`, or `` ` ``. */
  quote: "'" | '"' | '`';
  /** Decoded (unquoted) string content. */
  currentSelector: string;
}

export interface SelectorsKeyMatch {
  kind: 'selectors-key';
  /** Key path into selectors.json, e.g. ['home','wireframeButton']. */
  path: string[];
}

export type AnchorTarget = AnchorMatch | SelectorsKeyMatch;

/**
 * V1 finder: the inline string literal, or null. Kept as its own export because
 * "is there a literal to rewrite in ui-anchors.ts" is a distinct question from
 * "can this anchor be patched at all" — and answering the first with the second
 * is what would silently mispatch a `SEL.*` anchor.
 */
export function findAnchor(source: string, id: string): AnchorMatch | null {
  const t = findAnchorTarget(source, id);
  return t?.kind === 'literal' ? t : null;
}

/** V1 literal OR V2 selectors.json key — whichever this anchor's check uses. */
export function findAnchorTarget(source: string, id: string): AnchorTarget | null {
  const sf = ts.createSourceFile('ui-anchors.ts', source, ts.ScriptTarget.Latest, true);
  let result: AnchorTarget | null = null;

  const visit = (node: ts.Node): void => {
    if (result) return;
    if (ts.isObjectLiteralExpression(node) && matchesAnchorWithId(node, id)) {
      const checkProp = findProperty(node, 'check');
      if (checkProp) {
        const arg = extractCanonicalSelectorArg(checkProp.initializer);
        if (arg) result = describeTarget(arg, sf);
      }
      return; // don't recurse into the matched anchor
    }
    ts.forEachChild(node, visit);
  };

  visit(sf);
  return result;
}

export function canPatch(source: string, id: string): boolean {
  return findAnchorTarget(source, id) !== null;
}

/**
 * Rewrite one selectors.json value, identified by key path.
 *
 * Parse → mutate → re-stringify is safe here for a property this repo asserts in
 * test: selectors.json is byte-identical to `JSON.stringify(parsed, null, 2)`,
 * so the only textual change is the value being replaced. Splicing raw text at
 * an offset would be worse, not better — it has to re-implement string escaping
 * that JSON.stringify already gets right.
 *
 * Fails closed rather than creating structure: the path must already exist and
 * already hold a string. Auto-heal repairs a selector that drifted; it never
 * invents a contract entry, and it must never overwrite a nested object.
 */
export function patchSelectorsJson(jsonText: string, path: string[], newSelector: string): string {
  if (path.length === 0) throw new Error('patchSelectorsJson: empty key path');
  const root = JSON.parse(jsonText) as Record<string, unknown>;
  let cursor: Record<string, unknown> = root;
  for (const key of path.slice(0, -1)) {
    const next = cursor[key];
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      throw new Error(`patchSelectorsJson: ${path.join('.')} — "${key}" is not an object`);
    }
    cursor = next as Record<string, unknown>;
  }
  const leaf = path[path.length - 1] as string;
  if (typeof cursor[leaf] !== 'string') {
    throw new Error(
      `patchSelectorsJson: ${path.join('.')} is ${cursor[leaf] === undefined ? 'absent' : typeof cursor[leaf]}, expected a string selector`
    );
  }
  cursor[leaf] = newSelector;
  return JSON.stringify(root, null, 2) + '\n';
}

/** Read the current value at a selectors.json key path (null if absent). */
export function readSelectorsKey(jsonText: string, path: string[]): string | null {
  let cursor: unknown = JSON.parse(jsonText);
  for (const key of path) {
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) return null;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return typeof cursor === 'string' ? cursor : null;
}

/** V1: rewrite the inline literal in ui-anchors.ts. Selector-key anchors are
 *  patched through patchSelectorsJson instead — this throws for them rather
 *  than silently doing nothing. */
export function patchSelector(source: string, id: string, newSelector: string): string {
  const match = findAnchor(source, id);
  if (!match) {
    throw new Error(
      `anchor-patcher: id "${id}" has no inline literal to rewrite — it is either absent, a complex check, or reads SEL.* (patch selectors.json instead)`
    );
  }
  const escaped = escapeForQuote(newSelector, match.quote);
  return (
    source.slice(0, match.literalStart) +
    match.quote +
    escaped +
    match.quote +
    source.slice(match.literalEnd)
  );
}

// ---- internals ----

function matchesAnchorWithId(obj: ts.ObjectLiteralExpression, id: string): boolean {
  const idProp = findProperty(obj, 'id');
  if (!idProp) return false;
  const init = idProp.initializer;
  if (ts.isStringLiteralLike(init)) {
    return init.text === id;
  }
  return false;
}

function findProperty(
  obj: ts.ObjectLiteralExpression,
  name: string
): ts.PropertyAssignment | null {
  for (const p of obj.properties) {
    if (!ts.isPropertyAssignment(p)) continue;
    const n = p.name;
    if (ts.isIdentifier(n) && n.text === name) return p;
    if (ts.isStringLiteral(n) && n.text === name) return p;
  }
  return null;
}

/**
 * Pull the CANONICAL selector expression out of a check, for the two shapes that
 * have exactly one such expression:
 *
 *   async (b) => ({ ok: await hasSelector(b, <canonical>) })
 *   async (b) => checkWithLegacy(b, <canonical>, <legacy>, '<label>')
 *
 * The legacy argument is deliberately NOT a patch target. It records what the
 * selector USED to be, so a drifted page reports `degraded` instead of `fail`;
 * rewriting it would erase that history and let auto-heal quietly agree with
 * itself twice.
 */
function extractCanonicalSelectorArg(expr: ts.Expression): ts.Expression | null {
  if (!ts.isArrowFunction(expr)) return null;

  let body: ts.Node = expr.body;
  if (ts.isParenthesizedExpression(body)) body = body.expression;
  // `checkWithLegacy(...)` may or may not be awaited; both return the verdict.
  if (ts.isAwaitExpression(body)) body = body.expression;

  if (ts.isCallExpression(body)) return checkWithLegacyCanonical(body);

  if (!ts.isObjectLiteralExpression(body)) return null;
  // Exactly one property named `ok` — a check that also computes `detail` or
  // `status` has logic beyond the selector, and swapping the selector under it
  // is not a repair we can reason about.
  if (body.properties.length !== 1) return null;
  const okProp = body.properties[0];
  if (!okProp || !ts.isPropertyAssignment(okProp)) return null;
  if (!ts.isIdentifier(okProp.name) || okProp.name.text !== 'ok') return null;

  let okValue: ts.Expression = okProp.initializer;
  if (ts.isAwaitExpression(okValue)) okValue = okValue.expression;
  if (!ts.isCallExpression(okValue)) return null;

  const callee = okValue.expression;
  if (!ts.isIdentifier(callee)) return null;
  if (callee.text === 'checkWithLegacy') return checkWithLegacyCanonical(okValue);
  if (callee.text !== 'hasSelector') return null;

  // Args: (b, <canonical>)
  if (okValue.arguments.length !== 2) return null;
  const [arg0, arg1] = okValue.arguments;
  if (!arg0 || !arg1) return null;
  if (!ts.isIdentifier(arg0) || arg0.text !== 'b') return null;
  return arg1;
}

function checkWithLegacyCanonical(call: ts.CallExpression): ts.Expression | null {
  if (!ts.isIdentifier(call.expression) || call.expression.text !== 'checkWithLegacy') return null;
  // (browser, canonical, legacy, label)
  if (call.arguments.length < 2) return null;
  const [arg0, canonical] = call.arguments;
  if (!arg0 || !canonical) return null;
  if (!ts.isIdentifier(arg0) || arg0.text !== 'b') return null;
  return canonical;
}

/** Classify the canonical expression as an inline literal or a selectors.json key. */
function describeTarget(arg: ts.Expression, sf: ts.SourceFile): AnchorTarget | null {
  if (ts.isStringLiteralLike(arg)) {
    const quote = detectQuote(arg.getText(sf));
    if (!quote) return null;
    return {
      kind: 'literal',
      literalStart: arg.getStart(sf),
      literalEnd: arg.getEnd(),
      quote,
      currentSelector: arg.text
    };
  }
  const path = selectorsKeyPath(arg);
  return path ? { kind: 'selectors-key', path } : null;
}

/**
 * `SEL.home.wireframeButton` -> ['home','wireframeButton'].
 *
 * The root identifier must literally be `SEL` (ui-anchors.ts's binding for the
 * loaded selectors) — anything else is some other object and must not be
 * mistaken for a contract key. Optional chaining is accepted because the legacy
 * blocks are optional (`SEL.homeLegacy?.createButton`), though only canonical
 * arguments reach here.
 */
function selectorsKeyPath(expr: ts.Expression): string[] | null {
  const parts: string[] = [];
  let cursor: ts.Expression = expr;
  while (ts.isPropertyAccessExpression(cursor)) {
    if (!ts.isIdentifier(cursor.name)) return null;
    parts.unshift(cursor.name.text);
    cursor = cursor.expression;
  }
  if (!ts.isIdentifier(cursor) || cursor.text !== 'SEL') return null;
  if (parts.length === 0) return null;
  // Structural refusal of the legacy blocks, not a positional one.
  //
  // Today nothing produces a legacy target: extractCanonicalSelectorArg reads
  // argument index 1 of checkWithLegacy, which is the canonical one. That means
  // the "never rewrite the superseded selector" invariant currently rests on
  // argument ORDER — reorder the parameters, or add a check shaped
  // `hasSelector(b, SEL.homeLegacy?.createButton)`, and the patcher would
  // happily erase the record that lets a rolled-back page report `degraded`
  // instead of `fail`. Make the refusal a property of the key path itself.
  if (isLegacyGroup(parts[0])) return null;
  return parts;
}

/** `homeLegacy`, `loginLegacy`, `composerLegacy`, `filesLegacy` — the superseded-selector blocks. */
export function isLegacyGroup(group: string | undefined): boolean {
  return typeof group === 'string' && group.endsWith('Legacy');
}

/** The `*Legacy` block paired with a canonical group, e.g. `home` -> `homeLegacy`. */
export function legacyPathFor(path: string[]): string[] | null {
  if (path.length !== 2) return null;
  const [group, leaf] = path as [string, string];
  return isLegacyGroup(group) ? null : [`${group}Legacy`, leaf];
}

function detectQuote(literalText: string): "'" | '"' | '`' | null {
  const first = literalText[0];
  if (first === "'" || first === '"' || first === '`') return first;
  return null;
}

function escapeForQuote(s: string, quote: "'" | '"' | '`'): string {
  // Backslash always escapes; the specific quote character escapes; for
  // backticks we also escape `${` to avoid accidental template substitution.
  let out = s.replace(/\\/g, '\\\\');
  if (quote === "'") out = out.replace(/'/g, "\\'");
  else if (quote === '"') out = out.replace(/"/g, '\\"');
  else {
    out = out.replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
  }
  return out;
}
