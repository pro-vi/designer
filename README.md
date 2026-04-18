# designer

MCP + CLI for autonomous iteration of **claude.ai/design** — Claude's web-based wireframe and high-fidelity design tool.

The human describes intent. The agent drives `claude.ai/design` via `agent-browser` (attached to a real Chrome over CDP), generates variants, iterates to high-fidelity, and exports a handoff bundle (HTML + CSS + chat transcript) to disk so a coding agent can implement the design for real.

## Stance

- **Single-vendor, single-purpose.** Only `claude.ai/design`. No kitchen sink.
- **`agent-browser` is the substrate.** Attach to your real Chrome via CDP — sidesteps Cloudflare + Google SSO.
- **Human is the designer.** See `~/.claude/skills/designer-loop`. AI proposes and executes; taste lives with the human.
- **Artifacts land on disk.** Every iteration + every handoff saves under `./artifacts/{key}/`.

## Install

```bash
cd /Users/provi/Development/_projs/designer
npm install
npm run check            # tsc --noEmit, should pass clean
```

## First run

```bash
git clone … && cd designer
npm install
./bin/designer setup        # or: npm run setup
```

Optional — make `designer` available globally so you can run it from anywhere:

```bash
npm link                    # creates a `designer` symlink in your npm global bin
designer setup              # now works from any cwd
```

`designer setup` is idempotent and auto-progresses. It will:

- Install deps if missing
- Check `agent-browser` is on PATH
- If Chrome is running (non-debug), ask you to Cmd+Q and wait
- Launch a dedicated debug Chrome (`--remote-debugging-port=9222`, profile at `~/.chrome-designer-profile/`)
- Wait for you to sign in to Claude and reach `claude.ai/design`
- Copy the `designer-loop` skill to `~/.claude/skills/`
- Register the MCP with Claude Code

Re-run if interrupted — every step is a no-op when already satisfied.

### Why a dedicated profile?

Since Chrome 136, `--remote-debugging-port` is blocked on the default profile for security. The dedicated `~/.chrome-designer-profile/` is a one-time login that persists across launches. Your normal Chrome profile is untouched.

### Bot detection

Login is a real human typing into a real Chrome window. `--remote-debugging-port` alone doesn't set `navigator.webdriver` (only `--enable-automation` does); the user-agent is identical to normal Chrome. Cloudflare and Google OAuth see a normal session. First login on the new profile may trigger Google's "new device" verification once — that's a normal one-time prompt.

### Manual setup (if you skip `designer setup`)

```bash
# 1. Quit Chrome fully (Cmd+Q)
# 2. Launch debug Chrome:
./scripts/designer-chrome.sh
# 3. Sign in to Claude, navigate to https://claude.ai/design
# 4. Verify CDP up:
curl -s http://127.0.0.1:9222/json/version | head
# 5. Set the env var (every designer call needs it; export to your rc):
export DESIGNER_CDP=9222
# 6. Register MCP with Claude Code:
claude mcp add --transport stdio designer \
  -- env DESIGNER_CDP=9222 "$PWD/bin/designer-mcp"
```

## CLI (verbs)

```
designer session [--key k] [--action status|ensure_ready|resume|create] [--name N] [--fidelity wireframe|highfi]
designer prompt "<text>" [--key k] [--file f.html] [--timeoutMs n] [--stabilityMs n]
designer ask    "<text>" [--key k] [--file f.html]
designer snapshot       [--key k] [--file f.html]
designer list|projects|files|status
designer open-file "<name>.html" [--key k]
designer fetch    "<name>.html" [--key k] [--out path]
designer handoff  [--key k] [--file "<name>.html"]
designer tasting  [--key k]          # write tasting.html harness for latest handoff + serve + open
designer close    [--key k]
```

All verbs take `--key` to isolate parallel sessions. State lives at `~/.designer/sessions.json`.

Run any verb via `./bin/designer <verb>` (or `designer <verb>` after `npm link`). `npm run setup` and `npm run doctor` are scripted shortcuts.

