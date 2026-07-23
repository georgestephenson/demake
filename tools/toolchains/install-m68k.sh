#!/usr/bin/env bash
# Provision a Motorola 68000 assembler + linker for the Mega Drive / Genesis
# `--format rom` path: the GNU binutils m68k cross tools (m68k-linux-gnu-as /
# -ld / -objcopy). Unlike the other assemblers here, a well-tested m68k binutils
# is a stock distro package, so this installs it via apt (the main archive, no
# PPA) rather than a source build — far faster and equally deterministic (a
# pinned distro version). Best-effort (exits 0 unless M68K_STRICT=1) so it is
# hook-safe. Needs apt + sudo; falls back with a clear message otherwise.
set -uo pipefail

TOOLS=(m68k-linux-gnu-as m68k-linux-gnu-ld m68k-linux-gnu-objcopy)
PKG="binutils-m68k-linux-gnu"

log() { printf 'install-m68k: %s\n' "$*" >&2; }
die() {
  log "ERROR: $*"
  [ "${M68K_STRICT:-0}" = "1" ] && exit 1
  exit 0
}

have_all() {
  for t in "${TOOLS[@]}"; do command -v "$t" >/dev/null 2>&1 || return 1; done
  return 0
}

if have_all; then
  log "using system m68k binutils — nothing to install"
  exit 0
fi

SUDO=""
if [ "$(id -u)" != "0" ]; then
  command -v sudo >/dev/null 2>&1 || die "need root or sudo to install $PKG"
  SUDO="sudo"
fi
command -v apt-get >/dev/null 2>&1 || die "apt-get not available; install $PKG manually"

log "installing $PKG via apt…"
$SUDO apt-get update -qq >/tmp/m68k-apt.log 2>&1 || log "apt-get update failed (continuing)"
if ! $SUDO apt-get install -y "$PKG" >>/tmp/m68k-apt.log 2>&1; then
  die "apt-get install $PKG failed (see /tmp/m68k-apt.log)"
fi

have_all || die "m68k binutils still missing after install"
log "m68k binutils ready: ${TOOLS[*]}"
exit 0
