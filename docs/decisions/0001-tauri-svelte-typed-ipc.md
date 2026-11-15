# 0001: Tauri 2 + Svelte 5 + TypeScript, typed IPC with tauri-specta

**Status:** accepted (2026-11-13). Details: #9, #16, #18, #19.

## Context
kubeloupe is a Lens-style Kubernetes IDE. The UI needs widgets the web already
has in mature form: a terminal (xterm.js), a code editor with diffs
(CodeMirror), virtualized tables with 10k+ live rows, charts, a command palette.
All Kubernetes logic should be shared with the CLI.

## Decision
- **Tauri 2**: a Rust process with the OS web view (WebKitGTK, WebView2,
  WKWebView) as its screen. Kubernetes work lives in the core library (`src/`),
  Tauri commands are thin wrappers.
- **Svelte 5 + Vite + TypeScript** for the UI (fine-grained reactivity suits
  live watch diffs; small runtime). Large collections in `$state.raw`/`Map`.
- **tauri-specta** generates `bindings.ts` from the Rust command and event
  types; CI fails if it is stale.

Rejected: vanilla JS (hand-written DOM updates break under live data),
React (heavier, more care for per-event re-renders), SolidJS (smaller
ecosystem), Leptos/Dioxus (younger, still need JS for terminal/editor),
native Rust GUIs (would mean building the terminal, editor and tables), Electron
(ships its own Chromium + Node: large and memory hungry).

## Consequences
- Three different web engines: real-app QA must run in WebKitGTK (and ideally
  WebView2/WKWebView), not just Chromium (see 0002).
- Two toolchains (Rust + Node).
- Data crossing the boundary is serialized: keep payloads to summaries,
  batches and diffs; streaming over Tauri channels and raw bytes for bulk data
  is tracked in #115.
