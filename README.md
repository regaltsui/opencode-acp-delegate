# opencode-acp-delegate

An Opencode plugin that lets the master agent delegate self-contained subtasks to any ACP-compatible agent via the Agent Client Protocol. The plugin exposes a dedicated, synchronous tool for each agent configured in `opencode.json` (e.g., `delegate_to_gemini`, `delegate_to_claude`). The plugin is not tied to any specific agent — gemini, opencode, Claude Code, Codex, or any other conforming ACP implementation all work the same way.

---

## Prerequisites

At least one ACP-compatible agent installed and on your PATH. The MVP is verified end-to-end against all three of the following:

- **Google Gemini CLI** (`gemini --acp`):
  ```bash
  npm i -g @google/gemini-cli
  gemini   # walk through OAuth login once; quit with Ctrl-C when done
  ```
- **Opencode** (`opencode acp`): already available if you're running Opencode. Authenticate once with `opencode auth login` if you have not already.
- **Claude Code** via the official adapter `@agentclientprotocol/claude-agent-acp`. No global install required — the plugin invokes it via `npx`. The adapter delegates to the `claude` CLI under the hood, so make sure `claude` is installed and authenticated:
  ```bash
  npm i -g @anthropic-ai/claude-code
  claude   # walk through login once; quit when done
  # the adapter itself will be downloaded by npx on first use
  ```
- **Codex and other conforming ACP agents**: configure the same way — the plugin only cares that the spawned binary speaks ACP over stdio.

---

## Installation

The plugin is a single self-contained `.ts` file at [`plugin/acp-delegate.ts`](./plugin/acp-delegate.ts). No build step, no npm publish required — Bun (which opencode runs under) loads the `.ts` directly via `package.json#main`. There are zero runtime dependencies; only the `@opencode-ai/plugin` peer (which opencode itself satisfies) is imported.

### Option 1: GitHub URL (recommended, zero copying)

Add this to `opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["github:regaltsui/opencode-acp-delegate"]
}
```

opencode pulls the package from GitHub at startup, resolves `package.json#main` → `plugin/acp-delegate.ts`, and imports it. Restart opencode and the `delegate_to_<id>` tools register.

To pass config (agent registry, model whitelists, etc.), use the tuple form:

```jsonc
{
  "plugin": [
    ["github:regaltsui/opencode-acp-delegate", {
      "injectSystemGuidance": true,
      "agents": [
        { "id": "gemini", "command": ["gemini", "--acp"] },
        { "id": "claude", "command": ["npx", "-y", "@agentclientprotocol/claude-agent-acp@latest"] }
      ]
    }]
  ]
}
```

### Option 2: Per-project file copy

If you don't want opencode to manage the install, copy the single file directly:

```bash
mkdir -p .opencode/plugins
curl -fsSL https://raw.githubusercontent.com/regaltsui/opencode-acp-delegate/main/plugin/acp-delegate.ts \
  -o .opencode/plugins/acp-delegate.ts
# optional TUI panel:
curl -fsSL https://raw.githubusercontent.com/regaltsui/opencode-acp-delegate/main/plugin/acp-delegate-tui.ts \
  -o .opencode/plugins/acp-delegate-tui.ts
```

opencode auto-discovers every `.ts` file it finds in `.opencode/plugins/` (per-project) or `~/.opencode/plugins/` (global). **Do not** add anything to the `plugin` array in `opencode.json` for this path — file-based plugins are discovered, not configured.

This path doesn't receive tuple options from opencode.json; configure agents via a JSON file instead (see Configuration below).

### Option 3: Global file copy (all projects)

```bash
mkdir -p ~/.opencode/plugins
curl -fsSL https://raw.githubusercontent.com/regaltsui/opencode-acp-delegate/main/plugin/acp-delegate.ts \
  -o ~/.opencode/plugins/acp-delegate.ts
```

Same caveat as Option 2: configure via JSON file, not tuple.

