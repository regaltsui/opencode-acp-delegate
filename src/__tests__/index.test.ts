import { describe, test, expect } from "bun:test"
import * as indexMod from "../index.js"
import type { PluginInput, PluginOptions } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"

const z = tool.schema

function makeMockInput(): PluginInput {
  return {
    client: {
      session: {
        prompt: async () => undefined,
      },
    } as unknown as PluginInput["client"],
    project: {} as PluginInput["project"],
    directory: process.cwd(),
    worktree: process.cwd(),
    experimental_workspace: {
      register: () => {},
    } as PluginInput["experimental_workspace"],
    serverUrl: new URL("http://localhost"),
    $: {} as PluginInput["$"],
  }
}

function options(opts: { agents: Array<Record<string, unknown>> }): PluginOptions {
  return opts as unknown as PluginOptions
}

const validOptions = options({
  agents: [
    {
      id: "test-agent",
      command: ["nonexistent-binary-for-tests-xyz-acp"],
      default: true,
    },
  ],
})

interface MockCtx {
  sessionID: string
  messageID: string
  agent: string
  directory: string
  worktree: string
  abort: AbortSignal
  metadata: (input: { title?: string; metadata?: Record<string, unknown> }) => void
  ask: () => unknown
}

function makeMockCtx(): { ctx: MockCtx; getMeta: () => { title?: string } } {
  let captured: { title?: string } = {}
  const ctx: MockCtx = {
    sessionID: "sess-test-123",
    messageID: "msg-test-456",
    agent: "test-master",
    directory: process.cwd(),
    worktree: process.cwd(),
    abort: new AbortController().signal,
    metadata: (input) => {
      captured = { title: input.title }
    },
    ask: () => undefined,
  }
  return { ctx, getMeta: () => captured }
}

async function getDelegateTool(opts: PluginOptions) {
  const hooks = await indexMod.server(makeMockInput(), opts)
  const toolMap = hooks.tool
  if (!toolMap) throw new Error("hooks.tool is undefined")
  const t = toolMap.agent_delegate
  if (!t) throw new Error("agent_delegate tool not registered")
  return { hooks, t }
}

describe("plugin module exports", () => {
  test("exports id as 'opencode-acp-delegate'", () => {
    expect(indexMod.id).toBe("opencode-acp-delegate")
  })

  test("exports server as a function (Plugin)", () => {
    expect(typeof indexMod.server).toBe("function")
  })

  test("does NOT export a default (named export only)", () => {
    expect((indexMod as { default?: unknown }).default).toBeUndefined()
  })
})

describe("plugin setup", () => {
  test("returns hooks object with agent_delegate tool", async () => {
    const { t } = await getDelegateTool(validOptions)
    expect(typeof t.execute).toBe("function")
    expect(typeof t.description).toBe("string")
  })

  test("registers experimental.chat.system.transform hook", async () => {
    const { hooks } = await getDelegateTool(validOptions)
    expect(typeof hooks["experimental.chat.system.transform"]).toBe("function")
  })

  test("system.transform pushes guidance with NO hardcoded agent names", async () => {
    const { hooks } = await getDelegateTool(validOptions)
    const transform = hooks["experimental.chat.system.transform"]
    if (!transform) throw new Error("transform hook not registered")
    const output = { system: [] as string[] }
    await transform({ model: {} as Parameters<typeof transform>[0]["model"] }, output)
    expect(output.system.length).toBeGreaterThan(0)
    const guidance = output.system.join("\n").toLowerCase()
    expect(guidance).not.toContain("gemini")
    expect(guidance).not.toContain("claude")
    expect(guidance).not.toContain("opencode")
  })

  test("TOOL description has NO hardcoded agent names", async () => {
    const { t } = await getDelegateTool(validOptions)
    const description = t.description.toLowerCase()
    expect(description).not.toContain("gemini")
    expect(description).not.toContain("claude")
    expect(description).not.toContain("opencode")
  })

  test("plugin throws at setup when agents array is missing", async () => {
    let err: unknown
    try {
      await indexMod.server(makeMockInput(), {} as PluginOptions)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/agents/i)
  })
})

describe("agent_delegate.execute contract", () => {
  test("returns synchronously with 'started' message for valid agent", async () => {
    const { t } = await getDelegateTool(
      options({
        agents: [{ id: "alpha", command: ["nonexistent-bin-zzz"], default: true }],
      }),
    )
    const { ctx } = makeMockCtx()
    const result = await t.execute({ prompt: "hello world" }, ctx as Parameters<typeof t.execute>[1])
    const text = typeof result === "string" ? result : result.output
    expect(text).toContain("started")
    expect(text).toContain("alpha")
  })

  test("returns error string when agentId is unknown (does not throw)", async () => {
    const { t } = await getDelegateTool(
      options({ agents: [{ id: "real", command: ["x"], default: true }] }),
    )
    const { ctx } = makeMockCtx()
    const result = await t.execute(
      { prompt: "hello", agentId: "ghost" },
      ctx as Parameters<typeof t.execute>[1],
    )
    const text = typeof result === "string" ? result : result.output
    expect(text).toMatch(/failed/i)
    expect(text).toMatch(/ghost/i)
  })

  test("returns error string when no default agent and agentId omitted", async () => {
    const { t } = await getDelegateTool(
      options({
        agents: [
          { id: "a", command: ["a"] },
          { id: "b", command: ["b"] },
        ],
      }),
    )
    const { ctx } = makeMockCtx()
    const result = await t.execute({ prompt: "hi" }, ctx as Parameters<typeof t.execute>[1])
    const text = typeof result === "string" ? result : result.output
    expect(text).toMatch(/failed/i)
    expect(text.toLowerCase()).toContain("default")
  })

  test("calls metadata with title containing agent id", async () => {
    const { t } = await getDelegateTool(
      options({
        agents: [{ id: "tag-agent", command: ["xnope"], default: true }],
      }),
    )
    const { ctx, getMeta } = makeMockCtx()
    await t.execute({ prompt: "do something useful" }, ctx as Parameters<typeof t.execute>[1])
    const meta = getMeta()
    expect(meta.title).toBeDefined()
    expect(meta.title!).toContain("tag-agent")
  })
})

describe("agent_delegate args schema", () => {
  test("prompt is required, agentId and includeContext optional", async () => {
    const { t } = await getDelegateTool(validOptions)
    const schema = z.object(t.args)

    const missingPrompt = schema.safeParse({})
    expect(missingPrompt.success).toBe(false)

    const promptOnly = schema.safeParse({ prompt: "hi" })
    expect(promptOnly.success).toBe(true)

    const allFields = schema.safeParse({
      prompt: "hi",
      agentId: "x",
      includeContext: ["src"],
    })
    expect(allFields.success).toBe(true)

    const emptyPrompt = schema.safeParse({ prompt: "" })
    expect(emptyPrompt.success).toBe(false)
  })
})
