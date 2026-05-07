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

Transport: JSON-RPC 2.0 over stdio (subprocess). The plugin ships a hand-rolled JSON-RPC client built on `node:child_process` and `node:readline` — no external SDK dependency. This keeps the plugin a single zero-runtime-dep file that loads directly from a GitHub URL via opencode's plugin loader. The implementation conforms to the [ACP spec](https://agentclientprotocol.com); the wire-level behaviour is identical to using `@agentclientprotocol/sdk`, just inlined.

## 3. Synchronous One-Shot Session Model

Each tool call maps to exactly one ACP session lifecycle. The tool call is **synchronous**: it blocks until the agent subprocess completes, and returns the final text result directly. There is no persistent child process, no session reuse across calls, and no connection pool.

The lifecycle per call:

1. **Spawn** the agent subprocess with the configured command (e.g. `["gemini", "--acp"]`).
2. **Initialize** — send `initialize` with `clientCapabilities` and wait for `initializeResult`.
3. **New session** — send `session/new` and wait for `newSessionResult { sessionId }`.
4. **Prompt** — send `session/prompt` with the user's prompt text and the `sessionId`.
5. **Collect updates** — receive zero or more `session/update` notifications (streaming chunks). Accumulate text parts.
6. **Await result** — receive `promptResult { stopReason }`.
7. **Return to master** - The concatenated text is returned as the direct result of the tool call.
8. **Close** — send `session/close` if the agent advertised that capability in `initializeResult`; otherwise skip.
9. **Kill** the subprocess.

Steps 1-9 happen within a single `execute` call. The subprocess is single-use and never reused.

Three parallel tool calls in one master turn spawn three independent subprocesses. No coordination needed; the OS handles scheduling.

### 3.1 Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│ Opencode session (master agent — any provider/model)            │
│                                                                 │
│   plans → tool call: delegate_to_gemini({ prompt, ... })        │
│   plans → tool call: delegate_to_claude(...) (parallel-safe)    │
│                          │                                      │
└──────────────────────────┼──────────────────────────────────────┘
                           ▼
            ┌──────────────────────────────────┐
            │ Plugin: opencode-acp-delegate    │
            │                                  │
            │   tool registry:                 │
            │     - delegate_to_gemini         │
            │     - delegate_to_claude         │
            │     - ...                        │
            │                                  │
            │   per-call:                      │
            │     spawn agent subprocess       │
            │     drive ACP session lifecycle  │
            │     await & return text          │
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
- Tools are registered via `Hooks.tool: { [name]: ToolDefinition }`. The plugin dynamically generates this object, creating one tool for each agent in the configuration.
- `tool({ description, args, execute })` where `args` is a raw zod shape (object literal of zod schemas), not `z.object(...)`.
- `execute(args, ctx)` where `ctx: ToolContext` has `directory`, `worktree`, `abort: AbortSignal`, `metadata({title?, metadata?})`, `sessionID`, `messageID`, `agent`, and `ask`.

The plugin entry exports only `{ id, server }`.

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
| Error mapping | Translate `spawn ENOENT`, JSON-RPC errors, and ACP protocol errors into actionable messages returned synchronously from the tool call. |

## 4. v1 Limitations

These are explicit non-features in v1, not oversights.

| Limitation | Detail |
|---|---|
| Plugin filesystem service is read-only | `clientCapabilities` is sent as `{ fs: { readTextFile: true } }`. Any FS request the agent routes through the *client* (us) is read-only, cwd-contained, and bounded. The master also performs eager bounded reads on `includeContext` paths (see §5) under the same containment + per-file size cap. The agent's *own* tools (its built-in shell/write/web) go through `session/request_permission` instead — see `autoApprove` below. |
| Permission policy is binary, not granular | The plugin answers `session/request_permission` by selecting an `allow_once` (when `autoApprove: true`, the default) or `reject_once` (when `autoApprove: false`) option. There is no per-tool allowlist, no interactive prompt to the master agent, and no remembering of `allow_always` decisions across calls (each call is a fresh subprocess). Per-tool granular policy is on the future roadmap (§7). |
| No persistent sessions | Each tool call spawns a fresh subprocess and drives a complete session lifecycle from scratch. There is no session reuse, no warm subprocess pool, no continuity between calls. |
| No MCP server | This is an Opencode plugin only. There is no stdio MCP server wrapping the tools for use in Claude Desktop, Cursor, or other MCP hosts. |
| One-shot only | A single tool call is a single `session/prompt` exchange. There is no multi-turn conversation within one tool call. The master agent is the one carrying conversational state across turns. |
| Text output only | `session/update` notifications carry message parts. v1 collects only text parts. Non-text parts (images, files, structured data) are ignored. |
| No streaming to master | Text chunks from `session/update` are accumulated internally and returned as a single string when `promptResult` arrives. The master does not see incremental output. Deliberately deferred — the master LLM only ever sees the final tool-result `output` string regardless of how many intermediate `ctx.metadata` calls fire, so streaming chunks would help the TUI but not the model. A title-only progress marker (bytes / elapsed) is acceptable; partial-text streaming is out of scope. |

