/**
 * opencode-acp-delegate — ACP delegation plugin for Opencode
 *
 * Registers one tool per configured ACP agent: `delegate_to_<id>`. Each tool
 * drives a one-shot ACP session via @regaltsui/acp-delegate shared core and
 * returns the agent's final text response synchronously.
 *
 * CONFIGURATION: Provide agents via JSON or as tuple options in opencode.json:
 *   1. Tuple options (GitHub URL install in opencode.json)
 *   2. $OPENCODE_ACP_DELEGATE_CONFIG (path to a JSON file)
 *   3. ~/.config/opencode/acp-delegate.json
 *   4. ~/.opencode/acp-delegate.json
 *
 * Example JSON:
 *   {
 *     "agents": [
 *       { "id": "gemini",   "command": ["gemini", "--acp"] },
 *       { "id": "opencode", "command": ["opencode", "acp"] },
 *       { "id": "claude",   "command": ["npx", "-y", "@agentclientprotocol/claude-agent-acp@latest"] }
 *     ]
 *   }
 *
 * STATE & TELEMETRY: lifecycle events are persisted to
 *   $XDG_STATE_HOME/opencode/acp-delegate/state.json (inflight + recent + health)
 *   $XDG_STATE_HOME/opencode/acp-delegate/usage.jsonl (per-call audit, rotates at 5 MiB)
 * Health probes fire once at plugin load (best-effort, non-blocking).
 *
 * SOURCE: https://github.com/regaltsui/opencode-acp-delegate
 */

import {
  type Plugin,
  type PluginInput,
  type PluginOptions as OpencodePluginOptions,
  type ToolContext,
  type ToolDefinition,
  tool,
} from "@opencode-ai/plugin"
import {
  type AgentConfig,
  type AcpPluginOptions,
  type HealthEntry,
  type HostAdapter,
  OPENCODE_NAMESPACE,
  INCLUDE_CONTEXT_TOTAL_BUDGET_BYTES,
  INCLUDE_CONTEXT_PER_FILE_BUDGET_BYTES,
  readFallbackConfig,
  validateAgent,
  missingAgentsMessage,
  probeAll,
  recordHealth,
  sanitizeToolSuffix,
  describeAgent,
  buildRoutingBlock,
  runDelegation,
} from "@regaltsui/acp-delegate"

const z = tool.schema

// ============================================================================
// Config resolution — tuple options first, JSON file fallback
// ============================================================================

const DEFAULT_TIMEOUT_MS = 600_000
const GRACE_PERIOD_MS = 5_000
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024
const STDERR_BUFFER_BYTES = 64 * 1024
const ACP_PROTOCOL_VERSION = 1
const SESSION_CLOSE_TIMEOUT_MS = 1_000
const HEALTH_PROBE_TIMEOUT_MS = 5_000
const STATE_RECENT_MAX = 20
const STATE_FILE_VERSION = 1
const INCLUDE_CONTEXT_PER_FILE_BUDGET_BYTES = 64 * 1024
const INCLUDE_CONTEXT_TOTAL_BUDGET_BYTES = 256 * 1024
const USAGE_LOG_MAX_BYTES = 5 * 1024 * 1024
const PROMPT_SNIPPET_MAX = 80
const TITLE_PROMPT_MAX = 60

// ============================================================================
// Types
// ============================================================================

interface AgentConfig {
  id: string
  command: string[]
  default?: boolean
  timeout?: number
  label?: string
  description?: string
  whenToUse?: string
  models?: string[]
  defaultModel?: string
  complexityModels?: { high?: string; mid?: string; low?: string }
  modelFlag?: string
  autoApprove?: boolean
}

type ComplexityTier = "high" | "mid" | "low"

interface RoutingEntry {
  /** Agent id — must exist in the agents array. */
  agent: string
  /** Model id passed to the agent. If omitted, the agent's defaultModel or complexityModels[level] is used. */
  model?: string
  /** Complexity tier this entry matches. If omitted, this entry matches any complexity (used as a fallback). */
  complexity?: ComplexityTier
}

type RoutingTable = RoutingEntry[]

interface AcpPluginOptions {
  agents: AgentConfig[]
  injectSystemGuidance?: boolean
  enableUnifiedTool?: boolean
  routing?: RoutingTable
}

type AcpStopReason =
  | "end_turn"
  | "max_tokens"
  | "max_turn_requests"
  | "refusal"
  | "cancelled"

type DelegationStatus = "complete" | "error" | "cancelled"

