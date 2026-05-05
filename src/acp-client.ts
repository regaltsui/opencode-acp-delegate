import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { Writable, Readable } from "node:stream"
import * as acp from "@agentclientprotocol/sdk"
import type { AcpClientOptions, OneShotResult } from "./types.js"
import { GRACE_PERIOD_MS, MAX_OUTPUT_BYTES } from "./types.js"

export class AcpError extends Error {
  readonly code?: string
  constructor(message: string, code?: string) {
    super(message)
    this.name = "AcpError"
    this.code = code
  }
}

export class AcpTimeoutError extends AcpError {
  readonly agentId: string
  readonly timeoutMs: number
  constructor(agentId: string, timeoutMs: number) {
    super(`Agent ${agentId} timed out after ${timeoutMs}ms`, "ETIMEDOUT")
    this.name = "AcpTimeoutError"
    this.agentId = agentId
    this.timeoutMs = timeoutMs
  }
}

export interface RunOneShotInternalOpts {
  env?: NodeJS.ProcessEnv
  maxOutputBytes?: number
}

interface SessionUpdateLike {
  update: {
    sessionUpdate: string
    content?: { type: string; text?: string }
  }
}

export async function runOneShotSession(
  opts: AcpClientOptions,
  prompt: string,
  internal: RunOneShotInternalOpts = {},
): Promise<OneShotResult> {
  const startMs = Date.now()
  const maxOutputBytes = internal.maxOutputBytes ?? MAX_OUTPUT_BYTES
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
      env: internal.env ?? process.env,
    })
  } catch (e) {
    const err = e as NodeJS.ErrnoException
    if (err.code === "ENOENT") {
      throw new AcpError(`Agent binary not found: ${binary}`, "ENOENT")
    }
    throw new AcpError(err.message, err.code)
  }

  child.stderr.on("data", () => {})

  const spawnErrorPromise = new Promise<never>((_, reject) => {
    child.once("error", (e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") {
        reject(new AcpError(`Agent binary not found: ${binary}`, "ENOENT"))
      } else {
        reject(new AcpError(e.message, e.code))
      }
    })
  })

  const collectedText: string[] = []
  let outputBytes = 0
  let outputCapped = false

  const clientHandler = () =>
    ({
      async sessionUpdate(params: SessionUpdateLike) {
        const u = params.update
        if (
          u.sessionUpdate === "agent_message_chunk" &&
          u.content?.type === "text" &&
          typeof u.content.text === "string"
        ) {
          if (outputCapped) return
          const chunk = u.content.text
          const remaining = maxOutputBytes - outputBytes
          if (chunk.length <= remaining) {
            collectedText.push(chunk)
            outputBytes += chunk.length
          } else {
            if (remaining > 0) collectedText.push(chunk.slice(0, remaining))
            outputBytes = maxOutputBytes
            outputCapped = true
          }
        }
      },
      async requestPermission() {
        return { outcome: { outcome: "cancelled" as const } }
      },
    }) as unknown as acp.Client

  const input = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>
  const output = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>
  const stream = acp.ndJsonStream(input, output)
  const connection = new acp.ClientSideConnection(clientHandler, stream)

  const killChild = (): void => {
    if (!child.killed) {
      try { child.kill("SIGTERM") } catch {}
      setTimeout(() => {
        try { if (!child.killed) child.kill("SIGKILL") } catch {}
      }, GRACE_PERIOD_MS).unref()
    }
  }

  let timeoutHandle: NodeJS.Timeout | null = null
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      killChild()
      reject(new AcpTimeoutError(agentId, opts.timeout))
    }, opts.timeout)
  })

  const sessionPromise = (async () => {
    await connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    })
    const newSessionResult = await connection.newSession({
      cwd: opts.cwd,
      mcpServers: [],
    })
    await connection.prompt({
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
  }
}
