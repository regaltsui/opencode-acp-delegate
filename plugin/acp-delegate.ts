/**
 * opencode-acp-delegate — ACP delegation plugin for Opencode
 *
 * Exposes a single unified `acp_delegate` tool that routes to any configured
 * ACP agent by id via the shared core @regaltsui/acp-delegate. Each agent
 * drives a one-shot ACP session and returns the final text response synchronously.
 *
 * Legacy mode (enableUnifiedTool: false) keeps per-agent delegate_to_<id> tools
 * for backward compatibility. When enableUnifiedTool: true, only acp_delegate
 * is exposed as the sole entry point.
 *
 * CONFIGURATION: Provide agents via JSON or as tuple options in opencode.json:
 *   1. Tuple options (GitHub URL install in opencode.json)
 *   2. $OPENCODE_ACP_DELEGATE_CONFIG (path to a JSON file)
 *   3. ~/.config/opencode/acp-delegate.json
 *   4. ~/.opencode/acp-delegate.json
 */

// ---------------------------------------------------------------------------
// Portable crypto utilities (Web Crypto API — works in Node, Deno, Bun)
// Avoids `node:crypto` which may not resolve in non-Node plugin runtimes.
// ---------------------------------------------------------------------------

/** Generate a UUID v4 using globalThis.crypto (with manual fallback). */
function randomUUID(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID()
  }
  // Fallback: UUID v4 from getRandomValues
  const buf = new Uint8Array(16)
  globalThis.crypto.getRandomValues(buf)
  buf[6] = (buf[6] & 0x0f) | 0x40 // version 4
  buf[8] = (buf[8] & 0x3f) | 0x80 // variant 10
  const hex = Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Generate `bytes` random bytes as a hex string (replaces `randomBytes(n).toString("hex")`). */
function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes)
  globalThis.crypto.getRandomValues(buf)
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("")
}

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { readFile, writeFile, mkdir, stat, unlink, rename, appendFile } from "node:fs/promises"
import { createInterface } from "node:readline"
import { join, dirname, relative, isAbsolute, resolve as resolvePath } from "node:path"
import { homedir } from "node:os"
import {
  type Plugin,
  type PluginInput,
  type PluginOptions as OpencodePluginOptions,
  type ToolContext,
  type ToolDefinition,
  tool,
} from "@opencode-ai/plugin"
import {
  // Types
  type AgentConfig as CoreAgentConfig,
  type AcpPluginOptions as CoreAcpPluginOptions,
  type HealthEntry,
  type AcpStopReason,
  type DelegationStatus,
  type AcpClientOptions,
  type OneShotResult,
  type InflightEntry,
  type RecentEntry,
  type AcpState,
  type UsageEntry,
  type PreambleBlock,
  type ExecuteOutcome,
  type HostAdapter,
  type Namespace,
  type ComplexityTier,
  type RunDelegationArgs,
  // Constants
  OPENCODE_NAMESPACE,
  INCLUDE_CONTEXT_TOTAL_BUDGET_BYTES,
  INCLUDE_CONTEXT_PER_FILE_BUDGET_BYTES,
  INCLUDE_CONTEXT_PER_FILE_BUDGET_BYTES as INCLUDE_CONTEXT_PER_FILE_BUDGET_BYTES_CORE,
  INCLUDE_CONTEXT_TOTAL_BUDGET_BYTES as INCLUDE_CONTEXT_TOTAL_BUDGET_BYTES_CORE,
  DEFAULT_TIMEOUT_MS,
  GRACE_PERIOD_MS,
  MAX_OUTPUT_BYTES,
  STDERR_BUFFER_BYTES,
  ACP_PROTOCOL_VERSION,
  SESSION_CLOSE_TIMEOUT_MS,
  HEALTH_PROBE_TIMEOUT_MS,
  STATE_RECENT_MAX,
  STATE_FILE_VERSION,
  USAGE_LOG_MAX_BYTES,
  PROMPT_SNIPPET_MAX,
  TITLE_PROMPT_MAX,
  COMPLEXITY_TIERS,
  STATE_FILE_NAME,
  USAGE_LOG_NAME,
  // Functions — config
  readFallbackConfig,
  validateAgent,
  missingAgentsMessage,
  // Functions — state (namespace-parameterized)
  recordInflight as coreRecordInflight,
  resolveInflight as coreResolveInflight,
  recordHealth,
  appendUsage as coreAppendUsage,
  getStateDir as coreGetStateDir,
  // Functions — context
  buildContextPreamble,
  snippet,
  // Functions — descriptions / routing
  sanitizeToolSuffix,
  describeAgent,
  describeAgentFooter,
  summarizeAgent,
  buildRoutingBlock,
  buildSpawnCommand,
  resolveModel,
  // Functions — health
  probeAll,
  // Functions — delegation
  runDelegation as coreRunDelegation,
  // Functions — trailer
  applyStopReasonTrailer,
  // Functions — errors
  AcpError,
  AcpTimeoutError,
  AcpAbortError,
} from "@regaltsui/acp-delegate"

const z = tool.schema

// ============================================================================
// Plugin-specific extensions to core types
// ============================================================================

/** Extended config type — adds routing and unified-tool support on top of core. */
interface AcpPluginOptions extends CoreAcpPluginOptions {
  routing?: RoutingTable
  enableUnifiedTool?: boolean
}

