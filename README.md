# demake

> Demake modern game assets — art, and whole games — into something the
> 8/16-bit-era consoles and handhelds could actually run, up to and including the
> Nintendo DS.

`demake` takes ordinary modern inputs and produces things real retro hardware
could display and play, verified on emulated hardware rather than merely
asserted:

| Demaker   | Input                                               | Output                                                                   | Status                                           |
| --------- | --------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------ |
| **art**   | any image                                           | hardware-compliant art, palettes, tile maps, asm/C/binary, bootable ROMs | working                                          |
| **game**  | a [Demotic](docs/14-demotic.md) `.dmt` script + art | one game, every console                                                  | language, preview and a playable Game Boy ROM    |
| **music** | a MIDI track                                        | chip music, audio that sounds exactly like the hardware will, and a ROM  | six consoles; a Game Boy cartridge that plays it |
| **sound** | a WAV effect                                        | a chip sound effect, placed and prioritised, and a ROM                   | six consoles; a Game Boy cartridge that plays it |

Every demaker shares one engine, one determinism guarantee, and one proof: a
real ROM, booted in a real emulator, compared against what the hardware was
asked for. For art that comparison is pixel for pixel; for games it is the
game's own state, tick for tick; for audio it is the stream of register writes
the emulated sound chip actually receives, diffed against the schedule that
produced the audio file — which is exact rather than approximate, because the
compliant artifact _is_ that schedule. The audio ROM is a Game Boy today; the
other consoles' drivers follow.

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
> cross-console test runner, its browser preview — and its first console
> backend. `demake build pong.dmt -o pong.gb` _compiles_ a game to Game Boy
> machine code and demakes its art on the way, the web app builds and plays the
> identical cartridge in the page, and CI proves every example game reproduces
> the reference interpreter's fixed-point state tick for tick. All eight Tier 1
> consoles go image → compliant art → native data → bootable ROM → emulator
> frame, compared pixel-for-pixel in CI. The full design lives in
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
Nintendo DS. Beyond that, support deepens in two steps:

| Capability                                        | Consoles                                                                                                                                                               |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prep` + `inspect` (compliant PNG)                | GB/GBC, NES, SNES, MD/Genesis, SMS, GG, GBA, NDS, SG-1000, PC Engine, Neo Geo, WonderSwan/Color, NGP/NGPC, Virtual Boy, Pokémon Mini, Supervision, Game.com, Mega Duck |
| `gen` (bin/asm/C data + display code)             | GB/GBC, NES, SNES, MD/Genesis, SMS, GG, SG-1000, GBA, NDS, PC Engine, WonderSwan Color                                                                                 |
| `--format rom` + **pixel-perfect emulator proof** | GB/GBC, NES, SNES, MD/Genesis, SMS, GG, SG-1000, GBA, NDS, PC Engine, WonderSwan Color                                                                                 |
| `build` (a Demotic game as a playable ROM)        | GB                                                                                                                                                                     |

"Pixel-perfect emulator proof" means what it says: CI assembles a real ROM,
boots it in an emulator, and asserts the framebuffer matches demake's own output
byte-for-byte across an extensive image battery.

## Packages

| Package                               | What                                                                            |
| ------------------------------------- | ------------------------------------------------------------------------------- |
| [`@demake/core`](packages/core)       | The engine. Zero platform deps, ESM, ships types (doc 09).                      |
| [`demake`](packages/cli)              | The CLI wrapper (doc 05). Re-exports core for scripting.                        |
| [`@demake/demotic`](packages/demotic) | Demotic: the game language, its interpreter, and the ROM builder (docs 14, 15). |
| [`@demake/dmg`](packages/dmg)         | A Game Boy core: the conformance harness, and the web app's player.             |
| [`@demake/chip`](packages/chip)       | Every sound chip as a register-driven model (doc 16). Depends on nothing.       |
| [`@demake/audio`](packages/audio)     | The music and sound demakers (docs 16, 17, 18).                                 |
| [`@demake/web`](packages/web)         | The browser app (doc 07): the same core in a worker, no server.                 |

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