## 5. Agent Registry Config

Agents are declared in `opencode.json` under the plugin's options object. For each agent in the `agents` array, a tool named `delegate_to_<id>` is created.

```json
{
  "plugin": [
    ["opencode-acp-delegate", {
      "agents": [
        {
          "id": "gemini",
          "command": ["gemini", "--acp"]
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
| `id` | string | yes | Unique identifier used to construct the tool name `delegate_to_<id>`. |
| `command` | string[] | yes | Argv to spawn. First element is the binary; remaining elements are args. Resolved against `PATH`. |

The schema for each generated tool (e.g., `delegate_to_gemini`):

| Param | Type | Required | Notes |
|---|---|---|---|
| `prompt` | string | yes | Self-contained instruction. The agent has no prior session context. |
| `includeContext` | string[] | no | Relative paths (files or directories) under the project cwd. The plugin **eagerly** reads each path and prepends a `<context path="...">…</context>` block to the prompt, capped at `INCLUDE_CONTEXT_PER_FILE_BUDGET_BYTES = 64 KiB` per file and `INCLUDE_CONTEXT_TOTAL_BUDGET_BYTES = 256 KiB` total. Files are skipped when they look binary (a NUL byte appears in the first 8 KiB), the path escapes the cwd, or either budget is exhausted (with a `[truncated]` notice). Eager rather than lazy because not all ACP agents reliably issue `fs/read_text_file` requests for paths that are merely *mentioned* in a prompt. |

## 6. ACP Protocol Flow

The sequence below shows one complete delegation. The flow is fully synchronous from the perspective of the master agent.

```
Client (plugin)              Agent (subprocess)
─────────────               ──────────────────
spawn ["gemini", "--acp"]
                         ─► stdin/stdout connected
initialize ─────────────►
  clientCapabilities: { fs: { readTextFile: true } }
                         ◄─ initializeResponse
                              agentCapabilities.sessionCapabilities.close?
session/new ────────────►
                         ◄─ newSessionResponse { sessionId }
session/prompt ─────────►
  sessionId, prompt text
                         ◄─ session/update (streaming chunk)
                              parts: [{ type: "text", text: "..." }]
                         ◄─ session/update ...
                         ◄─ promptResponse { stopReason }