interface RoutingEntry {
  /** Agent id — must exist in the agents array. */
  agent: string
  /** Model id passed to the agent. If omitted, the agent's defaultModel or complexityModels[level] is used. */
  model?: string
  /** Complexity tier this entry matches. If omitted, this entry matches any complexity (used as a fallback). */
  complexity?: ComplexityTier
}

type RoutingTable = RoutingEntry[]

// ============================================================================
// Agent registry — JSON fallback config (drop-in path can't receive tuple opts)
// ============================================================================

const CONFIG_ENV_VAR = `${OPENCODE_NAMESPACE.envPrefix}_CONFIG`

function fallbackConfigPaths(): string[] {
  const paths: string[] = []
  const fromEnv = process.env[CONFIG_ENV_VAR]
  if (fromEnv && fromEnv.length > 0) paths.push(fromEnv)
  const dir = OPENCODE_NAMESPACE.configDirSubpath
  paths.push(join(homedir(), ".config", dir, "acp-delegate.json"))
  paths.push(join(homedir(), `.${dir}`, "acp-delegate.json"))
  return paths
}

function readFallbackConfigLocal(): CoreAcpPluginOptions | null {
  for (const p of fallbackConfigPaths()) {
    if (!existsSync(p)) continue
    try {
      const raw = readFileSync(p, "utf8")
      const parsed = JSON.parse(raw) as AcpPluginOptions
      if (parsed && Array.isArray(parsed.agents) && parsed.agents.length > 0) {
        return parsed
      }
    } catch {
      continue
    }
  }
  return null
}

// ============================================================================
// Plugin-specific config resolver (routing + unified tool on top of core)
// ============================================================================

function resolvePluginOptions(opts: AcpPluginOptions): {
  agents: CoreAgentConfig[]
  injectSystemGuidance: boolean
  enableUnifiedTool: boolean
  routing: RoutingTable | undefined
} {
  let source: AcpPluginOptions | null =
    opts && Array.isArray(opts.agents) && opts.agents.length > 0 ? opts : null
  if (!source) {
    source = readFallbackConfigLocal()
  }
  if (!source || !Array.isArray(source.agents) || source.agents.length === 0) {
    throw new Error(missingAgentsMessage(OPENCODE_NAMESPACE))
  }
  const routing = validateRouting(source.routing, source.agents)
  return {
    agents: source.agents.map((raw, i) => validateAgent(raw as unknown, i)),
    injectSystemGuidance: source.injectSystemGuidance === true,
    enableUnifiedTool: source.enableUnifiedTool === true,
    routing,
  }
}

function validateRouting(routing: RoutingTable | undefined, agents: unknown[]): RoutingTable | undefined {
  if (routing === undefined) return undefined
  if (!Array.isArray(routing)) {
    throw new Error("Plugin config: 'routing' must be an array when provided")
  }
  const agentConfigs = new Map(agents.map((a: unknown) => {
    const cfg = a as { id: string; models?: string[] }
    return [cfg.id, cfg] as const
  }))
  const validTiers = new Set<string>(["high", "mid", "low"])
  const result: RoutingEntry[] = []
  for (let i = 0; i < routing.length; i++) {
    const entry = routing[i]
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`Plugin config: routing[${i}] must be an object`)
    }
    const e = entry as unknown as Record<string, unknown>
    if (typeof e.agent !== "string" || e.agent.length === 0) {
      throw new Error(`Plugin config: routing[${i}].agent must be a non-empty string`)
    }
    const agentCfg = agentConfigs.get(e.agent)
    if (agentCfg === undefined) {
      throw new Error(`Plugin config: routing[${i}].agent '${e.agent}' is not in agents list [${Array.from(agentConfigs.keys()).join(", ")}]`)
    }
    if (e.model !== undefined) {
      if (typeof e.model !== "string" || e.model.length === 0) {
        throw new Error(`Plugin config: routing[${i}].model must be a non-empty string when provided`)
      }
      if (Array.isArray(agentCfg.models) && agentCfg.models.length > 0 && !agentCfg.models.includes(e.model as string)) {
        throw new Error(`Plugin config: routing[${i}].model '${e.model}' is not in agent '${e.agent}' models [${agentCfg.models.join(", ")}]`)
      }
    }
    if (e.complexity !== undefined) {
      if (typeof e.complexity !== "string" || !validTiers.has(e.complexity as string)) {
        throw new Error(`Plugin config: routing[${i}].complexity must be 'high', 'mid', or 'low' when provided`)
      }
    }
    result.push({
      agent: e.agent,
      ...(e.model !== undefined ? { model: e.model as string } : {}),
      ...(e.complexity !== undefined ? { complexity: e.complexity as ComplexityTier } : {}),
    })
  }
  return result
}

// ============================================================================
// State directory — opencode-specific path resolution
// ============================================================================

const STATE_DIR_ENV = `${OPENCODE_NAMESPACE.envPrefix}_STATE_DIR`

/** Opencode-specific state dir resolver; delegates to core when no explicit override. */
function getStateDir(): string {
  const explicit = process.env[STATE_DIR_ENV]
  if (explicit && explicit.length > 0) return explicit
  return coreGetStateDir(OPENCODE_NAMESPACE)
}

function getStateFilePath(): string {
  return join(getStateDir(), STATE_FILE_NAME)
}

function getUsageLogPath(): string {
  return join(getStateDir(), USAGE_LOG_NAME)
}

function emptyState(): AcpState {
  return {
    version: STATE_FILE_VERSION,
    updatedAt: Date.now(),
    pid: process.pid,
    inflight: [],
    recent: [],
    health: [],
  }
}

