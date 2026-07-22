#!/bin/bash
# SessionStart hook: make `demake` buildable, testable, and ROM-capable in
# managed / Claude Code on the web sessions (doc 06 §ROM building, doc 10).
#
# Idempotent and non-interactive. Runs only in remote sessions; local dev is
# expected to run `pnpm install` / `pnpm toolchains` on demand.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-.}"

# --- Node workspace: deps + build (cached after first run) -------------------
corepack enable 2>/dev/null || true
pnpm install --frozen-lockfile || pnpm install
pnpm build

# --- RGBDS toolchain for `demake gen --format rom` + the emulator E2E --------
# Best-effort: a missing assembler must not block the session (gen still emits
# bin/asm/c; only --format rom needs it).
bash tools/toolchains/install-rgbds.sh || true

# --- SameBoy headless capturer for the pixel-perfect E2E (doc 10) ------------
# Also best-effort; the emulator E2E test self-skips if it is absent.
bash tools/toolchains/install-sameboy.sh || true

# Persist the toolchain on PATH for the whole session, even if /usr/local/bin
# was not writable when the installer ran.
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  RGBDS_BIN="${HOME}/.cache/demake/toolchains/rgbds-${RGBDS_VERSION:-0.8.0}/bin"
  [ -d "$RGBDS_BIN" ] && echo "export PATH=\"${RGBDS_BIN}:\$PATH\"" >> "$CLAUDE_ENV_FILE"
fi