[session/close] ────────►   (only if agentCapabilities.sessionCapabilities.close is truthy)
kill process
```

The plugin accumulates all `text` parts from `session/update` notifications in order. When `promptResponse` arrives, the concatenated text is returned to the master as the direct, synchronous result of the tool call.

### 6.1 stopReason handling

`promptResponse.stopReason` is captured and surfaced to the caller. The mapping is:

| stopReason | status | Treatment |
|---|---|---|
| `end_turn` | `complete` | Output returned as-is; no trailer. |
| `max_tokens` | `complete` | Output returned with trailer `[delegate_to_<id>: stopReason=max_tokens, durationMs=…]`. The master agent must see this — silently truncated answers are otherwise indistinguishable from complete ones. |
| `max_turn_requests` | `complete` | Same as `max_tokens`. |
| `refusal` | `error` | Output replaced with a refusal notice; metadata records `stopReason=refusal`. |
| `cancelled` | `cancelled` | Output replaced with cancellation notice. Reached when the master aborts mid-flight or sends `session/cancel`. |

### 6.2 Cancellation

When `ctx.abort` fires, the plugin:

1. Sends `session/cancel` notification (best-effort, fire-and-forget — never awaits agent ack).
2. Sends SIGTERM to the subprocess immediately after.
3. After `GRACE_PERIOD_MS = 5_000`, sends SIGKILL if the process is still alive.

The cancellation path does **not** wait for the agent to deliver a `cancelled` `promptResponse` — most agents do not implement post-cancel cleanup correctly. Returning quickly is more important than protocol purity.

### 6.3 Graceful close

In the success path the plugin attempts `session/close` only when `initializeResponse.agentCapabilities.sessionCapabilities.close` is truthy. The close request is bounded by a 1-second timeout; on timeout or error the subprocess is killed normally.

If the subprocess exits before `promptResponse` arrives, the tool call fails with a structured error message returned synchronously, and `usage.jsonl` records `status: "error"`.

### 6.4 Permission requests (`session/request_permission`)

Most ACP agents have their own built-in tools (shell, web fetch, file write, etc.) that are *not* serviced by the client. Before invoking one, the agent sends a `session/request_permission` request whose `params.options[]` lists the choices available to the user — each option carries an `optionId`, a human-readable `name`, and a `kind ∈ { allow_once, allow_always, reject_once, reject_always }`. The expected response is `{ outcome: { outcome: "selected", optionId } }` or `{ outcome: { outcome: "cancelled" } }` (the latter signalling the user dismissed the prompt).

The plugin answers automatically. Per agent, `autoApprove` (default `true`) chooses the policy:

| `autoApprove` | Behavior |
|---|---|
| `true` (default) | Pick the first option whose `kind` is `allow_once`, else `allow_always`, else fall back to `cancelled`. |
| `false` | Pick the first option whose `kind` is `reject_once`, else `reject_always`, else fall back to `cancelled`. |

Returning `cancelled` is a last-resort fallback only when the agent provides no matching option — the previous v0.2 behavior of *always* returning `cancelled` made every shell/web/write attempt fail with a confusing "user cancelled the prompt" message back to the master. With `autoApprove: true`, agents can use their own tools normally; with `autoApprove: false`, the agent receives a clean rejection and can plan around it instead of retrying.

The plugin does not currently distinguish between tool kinds — `autoApprove` applies uniformly to every permission request within a session. Granular per-tool policy is on the §7 roadmap.

## 7. Future Roadmap

These are planned improvements, not commitments. Priority order is approximate. Items marked ✅ landed in v0.2.

| Item | Status | Description |
|---|---|---|
| Per-agent timeout config | ✅ v0.2 | `timeout` is honored per agent entry in the registry. See `AgentConfig.timeout` in [plugin/acp-delegate.ts](plugin/acp-delegate.ts). |
| Health check on startup | ✅ v0.2 | `probeAll(registry)` is fired (not awaited) at plugin load and the result is persisted under `state.json:health[]`. The TUI's `/acp-doctor` reads this. See §10. |
| Eager context inclusion | ✅ v0.2 | The `includeContext` schema field on each tool reads files in-process and injects a fenced preamble. See §5. |
| Per-agent permission policy | ✅ v0.3 | `autoApprove` (default `true`) controls whether the plugin selects `allow_once` or `reject_once` from the options the agent provides on `session/request_permission`. See §6.4. |
| Granular per-tool permission | Deferred | Replace the binary `autoApprove` with a per-tool allowlist (e.g. allow `read`, allow `write`, deny `webfetch`). Requires inspecting `toolCall.kind` on each request_permission call and matching against a config-supplied policy. |
| `fs.writeTextFile` service | Deferred | Advertise `fs.writeTextFile: true` and add a write handler with cwd-containment, mirroring `readBoundedTextFile`. Less risky than auto-approving the agent's full toolset because the plugin polices the path. |
| Streaming to master | Deferred | Surface `session/update` chunks incrementally via `ctx.metadata()` so the TUI sees partial output during long delegations. The master LLM still only sees the final tool-result string, so this is a TUI win, not a model-routing win. A title-only progress marker (bytes / elapsed) would be sufficient if implemented. |
| Non-text parts | Deferred | Handle image and structured-data parts from `session/update`. Return them in the tool result metadata rather than discarding. |
| Persistent subprocess pool | Deferred | Keep one warm subprocess per agent ID across calls to eliminate cold-start latency. Requires a mutex per agent and restart logic on subprocess death. Deferred until cold-start cost is demonstrated to be a real user pain point. |
| Multi-turn within a call | Deferred | Allow the master to pass a conversation history (not just a single prompt) so the agent has prior context. Useful for iterative refinement without spawning a new subprocess each turn. |
| MCP server | Deferred | Expose the delegation tools via a stdio MCP server for use in Claude Desktop, Cursor, and other MCP hosts. Reuses the ACP session runner; adds a `directory` param since MCP has no `ctx.directory`. |
| Modular split for npm publish | Deferred | The current single-file layout in `plugin/acp-delegate.ts` matches the gemini-delegate convention and keeps the repo minimal until publish. When/if we publish to npm, split into `src/` modules with proper tests and a bundler producing the single-file plugin output. |
| `detached: true` subprocess group | Deferred | If Opencode is `kill -9`'d, ACP children may be orphaned. Spawning each subprocess in its own pgroup and using `process.kill(-pid)` for cleanup hardens this. |

## 8. Failure Modes

| Failure | Detection | Response |
|---|---|---|
| Agent binary not on PATH | `spawn ENOENT` | Return error synchronously: "Agent `<id>` command `<binary>` not found..." |
| Agent not in registry | (N/A with per-agent tools) | The tool would not exist in the first place. |
| ACP initialize timeout | No `initializeResponse` within timeout | Kill subprocess; return timeout error message synchronously. |
| JSON-RPC error response | Error object in response | Return error message synchronously. |
| Subprocess exits before promptResponse | Exit event before `promptResponse` | Return error with exit code and stderr tail synchronously. |
| `promptResponse.stopReason: refusal` | Inspected after `prompt()` resolves | Replace `output` with refusal notice; metadata records `status: "error"`, `stopReason: "refusal"`. |
| `promptResponse.stopReason: max_tokens` / `max_turn_requests` | Inspected after `prompt()` resolves | Output preserved with `[delegate_to_<id>: stopReason=…]` trailer so the master can detect truncation. |
| Stdout buffer overflow | Buffer exceeds `MAX_OUTPUT_BYTES` | Continue to drain (the agent may still send `promptResponse`); output is truncated with a `[output truncated at N bytes]` notice. |
| Per-call timeout | Wall-clock timeout fires | SIGTERM subprocess; SIGKILL after grace period; return timeout error synchronously. |
| Master cancellation | `ctx.abort` fires | Send `session/cancel` notification (best-effort), then SIGTERM, then SIGKILL after grace. Return `status: "cancelled"`. |

## 9. References

- Agent Client Protocol spec: https://agentclientprotocol.com
- Opencode plugin docs: https://opencode.ai/docs/plugins/
- Opencode ACP server: https://opencode.ai/docs/agents/
- `@opencode-ai/plugin`: https://www.npmjs.com/package/@opencode-ai/plugin
- Single-file convention reference: https://github.com/regaltsui/opencode-gemini-delegate

## 10. State file & cross-process integration

The plugin persists runtime state to a JSON file so a second process (e.g. a future TUI module) can observe what is currently running.

### Path resolution

First match wins:

1. `$OPENCODE_ACP_DELEGATE_STATE_DIR` — full directory path override.
2. `$XDG_STATE_HOME/opencode/acp-delegate` — XDG Base Directory spec.
3. `~/.local/state/opencode/acp-delegate` — default.

Files inside the state directory:

| File | Purpose |
|---|---|
| `state.json` | Atomically-replaced snapshot of inflight + recent + health entries. |
| `usage.jsonl` | Append-only one-line-per-event usage log. Replaces the legacy `~/.opencode/acp-delegate-usage.jsonl` location. |

### Schema

`state.json` is the on-disk projection of the `AcpState` interface (see [plugin/acp-delegate.ts](plugin/acp-delegate.ts)):

```ts
interface AcpState {
  version: 1
  updatedAt: number
  pid: number
  inflight: InflightEntry[]   // currently running
  recent: RecentEntry[]       // capped at STATE_RECENT_MAX, most recent first
  health: HealthEntry[]       // last probe per registered agent
}
```

Each call's lifecycle:

1. **start** — `recordInflight(entry)` adds to `inflight[]`.
2. **end** — `resolveInflight(callId, result)` removes from `inflight[]` and prepends to `recent[]` (capped at `STATE_RECENT_MAX = 20`).
3. **probe** — `setHealthResults(health)` replaces `health[]` entirely (one entry per registered agent).

### Atomic write protocol

Every mutation goes through a single module-level `writeQueue` promise chain to serialise writes from concurrent delegations. Each save is:

1. Serialise the new state to a temp file `state.json.<pid>.<rand>.tmp` in the same directory.
2. `rename(tmp, "state.json")` — atomic on POSIX.
3. On any error during write/rename, attempt to unlink the temp file and re-throw to the caller.

Callers wrap every state-file API call in `.catch(() => {})` — the state file is **best-effort**. The tool must keep working even if the state directory is unwritable.

### Health probe

At plugin load, every registered agent is probed in parallel via `probeAll(registry)`:

- Spawn the agent's `command` with `stdio: pipe`.
- Send `initialize` over JSON-RPC, race against a 5-second timer (`HEALTH_PROBE_TIMEOUT_MS`).
- Always kill the child in `finally`. Always returns a `HealthEntry` (never throws).

The plugin does **not** await `probeAll` — it fires `void probeAll(...).then(...)` so plugin load is unblocked. Failures log to `console.warn` and land in `state.json:health[]`. The tool registers regardless of probe outcome.

### Cross-process contract

Currently:
- The server plugin is the only writer.
- The TUI module is the only reader, polling at 1Hz idle / 4Hz active.

If both server and TUI run, they must agree on the state directory. Documented as: set `OPENCODE_ACP_DELEGATE_STATE_DIR` in your shell rc rather than per-launch so both inherit the same value.

### Wire-up from the execute path

In [plugin/acp-delegate.ts](plugin/acp-delegate.ts) every tool's `execute` does (in order):

1. Generate `callId = crypto.randomUUID()`. Build `InflightEntry { callId, sessionId: ctx.sessionID.slice(0, 6), agentId, promptSnippet, startedAt }` and call `recordInflight(entry)` — fire-and-forget with `.catch(() => {})`.
2. Run the ACP session.
3. Call `resolveInflight(callId, { status, endedAt, durationMs, errorCode? })` — same best-effort treatment.
4. Append one JSONL line to `usage.jsonl` via `appendUsage(...)`. The log auto-rotates when it exceeds `USAGE_LOG_MAX_BYTES = 5 MiB` — the existing file is renamed to `usage.jsonl.1` (overwriting any prior `.1`) and a fresh log is started. Only one rolled archive is retained; this is a power-user diagnostic, not a long-term audit log.
5. Health probes are fired once at plugin load: `void probeAll(registry).then(setHealthResults).catch(() => {})`. Plugin load never blocks on the probe.

All five operations are wrapped so a broken state directory cannot break delegation. State writes are **best-effort**, never on the critical path.

## 11. TUI integration

The TUI plugin module ([plugin/acp-delegate-tui.ts](plugin/acp-delegate-tui.ts)) is a separate Opencode plugin entry that reads the state file written by the server plugin. They communicate exclusively through `state.json`; there is no IPC, no shared memory, no socket.

### Module shape

The TUI export is a `TuiPluginModule` (not a `Plugin`):

```ts
{
  id: "opencode-acp-delegate:tui",
  tui: async (api, options, meta) => { /* register slots, command, polling */ },
}
```

The `server` field must NOT be set — opencode's loader uses module shape to dispatch between server plugins and TUI plugins.

### Type-only imports + dynamic runtime imports

The TUI module imports `TuiPluginApi`, `TuiPluginModule`, `TuiSlotPlugin`, and `TuiCommand` from `@opencode-ai/plugin/tui` as **type-only** imports. These are erased at runtime.

UI primitives (`@opentui/solid`, `solid-js`) are **dynamically** imported inside the `tui` async function:

```ts
const { createElement } = await import("@opentui/solid")
const { createSignal } = await import("solid-js")
```

The plugin therefore declares no runtime dependency on either package; opencode's own bundle satisfies the resolver at load time. The single-file plugin keeps inline `declare module` shims at the top of `plugin/acp-delegate-tui.ts` to keep `tsc --noEmit` clean — declaring only the subset of `@opentui/solid`/`solid-js` our code actually touches.

### Slot registration

Two host slots are populated:

| Slot | Renders | Hidden when |
|---|---|---|
| `session_prompt_right` | `acp: N` badge in `theme.success`, switches to `theme.warning` if any call is older than 60 s | `inflight.length === 0` (returns `null`) |
| `sidebar_content` | bordered panel titled `ACP delegations`, one row per inflight: `agent | promptSnippet (≤32 ch) | elapsed` | `inflight.length === 0` (returns `null`) |

Both slots return `null` (not an empty element) when there is nothing to show — opencode renders nothing for null slots.

### Polling

A single `setTimeout` self-rescheduling loop polls `loadState()`:

- **1 Hz** when `inflight.length === 0` (idle).
- **4 Hz** (250 ms) when `inflight.length > 0` (active) — gives perceptibly live elapsed counters and quick badge updates.

The loop is torn down via `api.lifecycle.onDispose(...)`. A `disposed` flag short-circuits the next iteration if the timer fires after teardown.

### `/acp-doctor` slash command

Registered via `api.command.register(() => [...])`. On select, re-reads `state.json` and opens an `api.ui.DialogAlert` whose message body is one line per `health[]` entry — `agentId ✓ <ms>` for healthy, `agentId ✗ <error>` for failures.

### Read-only contract

The TUI plugin **never writes the state file**. Only the server plugin mutates `state.json`. This invariant lets multiple TUI processes (e.g. user has both global and per-project plugin copies installed) coexist without write contention.

### Path resolution must match across processes

Both plugins resolve the state directory the same way:

1. `$OPENCODE_ACP_DELEGATE_STATE_DIR`
2. `$XDG_STATE_HOME/opencode/acp-delegate`
3. `~/.local/state/opencode/acp-delegate`

Both the server plugin (`plugin/acp-delegate.ts`) and the TUI plugin (`plugin/acp-delegate-tui.ts`) implement this resolver inline so neither needs to import from the other — keeps both files install-free. If a user sets `OPENCODE_ACP_DELEGATE_STATE_DIR` only in one shell and runs both processes from different shells, the panels will be empty — env vars must be set in the user's shell rc.

## 12. Tool result shape

Every `delegate_to_<id>` tool returns a structured `ToolResult`:

```ts
{
  output: string,
  metadata: {
    agentId: string
    durationMs: number
    status: "complete" | "error" | "cancelled"
    stopReason?: "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled"
    errorCode?: string  // ENOENT, ETIMEDOUT, ECANCELLED, EAGENT, …
  }
}
```

### Two channels, two audiences

The opencode plugin runtime renders both fields, but each reaches a different consumer:

| Channel | Audience | What lives here |
|---|---|---|
| `output` (string) | The master LLM | The agent's full text response. **Load-bearing flags are also embedded here** as a trailer — see below — because the LLM does not see the `metadata` field. |
| `metadata` (object) | TUI + plugin hooks (`tool.execute.after`) | Structured, machine-readable `agentId / durationMs / status / stopReason / errorCode` for telemetry and the inflight panel. |

### Load-bearing trailer

When `stopReason ∈ { max_tokens, max_turn_requests }`, the plugin appends a single line to `output`:

```
[delegate_to_<id>: stopReason=max_tokens, durationMs=12453]
```

Without this, a truncated answer is indistinguishable from a complete one to the master agent. `end_turn` produces no trailer (the response is canonical).

For `stopReason: refusal`, `output` is replaced with a refusal notice:

```
delegate_to_<id> refused: <agent text or "no reason given">
```

For errors and cancellation, `output` is the human-readable failure message (timeout, ENOENT, abort, etc.) and `metadata.status` carries the structured code. Errors do NOT throw — execute always returns a result. Throwing would make the master agent give up rather than retry.
