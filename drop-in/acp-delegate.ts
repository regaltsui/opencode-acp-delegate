/**
 * opencode-acp-delegate — ACP delegation plugin for Opencode
 *
 * Delegates self-contained tasks to any ACP (Agent Client Protocol) compatible
 * agent: gemini --acp, opencode acp, claude-agent-acp, etc. The master agent
 * gains a generic `agent_delegate` tool routed via a user-configured registry.
 *
 * DROP-IN INSTALLATION:
 *   cp acp-delegate.ts ~/.opencode/plugins/acp-delegate.ts
 *   # or for a single project:
 *   cp acp-delegate.ts .opencode/plugins/acp-delegate.ts
 *
 * No `npm install` required — this file inlines the JSON-RPC client over
 * Node.js built-ins (child_process, readline) and uses only @opencode-ai/plugin
 * type imports (which Opencode itself provides).
 *
 * CONFIGURATION (opencode.json):
 *   {
 *     "plugins": [
 *       ["opencode-acp-delegate", {
 *         "agents": [
 *           { "id": "gemini", "command": ["gemini", "--acp"], "default": true },
 *           { "id": "opencode", "command": ["opencode", "acp"] }
 *         ]
 *       }]
 *     ]
 *   }
 *
 * Each agent entry:
 *   - id        unique name passed as the `agentId` tool parameter
 *   - command   argv array used to launch the agent in ACP mode
 *   - default   if true, used when `agentId` is omitted
 *   - timeout   per-agent override in ms (default 600000 = 10 min)
 *
 * v1 LIMITATIONS:
 *   - Agents receive text-only responses (no fs/terminal capabilities advertised
 *     to the spawned agent — it cannot read/write files or run shell commands
 *     through this plugin)
 *   - One-shot per call (no session continuity across tool calls)
 *   - Opencode plugin only (no MCP server)
 *
 * SOURCE: https://github.com/regaltsui/opencode-acp-delegate
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createInterface } from "node:readline"
import { homedir } from "node:os"
import { appendFile } from "node:fs/promises"
import { join } from "node:path"
import { type Plugin, type PluginInput, type PluginOptions as OpencodePluginOptions, tool } from "@opencode-ai/plugin"

const z = tool.schema

// ============================================================================
// Constants (inlined from src/types.ts)
// ============================================================================

/** Default per-call timeout: 10 minutes. */
const DEFAULT_TIMEOUT_MS = 600_000

/** Grace period between SIGTERM and SIGKILL during timeout or close. */
const GRACE_PERIOD_MS = 5_000

/** Maximum bytes of agent text buffered per session before truncation (8 MiB). */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024

/** ACP protocol version negotiated with the agent (numeric, per the ACP SDK). */
const ACP_PROTOCOL_VERSION = 1

// ============================================================================
// Types (inlined from src/types.ts)
// ============================================================================

interface AgentConfig {
  id: string
  command: string[]
  default?: boolean
  timeout?: number
}

interface AcpPluginOptions {
  agents: AgentConfig[]
}

interface AcpClientOptions {
  command: string[]
  cwd: string
  timeout: number
}

interface OneShotResult {
  output: string
  metadata: {
    durationMs: number
    agentId: string
    tokens?: {
      input: number
      output: number
    }
  }
}

// ============================================================================
// Agent registry (inlined from src/agent-registry.ts)
// ============================================================================

const MISSING_AGENTS_MESSAGE =
  'Plugin options must include a non-empty \'agents\' array. Example: ["opencode-acp-delegate", { agents: [{ id: "gemini", command: ["gemini", "--acp"], default: true }] }]'

const NO_DEFAULT_MESSAGE =
  "No default agent configured. Pass agentId or set default: true on one agent."