## MCP (6 tools)

| Tool | Purpose |
|---|---|
| `designer_session` | enter / create / resume / status. Default `action='status'` is a pure read. |
| `designer_prompt` | modify the design (HTML-diff wait). Returns `newFiles`, `activeFile`, `failureMode`, `htmlPath`, `chatReply`. |
| `designer_ask` | Q&A in chat (chat-panel wait). Returns the assistant reply. |
| `designer_list` | scope: `projects` or `files`. |
| `designer_snapshot` | capture current state (optionally switch file first). Default: slim metadata; `includeHtml: true` inlines. |
| `designer_handoff` | Export → Handoff to Claude Code → download + extract tar.gz. Returns README + paths. Auto-repairs a Claude-side em-dash bug in filenames. |

Register with Claude Code:

```bash
claude mcp remove designer 2>/dev/null
claude mcp add --transport stdio designer \
  -- env DESIGNER_CDP=9222 \
     /Users/provi/Development/_projs/designer/bin/designer-mcp
```

(`designer setup` does this for you. The wrapper `bin/designer-mcp` resolves the repo's tsx + mcp-server.ts internally, so the registration command stays short.)

## The full loop (from `designer-loop` skill)

```
1. Intent       → human describes what they want to feel/change
2. Read         → agent calls designer_session (returns availableFiles)
3. Propose      → designer_prompt with a terse, Claude-named-variants directive
4. React        → human reacts in the tasting harness (designer tasting)
5. Interpret    → next designer_prompt or designer_ask
6. Repeat 3-5   → until "yes"
7. Promote      → designer_handoff — bundle with README + chat transcript + all variants
```

## Tasting harness

`designer tasting --key <key>` takes the latest handoff bundle for a key and writes a `tasting.html` harness:

- top bar with variant tabs (keyboard shortcuts 1/2/3)
- persistent notes field (localStorage)
- full-viewport iframe underneath, switches between variant files
- served over `http://127.0.0.1:<port>` (required — `file://` blocks cross-origin XHR for JSX/CSS imports)

Only works when the bundle has multiple `.html` files (not the single-canvas pattern). See the skill for which prompt shape yields which bundle shape.

## Layout

```
designer/
├── package.json
├── tsconfig.json
├── mcp-server.ts          # stdio MCP server
├── cli.ts                 # same verbs, directly runnable
├── designer-controller.ts # core flow: session, prompt, ask, snapshot, handoff
├── browser.ts             # thin wrapper over agent-browser subprocess
├── tasting.ts             # tasting.html generator + http server
├── session-store.ts       # per-session state at ~/.designer/
├── artifact-store.ts      # writes HTML/PNG/JSON under ./artifacts/{key}/
├── selectors.json         # DOM selectors for claude.ai/design surface
├── scripts/
│   └── probe.ts           # manual DOM exploration helper
├── artifacts/             # generated outputs (gitignored)
└── logs/
```

## Known quirks

- **React-controlled inputs**: `agent-browser fill` doesn't fire React's synthetic input event. The controller uses the native `HTMLTextAreaElement` value-setter + `dispatchEvent(new Event('input', { bubbles: true }))`, plus JS `.click()` on Send. Both are canonical React-compat patterns.
- **Em-dash handoff bug**: Claude's handoff pipeline currently writes em-dash (`—`) into `index.html` hrefs but saves files with regular hyphens. `designer_handoff` detects and repairs (returns `repaired.renamed: [...]`). Safe if Anthropic fixes upstream — the repair is a no-op when hrefs already resolve.
- **Cross-origin iframe**: served HTML lives on `claudeusercontent.com` with a signed token — direct fetch from node works without cookies. The `t=` token is session-scoped, not per-iteration.
- **CDP debug profile**: `~/.chrome-designer-profile/` persists Claude login; only one Chrome can hold `--remote-debugging-port=9222` at a time.
