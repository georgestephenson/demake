#!/usr/bin/env bash
# Provision the RGBDS toolchain (rgbasm/rgblink/rgbfix/rgbgfx) for the `gb`
# codegen family's `--format rom` path and the doc-10 emulator E2E.
#
# Strategy (doc 06 §ROM building, doc 10): pin a release, build it from source
# (git clone the tag + cmake), and cache the result so re-runs are instant. This
# needs no Docker and no GitHub release API — only `git` egress to github.com,
# which every managed/web session already has. It is the mechanism a Claude Code
# session (or CI) uses to get a real assembler on PATH.
#
# Idempotent: if the pinned version is already built in the cache, it only
# re-links the binaries onto PATH. Safe to run from a SessionStart hook — it
# never fails the session (exits 0 on a best-effort basis unless RGBDS_STRICT=1).
set -uo pipefail

# --- pinned version ----------------------------------------------------------
RGBDS_VERSION="${RGBDS_VERSION:-0.8.0}"
CACHE_ROOT="${DEMAKE_TOOLCHAIN_DIR:-$HOME/.cache/demake/toolchains}"
PREFIX="$CACHE_ROOT/rgbds-$RGBDS_VERSION"
BIN_DIR="$PREFIX/bin"
LINK_DIR="${DEMAKE_TOOLCHAIN_BIN:-/usr/local/bin}"
TOOLS=(rgbasm rgblink rgbfix rgbgfx)

log() { printf 'install-rgbds: %s\n' "$*" >&2; }

die() {
  log "ERROR: $*"
  [ "${RGBDS_STRICT:-0}" = "1" ] && exit 1
  exit 0
}

link_onto_path() {
  # Symlink the built tools into a directory on PATH so later shells find them.
  if [ -w "$LINK_DIR" ] 2>/dev/null || mkdir -p "$LINK_DIR" 2>/dev/null; then
    for t in "${TOOLS[@]}"; do ln -sf "$BIN_DIR/$t" "$LINK_DIR/$t" 2>/dev/null || true; done
    log "linked ${TOOLS[*]} into $LINK_DIR"
  else
    log "cannot write $LINK_DIR; add to PATH manually:"
    log "  export PATH=\"$BIN_DIR:\$PATH\""
  fi
}

# --- already built? ----------------------------------------------------------
if [ -x "$BIN_DIR/rgbasm" ]; then
  have="$("$BIN_DIR/rgbasm" --version 2>/dev/null || true)"
  log "cached: $have ($BIN_DIR)"
  link_onto_path
  exit 0
fi

# --- toolchain deps ----------------------------------------------------------
for tool in git cmake make cc; do
  command -v "$tool" >/dev/null 2>&1 || die "missing build dependency '$tool'"
done

# --- fetch + build -----------------------------------------------------------
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
log "cloning RGBDS v$RGBDS_VERSION (source build)…"
if ! git clone --depth 1 --branch "v$RGBDS_VERSION" \
  https://github.com/gbdev/rgbds.git "$WORK/rgbds" >/dev/null 2>&1; then
  die "git clone of RGBDS v$RGBDS_VERSION failed (check network egress to github.com)"
fi

log "building…"
if ! cmake -S "$WORK/rgbds" -B "$WORK/rgbds/build" -DCMAKE_BUILD_TYPE=Release >/dev/null 2>&1 ||
  ! cmake --build "$WORK/rgbds/build" -j"$(nproc 2>/dev/null || echo 2)" >/dev/null 2>&1; then
  die "RGBDS build failed"
fi

mkdir -p "$BIN_DIR"
for t in "${TOOLS[@]}"; do
  src="$(find "$WORK/rgbds/build" -maxdepth 3 -type f -name "$t" -perm -u+x | head -1)"
  [ -n "$src" ] || die "built RGBDS is missing '$t'"
  cp "$src" "$BIN_DIR/$t"
done

log "installed $("$BIN_DIR/rgbasm" --version) into $BIN_DIR"
link_onto_path