async function loadState(): Promise<AcpState> {
  try {
    const raw = await readFile(getStateFilePath(), "utf8")
    const parsed = JSON.parse(raw) as Partial<AcpState>
    return {
      version: STATE_FILE_VERSION,
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : Date.now(),
      pid: typeof parsed.pid === "number" ? parsed.pid : process.pid,
      inflight: Array.isArray(parsed.inflight) ? parsed.inflight : [],
      recent: Array.isArray(parsed.recent) ? parsed.recent : [],
      health: Array.isArray(parsed.health) ? parsed.health : [],
    }
  } catch {
    return emptyState()
  }
}

async function ensureStateDir(): Promise<void> {
  await mkdir(getStateDir(), { recursive: true })
}

async function saveStateAtomic(state: AcpState): Promise<void> {
  const target = getStateFilePath()
  await ensureStateDir()
  const dir = dirname(target)
  const tmpPath = join(
    dir,
    `${STATE_FILE_NAME}.${process.pid}.${randomHex(4)}.tmp`,
  )
  const payload = { ...state, version: STATE_FILE_VERSION, updatedAt: Date.now(), pid: process.pid }
  try {
    await writeFile(tmpPath, JSON.stringify(payload, null, 2), "utf8")
    await rename(tmpPath, target)
  } catch (err) {
    try { await unlink(tmpPath) } catch {}
    throw err
  }
}

let writeQueue: Promise<unknown> = Promise.resolve()
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeQueue.then(fn, fn)
  writeQueue = next.catch(() => {})
  return next
}

// State mutations — wrapper functions that supply OPENCODE_NAMESPACE to core.
// The core versions accept a Namespace first parameter; these wrappers fix it.

async function localRecordInflight(entry: InflightEntry): Promise<void> {
  return enqueue(async () => {
    const state = await loadState()
    state.inflight = state.inflight.filter((e) => e.callId !== entry.callId)
    state.inflight.push(entry)
    await saveStateAtomic(state)
  })
}

async function localResolveInflight(
  callId: string,
  result: { status: DelegationStatus; endedAt: number; durationMs: number; errorCode?: string },
): Promise<void> {
  return enqueue(async () => {
    const state = await loadState()
    const found = state.inflight.find((e) => e.callId === callId)
    state.inflight = state.inflight.filter((e) => e.callId !== callId)
    if (found) {
      const recent: RecentEntry = {
        ...found,
        status: result.status,
        endedAt: result.endedAt,
        durationMs: result.durationMs,
        ...(result.errorCode !== undefined ? { errorCode: result.errorCode } : {}),
      }
      state.recent = [recent, ...state.recent].slice(0, STATE_RECENT_MAX)
    }
    await saveStateAtomic(state)
  })
}

async function setHealthResults(health: HealthEntry[]): Promise<void> {
  return enqueue(async () => {
    const state = await loadState()
    state.health = health
    await saveStateAtomic(state)
  })
}

async function rotateUsageLogIfNeeded(target: string): Promise<void> {
  try {
    const info = await stat(target)
    if (info.size < USAGE_LOG_MAX_BYTES) return
    const rolled = `${target}.1`
    try { await unlink(rolled) } catch {}
    await rename(target, rolled)
  } catch {}
}

async function localAppendUsage(entry: UsageEntry): Promise<void> {
  return enqueue(async () => {
    await ensureStateDir()
    const target = getUsageLogPath()
    await rotateUsageLogIfNeeded(target)
    await appendFile(target, JSON.stringify(entry) + "\n", "utf8")
  })
}

// ============================================================================
// Inline ACP client — raw JSON-RPC 2.0 over stdio (no SDK dependency)
// ============================================================================

interface SessionUpdateParams {
  sessionId?: string
  update?: {
    sessionUpdate?: string
    content?: { type?: string; text?: string }
  }
}

interface ReadTextFileParams {
  path?: unknown
  line?: unknown
  limit?: unknown
}

interface PermissionOption {
  optionId: string
  name?: string
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always"
}

interface RequestPermissionParams {
  sessionId?: string
  toolCall?: unknown
  options?: unknown[]
}

const VALID_STOP_REASONS = new Set<AcpStopReason>([
  "end_turn",
  "max_tokens",
  "max_turn_requests",
  "refusal",
  "cancelled",
])

function coerceStopReason(value: unknown): AcpStopReason | undefined {
  return typeof value === "string" && VALID_STOP_REASONS.has(value as AcpStopReason)
    ? (value as AcpStopReason)
    : undefined
}

const activeChildren: Set<ChildProcessWithoutNullStreams> = new Set()
let reaperRegistered = false

function registerReaperOnce(): void {
  if (reaperRegistered) return
  reaperRegistered = true
  const reap = (): void => {
    for (const child of activeChildren) {
      try { if (!child.killed) child.kill("SIGTERM") } catch {}
    }
  }
  process.once("exit", reap)
  process.once("SIGINT", () => { reap(); process.exit(130) })
  process.once("SIGTERM", () => { reap(); process.exit(143) })
}

function isPathInside(child: string, parent: string): boolean {
  const rel = relative(parent, child)
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel)
}

