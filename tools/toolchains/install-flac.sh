#!/usr/bin/env bash
# Provision the reference FLAC tool, which is the *oracle* for our own FLAC
# encoder rather than something the build uses. `packages/cli/test/flac.e2e.test.ts`
# runs `flac -t` over a stream we wrote — that verifies the MD5 in STREAMINFO
# against what libFLAC actually decoded, so it passes only if our bitstream is
# bit-for-bit the samples we hashed — and then decodes it and compares the
# samples with `encodeWav`'s. Same standing as arm-none-eabi-as in
# `arm-gnu.test.ts`: an encoder checked only by its own arithmetic is checked
# against its own misreadings. A stock distro package, like NASM and the m68k
# and ARM binutils. Best-effort (exits 0 unless FLAC_STRICT=1) so it is hook-safe.
# Needs apt + sudo; falls back with a clear message otherwise.
set -uo pipefail

TOOLS=(flac)
PKG="flac"

log() { printf 'install-flac: %s\n' "$*" >&2; }
die() {
  log "ERROR: $*"
  [ "${FLAC_STRICT:-0}" = "1" ] && exit 1
  exit 0
}

have_all() {
  for t in "${TOOLS[@]}"; do command -v "$t" >/dev/null 2>&1 || return 1; done
  return 0
}

if have_all; then
  log "using system flac — nothing to install"
  exit 0
fi

SUDO=""
if [ "$(id -u)" != "0" ]; then
  command -v sudo >/dev/null 2>&1 || die "need root or sudo to install $PKG"
  SUDO="sudo"
fi
command -v apt-get >/dev/null 2>&1 || die "apt-get not available; install $PKG manually"

log "installing $PKG via apt…"
$SUDO apt-get update -qq >/tmp/flac-apt.log 2>&1 || log "apt-get update failed (continuing)"
if ! $SUDO apt-get install -y "$PKG" >>/tmp/flac-apt.log 2>&1; then
  die "apt-get install $PKG failed (see /tmp/flac-apt.log)"
fi

have_all || die "flac still missing after install"
log "flac ready: ${TOOLS[*]}"
exit 0
