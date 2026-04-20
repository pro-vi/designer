---
name: designer-loop
description: "Human-participated design iteration loop. The human is the designer — AI is hands + memory. Works two ways: (1) driving claude.ai/design via the `designer` MCP for new-surface exploration, or (2) iterating design tokens directly in an existing codebase. Always: human states intent, AI reads what exists, proposes 2-3 variants with rationale, human reacts in their own words, AI interprets and iterates. Promotes accepted result with a decision record."
---

# Designer Loop

The human is the designer. The AI proposes, remembers, and executes — but taste lives with the human.

Two modes:

- **MCP mode**: drive `claude.ai/design` via the `designer` MCP. Claude's design assistant has baked-in taste; you pipe intent in, show variants to the human, interpret reactions, and promote the result to code.
- **Token mode**: edit tokens directly in the running repo. No MCP needed.

The loop is identical in both modes; the mechanics differ.

### Which mode?

Pick by the shape of the work, not the tool's availability.

**MCP mode fits when:**
- Designing a new surface that doesn't exist yet.
- Redesigning an existing surface where multiple directions are plausible.
- Human wants to taste alternatives side-by-side before committing.
- Change crosses multiple dimensions (palette + type + layout + hierarchy) — tokens can't carry it.
- Human's intent is exploratory ("what if", "feels like", "design me").

**Token mode fits when:**
- Change is mechanical and targeted — one or two dimensions (spacing, radius, a single color).
- Existing codebase has a clear token layer to edit.
- Human wants iterative polish, not fresh exploration.
- The right answer is already clear enough that side-by-side alternatives would be wasted turns.

**Default when ambiguous**: start MCP mode if the intent is feeling-shaped ("feels heavy", "too cold"); start token mode if it's value-shaped ("make the border lighter", "more padding").

**Fallback**: if MCP mode is indicated but unavailable (not registered, CDP down, can't sign in), drop to token mode and tell the human. Don't silently downgrade.

## The Loop

```
1. Intent       → Human describes what they want to feel/change (not specific values)
2. Read         → AI detects existing design language and constraints
3. Propose      → AI offers 2-3 variants
4. React        → Human responds in their own words ("too cold", "almost", "yes")
5. Interpret    → AI translates reaction into next proposal or promotion
6. Repeat 3-5   → Until human says "that's it"
7. Promote      → Write to production with decision record
```

## Phase 1: Intent

**The human speaks in feelings, not values.**

Good intent: "The sidebar feels heavy — I want it to recede." "I want an intake screen that doesn't feel clinical."

Bad intent (skip to Phase 3): `--border-radius: 12px` — already a solution.

If the human gives a specific value, ask once: "What are you trying to achieve?" — the answer is the real intent.

**Interview only when intent is genuinely unclear, and only about scope — never about aesthetics.**

Clarifying questions in scope: what data is rendered, what the primary user action is, what failure modes must be visible, what the adjacent screens are, what must NOT change.

Aesthetic questions belong to Claude Design, not you: do not ask about palette, type, layout direction, tone, hierarchy, spacing style. Those are the design surface's job.

## Phase 2: Read the Room

**Token mode** — understand what exists in the codebase:

1. **Find the token layer** — CSS custom properties in `app.css`? Tailwind config? Theme file?
2. **Map the current language** — spacing scale, palette, radii, shadow depth, type scale. Don't propose outside the system unless the intent is to break it.
3. **Identify constraints** — dark mode, a11y contrast, brand colors, breakpoints. Non-negotiable unless the human says otherwise.
4. **Note adjacency** — design is relational. Read the element AND what's next to it.

**MCP mode** — orient in the claude.ai/design surface:

1. `designer_session({ key })` — returns stored state + `availableFiles`. If `stored.designUrl` exists, you're resuming; otherwise create one with a sensible default name derived from the intent (don't interview the human for a project name).
2. For existing projects: `designer_snapshot({ filename })` per file of interest. You get `htmlPath` — read it if deep inspection is warranted.
3. If this is a frontend for an existing backend or codebase, read the backend's API shape and any existing design tokens in the target repo BEFORE prompting. Those are constraints to thread into the prompt verbatim, not aesthetic hypotheses to propose.

A one-line brief is fine ("I see X; here's the prompt I'm about to send"). Don't turn it into a design-by-interview. The human's intent goes in untouched.

## Phase 3: Propose

### In MCP mode: you're a translator, not a co-designer

Claude Design has taste. **Your only job is to translate the human's intent into a minimal faithful prompt and let Claude's taste work.**

Guide, don't constrain. The prompt should give Claude enough to make good decisions, not pre-make the decisions:

