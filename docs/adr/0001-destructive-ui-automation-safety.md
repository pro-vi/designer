# ADR 0001: Safety for destructive UI automation comes from verification, not from the click mechanism

- **Status:** Accepted on merge of PR #134
- **Date:** 2026-07-26 (decided) / 2026-07-28 (final revision)
- **Deciders:** provi, Claude (live-probe evidence + adversarial plan review + /gate lenses)
- **Note on status:** deliberately recorded as Accepted-on-merge rather than
  `Proposed`, so merging PR #134 lands the decision in its final state and no
  second merge is needed to flip it. If the PR is closed unmerged this file dies
  with the branch.
- **References:** PR #134, `docs/plans/2026-07-26-001-feat-files-delete-plan.md`,
  `files-switcher.ts`, `DesignerController.deleteFile` (`designer-controller.ts`),
  `scripts/e2e-files-delete.ts`

## Context

`designer` drives claude.ai/design through the DOM. Every existing verb is
additive — create a project, send a prompt, read files — so a wrong or lost
click was recoverable. `designer_files_delete` is the first verb that destroys
user data, against a product with **no undo**, on a surface that redesigns
without notice.

The obvious framing is "use real input events, because synthetic clicks are
unreliable." A live probe on 2026-07-26 appeared to support it: synthetic
`element.click()` opened some file-row menus and silently no-oped on others.

Driving the real flow end-to-end refuted that framing. Measured on the live
product the same day:

- agent-browser's **trusted** click reports success and does nothing at all on
  some page states — including the popover trigger, where selector click,
  hover-then-click and coordinate click all no-oped while a synthetic click
  worked immediately (React delegates handlers from the document root).
- The switcher popover's dismissal scrim (`div.fixed.inset-0`, z-3499,
  `pointer-events: auto`) stays mounted above the confirm dialog, because the
  popover must stay open to read rows. **Nothing** reaches the dialog through
  it — facade click, coordinate click, and raw CDP `Input.dispatchMouseEvent`
  alike.
- The original "synthetic is unreliable" observation was really about clicking
  elements located by text search without hovering or stamping them: the wrong
  node, not the wrong mechanism.

So neither mechanism is dependable on its own, and picking one cannot be the
safety story.

## Decision

Safety for destructive UI automation rests on two properties that are
independent of how a click is dispatched:

1. **Verify-and-stamp.** One in-page expression locates the control, verifies
   the identity of what it will affect (the confirm dialog's filename echo,
   parsed with an anchored regex and compared with `===`), and stamps that exact
   node with `data-designer-target`. The caller then clicks the stamped
   selector. The node that was verified is the node that is clicked.
2. **Positive outcome assertion.** Success requires observing the intended state
   change — for deletion, the row set shrinking by exactly one across two
   consecutive reads. Absence of evidence is never success: rows exist only
   while the popover is open, so an unreadable list is uncertainty, not `ok`.
   Each observation must also be a fresh one: the popover is remounted per poll,
   because an opener that no-ops when already open turns N polls into N re-reads
   of one stale subtree. And the negative claim was dropped entirely — see the
   consequences below.

Given those, the click mechanism is a *reliability* concern, free to be layered:
trusted click first, then dismiss the covering scrim and retry, then a synthetic
click on the stamped node — each step followed by proof the state actually
changed.

Corollaries this ADR also fixes in place:

- A parsing rule that authorizes a destructive act exists **once**
  (`CONFIRM_ECHO_RE_SRC`), compiled by both the in-page expression and the
  Node-side matcher, so the tested rule is the shipped rule.
- Destructive verbs pin the project root before acting and re-assert it
  immediately before the irreversible click; `_ensureInSession()` is not a pin.
- Ambiguity is refused, never guessed: switcher labels hide extensions, so two
  files can share one label.
- Health anchors probing a destructive surface walk to the last non-destructive
  step and stop.
- Exclusion belongs to the shared RESOURCE, not to the object holding a handle
  on it. The resource here is the agent-browser session's active tab, so every
  operation that navigates or re-activates a tab serializes on the session —
  re-entrantly per operation, so an outer verb may call inner ones.

## Rationale

The rejected alternative — "mandate trusted input, ban synthetic clicks" — was
the plan's original position. It fails on evidence (trusted input silently
no-ops here) and, more importantly, it protects the wrong thing. A click that
lands nowhere is *safe*: nothing is destroyed, and the outcome assertion reports
the file as survived or the outcome as unknown, never as deleted. A click that
lands on the **wrong element** is
the catastrophic case, and no amount of input fidelity prevents it — only
binding the assertion to the clicked node does.

Framing safety as verification also degrades honestly under UI drift: when the
product renames a button or restyles a dialog, the flow refuses and says why,
rather than clicking something plausible.

## The transferable part

If you are adding a sibling verb on this surface, or reviewing one, these are
the rules that span files and are therefore easy to violate one file at a time:

1. **Exclusion belongs to the shared resource, not to the object holding a
   handle on it.** The resource is the agent-browser session's active tab. Three
   attempts got this wrong — per controller instance, then per session+project,
   then leaking through a public `browser` field into the health path.
2. **A laggy read may never prove safety.** After an irreversible dispatch the
   outcome is proven-done or unknown. Never "it is still listed, so nothing
   happened".
3. **The commit boundary starts at attempted actuation**, not at a successful
   observation of it. "The dialog was not seen closing" is not "no click was
   issued".
4. **Positive and negative claims need symmetric evidence**, and each
   observation must be independent — a re-read of the same DOM nodes is one
   observation, however many times it is polled.
5. **A syntactic check is not proof.** Every guard here is verified by a
   mutation in `tests/mutation-harness.mjs`; a mutation that survives names a
   property that is asserted but not verified.

## Consequences

Positive:

- Wrong-file deletion requires the dialog's own filename echo to be wrong —
  a much stronger guarantee than "we clicked carefully".
- The flow survives both failure modes observed live (dead trusted clicks,
  uncloseable scrims) without weakening any guarantee.
- Refusal codes split on whether a confirm click was ever **dispatched**, not on
  whether one was observed to work. Before any dispatch, a code guarantees
  nothing was deleted. After one, there is exactly one failure code —
  `outcome-unknown` — because the only evidence that the file survived would be
  the file list, and that surface lags the delete. A destructive tool may prove
  success or admit ignorance; it may not claim safety from a laggy read.
- The pattern generalizes to the rename/duplicate/download verbs on the same
  surface, and to project deletion if it is ever productionized.

Negative:

- More round trips per action (stamp, verify, click, prove) — a delete takes
  seconds, not milliseconds.
- Stamping writes a transient attribute into someone else's page; it is removed
  in a `finally`, but it is a mutation of a surface we do not own.
- The layered actuation is more code than a single `click()`, and its
  justification lives in comments and this ADR rather than being obvious.
- Correctness below the pure-matcher level rests on a manual live e2e
  (`scripts/e2e-files-delete.ts`), because no controller harness exists.

## Revisit Triggers

- agent-browser's trusted click becomes reliable on this app (the synthetic
  fallback and its scrim workaround could then be deleted).
- claude.ai/design ships an API for file management, making DOM driving moot.
- The confirm dialog stops echoing the filename — the verification anchor
  disappears and the whole approach needs rethinking before any delete ships.
- A controller-level test harness appears, letting the e2e's assertions move
  into `npm test`.
