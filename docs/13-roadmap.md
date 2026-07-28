# 13 — Roadmap

Phases are sequential but internally parallelizable; each has explicit acceptance
criteria ("done means"). Consoles ride the tier schedule from doc 03. Per the
product direction, scope is driven by completeness and quality, not effort budgets —
phases order the work; they don't trim it.

## Phase 0 — Foundations

Repo scaffolding: pnpm workspaces, strict TS config, eslint/prettier + custom rules,
Vitest, CI skeleton (lint + unit on 3 OSes), changesets, README/CLAUDE.md/
CONTRIBUTING/SECURITY stubs, name check + npm scope reservation (`demake`,
`@demake/*`).

**Done means**: green CI on a hello-world core function imported by a stub CLI that
passes `--help`/`--version`/exit-code tests; npm names secured.

## Phase 1 — Engine spine + first console (GBC)

- Image layer: PNG codec (ours), WASM JPEG/WebP/GIF/BMP decode, RGBA pipeline,
  color spaces (linear/Oklab), seeded PRNG, DAC models (CGB curve first).
- ConsoleSpec schema + `gbc` spec (+ `dmg` — nearly free and exercises mono path).
- Pipeline stages 0–7 for tiled layouts (doc 04), generic fitter with alternating
  refinement + restarts; compliance checker (`inspect`) as independent oracle.
- CLI: `prep`, `inspect`, `consoles` per doc 05 (flags, exit codes, stdin/stdout,
  `--json`); `cli-spec` generation pipeline incl. man pages.
- **De-risking spikes** (start immediately, parallel): (a) the libretro capture
  harness prototype; (b) SameBoy/Mesen2 headless capture proof; (c) Node SEA binary
  proof. These decide doc-10 tooling while the engine is built.
- Hardware-spec verification pass for Tier 1 specs (primary-source citations).

**Done means**: predecessor portrait corpus preps at meet-or-beat quality vs the
original tool (metric comparison checked in as a test); property suite green;
determinism (Node 3-OS) green.

## Phase 2 — gen + the proof loop (GBC first, then Tier 1 breadth)

- Codegen framework + `gb` family backend (bin/asm/c), exact-path detector,
  manifest sidecar; `gen` CLI with implicit-prep.
- `rom` format: GB harness ROM, RGBDS toolchain container, SameBoy headless capture,
  **first pixel-perfect E2E test green** — the moment the credo is real.
- **Tournament + judge** (doc 04): candidate portfolio framework over the Phase-1
  stage library, worker-pool parallel execution with stage-DAG memoization, the
  multi-metric perceptual judge (validity/glitch gates, relational + absolute
  metric groups per doc 04 §The objective, aggregation), `--strategy` surface,
  human-calibration set collection and weight freeze.
- **Perceived-equivalence judge increment** (doc 04 §The objective — the
  post-eval-battery direction change): grade-aligned ΔE (isotonic monotone L +
  bounded chroma gain + bounded hue drift), asymmetric separation retention,
  asymmetric local contrast, ramp-ordering monotonicity, naturalness bounds,
  palette-pressure-scaled weights; graded (`expand`/`punchy`) candidates in the
  portfolio; separation-aware fitting term. Guardrails: round-trip idempotence
  on authored art stays a hard test, absolute palette recall keeps weight.
- Quality bench: fixture corpus + error-metric tracking + prior-art comparison
  (doc 04); `--effort max` annealing pass; tile-budget merge stage.
- Roll Tier 1 breadth, one console at a time, each = spec + backend + harness +
  toolchain image + E2E green: **NES → SMS → MD → SNES → GBA → NDS**
  (ordered easy→hard on codegen/emulator automation; NES early because its 16×16
  attribute cells and fixed master palette stress the fitter design).

**Done means**: `hd-many-colors.png` passes the full prep→gen→ROM→emulator→
pixel-perfect loop for all eight Tier 1 consoles in CI.

