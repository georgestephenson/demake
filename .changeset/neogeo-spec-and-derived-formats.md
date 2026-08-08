---
"@demake/core": minor
"demake": patch
---

Describe the Neo Geo's real hardware, and stop six consoles claiming a data
format nothing can produce.

The `neogeo` spec understated the machine on three axes at once, against the rule
that a spec says what the hardware can do and never what the engine has reached:
it declared sixteen sub-palettes where the hardware has **256** of sixteen, an
8×8 attribute cell where a palette actually belongs to a **16×16** sprite tile,
and a tile budget of 4096 for a console whose tiles are read from cartridge ROM
rather than uploaded to a bank. All three starve the fit — an under-fed fit looks
like a bad fit — so `prep -c neogeo` changes output bytes and gets a re-baseline.

The comment now carries what the fit rests on, including the one thing the
sources disagree about: bit 15 of a colour word is the dark bit and bits 14–12
are per-channel least significant bits, which is five bits a channel, but the
same reference also calls bit 15 "a common LSB for the three components", which
would make it six. Five is declared because it is the reading every source
agrees on, and the uncertainty is written down rather than hidden — a machine
description that is wrong _and_ consistent passes every test there is.

`codegen.formats` also drops `rom`, which had no builder behind it.

And the support matrix now asks `backendFor` before believing a spec's `bin`,
`asm` and `c`. `gen` raises `E_UNSUPPORTED_FAMILY` for a console whose codegen
family has no backend, whatever format was asked for, so those three were
unreachable claims on every console with a spec and nothing behind it — the Neo
Geo, the Neo Geo Pocket, the Game.com, the Pokémon Mini, the Supervision and the
Virtual Boy. That is the same overstatement the `rom` filter already existed to
catch, one column to the left, and `docs/console-support.md` is regenerated.
