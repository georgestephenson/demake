# AGENTS.md — working in this repository

Guidance for coding agents (and humans) contributing to demake.
This file is the canonical project-memory file; `CLAUDE.md` is a one-line import
shim so Claude Code reads the same instructions. Keep all guidance here — never
add content to `CLAUDE.md` directly.

## What this is

A tool that **demakes modern game assets** — art, and whole games — into
something 8/16-bit-era consoles and handhelds up to the Nintendo DS could
actually run. Four demakers, sharing one engine and one proof (a real ROM, in a
real emulator, compared pixel for pixel):

| Demaker               | Docs   | State                                                                       |
| --------------------- | ------ | --------------------------------------------------------------------------- |
| art (images)          | 03–06  | working, ten consoles proven on hardware                                    |
| game (Demotic `.dmt`) | 14, 15 | language, interpreter, tests, preview — and playable ROMs on seven consoles |
| music (`arrange`)     | 16, 17 | MIDI → chip music, eight consoles — and a Game Boy ROM that plays it        |
| sound (`sfx`)         | 16, 18 | WAV → chip effects, eight consoles — same ROM, same proof                   |

The four are not four tools that share a repo any more: a `.dmt` says
`music theme.mid` and `sound bounce.wav on ball hits paddle`, and `demake build`
demakes the art, the track and the effects into one 32 KiB cartridge (doc 14
§Sound, doc 16 §Two streams, one clock).

Every domain has the same shape, which is why they share a repo: **constrain →
fit → emit → prove it on emulated hardware**. Each reuses the layer below — a
game's sprites are demade by the image pipeline, its ROM assembled by the same
toolchain edge. The full
design lives in [`docs/`](docs/README.md); the milestone plan is
[`docs/13-roadmap.md`](docs/13-roadmap.md). **Current status: Phase 2 complete;
Phase 3 (web app) shipped** — the Phase-1 engine spine is live (the
deterministic image layer: our PNG codec, color spaces, DAC models, seeded PRNG,
math kernels; the `ConsoleSpec` schema; the tiled-and-mono conversion pipeline
with tournament + judge; the `inspect` compliance oracle). Phase 2 landed the
full proof loop for **all eight Tier 1 consoles**:

- **`prep`/`inspect` for 21 consoles** — every RGB-lattice and mono raster
  platform in doc 03 (GBC/DMG, NES, SNES, MD, SMS/GG, GBA, NDS, PCE, Neo Geo,
  WS/WSC, NGP/NGPC, VB, Pokémon Mini, Supervision, Game.com, Mega Duck) plus the
  SG-1000, through the one generic tiled fitter + mono path + the TMS9918
  Graphics II per-row two-color path (`pipeline/fit-tms.ts`). NES added
  `fixed-master` color, 16×16 attribute cells, and the shared-backdrop constraint.
- **Codegen** (`bin`/`asm`/`c`) for the `gb`, `nes`, `snes`, `sms`, `md`,
  `sg1000`, `gba`, `nds`, `pce`, and `wsc` families, reached via an exact-path
  detector, a manifest sidecar, or implicit `prep`.
- **`--format rom`** builds bootable ROMs for GB (RGBDS), NES (cc65 NROM), SMS +
  GG + SG-1000 (WLA-DX / Z80), SNES (WLA-DX / 65816, LoROM), PC Engine (WLA-DX /
  HuC6280, 64 KiB HuCard), MD/Genesis (GNU m68k binutils), GBA + NDS (GNU ARM
  binutils), and WonderSwan Color (NASM — the V30MZ is an 8086-compatible core).
  The z80/6502/65816/huc6280 assemblers are pinned source builds; the m68k and
  ARM binutils and NASM are stock distro packages (apt, main archive) since
  well-tested ones ship there — all via `pnpm toolchains`, no Docker, and no
  devkitARM/ndstool (demake packs the GBA, NDS and WonderSwan cartridge headers
  itself).
- **Pixel-perfect emulator E2E** for every Tier 1 console plus the PC Engine and
  WonderSwan Color — GB/GBC (SameBoy) and NES + SMS + GG + MD + SG-1000 + SNES +
  GBA + NDS + PCE + WSC (libretro cores via one generic `emu-harness/libretro/`
  runner) — all marching through the same shared extensive image battery
  (`packages/cli/test/_emu-battery.ts`).

Phase 5 then opened Tier 2 with the **PC Engine** and the **WonderSwan Color**,
both riding that same loop end to end (`wla-huc6280` on the existing WLA-DX
build and beetle-pce-fast; NASM and beetle-wswan). Doc 13 §Phase 5 records what
blocks each remaining Tier 2 console — including that the mono WonderSwan is
blocked on a _tiled-mono fitter_, not on a toolchain, and that its current spec
is optimistic about what that hardware can display.

Phase 7+ then opened the **Demotic backend**: `demake build` _compiles_ a `.dmt`
into a real 32 KiB Game Boy cartridge — SM83 machine code written for that game,
with the art it names demade by the image pipeline on the way — and the web app
plays it in the page. There is no fixed engine and nothing is patched: the
assembler is ours and written in TypeScript (`packages/demotic/src/codegen/`), so
the browser produces byte-identical cartridges with no toolchain. Every game in
the example library is proven against the reference interpreter tick for tick by
`packages/demotic/test/rom.test.ts`.

**And it builds in colour.** `demake build -c gbc` produces a real Game Boy
Color cartridge: the same machine code with a second half bolted to the
renderer — an attribute byte per background cell in VRAM bank 1, eight
background and eight object palettes of RGB555, a tile bank that may spill into
the second bank — with the art demade through the image engine's RGB-lattice
path, colour sprites included (`packages/core/src/pipeline/sprite.ts`). A game
traces identically on both consoles, and `rom.test.ts` runs the whole example
library on both to say so. `@demake/dmg` is both machines too, decided by the
cartridge header, so the DMG shows the authentic green LCD ramp and a `gbc`
build comes up in colour.

**And it builds for the Sega 8-bits, with sound.** `demake build -c sms` and
`-c gg` produce real mapper-less cartridges — Z80 machine code with the art demade
into a shared 4bpp bank the boot code uploads to video RAM, and the music and
effects demade by the same audio engine and played by a **generated Z80 driver**
(`packages/audio/src/rom/sms-driver.ts`, `sms-game.ts`) — and the whole example
library traces identically on both, in the same battery, at the same one frame per
tick. Two consoles from one backend: a Game Gear is a Master System with a smaller
window and wider colour entries, so the machine code is the same and only the
visible cell count, the palette upload and one audio register differ. The page
plays them too.

Three things about the sound are this chip's rather than the Game Boy's or the
NES's restated. The **channel is in the data byte and it is latched**, so
`packScript`'s `channelOf` is a factory for a tag carrying a per-schedule latch,
and preemption skips whole runs — safe because every run opens with a latch byte,
which `E_PSG_LATCH` refuses a schedule for violating. The **shared register exists
on only one of the two machines**: a Master System has nothing two streams both
write and emits no merge at all, while a Game Gear's stereo latch is `NR51`'s
exact shape and is merged the same way. And the **clock is the frame**, at 59.92
Hz, because this VDP reloads its line counter outside the active display — a line
interrupt is a raster effect, not a tempo.

**And it builds for a Super Nintendo.** `demake build -c snes` produces a real
64 KiB LoROM cartridge — 65816 machine code written for the game, a Mode 1
background demade into 4bpp tiles across seven sixteen-colour sub-palettes, and
tile art in a _second cartridge bank_ that no instruction ever addresses because
it reaches video RAM by DMA — and the whole example library traces identically
there too, in the same battery, at the same one frame per tick. The page plays it
in `@demake/snes`, the fourth self-hosted core.

This is the first console that is bigger than the language needs, and what it
changes is the _size_ of the backend rather than its shape. With `M` clear the
accumulator is sixteen bits, so a 16.16 add is two `lda`/`adc`/`sta` triples
where the 6502 needs four; the index registers are sixteen bits with it, so
`$nnnn,x` reaches all of bank zero and a shared helper is handed an address in
`X` rather than through a pointer somebody had to write first. `codegen/snes/` is
about two thirds of `codegen/nes/` for the same games. The bill is a discipline
neither 8-bit backend has — **the width flags are part of the machine state a
label promises** — and §The 65816 half is where it is stated.

**And it has sound, which here is a whole second computer.** The S-SMP is an
SPC700 with its own 64 KiB, its own timers and no access to the cartridge, so
`demake build -c snes` emits _two_ programs: 65816 for the game, and an SPC700
driver (`packages/audio/src/rom/spc-driver.ts`, `spc-game.ts`) that the cartridge
uploads through four mailbox bytes at boot. After that the game posts two request
bytes and carries on. Three things follow and none of them is true of any other
console here. The **clock is the sound processor's own timer** — an 8 kHz
prescaler over an eight-bit divisor, so 125 Hz is exact and a frame the game
overruns costs it no tempo. The **shared register is a pulse**: `KON` starts the
voices whose bits are set and does nothing to the rest, so preemption is one
`and` against a per-stream `own` byte rather than two shadows folded together.
And the **chip plays samples rather than generating them**, so a schedule is only
half an artifact — the waveform bank in `binding/sdsp-bank.ts` is the other half,
and `render()` puts it behind the model so the WAV and the cartridge sound the
same.

**And it builds for a second machine.** `demake build -c nes` produces a real
NROM cartridge — 6502 machine code written for the game, its art demade for a
fixed master palette and 16×16 attribute cells — and every game in the example
library traces identically there too, in the same battery, at the same one frame
per tick. What the second console changed is the shape of the first: compiling a
Demotic program is now an **interface** (`codegen/backend.ts`) that a console
implements, and what a program _means_ is shared (`codegen/shape.ts`), so the
only thing a backend owns is its instruction set.

**And one machine cost almost nothing, which is the point.**
`demake build -c megaduck` produces a real Mega Duck cartridge, and it is not a
backend: the console is a Game Boy clone whose I/O pins were rewired, so what it
added was a _machine description_ — a register page (`core/src/asm/megaduck.ts`),
a permuted `LCDC`, an entry point at `$0000` and no cartridge header — and not
one instruction. The whole example library traces identically on it, in the same
battery, and its audio is the same `@demake/chip` APU reached through a different
address, proven by the same register diff. Doc 13 §Console rollout costs the rest
of the consoles on those terms: the CPU is usually the cheap part, and what
actually decides the price is whether the machine has a tilemap, a scroll
register and hardware sprites.

**And it has sound.** The NES's music and effects are demade by the same audio
engine and played by a **generated 6502 driver** (`packages/audio/src/rom/nes-driver.ts`,
`nes-game.ts`) — the SM83 driver's counterpart, sharing the packed format and
nothing below it. Two things are the console's rather than the Game Boy's
restated: the clock is the picture's own interrupt, because a 2A03 has no timer a
driver can have without burning the DMC channel, so a game's audio runs at the
frame rate and not at 120 Hz; and the shared register is `$4015`, whose four
enable bits _are_ the four channel bits, so the merge is two `and`s and clearing
a bit is also how a channel is silenced. `packages/demotic/test/audio.test.ts`
runs its whole battery on every machine with a driver, tick for tick, with no
tolerance.

**And the page plays it, with sound.** The console selector in the web app's game
section changes the _cartridge_: pick NES and the browser compiles 6502, demakes
the art for that machine and boots the result in `@demake/nes` — byte-identical
to `demake build -c nes`, pinned by `determinism.spec.ts` on every console with a
backend (doc 07 §Playing the real ROM in the page) — and the sound button plays
whichever chip the running core has, through the same `StreamSink`. The Sega
consoles included, now that the SN76489 has a driver: the button is no longer
withheld anywhere.

Still to come: the remaining Tier 2/3 consoles (each = a codegen backend, a ROM
harness + toolchain, and a libretro core + DAC calibration), the remaining
framebuffer/scanline layout paths (Lynx, GBA/NDS bitmap modes, 2600/7800), and
the rest of the Demotic runtime story (the Mega Drive's 68000 and the speed work
doc 14 §Runtime model names).

**The audio spine is built, and two consoles boot** (docs
[16](docs/16-audio-engine.md), [17](docs/17-music-demaker.md),
[18](docs/18-sound-demaker.md)): `@demake/chip` models the Game Boy APU, the
SN76489, the NES 2A03 and the Super Nintendo's S-DSP; `@demake/audio` holds both
demakers; and `demake arrange`, `demake sfx` and `demake render` work for `dmg`,
`gbc`, `megaduck`, `nes`, `sms`, `gg`, `sg1000` and `snes`. A track becomes a
`.vgm` plus a WAV that is exactly what the schedule produces — or, on the one console whose
chip plays samples rather than generating them, an `.spc`, which is a snapshot of
the sound processor's RAM and therefore exactly what a cartridge uploads.

`demake gen <schedule> -c dmg --format rom` then turns that schedule into a real
32 KiB cartridge, with an SM83 driver **generated for it** — no fixed player, no
checked-in harness, no toolchain — and **doc 16's Level A proof runs in
`pnpm test`**: the ROM boots in `@demake/dmg`, whose APU is now `@demake/chip`'s,
and every register write it makes is diffed against the `ChipScript` tick for
tick, with no tolerance (`packages/audio/test/rom.test.ts`). That is the audio
counterpart of the pixel-perfect emulator E2E, and it is sharper, because the
artifact _is_ the schedule.

`demake build` then puts that driver _inside a game_: a track per scene, an
effect per event, one clock serving both, and the same proof one level up —
`packages/demotic/test/audio.test.ts` boots a cartridge that is playing a game
and diffs every register write against the schedules the demakers produced. It
does that on **every** console the game backend builds for, over four drivers
that share only the packed format: an SM83 player on a programmable timer, a 6502
and a Z80 player on the picture's interrupt, and an SPC700 player that is not on
the console's processor at all.

**And both demakers are on the web** (doc 07 §The audio sections): a music
section and a sound section over their own worker, carrying the whole
`arrange`/`sfx`/`render` flag surface — roles and drops per part, the channel
plan as a piano roll, the tournament as a strategy picker — and handing back the
`.vgm`, the `--emit-manifest` sidecar, the sample-exact WAV and a cartridge, all
four pinned byte-identical to the CLI's by
`packages/web/test/e2e/determinism.spec.ts`.

Still to come for audio: `bin`/`asm`/`c` emit, a _standalone_ audio cartridge for
anything but the Game Boy (the NES and the Sega 8-bits have drivers, but only
inside a game; the Super Nintendo's driver writes an `.spc` rather than a
cartridge), driver backends for the remaining consoles (each needs a CPU
encoder or a checked-in driver source, plus a core to prove it in), Level B sample
comparison, the remaining chips (YM2612, the handhelds), tracker and
lossy-audio input with the transcription front end, and FLAC/M4A export. Read doc
16 before touching any of it — several of its decisions are load-bearing and easy
to undo by accident (§Working on audio).