**Status: complete.** All eight Tier 1 consoles (DMG, GBC, NES, SNES, MD, SMS,
GBA, NDS) run the whole loop, each against the shared extensive image battery
(`packages/cli/test/_emu-battery.ts`) rather than a single fixture: SameBoy for
the GB family, and the one generic libretro harness for the rest (fceumm,
genesis-plus-gx, snes9x, mGBA, DeSmuME). SG-1000 came along early with the
TMS9918 row-pair path; the Game Gear rides the SMS family. Every toolchain is a
pinned source build or a stock distro package provisioned by `pnpm toolchains` —
no Docker anywhere in the loop.

## Phase 3 — Web app

Vite+Preact app per doc 07: worker-hosted core, full option UI, previews with
DAC/PAR rendering, exports (PNG/manifest/asm/c/bin; in-browser ROM for GB + NES),
equivalent-command display, PWA, Pages deploy, Playwright + browser-determinism CI.

**Done means**: github.io live; browser output byte-identical to CLI across
Chromium/Firefox/WebKit in CI; Lighthouse ≥ 95.

**Status: built.** `packages/web` ships the three-pane app on a worker-hosted
core: console picker grouped by tier with per-console constraint summaries, the
full doc-05 option surface (advanced options collapsed), previews with the DAC
model and pixel-aspect correction, the fitted palette strip, fit/tile-budget
stats, the tournament scoreboard doubling as a strategy picker, exports for
PNG/manifest/asm/C/bin, the live equivalent-command line, option permalinks, and
an offline service worker. `pages.yml` deploys `main` to Pages; `test-browser`
runs the Playwright functional + **byte-identity** suites in three engines, and a
gzipped-JS budget check guards doc 07's 300 KB. In-browser ROM assembly (the
GB/NES stretch goal) is not implemented: the ROM button explains that and points
at the CLI, which is what doc 07 specifies for a console whose ROM the browser
cannot build.

## Phase 4 — Desktop app + distribution

Tauri app per doc 08 (sidecar CLI, shared frontend, batch mode); Node SEA binaries;
`release.yml` end-to-end (npm provenance, signed installers, SLSA attestations,
auto-update); library docs + Typedoc site; generated agent guide + `help --agents`.

**Done means**: a tagged release automatically ships npm + 5 binaries + 3 desktop
installers + Pages + docs, all from one tag; desktop parity E2E green.

## Phase 5 — Tier 2 rollout

PCE, Game Gear, TMS9918 pair (SG-1000/Coleco + the row-pair fitter), Neo Geo,
Atari 7800, WS/WSC, NGPC, Lynx — same per-console definition-of-done as Phase 2.
Plus: per-scanline palette scheduling (Lynx/framebuffer enhancement), mode-selection
optimizer polish (SNES/GBA/ANTIC).

**Done means**: all Tier 2 consoles E2E-green in nightly CI; docs/README support
table auto-updated.

**Status: started.** Two Tier 2 verticals are complete and ride the same loop as
Tier 1, each reusing an existing edge rather than adding one:

- **PC Engine** — a `pce` codegen backend (word-planar HuC6270 characters, BAT
  words, 9-bit VCE palettes), a 64 KiB HuCard harness assembled by
  `wla-huc6280` (a fourth CPU target on the WLA-DX build the SMS/SG-1000/SNES
  families already provision), and a pixel-perfect E2E against beetle-pce-fast
  through the generic libretro runner.
- **WonderSwan Color** — a `wsc` backend (packed 4bpp tiles, screen-map words
  with palette/bank/flip, 16 RGB444 palettes), a 4 Mbit cartridge assembled by
  **NASM** (the V30MZ is an 8086-compatible core, so a stock x86 assembler is
  the native tool, not an approximation) with the cartridge footer and its
  checksum packed by demake itself, and a pixel-perfect E2E against
  beetle-wswan.

Both march the shared image battery. The Game Gear shipped with the SMS family
in Phase 2 and SG-1000 with the TMS9918 path.

What remains of Tier 2 splits by what is blocking it:

