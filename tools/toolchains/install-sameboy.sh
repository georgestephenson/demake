#!/usr/bin/env bash
# Provision the headless SameBoy capturer for the doc-10 pixel-perfect E2E.
#
# Builds SameBoy's public library (`libsameboy`) and its open-source boot ROMs
# from a pinned source tag, then compiles the repo's emu-harness/gb/capture.c
# against them into a cached `capture` binary. No Docker; needs only git egress,
# a C compiler, and RGBDS on PATH (SameBoy assembles its boot ROMs with rgbasm —
# these are SameBoy's own reimplementations, not Nintendo's).
#
# Idempotent and best-effort (exits 0 unless SAMEBOY_STRICT=1) so it is safe in a
# SessionStart hook. The E2E test self-skips when the capturer is absent.
set -uo pipefail

SAMEBOY_VERSION="${SAMEBOY_VERSION:-1.0.1}"
CACHE_ROOT="${DEMAKE_TOOLCHAIN_DIR:-$HOME/.cache/demake/toolchains}"
PREFIX="$CACHE_ROOT/sameboy-$SAMEBOY_VERSION"
CAPTURE="$PREFIX/capture"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CAPTURE_SRC="$REPO_ROOT/emu-harness/gb/capture.c"

log() { printf 'install-sameboy: %s\n' "$*" >&2; }
die() {
  log "ERROR: $*"
  [ "${SAMEBOY_STRICT:-0}" = "1" ] && exit 1
  exit 0
}

# Already built?
if [ -x "$CAPTURE" ] && [ -f "$PREFIX/dmg_boot.bin" ] && [ -f "$PREFIX/cgb_boot.bin" ]; then
  log "cached: $CAPTURE"
  exit 0
fi

[ -f "$CAPTURE_SRC" ] || die "missing capture source '$CAPTURE_SRC'"

# SameBoy assembles its boot ROMs with RGBDS; make sure it is available first.
if ! command -v rgbasm >/dev/null 2>&1; then
  log "RGBDS not on PATH; provisioning it first"
  bash "$SCRIPT_DIR/install-rgbds.sh" || true
fi
for tool in git make cc rgbasm; do
  command -v "$tool" >/dev/null 2>&1 || die "missing build dependency '$tool'"
done

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
log "cloning SameBoy v$SAMEBOY_VERSION…"
if ! git clone --depth 1 --branch "v$SAMEBOY_VERSION" \
  https://github.com/LIJI32/SameBoy.git "$WORK/SameBoy" >/dev/null 2>&1; then
  die "git clone of SameBoy v$SAMEBOY_VERSION failed"
fi

log "building libsameboy + boot ROMs…"
if ! make -C "$WORK/SameBoy" lib tester CONF=release -j"$(nproc 2>/dev/null || echo 2)" \
  >/tmp/sameboy-build.log 2>&1; then
  die "SameBoy build failed (see /tmp/sameboy-build.log)"
fi

LIB="$WORK/SameBoy/build/lib/libsameboy.a"
BOOTS="$WORK/SameBoy/build/bin/tester"
[ -f "$LIB" ] || die "libsameboy.a was not produced"

mkdir -p "$PREFIX"
log "compiling capture.c…"
if ! cc -O2 -I"$WORK/SameBoy" "$CAPTURE_SRC" "$LIB" -lm -o "$CAPTURE" 2>>/tmp/sameboy-build.log; then
  die "compiling capture.c failed (see /tmp/sameboy-build.log)"
fi
cp "$BOOTS/dmg_boot.bin" "$PREFIX/dmg_boot.bin"
cp "$BOOTS/cgb_boot.bin" "$PREFIX/cgb_boot.bin"

log "installed capturer + boot ROMs into $PREFIX"
