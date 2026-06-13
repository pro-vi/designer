---
title: Network-first run-state observer for the designer MCP
type: feat
status: completed
date: 2026-06-11
origin: docs/trace-spike-findings.md
---

# Network-first run-state observer

## Context

The designer MCP (`designer_prompt` → `DesignerController.iterate`) currently decides a
design run is "done" with `waitForGenerationDone()`, which polls the served HTML every
1.5s and calls it finished after 4s of byte-stability. A CDP trace spike (7 real captures,
see `docs/trace-spike-findings.md`) showed this heuristic is both slower and wrong on a
whole class of runs: it has no signal when an agent run finishes **without changing the
served HTML**. Two live reproductions — a chat-only "noop" prompt and a tiny in-place edit —
both finished server-side in ~13–15s but `waitForGenerationDone` ground on toward its 20-min
timeout (1201s and 930s observed) and reported `failureMode: timeout` for runs that
succeeded.

The spike also revealed a clean network contract to key off instead. Generation is
Connect-RPC over protobuf against `anthropic.omelette.api.v1alpha.OmeletteService`:
- **`RenewTurn`** is a 10.0s metronome for the entire active run → RUNNING/liveness.
- **`ReleaseTurn`** fires exactly once at the end → a discrete FINISHED signal that beats
  the current heuristic by 5–10s on edits and fixes the no-HTML-change blind spot.
- **`Chat`** streams in fetch-chunked segments (one per agent step); intra-stream gaps max
  ~1.9s, so a >25s silence with no `RenewTurn` is a strong STALLED signal.
- The session quota limit is **advisory** (no hard network refusal up to 99%); the only
  network BLOCKED signal is a non-200 / `loadingFailed` on a critical RPC (mechanism
  confirmed by an incidental `409` on `UpdateProjectData`). There is **no DOM stop button**
  (0/177 samples), so DOM is weak corroboration only.

The input layer already exists: `cdp-trace.ts CdpTraceRecorder` attaches a second CDP client
to the design tab and dispatches Network/Page events. This plan promotes that into a **live**
observer feeding a state machine, replacing the wait loop's *completion decision* (not its
HTML fetch) while preserving the exact `done` shape `iterate` consumes.

## Architecture Decision

**Approach:** A live `RunStateObserver` sharing a CDP-attach base (`CdpSession`, extracted
from `CdpTraceRecorder`) feeds OmeletteService turn-RPC signals into a latched state machine.
`iterate` attaches it per-run before `sendPrompt`; the observer decides *when* the run is
done, then `iterate` does one final `fetchServedHtml` for the artifact — keeping the `done`
object byte-identical so nothing downstream changes. If attach fails for any reason,
`iterate` falls back to today's HTML-stability loop.

**Rationale:** *Consistency + simplicity.* The `done` contract
(`{ok, elapsedMs, html, iframeSrc, htmlBytes, error}`) is already what `iterate` consumes
(designer-controller.ts:479/492/498) — the observer produces the same object, so the
integration is a swap, not a rewrite. Extracting `CdpSession` (vs. duplicating the subtle
WS reconnect handshake) keeps one copy of the attach logic. RPC method names are far more
drift-stable than the styled-component DOM a stop-button approach would need.

**Trade-offs:** A second CDP client per prompt (cheap; must close on every exit path — named
as an invariant). Engines bump to `>=22` (Node 20 is EOL as of April 2026) to make native
`WebSocket` the default, with the runtime guard retained as a degradation trigger.

## High-Level Technical Design

Seam in `iterate` (directional, not implementation spec):

```
iterate(prompt):
  observer = RunStateObserver.attach()            // null on any failure → degrade
  sendPrompt(prompt)                               // observer.beginRun() stamps t0 at send
  done = observer
       ? _waitForGenerationDoneNetwork(observer)   // awaitTerminal → fetchServedHtml once
       : _waitForGenerationDoneHtml()              // today's loop, unchanged, renamed
  ...snapshotDesign({ html: done.html, ... })      // UNCHANGED — same done shape
  failureMode = derive(done, snap, newFiles)       // + 'stalled' | 'blocked' arms
```