- **WonderSwan (mono)** is blocked on the engine, not the toolchain — its ROM
  path would be the `wsc` one with 2bpp tiles. The hardware shows four shades
  per tile through sixteen palettes that pick from an eight-shade pool, itself
  picked from sixteen LCD levels: a *two-level* mono palette with per-tile
  selection, which no fit path expresses (the mono path is single-palette;
  the tiled path fits RGB lattices). Its current `ConsoleSpec` papers over that
  with one eight-entry palette at 4bpp, which the mono hardware cannot display —
  so `prep -c ws` is, today, optimistic. Fixing it means a **tiled-mono fitter**
  and is the next engine increment here, not a backend.
- **ColecoVision**, **Neo Geo** and **Lynx** are gated on emulators that require
  copyrighted BIOS images, which the doc-10 loop will not ship.
- **Atari 7800** needs a display-list layout path that does not exist yet.
- **NGP/NGPC** has no assembler for the TLCS-900H in any distro archive.

## Phase 6 — 1.0

Freeze CLI/API surfaces; full-corpus nightly green two weeks running; docs complete
(man pages, site, README demo GIF); Homebrew/Scoop; `v1.0.0`.

**Done means**: every doc-01 success criterion checked off in the release PR.

## Phase 7+ — Post-1.0

- **Tier 3 long tail**: 2600 kernels, Atari 8-bit/5200, Intellivision, Virtual Boy,
  Pokémon Mini, and the remainder — each lands with its harness or ships prep-only
  with a documented "codegen pending toolchain validation" status.
  - **Mega Duck** is the closest of these: its *data* formats are the DMG's
    exactly, so it already rides the `gb` codegen family for `bin`/`asm`/`c`.
    What it does not share is the display program — its LCD registers live at
    `$FF10`–`$FF1B` instead of `$FF40`–`$FF4B` and LCDC's bits are shuffled — so
    `rom` is withheld rather than quietly assembling a Game Boy cartridge. The
    vertical is a `gb`-family harness variant plus the **SameDuck** libretro
    core (a SameBoy fork, no BIOS files); `Core/gb.h` there is the register map
    and its `display.c` the LCDC bit meanings.
- In-browser ROM assembly for more families; WASM-accelerated hot kernels if
  profiling asks; palette-cycling & per-scanline tricks as opt-in "expert" flags;
  sprite/animation mode (the reserved schema slot); home-computer specs if demand
  appears; tiny fixed-weight learned perceptual metric as a judge input
  (doc 04 §Aesthetics — admissible only if byte-deterministic and browser-sized).