function validateAgent(raw: unknown, index: number): AgentConfig {
  if (raw === null || typeof raw !== "object") {
    throw new Error(
      `Agent config at index ${index} is invalid: expected object, got ${raw === null ? "null" : typeof raw}`,
    )
  }
  const candidate = raw as Partial<AgentConfig>

  if (typeof candidate.id !== "string" || candidate.id.length === 0) {
    throw new Error(`Agent config at index ${index} is invalid: 'id' must be a non-empty string`)
  }

  if (!Array.isArray(candidate.command) || candidate.command.length === 0) {
    throw new Error(`Agent config at index ${index} is invalid: 'command' must be a non-empty string array`)
  }

  for (let j = 0; j < candidate.command.length; j++) {
    const piece = candidate.command[j]
    if (typeof piece !== "string") {
      throw new Error(`Agent config at index ${index} is invalid: command[${j}] must be a string`)
    }
  }

  return {
    id: candidate.id,
    command: candidate.command as string[],
    default: candidate.default,
    timeout: candidate.timeout ?? DEFAULT_TIMEOUT_MS,
  }
}

function parseAgentRegistry(opts: AcpPluginOptions): AgentConfig[] {
  if (!opts || !Array.isArray(opts.agents) || opts.agents.length === 0) {
    throw new Error(MISSING_AGENTS_MESSAGE)
  }
  return opts.agents.map((raw, i) => validateAgent(raw, i))
}

function findAgent(registry: AgentConfig[], id: string): AgentConfig {
  const found = registry.find((a) => a.id === id)
  if (!found) {
    const available = registry.map((a) => a.id).join(", ")
    throw new Error(`Unknown agentId: ${id}. Available: ${available}`)
  }
  return found
}

function findDefaultAgent(registry: AgentConfig[]): AgentConfig {
  const found = registry.find((a) => a.default === true)
  if (!found) {
    throw new Error(NO_DEFAULT_MESSAGE)
  }
  return found
}

function resolveAgent(registry: AgentConfig[], agentId?: string): AgentConfig {
  if (agentId !== undefined) {
    return findAgent(registry, agentId)
  }
  return findDefaultAgent(registry)
}

// ============================================================================
// Notification builder (inlined from src/notification.ts)
// ============================================================================