State machine (single-run scope; terminal states latch):

```
                 ┌──────────── release ───────────► FINISHED ✓
   beginRun      │
 ──────────► RUNNING ⇄ STALLED        (chat-open/chunk/heartbeat ⇒ RUNNING;
                 │   ▲   │             silence>stallMs ⇒ STALLED; recovery ⇒ RUNNING)
                 │   └───┘
                 ├── critical-error ─► BLOCKED ✗   (non-200 / loadingFailed on Chat|RenewTurn)
                 ├── silence>hardTimeout ─► FAILED(timeout) ✗
                 └── observer-lost ─► (iterate degrades to HTML loop for remaining budget)
```

Signal taxonomy — a first-class discriminated union (U2). `classifyEvent(method, params,
runStartTs)` maps a raw CDP event to one or none:

```
type RunSignal =
  | { kind: 'chat-open' }        // requestWillBeSent  …/OmeletteService/Chat
  | { kind: 'chat-chunk' }       // dataReceived for a tracked Chat requestId
  | { kind: 'heartbeat' }        // requestWillBeSent  …/OmeletteService/RenewTurn
  | { kind: 'release' }          // requestWillBeSent  …/OmeletteService/ReleaseTurn
  | { kind: 'critical-error'; rpc: string; status: number | 'failed' }
  | { kind: 'observer-lost' }    // emitted by CdpSession on reconnect-failure
```

## Implementation Units

### U1. Extract `CdpSession` base from `CdpTraceRecorder`

- **Goal:** Factor CDP attach + WS lifecycle + `send()`/dispatch + reconnect into a reusable
  base with a protected `onEvent(method, params, sessionId?)` hook; refactor
  `CdpTraceRecorder` to extend it. Behavior-preserving.