- **Demotic — the game language (new domain)**: docs [14](14-demotic.md) and
  [15](15-demakefile.md). Declare a game once in `.dmt` and build it for every
  tiled-sprite console, with a Demakefile deciding targets, art conversion and
  artifacts. Ordered so each step is provable before the next begins:
  - **D1 — language + preview** *(done)*: front end, reference interpreter,
    relative units, compile-time hardware diagnostics, `.test.dmt` runner, trace
    oracle, browser section, Pong fixture.
  - **D2 — Demakefile + `build`** *(`build` done; the manifest is not)*: `demake
    build` exists and is the zero-config path doc 15 §You do not need one
    describes — flags stand in for the file, and it now demakes the game's art
    through the image pipeline on the way. The manifest itself and
    `check`/`init`/`fmt` are still to come.
  - **D3 — first backend (`gb`)** *(done)*: `packages/demotic/src/codegen/`
    compiles a game to SM83 machine code written for it — no fixed engine, no
    program tables at run time. Every game in the example library builds and
    matches the reference interpreter tick for tick, in
    `packages/demotic/test/rom.test.ts`, levels and camera included. The harness
    is `@demake/dmg` rather than SameBoy, which is what makes the conformance
    loop a plain unit test: no toolchain, no emulator install. The gaps D3
    originally carried are closed: levels, tiles and the camera compile; art is
    demade through the image pipeline; and speed went from 3–11 Game Boy frames
    per tick to 1.00–1.03, so a game keeps up with the hardware. Doc 14 §2 has
    the reasoning for the reversal and the measurement.
  - **D3b — colour (`gbc`)** *(done)*: `demake build -c gbc` produces a real
    Game Boy Color cartridge. It is the *same machine code* with a second half
    bolted to the renderer — an attribute byte per background cell in VRAM bank
    1, eight background and eight object palettes of RGB555, a tile bank that
    may spill into the second bank — so a game traces identically on both
    consoles and `rom.test.ts` asserts exactly that. The art is demade by the
    image engine's RGB-lattice path rather than its mono one, including a colour
    sprite fit that decides *which objects share a palette*
    (`core/src/pipeline/sprite.ts`); one background and one object palette are
    reserved for the font, so a score stays legible over a title screen whose
    palettes were chosen for the title screen. Colour costs cartridge — around a
    kilobyte for a game with two demade backdrops — which is a fact the build
    reports rather than hides.
  - **D4 — breadth** *(`nes` and `sms`/`gg` trace-green)*: `nes`, `sms`/`gg`,
    `md`, `snes` backends, each trace-green then framebuffer-green. A backend is
    per-family; the `Program` it compiles is not.

    The NES half is built: `demake build -c nes` produces a real NROM cartridge
    — 6502 machine code written for the game, art demade by the image pipeline
    on the way — and every game in the example library reproduces the reference
    interpreter tick for tick, in the same battery both Game Boys run
    (`packages/demotic/test/rom.test.ts`). Speed is the published figure on this
    console too: every fixture is inside one frame per tick.

    What the second console changed is the shape of the first. Compiling a
    Demotic program is now an *interface* — `codegen/backend.ts` — that a console
    implements: it answers where state goes, what it cannot compile, how its art
    and audio are demade, how many tiles it has, and how a plan becomes a
    cartridge, and everything between those answers happens once in code neither
    console owns, including doc 14's seven tick steps in doc 14's order. What a
    program *means* moved to `codegen/shape.ts` for the same reason. The dividing
    line is that anything which would emit an instruction stays in the backend,
    because a shared instruction layer between a machine with seven registers and
    one with three would be a fake common denominator.

    Framebuffer-green is what remains: the NES image E2E already runs the shared
    battery through fceumm (Phase 2), and pointing it at a *game* cartridge needs
    doc 10's scripted input tape, which is the same addition every console's
    game-level E2E needs. Until then the rendering oracle is
    `nes-rom.test.ts`, which checks the nametable against the level grid the
    cartridge carries, cell by cell, before and after the camera has travelled.

    Sound is built: a generated 6502 driver plays the demade schedules on the
    2A03, on the picture's own interrupt because the NES has no timer a driver
    can have without burning the DMC channel (§A5). The proof is the Game Boy's
    one console over — `packages/demotic/test/audio.test.ts` now runs its whole
    battery on both machines, booting each cartridge and diffing every register
    write against the schedules the demakers produced. A game whose audio files
    were not supplied still builds, plays silently, and records what a rule asked
    for, so a silent build traces identically to a sounding one.

    What it also exposes is the **cartridge budget**, and one example runs out:
    the shooter's NES build is under two hundred bytes over with its music in it. The audio is
    not the reason — 1742 bytes there against 2076 on the Game Boy, because the
    driver ticks at 60 Hz rather than 120 — the code is: the same program's 6502
    is around 3.8 KiB larger than its SM83, and a backdrop is a 960-cell
    nametable against 360, on a cartridge with no mapper. The suite asserts the
    overflow rather than skipping the fixture. The obvious place to win it back
    is the backdrop nametable, which is stored raw; the play screen's would pack
    to a third of its size and the title screen's to about the same, so a
    literal-and-run encoding is worth roughly six hundred bytes a game.

    **The Sega 8-bits are the third console, and they cost the interface
    nothing.** `demake build -c sms` (and `-c gg`) produces a real 32 KiB Sega
    cartridge — Z80 machine code written for the game, `TMR SEGA` header and
    checksum, art demade into 16-colour tiles — and the whole example library
    traces identically there, in the same battery, at the same one frame a tick.
    Nothing moved out of `backend.ts` or `shape.ts` to make room for it, which is
    the strongest evidence so far that the interface is one: the only thing the
    Sega backend owns is an instruction set.

    What the Z80 made cheap and what it made dear are both worth recording. The
    16-bit register file makes 32-bit arithmetic short — `add hl,de` with `adc
    hl,de` is a 32-bit add in four instructions and no pointer — and `ldir` makes
    a block copy one instruction, which is what a collision box and a VRAM upload
    both are. What it lacks is a cheap *region*: there is no page zero and no high
    RAM, every address is three bytes, so the layout has no `fast` pool at all and
    the cheapness lives in the registers instead. And the name table is exactly as
    wide as the screen — thirty-two cells against thirty-two — so a scrolling
    scene has no spare column to paint into and writes the new one into the cell
    straddling the masked left edge, which is what `R0` bit 5 is turned on for.

    Framebuffer-green is what remains here too, and behind the same scripted
    input tape. Until then `sms-rom.test.ts` is the rendering oracle and
    `sms-arith.test.ts` the arithmetic one — every 16.16 operation assembled on
    its own, run in `@demake/sms` and compared with `fixed.ts`, because a multiply
    that floors the wrong way makes a game that plays almost right and diverges a
    thousand ticks later.

    **Everything the trace could not see was wrong, and the list is worth
    keeping**, because every entry is a thing this hardware does that neither of
    the first two consoles does. The background layer is **opaque**: colour zero
    is an ordinary colour drawn from the cell's own bank, and register 7's
    backdrop fills the border and the masked column and nothing else — so a
    renderer that treated it as transparent showed the border through every flat
    area a demade picture has, which is a whole sky. A name-table entry's second
    byte carries **flip bits**, so the fitter stores one tile for up to four
    orientations, and a pool that kept the tile number and dropped those bits drew
    the right-hand end of every mirrored brick, ledge and letter the wrong way
    round. The vertical scroll register wraps at **224** and not at 256, because
    the name table is twenty-eight rows — reducing it in the accumulator loses
    thirty-two pixels every time the sum passes 255, and the four rows a picture
    slid by were the four nothing had painted. A colour is **two bytes on a Game
    Gear**, so a boot upload that counted thirty-two of them left the whole sprite
    bank — every object, and the paper a caption is read on — unwritten. And a
    scene with no picture of its own has to upload the build's palette rather than
    inherit the last scene's, or a level comes out in a title screen's colours.

    The sharpest of them is not a fact about the VDP but about the **two-byte
    control port**: acknowledging the frame interrupt means reading that port,
    which resets its half-written state, so a handler landing between the two
    bytes of an address leaves the second read as a first and one cell of the
    screen is written somewhere else entirely. The rest of the runtime is safe by
    construction — `UploadFrame` runs a few instructions after the interrupt it
    waited for — so only the full redraw needed `di`, and the frame it spends
    there is owed rather than lost.

    **The cartridge budget runs out here too, and further.** The Sega name tables
    are packed the way the NES's are — literals and runs, but of whole *cells*,
    because an entry is a tile byte and an attribute byte and a run of identical
    cells has no byte runs in it at all — which is worth about 1.5 KiB a game and
    leaves the tightest fixture, the caves, at 1393 bytes free. The shooter still
    does not fit: 34.6 KiB against 32.7 on a Master System, 33.9 on a Game Gear.
    The tile bank is a quarter of the cartridge on its own (254 tiles at
    thirty-two bytes, because characters here are ROM *and* video RAM), and the
    rest is the same debt the NES paid off and this backend has not — a collision
    emitter that is 9.3 KiB for that game and an integrator that is 2.8, both the
    same body repeated with a different address in it. The other way out is the
    one the hardware offers: these machines take **bank-switched cartridges**, the
    slot at `$8000` is entirely unused today, and `@demake/sms` already implements
    the mapper's registers. Neither is done; the suite asserts the overflow.

    Sound is no longer the gap: there is a generated Z80 driver (§A5), and both
    machines carry their music and effects. The design question that was blocking
    it was in the packer, and it resolved the way it was expected to — the
    SN76489 puts the channel in the *data* byte and latches it across writes, so
    `channelOf(reg)` became a *factory* for a `channelOf(reg, value)` carrying a
    per-schedule latch, and `buildSmsGameAudio` refuses (`E_PSG_LATCH`) rather
    than guessing if a schedule ever opens a tick with a data byte and no latch in
    front of it. That refusal is what makes preemption safe: every run of a PSG
    stream begins with a latch byte, so a run the music skips takes its own
    channel selection with it.

    The clock is the other thing this console decided for itself. `psgBinding`
    will fit a rate to the VDP's line interrupt, and for a *game* that is the
    wrong answer — the line counter is reloaded on every scanline outside the
    active display, so a line interrupt every N lines fires a handful of times
    inside the picture and then not at all until the next frame. A game's driver
    therefore rides the frame at 59.92 Hz, like the NES's and for the same kind of
    reason, and `fitRate` now treats the frame as the candidate every other clock
    has to beat rather than as a fallback for when none is in range.
  - **D5 — Play ROM in the page** *(done for `gb`, `gbc`, `nes`, `sms` and
    `gg`)*: the browser
    compiles the
    game itself, because the assembler is ours and written in TypeScript, and
    demakes its art with our own rasteriser rather than the browser's. It boots
    the result in `@demake/dmg`, `@demake/nes` or `@demake/sms` — ours, because
    doc 07 forbids a CDN core and a WASM core we cannot read is the same bargain
    in a different wrapper. The bytes are identical to `demake build`'s, pinned by
    a Playwright spec on *every* console with a backend, and the pane offers them
    as a download. Picking a
    console in the selector changes the **cartridge**, not a setting on one:
    Game Boy Color builds a `.gbc` that the same core plays in colour because the
    machine it comes up as is the cartridge header's decision, and NES builds a
    `.nes` that a second core plays on a screen of its own shape. While the next
    cartridge demakes the pane keeps playing the one it has, so everything on
    screen — the machine's name, the canvas shape, the download's extension —
    describes the ROM that is running rather than the picker. Sound follows the
    cartridge too: the sound button plays whichever chip the running core has,
    through the same `StreamSink` and the same `@demake/chip` models.
  - **D6 — language growth**, driven by fixtures beyond Pong. Levels, tiles, a
    scrolling camera, `stream`-composed courses and a seeded `random` have
    landed (doc 14 §Levels, §Composed levels, §Randomness). What is left:
    runtime spawn, a tile layer that can *change* — a door that opens, a block
    that breaks — which needs a way to name a cell, and a camera with more than
    "follow". Scrolling is also where per-scanline sprite pressure bites, so the
    backends will have opinions.

