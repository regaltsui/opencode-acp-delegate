/**
 * Configuration for a single ACP-compatible agent in the registry.
 * Users define one or more agents in opencode.json plugin options.
 */
export interface AgentConfig {
  /** Unique identifier for this agent, used as the agentId tool parameter. */
  id: string
  /** Command and arguments to launch the agent in ACP mode, e.g. ["gemini", "--acp"]. */
  command: string[]
  /** If true, this agent is used when no agentId is specified in the tool call. */
  default?: boolean
  /** Per-agent timeout override in milliseconds. Defaults to DEFAULT_TIMEOUT_MS. */
  timeout?: number
}

/**
 * Shape of the plugin options tuple in opencode.json:
 * ["opencode-acp-delegate", { agents: [...] }]
 */
export interface PluginOptions {
  agents: AgentConfig[]
}

/**
 * Arguments accepted by the agent_delegate tool.
 */
export interface ToolArgs {
  /** The task prompt to send to the agent. Must be self-contained — the agent has no prior context. */
  prompt: string
  /** Which registered agent to use. Omit to use the default agent. */
  agentId?: string
  /** Additional context directories (relative to project cwd) to mention in the prompt preamble. */
  includeContext?: string[]
}

/**
 * Options passed to the ACP client for a single one-shot session.
 */
export interface AcpClientOptions {
  /** Full command array to spawn the agent, e.g. ["gemini", "--acp"]. */
  command: string[]
  /** Working directory for the spawned agent process. */
  cwd: string
  /** Timeout in milliseconds before the session is killed. */
  timeout: number
}

/**
 * Result of a completed one-shot ACP session.
 */
export interface OneShotResult {
  /** The agent's final text response. */
  output: string
  metadata: {
    /** Wall-clock duration from spawn to response, in milliseconds. */
    durationMs: number
    /** ID of the agent that handled this call. */
    agentId: string
    /** Token usage if the agent reported it. */
    tokens?: {
      input: number
      output: number
    }
  }
}

// ---------------------------------------------------------------------------
// Constants — single source of truth. README must derive values from these.
// ---------------------------------------------------------------------------

/** Default per-call timeout: 10 minutes. */
export const DEFAULT_TIMEOUT_MS = 600_000

/** Grace period between SIGTERM and SIGKILL during timeout or close. */
export const GRACE_PERIOD_MS = 5_000

/** Maximum stdout bytes buffered per session before truncation (8 MiB). */
export const MAX_OUTPUT_BYTES = 8 * 1024 * 1024
