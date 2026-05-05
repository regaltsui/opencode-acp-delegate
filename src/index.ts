import { tool } from "@opencode-ai/plugin"
import type { Plugin, PluginInput, PluginOptions } from "@opencode-ai/plugin"
import { homedir } from "node:os"
import { appendFile } from "node:fs/promises"
import { join } from "node:path"
import { parseAgentRegistry, resolveAgent } from "./agent-registry.js"
import { runOneShotSession } from "./acp-client.js"
import { buildSuccessNotification, buildErrorNotification, generateCallId } from "./notification.js"
import { DEFAULT_TIMEOUT_MS, type PluginOptions as AcpPluginOptions } from "./types.js"

const z = tool.schema

const TOOL_DESCRIPTION =
  "Delegate a self-contained task to a registered ACP agent. " +
  "Each call spawns a fresh, isolated agent session via the Agent Client Protocol (ACP) — " +
  "the agent has zero prior context, so prompts must be fully self-contained. " +
  "Runs asynchronously: returns a call ID immediately and the result arrives later as an <acp-delegate-result> notification. " +
  "Supports parallel fan-out — fire multiple delegate calls concurrently for independent subtasks. " +
  "Pick the agent via the optional 'agentId' parameter (omit to use the configured default). " +
  "Warning: agents may run with permissive auto-tool-call modes; side effects are not enumerated in the response. " +
  "Run a status check on the working tree afterwards if file integrity matters."

const SYSTEM_GUIDANCE = `<acp-delegate-routing>
## agent_delegate — Offload to a registered ACP agent

agent_delegate spawns a one-shot session in a different agent process via the Agent Client Protocol (ACP). It is the right tool when the work is *self-contained* and the cost asymmetry favours running it outside the master agent's own token budget.

### When agent_delegate WINS over task()

| Situation | Why |
|---|---|
| Bulk read-only summarisation across many files / large context | The delegated agent may have a much larger context window or independent quota |
| 3+ independent parallel analyses | Each agent_delegate call is a separate process; fan out without competing for the master's tokens |
| Genuinely independent second opinion | A different model family / training set, not just another instance of the same agent |
| Self-contained one-shot research | No iteration required — fire and collect the result asynchronously |

### When task() WINS over agent_delegate

| Situation | Use instead |
|---|---|
| Need the result synchronously before the next step | task(run_in_background=false) |
| Multi-turn iterative reasoning | task() — delegated agents have zero session memory across calls |
| Strict audit of every file/shell side effect | task() — agent_delegate surfaces only the final text output |

### Decision rule

> "Is this read-only, completable in a single self-contained prompt, and either large-context or running in parallel with other work?"
> - YES → agent_delegate
> - NO  → task()

### Async workflow

agent_delegate returns "started [acp-N]" immediately. Do not block on it. Continue with other tool calls or end your turn. The result arrives as an <acp-delegate-result> notification — extract the content from the <response> tag and continue from there.

For parallel fan-out: issue all agent_delegate calls in a single turn alongside any synchronous work, then collect results as notifications arrive.

**Prompt discipline:** every call is a fresh isolated session. Include all relevant file excerpts, goals, and the desired output format inline — there is no shared memory with previous calls.
</acp-delegate-routing>`

type SessionPrompt = (opts: {
  path: { id: string }
  body: { parts: Array<{ type: string; text: string }> }
}) => Promise<unknown>

function resolveSessionPrompt(client: unknown): SessionPrompt | null {
  try {
    const fn = (client as { session: { prompt: SessionPrompt } }).session.prompt
    return typeof fn === "function" ? fn.bind((client as { session: unknown }).session) : null
  } catch {
    return null
  }
}

function truncate(prompt: string, max = 60): string {
  const s = prompt.replace(/\s+/g, " ").trim()
  return s.length <= max ? s : s.slice(0, max - 1) + "\u2026"
}

const plugin: Plugin = async (input: PluginInput, options?: PluginOptions) => {
  const opts = (options ?? {}) as unknown as AcpPluginOptions
  const registry = parseAgentRegistry(opts)
  const sessionPrompt = resolveSessionPrompt(input.client)
  let callSeq = 0

  return {
    "experimental.chat.system.transform": async (_input, output) => {
      output.system.push(SYSTEM_GUIDANCE)
    },
    tool: {
      agent_delegate: tool({
        description: TOOL_DESCRIPTION,
        args: {
          prompt: z
            .string()
            .min(1)
            .describe("Self-contained task prompt. The agent has no prior context."),
          agentId: z
            .string()
            .optional()
            .describe("ID of the registered agent to use. Uses default agent if omitted."),
          includeContext: z
            .array(z.string())
            .optional()
            .describe("Context directories (relative to project cwd) to mention in the prompt preamble."),
        },
        execute: async (args, ctx) => {
          const callId = generateCallId(++callSeq)
          const sessionId = ctx.sessionID

          let agent
          try {
            agent = resolveAgent(registry, args.agentId)
          } catch (err) {
            return `agent_delegate [${callId}] failed: ${(err as Error).message}`
          }

          ctx.metadata({ title: `[${agent.id}] ${truncate(args.prompt)}` })

          const clientOpts = {
            command: agent.command,
            cwd: ctx.directory,
            timeout: agent.timeout ?? DEFAULT_TIMEOUT_MS,
          }

          runOneShotSession(clientOpts, args.prompt)
            .then((result) => {
              const usageEntry =
                JSON.stringify({
                  ts: new Date().toISOString(),
                  callId,
                  agentId: agent.id,
                  durationMs: result.metadata.durationMs,
                  promptLength: args.prompt.length,
                }) + "\n"
              appendFile(
                join(homedir(), ".opencode", "acp-delegate-usage.jsonl"),
                usageEntry,
              ).catch(() => {})

              if (sessionPrompt) {
                const notification = buildSuccessNotification(callId, result, args.prompt)
                sessionPrompt({
                  path: { id: sessionId },
                  body: { parts: [{ type: "text", text: notification }] },
                }).catch(() => {})
              }
            })
            .catch((err) => {
              if (sessionPrompt) {
                const notification = buildErrorNotification(
                  callId,
                  agent.id,
                  err instanceof Error ? err : new Error(String(err)),
                  args.prompt,
                )
                sessionPrompt({
                  path: { id: sessionId },
                  body: { parts: [{ type: "text", text: notification }] },
                }).catch(() => {})
              }
            })

          return `agent_delegate [${callId}] started in background (agent: ${agent.id}). Result will arrive as an <acp-delegate-result> notification.`
        },
      }),
    },
  }
}

export const id = "opencode-acp-delegate"
export const server: Plugin = plugin