async function readBoundedTextFile(
  cwdAbs: string,
  params: ReadTextFileParams,
): Promise<{ content: string }> {
  const path = params.path
  if (typeof path !== "string" || path.length === 0) {
    throw new Error("readTextFile: 'path' must be a non-empty string")
  }
  const requested = isAbsolute(path) ? path : resolvePath(cwdAbs, path)
  const target = resolvePath(requested)
  if (target !== cwdAbs && !isPathInside(target, cwdAbs)) {
    throw new Error(`readTextFile: path is outside the project directory: ${path}`)
  }
  const raw = await readFile(target, "utf8")
  const startLine =
    typeof params.line === "number" && Number.isFinite(params.line) && params.line > 0
      ? params.line
      : 1
  const limit =
    typeof params.limit === "number" && Number.isFinite(params.limit) && params.limit > 0
      ? params.limit
      : undefined
  if (startLine === 1 && limit === undefined) return { content: raw }
  const lines = raw.split("\n")
  const sliced = lines.slice(startLine - 1, limit !== undefined ? startLine - 1 + limit : undefined)
  return { content: sliced.join("\n") }
}

async function runOneShotSession(opts: AcpClientOptions, prompt: string): Promise<OneShotResult> {
  const startMs = Date.now()
  const binary = opts.command[0]
  if (!binary) {
    throw new AcpError("AcpClientOptions.command must have at least one element", "EINVAL")
  }
  const args = opts.command.slice(1)
  const agentId = binary

  if (opts.signal?.aborted) throw new AcpAbortError()
  registerReaperOnce()

  let child: ChildProcessWithoutNullStreams
  try {
    child = spawn(binary, args, { cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"] })
  } catch (e) {
    const err = e as NodeJS.ErrnoException
    if (err.code === "ENOENT") throw new AcpError(`Agent binary not found: ${binary}`, "ENOENT")
    throw new AcpError(err.message, err.code)
  }

  activeChildren.add(child)

  const stderrChunks: Buffer[] = []
  let stderrBytes = 0
  child.stderr.on("data", (chunk: Buffer) => {
    stderrChunks.push(chunk)
    stderrBytes += chunk.length
    while (stderrBytes > STDERR_BUFFER_BYTES && stderrChunks.length > 1) {
      const dropped = stderrChunks.shift()
      if (dropped) stderrBytes -= dropped.length
    }
  })
  const getStderrTail = (): string =>
    stderrChunks.length === 0 ? "" : Buffer.concat(stderrChunks).toString("utf8")

  let nextRequestId = 0
  const pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void }
  >()
  const collectedText: string[] = []
  let outputBytes = 0
  let outputCapped = false
  const cwdAbs = resolvePath(opts.cwd)

  let activeSessionId: string | null = null
  let serverSupportsClose = false
  let stopReason: AcpStopReason | undefined

  const sendJson = (obj: unknown): void => {
    try { child.stdin.write(JSON.stringify(obj) + "\n", () => {}) } catch {}
  }

  const sendNotification = (method: string, params: unknown): void => {
    sendJson({ jsonrpc: "2.0", method, params })
  }

  const sendCancelNotification = (): void => {
    if (!activeSessionId) return
    sendNotification("session/cancel", { sessionId: activeSessionId })
  }

  const sendRequest = (method: string, params: unknown): Promise<unknown> => {
    const id = ++nextRequestId
    return new Promise((resolveReq, rejectReq) => {
      pending.set(id, { resolve: resolveReq, reject: rejectReq })
      try {
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n", (err) => {
          if (err) {
            pending.delete(id)
            rejectReq(new AcpError(`Failed to write to agent stdin: ${err.message}`, "EIO"))
          }
        })
      } catch (err) {
        pending.delete(id)
        rejectReq(new AcpError(`Failed to write to agent stdin: ${(err as Error).message}`, "EIO"))
      }
    })
  }

  const sendResult = (id: number | string, result: unknown): void => {
    sendJson({ jsonrpc: "2.0", id, result })
  }

  const sendError = (id: number | string, message: string, code = -32603): void => {
    sendJson({ jsonrpc: "2.0", id, error: { code, message, data: { details: message } } })
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
        collectedText.push(`\n\n[output truncated at ${MAX_OUTPUT_BYTES} bytes]\n`)
      }
    }
  }

  const rl = createInterface({ input: child.stdout })
  rl.on("line", (rawLine: string) => {
    const trimmed = rawLine.trim()
    if (trimmed.length === 0) return
    let msg: { jsonrpc?: string; id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { code?: number; message?: string } }
    try {
      msg = JSON.parse(trimmed)
    } catch {
      return
    }

    if (typeof msg.id === "number" && msg.method === undefined && pending.has(msg.id)) {
      const handler = pending.get(msg.id)!
      pending.delete(msg.id)
      if (msg.error) {
        handler.reject(new AcpError(msg.error.message ?? "Agent returned error", "EAGENT"))
      } else {
        handler.resolve(msg.result)
      }
      return
    }

    if (typeof msg.method === "string") {
      if (msg.method === "session/update") {
        handleSessionUpdate((msg.params ?? {}) as SessionUpdateParams)
        return
      }
      if (msg.method === "fs/read_text_file" && msg.id !== undefined) {
        const reqId = msg.id
        void (async () => {
          try {
            const result = await readBoundedTextFile(cwdAbs, (msg.params ?? {}) as ReadTextFileParams)
            sendResult(reqId, result)
          } catch (err) {
            sendError(reqId, (err as Error).message)
          }
        })()
        return
      }
      if (msg.method === "session/request_permission" && msg.id !== undefined) {
        const params = (msg.params ?? {}) as RequestPermissionParams
        const options = Array.isArray(params.options) ? params.options : []
        const preferredKinds = opts.autoApprove
          ? (["allow_once", "allow_always"] as const)
          : (["reject_once", "reject_always"] as const)
        let chosen: PermissionOption | undefined
        for (const kind of preferredKinds) {
          chosen = options.find(
            (o): o is PermissionOption =>
              !!o && typeof o === "object" && (o as PermissionOption).kind === kind && typeof (o as PermissionOption).optionId === "string",
          )
          if (chosen) break
        }
        if (chosen) {
          sendResult(msg.id, { outcome: { outcome: "selected", optionId: chosen.optionId } })
        } else {
          sendResult(msg.id, { outcome: { outcome: "cancelled" } })
        }
        return
      }
    }
  })

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
        reject(new AcpError(`Agent binary not found: ${binary}`, "ENOENT", getStderrTail()))
      } else {
        reject(new AcpError(e.message, e.code, getStderrTail()))
      }
    })
  })

  let timeoutHandle: NodeJS.Timeout | null = null
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      sendCancelNotification()
      killChild()
      reject(new AcpTimeoutError(agentId, opts.timeout, getStderrTail()))
    }, opts.timeout)
  })

  let abortListener: (() => void) | null = null
  const abortPromise = new Promise<never>((_, reject) => {
    if (!opts.signal) return
    abortListener = (): void => {
      sendCancelNotification()
      killChild()
      reject(new AcpAbortError(getStderrTail()))
    }
    opts.signal.addEventListener("abort", abortListener, { once: true })
  })

  const sessionPromise = (async (): Promise<string> => {
    const initResult = (await sendRequest("initialize", {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: true } },
    })) as { agentCapabilities?: { sessionCapabilities?: { close?: unknown } } }
    serverSupportsClose = Boolean(
      initResult?.agentCapabilities?.sessionCapabilities?.close,
    )
    const newSessionResult = (await sendRequest("session/new", {
      cwd: opts.cwd,
      mcpServers: [],
    })) as { sessionId: string }
    activeSessionId = newSessionResult.sessionId
    const promptResult = (await sendRequest("session/prompt", {
      sessionId: newSessionResult.sessionId,
      prompt: [{ type: "text", text: prompt }],
    })) as { stopReason?: unknown }
    stopReason = coerceStopReason(promptResult?.stopReason)
    return collectedText.join("")
  })()

  try {
    const races: Array<Promise<string>> = [sessionPromise, timeoutPromise, spawnErrorPromise]
    if (opts.signal) races.push(abortPromise)
    const output = await Promise.race(races)
    return {
      output,
      metadata: {
        durationMs: Date.now() - startMs,
        agentId,
        ...(stopReason !== undefined ? { stopReason } : {}),
      },
    }
  } catch (e) {
    const tail = getStderrTail()
    if (e instanceof AcpError) {
      if (e.stderr === undefined && tail.length > 0) {
        if (e instanceof AcpTimeoutError) throw new AcpTimeoutError(e.agentId, e.timeoutMs, tail)
        if (e instanceof AcpAbortError) throw new AcpAbortError(tail)
        throw new AcpError(e.message, e.code, tail)
      }
      throw e
    }
    const errObj = e instanceof Error ? e : new Error(String(e))
    throw new AcpError(errObj.message, "EAGENT", tail.length > 0 ? tail : undefined)
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle)
    if (abortListener && opts.signal) {
      try { opts.signal.removeEventListener("abort", abortListener) } catch {}
    }
    if (serverSupportsClose && activeSessionId && stopReason !== undefined && !child.killed) {
      try {
        await Promise.race([
          sendRequest("session/close", { sessionId: activeSessionId }).catch(() => {}),
          new Promise<void>((res) => setTimeout(() => res(), SESSION_CLOSE_TIMEOUT_MS).unref()),
        ])
      } catch {}
    }
    activeChildren.delete(child)
    killChild()
    rl.close()
  }
}