## Layout map

```
packages/core/       @demake/core — the engine (zero platform deps; ESM; ships types)
  src/asm/           the SM83, 6502, Z80, 65816 and SPC700 assemblers + the GB,
                     iNES, Sega and LoROM cartridge wrappers — shared by the
                     Demotic game backends and the audio drivers, so no backend
                     owns the encoder for its own CPU. megaduck.ts is the Mega
                     Duck's I/O map, here because three things read it (the core,
                     the audio driver, the game backend). The SPC700 is the odd
                     one out: it is nobody's main processor, and the only thing
                     written in it is a sound driver
  src/math/          deterministic kernels (exp/log/pow/cbrt/sin) + PCG32 PRNG
  src/parallel/      the executor seam: work described as jobs, run wherever the
                     edge says. `jobs.ts` is the contract and the inline runner
                     (the reference answer); `pool.ts` is the scheduling every
                     edge shares — core supplies no threads and never will
  src/color/         sRGB/linear/Oklab, hardware-lattice snapping, color parsing
  src/image/         PNG codec (inflate/deflate/decode/encode), DAC models, decode dispatch
  src/consoles/      ConsoleSpec schema + one declarative spec per console (21 of them)
  src/pipeline/      stages 0–7, the tiled fitter, mono + TMS row-pair paths, tournament
  src/pipeline/candidate.ts  one candidate, start to finish — the unit of parallel
                     work, and the content-keyed prologue memo that stops a
                     fan-out decoding its source once per candidate
  src/codegen/       gen: per-family backends (gb, nes, snes, sms, md, sg1000, gba, nds, pce, wsc), detector
  src/image/svg/     our SVG rasteriser: XML, shapes, paint, scanline fill (doc 15 step 2)
  src/pipeline/sprite.ts  object + tile art for games: transparency, shades or
                     sub-palettes (the colour fit decides which assets share one), dedup
  src/inspect/       compliance oracle (inspect) + fidelity judge
packages/cli-spec/   @demake/cli-spec — single source of truth: spec → parser, help, man
packages/cli/        demake — thin CLI over core; re-exports core for scripting
  src/rom/           edge: assemble `--format rom` per family (RGBDS / cc65 / WLA-DX / m68k / ARM / NASM).
                     registry.ts is the one list of families that build, read by
                     the dispatch and by the support matrix
  src/parallel/      edge: the `worker_threads` pool `--jobs` spends. A lane owns a
                     thread; the scheduling is core's, shared with the web app's
  src/support.ts     the console support matrix, derived from four registries —
                     the only place that sees all four domains at once
  man/               generated roff man pages (never hand-edited)
rom-harness/{gb,nes,snes,sms,md,sg1000,gba,nds,pce,wsc}/  the display programs `gen --format rom` assembles
emu-harness/gb/      SameBoy headless capturer for the GB pixel-perfect E2E (doc 10)
emu-harness/libretro/  generic retrorun frontend — one capturer for every libretro core
tools/toolchains/    provisioners (cached): RGBDS, cc65, WLA-DX, SameBoy source builds;
                     GNU m68k + arm-none-eabi binutils and NASM (apt); libretro
                     cores (fceumm, genesis-plus-gx, snes9x, mgba, desmume,
                     mednafen_pce_fast, mednafen_wswan)
packages/nes/        @demake/nes — a self-hosted NES core, for the two jobs
                     @demake/dmg exists for: the conformance harnesses in Vitest
                     and (later) the page's player. Its APU is @demake/chip's
                     2A03. Its PPU enforces eight sprites a scanline and takes a
                     background palette from a 16x16 attribute cell, because
                     those are the constraints the compiler's warnings and the
                     art path are written against
packages/dmg/        @demake/dmg — a self-hosted Game Boy core, DMG *and* CGB *and*
                     Mega Duck: the Demotic and audio conformance harnesses in
                     Vitest, and the web app's in-page player (doc 07: no CDN).
                     Which *Game Boy* it comes up as is the cartridge header's
                     decision, never a setting; the Mega Duck is a constructor
                     argument, because that console's cartridges have no header.
                     Its APU is @demake/chip's, not a second one, and `audioSink`
                     is where its output goes
packages/sms/        @demake/sms — a self-hosted Sega 8-bit core, Master System *and*
                     Game Gear, decided by the cartridge's region nibble the way
                     @demake/dmg is decided by its header. Mode 4 only: the SG-1000's
                     Graphics II is a different renderer, not a flag on this one. Its
                     PSG is @demake/chip's SN76489
packages/snes/       @demake/snes — a self-hosted Super Nintendo core: a 65816 whose
                     registers change width at run time, a Mode 1 S-PPU with BG1
                     and the object layer, and — in `smp.ts` — a whole second
                     computer: an SPC700 with its own 64 KiB, three timers, and a
                     boot ROM of *ours* that speaks the documented upload
                     handshake rather than transcribing Nintendo's. Its S-DSP is
                     @demake/chip's, not a second one
packages/demotic/    @demake/demotic — Demotic, the `.dmt` game language (docs 14, 15)
  src/lang/          lex → parse → flat statement AST (one statement per line, no nesting)
  src/lang/highlight.ts  TextMate scopes for `.dmt` source — the registry's words,
                     the lexer's boundaries, and no colours (those are the page's)
  src/compile.ts     AST + console profile → resolved Program tables (constants folded)
  src/sim.ts         the reference interpreter — the semantic definition of the language
  src/level/         .dmtl levels: parse, camera + tile collision, `stream` composition
  src/rng.ts         the game's seeded generator — one definition, shared build and run
  src/testing/       .test.dmt: assertions run against every console at once
  src/trace.ts       state traces: the cross-implementation conformance oracle
  src/rom/           the console hand-off: table format, expression bytecode, the
                     built-in tile bank and the trace readers
  src/codegen/       the console backends and what they share:
    backend.ts       the contract — the six questions a console answers, the
                     build's order, and doc 14's seven tick steps in one function
    shape.ts         what both backends decide identically: scene membership,
                     mutability questions, a tick of movement, the level tables.
                     Anything that would emit an instruction is *not* here
    layout.ts        one RAM allocator over a per-console MemoryPlan (8 KiB of
                     work RAM, or a console with 2 KiB and no cartridge RAM)
    registry.ts      which backend builds which console; the CLI reads this
    gb.ts, emit/rules/expr/val/tiles.ts   the SM83 backend
    nes.ts, nes-art.ts, nes/              the 6502 backend and its image path
    sms.ts, sms-art.ts, sms/              the Z80 backend and its image path
    snes.ts, snes-art.ts, snes/           the 65816 backend and its image path
    audio.ts         the hand-off to @demake/audio, art.ts's twin
  demo/              terminal runner (play.mjs) and test runner (test.mjs)
packages/chip/       @demake/chip — every sound chip as a register-driven model (doc 16)
  src/gb-apu.ts      Game Boy APU: 2 pulse + wave + noise, envelopes, panning
  src/sn76489.ts     the SMS/GG/SG-1000 PSG: no envelopes, ~109 Hz pitch floor
  src/nes-apu.ts     the 2A03: volume-less triangle, non-linear mixing
  src/s-dsp.ts       the Super Nintendo's: eight sample-playing voices, BRR
                     decoding, ADSR and GAIN, and a pitch register that
                     *multiplies* where every other chip here divides. Echo and
                     pitch modulation are absent rather than half-implemented
  src/mix.ts         exact box-integration render, DC block, the one renderer
  src/stream.ts      the same renderer for a chip that is still running: the
                     ring buffer the web app's ROM pane plays from
packages/audio/      @demake/audio — the music + sound demakers (docs 16, 17, 18)
  src/score/         Score: the hardware-free representation, and the MIDI parser
  src/analysis.ts    roles, salience, sections, loop choice
  src/arrange/       assignment, exchange refinement, and the schedule compiler
  src/binding/       per-console register encoders + the driver-rate fits
  src/timing.ts      absolute row placement: the tempo guarantee lives here
  src/sfx/           gesture families, class gate, hardware-in-the-loop fitting
  src/rom/           the console hand-off: schedule packing (data.ts, shared) +
                     a generated driver per CPU (doc 16). SM83: one stream player
                     (gb-driver.ts), two callers — the cartridge (gb.ts) and the
                     driver a game embeds (gb-game.ts). 6502: nes-driver.ts and
                     nes-game.ts; Z80: sms-driver.ts and sms-game.ts. SPC700:
                     spc-driver.ts and spc-game.ts, and it is the one that does
                     not run on the console's own processor — what it builds is a
                     block to *upload*. gameDriverRate says which clock a game's
                     driver rides on a console
  src/binding/sdsp-bank.ts  the Super Nintendo's built-in waveforms: single-cycle
                     BRR blocks, one definition read by the binding (which puts
                     one in a voice's SRCN) and the driver (which uploads them)
  src/dsp.ts         deterministic FFT/resampler/pitch, all on core's kernels
  src/manifest.ts    the --emit-manifest sidecar: one shape, two callers (CLI, web)
  src/render.ts      ChipScript → PCM; the only way anything makes sound
packages/web/        the site (doc 07): one shell over five sections, all but the
                     art demaker code-split
  src/worker/        core.worker.ts (images *and* game cartridges) and
                     audio.worker.ts (music + sound): the only places the page
                     touches an engine, and the only places @demake/core is
                     bundled — a second copy is what the JS budget notices. Extra
                     instances of core.worker are the pool lanes, which is why
                     they cost nothing to download
  src/sections/      the lazy sections; art's panes live in src/components/
  src/lib/           option records ⇄ engine options ⇄ equivalent command line,
                     the bundled demo library, and audio-player.ts (playback only)
tools/eslint-rules/  custom ESLint rules: platform-purity + determinism
tools/ci/            CI guards: E2E prerequisites, web JS budget, and
                     affected.mjs — which gates a change can break, read off the
                     workspace graph rather than a hand-written path list
docs/                the design plan; source of truth for decisions
```

Packages not yet created (desktop, testdata) arrive in later phases per doc 02.

## Golden commands

```sh
pnpm install       # install workspace deps (Node >= 20, pnpm pinned via packageManager)
pnpm build         # typecheck + build all packages (tsc project references)
pnpm test          # Vitest unit suite
pnpm lint          # ESLint (incl. custom core rules) + Prettier check
pnpm lint:fix      # autofix ESLint + Prettier
pnpm changeset     # add a changeset for a user-visible change
pnpm cli -- --help # run the built CLI from source (build first)
pnpm gen:man       # regenerate man pages from cli-spec (build first; CI checks staleness)
pnpm eval:prep     # prep quality battery: scoreboard + side-by-side sheets (build first)
pnpm play          # Demotic: play the Pong fixture in a terminal (build first)
pnpm test:dmt      # Demotic: run the .test.dmt suite on every console (build first)
pnpm gen:demotic-docs  # regenerate the language reference from the registry (build first)
pnpm gen:console-docs  # regenerate docs/console-support.md from the registries (build first)
pnpm cli -- build packages/demotic/fixtures/pong.dmt -o pong.gb  # a playable cartridge
pnpm cli -- build packages/demotic/fixtures/pong.dmt -c nes -o pong.nes  # the same game, 6502
pnpm cli -- build packages/demotic/fixtures/pong.dmt -c snes -o pong.sfc # the same game, 65816
pnpm dev:web       # run the web app against the workspace core (build core first)
pnpm build:web     # typecheck + bundle the web app into packages/web/dist
pnpm test:rom-e2e  # just the emulator E2E suites (needs toolchains + emulator)
pnpm test:browser  # Playwright: web functional + browser-vs-Node determinism
pnpm check:web-budget  # assert the app's gzipped JS stays under the doc-07 budget
pnpm toolchains    # provision every assembler `gen --format rom` needs (cached)
pnpm emulator      # provision the SameBoy capturer + libretro cores for the E2E
```

## Iron rules

- **`core` stays platform-pure**: no `fs`/`Buffer`/DOM, no Node built-ins.
  I/O lives at the edges (CLI/web/desktop). Lint enforces (doc 02).
- **`core` stays deterministic**: no wall clock (`Date.now`, `new Date`), no
  `Math.random`, and no `Math.*` transcendentals — use the in-house math kernels
  (`packages/core/src/math/kernels.ts`). Lint enforces (doc 02 §Determinism).
- **Output-byte changes** require re-baselined goldens **+ a `minor` changeset +
  a release-note line, all in the same PR** (doc 09 §Stability). Patch releases
  never change output bytes.
- **How many cores ran a tournament is never an input** (doc 04 §Running the
  tournament). Candidates are spread over an `Executor` the edge supplies, and
  the winner is reduced in _portfolio_ order — so `--jobs 1` and `--jobs 16` write
  the same file, and lane count appears in no manifest and no `--json`. Two things
  follow and are easy to undo by accident: an executor must resolve one outcome
  per job **in the order the jobs were given**, and a reduce must walk the
  candidate list rather than arrival. The k-means restart loop inside a single fit
  shares one PRNG stream and is deliberately _not_ parallel — spreading it would
  change the draw order, which is an output-byte change rather than a speed-up.
- **`packages/cli-spec` is the only place flags are defined** (doc 05); the
  parser, `--help`, and man pages are generated from it. Man pages are never
  hand-edited — run `pnpm gen:man` and a test enforces they match the spec.
- **What each console supports is derived, never written down.**
  `docs/console-support.md` is generated by `pnpm gen:console-docs` from the four
  registries that decide it — the console specs, `cli/src/rom/registry.ts`,
  `demotic/src/codegen/registry.ts` and the audio driver table — and
  `packages/cli/test/support.test.ts` fails if it goes stale. Never state a
  console's support level in prose: prose drifts, and this one had (eight specs
  claimed a `rom` format with no builder behind it). Doc 03 §Support explains
  what the columns mean and what _supported_ is.
- **Language changes are the maintainer's call, not the agent's.** Adding,
  removing or altering a Demotic statement, property, unit, builtin, trigger or
  diagnostic — anything in `packages/demotic/src/lang/spec.ts` — needs the
  maintainer to agree the design _before_ it is implemented. Propose options and
  their trade-offs and wait. Finding a limitation while writing an example is
  expected and welcome; quietly fixing it by growing the language is not. Bug
  fixes that restore documented behaviour are not language changes.
- **`packages/demotic/src/lang/spec.ts` is the only place the language surface is
  defined**, the way `packages/cli-spec` is for the CLI (doc 05). The parser, the
  compiler, the diagnostics and the reference documentation are all generated
  from or checked against it; a test fails if the docs go stale. Never describe a
  language feature in prose that is not in the registry.
