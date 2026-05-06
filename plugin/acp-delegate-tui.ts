/**
 * opencode-acp-delegate:tui — companion TUI module (single file, install-free)
 *
 * INSTALLATION (file copy):
 *   curl -fsSL https://raw.githubusercontent.com/regaltsui/opencode-acp-delegate/main/plugin/acp-delegate-tui.ts \
 *     -o ~/.opencode/plugins/acp-delegate-tui.ts
 *
 * No `npm install` required. The TUI runtime (@opentui/solid + solid-js) is
 * dynamically imported from opencode's own bundle at load time. Sibling
 * `opentui-shims.d.ts` provides ambient module declarations so `tsc --noEmit`
 * passes without us depending on those packages — opencode satisfies the
 * resolver. If you copy this file standalone into `~/.opencode/plugins/`, no
 * shims are needed at runtime; the shims only matter for development typecheck.
 *
 * READS:  ~/.local/state/opencode/acp-delegate/state.json
 *         (written by the companion server plugin acp-delegate.ts)
 * WRITES: nothing — read-only TUI.
 *
 * Path resolution (must match the server plugin):
 *   1. $OPENCODE_ACP_DELEGATE_STATE_DIR (full path override)
 *   2. $XDG_STATE_HOME/opencode/acp-delegate
 *   3. ~/.local/state/opencode/acp-delegate (default)
 *
 * SOURCE: https://github.com/regaltsui/opencode-acp-delegate
 */

import type {
  TuiPluginApi,
  TuiPluginModule,
  TuiSlotPlugin,
  TuiCommand,
} from "@opencode-ai/plugin/tui"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

interface InflightEntry {
  callId: string
  sessionId: string
  agentId: string
  promptSnippet: string
  startedAt: number
}

interface RecentEntry {
  callId: string
  sessionId: string
  agentId: string
  status: "complete" | "error" | "cancelled"
  promptSnippet: string
  startedAt: number
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

const STATE_DIR_ENV = "OPENCODE_ACP_DELEGATE_STATE_DIR"
const STATE_FILE_NAME = "state.json"

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

function emptyState(): AcpState {
  return {
    version: 1,
    updatedAt: 0,
    pid: 0,
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
      version: 1,
      updatedAt:
        typeof parsed.updatedAt === "number" ? parsed.updatedAt : Date.now(),
      pid: typeof parsed.pid === "number" ? parsed.pid : 0,
      inflight: Array.isArray(parsed.inflight) ? parsed.inflight : [],
      recent: Array.isArray(parsed.recent) ? parsed.recent : [],
      health: Array.isArray(parsed.health) ? parsed.health : [],
    }
  } catch {
    return emptyState()
  }
}

const PLUGIN_ID = "opencode-acp-delegate:tui"
const POLL_IDLE_MS = 1_000
const POLL_ACTIVE_MS = 250
const SNIPPET_MAX_CHARS = 32
const OVERDUE_MS = 60_000
const AGENT_COL_WIDTH = 10

function formatElapsed(seconds: number): string {
  if (seconds < 0) return "0s"
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return s === 0 ? `${m}m` : `${m}m${s}s`
}

function clampSnippet(s: string, max = SNIPPET_MAX_CHARS): string {
  const cleaned = s.replace(/\s+/g, " ").trim()
  if (cleaned.length <= max) return cleaned
  return cleaned.slice(0, max - 1) + "\u2026"
}

function padRight(s: string, width: number): string {
  if (s.length >= width) return s.slice(0, width)
  return s + " ".repeat(width - s.length)
}

const tuiImpl: TuiPluginModule["tui"] = async (api) => {
  const { createElement } = await import("@opentui/solid")
  const { createSignal } = await import("solid-js")

  const [snapshot, setSnapshot] = createSignal<AcpState>(emptyState())
  let timer: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  const tick = async (): Promise<void> => {
    if (disposed) return
    try {
      setSnapshot(await loadState())
    } catch {}
    if (disposed) return
    const interval =
      snapshot().inflight.length > 0 ? POLL_ACTIVE_MS : POLL_IDLE_MS
    timer = setTimeout(() => {
      void tick()
    }, interval)
  }
  void tick()

  const slotPlugin: TuiSlotPlugin = {
    order: 900,
    slots: {
      session_prompt_right(ctx: { theme: { current: any } }) {
        const state = snapshot()
        if (state.inflight.length === 0) return null
        const overdue = state.inflight.some(
          (e) => Date.now() - e.startedAt > OVERDUE_MS,
        )
        const fg = overdue
          ? ctx.theme.current.warning
          : ctx.theme.current.success
        return createElement("text", { fg }, `acp: ${state.inflight.length}`)
      },
      sidebar_content(ctx: { theme: { current: any } }) {
        const state = snapshot()
        if (state.inflight.length === 0) return null
        const theme = ctx.theme.current
        const rows = state.inflight.map((entry) => {
          const elapsedSec = Math.max(
            0,
            Math.floor((Date.now() - entry.startedAt) / 1000),
          )
          const overdue = elapsedSec * 1000 > OVERDUE_MS
          const line = `${padRight(entry.agentId, AGENT_COL_WIDTH)} ${padRight(
            clampSnippet(entry.promptSnippet),
            SNIPPET_MAX_CHARS,
          )} ${formatElapsed(elapsedSec)}`
          return createElement(
            "text",
            { fg: overdue ? theme.warning : theme.text },
            line,
          )
        })
        return createElement(
          "box",
          {
            border: true,
            title: " ACP delegations ",
            borderColor: theme.border,
          },
          rows,
        )
      },
    },
  }
  api.slots.register(slotPlugin)

  const unregisterCommand = api.command.register((): TuiCommand[] => [
    {
      title: "ACP: doctor",
      value: "acp-doctor",
      description: "Check health of registered ACP agents",
      category: "ACP",
      slash: { name: "acp-doctor" },
      onSelect: () => {
        void showDoctorDialog(api)
      },
    },
  ])

  api.lifecycle.onDispose(() => {
    disposed = true
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    try {
      unregisterCommand()
    } catch {}
  })
}

async function showDoctorDialog(api: TuiPluginApi): Promise<void> {
  let state: AcpState
  try {
    state = await loadState()
  } catch {
    state = emptyState()
  }
  const message =
    state.health.length === 0
      ? "No agents registered or probe has not yet run."
      : state.health
          .map((h) => {
            const id = padRight(h.agentId, 12)
            return h.ok
              ? `${id} \u2713  ${h.durationMs}ms`
              : `${id} \u2717  ${h.error ?? "unknown error"}`
          })
          .join("\n")

  api.ui.dialog.replace(() =>
    api.ui.DialogAlert({
      title: "ACP Doctor",
      message,
    }),
  )
}

const plugin: TuiPluginModule = {
  id: PLUGIN_ID,
  tui: tuiImpl,
}

export const id = PLUGIN_ID
export const tui = plugin.tui
export default plugin