// ============================================================================
// Plugin entry — one tool per registered agent + state-file integration
// ============================================================================

// resolveRoute — when agent is omitted, look up routing table for the
// effective complexity tier. Falls back to the agent marked default:true
// or agents[0].
function resolveRoute(
  routing: RoutingTable | undefined,
  agents: CoreAgentConfig[],
  complexity: ComplexityTier | undefined,
): { agent: CoreAgentConfig; model: string | undefined } {
  const tier: ComplexityTier = complexity ?? "mid"

  // Scan the routing table for matching entries in order.
  if (routing !== undefined && routing.length > 0) {
    // First pass: exact match on both agent (if hinted) and complexity.
    // We don't filter by agent here because resolveRoute is called when
    // agent is omitted — we want the routing table to pick the agent.
    for (const entry of routing) {
      if (entry.complexity === tier) {
        const agent = agents.find((a) => a.id === entry.agent)
        if (agent !== undefined) {
          return { agent, model: entry.model }
        }
      }
    }
    // Second pass: entries without complexity (they match any tier).
    for (const entry of routing) {
      if (entry.complexity === undefined) {
        const agent = agents.find((a) => a.id === entry.agent)
        if (agent !== undefined) {
          return { agent, model: entry.model }
        }
      }
    }
  }

  // No routing entry matched. Fall back to default agent.
  // Return model: undefined so resolveModel handles complexityModels.
  const fallback = agents.find((a) => a.default) ?? agents[0]
  return { agent: fallback, model: undefined }
}

// ============================================================================
// HostAdapter bridge — adapts opencode's ToolContext to the shared-core's
// HostAdapter interface.
// ============================================================================

