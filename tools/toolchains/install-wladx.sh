#!/usr/bin/env bash
# Provision the WLA-DX toolchain (wla-z80 + wla-65816 + wlalink) for the SMS/GG,
# SG-1000 and SNES `--format rom` paths — one build serves every WLA-DX target
# family. Pinned source build (git clone + cmake), cached and idempotent —
# the same mechanism as the other assemblers. No Docker; needs git egress, a C
# compiler, and cmake. Best-effort (exits 0 unless WLADX_STRICT=1).
set -uo pipefail

WLADX_VERSION="${WLADX_VERSION:-v10.6}"
CACHE_ROOT="${DEMAKE_TOOLCHAIN_DIR:-$HOME/.cache/demake/toolchains}"
PREFIX="$CACHE_ROOT/wladx-${WLADX_VERSION}"
BIN_DIR="$PREFIX/bin"
LINK_DIR="${DEMAKE_TOOLCHAIN_BIN:-/usr/local/bin}"
TOOLS=(wla-z80 wla-65816 wlalink)

log() { printf 'install-wladx: %s\n' "$*" >&2; }
die() {
  log "ERROR: $*"
  [ "${WLADX_STRICT:-0}" = "1" ] && exit 1
  exit 0
}

link_onto_path() {
  if [ -w "$LINK_DIR" ] 2>/dev/null || mkdir -p "$LINK_DIR" 2>/dev/null; then
    for t in "${TOOLS[@]}"; do ln -sf "$BIN_DIR/$t" "$LINK_DIR/$t" 2>/dev/null || true; done
    log "linked ${TOOLS[*]} into $LINK_DIR"
  else
    log "cannot write $LINK_DIR; add to PATH: export PATH=\"$BIN_DIR:\$PATH\""
  fi
}

have_all() {
  for t in "${TOOLS[@]}"; do command -v "$t" >/dev/null 2>&1 || return 1; done
  return 0
}
cached_all() {
  for t in "${TOOLS[@]}"; do [ -x "$BIN_DIR/$t" ] || return 1; done
  return 0
}

if have_all; then
  log "using system WLA-DX — nothing to build"
  exit 0
fi
if cached_all; then
  log "cached: WLA-DX ($BIN_DIR)"
  link_onto_path
  exit 0
fi

for tool in git cmake make cc; do
  command -v "$tool" >/dev/null 2>&1 || die "missing build dependency '$tool'"
done

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
log "cloning WLA-DX ${WLADX_VERSION}…"
git clone --depth 1 --branch "$WLADX_VERSION" https://github.com/vhelin/wla-dx.git "$WORK/wla" >/dev/null 2>&1 ||
  git clone --depth 1 https://github.com/vhelin/wla-dx.git "$WORK/wla" >/dev/null 2>&1 ||
  die "git clone of WLA-DX failed"
log "building…"
if ! cmake -S "$WORK/wla" -B "$WORK/wla/build" -DCMAKE_BUILD_TYPE=Release >/tmp/wladx-build.log 2>&1 ||
  ! cmake --build "$WORK/wla/build" -j"$(nproc 2>/dev/null || echo 2)" >>/tmp/wladx-build.log 2>&1; then
  die "WLA-DX build failed (see /tmp/wladx-build.log)"
fi
mkdir -p "$BIN_DIR"
for t in "${TOOLS[@]}"; do
  src="$(find "$WORK/wla/build" -maxdepth 3 -type f -name "$t" -perm -u+x | head -1)"
  [ -n "$src" ] || die "built WLA-DX is missing '$t'"
  cp "$src" "$BIN_DIR/$t"
done
log "installed WLA-DX into $BIN_DIR"
link_onto_path
