# designer

MCP + CLI for iterating on **claude.ai/design** — Claude's web-based wireframe and high-fidelity design tool.

The human describes intent. The orchestrating agent translates intent into a minimal prompt, relays it to Claude Design, hands the URL back to the human, interprets their reaction, iterates. When the human says "yes", `designer_handoff` downloads a tar.gz bundle (README + chat transcripts + all design files + source JSX) so the implementing agent (Claude Code, typically) can build the design in a real repo.

## Stance

- **Single-vendor, single-purpose.** Only `claude.ai/design`. No kitchen sink.
- **`agent-browser` is the substrate.** Attaches to your real Chrome via CDP — sidesteps Cloudflare + Google SSO.
- **Human is the designer.** See `~/.claude/skills/designer-loop`. Orchestrator is translation + plumbing; Claude Design has the taste; human arbitrates.
- **URL is the default taste path.** `designer_prompt` returns a live claude.ai/design URL where tweak sliders work and variants switch. Local tasting harness exists only for when IDE chrome gets in the way.
- **Artifacts land on disk.** Every iteration + every handoff saves under `./artifacts/{key}/`.

## Install

One-call first-run:

```bash
git clone https://github.com/pro-vi/designer.git && cd designer
npm install
./bin/designer setup
```

Optional — make `designer` available globally:

```bash
npm link
designer setup     # now works from any cwd
```

`designer setup` is idempotent and auto-progresses:

1. Installs deps if missing.
2. Checks `agent-browser` is on PATH.
3. Asks you to Cmd+Q Chrome if a non-debug Chrome is running (polls until quit).
4. Launches a dedicated debug Chrome (`--remote-debugging-port=9222`, profile at `~/.chrome-designer-profile/`).
5. Polls until you sign in to Claude and reach `/design`.
6. Installs the `designer-loop` skill at `~/.claude/skills/designer-loop/` unless one is already present (respects bootstrap/dotfiles-managed symlinks).
7. Registers the MCP with Claude Code at user scope.

Re-run any time — every step no-ops when already satisfied.

### Why a dedicated profile?

Since Chrome 136, `--remote-debugging-port` is blocked on the default profile for security. The dedicated `~/.chrome-designer-profile/` is a one-time login that persists across launches. Your normal Chrome is untouched.

### Auto-launch

After first setup, the MCP auto-launches debug Chrome from the saved profile on the first tool call of any session. You don't have to think about Chrome state again. If a non-debug Chrome is running, auto-launch bails with an actionable error.

### Bot detection

Login is a real human typing into a real Chrome window. `--remote-debugging-port` alone doesn't set `navigator.webdriver` (only `--enable-automation` does); user-agent is identical to normal Chrome. Cloudflare and Google OAuth see a normal session. First login on the new profile may trigger Google's "new device" verification — that's a standard one-time prompt.

### Manual setup

The MCP registration embeds `DESIGNER_CDP=9222`, so Claude sessions pick it up automatically. The shell export below only matters for direct CLI invocations (`designer session`, `designer prompt`, etc.) from an interactive terminal — add it to `~/.zshenv` or equivalent if you use the CLI directly.

```bash
./scripts/designer-chrome.sh              # launches debug Chrome
# sign in to Claude, navigate to /design
curl -s http://127.0.0.1:9222/json/version | head   # verify CDP
export DESIGNER_CDP=9222                  # only needed for direct CLI use
claude mcp add --transport stdio designer \
  -- env DESIGNER_CDP=9222 "$PWD/bin/designer" mcp serve
```

## CLI

Top-level help leads with the typical loop:

```
$ designer --help

designer — CLI + MCP for iterating on claude.ai/design

Typical loop:
  designer setup                                       (once per machine)
  designer session --action create --name "X" --key x  start a project
  designer prompt "design the …" --key x               prints 'Taste here: <url>'  ← open that
  designer prompt - --key x < follow-up.txt            iterate until human says yes
  designer handoff --key x                             bundle for code implementation
```

Verbs are grouped: session lifecycle, design operations, file introspection, exit/promotion, setup+ops, internal. Every verb supports `--help`:

```bash
designer prompt --help        # expanded docs: input modes, flags, output shape, examples
designer help handoff         # same
```

All verbs take `--key <k>` to isolate parallel sessions (e.g., working on two features at once). Local state lives at `~/.designer/sessions.json`.

Prompts accept three input modes:

```bash
designer prompt "short text" --key feat-x                # positional
designer prompt --prompt-file ./brief.md --key feat-x    # from file
cat follow-up.txt | designer prompt - --key feat-x       # stdin
```

Output of `prompt` and `snapshot` leads with `Taste here: <url>` above the JSON — the URL is the default taste path.

## MCP

Six tools, registered at user scope by `designer setup`:

| Tool | Purpose |
|---|---|
| `designer_session` | Enter / inspect / transition. Actions: `status` (default, read-only), `ensure_ready`, `resume`, `create`. Always returns stored state + `currentUrl` + `availableFiles`. |
| `designer_prompt` | Modify the design (HTML-diff wait). Auto-appends a flat-layout instruction. Returns `url` (hand to human), `newFiles`, `activeFile`, `failureMode`, `htmlPath`, `chatReply`. |
| `designer_ask` | Q&A with the assistant (chat-panel wait). No file changes. Returns `reply`. |
| `designer_list` | `scope: 'projects'` (scrapes home) or `'files'` (scrapes file panel — flat-only, see quirks). |
| `designer_snapshot` | Capture current state. Optional `filename` to switch first. Default: paths + hash only; `includeHtml: true` inlines. |
| `designer_handoff` | Export → Handoff → download + extract tar.gz. Returns README + paths. Auto-repairs Claude-side em-dash filename bugs. |

