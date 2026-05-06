// Ambient declarations for runtime-only deps used by acp-delegate-tui.ts.
// Both packages are dynamically imported at load time; opencode's own bundle
// provides them. We declare only the subset our code actually touches so
// `tsc --noEmit` passes without us depending on these packages.
//
// Drop-in copies of acp-delegate-tui.ts do NOT need this file at runtime —
// opencode resolves @opentui/solid and solid-js internally. This shim exists
// purely for development typecheck against this repo.

declare module "@opentui/solid" {
  export function createElement(
    tag: string,
    props: Record<string, unknown>,
    ...children: unknown[]
  ): unknown
}

declare module "solid-js" {
  export function createSignal<T>(
    initial: T,
  ): [() => T, (next: T | ((prev: T) => T)) => void]
}