After any install method, **fully restart opencode** (quit and relaunch — a new session in the same process won't reload plugins).

---

## Configuration

The plugin needs to know which ACP agents you want to delegate to. **How** you supply that registry depends on which install path you used:

| Install path | Where to put config |
|---|---|
| **Option 1 — GitHub URL via `plugin` array** | Tuple's second element in `opencode.json`. opencode passes it to the plugin as options. |
| **Option 2/3 — Drop-in file** | JSON file on disk. opencode's file-based loader doesn't pass tuple options to file-loaded plugins. |

Both paths accept the **same options object shape** — only the wrapper differs.

### Tuple form (GitHub install)

```jsonc
{
  "plugin": [
    ["github:regaltsui/opencode-acp-delegate", {
      "agents": [
        { "id": "gemini",   "command": ["gemini", "--acp"] },
        { "id": "opencode", "command": ["opencode", "acp"] },
        { "id": "claude",   "command": ["npx", "-y", "@agentclientprotocol/claude-agent-acp@latest"] }
      ]
    }]
  ]
}
```

### JSON file (Option 2/3 file-copy install)

The plugin probes these paths in order; the first match wins:

1. `$OPENCODE_ACP_DELEGATE_CONFIG` (path to a JSON file)
2. `~/.config/opencode/acp-delegate.json`
3. `~/.opencode/acp-delegate.json`

```json
{
  "agents": [
    { "id": "gemini",   "command": ["gemini", "--acp"] },
    { "id": "opencode", "command": ["opencode", "acp"] },
    { "id": "claude",   "command": ["npx", "-y", "@agentclientprotocol/claude-agent-acp@latest"] }
  ]
}
```

When both are present (e.g. you have a copied file *and* a tuple in opencode.json), the explicit tuple options win and the JSON file is ignored.

Once configured, the master can target any of them using their specific tool name:

```text
> use delegate_to_gemini to summarize ./docs in 5 bullets
> use delegate_to_opencode to review ./src for obvious bugs
> use delegate_to_claude to explain what ./scripts does
```

Or fan out in parallel — three independent ACP subprocesses run concurrently, one per call.

Field reference:

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Unique identifier used to create the `delegate_to_<id>` tool. |
| `command` | string[] | yes | Argv to spawn. First element is the binary; remaining elements are args. Resolved from PATH. |
| `label` | string | no | Human-readable label used in the auto-generated tool description. Defaults to `id`. |
| `timeout` | number | no | Per-agent timeout override in milliseconds. Defaults to 600000 (10 minutes). |
| `description` | string | no | Hand-tuned `description` shown to the parent LLM in the tool list. Overrides the auto-generated boilerplate. The plugin always appends a footer with capability + capping facts so you don't have to repeat them. **Set this to give the LLM a sharp signal about when this *specific* agent is the right choice.** |
| `whenToUse` | string | no | One-line specialty summary used in the optional system-prompt routing block (see `injectSystemGuidance` below). Falls back to the first sentence of `description`, or a generic line. |
| `models` | string[] | no | Model allowlist. When non-empty, the generated tool exposes `model` as a closed `z.enum([...])` arg — the LLM must pick from these exact ids. Hallucinated names are rejected before spawn. |
| `defaultModel` | string | no | Used when the LLM omits the `model` arg. Must be in `models` if both are set. |
| `modelFlag` | string | no | CLI flag used to pass the chosen model to the spawned binary. Defaults to `--model`. Set per-agent (e.g. `-m` for `gemini-cli`). |

Top-level config (alongside `agents`):

| Field | Type | Required | Description |
|---|---|---|---|
| `injectSystemGuidance` | boolean | no | When `true`, the plugin registers an `experimental.chat.system.transform` hook that pushes a small `<acp-delegate-routing>` block (listing each registered tool and its specialty) into every agent's system prompt. Default `false` — most users prefer pure tool-description routing. Vanilla opencode plugin API; no external prompt-system dependency. |

### Worked example

```json
{
  "plugin": [
    ["opencode-acp-delegate", {
      "injectSystemGuidance": true,
      "agents": [
        {
          "id": "gemini",
          "command": ["gemini", "--acp"],
          "description": "Reach for delegate_to_gemini for bulk read-only analysis across many files (1M-token window) or a fast second opinion from an independent model family.",
          "whenToUse": "bulk multi-file analysis, fast second opinion",
          "models": ["gemini-2.5-pro", "gemini-2.5-flash"],
          "defaultModel": "gemini-2.5-flash",
          "modelFlag": "-m"
        },
        {
          "id": "claude",
          "command": ["npx", "-y", "@agentclientprotocol/claude-agent-acp@latest"],
          "description": "Reach for delegate_to_claude when you need deep design review, architecture critique, or careful refactoring analysis. Stronger at code reasoning than Gemini, slower.",
          "whenToUse": "deep design review, architecture critique",
          "models": ["claude-opus-4-5", "claude-sonnet-4-5"],
          "defaultModel": "claude-sonnet-4-5"
        },
        {
          "id": "opencode",
          "command": ["opencode", "acp"],
          "whenToUse": "quick general-purpose delegation"
        }
      ]
    }]
  ]
}
```

With this config the parent LLM sees three differentiated tools (`delegate_to_gemini`, `delegate_to_claude`, `delegate_to_opencode`), each with hand-tuned guidance. The Gemini and Claude tools also expose a `model` arg constrained to the listed ids, so the LLM can pick `claude-opus-4-5` for the gnarly refactor and `claude-sonnet-4-5` for everything else.

---

## Usage

Once installed and configured, the master agent gains a new tool for each registered agent, following the pattern `delegate_to_<agent-id>`. For example, an agent with `id: "gemini"` creates a tool named `delegate_to_gemini`.

Each tool is synchronous: the master agent calls the tool and gets the text result back in the same turn.

Example tool schema for `delegate_to_gemini`:

| Param | Type | Required | Description |
|---|---|---|---|
| `prompt` | string | yes | Self-contained task. The agent has no prior context from the current session. |
| `includeContext` | string[] | no | Relative paths under the project cwd (files or directories). Their contents are eagerly read and prepended to the prompt as `<context path="…">…</context>` blocks, capped at 256 KiB total / 64 KiB per file. Binary files and paths outside the project are skipped with a notice. Recursion into directories is one level at a time, in lexical order, until the budget is exhausted. |
| `model` | string (enum) | no | Only present when the agent's config declares `models: [...]`. Restricted to those exact ids — invalid values are rejected before the agent is spawned. Omit to use `defaultModel` (or the agent's built-in default). The chosen value is appended to the spawn command as `<modelFlag> <model>` (default flag: `--model`). |