Registration:

```bash
claude mcp add --transport stdio designer \
  -- env DESIGNER_CDP=9222 \
     /Users/provi/Development/_projs/designer/bin/designer mcp serve
```

(`designer setup` runs this. After `npm link` it collapses to `designer mcp serve`.)

## The loop

```
1. Intent       → human describes what they want to feel / change
2. Read         → designer_session returns currentUrl + availableFiles
3. Relay        → designer_prompt with a terse, guide-not-constrain prompt
4. Taste        → hand the human the url from the return; they react in their own words
5. Interpret    → next designer_prompt (modify) or designer_ask (clarify)
6. Repeat 3-5   → until human says "that's it"
7. Promote      → designer_handoff — bundle is the decision record
```

Full guidance in `~/.claude/skills/designer-loop/SKILL.md` (also in-repo at `skills/designer-loop/SKILL.md`).

## Tasting harness

Fallback for when claude.ai/design's IDE chrome (chat panel + toolbar) eats too much viewport to judge at real scale. Requires a prior `designer_handoff`.

```bash
designer tasting --key <key>
```

Walks the latest bundle's `project/` dir (recursively — handles nested layouts), writes `tasting.html` with variant tabs + keyboard shortcuts (1/2/3) + persistent notes (localStorage), starts a local `http.server`, opens the browser.

Default path for tasting is the live URL. Use tasting when: full-viewport comparison matters, Claude didn't build its own `index.html` gallery, or the IDE chrome is distracting.

## Operations

- `designer doctor` — diagnose first-run setup state. Checks agent-browser, CDP, a /design tab is open, selectors present, skill installed, MCP registered. Exits 2 on failure.
- `designer health` — probe every UI anchor this MCP depends on. 17 probes across home / session / share / pattern categories. Exits 2 on any fail. Wire into cron / CI to catch claude.ai UI regressions (it already moved Export under Share once mid-development).

## Layout

```
designer/
├── package.json
├── tsconfig.json            # type-check only
├── tsconfig.build.json      # tsc → dist/
├── bin/designer             # bash wrapper, prefers dist/ then tsx
├── mcp-server.ts            # MCP stdio server (exports startMcpServer)
├── cli.ts                   # same verbs, directly runnable; rich --help
├── designer-controller.ts   # core flow: session, prompt, ask, snapshot, handoff
├── browser.ts               # thin wrapper over agent-browser subprocess
├── cdp-ensure.ts            # auto-launches debug Chrome on first tool call
├── tasting.ts               # tasting.html generator + http.server
├── ui-anchors.ts            # every DOM / URL / structural dependency, enumerated
├── setup.ts                 # designer setup verb
├── session-store.ts         # per-session state at ~/.designer/
├── artifact-store.ts        # writes HTML/PNG/JSON under ./artifacts/{key}/
├── repo-root.ts             # package.json walk so source + compiled both resolve resources
├── selectors.json           # DOM selectors for the claude.ai/design surface
├── scripts/
│   ├── designer-chrome.sh   # standalone Chrome launcher
│   └── probe.ts             # manual DOM exploration helper
├── skills/
│   └── designer-loop/SKILL.md   # the skill, copied to ~/.claude/skills/ by setup
├── artifacts/               # generated outputs (gitignored)
└── dist/                    # tsc build output (gitignored; published on npm)
```

## Known quirks

- **Folder-organized variants.** Claude Design sometimes organizes multi-file variants under a subfolder (`directions/sediment.html`). The live MCP's file-list scrape (`designer_list files`, `availableFiles` in session status, `newFiles` diff from `designer_prompt`) is flat-only; nested files are invisible until `designer_handoff`. Mitigation: `designer_prompt` auto-appends *"Keep all generated files at the project root; no subfolders."* Handoff bundle is folder-aware; `designer tasting` walks recursively.
- **React-controlled inputs.** `agent-browser fill` doesn't fire React's synthetic input event. The controller uses the native `HTMLTextAreaElement` value-setter + `dispatchEvent(new Event('input', { bubbles: true }))`, plus JS `.click()` on Send and Create. Both are canonical React-compat patterns.
- **Em-dash handoff filenames.** Claude's handoff pipeline wrote em-dash (`—`) into `index.html` hrefs but saved files with regular hyphens. `designer_handoff` detects and repairs (`repaired.renamed: [...]`). No-op when hrefs already resolve.
- **Cross-origin iframe.** Served HTML lives on `claudeusercontent.com` with a signed `t=` token in the URL. Direct fetch from node works without cookies. The token is session-scoped, not per-iteration.
- **UI regressions.** Claude has moved critical buttons mid-development (Export → Share dropdown). `designer health` is the early-warning system; run it periodically.

## Publishing (future — not yet on npm)

Prepped but not shipped. Prerequisites: npm account with scope `@pro-vi` (currently 404/available), 2FA, `npm login`. Then:

```bash
npm publish --access public
```

`prepublishOnly` runs `tsc --noEmit` + `tsc -p tsconfig.build.json`. `files` whitelist in `package.json` keeps the tarball under 35KB. Published package will support:

```bash
npx @pro-vi/designer setup                                         # trial
npm i -g @pro-vi/designer && designer setup                        # daily use
claude mcp add --transport stdio designer -- designer mcp serve    # MCP
```