- **Projects in the web app**: today each section holds one artifact. A *project*
  is a folder with a Demakefile at its root — a `.dmt`, its `.test.dmt`, and an
  art directory — and it is the unit the site should actually operate on:
  open one, edit any file in it, build every target. It is the same object the
  CLI already builds, so the work is the browser's file handling (File System
  Access API where available, an in-memory tree elsewhere) plus import/export as
  a zip, not a second configuration model.

- **Agent-driven demaking**: the workflow doc 01 §Why exists for, closed. Attach
  an agent, describe a game in one prompt, and get back a `.dmt`, its art assets,
  a Demakefile and ROMs for every console. Three pieces, in order of leverage:
  a **`SKILL.md`** teaching the Demotic language and the loop that produces a
  working game (cheap, useful immediately, and testable by having an agent build
  a game from it); a **Demotic MCP server** exposing `check`, `test`, `trace` and
  `build` as tools so an agent iterates against real diagnostics rather than
  guesses; and **asset generation**, where the agent produces source art that the
  image pipeline then demakes. The language was designed for this — flat,
  line-oriented, order-free, with total error recovery and structured
  diagnostics — so most of the work is packaging rather than new capability.

- **A level editor in the web app**: `.dmtl` is a text format an LLM can edit,
  and that was the point — but a person drawing a room wants to draw it. The
  planned shape is a top-level site section after the four demakers: paint into
  a grid, name tiles, mark them solid, bind art, and see the result scroll at
  every console's viewport at once. The file it writes is the same `.dmtl` the
  compiler already reads, so it is a view over the format rather than a second
  one, and a game stays hand-editable whether or not the editor was used.