function makeHost(ctx: ToolContext): HostAdapter {
  return {
    getDirectory: (_args?: { directoryArg?: string }) => ctx.directory,
    getSessionId: () => ctx.sessionID.slice(0, 6),
    getAbortSignal: () => ctx.abort,
    reportProgress: (m: Record<string, unknown>) =>
      ctx.metadata(m as { title?: string; metadata?: Record<string, unknown> }),
    namespace: OPENCODE_NAMESPACE,
  }
}

// ============================================================================
// Delegate wrapper — bridges the opencode tool handler to core runDelegation
// ============================================================================

async function localRunDelegation(
  agent: CoreAgentConfig,
  args: { prompt: string; includeContext?: string[]; model?: string; complexity?: ComplexityTier },
  ctx: ToolContext,
  toolPrefix?: string,
): Promise<{ output: string; metadata: Record<string, unknown> }> {
  return coreRunDelegation(
    agent,
    {
      prompt: args.prompt,
      includeContext: args.includeContext,
      model: args.model,
      complexity: args.complexity,
    },
    makeHost(ctx),
    null, // pool=null → one-shot mode (no session pooling)
    undefined, // agents=undefined → no fallback/availability logic
  )
}

const PROMPT_ARG = z
  .string()
  .min(1)
  .describe(
    "Self-contained task prompt. The agent has zero prior context; include all goals, " +
      "constraints, and the desired output format inline.",
  )

const INCLUDE_CONTEXT_ARG = z
  .array(z.string().min(1))
  .optional()
  .describe(
    `Optional. Relative paths under the project cwd (files or directories). Their contents ` +
      `are eagerly read and prepended to the prompt as <context path="…"> blocks, capped at ` +
      `${INCLUDE_CONTEXT_TOTAL_BUDGET_BYTES / 1024} KiB total / ${INCLUDE_CONTEXT_PER_FILE_BUDGET_BYTES / 1024} KiB per file. ` +
      `Binary files and paths outside the project are skipped with a notice.`,
  )

// ============================================================================
// Tool factory — one opencode ToolDefinition per ACP agent
// ============================================================================

function makeDelegateTool(agent: CoreAgentConfig): ToolDefinition {
  const hasModels = agent.models !== undefined && agent.models.length > 0
  const hasComplexity = agent.complexityModels !== undefined &&
    Object.values(agent.complexityModels).some((v) => typeof v === "string" && v.length > 0)

  // Build the complexity arg when complexityModels is populated.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let complexityArg: any = undefined
  if (hasComplexity) {
    const populatedTiers = (["high", "mid", "low"] as const).filter((t) => {
      const v = agent.complexityModels?.[t]
      return typeof v === "string" && v.length > 0
    })
    if (populatedTiers.length > 0) {
      complexityArg = z
        .enum(populatedTiers as [string, ...string[]])
        .optional()
        .describe(
          `Optional. Complexity tier that selects a model via the agent's 'complexityModels' map. ` +
          `Ignored when 'model' is also supplied. ` +
          `Tiers: ${populatedTiers.map((t) => `${t} → ${agent.complexityModels![t]}`).join(", ")}.`,
        )
    }
  }

  // Both models + complexity
  if (hasModels && complexityArg !== undefined) {
    const models = agent.models!
    const modelArg = z
      .enum(models as [string, ...string[]])
      .optional()
      .describe(
        `Optional. Model id passed to the agent via '${agent.modelFlag ?? "--model"}'. ` +
          `Allowed values: ${models.join(", ")}. ` +
          (agent.defaultModel !== undefined
            ? `Defaults to '${agent.defaultModel}' when omitted.`
            : "Omit to use the agent's built-in default."),
      )
    return tool({
      description: describeAgent(agent),
      args: { prompt: PROMPT_ARG, includeContext: INCLUDE_CONTEXT_ARG, model: modelArg, complexity: complexityArg },
      execute: async (rawArgs, ctx) => {
        const args = rawArgs as { prompt: string; includeContext?: string[]; model?: string; complexity?: ComplexityTier }
        const result = await localRunDelegation(agent, args, ctx)
        if (args.complexity !== undefined) result.metadata.complexity = args.complexity
        return result
      },
    })
  }

  // Models only, no complexity
  if (hasModels) {
    const models = agent.models!
    const modelArg = z
      .enum(models as [string, ...string[]])
      .optional()
      .describe(
        `Optional. Model id passed to the agent via '${agent.modelFlag ?? "--model"}'. ` +
          `Allowed values: ${models.join(", ")}. ` +
          (agent.defaultModel !== undefined
            ? `Defaults to '${agent.defaultModel}' when omitted.`
            : "Omit to use the agent's built-in default."),
      )
    return tool({
      description: describeAgent(agent),
      args: { prompt: PROMPT_ARG, includeContext: INCLUDE_CONTEXT_ARG, model: modelArg },
      execute: async (args, ctx) => localRunDelegation(agent, args, ctx),
    })
  }

  // Complexity only, no explicit models list
  if (complexityArg !== undefined) {
    return tool({
      description: describeAgent(agent),
      args: { prompt: PROMPT_ARG, includeContext: INCLUDE_CONTEXT_ARG, complexity: complexityArg },
      execute: async (rawArgs, ctx) => {
        const args = rawArgs as { prompt: string; includeContext?: string[]; complexity?: ComplexityTier }
        const result = await localRunDelegation(agent, args, ctx)
        if (args.complexity !== undefined) result.metadata.complexity = args.complexity
        return result
      },
    })
  }

  // Neither models nor complexity — basic tool
  return tool({
    description: describeAgent(agent),
    args: { prompt: PROMPT_ARG, includeContext: INCLUDE_CONTEXT_ARG },
    execute: async (args, ctx) => localRunDelegation(agent, args, ctx),
  })
}

