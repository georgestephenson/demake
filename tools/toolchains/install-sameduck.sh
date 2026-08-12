#!/usr/bin/env bash
# Provision the headless SameDuck capturer for the Mega Duck pixel-perfect E2E
# (doc 10).
#
# SameDuck is SameBoy's own Mega Duck fork and lives on a branch of the same
# repository rather than in one of its own, so this clones `SameDuck` from
# LIJI32/SameBoy. Three things about that fork decide what this script does that
# install-sameboy.sh does not:
#
#   - **There is no boot ROM**, because the console has none: a cartridge begins
#     executing at $0000. So nothing is assembled with RGBDS here and nothing is
#     copied beside the capturer.
#   - **There is no `lib` target**, the fork predating SameBoy's public library
#     build, so `Core/*.c` is compiled directly with the flags the fork's own
#     Makefile uses for it (`-DGB_INTERNAL`, `-D_GNU_SOURCE`, `-DVERSION=…`).
#   - **The capturer is the Game Boy's**, compiled with -DDEMAKE_SAMEDUCK. One
#     source, two emulators (emu-harness/gb/capture.c §One source, two
#     emulators).
#
# The branch is tracked rather than pinned, for install-libretro.sh's reason and
# with the same standing risk. Idempotent and best-effort (exits 0 unless
# SAMEDUCK_STRICT=1) so it is safe in a SessionStart hook; the E2E self-skips
# when the capturer is absent.
set -uo pipefail

SAMEDUCK_BRANCH="${SAMEDUCK_BRANCH:-SameDuck}"
CACHE_ROOT="${DEMAKE_TOOLCHAIN_DIR:-$HOME/.cache/demake/toolchains}"
PREFIX="$CACHE_ROOT/sameduck"
CAPTURE="$PREFIX/capture"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CAPTURE_SRC="$REPO_ROOT/emu-harness/gb/capture.c"

log() { printf 'install-sameduck: %s\n' "$*" >&2; }
die() {
  log "ERROR: $*"
  if [ -s /tmp/sameduck-build.log ]; then
    log "last 25 lines of /tmp/sameduck-build.log:"
    tail -25 /tmp/sameduck-build.log >&2
  fi
  [ "${SAMEDUCK_STRICT:-0}" = "1" ] && exit 1
  exit 0
}

# Keyed on the source it compiles, for install-sameboy.sh's reason: the branch is
# not pinned and `capture.c` is ours, so "the binary exists" is not the same
# question as "the binary is this one".
STAMP="$PREFIX/capture.stamp"
source_stamp() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$CAPTURE_SRC" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$CAPTURE_SRC" | cut -d' ' -f1
  else cksum "$CAPTURE_SRC" | cut -d' ' -f1
  fi
}

[ -f "$CAPTURE_SRC" ] || die "missing capture source '$CAPTURE_SRC'"
WANT="$(source_stamp)"

if [ -x "$CAPTURE" ] && [ "$(cat "$STAMP" 2>/dev/null || true)" = "$WANT" ]; then
  log "cached: $CAPTURE"
  exit 0
fi
for tool in git cc; do
  command -v "$tool" >/dev/null 2>&1 || die "missing build dependency '$tool'"
done

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
log "cloning SameBoy branch $SAMEDUCK_BRANCH (SameDuck)…"
if ! git clone --depth 1 --branch "$SAMEDUCK_BRANCH" \
  https://github.com/LIJI32/SameBoy.git "$WORK/SameDuck" >/dev/null 2>&1; then
  die "git clone of the SameDuck branch failed"
fi

VERSION="$(sed -n 's/^VERSION[[:space:]]*:*=[[:space:]]*//p' "$WORK/SameDuck/version.mk" | head -1)"
[ -n "$VERSION" ] || VERSION="unknown"

mkdir -p "$PREFIX" "$WORK/obj"
log "building SameDuck core (v$VERSION)…"
CORE_FLAGS=(-O2 -std=gnu11 -D_GNU_SOURCE -DVERSION="\"$VERSION\"" -I"$WORK/SameDuck"
  -DGB_INTERNAL -w)
objects=()
for src in "$WORK/SameDuck"/Core/*.c; do
  obj="$WORK/obj/$(basename "$src" .c).o"
  cc "${CORE_FLAGS[@]}" -c "$src" -o "$obj" >>/tmp/sameduck-build.log 2>&1 ||
    die "compiling $(basename "$src") failed (see /tmp/sameduck-build.log)"
  objects+=("$obj")
done

log "compiling capture.c…"
cc -O2 -DDEMAKE_SAMEDUCK -I"$WORK/SameDuck" "$CAPTURE_SRC" "${objects[@]}" -lm \
  -o "$CAPTURE" >>/tmp/sameduck-build.log 2>&1 ||
  die "compiling capture.c failed (see /tmp/sameduck-build.log)"
# Last, so an interrupted build leaves no stamp and the next run rebuilds.
printf '%s\n' "$WANT" >"$STAMP"

log "installed capturer into $PREFIX"