- **Tile editing — a question, not a plan**: a tileset exists because hardware
  forces art to be shared, which makes it a *hardware* concern leaking into an
  authoring tool. A tile editor would therefore cut against the premise that you
  describe what you want and the tool handles the constraints. The current
  position is to avoid needing one: push harder on automatic dedup, budget
  reporting, and per-console art variants in the Demakefile. Revisit only if real
  games hit a wall the automatic path cannot clear — and if they do, the honest
  framing is a *tile budget inspector* that explains what was merged and why,
  rather than a manual editor.

- **Audio — the music and sound demakers (new domain)**: docs
  [16](16-audio-engine.md), [17](17-music-demaker.md) and
  [18](18-sound-demaker.md). Convert modern music and sound effects into
  hardware-compliant chip audio, driver data and ROMs for the same consoles.
  Same shape as the image pipeline — constrain → fit → emit → prove on emulated
  hardware — with **register-schedule equality** standing in for pixel-perfect,
  and one addition images do not need: a file you can play anywhere that is
  guaranteed to sound like the cartridge (doc 16 §The render contract). Ordered
  so each step is provable before the next begins:
  - **A1 — the chip layer** *(built, bar the test ROMs)*: `@demake/chip` models
    the GB APU, the SN76489 and the NES 2A03; `AudioSpec` and specs for six
    consoles live in `core`; the exact box-integration renderer and WAV encode
    are done, and `render` is the single path every surface makes sound through.
    Eighteen analytic vectors pass, and `@demake/dmg` now *is* a consumer: its
    APU is `@demake/chip`'s `GbApu`, so the emulator and the preview cannot
    disagree about a chip they share. Outstanding: the hardware test ROMs and
    their provisioner, and FLAC.
  - **A2 — `arrange`** *(built for MIDI; the Game Boy boots)*: ingest, analysis,
    the arrangement tournament, absolute-placement timing, the judge and the
    `.vgm` artifact run on all six consoles. Tempo is preserved outright rather
    than approximately, and a test shows the error shrinking with length rather
    than compounding. Outstanding: tracker ingest, `bin`/`asm`/`c` emit, driver
    backends beyond the Game Boy, and the listening sheets the judge weights get
    frozen against.
  - **A2.5 — the driver and the proof** *(done for the `gb` family)*: `demake gen
    <schedule> --format rom` generates an SM83 driver *for this schedule* — rests
    pulled only if it rests, an order walk only if it has one, a stop path only
    for a one-shot — packs the schedule into deduplicated blocks behind an order
    list, and assembles a 32 KiB cartridge with `core`'s own assembler. Level A
    of doc 16 §The proof runs in `pnpm test`: the ROM boots in `@demake/dmg` and
    every register write it makes is diffed against the `ChipScript`, tick for
    tick, with no tolerance and no toolchain. Both demakers are covered, because
    a track and a one-shot exercise different halves of the driver.

    This is the point at which the audio domain reaches the shape the image
    domain has — constrain → fit → emit → prove on emulated hardware — for one
    family. Level B (sample comparison against a third-party core, via the
    libretro harness's audio callback) and the other consoles' drivers are what
    remain.
  - **A3 — `sfx`** *(built for WAV; the Game Boy boots)*: eight gesture families, the class gate,
    deterministic coordinate descent with every candidate rendered through the
    chip model, and the placement contract each effect declares. A single effect
    builds into a cartridge and is proven by A2.5's Level A suite, and a Demotic
    game is now the bank: every `sound` it names is demade, packed behind one
    index and played under the music by one generated driver, with the same
    proof one level up (`packages/demotic/test/audio.test.ts`). Outstanding:
    `--variations`, standalone banks outside a game, and restoring the music's
    interrupted note rather than handing the channel back silent (doc 18
    §Stage 4).
  - **A4 — audio input**: the transcription front end (beat, percussion, bass,
    lead, harmony) with confidences, plus the decoders. *Done means*: an MP3
    becomes a playable cartridge, and the parts it found are reported honestly
    enough that a wrong one can be corrected in one flag.
  - **A5 — breadth** *(`nes`, `sms` and `gg` done, inside a game)*: the 2A03 and
    the SN76489 each have a chip model, a binding and a generated driver — 6502
    and Z80 — and `demake build -c nes`/`-c sms`/`-c gg` puts music and effects in
    the cartridge with doc 16's Level A proof over all of them. What none of them
    has yet is a *standalone* audio cartridge — `demake gen … --format rom` is
    still the Game Boy's alone — because a cartridge whose only job is one track is
    what the next caller needs and not what a game needed. The SN76489 is also the
    one that stretched the shared packing layer: its channel is in the data byte
    and latched, so `channelOf` became a factory over a per-schedule latch and a
    schedule that opens a tick with a bare data byte is refused rather than
    guessed at. Remaining: `md` (FM patch fitting), `snes` (BRR,
    the SPC700 driver, sample budgeting), `gba`, `nds` — each is a chip model, a
    driver backend and a Level A/B harness, on the per-console definition of done
    Phase 2 used for images. Each faces the choice doc 16 §The driver contract
    records: own the CPU's encoder (as the Game Boy does, which buys the browser
    and a toolchain-free proof) or pair generated data with a checked-in driver
    source for a stock assembler (as the image harnesses do). Level A also needs
    a core we own or one that exposes scripted register access.
  - **A6 — the surfaces** *(Demotic done)*: the Demotic integration is settled
    and built — `music` and `sound` are in the language, every example game has
    a theme and effects, and the cartridge the page hands you is byte-identical
    to the CLI's with the audio demade into it (doc 17 §Demotic integration).
    The page also *plays* a cartridge now: the ROM pane pipes `@demake/dmg`'s
    APU — which is `@demake/chip`'s — through a bare `AudioBufferSourceNode`,
    with the audio device clocking the emulator (doc 07 §Sound in the cartridge
    pane). **The two web sections are built too**: a music demaker and a sound
    demaker with the whole `arrange`/`sfx`/`render` flag surface, the channel
    plan as a piano roll, the tournament as a strategy picker, and downloads —
    `.vgm`, sidecar, WAV and cartridge — that the determinism suite pins as
    byte-identical to the CLI's. Still to come: the desktop wiring.