- **Demotic describes the game; the Demakefile describes the build** (docs 14,
  15). A `.dmt` file must never name a console, a palette, or a pixel, and a
  Demakefile must never change how the game plays. The operational test is a CI
  property: `demake trace` for a given (console, region) is byte-identical with
  and without a Demakefile. Region is a _profile selector_, not an override.
- **Demotic simulates constrained and renders unconstrained** (doc 14): state is
  16.16 fixed point on a fixed logical tick, identical in the preview and (later)
  on hardware; only rendering is free. Never "improve" the simulator with floats,
  a variable timestep, or host RNG — that turns the preview from a specification
  into a second, disagreeing implementation. Golden traces
  (`packages/demotic/fixtures/*.trace`) are output bytes under the rule above.
- **A game compiles to machine code; there is no fixed engine.** `demake build`
  generates SM83 for _this_ game and assembles it with our own TypeScript
  assembler, which is what lets the browser produce byte-identical ROMs with no
  toolchain (doc 13 §D5). Doc 14 §2 records the reversal and the measurement —
  don't reintroduce a table interpreter without reading it.
- **Unused features must leave no trace in the ROM.** Helpers are _pulled_, never
  pushed: `ctx.need(name, body)` is the only way a routine reaches the output, so
  a game that never divides ships no divider. Never add a routine unconditionally
  and never build a list to prune afterwards — a prune can miss, reachability
  cannot.
- **Art is demade by the image engine, never by the game code.** A build hands
  the source bytes to `@demake/core`; everything about pixels is decided in
  `packages/core/src/pipeline/sprite.ts` and the `prep` pipeline. A second
  converter in `@demake/demotic` is how the browser and the CLI stop agreeing.
  What a console's art module _may_ decide is what the hardware imposes — which
  pattern table a tile goes in, how much of the bank is free, that a 16×16
  attribute cell means level art gets one palette — and it says so by passing
  `maxTiles`/`maxPalettes` into the engine rather than trimming a finished
  conversion.
- **A build's only lever on a picture is the budget, so spend the hardware on
  it.** The cartridge's backdrop is `prep`'s backdrop at the budget it was given,
  and `nes-rom.test.ts` proves it cell by cell — so quality is decided entirely by
  how many patterns and palettes the build can hand over. On the NES that meant a
  pattern table per picture (`PPUCTRL` bit 4 chooses which one the background
  reads), a built-in bank pulled down to the characters a program actually writes
  (64 patterns to ~27), and no reserved sub-palette — a caption takes a colour slot
  the fit left empty, since a glyph cell shows only the universal backdrop and its
  ink. Together: 96 patterns to 201–231, three sub-palettes to four, and the
  shooter's title screen from 216 merged cells to none. Look for the same kind of
  headroom before touching a fitter: an under-fed fit looks like a bad fit.
- **A picture costs program space as well as patterns, so it is packed.** An NES
  nametable is 960 cells against a 32 KiB cartridge with no mapper, and two raw
  ones were six per cent of the program — which is what nearly stopped the shooter
  fitting once it had music. Cells and attributes go in as literals and runs
  (`packCells`) and come out through one walk with rendering off, at 279–682 bytes
  a picture. The encoding is never the contract: what is guaranteed is the bytes
  that reach the PPU, so `nes-rom.test.ts` boots the cartridge and reads the PPU's
  own memory rather than checking the format. The Sega name tables pack the same
  way and the packer is a separate one, because an entry there is _two_ bytes —
  a run of identical cells is `T A T A T A` and has no byte runs in it at all.
- **When several pictures share a bank, share it on what they ask for.** A
  conversion reports what it _wanted_ as well as what it took
  (`stats.uniqueTiles + stats.tileMerges`), because `maxTiles` reaches the
  pipeline after the fit — so a build can demake every picture against an even
  split, read the demands off, and hand the bank out max-min fair without a
  second tournament for anything whose share would not change its fit. Dividing
  the bank evenly and leaving it there is what merged the letters of BREAKOUT
  into each other on a Master System: the title screen wanted 229 tiles of the
  183 free and the court wanted 21, so half each starved one to reserve seventy
  the other never asked for. Never allocate to the pictures before they have said
  what they cost.
- **And music and effects are demade by the audio engine, the same way.** The
  same `assets` map carries `.mid` and `.wav` bytes, `codegen/audio.ts` hands
  them to `@demake/audio`, and the driver that plays them is `@demake/audio`'s
  too. `@demake/demotic` owns no notes, no registers and no second arranger.
- **One list says which consoles build.** `codegen/registry.ts`; the CLI, the
  conformance suite and (later) the web app all read it. A second list of
  "supported" ids is a list that falls out of step.
- **A backend gap is a build error, never a silent difference.** If the backend
  cannot do what a `.dmt` asks for, `unsupportedFeatures` names it and the build
  stops. A cartridge that plays a different game from the preview would make the
  trace oracle report a divergence three layers from its cause.
- **`CLAUDE.md` stays a pure `@AGENTS.md` import** (CI-checked, doc 12).
- **Commands named in this file must exist as `package.json` scripts** (CI
  staleness check, doc 12) — update both together.

## Working on Demotic

- **Two unit systems, and the choice is semantic** (doc 14 §3). `1 cell` is
  absolute; `15vw` is 15% of the playfield. Absolute where a thing _is what it
  is_ everywhere (a one-tile ball); relative where it must stay _balanced_ (a
  paddle covering a sixth of the wall, a rally taking the same seconds). Sizes
  quantise to whole cells; speeds and positions do not. `vmin` for anything that
  must stay square — the consoles do not share an aspect ratio.
- **Level rules are continuous, so prefer proportional control to on/off.**
  `when always (…) as clamp(error / gain, -1, 1)` eases in and lands on target;
  on/off steering overshoots by a tick every tick and buzzes, and a dead zone
  wide enough to stop that makes it lurch instead. Both failure modes show up as
  stop/start events, which `sim.test.ts` bounds.
- **Hardware traps are compile errors, not emulator surprises** (doc 14
  §Diagnostics): sprite budgets, tunnelling, sub-tick speeds, offscreen starts,
  aspect mismatch, size rounding. Adding a new class of known trap means adding a
  diagnostic, not a doc note.
- **The language never resolves an ambiguity quietly** (doc 14 §The readings the
  language will not guess between). A comment needs a space before it, because
  `y--1` is `y - -1` to a reader and a truncated statement to the lexer; a word
  glued to a number is a misspelled unit, not two tokens; and setting one thing
  twice — a property in a list, a property from a button, a camera in a scene —
  is an error, never last-write-wins. These parse fine under the obvious reading,
  so nothing downstream can catch them: the program is simply not the one in the
  file. When a new construct has two readings, reject it rather than pick one.
- **`hits` fires once per contact; `touches` fires every tick of it.** Bounces
  want the first, resting contact wants the second — a platformer that lands with
  `hits` accumulates gravity into `ydirection` while standing still, and looks
  fine until the next jump. `reaches` is a _crossing_ detector so it works on
  counters that fall as well as rise.
- **`visible 0` is inert**: not drawn, not collided with, not moved. That is why
  there is no `destroy` — and why separation re-checks it: a rule that collects a
  coin by hiding it has said so _before_ the push-apart runs, so the player must
  not be shoved off a thing that no longer exists.
- **A `number` with `visible 0` is how a game holds a plain value.** It is not
  drawn, not collided with and not moved, so it is a variable in everything but
  name — the platformer's `footing`, the shooter's `fired`, pong's `aim`. When
  one of those reads correctly it is because of _tick order_: cleared by a level
  rule (step 3), set by the collision or tile phase (steps 5–6), read by an edge
  rule (step 7). Writing the three rules in the wrong phase is the way to get a
  flag that is always false.
- **A jump needs a `when a pressed if` rule, not a `control`.** Controls run at
  the top of the tick, before anything has been collided with, so a control
  cannot ask whether there is ground underfoot — and a jump that cannot ask is a
  jump you can press forever.
- **A scene's playfield is its level's size, or the screen's** (doc 14 §Levels).
  So `screenright` means the end of the _level_, object positions are level
  coordinates, and the camera is the only thing that knows where the view is —
  which is the whole reason scrolling does not infect every rule. A game with no
  level is unchanged, because its playfield is still exactly the screen.
- **Tiles collide on the same two conditions objects do**: a rule has to name the
  pair, and separation happens only for `solid` ones. A tile no rule mentions is
  scenery. Tiles have no `visible`, so they cannot change — a thing that must
  vanish is an object.
- **Levels are composed at build time, never generated at run time** (doc 14
  §Composed levels). `stream` draws chunks from the program's `seed` and emits an
  ordinary tilemap, so the simulator, the camera and a console runtime need no
  notion of streaming and a trace stays a trace. Generating the course as the
  player flies would be reproducible only if every machine drew in the same order
  at the same tick.
- **`random` draws from `src/rng.ts`, never from the host.** The generator is
  part of the language because two implementations that disagree about it cannot
  be compared at all. Drawing advances it, so _when_ a draw happens is behaviour:
  it cannot fold into an initial value, and a `.test.dmt` assertion may not call
  it. The seed is a `.dmt` statement and never a Demakefile setting — a different
  seed is a different game.
- **A `sound` fires on a rule's trigger, and `touches` is the wrong one.** A
  level trigger fires every tick of the contact, so a one-shot hung on it
  restarts every tick and stutters; bounces and pickups want `hits`. And a
  `sound` whose trigger exactly matches an existing rule is _merged into it_ by
  the compiler — same tick either way, and the difference between thirty bytes
  and four and a half kilobytes when the trigger is a collision over nine aliens.
- **A wide object is a relative size the per-scanline sprite budget will not pay
  for.** Eight sprites to a scanline is the limit on the NES and both Sega
  8-bits — ten on a Game Boy, thirty-two on a Super Nintendo — and an object `w`
  cells wide costs `ceil(w)` of them on every line it covers. So a `55vw` platform is eleven sprites on a Game
  Gear and eighteen on a Master System, and the hardware simply stops drawing
  after the eighth: the platformer's floor lost its right-hand third, and the hero
  stepping into that row pushed one more off. Anything that has to span the screen
  belongs in the backdrop or a level, and anything an object draws is sized in
  _cells_ so the count does not grow with the screen. `E_SPRITE_BUDGET` counts a
  scene's total and not its worst line, so this one is still found by looking.
- **Audio costs cartridge the way a backdrop costs tiles.** A track is a few
  kilobytes of register schedule on a machine with 32 KiB and no mapper, which is
  why the shooter's theme is two bars and the platformer's is eight. Every
  fixture is held above a kilobyte of headroom by `audio.test.ts`, because a
  fixture built to the last hundred bytes turns the next codegen change into a
  mystery.
- **And it costs more on the NES, which is why the shooter does not fit there.**
  The audio itself is _cheaper_ on that machine — 1742 bytes against the Game
  Boy's 2076 for the shooter, because the driver ticks at 60 Hz rather than 120 —
  but the game around it is not: the same program's 6502 code is about 3.8 KiB
  larger than its SM83 code, and a backdrop is a 960-cell nametable against 360.
  The shooter's NES cartridge is under two hundred bytes over with its music in it, and
  `audio.test.ts` _asserts_ the overflow rather than skipping the fixture, so a
  codegen change that wins the bytes back fails the test and someone moves it
  into the sweep. The obvious place to look for them is the backdrop nametable,
  which is stored raw.
- **New language features come from the example library, not from theory**
  (`packages/demotic/fixtures/games/`). Each example is there for something the
  others do not exercise; `touches`, the `reaches` crossing rule and `visible`'s
  collision meaning were all found by writing one.
- **The examples are the shop window: keep them spare** (doc 14 §The example
  library). The web app shows a game's source beside the cartridge it built, and
  the claim is that a whole game is sixty lines — an example whose commentary
  outweighs its code argues the opposite. A comment earns its place only where
  the line above it cannot be read without one (tick order, an absolute unit
  chosen over a relative one, `touches` where `hits` looks right); everything
  else belongs here or in doc 14, where it can be longer. Section rules stay
  short enough not to wrap in the page's editor.
- **The syntax highlighter is generated from the registry too.**
  `lang/highlight.ts` scopes source with TextMate names and takes every word it
  knows from `spec.ts` and every boundary from `lex()` — so a new keyword must be
  added to `KEYWORDS` (a `spec.test.ts` check enforces it against the syntax
  lines) and is then coloured for free. Never colour by regular expression: `--`
  is a comment or two minus signs depending on what precedes it, and the lexer is
  where that is decided once.
- **A `.dmtl` grid is literal.** Every line after `map` is a row, blank ones
  included, and the only exception is the empty string a terminating newline
  leaves behind. Treating a blank line as a separator moves every row below it up
  one, which silently corrupts the shape the format exists to preserve.
- **`.test.dmt` suites run on every console.** That is what makes a _balance_
  regression visible; a mechanical one would show up anywhere. Write assertions
  in the relative vocabulary or they will only be true on one machine.
- **Every suite opens with `press a`,** because every game opens on its title
  screen. It is one line of ceremony in exchange for the title screen being part
  of what the suite checks rather than something it routes around.

## Writing music and sounds for the example library

Same bargain as the art: hand the demakers what a modern game would have and let
them do the work. Generators live in the session scratchpad; the `.mid` and
`.wav` files are the artefact.

- **Do not write chip music.** The MIDIs are four-part arrangements — bass,
  chords, melody, drum kit — because the arranger's whole job is choosing what to
  do when there are more parts than channels. A two-voice MIDI proves nothing and
  hides every interesting decision.
- **Do not synthesize square waves for effects either.** The sounds are built
  from harmonics, filtered noise and decay envelopes, so the class gate has
  something to classify and the gesture tournament has something to choose
  between. A source that is already a chip blip makes the sound demaker look
  perfect and tests nothing.
- **Length is the cost.** Bars are cartridge: eight bars of four parts is around
  five kilobytes of schedule, and a game with 4 KB free gets two bars. Check the
  headroom before making a tune longer.
- **The generator must be deterministic** — no `Math.random` for the noise bed —
  or regenerating the fixtures changes the goldens for no reason.

## Drawing art for the example library

The fixtures are the tool's own shop window, so they are held to what the tool is
_for_: hand them the artwork a modern game would have and let the demaker do the
work. Generators live in the session scratchpad, not in the repo — the SVGs are
the artefact. What is not obvious the first time:

- **Never author at the smallest target's resolution.** A backdrop is fitted to
  the screen of whichever console is being built, and those differ fourfold in
  area (160×144 against 320×224). Art whose finest feature is one Game Boy pixel
  hands a Mega Drive nothing to resolve. The screens here are drawn on a 640×576
  canvas with detail down to a quarter of a Game Boy pixel.
