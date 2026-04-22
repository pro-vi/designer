# designer

MCP + CLI that lets your coding agent drive **[claude.ai/design](https://claude.ai/design)** — Claude's web-based wireframe and hi-fi design tool, which has no API — with full context of your codebase. Capabilities, data shape, existing tokens fed into every prompt.

Human describes intent → agent surveys codebase and prompts Claude Design → hands you the URL → iterate → `designer_handoff` bundles the result (README + chats + HTML + JSX) back into your repo.

> **Status:** v0.3.0, early. macOS only (hardcodes Chrome.app path and `pgrep`). Linux/Windows support not implemented.

## Stance

- **Single-vendor, single-purpose.** Only `claude.ai/design`. No kitchen sink.
- **`agent-browser` is the substrate.** Attaches to your real Chrome via CDP — sidesteps Cloudflare + Google SSO.
- **Capabilities drive design.** The agent surveys what the codebase can actually do (entities, operations, states, failure modes, existing tokens) and feeds that into every prompt. The human's intent tells Claude Design *how*; the codebase tells it *what*. See the [designer-loop skill](skills/designer-loop/SKILL.md).
- **URL is the default taste path.** `designer_prompt` returns a live claude.ai/design URL where tweak sliders work and variants switch. Local tasting harness exists only for when IDE chrome gets in the way.
- **Artifacts land on disk.** Every iteration + every handoff saves under `./artifacts/{key}/`.

## Install

### Prerequisites

- macOS, Node 20+, and Google Chrome installed at `/Applications/Google Chrome.app`.
- `agent-browser` on PATH — install with `npm i -g agent-browser` (or `brew install agent-browser`). This is the CDP driver `designer` shells out to.

### Three paths

All land at the same `designer setup` flow.

#### A. Just try it — zero install

```bash
npx -y @pro-vi/designer setup
```

Runs the setup once. Nothing stays on PATH. Good for a first look.

#### B. Daily use — install globally

```bash
npm i -g @pro-vi/designer
designer setup
```

After this, `designer <verb>` works from any cwd. The MCP registration added by `setup` points at the globally-installed wrapper, so Claude Code picks it up automatically.

#### C. Hacking on it — clone

```bash
git clone https://github.com/pro-vi/designer.git && cd designer
npm install
./bin/designer setup
```

Use this if you want to edit source. `bin/designer` prefers `dist/cli.js` if present, else falls back to `tsx cli.ts` — no rebuild-between-edits required during dev.

### What `designer setup` does

Idempotent and auto-progresses:

1. Verifies deps (lockfile-hash compare; reinstalls if stale).
2. Checks `agent-browser` is on PATH.
3. Asks you to Cmd+Q Chrome if a non-debug Chrome is running (polls until quit).
4. Launches a dedicated debug Chrome (`--remote-debugging-port=9222`, profile at `~/.chrome-designer-profile/`).
5. Polls until you sign in to Claude and reach `/design`.
6. Installs the `designer-loop` skill at `~/.claude/skills/designer-loop/` unless one is already present (respects bootstrap/dotfiles-managed symlinks).
7. Registers the MCP with Claude Code at user scope.

Re-run any time — every step no-ops when already satisfied. Verify with `designer doctor`.

### MCP only — no CLI

If you only want the MCP in Claude Code (skip the CLI entirely):

```bash
claude mcp add --scope user --transport stdio designer \
  -- env DESIGNER_CDP=9222 npx -y @pro-vi/designer mcp serve
```

You'll still need debug Chrome running (`npx -y @pro-vi/designer setup` handles Chrome + login + skill install, then you can skip the CLI afterward).

### Why a dedicated profile?

Since Chrome 136, `--remote-debugging-port` is blocked on the default profile for security. The dedicated `~/.chrome-designer-profile/` is a one-time login that persists across launches. Your normal Chrome is untouched.

### Auto-launch

After first setup, the MCP auto-launches debug Chrome from the saved profile on the first tool call of any session. You don't have to think about Chrome state again. If a non-debug Chrome is running, auto-launch bails with an actionable error.

### Bot detection

Login is a real human typing into a real Chrome window. `--remote-debugging-port` alone doesn't set `navigator.webdriver` (only `--enable-automation` does); user-agent is identical to normal Chrome. Cloudflare and Google OAuth see a normal session. First login on the new profile may trigger Google's "new device" verification — that's a standard one-time prompt.

### DESIGNER_CDP shell export

The MCP registration embeds `DESIGNER_CDP=9222` automatically, so Claude Code sessions work without any shell config. The shell export is only needed if you invoke the CLI directly (`designer session`, `designer prompt`, etc.) from an interactive terminal — add to `~/.zshenv` or equivalent.

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

`designer setup` registers the MCP for you (flavor depends on install path — see the [MCP-only section](#mcp-only--no-cli) above).

## The loop

```
1. Intent       → human describes what they want to feel / change
2. Survey       → agent reads the target repo: entities, operations, states,
                  failure modes, existing tokens — capability facts, verbatim
3. Relay        → designer_prompt = intent + capabilities, minimal faithful prompt
4. Taste        → hand the human the returned URL; they react in their own words
5. Interpret    → next designer_prompt (modify) or designer_ask (clarify)
6. Repeat 3-5   → until human says "that's it"
7. Promote      → designer_handoff — bundle is the decision record
```

Full guidance: [`skills/designer-loop/SKILL.md`](skills/designer-loop/SKILL.md) in this repo (also installed to `~/.claude/skills/designer-loop/` by `designer setup`).

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

## Known quirks

- **Folder-organized variants.** Claude Design sometimes organizes multi-file variants under a subfolder (`directions/sediment.html`). The live MCP's file-list scrape (`designer_list files`, `availableFiles` in session status, `newFiles` diff from `designer_prompt`) is flat-only; nested files are invisible until `designer_handoff`. Mitigation: `designer_prompt` auto-appends *"Keep all generated files at the project root; no subfolders."* Handoff bundle is folder-aware; `designer tasting` walks recursively.
- **React-controlled inputs.** `agent-browser fill` doesn't fire React's synthetic input event. The controller uses the native `HTMLTextAreaElement` value-setter + `dispatchEvent(new Event('input', { bubbles: true }))`, plus JS `.click()` on Send and Create. Both are canonical React-compat patterns.
- **Em-dash handoff filenames.** Claude's handoff pipeline wrote em-dash (`—`) into `index.html` hrefs but saved files with regular hyphens. `designer_handoff` detects and repairs (`repaired.renamed: [...]`). No-op when hrefs already resolve.
- **Cross-origin iframe.** Served HTML lives on `claudeusercontent.com` with a signed `t=` token in the URL. Direct fetch from node works without cookies. The token is session-scoped, not per-iteration.
- **UI regressions.** Claude has moved critical buttons mid-development (Export → Share dropdown). `designer health` is the early-warning system; run it periodically.

## Credits

Built on [`agent-browser`](https://github.com/ctate/agent-browser) by [@ctatedev](https://x.com/ctatedev) — the CDP driver that makes the real-Chrome attachment possible.

## License

[MIT](LICENSE).