- **3D asset demake (new domain, exploratory)**: apply the same treatment to the
  32/64-bit 3D era — take a common modern 3D asset and emit PS1/N64/Saturn-
  compatible ones: polygon budgets and retopology, texture quantization through
  the existing image pipeline (palettes/CLUTs, N64's 4 KB TMEM tiling), and
  per-platform geometry quirks (PS1 fixed-point vertices and affine texturing,
  Saturn quads). Doc 03's generation cutoff stands for 2D image conversion;
  these platforms enter scope only for this separate 3D domain.

## Standing decision log

Decisions this plan defers, each becoming an ADR when made:
~~DS emulator choice (melonDS vs DeSmuME automation)~~ — **decided in Phase 2:
DeSmuME via the libretro harness.** It direct-boots a `.nds` with no BIOS or
firmware images, so the DS loop builds from source on a bare machine like every
other console; melonDS's BIOS/firmware requirement would have made the E2E
unrunnable in CI without shipping copyrighted files. · Node SEA vs
Bun compile (Phase 1 spike) · final name confirmation (Phase 0) · MD 32X/Sega CD
"extended spec" inclusion (post-1.0) · Oklab L-weight and judge metric-weight
calibration values (Phase 2, frozen thereafter) · initial candidate-portfolio
composition per console class (Phase 2, revisited per tier rollout) · the four
audio decisions in doc 16 §Open decisions (verb names, expansion sound chips and
the `.dmm` fallback format; ~~the Demotic audio surface~~ — **decided: `music`
scoped to a scene and `sound` on a rule's trigger**, doc 17 §Demotic
integration).
