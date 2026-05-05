#!/usr/bin/env bun
/**
 * Mock ACP agent fixture. Env-var contract:
 *   MOCK_AGENT_LOG_PATH  -- writes initialize params here so tests can assert
 *                           what `clientCapabilities` were sent.
 *   MOCK_AGENT_TEXT      -- text emitted per agent_message_chunk (default "Hello from mock agent!").
 *   MOCK_AGENT_CHUNKS    -- number of chunks to emit (default 1).
 */
import readline from "node:readline"
import fs from "node:fs"

const logPath = process.env["MOCK_AGENT_LOG_PATH"]
const text = process.env["MOCK_AGENT_TEXT"] ?? "Hello from mock agent!"
const chunkCount = Number(process.env["MOCK_AGENT_CHUNKS"] ?? "1")

const rl = readline.createInterface({ input: process.stdin })

rl.on("line", (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  let msg: { jsonrpc?: string; id?: unknown; method?: string; params?: any }
  try {
    msg = JSON.parse(trimmed)
  } catch {
    return
  }

  const id = msg.id
  const method = msg.method

  if (method === "initialize") {
    if (logPath) {
      try {
        fs.writeFileSync(logPath, JSON.stringify(msg.params ?? {}, null, 2))
      } catch {}
    }
    write({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: msg.params?.protocolVersion ?? 1,
        agentInfo: { name: "mock-agent", version: "1.0" },
        agentCapabilities: {},
      },
    })
    return
  }

  if (method === "session/new") {
    write({
      jsonrpc: "2.0",
      id,
      result: { sessionId: "mock-session-123" },
    })
    return
  }

  if (method === "session/prompt") {
    const sessionId = msg.params?.sessionId
    for (let i = 0; i < chunkCount; i++) {
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text },
          },
        },
      })
    }
    write({
      jsonrpc: "2.0",
      id,
      result: { stopReason: "end_turn" },
    })
    return
  }

  if (method === "session/close") {
    write({ jsonrpc: "2.0", id, result: {} })
    process.exit(0)
  }

  if (typeof id !== "undefined") {
    write({ jsonrpc: "2.0", id, result: {} })
  }
})

function write(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + "\n")
}