function generateCallId(seq: number): string {
  return `acp-${seq}-${Date.now().toString(36)}`
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

function buildSuccessNotification(
  id: string,
  result: OneShotResult,
  promptSnippet: string,
): string {
  const snippet = promptSnippet.length > 120 ? promptSnippet.slice(0, 120) + "..." : promptSnippet
  const tokenSection = result.metadata.tokens
    ? `<tokens>in:${result.metadata.tokens.input} out:${result.metadata.tokens.output}</tokens>`
    : ""

  return [
    "<acp-delegate-result>",
    `<id>${id}</id>`,
    "<status>complete</status>",
    `<agent>${result.metadata.agentId}</agent>`,
    `<duration>${result.metadata.durationMs}ms</duration>`,
    tokenSection,
    `<response>${escapeXml(result.output)}</response>`,
    `<prompt-snippet>${escapeXml(snippet)}</prompt-snippet>`,
    "</acp-delegate-result>",
  ].filter(Boolean).join("\n")
}

function buildErrorNotification(
  id: string,
  agentId: string,
  error: Error,
  promptSnippet: string,
): string {
  const snippet = promptSnippet.length > 120 ? promptSnippet.slice(0, 120) + "..." : promptSnippet

  return [
    "<acp-delegate-result>",
    `<id>${id}</id>`,
    "<status>error</status>",
    `<agent>${agentId}</agent>`,
    `<error-code>${escapeXml(error.name)}</error-code>`,
    `<error>${escapeXml(error.message)}</error>`,
    `<prompt-snippet>${escapeXml(snippet)}</prompt-snippet>`,
    "</acp-delegate-result>",
  ].join("\n")
}

// ============================================================================
// Inline ACP client — raw JSON-RPC 2.0 over stdio (no external SDK dependency,
// since the drop-in install path doesn't run `npm install`).
// ============================================================================

class AcpError extends Error {
  readonly code?: string
  constructor(message: string, code?: string) {
    super(message)
    this.name = "AcpError"
    this.code = code
  }
}

class AcpTimeoutError extends AcpError {
  readonly agentId: string
  readonly timeoutMs: number
  constructor(agentId: string, timeoutMs: number) {
    super(`Agent ${agentId} timed out after ${timeoutMs}ms`, "ETIMEDOUT")
    this.name = "AcpTimeoutError"
    this.agentId = agentId
    this.timeoutMs = timeoutMs
  }
}

interface JsonRpcMessage {
  jsonrpc?: string
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
  error?: { code?: number; message?: string }
}

interface SessionUpdateParams {
  sessionId?: string
  update?: {
    sessionUpdate?: string
    content?: { type?: string; text?: string }
  }
}

async function runOneShotSession(
  opts: AcpClientOptions,
  prompt: string,
): Promise<OneShotResult> {
  const startMs = Date.now()
  const binary = opts.command[0]
  if (!binary) {
    throw new AcpError("AcpClientOptions.command must have at least one element", "EINVAL")
  }
  const args = opts.command.slice(1)
  const agentId = binary

  let child: ChildProcessWithoutNullStreams
  try {
    child = spawn(binary, args, {
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    })
  } catch (e) {
    const err = e as NodeJS.ErrnoException
    if (err.code === "ENOENT") {
      throw new AcpError(`Agent binary not found: ${binary}`, "ENOENT")
    }
    throw new AcpError(err.message, err.code)
  }

  // Drain stderr so the pipe doesn't fill and stall the agent.
  child.stderr.on("data", () => {})

  // ---- JSON-RPC plumbing -------------------------------------------------
  let nextRequestId = 0
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>()
  const collectedText: string[] = []
  let outputBytes = 0
  let outputCapped = false

  const sendRequest = (method: string, params: unknown): Promise<unknown> => {
    const id = ++nextRequestId
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"
      child.stdin.write(payload, (err) => {
        if (err) {
          pending.delete(id)
          reject(new AcpError(`Failed to write to agent stdin: ${err.message}`, "EIO"))
        }
      })
    })
  }

  const sendResponse = (id: number | string, result: unknown): void => {
    const payload = JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n"
    child.stdin.write(payload, () => {})
  }

  const handleSessionUpdate = (params: SessionUpdateParams): void => {
    const u = params.update
    if (
      u?.sessionUpdate === "agent_message_chunk" &&
      u.content?.type === "text" &&
      typeof u.content.text === "string"
    ) {
      if (outputCapped) return
      const chunk = u.content.text
      const remaining = MAX_OUTPUT_BYTES - outputBytes
      if (chunk.length <= remaining) {
        collectedText.push(chunk)
        outputBytes += chunk.length
      } else {
        if (remaining > 0) collectedText.push(chunk.slice(0, remaining))
        outputBytes = MAX_OUTPUT_BYTES
        outputCapped = true
      }
    }
  }

  const rl = createInterface({ input: child.stdout })
  rl.on("line", (line: string) => {
    const trimmed = line.trim()
    if (trimmed.length === 0) return
    let msg: JsonRpcMessage
    try {
      msg = JSON.parse(trimmed) as JsonRpcMessage
    } catch {
      return
    }

    // Response to one of our requests (has matching numeric id).
    if (typeof msg.id === "number" && pending.has(msg.id)) {
      const handler = pending.get(msg.id)!
      pending.delete(msg.id)
      if (msg.error) {
        handler.reject(new AcpError(msg.error.message ?? "Agent returned error", "EAGENT"))
      } else {
        handler.resolve(msg.result)
      }
      return
    }

    // Server-to-client notification or request from the agent.
    if (typeof msg.method === "string") {
      if (msg.method === "session/update") {
        handleSessionUpdate((msg.params ?? {}) as SessionUpdateParams)
        return
      }
      // The agent may send `session/request_permission` even though we declared
      // no capabilities. Auto-decline so it doesn't block forever.
      if (msg.method === "session/request_permission" && msg.id !== undefined) {
        sendResponse(msg.id, { outcome: { outcome: "cancelled" } })
        return
      }
    }
  })

  // ---- Lifecycle: kill + timeout + spawn-error promise -------------------
  const killChild = (): void => {
    if (!child.killed) {
      try { child.kill("SIGTERM") } catch {}
      setTimeout(() => {
        try { if (!child.killed) child.kill("SIGKILL") } catch {}
      }, GRACE_PERIOD_MS).unref()
    }
  }

  const spawnErrorPromise = new Promise<never>((_, reject) => {
    child.once("error", (e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") {
        reject(new AcpError(`Agent binary not found: ${binary}`, "ENOENT"))
      } else {
        reject(new AcpError(e.message, e.code))
      }
    })
  })

  let timeoutHandle: NodeJS.Timeout | null = null
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      killChild()
      reject(new AcpTimeoutError(agentId, opts.timeout))
    }, opts.timeout)
  })

  // ---- Session orchestration --------------------------------------------
  const sessionPromise = (async (): Promise<string> => {
    await sendRequest("initialize", {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: {},
    })
    const newSessionResult = (await sendRequest("session/new", {
      cwd: opts.cwd,
      mcpServers: [],
    })) as { sessionId: string }
    await sendRequest("session/prompt", {
      sessionId: newSessionResult.sessionId,
      prompt: [{ type: "text", text: prompt }],
    })
    return collectedText.join("")
  })()

  try {
    const output = await Promise.race([sessionPromise, timeoutPromise, spawnErrorPromise])
    return {
      output,
      metadata: {
        durationMs: Date.now() - startMs,
        agentId,
      },
    }
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle)
    killChild()
    rl.close()
  }
}

