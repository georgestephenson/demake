# demake

> Demake modern game assets — art, and whole games — into something the
> 8/16-bit-era consoles and handhelds could actually run, up to and including the
> Nintendo DS.

`demake` takes ordinary modern inputs and produces things real retro hardware
could display and play, verified on emulated hardware rather than merely
asserted:

<!-- generated:demaker-table -->

<!-- prettier-ignore -->
| Demaker | Input | Output | Status |
|---|---|---|---|
| **art** | any image | hardware-compliant art, palettes, tile maps, asm/C/binary, bootable ROMs | 21 consoles; 17 proven pixel-perfect in an emulator |
| **game** | a [Demotic](docs/14-demotic.md) `.dmt` script + art | one game, every console | language, preview and playable ROMs on 16 consoles |
| **music** | a MIDI track | chip music, audio that sounds exactly like the hardware will, and a ROM | 18 consoles; 15 play it from inside a game, 10 from a cartridge of its own |
| **sound** | a WAV effect | a chip sound effect, placed and prioritised, and a ROM | 18 consoles; the same driver, the same cartridge, the same proof |

<!-- /generated:demaker-table -->

That table is **generated** from the registries that decide it, by
`pnpm gen:console-docs`, and CI fails if it drifts — as does
[`docs/console-support.md`](docs/console-support.md), which is the same facts one
console at a time.

Every demaker shares one engine, one determinism guarantee, and one proof: a
real ROM, booted in a real emulator, compared against what the hardware was
asked for. For art that comparison is pixel for pixel; for games it is the
game's own state, tick for tick; for audio it is the stream of register writes
the emulated sound chip actually receives, diffed against the schedule that
produced the audio file — which is exact rather than approximate, because the
compliant artifact _is_ that schedule.

## Why

One of the main motivations for this tool is enabling a fully AI-agent-driven
retro game workflow. Coding agents can already write code for retro consoles,
and image models can generate art — but art that fits precise hardware
constraints (master palettes, per-tile color limits, attribute grids, tile
budgets) has been the missing piece. `demake` closes that gap, so an AI agent
can create a retro game end to end: generate art, convert it into
hardware-compliant data and display code, and build a running ROM.

Demotic (docs [14](docs/14-demotic.md), [15](docs/15-demakefile.md)) takes that
further. A game is a `.dmt` script that names no console, no palette and no
pixel; a Demakefile says which machines to build for and how the art is
converted. Both are small, flat, and line-oriented precisely so a model can write
and patch them reliably — and a `.test.dmt` suite asserts the game still plays
correctly on every console at once.

> **Status: Phase 3, plus Demotic D1–D3 and D5.** The engine, the CLI and the web
> app are live; so are the Demotic language, its reference interpreter, its
> cross-console test runner, its browser preview — and its console
> backends. `demake build pong.dmt -o pong.gb` _compiles_ a game to Game Boy
> machine code and demakes its art on the way — and `-c nes`, `-c sms`, `-c snes`,
> `-c md`, `-c gba`, `-c pce`, `-c wsc`, `-c ngpc` and `-c vb` compile the same
> game to 6502, Z80, 65816, 68000, ARM, HuC6280, V30MZ, TLCS-900/H and V810:
> sixteen consoles across ten instruction sets. The web app builds and
> plays the identical cartridge in the page, and CI proves every example game
> reproduces the reference interpreter's fixed-point state tick for tick. Every
> console that builds a display ROM goes image → compliant art → native data →
> bootable ROM → emulator frame, compared pixel-for-pixel in CI — all eight of
> Tier 1 and nine more besides. The full design lives in
> [`docs/`](docs/README.md); the milestone plan is
> [`docs/13-roadmap.md`](docs/13-roadmap.md).

## Try it

- **In the browser** — the web app runs the identical engine client-side and
  uploads nothing: <https://georgestephenson.github.io/demake/>
- **On the command line**:

```sh
demake prep photo.jpg -c gbc -o photo.gbc.png     # hardware-compliant art
demake gen photo.gbc.png -c gbc --format asm      # tiles, map, palettes as RGBDS asm
demake gen photo.jpg -c nes --format rom -o out.nes   # a bootable ROM that displays it
demake inspect photo.gbc.png                      # is this really compliant? which consoles?
demake consoles                                   # every supported machine + its constraints

demake build pong.dmt -o pong.gb --title PONG     # a Demotic game as a playable cartridge
```

Building a game needs no assembler installed, because the assembler is ours: a
build compiles the game to SM83 machine code and demakes the art it names with
the same pipeline `prep` uses. That is also why the web app can compile the game
itself and hand you the identical bytes.

## Supported consoles

`prep` and `inspect` cover every RGB-lattice and mono raster console in
[doc 03](docs/03-console-matrix.md) — 21 machines from the Game Boy to the
Nintendo DS. Beyond that, support deepens a rung at a time:

<!-- generated:console-ladder -->

