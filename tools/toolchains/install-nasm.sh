#!/usr/bin/env bash
# Provision NASM for the WonderSwan Color `--format rom` path. The WonderSwan's
# NEC V30MZ is an 8086-compatible core, so a stock x86 assembler emitting a flat
# 16-bit binary is exactly the right tool — and, like the m68k and ARM binutils,
# a well-tested one is a distro package rather than something worth building
# from source. Best-effort (exits 0 unless NASM_STRICT=1) so it is hook-safe.
# Needs apt + sudo; falls back with a clear message otherwise.
set -uo pipefail

TOOLS=(nasm)
PKG="nasm"

log() { printf 'install-nasm: %s\n' "$*" >&2; }
die() {
  log "ERROR: $*"
  [ "${NASM_STRICT:-0}" = "1" ] && exit 1
  exit 0
}

have_all() {
  for t in "${TOOLS[@]}"; do command -v "$t" >/dev/null 2>&1 || return 1; done
  return 0
}

if have_all; then
  log "using system NASM — nothing to install"
  exit 0
fi

SUDO=""
if [ "$(id -u)" != "0" ]; then
  command -v sudo >/dev/null 2>&1 || die "need root or sudo to install $PKG"
  SUDO="sudo"
fi
command -v apt-get >/dev/null 2>&1 || die "apt-get not available; install $PKG manually"

log "installing $PKG via apt…"
$SUDO apt-get update -qq >/tmp/nasm-apt.log 2>&1 || log "apt-get update failed (continuing)"
if ! $SUDO apt-get install -y "$PKG" >>/tmp/nasm-apt.log 2>&1; then
  die "apt-get install $PKG failed (see /tmp/nasm-apt.log)"
fi

have_all || die "NASM still missing after install"
log "NASM ready: ${TOOLS[*]}"
exit 0