Each call returns a structured result:

```ts
{
  output: string,             // what the master LLM sees
  metadata: {
    agentId: string,
    durationMs: number,
    status: "complete" | "error" | "cancelled",
    stopReason?: "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled",
    errorCode?: string        // ENOENT, ETIMEDOUT, ECANCELLED, EAGENT, …
  }
}
```

The master agent only sees `output`, so any load-bearing flag (truncation, refusal) is also embedded as a trailer in the output text. Specifically, when the agent reports `stopReason ∈ { max_tokens, max_turn_requests }` the response gets a `[delegate_to_<id>: stopReason=…, durationMs=…]` line appended so the master can detect truncation. The `metadata` object reaches the TUI and `tool.execute.after` plugin hooks for telemetry.

### Single delegation

```
> use delegate_to_gemini to summarize ./docs in 5 bullet points
```

The master issues a tool call, the `gemini` agent runs to completion, and the master receives the final text synchronously.

### Parallel fan-out

The master can fan out across multiple independent subtasks by calling the different tools.

```
> In parallel, use delegate_to_gemini to summarize ./docs,
  use delegate_to_opencode to review ./src for obvious bugs,
  and use delegate_to_claude to explain what ./scripts does.
  Then combine into one report.
```

Three independent agent subprocesses run concurrently. Each is isolated with its own session.

---

## v1 Limitations

These are explicit non-features in v1, not oversights.

