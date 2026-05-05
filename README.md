# opencode-acp-delegate

An Opencode plugin that lets the master agent delegate self-contained subtasks to any ACP-compatible agent via the Agent Client Protocol. One generic `agent_delegate` tool. You configure which agents are available in `opencode.json`. The plugin is not tied to any specific agent — gemini, opencode, Claude Code, Codex, or any other conforming ACP implementation all work the same way.

---

## Prerequisites

At least one ACP-compatible agent installed and on your PATH:

- **Google Gemini CLI** (`gemini --acp`):
  ```bash
  npm i -g @google/gemini-cli
  gemini   # walk through OAuth login once; quit with Ctrl-C when done
  ```
- **Opencode** (`opencode acp`): already available if you're running Opencode.
- **Claude Code, Codex, and others** with an ACP adapter.

---

## Installation

### Option A: Drop-in (no npm install)

Copy the single-file plugin into Opencode's plugins directory. Opencode loads every `.ts` file it finds there at startup.

**Global (all projects):**

```bash
curl -fsSL https://raw.githubusercontent.com/regaltsui/opencode-acp-delegate/main/drop-in/acp-delegate.ts \
  -o ~/.opencode/plugins/acp-delegate.ts
```

**Per-project:**

```bash
cp drop-in/acp-delegate.ts .opencode/plugins/acp-delegate.ts
```

Create `.opencode/plugins/` if it doesn't exist. Restart Opencode after copying.

### Option B: npm package (when published)

```bash
npm i opencode-acp-delegate
```

Then reference it in `opencode.json`:

```json
{
  "plugins": ["opencode-acp-delegate"]
}
```

---

## Configuration

Declare your agents in `opencode.json` under the plugin's options object:

```json
{
  "plugins": [
    ["opencode-acp-delegate", {
      "agents": [
        {
          "id": "gemini",
          "command": ["gemini", "--acp"],
          "default": true
        },
        {
          "id": "opencode",
          "command": ["opencode", "acp"]
        }
      ]
    }]
  ]
}
```

Field reference:

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Identifier used as `agentId` in tool calls. Must be unique within the array. |
| `command` | string[] | yes | Argv to spawn. First element is the binary; remaining elements are args. Resolved from PATH. |
| `default` | boolean | no | If `true`, this agent is used when no `agentId` is specified in the tool call. |
| `timeout` | number | no | Per-agent timeout override in milliseconds. Defaults to 600000 (600 seconds). |

---

## Usage

Once installed and configured, the master agent gains a new tool: `agent_delegate`.

Tool schema:

| Param | Type | Required | Description |
|---|---|---|---|
| `prompt` | string | yes | Self-contained task. The agent has no prior context from the current session. |
| `agentId` | string | no | Which registered agent to use. Omit to use the default agent. |
| `includeContext` | string[] | no | Context directories (relative to project cwd) to mention in the prompt preamble. |

### Single delegation

```
> use agent_delegate to summarize ./docs in 5 bullet points
```

The master issues a tool call with `{ prompt: "...", includeContext: ["docs"] }`, the agent runs to completion, and the master receives the final text.

### Parallel fan-out

The master can fan out across multiple independent subtasks:

```
> In parallel, use agent_delegate three times to (a) summarize ./docs,
  (b) review ./src for obvious bugs, (c) explain what ./scripts does.
  Then combine into one report.
```

Three independent agent subprocesses run concurrently. Each is isolated with its own session.

### Targeting a specific agent

```json
{ "prompt": "Review this diff for security issues.", "agentId": "opencode" }
```

### Async workflow

The tool returns `"started [acp-1]"` immediately. The master can continue working on other things. When the agent finishes, the result arrives as an `<acp-delegate-result>` notification.

---

## v1 Limitations

These are explicit non-features in v1, not oversights.

| Limitation | Detail |
|---|---|
| Text-only responses | Agents cannot read or write files, run shell commands, or call MCP servers. `clientCapabilities` is sent as `{}`. No fs or terminal capabilities are granted. |
| No persistent sessions | Each tool call spawns a fresh agent subprocess. There is no session reuse or warm subprocess pool across calls. |
| No MCP server | Opencode plugin only. There is no stdio MCP server wrapping `agent_delegate` for use in Claude Desktop, Cursor, or other MCP hosts. |
| One-shot only | A single tool call is a single prompt exchange. No multi-turn conversation within one call. The master agent carries conversational state across turns. |

---

## Troubleshooting

**"Unknown agentId: X"** — the `agentId` you passed doesn't match any `id` in the `agents` array in `opencode.json`. Check spelling and case.

**"No default agent configured"** — add `"default": true` to one agent entry in your config.

**"Agent binary not found"** — the binary in `command[0]` isn't on PATH. Verify with `which gemini` (or whichever binary you're using) and install if missing.

**Timeout** — the default timeout is 600 seconds (10 minutes). If a task is too large, split it into smaller subtasks or increase the per-agent `timeout` field in `opencode.json` (value in milliseconds).

**"Plugin export is not a function" / tool not appearing** — the plugin file must end with `export const id` and `export const server` (not `export default`). Verify the file wasn't truncated during copy, then fully restart Opencode (quit and relaunch, not just a new session).

---

> **Migrating from `opencode-gemini-cli-hook`?** Configure your gemini agent in `opencode.json` as shown above and use `agent_delegate` with `agentId: "gemini"`. The new plugin uses ACP mode (`gemini --acp`) rather than the headless JSON mode of the old plugin.

---

## License

MIT