- **Sprites are eight pixels to a cell on _every_ one of these machines**, so
  what a bigger console has more of is colour, not room. Put the silhouette and
  anything that must stay legible on well-separated luminance tiers, and put the
  modelling _between_ them: the mono fit quantises it away and loses nothing it
  could have shown, while a Mega Drive sprite has fifteen colours and keeps it.
  Art with four tones in it is art drawn for the smallest screen in the set.
- **The mono fit is adaptive, so absolute colours mean less than spacing.** Two
  colours a designer calls "light blue" and "slightly lighter blue" arrive as one
  shade. Pick tiers, not tints.
- **An outline decides which part of a sprite disappears.** The sprite path
  auto-contrasts, so an asset's darkest colour lands on the darkest shade
  whatever its absolute lightness. Against a white sky a dark outline _is_ the
  silhouette; against black it is the silhouette going missing, and the rim has
  to be the light one with the shading turned inward.
- **A backdrop's cost is its variety, not its size.** Flat areas and repeated
  motifs collapse to one tile; anything off the cell grid does not. Aligning four
  clouds to the same phase is the difference between four tiles and forty, and
  `E_BACKDROP_TILES` is how you find out you were wrong.
- **Round shapes are the one thing not to draw.** Rectangles survive a demake;
  a circle eight pixels across is four pixels and a guess about the other twelve.

## Working on the console backend

- **A console implements `Backend`; it does not parallel another console.** The
  build's order, the tick's order, the error codes, the RAM allocator, the level
  tables and every compile-time decision about what a program _means_ live in
  `codegen/backend.ts` and `codegen/shape.ts`. If you find yourself copying a
  function from `gb.ts` into a new backend, that function is in the wrong place —
  move it, do not duplicate it. The one thing a backend owns is its instruction
  set, and doc 14 §2 accepts that cost deliberately.
- **The tick's order is a function, not a convention.** `emitTickSteps` runs doc
  14's seven steps; a backend supplies a method per step. Adding a step means
  adding it there, for every console at once, which is the point.
- **Speed is a published number, and it is currently 1.** Every example runs at
  1.00–1.03 Game Boy frames per game tick, so a game keeps up with the hardware.
  The web app shows the measured figure rather than hiding it behind a speed
  multiplier; if a change pushes a fixture over 1.2, that is a regression worth
  chasing before anything else.
- **Profile before optimising, with the real tool.** Build with
  `--format sym`, run the ROM in `@demake/dmg`, and bucket `cpu.pc` by symbol.
  Because the code is generated _for this game_, the histogram names the game's
  own rules — not which part of an interpreter is slow. Every optimisation so far
  came from that histogram and none from intuition.
- **The conformance suite is the safety net, so use it.** `pnpm test
packages/demotic/test/rom.test.ts` builds all seven fixture games and diffs raw
  16.16 state for hundreds of ticks; a change that alters behaviour fails in
  seconds, naming the tick. `art.test.ts` is its counterpart for the things a
  trace cannot see, because art is not state.
- **Emitters must leave the temp stack as they found it.** `ctx.scoped()` exists
  for that; a `pushTemp` without its `popTemp` corrupts a sibling expression
  rather than failing, and the symptom appears somewhere else entirely.