| Limitation | Detail |
|---|---|
| Read-only filesystem | Agents can read files (`fs.readTextFile`) but cannot write files, run shell commands, or call MCP servers. Other capabilities are not granted. |
| No persistent sessions | Each tool call spawns a fresh agent subprocess. There is no session reuse or warm subprocess pool across calls. |
| No MCP server | Opencode plugin only. There is no stdio MCP server wrapping the tools for use in Claude Desktop, Cursor, or other MCP hosts. |
| One-shot only | A single tool call is a single prompt exchange. No multi-turn conversation within one call. The master agent carries conversational state across turns. |

---

## Troubleshooting

**"not found, npmjs, failed to install plugin"** — opencode tried to resolve a bare package name (`"opencode-acp-delegate"`) against the npm registry, but this package is not published to npm. Use the GitHub URL spec instead:

```jsonc
{ "plugin": ["github:regaltsui/opencode-acp-delegate"] }
```

Or with options:

```jsonc
{ "plugin": [["github:regaltsui/opencode-acp-delegate", { "agents": [...] }]] }
```

opencode (via Bun) clones the repo and resolves `package.json#main` → `plugin/acp-delegate.ts`. No npm publish needed.

**"Unknown tool: delegate_to_..."** — Check that the agent is correctly configured in your fallback JSON config file (`~/.config/opencode/acp-delegate.json` or `~/.opencode/acp-delegate.json`, or the path in `$OPENCODE_ACP_DELEGATE_CONFIG`). The `id` in the config must match the tool name.

**"Agent binary not found"** — the binary in `command[0]` isn't on PATH. Verify with `which gemini` (or whichever binary you're using) and install if missing.

**Timeout** — the default timeout is 600 seconds (10 minutes). If a task is too large, split it into smaller subtasks or increase the per-agent `timeout` field (value in milliseconds).

**"Plugin options must include a non-empty 'agents' array..."** — opencode's file-based loader (Options 2/3) does not pass tuple options to plugins. Set `OPENCODE_ACP_DELEGATE_CONFIG` to a JSON file with your agents, or drop the file at `~/.config/opencode/acp-delegate.json` or `~/.opencode/acp-delegate.json`. See the Configuration section for the schema. (Option 1 — GitHub URL — does support tuple options.)

**"Plugin export is not a function" / tool not appearing** — opencode's V1 plugin loader (`packages/opencode/src/plugin/shared.ts#readV1Plugin`) reads `mod.default` and expects an object `{ id, server }`. If `default` is a function (or missing), the loader falls through to a legacy path that iterates every named export and tries to call each one — which throws "Plugin export is not a function" when it hits the string `id` named export. The plugin file must end with `export default { id, server }`. If you copied an older version, re-fetch it. After updating, fully restart Opencode (quit and relaunch — a new session within the same process won't reload the plugin).

**Where are usage logs and runtime state?** As of v0.2, the plugin writes to a per-user state directory rather than `~/.opencode/`:

| File | Purpose |
|---|---|
| `<stateDir>/state.json` | In-flight delegations, recent history (capped at 20), and last health-probe results. Atomically replaced on every lifecycle event. |
| `<stateDir>/usage.jsonl` | Append-only one-line-per-completion usage log. Auto-rotates to `usage.jsonl.1` (overwriting any prior archive) once the live log crosses 5 MiB. Only one rolled archive is retained — this is a power-user diagnostic, not a long-term audit log. |

Path resolution (first match wins):

1. `$OPENCODE_ACP_DELEGATE_STATE_DIR` (full path override)
2. `$XDG_STATE_HOME/opencode/acp-delegate`
3. `~/.local/state/opencode/acp-delegate` (default)

Health probes: at plugin load, every registered agent is probed via a 5-second `initialize` round-trip. Failures are logged to `console.warn` and persisted under `state.json:health[]` — the plugin never blocks load on probe failure.

---

## Optional: TUI module (sidebar in-flight panel + prompt badge)

Install the companion TUI module to see live ACP delegation status in your sidebar:

