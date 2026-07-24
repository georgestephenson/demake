#!/usr/bin/env bash
# Provision a bare-metal ARM assembler + linker for the Game Boy Advance and
# Nintendo DS `--format rom` paths: the GNU binutils arm-none-eabi cross tools
# (arm-none-eabi-as / -ld / -objcopy). Like the m68k tools, a well-tested build
# is a stock distro package, so this installs it via apt (the main archive, no
# PPA) instead of a source build — devkitARM is deliberately *not* required: the
# harnesses are pure assembly and demake packs the GBA/NDS cartridge headers
# itself (doc 06 §ROM building). Best-effort (exits 0 unless ARM_STRICT=1) so it
# is hook-safe. Needs apt + sudo; falls back with a clear message otherwise.
set -uo pipefail

TOOLS=(arm-none-eabi-as arm-none-eabi-ld arm-none-eabi-objcopy)
PKG="binutils-arm-none-eabi"

log() { printf 'install-arm: %s\n' "$*" >&2; }
die() {
  log "ERROR: $*"
  [ "${ARM_STRICT:-0}" = "1" ] && exit 1
  exit 0
}

have_all() {
  for t in "${TOOLS[@]}"; do command -v "$t" >/dev/null 2>&1 || return 1; done
  return 0
}

if have_all; then
  log "using system arm-none-eabi binutils — nothing to install"
  exit 0
fi

SUDO=""
if [ "$(id -u)" != "0" ]; then
  command -v sudo >/dev/null 2>&1 || die "need root or sudo to install $PKG"
  SUDO="sudo"
fi
command -v apt-get >/dev/null 2>&1 || die "apt-get not available; install $PKG manually"

log "installing $PKG via apt…"
$SUDO apt-get update -qq >/tmp/arm-apt.log 2>&1 || log "apt-get update failed (continuing)"
if ! $SUDO apt-get install -y "$PKG" >>/tmp/arm-apt.log 2>&1; then
  die "apt-get install $PKG failed (see /tmp/arm-apt.log)"
fi

have_all || die "arm-none-eabi binutils still missing after install"
log "arm-none-eabi binutils ready: ${TOOLS[*]}"
exit 0
