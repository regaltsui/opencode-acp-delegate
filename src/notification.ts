import type { OneShotResult } from "./types.js"

export function generateCallId(seq: number): string {
  return `acp-${seq}-${Date.now().toString(36)}`
}

export function buildSuccessNotification(
  id: string,
  result: OneShotResult,
  promptSnippet: string
): string {
  const snippet = promptSnippet.length > 120
    ? promptSnippet.slice(0, 120) + "..."
    : promptSnippet

  const tokenSection = result.metadata.tokens
    ? `<tokens>in:${result.metadata.tokens.input} out:${result.metadata.tokens.output}</tokens>`
    : ""

  return [
    "<acp-delegate-result>",
    `<id>${id}</id>`,
    "<status>complete</status>",
    `<agent>${result.metadata.agentId}</agent>`,
    `<duration>${result.metadata.durationMs}ms</duration>`,
    tokenSection,
    `<response>${escapeXml(result.output)}</response>`,
    `<prompt-snippet>${escapeXml(snippet)}</prompt-snippet>`,
    "</acp-delegate-result>",
  ].filter(Boolean).join("\n")
}

export function buildErrorNotification(
  id: string,
  agentId: string,
  error: Error,
  promptSnippet: string
): string {
  const snippet = promptSnippet.length > 120
    ? promptSnippet.slice(0, 120) + "..."
    : promptSnippet

  return [
    "<acp-delegate-result>",
    `<id>${id}</id>`,
    "<status>error</status>",
    `<agent>${agentId}</agent>`,
    `<error-code>${escapeXml(error.name)}</error-code>`,
    `<error>${escapeXml(error.message)}</error>`,
    `<prompt-snippet>${escapeXml(snippet)}</prompt-snippet>`,
    "</acp-delegate-result>",
  ].join("\n")
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}