<!-- prettier-ignore -->
| Capability | Consoles |
|---|---|
| `prep` + `inspect` (compliant PNG) | **21** — every console with a spec |
| `gen` (bin/asm/C data) + `--format rom` + **pixel-perfect emulator proof** | **17** — one rung, not three: nothing emits data it cannot also boot and prove |
| `build` (a Demotic game as a playable ROM) | **16** — those 17 without the Sega SG-1000 |
| `arrange` / `sfx` (chip music and effects) | **18** — those 17, plus the Neo Geo Pocket |

<!-- /generated:console-ladder -->

Generated too, and the deltas are computed rather than written: a console that
gained a game backend without a display ROM would turn that third row into a
list of names instead of a sentence that had quietly become false.
[`docs/console-support.md`](docs/console-support.md) says which console is on
which rung; the SG-1000 is
[out of scope for games](docs/13-roadmap.md), and the mono Neo Geo Pocket has the
Color's sound hardware and no game backend, because a demaker is per-domain.

"Pixel-perfect emulator proof" means what it says: CI assembles a real ROM,
boots it in an emulator, and asserts the framebuffer matches demake's own output
byte-for-byte across an extensive image battery. On the Virtual Boy that is
**both eyes**: its display is two LED arrays and its video processor draws every
scene twice, offset by a depth the scene declares, so a still picture is proved
to sit at the display plane rather than merely to be drawn. On the Neo Geo the
emulator is handed a system ROM demake wrote itself, because that is all a
demade cartridge needs of one — nothing copyrighted is shipped or required.

## Packages

| Package                               | What                                                                                         |
| ------------------------------------- | -------------------------------------------------------------------------------------------- |
| [`@demake/core`](packages/core)       | The engine. Zero platform deps, ESM, ships types (doc 09).                                   |
| [`demake`](packages/cli)              | The CLI wrapper (doc 05). Re-exports core for scripting.                                     |
| [`@demake/demotic`](packages/demotic) | Demotic: the game language, its interpreter, and the ROM builder (docs 14, 15).              |
| [`@demake/dmg`](packages/dmg)         | A Game Boy core: DMG, Color and Mega Duck. The conformance harness and the web app's player. |
| [`@demake/nes`](packages/nes)         | An NES core, for the same two jobs.                                                          |
| [`@demake/sms`](packages/sms)         | A Sega 8-bit core: Master System and Game Gear.                                              |
| [`@demake/md`](packages/md)           | A Mega Drive core: a 68000, a VDP, the PSG and the FM chip.                                  |
| [`@demake/snes`](packages/snes)       | A Super Nintendo core, and in `smp.ts` a whole second computer.                              |
| [`@demake/gba`](packages/gba)         | A Game Boy Advance core: an ARM7TDMI, a mode-0 2D engine, both halves of the sound.          |
| [`@demake/nds`](packages/nds)         | A Nintendo DS core — the only one that is _two_ processors.                                  |
| [`@demake/pce`](packages/pce)         | A PC Engine core: a HuC6280 and a VDC.                                                       |
| [`@demake/wsc`](packages/wsc)         | A WonderSwan core, Color and mono, with no video memory of its own.                          |
| [`@demake/ngp`](packages/ngp)         | A Neo Geo Pocket core, mono and Color, with a boot ROM of ours.                              |
| [`@demake/neogeo`](packages/neogeo)   | A Neo Geo core: the LSPC, and a Z80 sound computer on its own bus.                           |
| [`@demake/vb`](packages/vb)           | A Virtual Boy core — the only one that renders _two_ pictures.                               |
| [`@demake/chip`](packages/chip)       | Every sound chip as a register-driven model (doc 16). Depends on nothing.                    |
| [`@demake/audio`](packages/audio)     | The music and sound demakers (docs 16, 17, 18).                                              |
| [`@demake/web`](packages/web)         | The browser app (doc 07): the same core in a worker, no server.                              |

## Develop

Requires Node ≥ 20 and [pnpm](https://pnpm.io) (pinned via `packageManager`).

```sh
pnpm install       # install workspace deps
pnpm build         # typecheck + build all packages (project references)
pnpm test          # unit tests (Vitest)
pnpm lint          # ESLint (incl. custom core rules) + Prettier check
pnpm lint:fix      # autofix
pnpm dev:web       # the web app, against the workspace engine
pnpm test:browser  # Playwright: web flows + browser-vs-CLI byte identity
```

Run the CLI from source after building:

```sh
pnpm cli -- --help
pnpm cli -- prep photo.png -c gbc -o out.png
```

The ROM and emulator suites need their toolchains; both provisioners are cached
and need no Docker:

```sh
pnpm toolchains  # RGBDS, cc65, WLA-DX, m68k + ARM binutils, NASM
pnpm emulator    # SameBoy capturer + libretro cores (fceumm, genesis-plus-gx, snes9x, mGBA,
                 # DeSmuME, beetle-pce-fast, beetle-wswan)
pnpm test        # now includes every ROM + pixel-perfect emulator E2E
```

See [`AGENTS.md`](AGENTS.md) for the full contributor contract and
[`CONTRIBUTING.md`](CONTRIBUTING.md) for setup details.

## License

[MIT](LICENSE) © georgestephenson