// ============================================================================
// Unified tool factory — single `acp_delegate` tool that routes by agent id
// ============================================================================

function describeUnifiedTool(registry: CoreAgentConfig[], routing: RoutingTable | undefined): string {
  const agentList = registry.map((a) => {
    const label = a.label ?? a.id
    const modelInfo = a.models && a.models.length > 0 ? ` (models: ${a.models.join(", ")})` : ""
    const complexityInfo = a.complexityModels
      ? ` (complexity: high→${a.complexityModels.high ?? "default"}, mid→${a.complexityModels.mid ?? "default"}, low→${a.complexityModels.low ?? "default"})`
      : ""
    return `  - "${a.id}" — ${label}${modelInfo}${complexityInfo}`
  }).join("\n")

  const routingDesc = routing && routing.length > 0
    ? `\n\nRouting table (used when 'agent' is omitted):\n` +
      routing.map((r) =>
        `  ${r.complexity ?? "*"} → ${r.agent}${r.model ? ` (${r.model})` : ""}`
      ).join("\n")
    : "\n\nWhen 'agent' is omitted, the default agent is used."

  return (
    `Delegate a self-contained task to an external coding agent via a unified interface. ` +
    `Select the agent by id, or omit 'agent' to let the routing table auto-select based on 'complexity'.\n\n` +
    `Available agents:\n${agentList}${routingDesc}\n\n` +
    `The 'model' parameter takes precedence over 'complexity'. ` +
    `When both 'agent' and 'model' are omitted, the routing table's first entry for 'mid' (or the default tier) selects both the agent and model.\n\n` +
    `The agent has no prior context — include all goals, constraints, and the desired output ` +
    `format inline. It can read files within the project directory (read-only); it cannot write ` +
    `or run shell commands. Pass relative file or directory paths via 'includeContext' to attach ` +
    `their contents inline (capped at ${INCLUDE_CONTEXT_TOTAL_BUDGET_BYTES / 1024} KiB total, ` +
    `${INCLUDE_CONTEXT_PER_FILE_BUDGET_BYTES / 1024} KiB per file). Returns the agent's final text ` +
    `response synchronously, with a [acp_delegate: …] trailer if the response was ` +
    `truncated by the agent's own token limit.`
  )
}

function makeUnifiedTool(registry: CoreAgentConfig[], routing: RoutingTable | undefined): ToolDefinition {
  const agentIds = registry.map((a) => a.id) as [string, ...string[]]
  const agentMap = new Map(registry.map((a) => [a.id, a]))

  // Determine which agents have complexityModels to decide if the complexity arg should be offered.
  const hasAnyComplexity = registry.some((a) => a.complexityModels !== undefined)

  const agentArg = z
    .enum(agentIds)
    .optional()
    .describe(
      `Optional. Agent id to delegate to. Available: ${agentIds.join(", ")}. ` +
      `When omitted, the routing table selects the agent based on 'complexity' (defaults to 'mid').`
    )

  const modelArg = z
    .string()
    .optional()
    .describe(
      "Optional. Model id passed to the agent. Must be in the agent's 'models' list when defined. " +
      "Takes precedence over 'complexity' when both are supplied."
    )

  const complexityArg = z
    .enum(["high", "mid", "low"] as [string, string, string])
    .optional()
    .describe(
      "Optional. Complexity tier. When 'agent' is omitted, used to look up the routing table. " +
      "When 'agent' is supplied, maps to a model via the agent's 'complexityModels'. " +
      "Defaults to 'mid' when both 'agent' and 'complexity' are omitted."
    )

  // Always include complexity when routing exists or any agent has complexityModels.
  const includeComplexity = hasAnyComplexity || routing !== undefined

  if (includeComplexity) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const args: any = {
      prompt: PROMPT_ARG,
      agent: agentArg,
      model: modelArg,
      complexity: complexityArg,
      includeContext: INCLUDE_CONTEXT_ARG,
    }
    return tool({
      description: describeUnifiedTool(registry, routing),
      args,
      execute: async (rawArgs, ctx) => {
        const args = rawArgs as {
          prompt: string
          agent?: string
          model?: string
          complexity?: ComplexityTier
          includeContext?: string[]
        }
        return executeUnifiedDelegation(agentMap, registry, routing, args, ctx)
      },
    })
  }

  return tool({
    description: describeUnifiedTool(registry, routing),
    args: {
      prompt: PROMPT_ARG,
      agent: agentArg,
      model: modelArg,
      includeContext: INCLUDE_CONTEXT_ARG,
    },
    execute: async (rawArgs, ctx) => {
      const args = rawArgs as {
        prompt: string
        agent?: string
        model?: string
        includeContext?: string[]
      }
      return executeUnifiedDelegation(agentMap, registry, routing, args, ctx)
    },
  })
}

// ============================================================================
// Unified delegation execute — shared between the two makeUnifiedTool branches
// ============================================================================

