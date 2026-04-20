---
name: designer-loop
description: "Human-participated design iteration loop. The human is the designer — AI is hands + memory. Works two ways: (1) driving claude.ai/design via the `designer` MCP for new-surface exploration, or (2) iterating design tokens directly in an existing codebase. Always: human states intent, AI reads what exists, proposes 2-3 variants with rationale, human reacts in their own words, AI interprets and iterates. Promotes accepted result with a decision record."
---

# Designer Loop

The human is the designer. The AI proposes, remembers, and executes — but taste lives with the human.

Two modes:

- **MCP mode** (preferred when designing a new surface): drive `claude.ai/design` via the `designer` MCP. Claude's design assistant has baked-in taste; your job is to pipe intent in, show variants to the human, interpret reactions, and promote the result to code.
- **Token mode** (preferred when iterating an existing codebase's design language): edit tokens directly in the running repo. No MCP needed.

The loop is identical in both modes; the mechanics differ.

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

Good intent: "The sidebar feels heavy — I want it to recede." "Everything looks flat, needs depth without being cheesy." "I want an intake screen that doesn't feel clinical."

Bad intent (skip to Phase 3): `--border-radius: 12px` — already a solution.

If the human gives a specific value, ask: "What are you trying to achieve?" — the answer is the real intent.

## Phase 2: Read the Room

**Token mode** — understand what exists in the codebase:

1. **Find the token layer** — CSS custom properties in `app.css`? Tailwind config? Theme file?
2. **Map the current language** — spacing scale, palette, radii, shadow depth, type scale. Don't propose outside the system unless the intent is to break it.
3. **Identify constraints** — dark mode, a11y contrast, brand colors, breakpoints. Non-negotiable unless the human says otherwise.
4. **Note adjacency** — design is relational. Read the element AND what's next to it.

**MCP mode** — orient in the claude.ai/design surface:

1. `designer_session({ key })` — returns stored state + `availableFiles`. If `stored.designUrl` exists, you're resuming; otherwise propose a project name.
2. For existing projects: `designer_snapshot({ filename })` per file of interest. You'll get `htmlPath` — read it if the file needs deep inspection.
3. If this is a frontend for an existing backend/codebase, read the backend's API shape and any existing design tokens in the target repo BEFORE prompting. The prompt will be better for it.

Present a brief either way: "Here's what I see: [current state]. Given your intent, I'm going to explore [direction]."

## Phase 3: Propose

### In MCP mode: **let Claude's taste lead**

The central insight: claude.ai/design has taste baked in. Over-specifying style fights the product. Under-specify and let it surface directions from the subject matter.

**Prompt discipline** (from Anthropic's docs + gallery):

- **Short and concrete over long and tasteful.** Official gallery prompts average 30–40 words. Target similar but don't treat it as a hard ceiling — goal + layout + content + audience from Anthropic's doc is the actual recipe, and it sometimes takes more.
- **Avoid *ungrounded* vibe adjectives.** "Contemplative, trustworthy, modern, not chatbot-pink" without concrete levers fights Claude's style coherence. Anthropic's own examples include aesthetic shifts ("darker and more minimal", "iridescent", "organic, blobby") — these are fine because they're paired with specific artifacts. The rule is: vibe word OK if it maps to a concrete surface (a loader's motion, a button's treatment); not OK as a brand essay ahead of the brief.
- **Lock brand explicitly.** Palette / type / component names → say them. Don't hope Claude picks your teal.
- **Ask for tweaks** when you expect to iterate dimensions (type, spacing, palette). Claude wires live sliders.
- **Quantities help** ("20 loaders on a wrapping grid", "4-screen onboarding", "3 directions for the intake") — matches Anthropic's gallery style.

### Picking the right artifact shape

The split is not canvas-vs-files. The split is **what's the unit of critique?** — pick the generation AND the evaluation surface from that.

| Unit of critique | What to generate | How to evaluate |
|---|---|---|
| **Alternative treatments of one view** (three ways the intake screen could feel) | Canvas with N variations OR separate full-page files (choose based on scale — see below) | Canvas works if variants read at cell scale (loaders, cards, icons); otherwise serve separate files with a full-viewport switcher |
| **A journey across screens** (onboarding, checkout, signup flow) | One routed prototype that includes the sequence in context. Anthropic's public example: *"Create a simple iOS signup flow for a bikesharing app. Show screens on a canvas."* | Native canvas as storyboard — each screen is a frame in the flow, not a competing variant |
| **Named interactive states** (empty / loading / error / success) | One interactive prototype with the states as toggles or routes | Claude's tweak system or explicit state buttons |
| **Scroll rhythm / long-form pacing** (landing page, essay, long dashboard) | One scrollable artifact. Don't multiply it | Scroll through it at real width |
| **A system / shipped artifact** | Routed prototype, zip bundle, or handoff to code. Anthropic supports all three | Claude Code via `designer_handoff` |

Heuristic threshold: once **screens × meaningful states × breakpoints > ~8–10**, stop multiplying variants. Converge to one routed prototype or structured file handoff.

### Canvas at what scale

Canvas is Claude's native multi-artifact container. Two sub-modes:

- **Grid canvas** — many small cells, each ≤300×300. Anthropic's gallery: "20 loaders on a wrapping grid", "10 streaming animations", "5 interactive shaders". Variety without ceremony. Use this for widgets where variants read fine at thumbnail scale.
- **Storyboard canvas** — a few frames at real device size. Anthropic's gallery: "iOS signup flow — show screens on a canvas". Each frame is a screen in a sequence. Works for flows because there's one sequence, not competing variants.

**Variants of a full-viewport surface are the awkward case.** Grid canvas mangles them (hierarchy, type scale, whitespace only read at real size). Storyboard canvas doesn't apply (these aren't a sequence). Best shape: **Claude generates the variants as separate full-page HTML files (optionally under a wrapper `index.html`), our tasting harness swaps between them full-viewport.**

Prompt for this case:
> "Produce 3 distinct directions as 3 separate full-page HTML files — you name each one after the stance it takes."

Empirical confirmation: for a Jungian text-retrieval intake screen, this yielded Claude-named **The Alembic / The Clinic / The Reading Room** — each a real stance on what the tool is. Dictating names ("Editorial / Canvas / Terminal") gave generic aesthetic stereotypes.

Evaluation harness: `designer tasting --key <name>` finds the latest handoff bundle, walks its `.html` files, writes `tasting.html` with tab-switcher + keyboard shortcuts + persistent notes, starts a local server, opens the browser.

### Naming variants vs locking brand

Two different things, often conflated:

- **Brand tokens** (palette, type, existing component names, product language) → **specify explicitly**. These are non-negotiables; don't hope Claude guesses. Example: "use the existing teal/orange palette, GeistMono for code, Inter for UI."
- **Variant names** (what each disposable exploratory branch is called) → **let Claude name them** when they're exploratory branches and the human hasn't already committed to names. Names from the problem domain ("Alembic / Clinic / Reading Room" for a Jungian tool) beat generic aesthetic stereotypes ("Editorial / Canvas / Terminal").

Counter-exception: if the human already has review-friendly labels in mind ("single-page / wizard / dense ops"), use those. Don't invent names when the team already has vocabulary.

### Prompting examples

Good — full-page intake variants:

> "Design the intake screen for Philemon, a Jungian text retrieval tool. A user pastes a life situation or Reddit post; the app returns ranked passages from Jung's Collected Works — §number, chapter, relevance score 0-10, direct quote, 1-2 sentence explanation. Sidebar shows extracted themes and the FTS5 queries it ran. Produce 3 distinct directions as 3 separate full-page HTML files — you name each one after the stance it takes. Add tweaks for typography and palette on each."

Good — canvas variants for a compact widget:

> "Prototype 8 loading indicators that fit in a 200×200 cell on a wrapping grid. All monochrome, no text. Each should feel organic, not mechanical. Add tweaks for speed and stroke weight."

Bad (over-specified, taste-loaded, wrong variant container):

> "Design the first screen for Philemon. Tone: contemplative, literate, generous with whitespace, trustworthy. Not trendy, not chatbot-pink. Generate 3 variants: 'Editorial' (serif headings, restrained), 'Canvas' (whitespace-forward, minimalist), 'Terminal' (dense, monospace). Each variant in a separate file."

### Tool sequence (separate-file variants — the common case for app screens)

1. `designer_session({ key, action: 'create', name, fidelity: 'highfi' })` — start the project.
2. `designer_prompt({ prompt })` — send the terse, let-Claude-name prompt. Returns `newFiles` listing the variant filenames Claude chose.
3. `designer_handoff({ key })` — download the tar.gz bundle with all variants + README + chat transcript.
4. (skill-level) **Write a tasting harness** — a `tasting.html` in the bundle's `project/` dir with:
   - fixed top bar: variant tabs, keyboard shortcuts (1/2/3), persistent notes field (localStorage)
   - full-viewport iframe underneath swapping between variant files
   - serve it via local http.server (needed — browsers block cross-origin XHR under `file://`)
5. Human tastes, reacts in their own words into the notes field or in chat.

The `designer` CLI ships a `tasting` verb that does step 4 automatically: `designer tasting --key <name>` finds the latest handoff bundle, walks its `.html` files, writes `tasting.html`, starts a local server, opens the browser.

### Tool sequence (canvas variants — compact grids)

1. `designer_session create` as above.
2. `designer_prompt` with "on a wrapping grid" / "N variations on a canvas".
3. `designer_snapshot({ key })` — fetch the canvas file for review.
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
- **Variant names from the problem domain** — in MCP mode, let Claude name them; in token mode, borrow from the subject matter ("Whisper" for a sidebar intent about retreating; "Marginalia" for a text-annotation feature).
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
- **Ungrounded vibe essays** — "contemplative, literate, trustworthy, not trendy" without levers fights Claude's style coherence. Vibe words need concrete surfaces.
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