```bash
curl -fsSL https://raw.githubusercontent.com/regaltsui/opencode-acp-delegate/main/plugin/acp-delegate-tui.ts 
  -o ~/.opencode/plugins/acp-delegate-tui.ts
```

The TUI module is a separate, optional plugin. It reads delegation state from `~/.local/state/opencode/acp-delegate/state.json` (which the server plugin writes) and renders:

- An `acp: N` badge next to the prompt while delegations are running. Hidden when nothing is in-flight; turns yellow once any call has been running for more than 60 seconds.
- A live in-flight panel in the sidebar listing each running delegation: `agent | prompt-snippet | elapsed`. Hidden when nothing is in-flight.
- An `/acp-doctor` slash command that opens a dialog with the health-probe results for every registered agent.

**Polling**: the TUI polls the state file at 1 Hz when idle and 4 Hz (250 ms) when at least one delegation is in-flight. It is purely a reader — it never writes the state file.

**Installation matrix**:

| Server plugin | TUI plugin | Result |
|---|---|---|
| installed | installed | full experience: tool + badge + sidebar + `/acp-doctor` |
| installed | not installed | tool works, no UI |
| not installed | installed | UI present but always empty (nothing writes state.json) |

The state directory must agree across both plugins. If you set `OPENCODE_ACP_DELEGATE_STATE_DIR` (or `XDG_STATE_HOME`), set it in your shell rc file so both inherit the same value.

---

## Routing guidance for the parent agent

The plugin gives the parent LLM three signals about when to delegate, in increasing strength:

1. **Tool description** (always on) — each `delegate_to_<id>` tool's description carries hand-tuned `description`/`whenToUse` text plus a fixed footer describing capabilities and capping. This is the primary, lowest-friction channel.
2. **System-prompt block** (opt in via `injectSystemGuidance: true`) — the plugin pushes a `<acp-delegate-routing>` block into every system prompt listing each registered tool with its one-line specialty. Useful when tool descriptions alone aren't getting picked up.
3. **AGENTS.md** (you write it) — opencode reads `AGENTS.md` from the project root automatically. Drop the snippet below in to give your parent agent stronger, project-specific guidance.

### AGENTS.md snippet

Paste this block into your project's `AGENTS.md` (or a section of it) to teach the parent agent the delegation pattern:

```md
## Delegation tools

This project has the `opencode-acp-delegate` plugin installed, which exposes one
`delegate_to_<id>` tool per registered ACP-compatible coding agent. These run as
fresh, isolated subprocesses with read-only filesystem access — they cannot
write files, run shells, or escape the project directory.

**Reach for delegation when:**
- Summarizing or analyzing 5+ files (offload bulk reading)
- Getting a second opinion from an independent model family on a hard call
- Fanning out 3+ independent subtasks in parallel
- Hitting your own context window on a large refactor

**Skip delegation when:**
- The task is a single-file edit with an exact path
- A simple grep/search would answer it
- The task requires multi-turn back-and-forth (each delegate call is one-shot)

**How to call:**
- The tool is synchronous — you receive the result in the same turn.
- The prompt must be fully self-contained. The delegated agent has no prior
  session context.
- Pass file/directory paths via `includeContext: ["path/to/file", "src/"]` to
  attach their contents inline (capped at 256 KiB total / 64 KiB per file).
- If the agent's config exposes a `model` arg, pick the model that matches the
  task's depth-vs-speed tradeoff. Omit to use the configured default.

**Truncation:** if the delegated response ends with a
`[delegate_to_<id>: stopReason=max_tokens, …]` trailer, the agent ran out of
budget mid-answer. Re-issue with a narrower prompt or split into subtasks.
```

Customize the bullet lists with your registered agents' specialties so the parent agent learns *which* delegate to pick for each kind of task.

---

> **Migrating from `opencode-gemini-cli-hook`?** This plugin provides a similar capability but with a more robust, multi-agent architecture. Configure your gemini agent in `opencode.json` as shown above and use the `delegate_to_gemini` tool.

---

## License

MIT
