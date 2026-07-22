#!/usr/bin/env bash
# Provision the cc65 toolchain (ca65/ld65) for the NES `--format rom` path.
# Pinned source build (git clone the tag + make), cached and idempotent — the
# same mechanism as install-rgbds.sh. No Docker; needs only git egress + a C
# compiler. Best-effort (exits 0 unless CC65_STRICT=1) so it is hook-safe.
set -uo pipefail

CC65_VERSION="${CC65_VERSION:-2.19}"
CACHE_ROOT="${DEMAKE_TOOLCHAIN_DIR:-$HOME/.cache/demake/toolchains}"
PREFIX="$CACHE_ROOT/cc65-$CC65_VERSION"
BIN_DIR="$PREFIX/bin"
LINK_DIR="${DEMAKE_TOOLCHAIN_BIN:-/usr/local/bin}"
TOOLS=(ca65 ld65 cc65 ar65 cl65)

log() { printf 'install-cc65: %s\n' "$*" >&2; }
die() {
  log "ERROR: $*"
  [ "${CC65_STRICT:-0}" = "1" ] && exit 1
  exit 0
}

link_onto_path() {
  if [ -w "$LINK_DIR" ] 2>/dev/null || mkdir -p "$LINK_DIR" 2>/dev/null; then
    for t in "${TOOLS[@]}"; do ln -sf "$BIN_DIR/$t" "$LINK_DIR/$t" 2>/dev/null || true; done
    log "linked ca65/ld65/… into $LINK_DIR"
  else
    log "cannot write $LINK_DIR; add to PATH: export PATH=\"$BIN_DIR:\$PATH\""
  fi
}

if command -v ca65 >/dev/null 2>&1 && command -v ld65 >/dev/null 2>&1; then
  log "using system cc65 ($(ca65 --version 2>&1 | head -1)) — nothing to build"
  exit 0
fi
if [ -x "$BIN_DIR/ca65" ]; then
  log "cached: $("$BIN_DIR/ca65" --version 2>&1 | head -1) ($BIN_DIR)"
  link_onto_path
  exit 0
fi

for tool in git make cc; do
  command -v "$tool" >/dev/null 2>&1 || die "missing build dependency '$tool'"
done

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
log "cloning cc65 V$CC65_VERSION…"
if ! git clone --depth 1 --branch "V$CC65_VERSION" \
  https://github.com/cc65/cc65.git "$WORK/cc65" >/dev/null 2>&1; then
  die "git clone of cc65 V$CC65_VERSION failed"
fi
log "building…"
if ! make -C "$WORK/cc65" -j"$(nproc 2>/dev/null || echo 2)" >/tmp/cc65-build.log 2>&1; then
  die "cc65 build failed (see /tmp/cc65-build.log)"
fi
mkdir -p "$BIN_DIR"
for t in "${TOOLS[@]}"; do
  [ -f "$WORK/cc65/bin/$t" ] || die "built cc65 is missing '$t'"
  cp "$WORK/cc65/bin/$t" "$BIN_DIR/$t"
done
log "installed $("$BIN_DIR/ca65" --version 2>&1 | head -1) into $BIN_DIR"
link_onto_path