- **Requirements:** Foundation for U3 (don't duplicate the reconnect handshake).
- **Dependencies:** None.
- **Files:** Modify: `cdp-trace.ts` (extract base; `CdpTraceRecorder extends CdpSession`,
  `onEvent` = current `handleEvent` body minus file-stream concerns). Keep
  `findDesignTarget`/`listTargets`/`redact` exported as-is.
- **Approach:** `CdpSession` owns `ws`, `send()`, `onMessage` (id-routing + dispatch to
  `onEvent`), `handleClose`/reconnect, `close()`. `CdpTraceRecorder` keeps the JSONL sink
  (allowlist, `shapePayloads`, `redact`, `writeLine`, body capture) in its `onEvent`
  override. Protected hook signature **identical** for both subclasses — no adapter.
- **Patterns to follow:** `cdp-trace.ts:287-338` (send/onMessage/handleEvent), `:430-470`
  (handleClose/reconnect).
- **Test scenarios:**
  - *Happy path:* re-run `npm run trace -- idle --minutes 1` and a `success` capture; event
    counts and `byMethod`/`droppedByMethod` match a pre-refactor baseline.
  - *Edge case:* kill+restore the target mid-idle-trace → a `reconnect` recorder event still
    lands.
- **Verification:** The spike's three scripts produce equivalent traces; no JSONL schema change.

### U2. `RunSignal` union + pure `classifyEvent` mapper

- **Goal:** Define the discriminated union and a pure `(method, params, runStartTs)` →
  `RunSignal | null` mapper, with a stale-signal guard (ignore events before `runStartTs`).
- **Requirements:** Typed taxonomy the state machine and tests share.
- **Dependencies:** None.
- **Files:** Create: `run-state.ts` (union + `classifyEvent`). Test:
  `tests/run-state.classify.test.mjs`.
- **Approach:** Match on RPC suffix (`OmeletteService/Chat|RenewTurn|ReleaseTurn`) and on
  non-200 `responseReceived` / `loadingFailed` for the critical set. Pure + synchronous —
  feed it recorded lines from the 7 captured traces.
- **Patterns to follow:** `scripts/trace-analyze.ts:334-345` (the `byRpc` suffix match), lifted
  to a typed mapper.
- **Test scenarios:**
  - *Happy path:* replay `success` trace → ≥1 `chat-open`, multiple `heartbeat`, exactly one
    `release`.
  - *Edge case:* event with `ts < runStartTs` → `null` (stale-guard).
  - *Error path:* `loadingFailed` on `Chat` → `critical-error`; the incidental `409` on
    `UpdateProjectData` (non-critical) → `null`.
- **Verification:** Classifier output over each captured trace matches the hand-analyzed
  lifecycle in `docs/trace-spike-findings.md`.

### U3. `RunStateObserver extends CdpSession` — the state machine

- **Goal:** Consume `RunSignal`s; expose `beginRun()`, a `state` getter, and
  `awaitTerminal({stallMs=25_000, hardTimeoutMs=20*60_000})` →
  `{terminal: 'finished'|'blocked'|'timeout'|'observer-lost', elapsedMs, reason?}`.
- **Requirements:** RUNNING/FINISHED/STALLED/BLOCKED contract.
- **Dependencies:** U1, U2.
- **Files:** Modify: `run-state.ts` (add observer). Test: `tests/run-state.machine.test.mjs`.
- **Approach:** `onEvent` → `classifyEvent` → reducer over the matrix below. STALLED is a
  **transient reported** state (silence > `stallMs`), not terminal; only `hardTimeoutMs` of
  continuous silence is terminal `timeout`. A watchdog `tick` drives silence checks. Terminal
  latches.
- **Patterns to follow:** `cdp-trace.ts` static `attach` shape for the observer's own attach.
- **Test scenarios:** see matrix; each cell names a test.
- **Verification:** All invariants hold; replaying each of the 7 traces yields the expected
  terminal.

State-action matrix (states: `running`, `stalled`; terminals latch):

| action | running | stalled |
|---|---|---|
| chat-open / chat-chunk / heartbeat | advance `lastActivity`; stay `running`; `t_running_activity` | advance `lastActivity`; → `running` (recovery); `t_stall_recovery` |
| release (after ≥1 prior run-signal) | → **FINISHED** (latch); resolve `awaitTerminal`; `t_release_finishes` | → **FINISHED** (latch); `t_release_from_stall` |
| release (no prior run-signal) | ignore — stale guard; stays `running`; `t_stale_release_ignored` | n/a |
| critical-error | → **BLOCKED**(rpc,status) (latch); `t_chat_500_blocks` | → **BLOCKED** (latch); `t_blocked_from_stall` |
| tick: silence > stallMs | → `stalled` (reported, keep waiting); `t_silence_marks_stalled` | stay `stalled`; `t_stall_persists` |
| tick: silence > hardTimeoutMs | → **FAILED(timeout)** (latch); `t_hard_timeout` | → **FAILED(timeout)** (latch); `t_stall_to_timeout` |
| observer-lost | → **observer-lost** (latch); `t_ws_dead_degrades` | → **observer-lost** (latch); `t_ws_dead_from_stall` |

Invariants (locked by tests, enforced atomically in one synchronous block per transition):
- `terminal !== null` is latched — once set, no action mutates it.
- `state === 'finished' iff a release signal was consumed after ≥1 prior run-signal of this run`.
- `lastActivity advances iff signal ∈ {chat-open, chat-chunk, heartbeat}`.
- `the WS is closed exactly once` — on `awaitTerminal` resolution **or** explicit `close()`,
  never both, never zero (leak prevention).

Omitted-state challenge: (1) *release while already FINISHED* → ignored by latch
(`t_double_release_noop`). (2) *critical-error after FINISHED* (late failed asset) → ignored
by latch; must not flip finished→blocked (`t_late_error_after_finish`).

### U4. Wire observer into `DesignerController`

- **Goal:** Add `_waitForGenerationDoneNetwork(observer)`, rename current method to
  `_waitForGenerationDoneHtml`, add the dispatcher, attach in `iterate` with graceful
  fallback, extend `FailureMode` derivation.
- **Requirements:** The replacement + the blind-spot fix.
- **Dependencies:** U3.
- **Files:** Modify: `designer-controller.ts` (~379-524), `FailureMode` type at `:62`.
- **Approach:** `_waitForGenerationDoneNetwork` = `await observer.awaitTerminal()` → on
  `finished`: one `fetchServedHtml` with a single ~1.5s settle-refetch if it changed → return
  `{ok:true, html, iframeSrc, htmlBytes, elapsedMs}`. `blocked`→`{ok:false, error:'blocked',
  reason}`; `timeout`→`{ok:false, error:'timeout'}`; `observer-lost`→ caller degrades.
  `iterate` attaches before `sendPrompt`, `close()`s in a `finally` (all paths). The
  `no_change` derivation at `:498` now fires correctly for chat-only runs (FINISHED + html
  unchanged) instead of timeout — the blind-spot fix, free, because that line already handles
  it once `done.ok` is true.
- **Patterns to follow:** existing `iterate` body; `fetchServedHtml` usage at `:411`.
- **Test scenarios:**
  - *Happy path (create):* network wait returns `ok:true` within ~settle of ReleaseTurn;
    snapshot identical to HTML-path result.
  - *Error path (noop / tiny-edit blind spot):* finishes at ReleaseTurn; `iterate` returns
    `failureMode:'no_change'` in seconds, **not** `timeout` at 20min.
  - *Edge case (observer-lost mid-run):* falls back to `_waitForGenerationDoneHtml` for the
    remaining budget; still returns a valid `done`.
  - *Integration:* observer WS closed after every iterate (no FD leak across 3 sequential
    prompts).
- **Verification:** `iterate` returns the same `IterateResult` shape; noop no longer times out.

### U5. Extend `FailureMode` surface + MCP description

- **Goal:** Add `'stalled' | 'blocked'` to `FailureMode`; update the `designer_prompt` tool
  doc so callers know `no_change` now reliably means "chat-only reply" (no longer masked as
  `timeout`), and what `stalled`/`blocked` mean.
- **Requirements:** Public-surface accuracy.
- **Dependencies:** U4.
- **Files:** Modify: `designer-controller.ts:62` (type), `mcp-server.ts:44-65` (description).
- **Approach:** Additive union widening — existing switches still compile.
- **Test scenarios:** *Test expectation: none — type widening + doc string; behavior covered
  by U4.*
- **Verification:** `npm run check` clean; MCP description lists all five `failureMode` values.

### U6. Engines bump to `>=22`, retain runtime guard

- **Goal:** Set `engines.node: ">=22"`; keep the `typeof WebSocket === 'undefined'` guard as
  the degradation trigger (not a hard throw at the controller layer).
- **Requirements:** Native WebSocket as the default path; no `ws` dep.
- **Dependencies:** None (can land first).
- **Files:** Modify: `package.json:57-59`. Verify: `scripts/install-smoke.sh`.
- **Approach:** Node 20 is EOL (April 2026); bump justified. Observer attach returns null on
  guard failure → degrade.
- **Test scenarios:** *Test expectation: none — manifest change; smoke covers install.*
- **Verification:** `npm run smoke` green on dev Node (24); engines reflects reality.

### U7. Health anchor for the turn-RPC names

- **Goal:** Add a `ui-anchors.ts` anchor asserting the OmeletteService turn RPCs
  (`Chat`/`RenewTurn`/`ReleaseTurn`, `v1alpha` path) are still the live contract, so a rename
  is caught by daily CI — the observer's one real drift surface.
- **Requirements:** Drift mitigation paired with detection (the spike's stated discipline).
- **Dependencies:** U3.
- **Files:** Modify: `ui-anchors.ts` (new anchor), `scripts/ci-health.ts` (exercise in the
  session phase via a brief observer attach + tiny canary prompt).
- **Approach:** Anchor `network.turnRpcContract`, `requires:'session'`, `category:'pattern'`
  — attaches the observer, fires a trivial canary prompt, asserts heartbeat/release signals;
  degrades to `skip` (not `fail`) if CDP attach unavailable.
- **Patterns to follow:** `ui-anchors.ts:26-32` (AnchorDef), multi-phase anchor at `:252-298`;
  CI wiring at `scripts/ci-health.ts:287-310`.
- **Test scenarios:**
  - *Happy path:* canary prompt → anchor `ok`, detail "heartbeat ×N, release seen".
  - *Error path:* RPC suffix not observed → `fail` with the observed method list.
  - *Edge case:* no CDP / no canary project → `skip`, never `fail`.
- **Verification:** `npm run probe:health` includes the anchor; a simulated rename fails loudly.

## Scope Boundaries

- **Not** replacing `fetchServedHtml` or `snapshotDesign` — the observer decides *when*; HTML
  stays the artifact source.
- **Not** a network-level quota-BLOCKED detector — the limit is advisory with no hard refusal
  up to 99%; observer `BLOCKED` is critical-RPC-failure only.
- **Not** persisting live observer events to disk — that's the JSONL recorder's job; the
  observer is in-memory.

### Deferred to Follow-Up Work
- **Quota-banner reader** (the `BLOCKED`-via-banner path, both "weekly"/"session" axes): a
  separate controller DOM probe + a `quota` status field — its own PR.
- **`designer_ask` parity:** route the same observer through the text-only ask path (currently
  a separate timeout-only wait).

## System-Wide Impact

- **Interaction graph:** `mcp-server.ts designer_prompt → iterate → wait(dispatch) → observer
  | html-loop`. Only the wait node changes; `snapshotDesign`, `saveIteration`, `getChatTurns`
  untouched.
- **Error propagation:** observer failures never throw into `iterate` — they resolve to
  `observer-lost` and degrade. Critical-RPC errors surface as `failureMode:'blocked'`
  (additive).
- **State lifecycle risks:** the per-prompt WS must close on every exit path (U3/U4 invariant);
  a leaked client across many prompts is the main hazard, locked by the FD-leak integration
  test.
- **API surface parity:** `designer_ask` has its own wait (deferred); `iterate` is the only
  consumer changing now.
- **Unchanged invariants:** `IterateResult` shape; `done.html`-sourced snapshot; the
  HTML-stability path (still present as fallback, byte-for-byte).

## Risks & Dependencies

| Risk | Mitigation |
|---|---|
| OmeletteService renamed / `v1alpha` revs | U7 health anchor fails loudly daily; classifier is one file to update |
| ReleaseTurn fires before final HTML/CDN settle | Post-FINISHED single settle-refetch (~1.5s) before snapshot |
| Second CDP client leaks across prompts | `close()` in `iterate` `finally`; FD-leak integration test |
| Engines `>=22` breaks a Node-20 consumer | Node 20 is EOL; documented; runtime guard still degrades |
| False STALLED on a legitimately slow step | STALLED is transient/reported, not terminal; only hard-timeout fails |

## Confidence Cross-Check

Bug-trace (against the two reproduced blind-spots):

| Reproduced bug | Contract clause | Cell behavior | Expected | Match? |
|---|---|---|---|---|
| noop chat-only → `timeout` @1201s | release → FINISHED regardless of HTML change (U3); `no_change` derive (U4) | ReleaseTurn +15s → finished → `no_change` | fast, `no_change` | ✓ |
| tiny edit → stuck 930s | same + post-FINISHED settle-refetch | ReleaseTurn +13s → finished → snapshot | done ~ReleaseTurn+settle | ✓ |

Integration-shape: `_waitForGenerationDoneNetwork` returns
`{ok, elapsedMs, html, iframeSrc, htmlBytes, error}` — the exact object `iterate` destructures
at designer-controller.ts:479/492 (no `as any`, no widening). `RunStateObserver` and
`CdpTraceRecorder` both override `CdpSession.onEvent(method, params, sessionId?)` with an
identical signature — no bridge. `FailureMode` widening is additive.
