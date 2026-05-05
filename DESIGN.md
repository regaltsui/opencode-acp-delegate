# DESIGN: Opencode ACP Delegate Plugin

## 1. Purpose

Inside an Opencode session, allow the master agent to delegate self-contained subtasks to any agent that speaks the Agent Client Protocol (ACP). The master stays on its primary provider; the ACP agent is a callable worker that returns text.

This plugin is the ACP-native counterpart to `opencode-gemini-cli-hook`. Where that plugin invokes `gemini-cli` via its headless JSON output format, this plugin speaks a standard protocol. Any conforming ACP agent — `gemini --acp`, `opencode acp`, Claude Code via adapter, Codex, and others — can be registered and called without plugin-specific code per agent.

The master-worker shape is the same: each delegation is a self-contained subtask whose only output is text the master will read. The protocol is different: instead of parsing a proprietary JSON output format, the plugin drives a JSON-RPC 2.0 session over stdio.

## 2. Why ACP

The Agent Client Protocol (https://agentclientprotocol.com) is an open, Apache-licensed standard created by Zed Industries in August 2025. It defines a JSON-RPC 2.0 message exchange over stdio for spawning and communicating with AI agents as subprocesses.

The alternative to ACP is per-agent CLI parsing: each agent has its own output format, its own flags, its own error codes. `opencode-gemini-cli-hook` works well for gemini-cli specifically, but adding a second agent (say, `opencode acp` or Codex) would require a separate plugin with its own output parser, its own failure-mode table, its own test harness.

ACP gives a single integration point:

| Approach | Agents supported | Protocol | Maintenance cost |
|---|---|---|---|
| Per-agent CLI parsing | One per plugin | Proprietary stdout | High — each agent is a new plugin |
| ACP | Any conforming agent | JSON-RPC 2.0 over stdio | Low — one plugin, agent list is config |

The tradeoff: ACP requires the agent to support `--acp` or equivalent. Agents that only expose a headless CLI (no ACP mode) still need the per-agent approach. For agents that do support ACP, this plugin is the right integration.

Transport: JSON-RPC 2.0 over stdio (subprocess). SDK: `@agentclientprotocol/sdk` v0.21.0.

## 3. One-Shot Session Model

Each tool call maps to exactly one ACP session lifecycle. There is no persistent child process, no session reuse across calls, no connection pool.

The lifecycle per call:

1. **Spawn** the agent subprocess with the configured command (e.g. `["gemini", "--acp"]`).
2. **Initialize** — send `initialize` with `clientCapabilities: {}` and wait for `initializeResult`. Empty capabilities is deliberate: see §4.
3. **New session** — send `session/new` and wait for `newSessionResult { sessionId }`.
4. **Prompt** — send `session/prompt` with the user's prompt text and the `sessionId`.
5. **Collect updates** — receive zero or more `session/update` notifications (streaming chunks). Accumulate text parts.
6. **Await result** — receive `promptResult { stopReason }`. Concatenate accumulated text and return it to the master.
7. **Close** — send `session/close` if the agent advertised that capability in `initializeResult`; otherwise skip.
8. **Kill** the subprocess.

Steps 1-8 happen within a single `execute` call. The subprocess is single-use and never reused.

Three parallel `agent_delegate` calls in one master turn spawn three independent subprocesses. No coordination needed; the OS handles scheduling.

### 3.1 Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│ Opencode session (master agent — any provider/model)            │
│                                                                 │
│   plans → tool call: agent_delegate({ prompt, agentId, ... })   │
│   plans → tool call: agent_delegate(...) (parallel-safe)        │
│                          │                                      │
└──────────────────────────┼──────────────────────────────────────┘
                           ▼
            ┌──────────────────────────────────┐
            │ Plugin: opencode-acp-delegate    │
            │                                  │
            │   tool registry:                 │
            │     - agent_delegate             │
            │                                  │
            │   per-call:                      │
            │     spawn agent subprocess       │
            │     drive ACP session lifecycle  │
            │     collect text, return         │
            └──────────────┬───────────────────┘
                           │  one subprocess per tool call
                           ▼
            ┌──────────────────────────────────┐
            │ ACP agent subprocess             │
            │                                  │
            │   e.g. gemini --acp              │
            │        opencode acp              │
            │        claude-code-acp-adapter   │
            │                                  │
            │   JSON-RPC 2.0 over stdio        │
            └──────────────────────────────────┘
```

### 3.2 Plugin shape

The `@opencode-ai/plugin` 1.14 API exposes:
- `Plugin = (input: PluginInput, options?: PluginOptions) => Promise<Hooks>` — config flows through `options` (the tuple-form in `opencode.json`'s `plugin` array).
- Tools are registered via `Hooks.tool: { [name]: ToolDefinition }` (singular `tool`, not `tools`).
- `tool({ description, args, execute })` where `args` is a raw zod shape (object literal of zod schemas), not `z.object(...)`.
- `execute(args, ctx)` where `ctx: ToolContext` has `directory`, `worktree`, `abort: AbortSignal`, `metadata({title?, metadata?})`, `sessionID`, `messageID`, `agent`, and `ask`.

The plugin entry exports only `{ id, server }`. The ACP session runner lives on a `./acp` subpath. This prevents Opencode's legacy plugin-loader fallback from calling helper functions as plugins.

```ts
// opencode-acp-delegate entry
export const id = "opencode-acp-delegate"
export const server: Plugin = plugin
```

No `stop` hook needed. There's nothing persistent to clean up between calls. Cancellation is honored via `ctx.abort` (an `AbortSignal`), which the session runner translates into SIGTERM then SIGKILL on the subprocess.

### 3.3 Per-call concerns

| Concern | Strategy |
|---|---|
| Hung subprocess | Per-call timeout (configurable). On timeout: SIGTERM, then SIGKILL after a grace period. |
| Concurrent calls | None needed. Each call is a separate subprocess. OS handles scheduling. |
| Stdout buffer | Bound to N MB. Overflow kills the subprocess and returns an error. |
| Subprocess orphaning | `detached: false` (default); subprocess dies if Opencode dies. A `process.on('exit')` reaper SIGTERMs any in-flight subprocesses. |
| Error mapping | Translate `spawn ENOENT`, JSON-RPC errors, and ACP protocol errors into actionable messages. |

## 4. v1 Limitations

These are explicit non-features in v1. They are not oversights.

| Limitation | Detail |
|---|---|
| No fs/terminal capabilities | `clientCapabilities` is sent as `{}`. The plugin never grants `fs.readTextFile`, `fs.writeTextFile`, `terminal`, or any other capability. Agents cannot read or write files, run shell commands, or call MCP servers through this plugin. This is a deliberate security boundary. |
| No persistent sessions | Each tool call spawns a fresh subprocess and drives a complete session lifecycle from scratch. There is no session reuse, no warm subprocess pool, no continuity between calls. |
| No MCP server | This is an Opencode plugin only. There is no stdio MCP server wrapping `agent_delegate` for use in Claude Desktop, Cursor, or other MCP hosts. |
| One-shot only | A single tool call is a single `session/prompt` exchange. There is no multi-turn conversation within one tool call. The master agent is the one carrying conversational state across turns. |
| Text output only | `session/update` notifications carry message parts. v1 collects only text parts. Non-text parts (images, files, structured data) are ignored. |
| No streaming to master | Text chunks from `session/update` are accumulated internally and returned as a single string when `promptResult` arrives. The master does not see incremental output. |

The contrast with `opencode-gemini-cli-hook` is worth stating directly: that plugin uses `--yolo`, which lets gemini-cli auto-accept file edits and shell commands. Those side effects are silent from the master's perspective. This plugin takes the opposite position: agents get no capabilities by default, so there are no silent side effects. If you need an agent to read files, pass the relevant content in the prompt.

## 5. Agent Registry Config

Agents are declared in `opencode.json` under the plugin's options object. The `agents` array is ordered; the first entry with `"default": true` is used when the master calls `agent_delegate` without specifying an agent. If no default is marked, the first entry is used.

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

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes | Identifier passed to `agent_delegate` as the `agentId` param. Must be unique within the array. |
| `command` | string[] | yes | Argv to spawn. First element is the binary; remaining elements are args. Resolved against `PATH`. |
| `default` | boolean | no | If `true`, this agent is used when no `agentId` param is passed to `agent_delegate`. At most one entry should be `true`. |

The `agent_delegate` tool schema:

| Param | Type | Required | Notes |
|---|---|---|---|
| `prompt` | string | yes | Self-contained instruction. The agent has no prior session context. |
| `agentId` | string | no | `id` of the agent to use. Defaults to the entry marked `default`. |

## 6. ACP Protocol Flow

The sequence below shows one complete delegation. JSON-RPC request IDs are omitted for readability.

```
Client (plugin)              Agent (subprocess)
─────────────               ──────────────────
spawn ["gemini", "--acp"]
                         ─► stdin/stdout connected
initialize ─────────────►
  clientCapabilities: {}
                         ◄─ initializeResult
                              serverCapabilities: { ... }
session/new ────────────►
                         ◄─ newSessionResult { sessionId }
session/prompt ─────────►
  sessionId, prompt text
                         ◄─ session/update (streaming chunk)
                              parts: [{ type: "text", text: "..." }]
                         ◄─ session/update ...
                         ◄─ promptResult { stopReason: "end_turn" }
[session/close] ────────►   (only if serverCapabilities includes session/close)
kill process
```

The plugin accumulates all `text` parts from `session/update` notifications in order. When `promptResult` arrives, the concatenated text is returned to the master as the tool result.

If the subprocess exits before `promptResult` arrives, the call fails with a structured error containing the exit code and any stderr output.

## 7. Future Roadmap

These are planned improvements, not commitments. Priority order is approximate.

| Item | Description |
|---|---|
| Capability negotiation | Let callers opt into specific capabilities per call (e.g. `fs.readTextFile` for read-only file access). Requires a trust model and probably a per-agent allowlist in config. |
| Streaming to master | Surface `session/update` chunks incrementally via `ctx.metadata()` so the master sees partial output during long delegations. |
| Non-text parts | Handle image and structured-data parts from `session/update`. Return them in the tool result metadata rather than discarding. |
| Persistent subprocess pool | Keep one warm subprocess per agent ID across calls to eliminate cold-start latency. Requires a mutex per agent and restart logic on subprocess death. Deferred until cold-start cost is demonstrated to be a real user pain point. |
| Multi-turn within a call | Allow the master to pass a conversation history (not just a single prompt) so the agent has prior context. Useful for iterative refinement without spawning a new subprocess each turn. |
| MCP server | Expose `agent_delegate` as a stdio MCP tool for use in Claude Desktop, Cursor, and other MCP hosts. Reuses the ACP session runner; adds a `directory` param since MCP has no `ctx.directory`. |
| Per-agent timeout config | Allow `timeout` to be set per agent entry in the registry, not just globally. Useful when one agent is known to be slow. |
| Health check on startup | On plugin load, verify each registered agent binary is on PATH and optionally probe it with a minimal `initialize` exchange. Surface misconfiguration early rather than at first tool call. |

## 8. Failure Modes

| Failure | Detection | Response |
|---|---|---|
| Agent binary not on PATH | `spawn ENOENT` | "Agent `<id>` command `<binary>` not found. Check your PATH or the `command` field in opencode.json." |
| Agent not in registry | Config lookup miss | "No agent with id `<id>` registered. Available: `<list>`." |
| ACP initialize timeout | No `initializeResult` within timeout | Kill subprocess; return timeout error with agent id. |
| JSON-RPC error response | Error object in response | Surface `code` and `message` from the error object. |
| Subprocess exits before promptResult | Exit event before `promptResult` | Return error with exit code and stderr tail. |
| promptResult stopReason is error | `stopReason: "error"` | Return error; include any error text from accumulated parts. |
| Stdout buffer overflow | Buffer exceeds limit | Kill subprocess; return error with byte count. |
| Per-call timeout | Wall-clock timeout fires | SIGTERM subprocess; SIGKILL after grace period; return timeout error. |

## 9. References

- Agent Client Protocol spec: https://agentclientprotocol.com
- ACP SDK: https://www.npmjs.com/package/@agentclientprotocol/sdk
- Opencode plugin docs: https://opencode.ai/docs/plugins/
- Opencode ACP server: https://opencode.ai/docs/agents/
- `@opencode-ai/plugin`: https://www.npmjs.com/package/@opencode-ai/plugin
- Prior art (per-agent approach): https://github.com/regaltsui/opencode-gemini-cli-hook
