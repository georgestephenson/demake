#!/usr/bin/env bash
# Provision the RGBDS toolchain (rgbasm/rgblink/rgbfix/rgbgfx) for the `gb`
# codegen family's `--format rom` path and the doc-10 emulator E2E.
#
# Resolution order (fastest acceptable path first, universal fallback last):
#   1. an rgbds already on PATH whose version we support        -> use it
#   2. a previous cached build of the pinned version            -> re-link it
#   3. $RGBDS_PREBUILT_URL, a tarball of prebuilt binaries       -> download it
#   4. source build: git clone the pinned tag + cmake            -> build it
#
# Why source build is the committed default: prebuilt-release and distro-package
# installs are faster but depend on hosts a locked-down egress policy often
# denies (GitHub release assets / api.github.com / third-party PPAs all 403 in
# Claude Code on the web); only `git` to github.com is guaranteed. Source build
# needs just git + cmake + a compiler, runs in ~13s, and caches. Environments
# that *can* fetch a binary set $RGBDS_PREBUILT_URL to skip compiling.
#
# Idempotent, non-interactive, and safe to run from a SessionStart hook: it never
# fails the session (exits 0 best-effort unless RGBDS_STRICT=1).
set -uo pipefail

RGBDS_VERSION="${RGBDS_VERSION:-0.8.0}"
# Versions the CLI's ROM builder accepts (keep in sync with rom/gb.ts).
SUPPORTED_RE='^0\.(8|9)\.'
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

rgbds_version() { "$1" --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1; }

link_onto_path() {
  if [ -w "$LINK_DIR" ] 2>/dev/null || mkdir -p "$LINK_DIR" 2>/dev/null; then
    for t in "${TOOLS[@]}"; do ln -sf "$BIN_DIR/$t" "$LINK_DIR/$t" 2>/dev/null || true; done
    log "linked ${TOOLS[*]} into $LINK_DIR"
  else
    log "cannot write $LINK_DIR; add to PATH manually: export PATH=\"$BIN_DIR:\$PATH\""
  fi
}

# --- 1. an acceptable rgbds already on PATH ----------------------------------
if command -v rgbasm >/dev/null 2>&1; then
  sysver="$(rgbds_version "$(command -v rgbasm)")"
  if [ -n "$sysver" ] && printf '%s' "$sysver" | grep -qE "$SUPPORTED_RE"; then
    have_all=1
    for t in "${TOOLS[@]}"; do command -v "$t" >/dev/null 2>&1 || have_all=0; done
    if [ "$have_all" = "1" ]; then
      log "using system RGBDS v$sysver ($(command -v rgbasm)) — nothing to build"
      exit 0
    fi
  fi
fi

# --- 2. a previous cached build ----------------------------------------------
if [ -x "$BIN_DIR/rgbasm" ]; then
  log "cached: rgbasm v$(rgbds_version "$BIN_DIR/rgbasm") ($BIN_DIR)"
  link_onto_path
  exit 0
fi

install_from_dir() { # $1 = dir containing the four tools
  mkdir -p "$BIN_DIR"
  for t in "${TOOLS[@]}"; do
    local src; src="$(find "$1" -maxdepth 3 -type f -name "$t" -perm -u+x | head -1)"
    [ -n "$src" ] || return 1
    cp "$src" "$BIN_DIR/$t"
  done
  return 0
}

# --- 3. opt-in prebuilt binary tarball ---------------------------------------
if [ -n "${RGBDS_PREBUILT_URL:-}" ]; then
  log "downloading prebuilt RGBDS from \$RGBDS_PREBUILT_URL…"
  WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
  if curl -fsSL "$RGBDS_PREBUILT_URL" -o "$WORK/rgbds.tar" &&
    tar -xf "$WORK/rgbds.tar" -C "$WORK" && install_from_dir "$WORK"; then
    log "installed prebuilt $("$BIN_DIR/rgbasm" --version) into $BIN_DIR"
    link_onto_path
    exit 0
  fi
  log "prebuilt install failed; falling back to source build"
fi

# --- 4. source build (universal fallback) ------------------------------------
for tool in git cmake make cc; do
  command -v "$tool" >/dev/null 2>&1 || die "missing build dependency '$tool'"
done
WORK="${WORK:-$(mktemp -d)}"; trap 'rm -rf "$WORK"' EXIT
log "building RGBDS v$RGBDS_VERSION from source…"
if ! git clone --depth 1 --branch "v$RGBDS_VERSION" \
  https://github.com/gbdev/rgbds.git "$WORK/rgbds" >/dev/null 2>&1; then
  die "git clone of RGBDS v$RGBDS_VERSION failed (check network egress to github.com)"
fi
if ! cmake -S "$WORK/rgbds" -B "$WORK/rgbds/build" -DCMAKE_BUILD_TYPE=Release >/dev/null 2>&1 ||
  ! cmake --build "$WORK/rgbds/build" -j"$(nproc 2>/dev/null || echo 2)" >/dev/null 2>&1; then
  die "RGBDS build failed"
fi
install_from_dir "$WORK/rgbds/build" || die "built RGBDS is missing a tool"
log "installed $("$BIN_DIR/rgbasm" --version) into $BIN_DIR"
link_onto_path