// ============================================================================
// Plugin entry (inlined / mirrored from src/index.ts)
// ============================================================================

const TOOL_DESCRIPTION =
  "Delegate a self-contained task to any registered ACP (Agent Client Protocol) compatible agent. " +
  "REACH FOR THIS when: getting a second opinion from a different model family with independent " +
  "training data; running 3+ independent analysis tasks in parallel (fan-out); offloading a long " +
  "self-contained subtask. Each call spawns a fresh isolated agent process — the prompt must be " +
  "self-contained because the agent has no prior session context. Use `agentId` to choose a " +
  "specific agent from the registry; omit it to use the default agent. " +
  "Returns the agent's final text response. " +
  "v1 limitation: agents are text-only — they receive no fs/terminal capabilities through this plugin."

const SYSTEM_GUIDANCE = `<acp-delegate-routing>
## agent_delegate — Delegate to any ACP agent

If \`agent_delegate\` appears in your tool list, treat it as a first-class delegation path alongside explore/librarian/oracle.

**USE when:**
- Second opinion from a different model family with independent training data
- Self-contained research or summarization where another agent's perspective helps
- Parallel analysis: fire 3+ independent \`agent_delegate\` calls simultaneously
- Offloading a long self-contained subtask while you continue other work

**SKIP when:**
- Simple grep/search — use \`explore\` or direct tools (faster, cheaper)
- Multi-turn reasoning chains — each call is isolated with zero session history
- The task requires the delegated agent to read/write files or run shell commands
  (v1 declares no fs/terminal capabilities — text-only responses)

**Selecting an agent:**
- Pass \`agentId: "<id>"\` to route to a specific registered agent
- Omit \`agentId\` to use the default agent (the one with \`default: true\` in opencode.json)
- The result \`<acp-delegate-result>\` element includes \`<agent>\` so you know which agent answered

**Prompt discipline:** each call is a fresh agent session with no memory of your conversation. Include all context inline — file excerpts, goals, output format.
</acp-delegate-routing>`

