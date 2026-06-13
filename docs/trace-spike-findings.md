# CDP trace spike — findings

_Captured 2026-06-11 against claude.ai/design (Chrome 149). Grounds the future
network-first run-state observer. Tooling: `cdp-trace.ts`, `scripts/trace-spike.ts`,
`scripts/trace-analyze.ts`. Raw traces under `artifacts/trace/` (gitignored)._

## What we set out to learn

How does the design surface stream generation traffic, and what network signal
should a RUNNING / FINISHED / STALLED / BLOCKED observer key off — instead of the
current `waitForGenerationDone()` heuristic, which polls the served HTML every 1.5s
and calls it done after 4s of byte-stability.

## Captures

| scenario | elapsed | failureMode | files | events |
|---|---|---|---|---|
| create (aurora hero) | 254s | null | NOCTURNE.html | 1082 |
| edit (interactive) | 73s | null | (in-place) | 545 |
| multi-file (tokens + 2nd page) | 384s | null | tokens.css, aurora.css, sessions.html | 1776 |
| noop (chat-only) | **1201s (timeout)** | **timeout** | none | 930 |
| tweak (decisive, small) | 34s | null | (in-place) | 255 |
| idle (3 min baseline) | 180s | — | — | 49 |
| quota | — | — | — | 111 |

## Headline findings

### 1. Generation is Connect-RPC over protobuf, not SSE

The surface talks to `anthropic.omelette.api.v1alpha.OmeletteService` via Connect-RPC.
Generation streams over **`POST .../OmeletteService/Chat`**, `mimeType:
application/connect+proto`, body delivered as **fetch-chunked** `dataReceived` events
(no `Content-Length`, no `EventSource`). So:

- `eventSourceMessageReceived` never fires — as predicted. **Chunk size/timing is the
  ground truth**, exactly what the recorder was built to record as primary.
- A run is **many `Chat` segments**, one per agent step (create: 23 segments; multi-file:
  45; noop: 1). Watching a single request open/close is not enough — the observer must
  track the segment _series_, not one stream.

### 2. `ReleaseTurn` is the discrete FINISHED signal — and it beats the current heuristic

The server holds a turn lease for the whole run. Observed every time:

- **`RenewTurn` is a 10.0s metronome** for the entire active run (create: 25 calls;
  multi-file: 38 calls; tweak: 2 calls — median gap 10.0s in every case, first ~14.5s
  in, last call ~at end). This is a clean **RUNNING / liveness** heartbeat.
- **`ReleaseTurn` fires exactly once, at the end** — the discrete **FINISHED** event.

How `ReleaseTurn` compares to the controller's HTML-stability verdict (`iterate-done`):

| run | ReleaseTurn | vs controller verdict |
|---|---|---|
| create | +261.3s | −0.3s (basically tied) |
| edit | +74.6s | **led by 5.3s** |
| multi-file | +391.5s | −0.9s (tied) |
| tweak | +31.0s | **led by 9.7s** |

On in-place edits `ReleaseTurn` is **5–10s faster** than waiting for HTML byte-stability,
and never lags it by more than ~1s. It's both more correct and lower-latency.

### 3. The noop run is the case for doing this at all

Chat-only prompt → the agent answered in one `Chat` segment and **`ReleaseTurn` fired at
+15.3s**. But `waitForGenerationDone()` **timed out at 1201s** (20 min): no file ever
changed, so its `sawChange` flag stayed false and it never reached the stability path.
The controller reported `failureMode: timeout` for a run that succeeded in 15 seconds.

A `ReleaseTurn`-based observer fixes this outright — it's the "finished-with-no-file-change"
blind spot from the original review, reproduced live. **~80s of real wall-clock and a
wrong failure verdict, on one trivial prompt.**

### 4. STALLED threshold

Within a `Chat` stream, inter-chunk gaps are tiny — across all runs **max 1916ms, p95 ~1.9s**.
Between agent steps the `RenewTurn` metronome ticks every 10.0s. So a robust STALLED
detector keys off the **turn-level heartbeat, not intra-stream gaps**: _no `RenewTurn`
AND no `Chat` chunk for > ~25s_ (comfortably above the 10s renew cadence and the ~2s
max intra-stream gap) while no `ReleaseTurn` has been seen.

### 5. BLOCKED / quota

The usage banner is **not in the DOM at idle or on the home screen** — it renders
contextually in the chat flow after prompt activity (the plan's home-screen scrape found
nothing; the post-iterate probe caught it every time). Over the campaign it walked
**77% → 98%**, and crucially the wording **switches axis** under load:

- `"You've used 83% of your weekly limit · It resets Sun, Jun 14"`
- `"You've used 98% of your session limit · It resets at 3:00 AM"`

A quota reader must handle **both "weekly limit" and "session limit"** with different
reset semantics, and should be sampled **after** a prompt, not pre-flight on home. (Heads-up:
the account is at 98% session / ~87% weekly — further capture today will hit the wall.)

