import { describe, test, expect } from "bun:test"
import path from "node:path"
import os from "node:os"
import fs from "node:fs"
import crypto from "node:crypto"
import { fileURLToPath } from "node:url"
import { runOneShotSession, AcpError, AcpTimeoutError } from "../acp-client.js"
import type { AcpClientOptions } from "../types.js"

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures")
const mockAgent = path.join(fixturesDir, "mock-acp-agent.ts")
const slowMockAgent = path.join(fixturesDir, "slow-mock-acp-agent.ts")

function tmpLogPath(): string {
  return path.join(os.tmpdir(), `acp-mock-${crypto.randomBytes(8).toString("hex")}.json`)
}

function bunCommand(scriptPath: string): string[] {
  return [process.execPath, "run", scriptPath]
}

describe("runOneShotSession - happy path", () => {
  test("returns the agent's text response", async () => {
    const opts: AcpClientOptions = {
      command: bunCommand(mockAgent),
      cwd: process.cwd(),
      timeout: 30_000,
    }
    const result = await runOneShotSession(opts, "say hi")
    expect(result.output).toBe("Hello from mock agent!")
    expect(result.metadata.agentId).toBe(process.execPath)
    expect(result.metadata.durationMs).toBeGreaterThanOrEqual(0)
  })

  test("concatenates multiple agent_message_chunk updates", async () => {
    const opts: AcpClientOptions = {
      command: bunCommand(mockAgent),
      cwd: process.cwd(),
      timeout: 30_000,
    }
    const env = { ...process.env, MOCK_AGENT_TEXT: "abc", MOCK_AGENT_CHUNKS: "3" }
    const result = await runOneShotSession(opts, "say hi", { env })
    expect(result.output).toBe("abcabcabc")
  })
})

describe("runOneShotSession - clientCapabilities", () => {
  test("sends clientCapabilities as empty object (no fs, no terminal)", async () => {
    const logPath = tmpLogPath()
    try {
      const opts: AcpClientOptions = {
        command: bunCommand(mockAgent),
        cwd: process.cwd(),
        timeout: 30_000,
      }
      const env = { ...process.env, MOCK_AGENT_LOG_PATH: logPath }
      await runOneShotSession(opts, "say hi", { env })
      const raw = fs.readFileSync(logPath, "utf8")
      const initParams = JSON.parse(raw) as {
        protocolVersion?: number
        clientCapabilities?: Record<string, unknown>
      }
      expect(initParams.clientCapabilities).toBeDefined()
      const caps = initParams.clientCapabilities ?? {}
      expect(caps.fs).toBeUndefined()
      expect(caps.terminal).toBeUndefined()
      const allowedKeys = ["_meta"]
      const realKeys = Object.keys(caps).filter((k) => !allowedKeys.includes(k))
      expect(realKeys).toEqual([])
    } finally {
      try { fs.unlinkSync(logPath) } catch {}
    }
  })
})

describe("runOneShotSession - timeout", () => {
  test("throws AcpTimeoutError when agent never responds", async () => {
    const opts: AcpClientOptions = {
      command: bunCommand(slowMockAgent),
      cwd: process.cwd(),
      timeout: 500,
    }
    const start = Date.now()
    let err: unknown
    try {
      await runOneShotSession(opts, "hello")
    } catch (e) {
      err = e
    }
    const elapsed = Date.now() - start
    expect(err).toBeInstanceOf(AcpTimeoutError)
    expect((err as Error).message).toMatch(/timed out/i)
    expect(elapsed).toBeLessThan(15_000)
  }, 20_000)
})

describe("runOneShotSession - ENOENT", () => {
  test("throws an error containing 'not found' for missing binary", async () => {
    const opts: AcpClientOptions = {
      command: ["definitely-not-a-real-binary-xyz123-acp"],
      cwd: process.cwd(),
      timeout: 5_000,
    }
    let err: unknown
    try {
      await runOneShotSession(opts, "hi")
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(AcpError)
    expect((err as Error).message).toMatch(/not found/i)
  })
})

describe("runOneShotSession - output cap", () => {
  test("truncates output when total bytes exceed maxOutputBytes", async () => {
    const opts: AcpClientOptions = {
      command: bunCommand(mockAgent),
      cwd: process.cwd(),
      timeout: 30_000,
    }
    const env = {
      ...process.env,
      MOCK_AGENT_TEXT: "x".repeat(1000),
      MOCK_AGENT_CHUNKS: "5",
    }
    const result = await runOneShotSession(opts, "go", {
      env,
      maxOutputBytes: 1500,
    })
    expect(result.output.length).toBeLessThanOrEqual(1500)
    expect(result.output.length).toBeGreaterThan(0)
  })
})
