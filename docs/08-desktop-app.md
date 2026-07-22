# 08 — Desktop App

A deliberately simple GUI for people who won't touch a terminal, with a hard
architectural rule: **the desktop app contains no conversion logic**. It bundles the
real CLI binary and shells out to it — the product requirement ("just runs the CLI
behind the scenes") adopted as a guarantee, not a shortcut.

## Stack decision: Tauri v2 + CLI sidecar

| Option | Verdict |
|---|---|
| **Tauri v2, CLI as sidecar** | ✅ Chosen. ~5–10 MB installers, native webview, first-class "sidecar binary" support (bundles our standalone CLI per-platform and exposes spawn with scoped permissions), good auto-update story. |
| Electron | 100+ MB, no benefit for a UI this small. Rejected. |
| Native (Swift/WinUI/GTK ×3) | Triple the work for a UI whose whole job is calling one binary. Rejected. |

The UI layer **reuses the web app's frontend** (same Preact components) with a
different backend adapter: where the web build calls the core in a worker, the
desktop build invokes the sidecar CLI (`demake prep … --json`) and reads its
structured output. One frontend codebase, two adapters, both exercising doc-05's
JSON contract — the desktop app is a permanent integration test of agent-facing
output.

## Scope (v1 — intentionally small)

- Open image (dialog, drag-drop onto window, or "Open with" file association).
- Console picker + the same core options as the web UI; equivalent-command display.
- Preview (rendered from the CLI's PNG output).
- Save PNG / manifest / asm / C / bin; `--format rom` shown when a local or Docker
  toolchain is detected (surfaced exactly as the CLI reports it).
- Batch mode: drop a folder → convert all with current settings (uses one CLI
  invocation per file; progress list with per-file status from JSON output).
- Nothing else. No editing, no library management, no settings sync.

## Packaging & updates

- Targets: macOS (.dmg, universal), Windows (.msi + portable .exe), Linux
  (.AppImage + .deb). Built by the release workflow (doc 11) from the same tag as
  the CLI, embedding that exact CLI build as the sidecar.
- Code signing: macOS notarization + Windows signing keys stored as GH secrets;
  unsigned builds still produced for forks/PRs (CI smoke only).
- Auto-update via Tauri updater fed from GitHub Releases (signature-verified);
  can be disabled at build time for distro packaging.

## Testing

- Playwright/WebDriver E2E on the built app (Linux headless in CI, macOS/Windows in
  the release pipeline): open fixture image → convert for GBC → saved PNG must be
  byte-identical to the CLI's output for the same options (the parity contract,
  enforced end-to-end).
- Sidecar contract tests: every UI control maps to a flag; a generated test walks
  the control schema and asserts the produced command line parses cleanly against
  `cli-spec`.
