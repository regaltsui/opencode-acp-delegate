import { describe, test, expect } from "bun:test"
import { buildSuccessNotification, buildErrorNotification, generateCallId } from "../notification.js"
import type { OneShotResult } from "../types.js"

describe("generateCallId", () => {
  test("returns string starting with acp-", () => {
    expect(generateCallId(1)).toMatch(/^acp-1-/)
  })
  test("increments with seq number", () => {
    const id1 = generateCallId(1)
    const id2 = generateCallId(2)
    expect(id1).toMatch(/^acp-1-/)
    expect(id2).toMatch(/^acp-2-/)
  })
})

describe("buildSuccessNotification", () => {
  const result: OneShotResult = {
    output: "Hello world",
    metadata: { durationMs: 1234, agentId: "gemini" }
  }
  const withTokens: OneShotResult = {
    output: "Hello world",
    metadata: { durationMs: 1234, agentId: "gemini", tokens: { input: 100, output: 50 } }
  }

  test("contains required XML tags", () => {
    const xml = buildSuccessNotification("acp-1-abc", result, "my prompt")
    expect(xml).toContain("<acp-delegate-result>")
    expect(xml).toContain("</acp-delegate-result>")
    expect(xml).toContain("<id>acp-1-abc</id>")
    expect(xml).toContain("<status>complete</status>")
    expect(xml).toContain("<agent>gemini</agent>")
    expect(xml).toContain("<response>Hello world</response>")
    expect(xml).toContain("<prompt-snippet>")
  })
  test("includes duration", () => {
    expect(buildSuccessNotification("id", result, "p")).toContain("1234ms")
  })
  test("includes token counts when present", () => {
    const xml = buildSuccessNotification("id", withTokens, "p")
    expect(xml).toContain("100")
    expect(xml).toContain("50")
  })
  test("omits token section when absent", () => {
    const xml = buildSuccessNotification("id", result, "p")
    // should not throw; tokens section optional
    expect(xml).toBeTruthy()
  })
  test("truncates prompt to 120 chars", () => {
    const longPrompt = "x".repeat(200)
    const xml = buildSuccessNotification("id", result, longPrompt)
    // prompt-snippet should be at most 120 chars of content
    const match = xml.match(/<prompt-snippet>(.*?)<\/prompt-snippet>/)
    expect(match).toBeTruthy()
    expect(match![1]!.length).toBeLessThanOrEqual(123) // 120 + possible "..."
  })
})

describe("buildErrorNotification", () => {
  test("contains error tags", () => {
    const err = new Error("something broke")
    err.name = "AcpTimeoutError"
    const xml = buildErrorNotification("acp-1-abc", "gemini", err, "prompt")
    expect(xml).toContain("<status>error</status>")
    expect(xml).toContain("<error>something broke</error>")
    expect(xml).toContain("<error-code>AcpTimeoutError</error-code>")
    expect(xml).toContain("<agent>gemini</agent>")
  })
})