interface PluginConfigShape {
  agents: AgentConfig[]
}

function truncate(s: string, max = 60): string {
  const trimmed = s.replace(/\s+/g, " ").trim()
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max - 1) + "…"
}

function logUsage(entry: Record<string, unknown>): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n"
  appendFile(join(homedir(), ".opencode", "acp-delegate-usage.jsonl"), line).catch(() => {})
}

let callSeq = 0

const plugin: Plugin = async (_input: PluginInput, options?: OpencodePluginOptions) => {
  const config = (options ?? {}) as unknown as PluginConfigShape
  const registry = parseAgentRegistry(config)

  return {
    "experimental.chat.system.transform": async (_inp, output) => {
      output.system.push(SYSTEM_GUIDANCE)
    },
    "tool.definition": async (input, output) => {
      if (input.toolID === "agent_delegate") {
        output.description = TOOL_DESCRIPTION
      }
    },
    tool: {
      agent_delegate: tool({
        description: TOOL_DESCRIPTION,
        args: {
          prompt: z
            .string()
            .min(1)
            .describe(
              "Self-contained instruction for the delegated agent. The agent has no prior session context.",
            ),
          agentId: z
            .string()
            .optional()
            .describe(
              "Which registered agent to use (must match an `id` in the plugin's agents config). Omit to use the default agent.",
            ),
          includeContext: z
            .array(z.string())
            .optional()
            .describe(
              "Additional context directories (relative to project cwd) to mention in the prompt preamble. v1 only embeds these as text references — agents cannot actually read them since fs capability is not advertised.",
            ),
        },
        execute: async (args, ctx) => {
          const callId = generateCallId(++callSeq)
          ctx.metadata({ title: truncate(args.prompt) })

          let agent: AgentConfig
          try {
            agent = resolveAgent(registry, args.agentId)
          } catch (err) {
            const errObj = err instanceof Error ? err : new Error(String(err))
            return buildErrorNotification(callId, args.agentId ?? "(default)", errObj, args.prompt)
          }

          const preamble =
            args.includeContext && args.includeContext.length > 0
              ? `Context directories (referenced for your awareness; you do not have file access): ${args.includeContext.join(", ")}\n\n`
              : ""
          const fullPrompt = preamble + args.prompt

          const clientOpts: AcpClientOptions = {
            command: agent.command,
            cwd: ctx.directory,
            timeout: agent.timeout ?? DEFAULT_TIMEOUT_MS,
          }

          try {
            const result = await runOneShotSession(clientOpts, fullPrompt)
            // Override agentId with the user-facing registry id (binary path is too noisy).
            const labelled: OneShotResult = {
              output: result.output,
              metadata: { ...result.metadata, agentId: agent.id },
            }
            ctx.metadata({
              metadata: {
                callId,
                agentId: agent.id,
                durationMs: labelled.metadata.durationMs,
              },
            })
            logUsage({
              callId,
              agentId: agent.id,
              durationMs: labelled.metadata.durationMs,
              promptLength: args.prompt.length,
            })
            return {
              output: buildSuccessNotification(callId, labelled, args.prompt),
              metadata: labelled.metadata,
            }
          } catch (err) {
            const errObj = err instanceof Error ? err : new Error(String(err))
            ctx.metadata({
              metadata: {
                callId,
                agentId: agent.id,
                errorCode: errObj.name,
                errorMessage: errObj.message,
              },
            })
            logUsage({
              callId,
              agentId: agent.id,
              error: errObj.message,
              errorCode: errObj.name,
              promptLength: args.prompt.length,
            })
            return buildErrorNotification(callId, agent.id, errObj, args.prompt)
          }
        },
      }),
    },
  }
}

// ============================================================================
// Exports — Opencode plugin loader recognises `id` + `server` named exports.
// (A default export would be silently ignored by the loader.)
// ============================================================================

export const id = "opencode-acp-delegate"
export const server: Plugin = plugin