interface AcpClientOptions {
  command: string[]
  cwd: string
  timeout: number
  signal?: AbortSignal
  autoApprove: boolean
}

interface OneShotResult {
  output: string
  metadata: {
    durationMs: number
    agentId: string
    stopReason?: AcpStopReason
  }
}

interface InflightEntry {
  callId: string
  sessionId: string
  agentId: string
  promptSnippet: string
  startedAt: number
}

interface RecentEntry extends InflightEntry {
  status: DelegationStatus
  endedAt: number
  durationMs: number
  errorCode?: string
}

interface HealthEntry {
  agentId: string
  ok: boolean
  durationMs: number
  checkedAt: number
  error?: string
}

interface AcpState {
  version: 1
  updatedAt: number
  pid: number
  inflight: InflightEntry[]
  recent: RecentEntry[]
  health: HealthEntry[]
}

interface UsageEntry {
  ts: number
  callId: string
  sessionId: string
  agentId: string
  status: DelegationStatus
  durationMs: number
  promptBytes: number
  outputBytes: number
  errorCode?: string
  stopReason?: string
}

// ============================================================================
// Agent registry — JSON fallback config (drop-in path can't receive tuple opts)
// ============================================================================

const MISSING_AGENTS_MESSAGE =
  'Plugin options must include a non-empty \'agents\' array, or set OPENCODE_ACP_DELEGATE_CONFIG / drop a JSON file at ~/.config/opencode/acp-delegate.json. Example: { "agents": [{ "id": "gemini", "command": ["gemini", "--acp"] }] }'

const CONFIG_ENV_VAR = "OPENCODE_ACP_DELEGATE_CONFIG"

function fallbackConfigPaths(): string[] {
  const paths: string[] = []
  const fromEnv = process.env[CONFIG_ENV_VAR]
  if (fromEnv && fromEnv.length > 0) paths.push(fromEnv)
  paths.push(join(homedir(), ".config", "opencode", "acp-delegate.json"))
  paths.push(join(homedir(), ".opencode", "acp-delegate.json"))
  return paths
}

function readFallbackConfig(): AcpPluginOptions | null {
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
    if (typeof candidate.command[j] !== "string") {
      throw new Error(`Agent config at index ${index} is invalid: command[${j}] must be a string`)
    }
  }
  if (candidate.label !== undefined && typeof candidate.label !== "string") {
    throw new Error(`Agent config at index ${index} is invalid: 'label' must be a string when provided`)
  }
  if (candidate.description !== undefined && typeof candidate.description !== "string") {
    throw new Error(`Agent config at index ${index} is invalid: 'description' must be a string when provided`)
  }
  if (candidate.whenToUse !== undefined && typeof candidate.whenToUse !== "string") {
    throw new Error(`Agent config at index ${index} is invalid: 'whenToUse' must be a string when provided`)
  }
  if (candidate.modelFlag !== undefined) {
    if (typeof candidate.modelFlag !== "string" || candidate.modelFlag.length === 0) {
      throw new Error(`Agent config at index ${index} is invalid: 'modelFlag' must be a non-empty string when provided`)
    }
  }
  if (candidate.models !== undefined) {
    if (!Array.isArray(candidate.models) || candidate.models.length === 0) {
      throw new Error(`Agent config at index ${index} is invalid: 'models' must be a non-empty string array when provided`)
    }
    for (let j = 0; j < candidate.models.length; j++) {
      const m = candidate.models[j]
      if (typeof m !== "string" || m.length === 0) {
        throw new Error(`Agent config at index ${index} is invalid: models[${j}] must be a non-empty string`)
      }
    }
    const seen = new Set<string>()
    for (const m of candidate.models) {
      if (seen.has(m)) {
        throw new Error(`Agent config at index ${index} is invalid: models contains duplicate '${m}'`)
      }
      seen.add(m)
    }
  }
  if (candidate.defaultModel !== undefined) {
    if (typeof candidate.defaultModel !== "string" || candidate.defaultModel.length === 0) {
      throw new Error(`Agent config at index ${index} is invalid: 'defaultModel' must be a non-empty string when provided`)
    }
    if (Array.isArray(candidate.models) && candidate.models.length > 0) {
      if (!candidate.models.includes(candidate.defaultModel)) {
        throw new Error(
          `Agent config at index ${index} is invalid: defaultModel '${candidate.defaultModel}' is not in models [${candidate.models.join(", ")}]`,
        )
      }
    }
  }
  if (candidate.complexityModels !== undefined) {
    if (typeof candidate.complexityModels !== "object" || candidate.complexityModels === null || Array.isArray(candidate.complexityModels)) {
      throw new Error(`Agent config at index ${index} is invalid: 'complexityModels' must be an object when provided`)
    }
    const validTiers = new Set<string>(["high", "mid", "low"])
    for (const key of Object.keys(candidate.complexityModels)) {
      if (!validTiers.has(key)) {
        throw new Error(`Agent config at index ${index} is invalid: complexityModels has unknown key '${key}' (allowed: high, mid, low)`)
      }
      const val = (candidate.complexityModels as Record<string, unknown>)[key]
      if (val !== undefined) {
        if (typeof val !== "string" || val.length === 0) {
          throw new Error(`Agent config at index ${index} is invalid: complexityModels.${key} must be a non-empty string when provided`)
        }
        if (Array.isArray(candidate.models) && candidate.models.length > 0 && !candidate.models.includes(val as string)) {
          throw new Error(`Agent config at index ${index} is invalid: complexityModels.${key} '${val}' is not in models [${candidate.models.join(", ")}]`)
        }
      }
    }
  }
  if (candidate.autoApprove !== undefined && typeof candidate.autoApprove !== "boolean") {
    throw new Error(`Agent config at index ${index} is invalid: 'autoApprove' must be a boolean when provided`)
  }
  return {
    id: candidate.id,
    command: candidate.command as string[],
    default: candidate.default,
    timeout: candidate.timeout ?? DEFAULT_TIMEOUT_MS,
    autoApprove: candidate.autoApprove ?? true,
    ...(candidate.label !== undefined ? { label: candidate.label } : {}),
    ...(candidate.description !== undefined ? { description: candidate.description } : {}),
    ...(candidate.whenToUse !== undefined ? { whenToUse: candidate.whenToUse } : {}),
    ...(candidate.models !== undefined ? { models: [...candidate.models] } : {}),
    ...(candidate.defaultModel !== undefined ? { defaultModel: candidate.defaultModel } : {}),
    ...(candidate.complexityModels !== undefined ? { complexityModels: { ...candidate.complexityModels } } : {}),
    ...(candidate.modelFlag !== undefined ? { modelFlag: candidate.modelFlag } : {}),
  }
}

