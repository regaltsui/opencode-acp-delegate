import { describe, test, expect } from "bun:test"
import {
  parseAgentRegistry,
  findAgent,
  findDefaultAgent,
  resolveAgent,
} from "../agent-registry.js"
import { DEFAULT_TIMEOUT_MS, type AgentConfig, type PluginOptions } from "../types.js"

const gemini: AgentConfig = { id: "gemini", command: ["gemini", "--acp"], default: true }
const claude: AgentConfig = { id: "claude", command: ["opencode", "acp"] }
const registry: AgentConfig[] = [gemini, claude]

describe("parseAgentRegistry", () => {
  test("returns agents array on valid config", () => {
    const opts: PluginOptions = { agents: [gemini, claude] }
    const result = parseAgentRegistry(opts)
    expect(Array.isArray(result)).toBe(true)
    expect(result).toHaveLength(2)
    expect(result[0]?.id).toBe("gemini")
    expect(result[1]?.id).toBe("claude")
    expect(result[0]?.command).toEqual(["gemini", "--acp"])
    expect(result[0]?.default).toBe(true)
  })

  test("throws if agents is missing", () => {
    expect(() => parseAgentRegistry({} as PluginOptions)).toThrow(
      /Plugin options must include a non-empty 'agents' array/,
    )
  })

  test("throws if agents is undefined explicitly", () => {
    expect(() =>
      parseAgentRegistry({ agents: undefined as unknown as AgentConfig[] }),
    ).toThrow(/Plugin options must include a non-empty 'agents' array/)
  })

  test("throws if agents is null", () => {
    expect(() =>
      parseAgentRegistry({ agents: null as unknown as AgentConfig[] }),
    ).toThrow(/Plugin options must include a non-empty 'agents' array/)
  })

  test("throws if agents is empty array", () => {
    expect(() => parseAgentRegistry({ agents: [] })).toThrow(
      /Plugin options must include a non-empty 'agents' array/,
    )
  })

  test("throws if an agent has empty id", () => {
    const bad: AgentConfig = { id: "", command: ["x"] }
    expect(() => parseAgentRegistry({ agents: [bad] })).toThrow(
      /Agent config at index 0 is invalid/,
    )
  })

  test("throws if an agent has missing id", () => {
    const bad = { command: ["x"] } as unknown as AgentConfig
    expect(() => parseAgentRegistry({ agents: [bad] })).toThrow(
      /Agent config at index 0 is invalid/,
    )
  })

  test("throws if an agent has empty command array", () => {
    const bad: AgentConfig = { id: "x", command: [] }
    expect(() => parseAgentRegistry({ agents: [bad] })).toThrow(
      /Agent config at index 0 is invalid/,
    )
  })

  test("throws if an agent has missing command", () => {
    const bad = { id: "x" } as unknown as AgentConfig
    expect(() => parseAgentRegistry({ agents: [bad] })).toThrow(
      /Agent config at index 0 is invalid/,
    )
  })

  test("throws if a command element is not a string", () => {
    const bad = { id: "x", command: ["ok", 123] } as unknown as AgentConfig
    expect(() => parseAgentRegistry({ agents: [bad] })).toThrow(
      /Agent config at index 0 is invalid/,
    )
  })

  test("error message identifies the correct index when second agent invalid", () => {
    const bad = { id: "", command: ["x"] }
    expect(() => parseAgentRegistry({ agents: [gemini, bad] })).toThrow(
      /Agent config at index 1 is invalid/,
    )
  })

  test("defaults timeout to DEFAULT_TIMEOUT_MS when not set", () => {
    const result = parseAgentRegistry({ agents: [gemini, claude] })
    expect(result[0]?.timeout).toBe(DEFAULT_TIMEOUT_MS)
    expect(result[1]?.timeout).toBe(DEFAULT_TIMEOUT_MS)
  })

  test("preserves explicit timeout when provided", () => {
    const custom: AgentConfig = { id: "slow", command: ["slow"], timeout: 30_000 }
    const result = parseAgentRegistry({ agents: [custom] })
    expect(result[0]?.timeout).toBe(30_000)
  })
})

describe("findAgent", () => {
  test("returns matching agent by id", () => {
    const result = findAgent(registry, "claude")
    expect(result).toBe(claude)
    expect(result.id).toBe("claude")
  })

  test("returns the first agent match (gemini)", () => {
    const result = findAgent(registry, "gemini")
    expect(result).toBe(gemini)
  })

  test("throws with available list when id not found", () => {
    expect(() => findAgent(registry, "nonexistent")).toThrow(
      /Unknown agentId: nonexistent\. Available: gemini, claude/,
    )
    try {
      findAgent(registry, "nonexistent")
    } catch (err) {
      expect((err as Error).message).toContain("Available:")
      expect((err as Error).message).toContain("gemini")
      expect((err as Error).message).toContain("claude")
    }
  })
})

describe("findDefaultAgent", () => {
  test("returns agent with default: true", () => {
    const result = findDefaultAgent(registry)
    expect(result).toBe(gemini)
    expect(result.default).toBe(true)
  })

  test("returns first default if multiple set (uses Array.find semantics)", () => {
    const a: AgentConfig = { id: "a", command: ["a"], default: true }
    const b: AgentConfig = { id: "b", command: ["b"], default: true }
    const result = findDefaultAgent([a, b])
    expect(result).toBe(a)
  })

  test("throws actionable error when no default", () => {
    const noDefault: AgentConfig[] = [
      { id: "a", command: ["a"] },
      { id: "b", command: ["b"] },
    ]
    expect(() => findDefaultAgent(noDefault)).toThrow(
      "No default agent configured. Pass agentId or set default: true on one agent.",
    )
  })

  test("throws when registry is empty", () => {
    expect(() => findDefaultAgent([])).toThrow(
      "No default agent configured. Pass agentId or set default: true on one agent.",
    )
  })
})

describe("resolveAgent", () => {
  test("uses findAgent when agentId provided", () => {
    const result = resolveAgent(registry, "claude")
    expect(result).toBe(claude)
  })

  test("uses findDefaultAgent when agentId omitted", () => {
    const result = resolveAgent(registry)
    expect(result).toBe(gemini)
    expect(result.default).toBe(true)
  })

  test("uses findDefaultAgent when agentId is undefined", () => {
    const result = resolveAgent(registry, undefined)
    expect(result).toBe(gemini)
  })

  test("throws when agentId provided but not found", () => {
    expect(() => resolveAgent(registry, "ghost")).toThrow(
      /Unknown agentId: ghost\. Available: gemini, claude/,
    )
  })

  test("throws when no agentId and no default", () => {
    const noDefault: AgentConfig[] = [
      { id: "a", command: ["a"] },
      { id: "b", command: ["b"] },
    ]
    expect(() => resolveAgent(noDefault)).toThrow(
      "No default agent configured. Pass agentId or set default: true on one agent.",
    )
  })
})