- **Colour is a second half of the renderer, never a second backend.** A `gbc`
  build is the same machine code as a `gb` one plus: an attribute byte per
  background cell (VRAM bank 1, at the map's own addresses), palette RAM instead
  of BGP/OBP, an OAM attribute carrying the object's palette and tile bank, and a
  tile bank that may run past 256 into the second bank. Everything else — every
  rule, every collision, every tick — is byte-for-byte the same code, and
  `rom.test.ts` runs the whole example library on both consoles to keep it that
  way. A change that made a rule compile differently per console would break the
  one property that makes the colour build trustworthy.
- **Every path that writes a background cell must write its attribute.** There
  are five of them — the full redraw, the backdrop block copy, the scroll edge
  painter, the HUD's queued plot and the HUD's direct poke — and a cell whose
  tile is updated without its attribute keeps the palette of whatever was there
  before. `emitBackgroundTile` and `emitLegendToTile` leave the attribute in
  `layout.attr` for exactly that reason; the queue carries it as a fourth byte
  and flushes it in a second pass, because switching VRAM banks per cell costs
  more than walking a short list twice.
- **One palette of each kind is the font's, and the fitters are told so.** The
  art gets seven background and seven object sub-palettes; `SYSTEM_PALETTE` is
  reserved and holds a plain white-through-black ramp. Never "reclaim" it by
  letting a picture use all eight — the HUD, the built-in patterns and the
  placeholder block all draw with it, and a caption in a title screen's palette
  is a caption nobody can read. `prep`'s `maxSubPalettes` and `buildSpriteBank`'s
  `maxPalettes` are how the reservation reaches the engine.
- **Colour costs cartridge, the way audio does.** An attribute byte per backdrop
  cell (360 a picture), the palettes each scene uploads, and the extra tiles
  colour art costs — two cells that differ only in tone are one tile on a DMG and
  two here — come to about a kilobyte for a game with two backdrops. The shooter
  is the tightest fixture; `audio.test.ts` holds the three biggest above 512
  bytes free, against 1 KiB for the monochrome build, and the difference is
  measured rather than a policy.
- **Demaking a picture in colour is seconds, not milliseconds**, because it is
  the whole `prep` tournament rather than the mono path. `bindArt` memoises the
  conversion by content hash, which is what keeps the web app's per-keystroke
  rebuild instant and the test suite under its budget; the cache is a speed
  optimisation over a pure function and must never become one that changes
  bytes. The web app's ROM pane says "demaking…" and stays live while it happens,
  because a tab that silently stopped for five seconds looks broken.
- **A build is a fan-out, and the order things are _interned_ is not the order
  they are demade in.** `buildRom` demakes art and audio at the same time
  (`allSettled`, so art's error still wins), and the Game Boy converts a scene's
  backdrops concurrently — but interns them in scene order, because a tile's
  number is where it landed. The NES converts its backdrops one at a time instead:
  what a picture may spend is what the ones before it left. Both are correct and
  they are correct for different reasons, so neither may be made to look like the
  other. `packages/demotic/test/parallel.test.ts` builds the library under an
  executor that runs jobs backwards and compares cartridges byte for byte — and
  runs the spread build _first_, because the conversion memo would otherwise let a
  second build pass without a candidate ever reaching the executor.
- **Art is sized by the _instance_, not the class.** One asset used at two
  different `width`s is converted twice, at both boxes, and keyed by
  `name@WxH` — because the box is the collision box, and drawing the larger
  conversion for both paints ledge where nothing can be stood on. Tile dedup
  across the build makes the second box nearly free.
- **A scene that scrolls draws its HUD with sprites.** The background layer moves
  as one piece, so a cell of it cannot be held still while the rest slides; a
  counter pinned to `camera.x + 1` on the background jitters by up to seven
  pixels and snaps back. Sprites are positioned in screen pixels, so the pin
  lands on the pixel. They use OBP1, which stays the plain ramp — the art's own
  palette may map the font's ink onto the lightest shade.
- **A static caption is painted once, with the background.** `hudIsStatic` asks
  whether anything about a `number` or `text` can change; if nothing can, it goes
  in during the full redraw and never touches the per-frame erase-and-repaint
  path. Labels are six cells against a counter's one, so this is most of the HUD
  cost in a small game.
- **Per-pair collision work is a routine, not a copy per pair.** `x`, `y`,
  `width` and `height` are the first four slots of an entity record, so a box is
  one block copy into fixed staging and the overlap test and separation are
  shared code. Inlined, a bullet against nine aliens cost 1.5 KiB _per pair_ and
  a three-shot magazine would not fit in a cartridge.
- **And the pairs themselves are a loop, not a copy per pair** (the NES's
  `emitPairLoop`/`emitEdgeLoop`). The other object goes in a page-zero pointer and
  the rule body is emitted once against `EntityAddr`'s `ptr` case, with a
  four-byte table entry per pair for its address and contact bit. Three shots
  against nine aliens went from 12.2 KiB of collision code to 2.5. A loop is only
  taken where the objects agree about what an unrolled copy would have baked in —
  the near margins, whether `visible` can change, their size — and never below
  three, where the tables cost more than the copies. When you add an emitter that
  reads or writes a bound entity, take an `EntityAddr` rather than an address, or
  it will be the one thing that cannot be looped.
- **The integrator groups by what it would have compiled to.** `moveShape` is
  every compile-time question `emitAxis` asks — can speed change, can each
  direction, and what are they where they cannot — so objects in one group would
  have produced identical instructions and sharing a body is a proof rather than a
  hope. A property the emitter reads _and_ writes goes through `openProp`: the
  property's own address for a named instance, a staged temporary for a looped
  one, so an unrolled object's code is byte-for-byte what it always was.
- **The tile walk is clipped to the grid once, not per cell.** Cells outside a
  level contribute nothing either way, so bounding the walk up front is
  equivalent to asking `TileAt` about every cell — and it is the difference
  between a load-and-increment inner loop and four bounds comparisons plus a
  multiply.
- **And it happens once per object, not once per rule.** The cells an object
  overlaps are walked into a list (`emitFillCells`) and every tile rule _and_ the
  separation pass reads that list. It is only valid where no tile rule can move
  its subject, which `tileCellsCacheable` decides at compile time — the
  interpreter recomputes the list per rule, so caching it is equivalent exactly
  when the answer cannot have changed. In the caves this was 37% of the tick.
- **Work you can prove is invisible is work you do not do.** `Onscreen` culls
  objects the view does not cover before the OAM build touches them, and
  `NearBox` rejects a collision pair before staging a box. Both compare _whole
  cells_ — the high half of a 16.16 coordinate — and both round their margins
  outward, so they may answer "maybe" when the truth is no and never the reverse.
  A cavern's worth of coins is eleven objects off screen and one on it.
- **A divisor that is a whole number of cells takes the byte divider.** The
  general path is a 48-bit shift-and-subtract loop, and a rule that divides every
  tick pays for it every tick. Pong's opponent uses a `5vw` gain — one whole cell
  on a Game Boy court — for exactly that reason, and it is worth a third of the
  game's tick.
- **Watch which registers a helper needs live.** `ld de, addr` and `ld bc, addr`
  destroy a byte the caller may be carrying — that is exactly how every object
  came to draw tile `$C0` (see §Gotchas). Prefer building an address from a
  page-aligned base when an argument is in `d` or `b`.
- **Long branches: use `jp`, not `jr`.** An unrolled rule body easily exceeds a
  relative branch's ±128 bytes, and the assembler correctly refuses rather than
  wrapping. Rule and comparison branches are `jp` for that reason.
- **`jr` is relative to the instruction _after_ its operand.** Reading the base
  before fetching the offset moves every relative jump one byte, which presents
  as an infinite loop somewhere unrelated. `packages/dmg/test/cpu.test.ts` pins
  it because it actually happened.

### The 6502 half

- **The carry means the opposite of what it means on the SM83.** On this CPU it
  is _no borrow_, so `sbc` with the carry clear subtracts an extra one — which is
  how you subtract one, and how the divide's floor adjustment is written. The
  Game Boy backend sets its carry in the same place for the same effect. Getting
  it backwards produces a division that is right for positive operands and off by
  one for negative ones, which is a game that plays correctly until something
  moves left.
- **Every branch to a label a caller gave you is `ctx.far`.** A branch reaches
  ±128 bytes and a rule body is routinely a kilobyte, so `far` inverts the
  condition and jumps. Short branches are for loop heads and two-instruction
  skips inside one emitter, where the distance is visible in the same function.
- **Page zero is not an optimisation, it is the only place a pointer can live.**
  `($nn),y` is the CPU's one indirect mode, so anything a shared routine has to
  be _told_ the address of goes through `ZP.p0`/`p1`/`p2` — and the plan puts the
  expression temporaries there too, which is most of why the arithmetic is
  cheaper here than on the Game Boy.
- **A shared register written through `$4000,x` costs the caller its index.**
  The audio driver's merge folds two shadows and writes `$4015`; doing that with
  `ldx #$15` / `sta $4000,x` destroys `x` — and `AudioSfxStart` carries a table
  offset in it across `AudioSfxRelease`, which tails into that merge, so the next
  effect would be started from another effect's entry. An absolute store is three
  bytes against five and has no such reach. The stream player's `$4000,x` form is
  right where the register comes from data; it is wrong wherever the register is
  a constant.
- **Check which scratch the routine you are about to call uses.** The helper
  scratch (`ZP.t0`–`t3`, `spare`, `saved`) is valid for the length of one
  routine, and the cell-address routine, the write queue and the object builder
  between them use all of it. A value that must survive a call goes in a render
  _word_ instead — which is what the decimal renderer's digit loop does, after a
  version that kept its power-of-ten index in page zero looped for ever.
- **Only draw what is about to be seen.** The redraw paints the window and the
  one column the next scroll step needs; the edge painter paints one strip per
  cell the camera crosses. Painting a whole level at a scene change is more work,
  holds the screen off longer, and draws cells nobody has looked at — the rule is
  the Game Boy's and it did not change.
- **A queued write is a _run_, because the PPU's data port auto-increments.** A
  scrolled column is one address and thirty-one tiles; a cell at a time was three
  times the queue and did not fit beside the row a diagonal scroll also paints.
  The control byte's top bit asks the flush for the down-a-row step.
- **The background palette covers a 16×16 block, so the attribute table is built
  at compile time.** Every cell a caption occupies is known when the game is
  compiled, so the blocks it covers are switched to the font's palette in the
  table the scene uploads — not at run time, and not per cell. An object whose
  _position_ a rule can change is skipped, because its blocks are not knowable.
- **The picture is fitted to the game's screen, not to the raster.** The profile's
  screen is the overscan-safe 28 rows and the name table is 30, and for a while
  backdrops were demade at 30 — so a picture's edges were not the edges the rules
  talk about: pong's scoreboard band sat below the HUD written on it and the
  court's bottom rail below the floor the ball bounces off. `GAME_ROWS` is the
  fit's height and `extendToRaster` repeats the last row into the two overscan
  ones, attributes included, because a palette covers a 16×16 block and the
  eighth block row would otherwise hold whatever zero means.
- **A sprite whose top row is line 0 is drawn a line low, not dropped.** An
  object is drawn on the line _after_ its Y, so that one position would need a
  shadow of minus one — and rejecting it costs the whole object, which is how the
  opponent went missing in a game whose trace was perfect. The bounds test is on
  the position and the subtraction happens after it.
- **Colour zero of every background palette is the same universal backdrop.** So
  the font's palette gets three colours and its ink is chosen against the
  backdrop it will be read on — dark ink over a light one, light over a dark. A
  fixed white-through-black ramp, which is what the Game Boy Color reserves, puts
  the ink on white and is invisible on the one example scene whose fit made the
  backdrop white.
- **Thirty rows of nametable against thirty rows of screen leave nothing spare.**
  A level no taller than the map cannot scroll vertically by repainting, so it
  does not try: every row sits at its own address and the two overscan rows such
  a level scrolls into show its own top two. A taller level wraps properly and is
  painted a row at a time like the columns.

### The Z80 half

`demake build -c sms` and `-c gg` build playable cartridges with their music and
effects in them, and the whole example library traces identically on both. The
four bullets at the end of this section are the sound half; everything before them
is the game.

- **A load says nothing about what it loaded.** `ld a,(nn)` sets no flags, where
  the 6502's `lda` sets N and Z. Every sign test therefore needs an explicit
  `or a` after the load, and the omission does not fail — it branches on whatever
  the _previous_ instruction decided, which is usually right by accident until it
  is not.
- **`or a` clears the carry and keeps the accumulator.** It computes `a | a`, so
  only the flags move. That is what lets a subtraction chain start without saving
  anything, and it is why the block negate uses `ld a,0` instead: `xor a` would
  clear the borrow the chain is carrying.
- **Every conditional jump reaches, so `far` is one instruction.** `jp cc,nn`
  takes a sixteen-bit target, unlike the 6502's ±128-byte branches. `jr` is still
  eight bits and is still only for a target defined a few instructions away.
- **The sign of a difference is the signed comparison**, because the operands are
  clamped: both are inside ±2^26, so their difference cannot wrap and `jp m` after
  two `sbc hl,de` is the whole test. Reaching for `pe`/`po` — the general Z80
  signed-compare idiom, sign exclusive-or overflow — would be correct and three
  instructions longer.
- **Per-pair collision work is a routine, and the pairs are a loop.** Both
  halves are the NES's, arrived at here for the same reason and worth the same
  five lines. A box is one `ldir` into fixed staging, so the overlap test and the
  separation are shared code; and the _pairs_ are walked from a table
  (`emitPairLoop`/`emitEdgeLoop`) rather than copied, with the other object's
  record in `layout.loop` and the rule body emitted once against `EntityAddr`'s
  `ptr` case. Three shots against nine aliens went from 9.3 KiB of collision code
  to under one, which is what made the shooter fit at all. A loop is only taken
  where the objects agree about what an unrolled copy would have baked in — the
  near margins, whether `visible` can change, their size — and never below three.
  When you add an emitter that reads or writes a bound entity, take an
  `EntityAddr` rather than an address, or it will be the one thing that cannot be
  looped.
- **And the integrator groups by what it would have compiled to.** `moveShape` is
  every compile-time question `emitAxis` asks, so objects in one group would have
  produced identical instructions and sharing a body is a proof rather than a
  hope. A property the emitter reads _and_ writes goes through `openProp`: the
  property's own address for a named instance, a staged temporary for a looped
  one, so an unrolled object's code is byte-for-byte what it always was.
- **The loop cursor is memory, not a register pair.** `MemoryPlan.loopBytes` buys
  three bytes — a record pointer and an index — because a rule body fires between
  one iteration and the next and helps itself to every register the Z80 has. Not
  `layout.scratch`, which is documented as valid for the length of one routine and
  is exactly what that rule body uses.
- **The mapper's registers are decoded out of the RAM mirror.** `$FFFC`–`$FFFF`
  is `$DFFC`–`$DFFF` in real RAM, so those four bytes read back as ordinary
  memory and page a ROM bank out from under the program when written. The heap
  stops short of them; the allocator must never be given them back.
- **A Game Gear is a Master System with a smaller window.** The VDP renders the
  whole 256×192 frame and the LCD shows the middle 160×144, so only `viewW`/
  `viewH` differ between the two memory plans and only the palette upload differs
  in the emitter. Anything that made a _rule_ compile differently per console
  would break the property that makes the second machine trustworthy — the same
  one the Game Boy Color build rests on.
- **And a sprite's position is a _frame_ position, so it carries that window's
  origin itself.** The background is moved into the window by the scroll
  registers; nothing moves the sprite table, so `PushSprite` adds `windowOrigin`
  and every caller is a screen coordinate. Bias one layer and not the other and
  they disagree about where the world starts — an object at `y 0` lands 24 lines
  above the LCD and is simply not there. It goes on _before_ the entry count is
  loaded, because the count stays in `a` from the room check into the address
  arithmetic; after it, every object shares slot zero and nothing is drawn.
- **An interrupt's flag is not scratch.** `layout.scratch` is four numbered words
  that are valid for the length of one routine, and a handler writes its byte in
  the middle of whatever the game was doing — so the frame flag and the Pause
  latch have their own bytes (`MemoryPlan.interruptBytes`, allocated last so no
  other console's map moves). They were `S.w3`, which `Mod16` uses for its
  divisor, so a frame boundary inside `random()`'s sixteen-iteration loop
  returned a draw outside its own bounds. It presents as a game that is
  occasionally, unaccountably wrong, and no tick can be named — which is also why
  a change that only makes the frame _shorter_ can be the thing that reveals it.
- **The sprite table is uploaded as far as the list, not as far as the table.**
  `$D0` ends it, `ClearRestOfOam` parks one there, so `UploadFrame` sends
  `count + 1` Y bytes and `count` pairs — and `otir` sends each run in one
  instruction. All 192 bytes every frame was thirteen per cent of pong's tick for
  eleven sprites. `otir` is safe here because this runs inside the blanking
  interval by construction; do not reach for it on a path that might not.
- **A name-table entry is two bytes**, so `cellAttributes` is true here: the
  second byte carries the palette-select, flip and priority bits. Same shape as
  the Game Boy Color's attribute byte, reached by different hardware. **The flip
  bits are the fitter's**, not decoration: this layout is flip-aware, so one tile
  stands for up to four orientations and the cell says which. A pool that carried
  the tile number and dropped bits 1 and 2 drew the right-hand end of every
  mirrored brick, ledge and letter the wrong way round — on every title screen in
  the library, and it cost no tiles to fix because it is the same tile either way.
- **The background layer is opaque.** Colour zero is an ordinary colour, drawn
  from whichever bank the cell selected; transparency belongs to the sprites, and
  register 7's backdrop fills the border and the masked left column and nothing
  else. Two things follow. A renderer that skips colour-zero background pixels
  shows the border through every flat area a demade picture has — a whole sky, in
  the flesh — which is what `packages/sms/test/vdp.test.ts` now pins. And a
  caption has _paper_: the font draws its shade zero as the sprite bank's colour
  zero, which no sprite can ever render because it is their transparency slot, so
  `packPalette` pins it to black rather than leaving it to whatever the object fit
  happened to put there.
- **The vertical scroll register wraps at 224; the horizontal one wraps at 256.**
  Thirty-two columns is exactly a byte, so a level wider than 255 pixels needs
  nothing special. Twenty-eight _rows_ is not: reducing `camY + bias` in the
  accumulator throws away thirty-two pixels every time the sum passes 255, and the
  four rows the picture slides by are the four nothing has painted. It is done in
  `hl`, which also covers a level taller than a byte.
- **The name table holds the window plus one cell on each axis, and only a Master
  System has to wrap to do it.** A scroll of part of a cell shows a sliver of the
  next column and the next row, so a cell nothing painted shows the scene before
  it. A Game Gear's window is twenty columns of thirty-two, so the incoming column
  has a cell of its own: no seam, no mask, and a leftward step paints the origin
  itself. A Master System's screen is all thirty-two, so its extra column wraps
  onto the cell straddling the masked left edge and a leftward step paints offset
  _one_ — offset zero is that shared cell, and painting it puts the left-hand
  column into the right-hand sliver. `spareColumn` is the one question, and rows
  never ask it because twenty-eight always beats twenty-four.
- **Every scene uploads a palette, whether it has a picture or not.** A scene with
  a backdrop brings that picture's colours and one without brings the build's —
  the level tiles' and the objects' fit. Leaving colour RAM alone made a level
  wear whichever title screen the player came from, which looks like a corrupt
  tilemap rather than a wrong palette. And the upload counts _bytes_: a Game Gear
  colour is two of them, so a loop written for thirty-two leaves the whole sprite
  bank unwritten there.
- **The control port is two writes, and the interrupt handler resets it.**
  Acknowledging the frame interrupt means reading that port, which clears its
  half-written state — so a handler landing between the two bytes of an address
  leaves the second one read as a first, and one cell of the screen is written
  somewhere else entirely. `UploadFrame` is safe by construction, because it runs
  a few instructions after the interrupt it waited for; the full redraw is the one
  thing long enough to be interrupted, so it runs under `di` and the frame it
  spends there is owed rather than lost. Before adding a VDP path that runs with
  interrupts on, ask which of its control writes can be split.
- **The bank is capped at 256 tiles, not the 448 that fit.** A sprite's tile
  number in the attribute table is a single byte, so anything an object can draw
  has to be below 256; letting the background reach higher would mean two budgets
  to explain and a nine-bit index in the name table's second byte. Tiles are also
  ROM _and_ video RAM here — they are uploaded at boot, not addressed in place —
  so the bank costs cartridge twice.
- **Which colour bank a background cell uses is decided by its tile number.**
  Anything below `BUILTIN_TILES` is the font, the level patterns or the
  placeholder block and draws in bank 1 alongside the sprites; art draws in bank 0. There is no third palette to reserve, so three _entries_ at the top of the
  sprite bank are the reservation instead and `buildSpriteBank`'s `maxColors`
  tells the fit about them. Never widen the sprite fit back to sixteen: the font
  would take three of the art's colours and a caption would be the colour it is
  written on.
- **Do not reach for a render word without checking who owns it.** The renderer's
  sixteen scratch words include `mapCol`/`mapRow`, which are the map origin and
  have to survive from one frame to the next. The decimal renderer used them and
  every frame looked like a camera teleport — the game played correctly and
  repainted the whole screen seventy-eight frames in ninety, display off and on
  each time. `sms-rom.test.ts` pins it now; the safe slots are the redraw's and
  the walk's own loop counters, which have finished before a HUD is drawn.
- **A write is a port, so the packed data carries one.** `out (c), a` is the Z80's
  one register-indirect way into I/O space, so `data.ts`'s `port` option puts the
  port number where the other two consoles put a register number — the same byte,
  and no translation in the write loop. `b` rides along on A8–A15 while it counts
  the run, which is harmless because these machines decode I/O from A7, A6 and A0
  alone.
- **The channel is in the data byte, and it is latched.** That is the one thing
  neither other chip forced. `channelOf` is a factory for a tag carrying a
  per-schedule latch, preemption skips whole _runs_ rather than writes, and the
  property that makes that safe — every run opens with a latch byte — is checked
  by `checkLatchDiscipline` rather than assumed. Get it wrong and the symptom is a
  note on the wrong voice several ticks later.
- **The frame is the driver's clock, and the line interrupt is not.** This VDP
  reloads its line counter on every scanline outside the active display, so an
  interrupt programmed for every N lines fires a handful of times inside the
  picture and then not at all until the next frame. `psgBinding.fitRate` will
  still offer those rates to a _standalone_ track; a game asks `gameDriverRate`
  and gets 59.92 Hz.
- **A Master System has no register two streams share.** Four attenuation latches,
  four channels, nothing carrying more than one of them — so no merge routine is
  emitted at all. The Game Gear's stereo latch is `NR51`'s exact shape and brings
  it back, expanded by one instruction because the Z80 has no `swap`. That is the
  only thing in the driver that differs between the two machines.

### The 65816 half

`demake build -c snes` builds a playable 64 KiB LoROM cartridge, and the whole
example library traces identically on it. This CPU is a 6502 with three things
added, and every bullet here is one of them biting.

- **The width flags are part of the machine state a label promises.** `M` decides
  whether the accumulator is eight bits or sixteen, and _the instruction stream
  changes length with it_ — an immediate is one operand byte or two. So the
  backend fixes an invariant and keeps it: **sixteen bits at every label, every
  call and every return.** `ctx.narrow()` is the only sanctioned way to leave it,
  nothing inside one may branch out or call a routine, and a routine that wants
  eight-bit arithmetic throughout narrows once at its entry and widens before its
  `rts`. Getting this wrong does not produce a wrong number; it executes an
  operand as an opcode, somewhere else entirely.
- **A byte field is read as a word and written under `narrow`.** Most of a game's
  state is 16.16 and the accumulator is sixteen bits to suit it, but a flag, a
  counter and a contact bitfield are one byte each — and the byte beside them
  belongs to something else. `loadByte` masks the neighbour away for nothing;
  `setByte`/`clearByte`/`incByte` narrow for the length of the store. A
  sixteen-bit `sta` to a one-byte field is a bug that surfaces as an unrelated
  flag changing value.
- **`tsb` is how a bit is set without narrowing.** It writes back `memory | A`, so
  a mask whose high byte is zero leaves the byte above the target exactly as it
  found it. The indexed contact-bit path uses a plain read-modify-write for the
  same reason and it is safe for the same reason — `tsb` has no indexed form.
- **A helper is handed an address in `X`, not through a pointer.** `$nnnn,x`
  reaches all of bank zero with sixteen-bit index registers, so `ldx #Addr; jsr
Clamp32` is the whole calling convention and there is one clamp routine where
  the 6502 backend needs two. The same thing makes `EntityAddr`'s `ptr` case one
  `ldx` and an indexed load rather than four indirections. `X` is reloaded per
  access rather than kept live, because a rule body between two accesses uses
  every register there is.
- **Reset lands in emulation mode.** There is no native reset vector, so a
  cartridge's first instructions are `clc; xce; rep #$38`. `snes-rom.test.ts`
  pins those three bytes, because a build that forgot them fetches every
  sixteen-bit immediate one byte short.
- **The tile art is in a second cartridge bank and no instruction addresses it.**
  DMA takes its source bank as a _data byte_, so sixteen kilobytes of art costs
  the 32 KiB program bank nothing. Do not reach for long addressing to read it:
  the whole point of the split is that the data bank stays at zero, where the
  console's first 8 KiB of work RAM is mirrored and every property is a plain
  sixteen-bit absolute.
- **The background is scrolled one line late.** Screen line `N` shows background
  line `BG1VOFS + N + 1`, so the vertical register written is the camera's minus
  one. That is the same `$3FF` the image E2E's harness has always written, and
  without it every scene sits a pixel high.
- **A 64-wide tilemap is two 32×32 screens a kilobyte apart.** Column 32 is
  `$400` words from column 0, not one word from column 31. A reader that assumed
  a rectangle would agree with a renderer that made the same mistake, which is
  why `snes-rom.test.ts` computes the address the hardware's way and checks that
  both screens carry cells once the camera has crossed.
- **An object's Y is direct.** No minus-one convention, unlike the NES: this chip
  draws an object's top row _on_ the line its Y names, so `y 0` is the top of the
  screen and needs no exception. Its X is nine bits; this runtime uses eight of
  them and drops what falls outside, as the other backends do.
- **The map is bigger than the screen in both directions**, so both axes scroll by
  painting a leading edge and neither needs the NES's row pinning or the Master
  System's seam mask. This is the one console where that machinery is simply
  absent rather than worked around.
- **Object priority runs the other way, and the per-line cap does not.** Entry
  zero is in front, but the thirty-two the hardware evaluates are chosen by
  scanning _forward_ — so the objects that get dropped are not the ones that lose
  the priority fight, and `@demake/snes`'s renderer does the two passes in
  opposite directions for exactly that reason.
- **A picture is thirty seconds of tournament, not five.** 256×224 fitted into
  seven sixteen-colour sub-palettes is three times any other console's screen.
  `bindSnesArt` memoises by content hash for the same reason `bindArt` does, and
  the parallel suite runs one fixture here rather than three. Before adding an
  art-heavy test on this console, check what it does to the suite's budget.

### The SPC700 half

`demake build -c snes` puts a second program in the cartridge, and the cartridge
hands it to a second processor at boot. Everything here is a consequence of that.

- **The driver is uploaded, not called.** `AudioUpload` performs the documented
  handshake — wait for `$AA`/`$BB`, state a destination, kick with `$CC`, then a
  byte and its counter at a time — and the whole block (the waveform bank, the
  driver, its tables and its packed schedules) goes across four mailbox bytes
  before the screen comes on. After that the game writes two request bytes and a
  sequence byte and never waits for sound again.
- **The mailbox is inside the picture's register range, and it must be decoded
  first.** `$2140`–`$217F` sits under `$2100`–`$21FF`, so a bus that asks "is this
  a PPU register" before "is this the sound processor" answers every mailbox read
  with the PPU's, and the upload spins forever waiting for a greeting that has
  already been sent. `@demake/snes`'s bus checks the mailbox first for exactly
  that reason.
- **Every mailbox access is a byte, so it runs under `ctx.narrow`.** A sixteen-bit
  store to `$2140` writes `$2141` as well — which in the middle of the handshake
  is the counter overwriting the data byte the sound side is about to read.
- **The entry scene's music is asked for beside the upload, not after the first
  redraw.** The sound processor's timer starts when its program does, so a request
  posted after a full-screen redraw arrives a tick or two into a schedule that has
  already been playing to nobody. No scene _change_ asks for the entry scene's
  track either, which is the other half of why it is there.
- **The shared register is a pulse, so preemption is a mask rather than a fold.**
  `KON` starts the voices whose bits are set and does nothing to the rest, so each
  stream carries one `own` byte — the voices it may touch — and the driver skips a
  run naming anything outside it and `and`s a merge write down to it. Music's
  `own` is the complement of what an effect took; an effect's is what it took.
  There are no shadows and no `NR51`-shaped byte to recompute.
- **A note's level lives in `GAIN` and its panning in the volume registers.**
  `GAIN`'s direct mode is one byte that _is_ the level, so a whole dynamic shape
  costs one write a tick and note-off is `GAIN = 0` — which is also why the driver
  never writes `KOF`, the only other byte two streams would have shared.
  Percussion is the exception and takes the opposite arrangement, because its
  `GAIN` is carrying the chip's own exponential decay.
- **The waveform bank is one definition with two readers.**
  `binding/sdsp-bank.ts` decides where the sample directory lives, what is in it
  and how loud it is; the binding puts an index in a voice's `SRCN` and the driver
  uploads the bytes. A second copy of either number is a game whose bass plays the
  snare.
- **A schedule for this console is only half an artifact.** The chip plays samples,
  so `render()` puts the bank behind the model rather than making every caller
  remember — and `demake arrange -c snes` writes an `.spc` rather than a `.vgm`,
  because a write log without the RAM is not a piece of music and an SPC is
  exactly what the cartridge uploads.
- **The image sits at the top of the second cartridge bank, under the tile art.**
  Both are sized by what the game contains and only one of them can have the low
  end without the other having to know how big it got; `E_BACKDROP_TILES` names
  the sound processor's share when there is one.

## Working on audio

The spine, both demakers and three CPUs' drivers are built; these are the rules
that keep them from being undone. All of them come from doc 16.

- **A chip is implemented once, in `@demake/chip`.** `@demake/dmg` needs a Game
  Boy APU for the web player and the audio pipeline needs one for previews;
  those must be the same code. A second implementation of a chip is how the
  preview and the emulator quietly stop agreeing — the exact failure the "no
  second art converter" and "the web app must never grow conversion logic" rules
  already exist to prevent.
- **The compliant artifact is a timed register-write schedule**, not a song.
  That is what makes four things the same object: what our synth renders, what
  the driver must write, what an emulator's chip actually receives, and what the
  compliance oracle checks. Any "musical" layer left in the artifact is a place
  two implementations can disagree.
- **One renderer feeds every surface.** The CLI writes files with `render()`, the
  page plays the _same_ PCM through a bare `AudioBufferSourceNode`, the desktop
  plays the CLI's file. Web Audio is a playback device, never a synthesizer — no
  `OscillatorNode`, no filters, no worklet DSP. Construct the `AudioContext` with
  an explicit `{ sampleRate: 48000 }` or the browser resamples the buffer on its
  own terms, differently per engine.
- **A live stream is the same renderer, not a second one.** `StreamSink`
  (`@demake/chip`) box-integrates a _running_ chip into a ring buffer with the
  same boundary arithmetic and the same DC blocker the offline render uses, and
  `packages/chip/test/stream.test.ts` pins them as bit-identical in any chunk
  size. Two details are load-bearing and easy to undo: the DC blocker's state
  carries across calls (restarting it per chunk is sixty clicks a second), and
  the integrated value is rounded to single precision _before_ it reaches the
  filter, because that is what filtering a `Float32Array` in place does.
- **With sound on, the audio device clocks the emulator.** The ROM pane runs
  frames until the chip has produced the samples the player still needs, not on
  the frame clock: a tab whose display and audio clocks differ by a few ppm
  drifts into a click every few minutes otherwise.
- **Sound is the cartridge's, never the preview's.** The interpreter says _when_
  a sound is asked for (the trace's `audio` field) and knows nothing about chips,
  channels or registers — a `.dmt` names none of them. So the page's sound
  control lives in the cartridge view and the preview has none, which is the
  honest way to say a simulator has nothing to play.
- **Lossless carries the guarantee; lossy does not.** WAV and FLAC are
  sample-exact and byte-golden. M4A/Opus/MP3 are convenience exports and must be
  labelled as approximations everywhere they appear — the project does not make
  "transparent to most listeners" claims anywhere else.
- **Exactness lives in the schedule, not in a waveform diff.** Level A (diff the
  register writes an owned core observes against the `ChipScript`) is exact and
  runs in `pnpm test`. Comparing our audio to a third-party core's is a
  tolerance-based cross-check and must never be written as if it were bit-exact —
  cores resample and filter on their own terms.
- **Audio DSP is where determinism breaks first.** FFT twiddles, windows, mel
  banks, dB conversions and resampler kernels all come from
  `packages/core/src/math/kernels.ts`. An FFT seeded with `Math.cos` returns
  different low bits in Firefox and every metric downstream inherits it.
- **Tempo is a budget, not a metric.** The requirement is that timing error does
  not _accumulate_; a bar boundary must land where it should after ninety
  seconds. Report requested BPM, achieved BPM, ppm error and worst onset
  deviation every time.
- **Never lose a part silently.** Every dropped note, merged voice and stolen
  channel is counted in the manifest and `--json`; `--strict` turns any of them
  into an error. The image path's tile-merge reporting is the precedent.
- **The driver is generated, and helpers are pulled.** `packages/audio/src/rom/`
  emits SM83 _for this schedule_: a track that never rests ships no rest
  handling, a one-shot ships a stop path and a track does not. Never add a
  routine unconditionally and never prune afterwards — the same rule the Demotic
  backend runs under, and `stats.helpers` is what makes it checkable.
- **A driver's size is a query, not a value.** The emitter is a closure the
  assembler runs, so `stats.code`, `stats.data` and `stats.helpers` are all zero
  or empty until it has — which happens in `assemble`, one step after
  `bindAudio`. A backend that copies them out of the binding reports that zero,
  and `demake build` did exactly that for every cartridge it made until PR #31
  caught it in passing. `BoundAudioShape` states the rule for all three;
  `demotic/test/audio.test.ts`'s size sweep asserts the numbers are real, which
  is the part that had been missing — the bug survived because nothing checked.
- **The driver format is not part of the contract.** The only guarantee is that
  on tick N the driver performs exactly the writes `ChipScript.ticks[N]` lists,
  in order. Blocks, dedup, the order list and the opcodes can all change freely;
  what may not change is the register stream, and `rom.test.ts` is what says so.
- **A game has one interrupt, so it has one rate.** Music and effects both step
  on the same tick, so the game states the rate (`arrange`'s `driverHz`, `sfx`'s
  `rateHz`) and every piece is fitted to it through the binding's own `fitRate`.
  Never let a game's two streams pick rates independently and reconcile them
  afterwards: `buildGameAudio` refuses schedules that disagree, and that refusal
  is the design, not a limitation.
- **_Which_ interrupt is the console's answer, and so is the rate.**
  `gameDriverRate` lives in `@demake/audio` because it is a fact about the driver
  that has to keep it: a Game Boy has a timer and gets 120 Hz; an NES and a Sega
  8-bit have the frame the picture runs on and get 60. Never ask a frame-clocked
  console for a multiple of its frame rate to "improve resolution" — the driver
  would tick twice at the top of a frame and then not at all for sixteen
  milliseconds, which is a schedule performed correctly and heard wrongly. And
  never trust a clock a `fitRate` will _offer_ without asking what the hardware
  does with it: the Sega VDP's line interrupt fits beautifully and fires only
  inside the active display.
- **A frame-clocked console counts frames rather than riding them.** The handler
  increments a byte (capped, so a stalled tab does not come back owing hundreds of
  ticks) and the main loop performs what it says. Doing the tick inside the
  handler would put it in front of the tilemap upload, which owns the blanking
  interval; dropping the counter would make a frame the game overran a frame of
  tempo lost.
- **The chip is initialised once, at boot, not at the head of every stream.** An
  effect that re-ran the power-up writes would silence the music each time it
  fired. That is why `performed` exists on a game's driver: the schedules the ROM
  really plays are the ones with the boot prefix taken off and an effect narrowed
  to its own channel, and it is what the conformance harness must diff against.
- **`NR51` is merged, never stored, whenever two streams share the chip.** One
  byte carries every channel's panning. Each stream keeps a shadow and the driver
  folds them under the steal mask, which is what makes the register stream exactly
  the schedule's when nothing is preempting — the whole proof rests on that. The
  NES's `$4015` and the Game Gear's stereo latch are the same problem and the same
  answer; a Master System is the one machine with no such byte, and it emits no
  merge at all rather than a merge that folds nothing.
- **A chip may put the channel in the data rather than in the address, and it may
  latch it.** So `packScript`'s `channelOf` is a **factory** for a
  `(reg, value) => channels` tag, fresh per schedule — the SN76489 is the case it
  exists for, and a latch shared between two calls would tag the second stream
  from the first stream's last write. Preemption then skips whole _runs_, which is
  safe only because every run of such a stream opens with the byte that selects
  its channel; `checkLatchDiscipline` refuses a schedule where that is not true
  rather than letting it become a note on the wrong voice.
- **Anything that stores a driver rate must store the register that makes it.**
  A `ChipScript` carries the reload (`divisor`) as well as the exact rate,
  because a ROM programs a register and re-deriving one from a rational would be
  a second timing fit that could disagree with the first. The `sfx` path dropped
  it once and the ROM builder simply could not be written.
- **An artifact shape with two callers belongs in the package, not in an edge.**
  The `--emit-manifest` sidecar was built inline in the CLI until the web app
  needed to hand you the same file; it lives in `src/manifest.ts` now, encoding
  and trailing newline included, because those are output bytes and a second
  writer is a second answer. Same precedent as the image path's
  `buildManifest`/`encodeManifest` (doc 07 §The web app must never grow
  conversion logic).
- **The page renders at the audio device's rate; it never resamples to it.** If
  a browser refuses a 48 kHz `AudioContext`, the schedule is rendered again at
  whatever rate it gave. Handing Web Audio a buffer at the wrong rate lets the
  _browser_ resample, differently per engine — which is a second implementation
  of the output stage arriving through the back door.

## How to add a console

Four steps, and they are independent — a console can gain any of them without the
others, which is why `docs/console-support.md` has a column per step rather than
one "supported" flag. Doc 13 §Console rollout says what each costs per console;
run `pnpm gen:console-docs` when you land one.

1. **Art** — `packages/core/src/consoles/<id>.ts`, a declarative `ConsoleSpec`,
   registered in `consoles/registry.ts`. This alone makes the console work for
   `prep`/`inspect` (the generic tiled fitter or the mono path consumes the
   spec). Cite primary hardware sources in `docs.sources` (doc 03).
2. **Data** — `packages/core/src/codegen/<family>.ts`, native data + display
   source, registered in `codegen/registry.ts`. The `gb` family is the model.
3. **Display ROM** — `rom-harness/<family>/` (display program),
   `emu-harness/<family>/` (headless capturer), a pinned provisioner in
   `tools/toolchains/` (Docker not required — see the RGBDS/SameBoy scripts), and
   an entry in `cli/src/rom/registry.ts`. The console is only _supported_ when
   its pixel-perfect E2E passes (doc 10) — add it to `EMULATOR_PROVEN` and name
   the suite `<id>.e2e.test.ts`, which `support.test.ts` cross-checks.
4. **Games** — a `Backend` in `packages/demotic/src/codegen/`, registered in
   `codegen/registry.ts`, plus a profile in `profiles.ts` and a core to prove it
   in. Add it to `rom.test.ts`'s target list and, if it has a driver, to
   `audio.test.ts`'s: running the whole example library on every machine is what
   makes `Backend` a contract rather than a resemblance.

**Check first whether the console is a variant rather than a machine.** Three of
the consoles that build games are not backends: the Game Boy Color is the Game
Boy's machine code with a second half on the renderer, the Game Gear is the
Master System's family with a different crop, and the Mega Duck is a Game Boy
whose I/O pins moved — a register table, an `LCDC` permutation, an entry point
and a cartridge with no header (`core/src/asm/megaduck.ts`). A variant costs a
machine description and no instructions; if you find yourself copying an emitter,
you are writing the wrong one of the two.

## Testing truths

- `pnpm test` runs the Vitest unit suite locally with no Docker. It is ten to
  twenty minutes now depending on how many cores it gets, not the two the plan
  wanted, and one file is most of it:
  `packages/demotic/test/audio.test.ts` builds every example game _with its art
  and its audio_ on every console with a driver, and demaking a picture is the
  whole `prep` tournament. That is the price of the size assertions — they are the
  only thing that would catch a cartridge overflowing — so before trimming it,
  check that what you are removing is not the coverage. The Super Nintendo runs
  the whole register-conformance battery there but **one fixture** of the size
  sweep rather than seven, because a picture on that console is thirty seconds of
  tournament rather than five; the shooter, because a budget can only decide a
  cartridge already near the edge.
- **`unsupported` names language gaps, not hardware ones**, and every console's
  list is empty. It stayed empty on the Super Nintendo through the period when
  that machine had no sound, because a `.dmt` that says `music theme.mid`
  compiled, recorded the request its rules made, and traced identically to a build
  that played it. A gap that changed what a _trace_ says is the one that must be
  named.
- **The parallel contract is tested at four levels, and they are not redundant.**
  `packages/core/test/parallel.test.ts` pins the ordering rules with executors
  that run jobs backwards and interleave two tournaments (fast, no threads);
  `packages/cli/test/pool.test.ts` does it over real `worker_threads` and is
  therefore run against the _built_ pool, self-skipping without `dist` the way
  `binary.test.ts` does; `packages/demotic/test/parallel.test.ts` compares whole
  cartridges across the example library; and
  `packages/web/test/e2e/determinism.spec.ts` compares the page's — built over
  real Web Workers — against the CLI's. A change to the seam should keep all four
  passing or explain which one it invalidated.
- The ROM-build E2E (`packages/cli/test/rom.e2e.test.ts`) assembles a real
  `.gb`/`.gbc` through RGBDS; it self-skips when the toolchain is absent, so run
  `pnpm toolchains` first to exercise it. RGBDS is provisioned by a source build
  (`tools/toolchains/install-rgbds.sh`), and web sessions get it automatically
  via the `.claude/` SessionStart hook.
- The Demotic ROM conformance suite (`packages/demotic/test/rom.test.ts`) builds
  a cartridge from each fixture game **for every console with a backend** — both
  Game Boys, the Mega Duck, the NES, both Sega 8-bits and the Super Nintendo —
  and runs it in the matching self-hosted core, asserting the trace matches the
  reference interpreter tick for tick. No toolchain, no emulator install, so it
  runs everywhere `pnpm test` does. Running the same battery on all seven is what
  makes `Backend` a contract rather than a resemblance, and each console proves
  something different: the colour build that the attribute work never touched
  simulation state, the NES and the Master System that a second and third CPU's
  arithmetic and ordering agree to the bit, the Mega Duck that a machine
  description never leaked into the code the tick runs, and the Super Nintendo
  that a value layer whose accumulator is _sixteen_ bits agrees too — every
  routine there is a different program from the one the others share. It also
  checks the Duck's cartridge _fails_ on a Game Boy — identical traces are also
  what a register map that had quietly become the identity would produce.
- `packages/demotic/test/nes-arith.test.ts` is one layer below that: it assembles
  each 16.16 operation on its own, runs it in `@demake/nes` and compares with
  `fixed.ts`. A multiply that floors the wrong way for negative operands makes a
  game that plays _almost_ right and diverges a thousand ticks later, by which
  point the trace names a position rather than an operation.
- `packages/demotic/test/snes-arith.test.ts` is the same test for the 65816, and
  it matters more here than on either 8-bit console: those two share an
  eight-bit-accumulator shape, and this one does not, so nothing it covers was
  proved by anything that came before. `packages/snes/test/{cpu,ppu}.test.ts` sit
  under it — the CPU is driven by `core`'s own 65816 assembler, so an encoder and
  a decoder that agreed with each other and not with the hardware would still fail
  against the published opcode bytes `packages/core/test/wdc65816.test.ts` pins.
- `packages/demotic/test/snes-rom.test.ts` is the rendering oracle for that
  console, and it is where the things a trace cannot see are checked: that the
  tile bank really left the second cartridge bank and arrived in video RAM, that
  every visible cell matches the level's own grid, that a camera which has crossed
  column 32 has painted into the _second_ 32×32 screen rather than one word
  further along, and that the reserved sub-palette survives whatever the art
  chose. Let the scene settle before comparing, for the reason the Sega one gives.
- `packages/demotic/test/sms-arith.test.ts` is the same test for the Z80, and it
  is the first thing that runs code the Sega backend wrote. Until the rest of that
  backend exists it is also the only one — so it is where a new value-layer
  emitter is proven, and the file to run when touching `codegen/sms/val.ts`.
  `packages/sms/test/{cpu,vdp}.test.ts` sit under it: the CPU is driven by
  `core`'s own Z80 assembler, so an encoder and a decoder that agreed with each
  other and not with the hardware would still fail against the published opcode
  bytes `packages/core/test/z80.test.ts` pins.
- `packages/demotic/test/sms-rom.test.ts` is the same for the Sega 8-bits, and it
  is where the things a trace cannot see are checked: that the tile bank reaches
  video RAM, that every visible cell matches the level's own grid, that the seam
  mask is on only where the level scrolls sideways, and that the reserved colours
  survive whatever the art chose. Let the scene _settle_ before comparing — a
  camera moving more than four cells in a tick asks for a full redraw next frame,
  so a picture read four frames in is one the runtime has already discarded.
- `packages/demotic/test/nes-rom.test.ts` is the rendering oracle the NES has
  until doc 10's scripted-input E2E exists: it checks the nametable against the
  level grid the cartridge carries, cell by cell, before and after the camera has
  travelled. Its wide-level case is written in the test rather than taken from
  the library, because no example level is wider than the nametable pair and the
  edge painter would otherwise be the one path nothing ran.
- `packages/audio/test/spc.test.ts` is the driver proof one layer below the game
  one: it builds an SPC700 driver for an arranged track, performs the upload
  handshake against `@demake/snes`'s S-SMP directly, and diffs every S-DSP write
  against the schedule. It exists because a failure in `audio.test.ts` on that
  console could be the driver, the cartridge's upload or the request protocol, and
  this file can only be the first.
- The audio ROM conformance suite (`packages/audio/test/rom.test.ts`) is its
  counterpart for sound, and doc 16 §The proof's Level A: it builds a cartridge
  from an arranged track and from a demade effect, boots each in `@demake/dmg`,
  and diffs the register writes the APU receives against the `ChipScript`, tick
  for tick. Ticks are attributed by watching the driver's `Tick` symbol, so
  nothing is added to the ROM to make it observable. Also toolchain-free.
- The game-audio conformance suite (`packages/demotic/test/audio.test.ts`) is
  doc 16's Level A for a cartridge that is also playing a game, **on every console
  with a driver**: it boots a built `.gb` in `@demake/dmg`, a built `.nes` in
  `@demake/nes` and a built `.sms` in `@demake/sms`, watches `AudioTick` by program
  counter, and diffs the writes the chip receives against the schedules the
  demakers produced — the music's when nothing preempts, the effect's own channel
  while one does. The battery is written once against a `Target`; the only
  per-console entries are the channel _tag_ (a factory, because one chip latches
  it), the shared register (`null` where there is none), the merge helper's name
  and the ratio a window written in ticks is scaled by, because a frame-clocked
  driver ticks half as often as a Game Boy's. The Game Gear gets its own short
  block rather than a fourth pass, because the stereo latch is the only thing
  about it the Master System's pass does not already run. Also toolchain-free, and
  it is the file to run when touching any driver.
- The pixel-perfect emulator E2E (`packages/cli/test/emu.e2e.test.ts`, doc 10)
  boots the ROM in SameBoy and asserts the framebuffer matches the DAC reference
  byte-for-byte; it self-skips without the capturer, so run `pnpm emulator`
  (which needs `pnpm toolchains` first) to exercise it. The capturer is built
  from `emu-harness/gb/capture.c` against `libsameboy`; web sessions get it via
  the `.claude/` SessionStart hook.
- CLI tests exercise both the pure `run()` function and the spawned built binary;
  the binary test skips when `dist` is absent, so run `pnpm build` first to
  include it (CI always does).
- The web suite is Playwright, not Vitest: `pnpm test:browser` builds the app,
  serves the _built_ bundle, and runs every spec in Chromium + Firefox + WebKit.
  `packages/web/test/e2e/determinism.spec.ts` is the doc-07 parity contract, and
  it now covers all four domains: it converts the bundled demo image, builds
  `caves` **once per console with a backend**, arranges a track and demakes an
  effect — in Node through the engine
  packages and in the page through its workers — and compares the exported PNG,
  the cartridge, and the audio's `.vgm` + sidecar + WAV + cartridge
  byte-for-byte. Narrow the browsers with `DEMAKE_BROWSERS=chromium`, and point
  at a browser already on the machine with `DEMAKE_CHROMIUM=/path/to/chrome`
  (managed containers ship one; CI runs `playwright install`).
- **The audio E2E is where a browser-synthesized shortcut would surface.**
  `audio.spec.ts` records the Web Audio constructors before the app loads and
  asserts none of them ran, the way the game section's cartridge test does — an
  `OscillatorNode` anywhere in the graph would _sound_ fine, which is exactly why
  it needs a test rather than a review.
- **A PR runs only the gates it can break, and the gate list is derived** (doc 11
  §Affected-only gates). `tools/ci/affected.mjs` maps changed files onto packages
  and closes over their _dependents_ using the manifests' own `workspace:*`
  entries, so giving a package a dependency widens the gate with no CI edit —
  the same reason `codegen/registry.ts` is the one list that says which consoles
  build. Never replace it with a `paths:` list per job: that is a second graph,
  and it goes stale silently the first time a package gains a dependency. It
  fails open by construction — an unrecognised path runs everything, and only
  paths explicitly named inert can turn a gate off — so a new top-level
  directory is loud rather than quietly untested. `main` is never gated.
- **Branch protection requires `gate`, not the job names.** Which jobs a PR runs
  is now a CI decision, so a single aggregate check stands in for all of them:
  it passes when every job that ran succeeded and treats a skipped job as a
  pass. Adding, splitting or renaming a job therefore needs no change in the
  repo settings — but removing it from `gate`'s `needs:` list would make it
  unenforced, which is the one way to make a green PR mean less than it says.

## Gotchas

- **The prep objective is perceived equivalence, not per-pixel closeness**
  (doc 04 §The objective — a deliberate direction change): under palette
  pressure, keeping regions _distinct_ and exaggerating tone/chroma the way
  period artists did beats minimizing raw ΔE; a bounded coherent grade is
  nearly free to the judge. Never "improve" the judge back toward pure
  per-pixel ΔE, and keep round-trip idempotence on authored art as the
  zero-pressure guardrail.
- NES attribute cells are 16×16, not 8×8 — a load-bearing detail for the fitter.
- **`prep` works in the console's _author space_**: on the GBC the `cgb` DAC
  model is an LCD _panel filter_, so fitting/judging/storage use raw RGB555
  expansion (matching the E2E — SameBoy runs with color correction disabled);
  the panel sim is opt-in via `--dac-colors`. Consoles whose DAC model is the
  hardware's own output (NES NTSC, MD VDP, mono ramps) author in display
  colors. `inspect`/`gen` accept a compliant PNG in either encoding (doc 04).
- **A coarse colour lattice is what makes a fit slow, not a big picture.** A
  k-means centroid is snapped to the hardware lattice every iteration, so on a
  Master System's sixty-four colours two centroids collide constantly and clusters
  empty; on a Game Gear's four thousand ninety-six they almost never do. That is
  why the same 256×192 source took forty-five seconds for one console and eight
  for the other. Before reaching for `--effort fast` on a slow console — which
  drops the tournament to one candidate and _is_ a quality change — profile it:
  the last time this came up the answer was a redundant scan, and removing it was
  byte-identical.
- **Prep quality changes need eyes, not just numbers**: run `pnpm eval:prep`
  and look at the side-by-side sheets in `tools/prep-eval/out/`; the behavioral
  floors live in `packages/core/test/quality.test.ts`. Drop extra real-world
  sources into `tools/prep-eval/local/` (gitignored — never commit assets that
  aren't public domain). Pass a console to check another family —
  `pnpm eval:prep -- nes` is the fixed-master path, which is not what the default
  battery exercises.
- **Every slot the console has is a slot the fit must spend**, and a slot left
  unspent is invisible in every number the tournament reports: the fit is
  internally consistent, and the judge scores what it produced rather than what
  it could have. It surfaced as NES title screens in six colours of a possible
  thirteen. Two causes, both now held by `quality.test.ts`. Two centroids can
  converge on different Oklab means and snap to the _same_ lattice colour —
  routine on a fixed master palette, where the shadow end is sparse — and
  dedupe then returned a palette shorter than the caller asked for, so
  `latticeKmeans` tops up from the point it serves worst. And a sub-palette that
  loses all its cells can never win one back, because a cell only ever moves to
  the palette that serves it _best_ and an unused one serves nothing, so
  `seedUnusedPalettes` reseeds it from the cell its own palette serves worst.
- **A reserved backdrop is a frozen centroid, not a colour prepended
  afterwards.** On a `sharedIndex0` console index 0 is decided before the fit, so
  it goes _into_ the k-means and competes for points: the other K−1 then cover
  what the backdrop cannot. Fitting K−1 free colours over the whole cell and
  putting the backdrop in front of them is how a Nintendo palette came to hold
  three colours on hardware that has four — one of the free centroids simply
  landed back on the backdrop and dedupe dropped it.
- DAC models are tested artifacts: they decide pixel-perfect emulator comparisons.
  The MD `md-vdp` model reproduces genesis-plus-gx's Mode-5 normal-intensity
  color exactly (its `MAKE_PIXEL(2·code, …)` in 5:6:5); the SMS/GG cores render
  16-bit, so their E2E compares in RGB565, not 8-bit.
- MD tile 0 is reserved blank/transparent: color index 0 is transparent and
  reveals the second scroll plane, so the `md` codegen shifts real tiles to
  index 1 and the harness leaves plane B pointing at the (blank) tile 0 → the
  backdrop shows through, not stray patterns. The SMS/GG harness terminates the
  sprite list (Y=$D0) for the analogous reason.
- The `sms`-family ROM builder offsets the image into the name table by the VDP
  crop margin so the Game Gear's 160×144 window lands on the art; the MD harness
  addresses its data with absolute (not PC-relative) loads because the tile blob
  can exceed the 68000's ±32 KiB PC-relative range.
- **The WonderSwan's screen orientation is a setting, not a fact.** The core
  defaults to landscape but takes `wswan_rotate_display` as an option, and a
  rotated capture fails in a way that reads like a fitter bug — so the E2E asks
  for landscape explicitly. Its cartridge is packed by demake
  (`cli/src/rom/wsc.ts`): NASM assembles only the _last_ 64 KiB bank, which is
  the one the V30MZ answers segment $F with after reset, and the builder
  prepends the rest of the 4 Mbit cartridge and patches the footer checksum
  (the sum of every byte but the two it lives in — computable only once the
  whole cartridge exists).
- **The mono WonderSwan (`ws`) spec is knowingly optimistic** and is _not_ the
  `wsc` family: it declares one eight-entry palette at 4bpp, but the hardware
  has 2bpp tiles and four-entry palettes drawing from an eight-shade pool. Doing
  it properly needs a tiled-mono fitter (doc 13 §Phase 5) — do not "fix" it by
  pointing `ws` at the colour backend, which would emit tiles the mono display
  controller cannot decode.
- **The PC Engine's BAT is fixed at VRAM word $0000**, so characters cannot start
  there: the harness gives the BAT 32×32 entries (words $0000–$03FF) and puts the
  first character at word $0400 — character 64 — which `cli/src/rom/pce.ts` adds
  to every BAT entry, along with a blank character for the cells the image does
  not cover (otherwise the area outside the image renders the BAT _as pixels_).
  The harness also programs VDS + VSW = 14, because beetle-pce-fast captures from
  scanline 14 onward: that puts the first active line on the frame's first line,
  the same trick as the SNES's `BG1VOFS = -1`.
- The PC Engine needs **no new DAC model**, and that is a fact worth keeping:
  beetle-pce-fast expands each 3-bit VCE code as `36 × code` while demake's
  `expandChannel` replicates bits, and the two agree on all eight codes once
  reduced to RGB565 — which is the core's own framebuffer depth. Compare in 565
  (`to565`) and it is exact; do not "fix" the disagreement in 8-bit space.
- **The SNES scrolls by one line**: the PPU renders screen scanline N from BG
  line `BGnVOFS + N + 1`, so the harness sets `BG1VOFS = -1` ($3FF). With zero
  there the whole image is one pixel low and every E2E case fails by exactly a
  row — the "shifted image" entry in doc 10's triage guide, in the flesh.
- mGBA (GBA) and DeSmuME (NDS) render 15-bit consoles into a 16-bit framebuffer
  and widen green with a plain shift, not bit replication, so those E2Es compare
  in **RGB555** (`to555` in `test/_emu-battery.ts`) — the console's real depth.
  The 565 cores (SMS/GG/MD/SNES) keep using `to565`.
- GBA/NDS 4bpp tiles are packed nibbles with the **left pixel in the low nibble**
  (`packPacked4Le`) — the mirror image of the MD's `packPacked4`. SNES 4bpp is a
  third layout again (`packSnes4`: plane pair 0/1 per row, then 2/3).
- The DS reuses the `gba` codegen emitter verbatim (identical 2D-engine formats);
  only the ROM edge differs. demake writes the `.nds` cartridge header itself
  (`cli/src/rom/nds.ts`) — ARM9 at ROM offset 0x4000 with entry 0x02000000, an
  ARM7 stub at 0x02380000, header CRC16 — so no ndstool or devkitARM is needed;
  the Nintendo logo area stays zero (direct boot never checks it, and we ship no
  copyrighted logo).
- ARM harnesses must keep their literal pool next to the code (`.pool` before the
  `.incbin` blobs): `ldr rX, =value` only reaches ±4 KiB and the tile blob is far
  bigger.
- SG-1000 (TMS9918 Graphics II) is _not_ a tiled sub-palette layout: its rule is
  two colors per 8×1 row, handled by `pipeline/fit-tms.ts` and validated by a
  dedicated oracle branch (there is no `subPalettes` on a `scanline` spec — don't
  cast it to `TileLayout`). Its Z80 harness reuses WLA-DX; the master palette is
  derived from genesis-plus-gx's native RGB565 `tms_palette`, not the 32-bit one.
- **A driver tick is attributed by program counter, never by a marker.** The
  audio proof watches `cpu.pc` for the driver's `Tick` label (from the build's
  symbol table) and taps `Gameboy.apuTap`, which _observes_ rather than
  intercepts. A ROM that had to be instrumented to be testable would not be the
  ROM that ships, and an oracle that changed what the hardware saw would be
  testing itself.
- **`ld [$FF00+c], a` is why packed register numbers are low bytes.** The audio
  driver's data holds `$26`, not `$FF26`, because the write loop carries the
  register in `c`. A chip whose registers are not in high RAM would need a full
  address and therefore a different packing — do not assume the format
  generalises for free.
- **The web app must never grow conversion logic.** Everything it shows comes
  from `@demake/core` through `src/worker/core.worker.ts` — console list,
  strategy portfolio, palettes, stats, manifest bytes. A second implementation
  of anything the CLI does (a manifest shape, a symbol-name rule, a console
  summary table) is how parity dies; if the web needs it, it moves into core
  first, as `buildManifest`/`encodeManifest` did.
- **An engine imported on the UI thread is a second copy of it in the bundle.**
  A worker is a separate bundle, so `@demake/core` reached from a component is
  shipped twice — and the doc-07 JS budget is a sum precisely so that shows up.
  The game section built its cartridge inline until the Sega backend needed the
  room; it goes through `core.worker.ts` now, which is where every path that
  touches `@demake/core` belongs anyway. What may stay on the main thread is what
  has no engine under it: the language front end, the interpreter, and the
  emulator cores, because playing a cartridge is what the page does with one.
- **The service worker may cache anything but the shell.** Every asset is
  content-hashed, so cache-first is right for all of them — and wrong for
  `index.html`, the one URL that never changes and the file that names those
  hashed chunks. Cached, it asks for the chunks it already has, so a returning
  visitor stays on the build they first loaded and a deploy reaches new visitors
  only. Navigations therefore go to the network first and fall back to the cache
  (offline still works). No browser test can catch this — a Playwright context
  always starts with empty storage, so the suite only ever sees a first visit —
  which is why `packages/web/test/sw.test.ts` runs the worker in a fake global
  instead. Changing `CACHE`'s name is what rescues visitors holding a poisoned
  shell, and it costs them one further reload.
- **A one-run Lighthouse audit is a coin toss on a shared runner.** The job asks
  for `numberOfRuns: 3` and asserts against the best of them, which is lhci's
  default `optimistic` aggregation for a `minScore`. Noise only ever makes a page
  look _slower_ than it is, so the least-contaminated run is the truthful
  measurement, and a genuine regression still drags all three. Before touching
  the thresholds when this job fails, reproduce locally
  (`pnpm build:web && pnpm --filter @demake/web exec lhci autorun`) and check the
  entry chunk against `pnpm check:web-budget` — the score falling while the
  payload is flat means the runner, not the page.
- **CI's server-start traps, both learned the hard way.** (1) Actions sets
  `CI=1`, which makes Vite _colourise_ its banner — `Local:` arrives as
  `Local\e[22m:`, so any ready-pattern matching that literal never fires;
  `lighthouserc.json` matches the bare port and the job sets `NO_COLOR=1`.
  (2) Bound to the name `localhost`, the preview server can listen on `::1`
  alone while everything polls `127.0.0.1` — Playwright then dies on "Timed out
  waiting … from config.webServer" and Lighthouse audits an error page. The
  `preview` script therefore pins `--host 127.0.0.1 --strictPort`; keep it that
  way, and don't leave a stray preview on 4173 (Playwright reuses an existing
  server locally, even one serving a different base).
- Toolchain provisioners are best-effort by design (they must never break a
  session or a SessionStart hook), so **CI sets their `*_STRICT=1` variables**:
  a failed build then fails at the provisioning step with the tail of its build
  log, instead of silently skipping suites later. RGBDS additionally apt-installs
  its own build deps (bison, pkg-config, libpng-dev) — runner images ship libpng
  without its headers, which fails cmake in about a second.
- Web determinism has one extra trap the CLI doesn't: anything the _page_ feeds
  the engine must itself be engine-independent. That is why the bundled demo
  image (`src/lib/demo-image.ts`) uses no `Math.sin`/`Math.random` — the
  determinism spec converts it, so a transcendental there would turn a real byte
  mismatch into an untraceable one.
- **`ld de, addr` clobbers `d`, and `d` is often live.** `PushSprite` takes the
  tile number in `d`, so building the OAM address with `ld de, OAM_SHADOW`
  silently made every object draw tile `$C0`. The shadow is page-aligned, so the
  address is `ld h, HIGH(shadow)` plus a shifted count — cheaper as well as
  correct. Check the register a helper takes its arguments in before reaching for
  a 16-bit load.
- **A machine description that is wrong _and consistent_ passes everything.**
  The Mega Duck's I/O map is used to build the cartridge and to route its writes
  in `@demake/dmg`, so a swapped pair cancels out: the game traces perfectly, the
  audio diff matches, and the ROM would do nothing on real hardware. That is why
  `packages/core/test/megaduck.test.ts` carries SameDuck's numbers _literally_
  and compares against those rather than against the table's own inverse — and
  it caught exactly that, twice. Any future variant console needs the same
  treatment: pin the description against the hardware, not against itself.
- **Inverting a sparse map by flipping every entry lets the identity clobber it.**
  Building `GB_TO_MEGADUCK` from all 128 entries of `MEGADUCK_TO_GB` put `OBP0`
  back at `$48` — its Game Boy address — because offset `$48` identity-maps to
  itself and is written _after_ the entry that belongs there. Invert only the
  entries that moved.
- **The gaps a register move leaves are not identity, they are nothing.** Mega
  Duck offsets `$1C`–`$1F` and `$47`–`$4B` have no register behind them, and they
  are `NR32`/`NR33`/`NR34` and the palettes on a Game Boy — so falling through as
  identity would let a write to an empty address change the music. They map to
  `MEGADUCK_UNMAPPED` and the core stores them as plain bytes.
- **A Game Boy screen is green, and that is a tested artifact.** `@demake/dmg`'s
  four DMG shades are the `dmg` console spec's `mono-ramp` DAC model, pinned
  against it by `packages/dmg/test/ppu.test.ts`, and the same four the SameBoy
  capturer compares in. Anything that measures "brightness" on that framebuffer
  has to account for it: the web E2E's `romPainted` counts pixels that differ
  from the modal colour precisely because a red-channel threshold called the
  whole green screen dark and stopped distinguishing anything.
- **A `gbc` cartridge declares itself CGB-_only_ (`$C0`), not CGB-aware.** It
  programs palette RAM and the second VRAM bank from its first instruction, so a
  DMG running it would show the game in whatever BGP happened to hold. A
  cartridge that refuses to run is a better answer than one that runs wrong, and
  `demake build -c gb` is the cartridge for that machine. The flag is the last
  byte of the title field, so a colour title is still fifteen characters.
- **The Nintendo boot logo is never checked in.** The build leaves that area
  zero, so a built ROM direct-boots in emulators and does not boot on original
  hardware; `demake build --boot-logo` asks `rgbfix` to stamp it. Default output
  is therefore byte-identical between the CLI and the browser, which is the
  doc-07 parity contract restated for games.
- **A 65816 immediate's width is not in its opcode**, so `Asm65816` makes it the
  caller's: `imm8` and `imm16` are different operands and the assembler infers
  nothing. A `rep`/`sep` behind a branch is enough to make the width unknowable at
  assembly time, and guessing wrong does not produce a wrong value — it produces a
  wrong instruction stream, because the extra operand byte is executed.
- **The 65816's operand constructors collide with the 6502's by name and not by
  type.** `@demake/core` exports the five that clash under a `snes` prefix and
  `codegen/snes/ops.ts` aliases them back in one place, so a call site still reads
  like assembly and nothing can hand a 6502 operand to a 65816 instruction.
- **The sound processor's mailbox is inside the picture's register range.**
  `$2140`–`$217F` lies under `$2100`–`$21FF`, so a bus that asks "is this a PPU
  register" first answers every mailbox read with the PPU's — and a cartridge then
  spins for ever in the boot handshake waiting for a greeting the sound side has
  already sent. It presents as a game that never starts, with the sound
  processor's program counter parked in its boot ROM. `@demake/snes` decodes the
  mailbox first, and `packages/audio/test/spc.test.ts` would not have caught it,
  because that file talks to the S-SMP directly.
- **The S-DSP interpolates linearly here and by a Gaussian window on the
  hardware.** That is the one place the chip model is knowingly not the chip, and
  it is stated in `s-dsp.ts` rather than hidden: the real filter is a 512-entry
  constant table, and a table transcribed with one entry wrong is worse than an
  interpolator that says what it is. It affects timbre only — doc 16's Level A
  proof compares register writes — and it is what doc 16's Level B would need.
- **`@demake/snes` renders BG1 and the objects and nothing else.** The other three
  backgrounds, the two extra modes with them, colour maths, windows, mosaic and
  offset-per-tile are absent rather than half-implemented, because a renderer that
  answered plausibly for hardware nothing drives is a renderer nobody is checking.
  A backend that starts programming one of them has to implement it here first.
- **The Super Nintendo's plot list is two words an entry against a plan that
  allows two bytes a cell**, so the emitter caps recording at half `plotMax` and
  says so. The other three backends write four bytes an entry into the same
  allocation and are saved only by their HUDs being small; if that ever changes,
  the fix is `layout.ts`'s, not a backend's.
- The PNG encoder must stay deterministic (no libpng drift) once it exists.
- Source imports use explicit `.js` extensions (NodeNext ESM); Vitest resolves
  them to `.ts` via the workspace alias.

## Commit rules

- **No AI attribution of any kind in commits**: no `Co-Authored-By` trailers, no
  `Generated with` lines, no session links, no model names — in commit messages,
  PR titles/bodies, or code comments.
- **Never name other repositories or prior personal projects anywhere in this
  repository** — not in commit messages, docs, code, comments, or fixtures.
  This includes the earlier project this tool's design originated from: refer
  to it only generically (the docs use "the predecessor tools"). No project
  names, no links to it.
- Write commit messages about the change itself: imperative subject ≤ 72 chars,
  body explaining what and why (Conventional Commits).
- Develop on the designated feature branch; never push to `main` directly.

## Documentation rules

- `docs/` is the source of truth for design. If you change a decision, update
  every doc that states it (they cross-reference each other by number).
- Keep this file current: any workflow or convention you introduce that an agent
  needs on day one gets a line here, in the same PR.