### 6. DOM corroboration is weak; OOPIF blind spot is narrow

- `selectors.json composer.stopButton` is `null` and **the spike confirms why**: the
  generic stop/cancel probe matched **0/177 samples** on every run. There is no reliable
  DOM stop-button to key off — another reason to go network-first.
- The send button sits `visible + disabled` throughout generation; `chatTurnCount` rises
  as steps complete but only resolves fully at the end. Useful as soft corroboration, not
  as the oracle.
- The preview fetch to `…claudeusercontent.com/serve/<file>.html` **is visible** in the
  main-frame trace (4 hits on create). The feared OOPIF blind spot is narrow — we see the
  preview reload as a GET, even though the iframe document itself is out-of-process.

### 7. Per-file mutation RPCs are the network-level tool-activity feed

File writes surface as their own OmeletteService RPCs — **`WriteFiles`, `EditFile`,
`DeleteFile`, `GetFile`** — interleaved with the `Chat` segments during a run (the multi-file
run fired 8 `WriteFiles` + 8 `EditFile`). These are the network-level equivalent of the UI's
"Writing tokens.css" tool-activity cards: a per-file progress feed keyed off stable RPC method
names rather than scraped DOM. The observer doesn't need them to decide RUNNING / FINISHED, but
they're the cleanest source if per-file progress is ever surfaced to the orchestrator.

### 8. Baseline noise is near-zero — anything on `OmeletteService` is signal

An idle design tab issues **no generation traffic at all** (0 `OmeletteService` requests in a
3-minute baseline); only `TrackEvent` analytics and datadog assets fire, and only around
interactions. So the observer needs no allowlist gymnastics: anything on the
`…/OmeletteService/<Method>` path is generation signal, and `TrackEvent` + datadog are the only
things to ignore.

## Follow-up captures (quota-blocked hunt)

Two extra prompts fired at 98% → 99% session quota to try to observe a
hard-blocked run. **The wall never tripped** — both generated normally. Takeaways:

- **The session limit is advisory within a session**, at least up to 99%. The
  banner counts up but generation keeps working; there is no hard network refusal
  at the banner. So the BLOCKED branch should key off the **banner** (which we can
  detect reliably, both axes) — not an expectation that `Chat` will start returning
  errors as you approach the limit.
- **A real non-200 was captured incidentally**: `UpdateProjectData` returned **409
  Conflict** (optimistic-concurrency, not quota). Structurally useful — it confirms
  OmeletteService **surfaces RPC failures as non-200 HTTP status on the request**, so
  an error/BLOCKED detector keying off "non-200 on a generation-critical RPC" has a
  confirmed mechanism, even though we never caught a quota-specific rejection.
- **The FINISHED blind-spot reproduced a second time, more sharply.** A tiny
  in-place edit ("bump starfield twinkle speed") finished server-side at
  **`ReleaseTurn` +13s**, but `waitForGenerationDone()` was still spinning at
  **930s** when we interrupted it (heading for the 20-min timeout) — because the
  micro-edit never produced a stable served-HTML byte-change. So the blind spot is
  **not limited to chat-only noops**: small real edits hit it too. This is the
  strongest single argument for the `ReleaseTurn`-based FINISHED signal.

_Tooling note: SIGINT to the `npm run` wrapper does not propagate to the tsx child,
so graceful finalize was skipped and that one trace has no `manifest.json` (the
JSONL is intact and analyzes fine). If the runner graduates past spike use, invoke
`tsx` directly or trap+forward the signal._

## Recommended observer contract (for the /architect pass)

- **RUNNING** ← `Chat` segment open OR a `RenewTurn` within the last ~15s.
- **FINISHED** ← `ReleaseTurn` seen (primary). Corroborate with `chatTurnCount` stable +
  preview GET settled. Do **not** require an HTML byte change (kills the noop blind spot).
- **STALLED** ← run expected, but no `RenewTurn` and no `Chat` chunk for > ~25s, no
  `ReleaseTurn` yet.
- **BLOCKED** ← quota banner (weekly **or** session axis), or a `Chat`/`RenewTurn` request
  returning non-200 / `loadingFailed`.
- Key off the RPC **method names** (`Chat`, `RenewTurn`, `ReleaseTurn`, `WriteFiles`,
  `EditFile`, `DeleteFile`), which are far more stable than styled-component DOM classes.
  Watch for drift in the `v1alpha` service version — that's the one thing here that will
  rev.

## Tooling notes

- Recorder uses native `WebSocket` (Node ≥22). Promoting into shipped runtime needs
  `engines >=22` or the `ws` dep — flagged in `cdp-trace.ts`.
- Redaction verified: no `cookie`/`authorization`/session tokens in any trace; `artifacts/`
  stays gitignored.
- Reproduce: `npm run trace -- <scenario>`, then `npm run trace:analyze -- <dir>`.
