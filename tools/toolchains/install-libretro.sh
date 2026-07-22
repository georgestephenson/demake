#!/usr/bin/env bash
# Provision the headless libretro capture stack for the pixel-perfect E2E:
# the generic `retrorun` frontend (emu-harness/libretro/retrorun.c) plus one
# accuracy core per console family. One frontend serves every console — adding a
# console adds its core to the table below, not a new emulator harness.
#
# Pinned source builds (git clone + make), cached and idempotent. No Docker;
# needs git egress + a C compiler. Best-effort (exits 0 unless LIBRETRO_STRICT=1).
set -uo pipefail

CACHE_ROOT="${DEMAKE_TOOLCHAIN_DIR:-$HOME/.cache/demake/toolchains}"
PREFIX="$CACHE_ROOT/libretro"
CORES_DIR="$PREFIX/cores"
RUNNER="$PREFIX/retrorun"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
RUNNER_SRC="$REPO_ROOT/emu-harness/libretro/retrorun.c"

# Cores to build: "name|git-url|branch|make-recipe|output.so". Extend per console.
CORES=(
  "fceumm|https://github.com/libretro/libretro-fceumm.git|master|make -f Makefile.libretro|fceumm_libretro.so"
)
# Which cores to (re)build this run (default: all). Pass names as args to subset.
WANT=("$@")

log() { printf 'install-libretro: %s\n' "$*" >&2; }
die() {
  log "ERROR: $*"
  [ "${LIBRETRO_STRICT:-0}" = "1" ] && exit 1
  exit 0
}

want() {
  [ ${#WANT[@]} -eq 0 ] && return 0
  for w in "${WANT[@]}"; do [ "$w" = "$1" ] && return 0; done
  return 1
}

for tool in git make cc; do
  command -v "$tool" >/dev/null 2>&1 || die "missing build dependency '$tool'"
done
[ -f "$RUNNER_SRC" ] || die "missing runner source '$RUNNER_SRC'"
mkdir -p "$CORES_DIR"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

built_runner=0
for entry in "${CORES[@]}"; do
  IFS='|' read -r name url branch recipe out <<<"$entry"
  want "$name" || continue
  if [ -f "$CORES_DIR/$out" ] && [ -x "$RUNNER" ]; then
    log "cached: $name ($out)"
    continue
  fi
  log "cloning core $name…"
  git clone --depth 1 --branch "$branch" "$url" "$WORK/$name" >/dev/null 2>&1 ||
    git clone --depth 1 "$url" "$WORK/$name" >/dev/null 2>&1 ||
    die "git clone of $name failed"
  log "building core $name (this can take a minute)…"
  ( cd "$WORK/$name" && $recipe -j"$(nproc 2>/dev/null || echo 2)" ) >/tmp/libretro-$name.log 2>&1 ||
    die "build of $name failed (see /tmp/libretro-$name.log)"
  soPath="$(find "$WORK/$name" -maxdepth 2 -name "$out" | head -1)"
  [ -n "$soPath" ] || die "core $name did not produce $out"
  cp "$soPath" "$CORES_DIR/$out"

  # Build the runner once, against this core's bundled libretro.h.
  if [ "$built_runner" = "0" ]; then
    inc="$(dirname "$(find "$WORK/$name" -name libretro.h | head -1)")"
    [ -n "$inc" ] || die "no libretro.h found to build the runner"
    cc -O2 -I"$inc" "$RUNNER_SRC" -ldl -o "$RUNNER" 2>>/tmp/libretro-runner.log ||
      die "compiling retrorun.c failed (see /tmp/libretro-runner.log)"
    built_runner=1
    log "built retrorun -> $RUNNER"
  fi
  log "installed core $name -> $CORES_DIR/$out"
done

# If every core was cached, the runner already exists; report it.
[ -x "$RUNNER" ] && log "runner ready: $RUNNER"