function resolvePluginOptions(opts: AcpPluginOptions): {
  agents: AgentConfig[]
  injectSystemGuidance: boolean
  enableUnifiedTool: boolean
  routing: RoutingTable | undefined
} {
  let source: AcpPluginOptions | null =
    opts && Array.isArray(opts.agents) && opts.agents.length > 0 ? opts : null
  if (!source) {
    source = readFallbackConfig(OPENCODE_NAMESPACE)
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
// Tool arg schemas
// ============================================================================

const STATE_DIR_ENV = "OPENCODE_ACP_DELEGATE_STATE_DIR"
const STATE_FILE_NAME = "state.json"
const USAGE_LOG_NAME = "usage.jsonl"

function getStateDir(): string {
  const explicit = process.env[STATE_DIR_ENV]
  if (explicit && explicit.length > 0) return explicit
  const xdg = process.env["XDG_STATE_HOME"]
  if (xdg && xdg.length > 0) return join(xdg, "opencode", "acp-delegate")
  return join(homedir(), ".local", "state", "opencode", "acp-delegate")
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
    `${STATE_FILE_NAME}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`,
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

async function recordInflight(entry: InflightEntry): Promise<void> {
  return enqueue(async () => {
    const state = await loadState()
    state.inflight = state.inflight.filter((e) => e.callId !== entry.callId)
    state.inflight.push(entry)
    await saveStateAtomic(state)
  })
}

async function resolveInflight(
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

async function appendUsage(entry: UsageEntry): Promise<void> {
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

class AcpError extends Error {
  readonly code?: string
  readonly stderr?: string
  constructor(message: string, code?: string, stderr?: string) {
    super(message)
    this.name = "AcpError"
    this.code = code
    this.stderr = stderr
  }
}

class AcpTimeoutError extends AcpError {
  readonly agentId: string
  readonly timeoutMs: number
  constructor(agentId: string, timeoutMs: number, stderr?: string) {
    super(`Agent ${agentId} timed out after ${timeoutMs}ms`, "ETIMEDOUT", stderr)
    this.name = "AcpTimeoutError"
    this.agentId = agentId
    this.timeoutMs = timeoutMs
  }
}

class AcpAbortError extends AcpError {
  constructor(stderr?: string) {
    super("Delegation aborted", "ECANCELLED", stderr)
    this.name = "AcpAbortError"
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
    let msg: JsonRpcMessage
    try {
      msg = JSON.parse(trimmed) as JsonRpcMessage
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
// Health probe — fired (not awaited) at plugin load
// ============================================================================

async function probeAgent(agent: AgentConfig): Promise<HealthEntry> {
  const startMs = Date.now()
  const binary = agent.command[0]
  if (!binary) {
    return {
      agentId: agent.id,
      ok: false,
      durationMs: 0,
      checkedAt: Date.now(),
      error: "command must have at least one element",
    }
  }
  let child: ChildProcessWithoutNullStreams
  try {
    child = spawn(binary, agent.command.slice(1), { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] })
  } catch (e) {
    const err = e as NodeJS.ErrnoException
    return {
      agentId: agent.id,
      ok: false,
      durationMs: Date.now() - startMs,
      checkedAt: Date.now(),
      error: err.code === "ENOENT" ? `Agent binary not found: ${binary}` : err.message,
    }
  }
  child.stderr.on("data", () => {})
  child.on("error", () => {})

  let nextId = 0
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>()
  const rl = createInterface({ input: child.stdout })
  rl.on("line", (line: string) => {
    if (!line.trim()) return
    try {
      const m = JSON.parse(line.trim()) as JsonRpcMessage
      if (typeof m.id === "number" && pending.has(m.id)) {
        const handler = pending.get(m.id)!
        pending.delete(m.id)
        if (m.error) handler.reject(new Error(m.error.message ?? "agent error"))
        else handler.resolve(m.result)
      }
    } catch {}
  })

  const send = (method: string, params: unknown): Promise<unknown> => {
    const id = ++nextId
    return new Promise((res, rej) => {
      pending.set(id, { resolve: res, reject: rej })
      try { child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n") } catch (e) {
        pending.delete(id)
        rej(e)
      }
    })
  }

  const timeoutPromise = new Promise<never>((_, rej) =>
    setTimeout(() => rej(new Error(`Probe timed out after ${HEALTH_PROBE_TIMEOUT_MS}ms`)), HEALTH_PROBE_TIMEOUT_MS).unref(),
  )

  try {
    await Promise.race([
      send("initialize", { protocolVersion: ACP_PROTOCOL_VERSION, clientCapabilities: {} }),
      timeoutPromise,
    ])
    return {
      agentId: agent.id,
      ok: true,
      durationMs: Date.now() - startMs,
      checkedAt: Date.now(),
    }
  } catch (e) {
    return {
      agentId: agent.id,
      ok: false,
      durationMs: Date.now() - startMs,
      checkedAt: Date.now(),
      error: (e as Error).message ?? String(e),
    }
  } finally {
    rl.close()
    try { if (!child.killed) child.kill("SIGTERM") } catch {}
    setTimeout(() => { try { if (!child.killed) child.kill("SIGKILL") } catch {} }, 1_000).unref()
  }
}

async function probeAll(registry: AgentConfig[]): Promise<HealthEntry[]> {
  if (registry.length === 0) return []
  return Promise.all(registry.map((agent) => probeAgent(agent)))
}

// ============================================================================
// includeContext — eager bounded preamble
// ============================================================================

interface PreambleBlock {
  path: string
  status: "ok" | "skipped"
  reason?: string
  content?: string
  bytes: number
  truncated: boolean
}

function looksBinary(buf: Buffer): boolean {
  const limit = Math.min(buf.length, 8192)
  for (let i = 0; i < limit; i++) if (buf[i] === 0) return true
  return false
}

async function expandSinglePath(
  cwdAbs: string,
  rel: string,
  remainingBudget: number,
): Promise<PreambleBlock[]> {
  const requested = isAbsolute(rel) ? rel : resolvePath(cwdAbs, rel)
  const target = resolvePath(requested)
  if (target !== cwdAbs && !isPathInside(target, cwdAbs)) {
    return [{ path: rel, status: "skipped", reason: "outside project directory", bytes: 0, truncated: false }]
  }
  let info
  try {
    info = await stat(target)
  } catch (e) {
    const err = e as NodeJS.ErrnoException
    return [{ path: rel, status: "skipped", reason: err.code ?? err.message, bytes: 0, truncated: false }]
  }
  if (info.isDirectory()) {
    const { readdir } = await import("node:fs/promises")
    let entries: string[]
    try {
      entries = await readdir(target)
    } catch (e) {
      const err = e as NodeJS.ErrnoException
      return [{ path: rel, status: "skipped", reason: err.code ?? err.message, bytes: 0, truncated: false }]
    }
    entries.sort()
    const blocks: PreambleBlock[] = []
    let budget = remainingBudget
    for (const entry of entries) {
      if (budget <= 0) {
        blocks.push({ path: `${rel}/${entry}`, status: "skipped", reason: "total budget exhausted", bytes: 0, truncated: false })
        continue
      }
      const childBlocks = await expandSinglePath(cwdAbs, `${rel}/${entry}`, budget)
      for (const b of childBlocks) {
        blocks.push(b)
        budget -= b.bytes
      }
    }
    return blocks
  }
  if (!info.isFile()) {
    return [{ path: rel, status: "skipped", reason: "not a regular file", bytes: 0, truncated: false }]
  }
  if (remainingBudget <= 0) {
    return [{ path: rel, status: "skipped", reason: "total budget exhausted", bytes: 0, truncated: false }]
  }
  let raw: Buffer
  try {
    raw = await readFile(target)
  } catch (e) {
    const err = e as NodeJS.ErrnoException
    return [{ path: rel, status: "skipped", reason: err.code ?? err.message, bytes: 0, truncated: false }]
  }
  if (looksBinary(raw)) {
    return [{ path: rel, status: "skipped", reason: "binary file", bytes: 0, truncated: false }]
  }
  const perFileCap = Math.min(INCLUDE_CONTEXT_PER_FILE_BUDGET_BYTES, remainingBudget)
  const truncated = raw.length > perFileCap
  const sliced = truncated ? raw.subarray(0, perFileCap) : raw
  return [{ path: rel, status: "ok", content: sliced.toString("utf8"), bytes: sliced.length, truncated }]
}

async function buildContextPreamble(cwd: string, paths: string[]): Promise<string> {
  if (paths.length === 0) return ""
  const cwdAbs = resolvePath(cwd)
  const blocks: PreambleBlock[] = []
  let totalBudget = INCLUDE_CONTEXT_TOTAL_BUDGET_BYTES
  for (const p of paths) {
    if (totalBudget <= 0) {
      blocks.push({ path: p, status: "skipped", reason: "total budget exhausted", bytes: 0, truncated: false })
      continue
    }
    const expanded = await expandSinglePath(cwdAbs, p, totalBudget)
    for (const b of expanded) {
      blocks.push(b)
      totalBudget -= b.bytes
    }
  }
  const parts: string[] = []
  for (const b of blocks) {
    if (b.status === "ok" && b.content !== undefined) {
      const trunc = b.truncated ? ' truncated="true"' : ""
      parts.push(`<context path="${b.path}"${trunc}>\n${b.content}\n</context>`)
    } else {
      parts.push(`<context path="${b.path}" skipped="true" reason="${b.reason ?? "unknown"}"/>`)
    }
  }
  return parts.join("\n") + "\n\n"
}

// ============================================================================
// Plugin entry — one tool per registered agent + state-file integration
// ============================================================================

function sanitizeToolSuffix(id: string): string {
  return id.replace(/[^a-zA-Z0-9_]/g, "_")
}

function describeAgentFooter(agent: AgentConfig): string {
  return (
    `\n\nThe agent has no prior context — include all goals, constraints, and the desired output ` +
    `format inline. It can read files within the project directory (read-only); it cannot write ` +
    `or run shell commands. Pass relative file or directory paths via 'includeContext' to attach ` +
    `their contents inline (capped at ${INCLUDE_CONTEXT_TOTAL_BUDGET_BYTES / 1024} KiB total, ` +
    `${INCLUDE_CONTEXT_PER_FILE_BUDGET_BYTES / 1024} KiB per file). Returns the agent's final text ` +
    `response synchronously, with a [delegate_to_${agent.id}: …] trailer if the response was ` +
    `truncated by the agent's own token limit.`
  )
}

function describeAgent(agent: AgentConfig): string {
  if (agent.description !== undefined && agent.description.length > 0) {
    return agent.description + describeAgentFooter(agent)
  }
  const label = agent.label ?? agent.id
  return (
    `Delegate a self-contained task to the '${label}' coding agent (separate process, fresh session). ` +
    `Useful when you want a second opinion from a different model family, when offloading bulk read-only ` +
    `analysis across many files, or when fanning out 3+ independent subtasks in parallel.` +
    describeAgentFooter(agent)
  )
}

function summarizeAgent(agent: AgentConfig): string {
  if (agent.whenToUse !== undefined && agent.whenToUse.length > 0) return agent.whenToUse
  if (agent.description !== undefined && agent.description.length > 0) {
    const firstSentence = agent.description.split(/(?<=[.!?])\s+/, 1)[0] ?? agent.description
    return firstSentence
  }
  const label = agent.label ?? agent.id
  return `Delegate to '${label}' for a second opinion or bulk read-only analysis.`
}

function buildRoutingBlock(registry: AgentConfig[]): string {
  const lines = registry.map((a) => {
    const toolName = `delegate_to_${sanitizeToolSuffix(a.id)}`
    return `- \`${toolName}\` — ${summarizeAgent(a)}`
  })
  return (
    `<acp-delegate-routing>\n` +
    `You can delegate self-contained tasks to one of these external coding agents:\n\n` +
    lines.join("\n") +
    `\n\nEach call spawns a fresh subprocess — the prompt must be self-contained, no session memory. ` +
    `Pass file/directory paths via \`includeContext\` to attach contents inline. Reach for delegation ` +
    `when offloading bulk read-only analysis (5+ files), getting an independent second opinion, or ` +
    `fanning out 3+ subtasks in parallel.\n\n` +
    `Skip when: simple grep/search, single-file edits with exact path, multi-turn chains.\n` +
    `</acp-delegate-routing>`
  )
}

function buildSpawnCommand(agent: AgentConfig, requestedModel: string | undefined): string[] {
  const chosen = requestedModel ?? agent.defaultModel
  if (chosen === undefined) return [...agent.command]
  const flag = agent.modelFlag ?? "--model"
  return [...agent.command, flag, chosen]
}

function resolveEffectiveModel(
  agent: AgentConfig,
  opts: { model?: string; complexity?: ComplexityTier },
): string | undefined {
  // Explicit model takes precedence.
  if (opts.model !== undefined) return opts.model
  // Complexity tier maps to a model via complexityModels.
  if (opts.complexity !== undefined && agent.complexityModels !== undefined) {
    const tier = agent.complexityModels[opts.complexity]
    if (tier !== undefined) return tier
  }
  // Fall back to agent defaultModel, or undefined (agent's built-in default).
  return agent.defaultModel
}

// ============================================================================
// resolveRoute — when agent is omitted, look up routing table for the
// effective complexity tier.  Falls back to the agent marked default:true
// or agents[0].
// ============================================================================

function resolveRoute(
  routing: RoutingTable | undefined,
  agents: AgentConfig[],
  complexity: ComplexityTier | undefined,
): { agent: AgentConfig; model: string | undefined } {
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
  // Return model: undefined so resolveEffectiveModel handles complexityModels.
  const fallback = agents.find((a) => a.default) ?? agents[0]
  return { agent: fallback, model: undefined }
}

function snippet(prompt: string, max: number): string {
  const cleaned = prompt.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim()
  return cleaned.length <= max ? cleaned : cleaned.slice(0, max - 1) + "\u2026"
}

function applyStopReasonTrailer(
  toolPrefix: string,
  output: string,
  stopReason: AcpStopReason | undefined,
  durationMs: number,
): { output: string; status: DelegationStatus } {
  if (stopReason === undefined || stopReason === "end_turn") return { output, status: "complete" }
  if (stopReason === "refusal") {
    const reason = output.trim().length > 0 ? output.trim() : "no reason given"
    return { output: `${toolPrefix} refused: ${reason}`, status: "error" }
  }
  if (stopReason === "cancelled") {
    return { output: `${toolPrefix} cancelled by agent.`, status: "cancelled" }
  }
  const trailer = `\n\n[${toolPrefix}: stopReason=${stopReason}, durationMs=${durationMs}]`
  return { output: output + trailer, status: "complete" }
}

interface ExecuteOutcome {
  output: string
  status: DelegationStatus
  stopReason?: AcpStopReason
  errorCode?: string
  durationMs: number
  outputBytes: number
}

async function runDelegation(
  agent: AgentConfig,
  args: { prompt: string; includeContext?: string[]; model?: string },
  ctx: {
    sessionID?: string
    directory: string
    abort?: AbortSignal
    metadata: (input: { title?: string; metadata?: Record<string, unknown> }) => void
  },
  toolPrefix?: string,
): Promise<{ output: string; metadata: Record<string, unknown> }> {
  const prefix = toolPrefix ?? `delegate_to_${agent.id}`
  const startedAt = Date.now()
  const callId = randomUUID()
  const sessionIdShort = String(ctx.sessionID ?? "").slice(0, 6)
  const promptSnippet = snippet(args.prompt, PROMPT_SNIPPET_MAX)

  ctx.metadata({ title: `[${agent.id}] ${snippet(args.prompt, TITLE_PROMPT_MAX)}` })

  void recordInflight({
    callId,
    sessionId: sessionIdShort,
    agentId: agent.id,
    promptSnippet,
    startedAt,
  }).catch(() => {})

  const finalize = (outcome: ExecuteOutcome): { output: string; metadata: Record<string, unknown> } => {
    const endedAt = Date.now()
    void resolveInflight(callId, {
      status: outcome.status,
      endedAt,
      durationMs: outcome.durationMs,
      ...(outcome.errorCode !== undefined ? { errorCode: outcome.errorCode } : {}),
    }).catch(() => {})
    const usage: UsageEntry = {
      ts: endedAt,
      callId,
      sessionId: sessionIdShort,
      agentId: agent.id,
      status: outcome.status,
      durationMs: outcome.durationMs,
      promptBytes: Buffer.byteLength(args.prompt, "utf8"),
      outputBytes: outcome.outputBytes,
      ...(outcome.errorCode !== undefined ? { errorCode: outcome.errorCode } : {}),
      ...(outcome.stopReason !== undefined ? { stopReason: outcome.stopReason } : {}),
    }
    void appendUsage(usage).catch(() => {})
    return {
      output: outcome.output,
      metadata: {
        agentId: agent.id,
        durationMs: outcome.durationMs,
        status: outcome.status,
        ...(outcome.stopReason !== undefined ? { stopReason: outcome.stopReason } : {}),
        ...(outcome.errorCode !== undefined ? { errorCode: outcome.errorCode } : {}),
        ...(args.model !== undefined ? { model: args.model } : {}),
      },
    }
  }

  try {
    const preamble = args.includeContext && args.includeContext.length > 0
      ? await buildContextPreamble(ctx.directory, args.includeContext)
      : ""
    const fullPrompt = preamble + args.prompt
    const command = buildSpawnCommand(agent, args.model)

    const result = await runOneShotSession(
      {
        command,
        cwd: ctx.directory,
        timeout: agent.timeout ?? DEFAULT_TIMEOUT_MS,
        signal: ctx.abort,
        autoApprove: agent.autoApprove ?? true,
      },
      fullPrompt,
    )
    const durationMs = result.metadata.durationMs
    const { output, status } = applyStopReasonTrailer(
      prefix,
      result.output,
      result.metadata.stopReason,
      durationMs,
    )
    return finalize({
      output,
      status,
      stopReason: result.metadata.stopReason,
      durationMs,
      outputBytes: Buffer.byteLength(output, "utf8"),
    })
  } catch (err) {
    const durationMs = Date.now() - startedAt
    if (err instanceof AcpAbortError) {
      const output = `${prefix} cancelled.`
      return finalize({
        output,
        status: "cancelled",
        errorCode: err.code ?? "ECANCELLED",
        durationMs,
        outputBytes: Buffer.byteLength(output, "utf8"),
      })
    }
    const e = err instanceof AcpError ? err : new AcpError(String(err))
    const stderrTail = e.stderr ? `\n--- agent stderr (tail) ---\n${e.stderr}` : ""
    const output = `${prefix} failed (${e.code ?? e.name}): ${e.message}${stderrTail}`
    return finalize({
      output,
      status: "error",
      errorCode: e.code ?? e.name,
      durationMs,
      outputBytes: Buffer.byteLength(output, "utf8"),
    })
  }
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

function makeDelegateTool(agent: AgentConfig): ToolDefinition {
  const makeHost = (ctx: ToolContext): HostAdapter => ({
    getDirectory: (_args?: { directoryArg?: string }) => ctx.directory,
    getSessionId: () => ctx.sessionID.slice(0, 6),
    getAbortSignal: () => ctx.abort,
    reportProgress: (m) =>
      ctx.metadata(m as { title?: string; metadata?: Record<string, unknown> }),
    namespace: OPENCODE_NAMESPACE,
  })

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
        const effectiveModel = resolveEffectiveModel(agent, { model: args.model, complexity: args.complexity })
        const result = await runDelegation(agent, { prompt: args.prompt, includeContext: args.includeContext, model: effectiveModel }, makeHost(ctx))
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
      execute: async (args, ctx) => runDelegation(agent, args, makeHost(ctx)),
    })
  }

  // Complexity only, no explicit models list
  if (complexityArg !== undefined) {
    return tool({
      description: describeAgent(agent),
      args: { prompt: PROMPT_ARG, includeContext: INCLUDE_CONTEXT_ARG, complexity: complexityArg },
      execute: async (rawArgs, ctx) => {
        const args = rawArgs as { prompt: string; includeContext?: string[]; complexity?: ComplexityTier }
        const effectiveModel = resolveEffectiveModel(agent, { complexity: args.complexity })
        const result = await runDelegation(agent, { prompt: args.prompt, includeContext: args.includeContext, model: effectiveModel }, makeHost(ctx))
        if (args.complexity !== undefined) result.metadata.complexity = args.complexity
        return result
      },
    })
  }

  // Neither models nor complexity — basic tool
  return tool({
    description: describeAgent(agent),
    args: { prompt: PROMPT_ARG, includeContext: INCLUDE_CONTEXT_ARG },
    execute: async (args, ctx) => runDelegation(agent, args, makeHost(ctx)),
  })
}

// ============================================================================
// Unified tool factory — single `acp_delegate` tool that routes by agent id
// ============================================================================

function describeUnifiedTool(registry: AgentConfig[], routing: RoutingTable | undefined): string {
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

function makeUnifiedTool(registry: AgentConfig[], routing: RoutingTable | undefined): ToolDefinition {
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
  agentMap: Map<string, AgentConfig>,
  registry: AgentConfig[],
  routing: RoutingTable | undefined,
  args: { prompt: string; agent?: string; model?: string; complexity?: ComplexityTier; includeContext?: string[] },
  ctx: {
    sessionID?: string
    directory: string
    abort?: AbortSignal
    metadata: (input: { title?: string; metadata?: Record<string, unknown> }) => void
  },
): Promise<{ output: string; metadata: Record<string, unknown> }> {
  // Resolve agent: explicit > routing table > default.
  let agent: AgentConfig
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
    effectiveModel = resolveEffectiveModel(agent, { complexity: args.complexity })
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

  // Delegate to runDelegation with the resolved model.
  const result = await runDelegation(agent, {
    prompt: args.prompt,
    includeContext: args.includeContext,
    model: effectiveModel,
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

// ============================================================================
// Plugin entry point
// ============================================================================

const plugin: Plugin = async (_input: PluginInput, options?: OpencodePluginOptions) => {
  const config = (options ?? {}) as unknown as AcpPluginOptions
  const { agents: registry, injectSystemGuidance, enableUnifiedTool, routing } = resolvePluginOptions(config)

  // Fire-and-forget startup health probe; never blocks plugin load.
  void probeAll(registry)
    .then((health: HealthEntry[]) => recordHealth(OPENCODE_NAMESPACE, health).catch(() => {}))
    .catch(() => {})

  const tools: Record<string, ToolDefinition> = {}
  for (const agent of registry) {
    const name = `delegate_to_${sanitizeToolSuffix(agent.id)}`
    tools[name] = makeDelegateTool(agent)
  }

  // Register the unified acp_delegate tool when opted in.
  if (enableUnifiedTool) {
    tools["acp_delegate"] = makeUnifiedTool(registry, routing)
  }

  // Optional system-prompt routing block. Off by default — opt in via
  // `injectSystemGuidance: true` in the JSON fallback config.
  const result: Awaited<ReturnType<Plugin>> = { tool: tools }
  if (injectSystemGuidance) {
    let block = buildRoutingBlock(registry)
    if (enableUnifiedTool) {
      // Append unified tool entry to the routing block.
      const routingDesc = routing && routing.length > 0
        ? `Routing: ${routing.map((r) => `${r.complexity ?? "*"}→${r.agent}${r.model ? `(${r.model})` : ""}`).join(", ")}.`
        : "When 'agent' is omitted, the default agent is used."
      const unifiedEntry =
        `\n- \`acp_delegate\` — Unified delegation tool. Pass \`agent\` to select the target ` +
        `(or omit to auto-route via complexity). Pass \`complexity\` (high|mid|low) to select ` +
        `the right model. ${routingDesc} ` +
        `Use when you don't want to think about which delegate_to_<id> tool to call.`
      block = block.replace(
        "</acp-delegate-routing>",
        unifiedEntry + "\n</acp-delegate-routing>"
      )
    }
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
