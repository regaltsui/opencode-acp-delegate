import { type AgentConfig, type PluginOptions, DEFAULT_TIMEOUT_MS } from "./types.js"

const MISSING_AGENTS_MESSAGE =
  'Plugin options must include a non-empty \'agents\' array. Example: ["opencode-acp-delegate", { agents: [{ id: "gemini", command: ["gemini", "--acp"], default: true }] }]'

const NO_DEFAULT_MESSAGE =
  "No default agent configured. Pass agentId or set default: true on one agent."

function validateAgent(raw: unknown, index: number): AgentConfig {
  if (raw === null || typeof raw !== "object") {
    throw new Error(`Agent config at index ${index} is invalid: expected object, got ${raw === null ? "null" : typeof raw}`)
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

  const normalized: AgentConfig = {
    id: candidate.id,
    command: candidate.command as string[],
    default: candidate.default,
    timeout: candidate.timeout ?? DEFAULT_TIMEOUT_MS,
  }
  return normalized
}

export function parseAgentRegistry(opts: PluginOptions): AgentConfig[] {
  if (!opts || !Array.isArray(opts.agents) || opts.agents.length === 0) {
    throw new Error(MISSING_AGENTS_MESSAGE)
  }
  return opts.agents.map((raw, i) => validateAgent(raw, i))
}

export function findAgent(registry: AgentConfig[], id: string): AgentConfig {
  const found = registry.find((a) => a.id === id)
  if (!found) {
    const available = registry.map((a) => a.id).join(", ")
    throw new Error(`Unknown agentId: ${id}. Available: ${available}`)
  }
  return found
}

export function findDefaultAgent(registry: AgentConfig[]): AgentConfig {
  const found = registry.find((a) => a.default === true)
  if (!found) {
    throw new Error(NO_DEFAULT_MESSAGE)
  }
  return found
}

export function resolveAgent(registry: AgentConfig[], agentId?: string): AgentConfig {
  if (agentId !== undefined) {
    return findAgent(registry, agentId)
  }
  return findDefaultAgent(registry)
}
