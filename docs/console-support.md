# Console support

**Generated — do not edit.** Run `pnpm gen:console-docs` after changing a console
spec, a ROM builder, a Demotic backend or an audio driver; `packages/cli/test/support.test.ts`
fails CI if this file goes stale. The hardware constraints behind these
columns are [doc 03](03-console-matrix.md); the plan for the empty cells is
[doc 13](13-roadmap.md).

## What the columns mean

| Column | Means |
|---|---|
| **art** | `demake prep` fits an image to the hardware and `demake inspect` proves the result compliant. Every console with a `ConsoleSpec` has this. |
| **data** | `demake gen` emits native tiles/maps/palettes as `bin`, `asm` or `c`. |
| **ROM** | `demake gen --format rom` assembles a bootable cartridge that displays the art. Blank means no builder exists at this edge — not that the toolchain is missing on your machine. |
| **emulator** | The ROM's framebuffer is compared against the DAC reference byte for byte in a headless core (doc 10). This is what *supported* means here. |
| **game** | `demake build` compiles a `.dmt` into a cartridge for this console, proven against the reference interpreter tick for tick. |
| **music/sfx** | `demake arrange`, `demake sfx` and `demake render` demake audio for this console's sound hardware. |
| **in-game audio** | A generated driver plays that audio inside a `demake build` cartridge, at this tick rate. |

## Tier 1

| Console | id | family | art | data | ROM | emulator | game | music/sfx | in-game audio |
|---|---|---|---|---|---|---|---|---|---|
| Game Boy | `dmg` | `gb` | yes | `bin` `asm` `c` | RGBDS | SameBoy | `gb` | yes | 120 Hz |
| Game Boy Advance | `gba` | `gba` | yes | `bin` `asm` `c` | GNU ARM binutils | mGBA | `gba` | yes | — |
| Game Boy Color | `gbc` | `gb` | yes | `bin` `asm` `c` | RGBDS | SameBoy | `gb` | yes | 120 Hz |
| Sega Mega Drive | `md` | `md` | yes | `bin` `asm` `c` | GNU m68k binutils | genesis-plus-gx | `md` | yes | 59.92 Hz |
| Nintendo DS | `nds` | `nds` | yes | `bin` `asm` `c` | GNU ARM binutils | DeSmuME | — | — | — |
| Nintendo Entertainment System | `nes` | `nes` | yes | `bin` `asm` `c` | cc65 | fceumm | `nes` | yes | 60.1 Hz |
| Sega Master System | `sms` | `sms` | yes | `bin` `asm` `c` | WLA-DX | genesis-plus-gx | `sms` | yes | 59.92 Hz |
| Super Nintendo Entertainment System | `snes` | `snes` | yes | `bin` `asm` `c` | WLA-DX | snes9x | `snes` | yes | 125 Hz |

## Tier 2

| Console | id | family | art | data | ROM | emulator | game | music/sfx | in-game audio |
|---|---|---|---|---|---|---|---|---|---|
| Sega Game Gear | `gg` | `sms` | yes | `bin` `asm` `c` | WLA-DX | genesis-plus-gx | `sms` | yes | 59.92 Hz |
| Neo Geo | `neogeo` | `neogeo` | yes | `bin` `asm` `c` | — | — | — | — | — |
| Neo Geo Pocket | `ngp` | `ngpc` | yes | `bin` `asm` `c` | — | — | — | — | — |
| Neo Geo Pocket Color | `ngpc` | `ngpc` | yes | `bin` `asm` `c` | — | — | — | — | — |
| PC Engine | `pce` | `pce` | yes | `bin` `asm` `c` | WLA-DX | beetle-pce-fast | — | — | — |
| WonderSwan | `ws` | `ws` | yes | `bin` `asm` `c` | — | — | — | — | — |
| WonderSwan Color | `wsc` | `wsc` | yes | `bin` `asm` `c` | NASM | beetle-wswan | — | — | — |

## Tier 3

| Console | id | family | art | data | ROM | emulator | game | music/sfx | in-game audio |
|---|---|---|---|---|---|---|---|---|---|
| Tiger Game.com | `gamecom` | `mono-misc` | yes | `bin` `asm` `c` | — | — | — | — | — |
| Mega Duck | `megaduck` | `gb` | yes | `bin` `asm` `c` | — | — | `gb` | yes | 120 Hz |
| Pokémon Mini | `pokemini` | `mono-misc` | yes | `bin` `asm` `c` | — | — | — | — | — |
| Sega SG-1000 | `sg1000` | `sg1000` | yes | `bin` `asm` `c` | WLA-DX | genesis-plus-gx | — | yes | — |
| Watara Supervision | `supervision` | `mono-misc` | yes | `bin` `asm` `c` | — | — | — | — | — |
| Virtual Boy | `vb` | `vb` | yes | `bin` `asm` `c` | — | — | — | — | — |

## Totals

- **21** consoles have a spec, so all 21 do art.
- **12** build a display ROM; **12** of those are proven pixel-perfect in an emulator.
- **9** compile a Demotic game.
- **10** demake music and sound effects; **8** play it from inside a game.