| Guide (include) | Constrain (omit) |
|---|---|
| What the product does / data it renders | Color palette (unless it's a hard brand token — see below) |
| User's situation / primary action | Type treatment, font feel |
| Entities, field names, copy that must appear | Layout direction, whitespace rules |
| Adjacent surfaces / what must NOT change | Tone adjectives ("contemplative", "trustworthy") unless paired with a concrete lever |
| Hard brand tokens (palette, type, existing component names) as non-negotiables | Visual hierarchy choices |
| Quantity + shape of variants ("3 full-page files", "20 on a wrapping grid") | Variant names (let Claude pick) |

Do not:

- Workshop aesthetic direction in chat before sending.
- Propose variants of your own to the human. Claude Design proposes; you relay.
- Interview about taste. Scope questions only — see Phase 1.

The orchestrator is hands. Claude Design is the designer. The human is the taste. Don't muddle the three.

### Prompt discipline

- **Short and concrete over long and tasteful.** Not a hard ceiling — goal + layout + content + audience is the recipe and sometimes takes more — but over-specification is the most common failure mode.
- **Avoid ungrounded vibe adjectives.** Vibe words that don't map to a concrete surface (a button, a motion, a spacing rule) fight Claude's style coherence. Vibe word + concrete lever is fine; vibe essay ahead of the brief is not.
- **Lock brand explicitly.** Palette, type, component names — say them. Don't hope Claude guesses.
- **Ask for tweaks** on the dimensions you expect to iterate (type, spacing, palette). Claude wires live sliders.
- **Quantities help.** "N variations", "N loaders on a grid", "N-screen onboarding" — Claude delivers variety within one generation.

### Picking the right artifact shape

The split is not canvas-vs-files. The split is **what's the unit of critique?** — pick generation AND evaluation from that.

| Unit of critique | What to generate | How to evaluate |
|---|---|---|
| Alternative treatments of one view | Canvas grid OR separate full-page files, based on scale (see below) | Canvas works for ≤300×300 cells; otherwise full-viewport with a switcher |
| A journey across screens | One routed prototype with the sequence in context | Storyboard canvas — each frame is a screen in the flow |
| Named interactive states (empty / loading / error / success) | One interactive prototype with the states as toggles | Tweak system or state buttons |
| Scroll rhythm / long-form pacing | One scrollable artifact. Don't multiply it | Scroll at real width |
| A system / shipped artifact | Routed prototype, zip, or handoff to code | `designer_handoff` |

Heuristic threshold: once **screens × meaningful states × breakpoints > ~8–10**, stop multiplying variants. Converge to one routed prototype or structured handoff.

### Canvas at what scale

Two sub-modes:

- **Grid canvas** — many small cells, each ≤300×300. For widgets where variants read at thumbnail scale (loaders, cards, icons, type specimens).
- **Storyboard canvas** — a few frames at real device size, arranged as a sequence. For flows — one sequence, not competing variants.

Variants of a full-viewport surface are neither. Grid canvas mangles them (type scale, whitespace, hierarchy only read at real size). Storyboard doesn't apply. Right shape: separate full-page HTML files + a skill-level full-viewport switcher. `designer tasting --key <name>` builds it.

### Naming variants vs locking brand

Two different things, often conflated:

- **Brand tokens** (palette, type, component names, product language) — specify explicitly.
- **Variant names** (what each disposable exploratory branch is called) — let Claude name them from the problem domain. Exception: if the human already has review-friendly labels in mind ("single-page / wizard / dense ops"), use those.

### Tool sequence

Separate-file variants (app screens, full-viewport):

1. `designer_session({ key, action: 'create', name, fidelity: 'highfi' })`.
2. `designer_prompt({ prompt })` — terse, let-Claude-name. Returns `newFiles`.
3. `designer_handoff({ key })` — tar.gz bundle with all variants + README + chat transcript.
4. `designer tasting --key <name>` — builds the full-viewport switcher and opens it.

Canvas variants (compact widgets):

1. `designer_session({ key, action: 'create' })`.
2. `designer_prompt` with "on a wrapping grid" / "N variations on a canvas".
3. `designer_snapshot({ key })` — fetch the canvas file.
4. `designer_handoff` when done.

### In token mode: **offer variants with rationale**

Offer 2-3 variants. Each has:

- **Name** — evocative, not technical ("Whisper", "Breathe", "Recede"). Let the problem domain suggest names when you can.
- **Tokens** — the actual CSS/config changes.
- **Rationale** — why this variant might satisfy the intent.
- **Trade-off** — what you lose.

```
### Whisper
Reduces sidebar border to 1px, drops shadow to 0 1px 2px, mutes background by 2 stops.
→ Why: border and shadow are the two heaviest signals. Removing them lets content lead.
→ Trade-off: sidebar/content boundary becomes implicit.
```

**Preview**:
- **Quick preview** — write an HTML file with variants side-by-side using realistic content (not isolated swatches).
- **Live preview** — apply variant tokens to the running app via CSS override; capture screenshots.

Store variants in `.design-lab/` (gitignored) until promoted.

## Phase 4: React

**The human reacts in their own language.** Don't ask "accept or reject?" — ask "what do you think?"

Messy reactions are the point:
- "A is closer but still too stark"
- "B feels right but the gap is too much"
- "Neither — what if we kept the border but made it almost invisible?"
- "Yes. That's it."

In MCP mode, the human can tune live via the tweak sliders Claude wired into the canvas. Those tweak positions are themselves a reaction — capture them.

## Phase 5: Interpret

Translate reaction into the next move:

- **"Too X"** → propose variants that move away from X.
- **"Almost"** → narrow range, smaller adjustments.
- **"What if..."** → human is designing now — execute their idea as the next variant.
- **"Yes"** → promote (Phase 7).
- **Silence / uncertainty** → show variants in context, ask what's bothering them.
- **Ambiguous** → before re-prompting, consider `designer_ask({ prompt })` to *consult* Claude: "given the human said X, what small change would address that?" — cheap (~15-30s text reply) and often surfaces the right adjustment.

Never override with "but best practice says..." — capture the tension in the decision record instead.

## Phase 6: Promote

**MCP mode**:

1. `designer_handoff({ key, openFile: <chosen variant> })` — downloads the tar.gz bundle under `./artifacts/{key}/handoff-{ts}/`. The bundle is the decision record:
   - `README.md` — handoff protocol for the implementing agent
   - `chats/chat1.md` — full transcript (every prompt + reply, verbatim)
   - `project/*.html`, `*.jsx`, `*.css` — all design files including the chosen variant
2. If this is a frontend for an existing codebase, the implementing agent (this one, or Claude Code downstream) reads the bundle's README + chat transcript first, then translates the chosen variant into real code in the target repo.
3. Append to the codebase's design decision log with a short entry citing the bundle path + the human's final reaction verbatim.

**Token mode**:

1. Write tokens to the production file (`app.css`, tailwind config, theme).
2. Capture the decision record as a comment or companion file:

```css
/* Design decision: sidebar weight (2026-03-26)
   Intent: "sidebar feels heavy, want it to recede"
   Chosen: "Whisper" — reduced border + muted shadow
   Rejected: "Breathe" (spacing-only) — "still felt dense"
   Constraint: kept 3:1 contrast ratio for a11y */
```

3. Show the diff before writing.

## Guardrails

- **Read before proposing** (Phase 2). In MCP mode, call `designer_session` first — it returns `availableFiles` so you know what exists.
- **Offer rationale**, not just values — the human should understand WHY.
- **Variant names from the problem domain** — in MCP mode, let Claude name them; in token mode, borrow from the subject matter, not from generic aesthetic vocabulary.
- **Lock brand explicitly.** Claude won't guess your palette. If brand matters, state it — palette, type, component names.
- **Capture feedback verbatim** in the decision record — don't sanitize.
- **Direct values execute** — if the human says `--border-radius: 12px`, just do it. Still ask about intent for the record.
- **Promote only after explicit "yes"** — "almost" is not "yes."
- **MCP prompts short and concrete.** Not a hard ceiling, but over-specification is the most common failure mode. Official gallery examples average 30–40 words.

## Anti-Patterns

- **Swatch galleries** — isolated color chips instead of tokens in context.
- **Binary choice** — "A or B?" instead of "what do you think?"
- **Premature precision** — debating `oklch(0.78 0.02 285)` vs `oklch(0.79 0.02 285)` before direction is established.
- **Ignoring adjacency** — changing the sidebar without seeing how it affects the content area.
- **Silent promotion** — writing tokens without a decision record.
- **Interviewing about aesthetics in MCP mode.** Scope questions are fine when intent is genuinely unclear; taste questions aren't yours to ask.
- **Proposing variants of your own in MCP mode.** Claude Design proposes. You relay.
- **Constraining where Claude should have room.** Brand tokens are constraints; palette feelings and layout hunches aren't.
- **Ungrounded vibe essays** — vibe words without a concrete surface to attach to fight Claude's style coherence.
- **Variant grid for full-screen experiences** — shrinking an intake/onboarding/dashboard into a 400px canvas cell loses hierarchy, type scale, whitespace. Screen-level variants → separate files + tasting harness.
- **Separate files for compact widgets** — 20 loading indicators don't each need their own file. Grid canvas.
- **Variant grid for journeys/states/systems** — multiplying screens by variants blows up fast. Once screens × states × breakpoints > ~8–10, converge to one routed prototype.
- **Dictating variant names when team has none** — generic aesthetic stereotypes. Let Claude name exploratory branches from the problem domain.
- **Forgetting to lock brand** — Claude won't guess your palette. If brand matters, state it.
- **Auto-handoff** — don't promote on every iteration. Handoff is Phase 6, not a sub-verb of `designer_prompt`.

## When the MCP is not available

Check first: `designer_*` tools should appear in the tool list. If they don't:

1. Ask the human whether they've installed the `designer` package. If yes, the MCP may have disconnected — `claude mcp list` will show the status.
2. If they haven't set it up, the one-call install is:
   ```
   cd ~/Development/_projs/designer && ./bin/designer setup
   ```
   (Or after `npm i -g @pro-vi/designer` + `designer setup` once it's published.)
3. If setup isn't possible in this session, fall back to **token mode** or hand-write an HTML variant gallery you can open in the browser.

Setup needs to happen once per machine: launch debug Chrome with a dedicated profile, sign in, register the MCP. Re-runs of `designer setup` are idempotent.