async function executeUnifiedDelegation(
  agentMap: Map<string, CoreAgentConfig>,
  registry: CoreAgentConfig[],
  routing: RoutingTable | undefined,
  args: { prompt: string; agent?: string; model?: string; complexity?: ComplexityTier; includeContext?: string[] },
  ctx: ToolContext,
): Promise<{ output: string; metadata: Record<string, unknown> }> {
  // Resolve agent: explicit > routing table > default.
  let agent: CoreAgentConfig
  let routingModel: string | undefined

  if (args.agent !== undefined) {
    // Explicit agent — validate it exists.
    const found = agentMap.get(args.agent)
    if (found === undefined) {
      const available = Array.from(agentMap.keys()).join(", ")
      return {
        output: `acp_delegate failed: unknown agent '${args.agent}'. Available: ${available}`,
        metadata: {
          agentId: args.agent,
          durationMs: 0,
          status: "error" as DelegationStatus,
          errorCode: "EAGENT",
        },
      }
    }
    agent = found
  } else {
    // No explicit agent — resolve via routing table or default.
    const route = resolveRoute(routing, registry, args.complexity)
    agent = route.agent
    routingModel = route.model
  }

  // Resolve effective model.
  // Precedence: explicit model > routing table model > complexityModels[tier] > defaultModel.
  let effectiveModel: string | undefined
  if (args.model !== undefined) {
    effectiveModel = args.model
  } else if (routingModel !== undefined) {
    effectiveModel = routingModel
  } else {
    effectiveModel = resolveModel(agent, { complexity: args.complexity })
  }

  // Validate effective model against agent.models when defined.
  if (effectiveModel !== undefined && agent.models !== undefined && agent.models.length > 0) {
    if (!agent.models.includes(effectiveModel)) {
      return {
        output: `acp_delegate failed: model '${effectiveModel}' is not in agent '${agent.id}' models [${agent.models.join(", ")}]`,
        metadata: {
          agentId: agent.id,
          durationMs: 0,
          status: "error" as DelegationStatus,
          errorCode: "EMODEL",
        },
      }
    }
  }

  // Delegate to core runDelegation via the local wrapper.
  const result = await localRunDelegation(agent, {
    prompt: args.prompt,
    includeContext: args.includeContext,
    model: effectiveModel,
    complexity: args.complexity,
  }, ctx, "acp_delegate")

  // Inject routing metadata.
  result.metadata.agentId = agent.id
  if (args.complexity !== undefined) {
    result.metadata.complexity = args.complexity
  } else if (args.agent === undefined) {
    // When agent was auto-selected, echo the effective complexity tier.
    result.metadata.complexity = args.complexity ?? "mid"
  }

  return result
}

function buildUnifiedRoutingBlock(registry: CoreAgentConfig[], routing: RoutingTable | undefined): string {
  const routingDesc = routing && routing.length > 0
    ? `Routing: ${routing.map((r) => `${r.complexity ?? "*"}→${r.agent}${r.model ? `(${r.model})` : ""}`).join(", ")}.`
    : "When 'agent' is omitted, the default agent is used."
  return (
    `<acp-delegate-routing>\n` +
    `You can delegate self-contained tasks to external coding agents via the \`acp_delegate\` tool.\n\n` +
    `- \`acp_delegate\` — Unified delegation tool. Pass \`agent\` to select the target ` +
    `(or omit to auto-route via complexity). Pass \`complexity\` (high|mid|low) to select ` +
    `the right model. ${routingDesc}\n\n` +
    `Each call spawns a fresh subprocess — the prompt must be self-contained, no session memory. ` +
    `Pass file/directory paths via \`includeContext\` to attach contents inline. Reach for delegation ` +
    `when offloading bulk read-only analysis (5+ files), getting an independent second opinion, or ` +
    `fanning out 3+ subtasks in parallel.\n\n` +
    `Skip when: simple grep/search, single-file edits with exact path, multi-turn chains.\n` +
    `</acp-delegate-routing>`
  )
}

// ============================================================================
// Plugin entry point
// ============================================================================

const plugin: Plugin = async (_input: PluginInput, options?: OpencodePluginOptions) => {
  const config = (options ?? {}) as unknown as AcpPluginOptions
  const { agents: registry, injectSystemGuidance, enableUnifiedTool, routing } = resolvePluginOptions(config)

  // Fire-and-forget startup health probe; never blocks plugin load.
  void probeAll(registry)
    .then((health: HealthEntry[]) => setHealthResults(health))
    .catch(() => {})

  const tools: Record<string, ToolDefinition> = {}

  if (enableUnifiedTool) {
    // Unified mode: expose only acp_delegate as the single entry point.
    // Per-agent delegate_to_<id> tools are NOT registered.
    tools["acp_delegate"] = makeUnifiedTool(registry, routing)
  } else {
    // Legacy mode: expose one tool per configured agent.
    for (const agent of registry) {
      const name = `delegate_to_${sanitizeToolSuffix(agent.id)}`
      tools[name] = makeDelegateTool(agent)
    }
  }

  // Optional system-prompt routing block. Off by default — opt in via
  // `injectSystemGuidance: true` in the JSON fallback config.
  const result: Awaited<ReturnType<Plugin>> = { tool: tools }
  if (injectSystemGuidance) {
    const block = enableUnifiedTool
      ? buildUnifiedRoutingBlock(registry, routing)
      : buildRoutingBlock(registry)
    ;(result as Record<string, unknown>)["experimental.chat.system.transform"] = async (
      _input2: unknown,
      output: { system: string[] },
    ): Promise<void> => {
      output.system.push(block)
    }
  }
  return result
}

// OpenCode's V1 plugin loader (packages/opencode/src/plugin/shared.ts#readV1Plugin)
// reads `mod.default` and expects an object with `{ id, server }`. If `default`
// is a function (or absent), the loader falls through to the legacy path which
// throws "Plugin export is not a function" when it iterates non-function exports.
const id = "opencode-acp-delegate"
const server = plugin
export default { id, server }