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

- Image layer: PNG codec (ours), JPEG/GIF/BMP decode (also ours — doc 02
  §Image codecs; WebP is still outstanding), RGBA pipeline,
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

**Status: started.** Two Tier 2 verticals ride the whole loop — art, a display
ROM and a pixel-perfect emulator E2E — and a third, the **Neo Geo**, compiles
games without a display ROM of its own (§The order, item 8: it has a self-hosted
core and the full trace battery, but no `gen --format rom` harness). The two that
ride the loop each reused an existing edge rather than adding one, and both now
compile games as well as pictures:

- **PC Engine** — a `pce` codegen backend (word-planar HuC6270 characters, BAT
  words, 9-bit VCE palettes), a 64 KiB HuCard harness assembled by
  `wla-huc6280` (a fourth CPU target on the WLA-DX build the SMS/SG-1000/SNES
  families already provision), and a pixel-perfect E2E against beetle-pce-fast
  through the generic libretro runner. It is also the first Tier 2 console with a
  **Demotic backend**: `demake build -c pce` produces a real HuCard and the whole
  example library traces identically on it in `@demake/pce` (§Console rollout,
  item 2) — **with its music and effects**, since `Huc6280Psg` and a generated
  HuC6280 driver closed the one gap it had left.
- **WonderSwan Color** — a `wsc` backend (packed 4bpp tiles, screen-map words
  with palette/bank/flip, 16 RGB444 palettes), a 4 Mbit cartridge assembled by
  **NASM** (the V30MZ is an 8086-compatible core, so a stock x86 assembler is
  the native tool, not an approximation) with the cartridge footer and its
  checksum packed by demake itself, and a pixel-perfect E2E against
  beetle-wswan. It is the second Tier 2 console with a **Demotic backend**:
  `demake build -c wsc` produces a real cartridge and the whole example library
  traces identically on it in `@demake/wsc` (§Console rollout, item 4). Sound is
  the one gap it has left.

A third Tier 3 vertical rides the *whole* loop: the **Virtual Boy** has art, data,
a display ROM, a pixel-perfect E2E against beetle-vb and a Demotic backend — and
with it the first *depth axis* in the project, since its video processor draws
every scene once an eye. What it does not have is an in-game audio driver, which
§Console rollout item 9 costs.

All three march the shared image battery. The Game Gear shipped with the SMS family
in Phase 2 and SG-1000 with the TMS9918 path.

What remains of Tier 2, and of every other console in scope, is costed in
[§Console rollout](#console-rollout) below rather than listed here — the blockers
turned out to group by *what kind* of work they are, not by tier, and that
grouping is what decides the order.

## Console rollout

The support state at any moment is [`console-support.md`](console-support.md),
which is generated. This section is the other half: what each remaining console
*costs*, and therefore what order they are worth doing in.

The useful thing learned from shipping the NES beside the Game Boy is that **the
CPU is the cheap part**. Three axes decide the cost, and only the second is
usually the hard one.

### Axis 1 — the instruction set, which amortises

A backend owns its instruction set and nothing else (doc 14 §2,
`codegen/backend.ts`). demake writes its own encoders in TypeScript — that is
what lets the browser produce byte-identical cartridges with no toolchain (§D5)
— so "no distro ships an assembler for this CPU" is a blocker for `gen --format
rom` and *not* for `demake build`. Encoders pay for more than one console:

| Encoder | State | Consoles it buys |
|---|---|---|
| SM83 | built (`core/src/asm/sm83.ts`) | Game Boy, Game Boy Color, **Mega Duck** |
| 6502 | built (`core/src/asm/mos6502.ts`) | NES, **Atari 7800**; the CMOS additions extend it to Lynx and Supervision |
| HuC6280 | built (`core/src/asm/huc6280.ts`) — a 65C02 superset, and the first encoder here that *extends* another | **PC Engine**, TurboExpress |
| Z80 | built (`core/src/asm/z80.ts`) | Master System, Game Gear. It would cover the SG-1000 too — same CPU, no further encoder work — but that console is out of scope for games ([§below](#the-sg-1000-is-out-of-scope-for-games)) |
| 68000 | built (`core/src/asm/m68k.ts`) | Mega Drive, Neo Geo |
| 65816 | built (`core/src/asm/wdc65816.ts`) | SNES |
| ARM | built (`core/src/asm/arm.ts`) | **GBA, NDS** — one encoder for three processors, since a DS has two |
| V30MZ (8086) | built (`core/src/asm/v30mz.ts`) — 16-bit x86, and the second encoder here with two oracles | **WonderSwan, WonderSwan Color** |
| TLCS-900/H | built (`core/src/asm/tlcs900.ts`), and the largest of them | Neo Geo Pocket, NGP Color |
| V810 | built (`core/src/asm/v810.ts`) — the first *RISC* here, and the cheapest to write | **Virtual Boy** |
| SPC700 | built (`core/src/asm/spc700.ts`) | SNES audio only |

Four consoles therefore need no new encoder at all: the Mega Duck, the Atari
7800, the Lynx and the Supervision. The Mega Duck needs nothing new anywhere,
which is why it went first.

### Axis 2 — the renderer shape, which does not amortise

Both existing backends are *tilemap + hardware scroll + hardware sprites*
machines, and everything in `codegen/shape.ts` quietly assumes it: five paths
write a background cell, the camera is a scroll register, an object is an OAM
entry. Consoles that do not work that way need new shapes, and this is where the
real work is.

| Shape | Consoles | What it costs |
|---|---|---|
| Tilemap + scroll + sprites | GB, GBC, Mega Duck, NES, SMS, GG, MD, SNES, PCE, TurboExpress, WS, WSC, NGP, NGPC, GBA, NDS | Nothing new — this is what the backend interface is |
| Tilemap, **no scroll**, 1 KB RAM | SG-1000 | **Out of scope for games** ([§below](#the-sg-1000-is-out-of-scope-for-games)). The hardware has no scroll register, so a backend would have to reject any game that declares a camera; scrolling would mean rewriting the pattern table every frame |
| ~~**Sprite-only**, no tilemap~~ **done** | Neo Geo | *This row was wrong.* A sprite here is a vertical strip whose column of tile numbers is a 64-word table, and the **sticky bit** chains each strip to the one before it — so twenty-one strips side by side are a plane of 16×16 cells carrying **one position between them**. The background-cell writers needed a different address calculation, not counterparts, and scrolling turned out to be *two writes* rather than a scroll register. See [§the order, item 8](#the-order) |
| **Display list of tilemap rectangles, with a depth** | Virtual Boy | The renderer is a 32-entry list rather than a stack of layers: a *world* names a rectangle of a BGMap, where on the screen it goes, and **how far apart its two eyes' copies are**. Three mechanisms fall away — a world carries its own source origin, so scrolling is not a scroll register; the HUD takes a world of its own, so the sprite HUD is absent; and the map is 64×64 against a 48×28 window, so there is no leading-edge painter. What is genuinely new is the depth field, which nothing in `codegen/shape.ts` has a vocabulary for |
| **Display list** | Atari 7800 | MARIA draws from per-zone header lists and steals cycles from the 6502; no tilemap, no ordinary sprites |
| **Framebuffer + blitter** | Atari Lynx | Suzy blits scaled RLE sprite packets into RAM; background, scroll and tile rendering all become software |
| **Framebuffer, software everything** | Watara Supervision | 65C02, no tiles, no sprites, no scroll, and the visible bitmap lives *inside* the 8 KB of system RAM |

### Axis 3 — the proof, which gates "supported"

`rom.test.ts` is toolchain-free because the cores are ours (`@demake/dmg`,
`@demake/nes`). Every new console needs either a self-hosted core or a BIOS-free
libretro core plus doc 10's scripted input tape. **Lynx and ColecoVision are
gated on emulators that require copyrighted BIOS images**, which this loop will
not ship — so for those two the proof is likely to cost more than the backend
does, and that fact should drive the schedule rather than be discovered in it.

**The Neo Geo was on that list and should not have been**, which is worth
recording because the same reasoning frees the other two if anyone acts on it.
Owning the core changes the question from "can we run somebody else's emulator"
to "what does the hardware do before it hands control over" — and here that is
three lines: take the stack pointer from the cartridge's first longword and enter
at the header's `USER` vector. Commercial cartridges lean on the system ROM
constantly (its font, its soft dips, its coin handling); one this project *writes*
calls none of it, because we author both sides. Nothing copyrighted is shipped,
reimplemented or needed — the position `@demake/snes` already takes about the
S-SMP's boot ROM and `@demake/ngp` about SNK's other console. The Lynx's boot ROM
exists to decrypt a cartridge's first block and the `.lnx` header is the
direct-boot path around it; a ColecoVision cartridge's header magic tells the BIOS
to skip its own title screen. Neither is a reason to need somebody's dump.

### RAM and cartridge, measured

A fixture game needs **≈700–950 bytes of work RAM** and **10–30 KB of ROM**
before its art and audio (measured on the NES, the tightest machine with a
backend). That is the yardstick two consoles fail or nearly fail:

- **SG-1000** has 1 KB of work RAM, against the 700–950 bytes a fixture game needs
  before its level tables, its sprite shadow and its audio state. That is the
  second of the two reasons it is out of scope for games ([§below](#the-sg-1000-is-out-of-scope-for-games)).
- **Supervision** has 8 KB, of which 160×160 at 2bpp is 6,400 bytes of visible
  bitmap.

It also explains why the shooter's NES cartridge is a couple of hundred bytes
over with its music in it (§D4). The obvious win is the backdrop nametable,
which is stored raw and would pack to roughly a third — worth about six hundred
bytes a game, and worth more than it looks, because several consoles below are
tighter than the NES.

### The SG-1000 is out of scope for games

**Decided 2026-08. `demake build -c sg1000` is not planned, and the SG-1000 is
not in the rollout order below.** This excludes step 4 of §How to add a console
(a Demotic game backend) and nothing else — the console keeps everything it has
today, which is art (`prep`/`inspect` through the TMS9918 row-pair fitter), data
(`bin`/`asm`/`c`), a display ROM through WLA-DX with a pixel-perfect emulator
E2E behind it, and music and effects through `arrange`, `sfx` and `render`.
[`console-support.md`](console-support.md) is generated and already says exactly
this; it needs no edit.

Doc 14 §Scope had already excluded this console from the language, on the grounds
that four sprites per scanline and one colour per sprite distort the sprite model
every other target shares. This section is the roadmap half of the same decision:
two further hardware facts, both about what a game *is* rather than about how much
work a backend would be, which together make the exclusion permanent rather than
an ordering.

- **There is no scroll register.** A Demotic scene can declare a camera that
  follows an object, and on every console with a backend that camera compiles to
  a hardware scroll register. The TMS9918 has none, so the only way to scroll is
  to rewrite the pattern table every frame on a machine with 1 KB of work RAM. A
  backend would therefore have to reject any game that declares a camera, by
  name, at build time — the rule in AGENTS.md §Iron rules that a backend gap is a
  build error and never a silent difference.
- **1 KB of work RAM.** A fixture game needs 700–950 bytes before its level
  tables, its sprite shadow and its audio state (§RAM and cartridge, measured).
  What fits is a game with no camera, no level and few objects.

Between them, what the console could build is a strict subset of what the example
library already is — so the honest description is that this hardware does not run
the games this language describes, and shipping a backend that refused most of
them would say otherwise. The `unsupported()` hook exists for a feature a backend
has not implemented yet, not for a console that cannot implement it.

**What would reopen it**: a demand for the subset that does fit — single-screen,
cameraless games — or the ColecoVision, which is the same TMS9918 with 8× the
work RAM and would make the RAM half of this moot. Neither is a reason to build
the backend today, and either is a reason to revisit rather than to work around.

### The order

1. **Mega Duck** — *done*. Same SM83, same tile and map formats, same joypad,
   same interrupt vectors; a permuted LCD register map, a permuted LCDC, a
   permuted APU register map, no cartridge header and no boot ROM. A whole
   console for a machine-description change.
2. **PC Engine** — *done, sound included*, and **TurboExpress** free behind it. It was the highest capability per unit of effort on this list
   and it came out that way: `Asm6280` *extends* `Asm6502` rather than restating
   it, which is what let the whole 16.16 value layer, the rule bodies, the tile
   walk and tile collision move to `codegen/mos/` and be shared verbatim between
   the two consoles. What the backend owns is a renderer, and the hardware is
   generous with it — 8 KB of work RAM against an NROM's 2, a 64×32 map against a
   32×28 window so neither axis has a seam, a sub-palette per *cell* so there is
   no attribute table at all, and sixteen sprites a line rather than eight.

   Three things cost more here than the numbers suggest and are worth knowing
   before the next console on a mapper. **A program lives in a 48 KiB window**,
   not in its cartridge: the mapper's eight pages have to hold the hardware, work
   RAM, the code and the data, and `$4000`–`$FFFF` is what is left. **Characters
   are program bytes**, uploaded at boot, where an NES's are a separate ROM that
   costs the program nothing — so art is a real budget here. And **there is no
   8×8 sprite**, so a one-cell object is a 16×16 pattern with three quarters of it
   transparent and a HUD glyph costs 128 bytes; the glyph patterns are therefore
   *pulled* like a helper, and a game whose HUD is all on the background layer
   ships none.

   The **sound** closed the same way: `Huc6280Psg` in `@demake/chip`, a binding,
   and a generated driver whose stream player is the NES's — `rom/mos-player.ts`
   belongs to the *processor* rather than to either machine, on
   `arm-player.ts`'s precedent, so all this console's own driver file adds is a
   clock, a register base and a routine that gives a borrowed channel back.
   Three things about that driver are this machine's. The clock is the **CPU's
   own timer**, so a game's audio runs at 120 Hz where a NES game's runs at its
   frame rate; **nothing on the chip is shared**, so the build emits no merge
   routine at all; and the **channel is a register and it is latched**, so the
   driver skips a preempted run whole, the way an SN76489 driver does.
   `packages/demotic/test/audio-pce.test.ts` runs the whole battery on it.
3. **Z80** — *done*, for the Master System and the Game Gear, from one encoder
   with an SN76489 driver behind them. The encoder has no console left to buy:
   the only other Z80 machine in the matrix is the SG-1000, which is out of scope
   for games ([§above](#the-sg-1000-is-out-of-scope-for-games)).
4. **WonderSwan Color** — *done* — and the **tiled-mono fitter** with it, so
   the mono **WonderSwan** now demakes art (`pipeline/fit-mono-tiled.ts`, doc 04
   §Special cases). That machine's blocker was the art path rather than the CPU,
   and the fitter was an engine increment that stood on its own: a pool of eight
   shades chosen from sixteen LCD levels, a shared backdrop, sixteen four-entry
   palettes indexing the pool, and a per-cell choice among them — the first fit
   in the project whose search space is small enough to enumerate rather than
   cluster. And `demake build -c ws` then followed for the price of a
   *description*: these two consoles are one processor and one display
   controller, so the mono machine is a variant (`codegen/wsc/machine.ts` — four
   entries and not one instruction) rather than a ninth backend.

   `demake build -c wsc` produces a playable 512 KiB cartridge and the whole
   example library traces identically on it, in the same battery every other
   console runs. **The encoder**
   (`core/src/asm/v30mz.ts`) is 16-bit x86 and the second one here with two
   oracles: hand-read encodings, as every encoder gets, *and* a differential
   battery against NASM, which the display-ROM harness already provisions. It
   earns that here for the ARM encoder's reason turned inside out — this
   architecture packs three fields into a mod/reg/rm byte and gives a
   displacement a length that depends on its *value*, so a register written into
   the wrong field still decodes as an instruction. **The cartridge wrapper**
   (`core/src/asm/ws-cart.ts`) is the other half: the program is in the last
   64 KiB bank because that is what the processor answers segment `$F000` with
   from reset, the entry point is a far jump at that bank's `$FFF0` because that
   is physically where reset starts fetching, and the checksum covers every byte
   but its own two. There is **one board**, unlike the NES's or the Mega Drive's
   — the size byte's vocabulary starts at 4 Mbit, so this console has nothing
   smaller to choose, the way a Game Boy ROM-only cartridge cannot move either.
   And **`@demake/wsc`** is the ninth owned core.

   The **value and expression layers** are built and proven (`codegen/wsc/val.ts`,
   `expr.ts`, `wsc-arith.test.ts`), and the value layer is small for a reason neither 16-bit console
   before it has. A V30MZ is sixteen bits wide, so an add is still two
   instructions — but its ALU reaches memory on *both* sides, so a 32-bit add is
   four instructions with no pointer and no scratch, and it has a real multiplier
   and divider. A 16.16 multiply is **four multiplies and no loop at all**, which
   no other backend here can say, and the two divisor shapes a game actually uses
   are three chained divides each. The bit loop is left for a fractional divisor
   of a cell or more, which nothing in the example library reaches, and it is
   thirty-two iterations rather than forty-eight because such a divisor is at
   least `1.0` and the dividend's top sixteen bits cannot produce a quotient bit.

   The multiplier reaches the expression layer too, and in two places no other
   backend has. The **generator advances with no loop**: `rng * 1664525 +
   1013904223` is three `mul` instructions and two adds, where every other
   backend here shifts and adds over thirty-two bits — bit-for-bit `rng.ts`
   either way, which is what `wsc-arith.test.ts` checks against the definition
   and against the rule that a draw advances the state even when the bounds leave
   nothing to draw. And the **modulo a draw needs is one instruction**, so
   `Mod16` is not a routine on this console at all.

   The renderer, the rules and the emitter are built (`codegen/wsc/emit.ts`,
   `rules.ts`, `tiles.ts`, `wsc-art.ts`), and five things about them are this
   hardware's:

   - **The HUD gets a plane of its own**, which only the Game Boy Advance has so
     far. `SCR2` scrolls independently of `SCR1` and draws in front of it, and
     colour zero is transparent on both, so a caption's cell can be held still
     while the picture slides under it. The sprite HUD, the second decimal
     renderer and the pixel-pinning argument every 8-bit console needs are absent
     rather than reimplemented.
   - **A cell carries its own palette** — four bits in the map word — so there is
     no attribute table and no 16×16 block, which is the PC Engine's arrangement.
     The split is the Game Boy Color's: seven palettes for background art and one
     for the font, seven for objects and one for theirs, because a sprite's
     palette field is three bits and selects among the upper eight.
   - **The map is 32×32 against a 28×18 window**, so a scrolling scene paints its
     leading edge where nobody is looking and both wraps are powers of two — no
     seam to mask on either axis.
   - **There is no video memory at all.** The screen maps, the tile bank, the
     object table and palette RAM are addresses in the same 64 KiB the game's
     variables are in, so nothing is ever uploaded and the object table is not a
     shadow — the display reads it where the runtime wrote it.
   - **The loop watches the beam**, as the Nintendo DS's does: this console's
     interrupt controller vectors through the processor's own table, and a game
     whose main loop waits either way gains nothing by it. That changes the day
     this console gets an audio driver, which it has not.

   What the backend cost that no predecessor did was **saying which segment a
   read means**. `DS` is the console's RAM and `CS` is its cartridge, so a level's
   grid, a packed picture and a pooled 16.16 constant all need a one-byte
   override and a game's own property does not — and `val.ts` decides it from the
   reference's own type rather than leaving each emitter to remember, because the
   version that did not froze every game on its second tick with nothing about
   the arithmetic wrong.

   **And it has sound.** `@demake/chip`'s `WsSound` models the four wavetable
   channels, `binding/wsc.ts` drives them, and the cartridge carries a generated
   V30MZ driver (`rom/wsc-driver.ts`, `wsc-game.ts`) whose every register write
   is diffed against the demakers' schedules tick for tick by the shared battery.
   Both WonderSwans demake music and effects, because the mono machine has the
   same sound hardware; only the *game* backend is the colour machine's.

   Three things about it are this console's. The waveforms are in its **own RAM**
   — port `$8F` names a sixty-four-byte page — so the bank is bytes the driver
   copies rather than register writes it performs, and the address is one
   constant the binding, the renderer and the memory plan all read. The **clock
   is a tally**: this cartridge takes no interrupts anywhere, so the driver reads
   the vertical-blank timer's counter and pays whatever frames it finds owed,
   which is the frame-counting discipline every other frame-clocked console needs
   a handler for. And the **pitch register counts up** — it is subtracted from
   2048 — so the spec declares the lattice and the binding does the subtraction.

   **Channel two's PCM voice is modelled** — `$90` bit 5 turns that channel into
   a direct D/A whose sample is the whole of `$89` and whose only level is the
   full-or-half pair in `$94`, so the hardware can play a recording on one of
   its four voices. What is left is a *demaker* that would: nothing above the
   chip layer streams samples into it, which is doc 18's work rather than this
   model's.

   **And one thing it found was not this console's** — *closed*. The display runs
   at **75.47 Hz**, so a tick that is a frame happens seventy-five times a second,
   which makes this the first console in the set that does not run at sixty. The
   language was built for exactly that (doc 14 §3) and the **`.test.dmt` suites
   were not: every script in the example library measured with `play 240 ticks`
   and `hold right for 42 ticks`**, and `caves`' own comment stated the assumption
   out loud — "an eleven-cell-a-second hero … takes the same ticks to reach the
   same ledge on every console". A tick count was an absolute duration dressed as
   a portable one, and it had been portable only because every console so far
   shared a rate.

   The test-script grammar now takes a duration in **seconds**, resolved against
   the profile's `fps` by the runner — the same rule `speed` already runs under
   one layer down. `ticks` stays a unit, because a step that means "one more tick"
   should say so, and the suites keep it for the two- and eight-tick waits that
   give a rule an edge to fire on. The conversion changed no console's behaviour:
   two decimal places of seconds round-trips to the same tick count at sixty, and
   every count in the library does.

   It also found one assertion that was never portable and was not about the
   rate. `quest`'s pit test asserted a power-up's value after a death *and a level
   restart* — a second run at the same level, whose progress when the script stops
   depends on where the first one ended. It asserts the scene now, which is what
   its own name claims and what the restart actually is.
5. **Atari 7800** — the encoder is free, and it buys the display-list layout path
   the image side wants anyway.
6. **Neo Geo Pocket / Color** — **done.** `demake build -c ngpc` produces a
   playable cartridge that plays its own music and effects, and the whole example
   library traces identically on it and is diffed tick for tick by the shared
   audio battery; `demake arrange -c ngpc`, `sfx` and `render` demake its music
   and effects, on the mono machine too.

   The audio turned out not to be free after all, and it is worth saying why,
   because the estimate above was written from the chip's family name. The T6W28
   is an SN76489 derivative in its *register format* and in nothing else that
   matters to a driver: it has **two write ports carrying different registers**
   (each side's four attenuators, the tone periods on the left port and the
   noise's on the right), so it is a second chip model rather than a flag on
   `Sn76489` — and its stereo is a *level* per channel where a Game Gear's is a
   switch, which is why this is the fourth console in the set with no shared
   register and the first to have none because its hardware pans *more*.

   The driver is the seventh CPU's, on the frame rather than a timer for the
   Sega parts' reason (a game's two streams share one interrupt with the picture,
   and this cartridge already takes the vertical blank). What is unlike every
   other driver in the set is that it has to **ask for its chip**: the T6W28's own
   bus belongs to a Z80 sound processor, so `AudioInit` writes `$55` and `$AA` to
   two bytes of the main CPU's I/O page and then reaches the chip through two
   more. `@demake/ngp` models the same gate, so a cartridge that skipped them is
   perfect and silent rather than quietly working.

   Building it found a timing description that was wrong and invisible. This
   CPU's instruction timings are in *states* — the crystal halved — and the
   display controller counts the crystal, so the core had been drawing frames at
   half the hardware's rate. Nothing could see it: a trace is per tick and a tick
   is per frame either way. The audio is what made it visible, because a chip
   handed the wrong number of clocks renders at the wrong speed.

   One thing the binding cannot yet spend: `ChannelFrame.pan` is a pair of
   booleans, so a part reaches the chip hard left, hard right or both. The spec
   says `lr-level` because that is what the hardware does (AGENTS.md §Iron
   rules), and closing it is a continuous pan in the arranger — which would also
   be the first thing in this project to make a *stereo image* an arranging
   decision rather than a channel property.
7. **Supervision** and **Lynx** — each gated on something structural (RAM, a
   framebuffer renderer). Worth doing once a framebuffer renderer exists for one
   of them.
8. **Neo Geo** — **done**, and it was the cheapest console on this list rather
   than the dearest. `demake build -c neogeo` produces a playable `.neo` and the
   whole example library traces identically on it, in the same battery every
   other console runs.

   Three things made it cheap and none of them was foreseen here. The **68000 was
   already built and so was a core for it**, so `@demake/neogeo` imports
   `@demake/md`'s processor the way `@demake/nds` imports `@demake/gba`'s ARM —
   and the arrival of a second 68000 console is what moved the value layer, the
   expression compiler, the rule bodies, the tile walk *and* the tile rules into
   `codegen/m68k/`, on `codegen/mos/`'s precedent. The backend that is left owns
   only a renderer. **The playfield is a tilemap in everything but the name**
   (§Axis 2 above). And **the BIOS was never a gate** (§Axis 3 above).

   What it cost instead is a fact no other console in the set has: **a hardware
   cell is 16×16 and a language cell is 8×8**, so one plane cell covers a 2×2
   block of language cells. The art path composes level grids, backdrops and
   objects into 16×16 tiles at build time and dedups those — legal only because a
   Demotic tile layer cannot change, which is §D6's still-to-come work and the one
   thing that will need a different answer here rather than a bigger one. The PC
   Engine hit the first half of this for objects; what is new is that the
   *background* has it too.

   Two dividends fell out of the geometry. **There is no edge painter**: the plane
   is 21×15 cells where a Mega Drive's map is 64×32, so a full repaint is 630
   words and a few thousand cycles — the leading-edge mechanism every other
   backend needs is *absent* rather than reimplemented. And **the HUD is the fix
   layer**, 8×8 and always in front, on a grid that *is* the language's own — so
   the write queue, the erase list and `PlotCell` are absent too. Three
   mechanisms deleted by one piece of hardware.

   Still missing: **sound**. The chip answers a Z80 that `demake build` emits no
   program for, so a cartridge is silent and says so — the request bytes a rule
   writes are still there, so its trace is identical to a sounding console's. A
   Z80 encoder already exists (the Sega 8-bits'), so this is a driver and a
   second program in the container rather than anything new.

9. **Virtual Boy** — **art, data, a display ROM, a pixel-perfect E2E and a game
   backend are done; the in-game audio driver is what remains.**
   `demake gen -c vb --format rom` builds a bootable cartridge and the whole
   shared image battery matches the DAC reference in beetle-vb, *in both eyes*;
   `demake build -c vb` builds a playable one.

   Three things about it were cheaper than this list would have guessed. The
   **encoder is the smallest in the set** — a V810 is a RISC with thirty-two
   32-bit registers, a hardware multiply and a hardware divide, so the value
   layer pulls in **no arithmetic helper at all** for a multiply, which nothing
   else in the project can say. The **boot is three lines**, because a
   27-bit address bus puts the reset fetch inside the cartridge's own last
   sixteen bytes and there is no header to read on the way. And the **display ROM
   needed no toolchain**: no distribution ships a V810 assembler, so this is the
   one family whose display program demake emits with its own encoder — which
   costs a second opinion on the assembly and keeps the one that matters, since a
   third-party emulator still decodes every instruction.

   What it costs that no predecessor did is a **depth axis**. The video processor
   draws every scene twice, once an eye, offset by a parallax the scene itself
   declares — so this console can put a sprite *in front of* the scenery it is
   drawn over without moving the scenery, and a backend that ignored that would
   be spending the machine downwards in a way no other console here allows
   (AGENTS.md §Iron rules — a demaker spends the whole machine). The intended
   arrangement is stated once and proved against hardware today: scenery at the
   display plane, objects and the HUD in front of it, `VB_NEARER` the sign that
   means nearer, and `packages/cli/test/vb.e2e.test.ts`'s depth case the place
   where our model and beetle-vb are compared pixel for pixel on a scene with two
   depths in it.

   The **value layer** is proven on the hardware in its own file, as every
   backend's is: `packages/demotic/test/vb-arith.test.ts` runs every 16.16
   operation against `fixed.ts` and four generator draws in a row against
   `rng.ts`. Three findings from writing it are worth carrying forward.

   - **The multiply pulls in nothing.** `mul` leaves the whole 64-bit product
     across two registers and a 16.16 product is its middle thirty-two bits, so
     six instructions and no routine — and *no floor correction*, because an
     arithmetic shift of a two's-complement product already is one. This is the
     only console in the set with no multiply helper.
   - **The divide is the one place this machine is worse than its neighbours.**
     `div` is 32-by-32 and a 16.16 numerator is 48 bits, so there is a
     shift-and-subtract loop — with the Mega Drive's escape, since a divisor
     that is a whole number of cells is a single `divu`. Every `n / fps`
     constant folds onto that path.
   - **A `jal` returns through a register**, so a helper that calls a helper
     destroys its own return address — and that reads as a *hang* rather than as
     a wrong number. `ctx.enter`/`leave` are the answer and no other backend
     needs a counterpart, because every other console in the set pushes.

   **The backend is finished.** `demake build -c vb` produces a real cartridge
   and the whole example library traces identically on it in `@demake/vb`, in
   the same battery, at the same one frame per tick — the sixteenth console to
   do so. `packages/demotic/test/vb-rom.test.ts` is the rendering oracle beside
   it, and every case in it is one that produces a cartridge which ticks
   perfectly and shows nothing.

   Four things about the renderer are this console's rather than a predecessor's
   restated.

   - **A scene is a display list, and this runtime's is seven entries written
     once.** Scenery, four object worlds, the caption plane and the terminator.
     The four object worlds are four rather than one because the drawing
     processor counts them — the group a world draws is decided by how many
     object worlds came before it, from three downward — and none of them is
     wasted: the other three groups are left empty by the `SPT` registers, which
     name a *last entry* rather than a count.
   - **Scrolling is two halfword stores.** The map is 64×64 against a 48×28
     window and the scenery world carries its own source origin, so the leading
     edge is painted sixteen columns off the right-hand side, both wraps are
     powers of two, and neither the NES's row pinning nor the Master System's
     seam mask exists.
   - **The HUD gets a plane of its own**, at the caption depth, whose origin is
     written at boot and never again — the WonderSwan's arrangement and the Game
     Boy Advance's, with a depth on top. The sprite HUD, the second decimal
     renderer and the whole pixel-pinning argument are absent rather than
     reimplemented.
   - **A caption is chosen against the picture, not against the backdrop.** On
     the NES and the PC Engine a caption's paper *is* the shared backdrop, so the
     ink is picked against that; here the caption is on a plane in *front* of
     the picture, so what shows through its paper is the picture itself. Picking
     against the backdrop register gave the caves title screen dark ink over a
     three-quarters-dark picture whose lightest colour was rare — a caption that
     is perfectly placed, perfectly demade and invisible, and one no register
     comparison can see. `vb-art.ts` counts the shades the demade picture
     actually places and rams the font the other way.

   And one about the emitter that the other fifteen backends are simply spared:
   **an unaligned access is masked rather than faulted**. A V810 clears the low
   bits of an address instead of raising, so an `ld.h` at an odd address reads
   the halfword below it and reports nothing — which the three structures with a
   count byte among halfword entries hit by construction, and which the constant
   pool would hit whenever a byte table before it happened to be an odd length.
   `MemoryPlan.align` covers the allocator's share; the rest is split loads and
   an `align(4)` hook on the shared constant pool.

   One gap in it is worth naming because nothing will find it by accident:
   **a cartridge stages 128 objects where the chip holds 1024.** The object table
   is copied out of work RAM in the gap after the frame and `layout.oamCount` is
   one byte, so the Demotic profile quotes 128 rather than the hardware's number
   — a diagnostic that promised the chip's would pass a game whose sprites then
   went missing. Reaching the rest is a sixteen-bit object count in `layout.ts`
   and a wider shadow, and it is worth doing when a game wants it rather than
   before: the widest fixture in the library stages fifteen.

   Two things it still does not have. The **in-game audio driver** is one, and
   it is blocked on nothing but itself now: a V810 stream player would be the
   processor's first, and the cartridge it goes in exists. The other is the
   depth ladder itself — `VB_DEPTH`'s three numbers are still a *proposal*,
   because "how far in front" is a value no `.dmt` says and no Demakefile may
   (doc 14 §Scope), and the maintainer's call rather than an agent's.

   **The sound is half done, and it is the half that does not need the backend.**
   `@demake/chip` models the VSU, `binding/vb.ts` drives it and
   `binding/vb-bank.ts` supplies its five waveform tables, so
   `demake arrange -c vb`, `sfx` and `render` all work — this console demakes
   music on the Neo Geo Pocket's precedent, where a demaker is per-domain and
   does not wait for a cartridge. Three things about the chip are worth knowing:
   the waveform tables are a **shared pool of five** rather than one per channel,
   **every channel has a hardware envelope** (so a drum's decay is programmed
   rather than written every tick), and **nothing is shared between channels** —
   so this console emits no merge routine at all, the sixth in the matrix to do
   so.

   What remains is the **in-game driver**, and it is blocked on the backend rather
   than on anything of its own: a V810 stream player would be the *processor's*
   first, on `arm-player.ts`'s and `mos-player.ts`'s precedent, and it has nothing
   to be embedded in until `demake build -c vb` exists. `@demake/vb`'s VSU page
   accepts writes and generates nothing until then, which is why the in-game
   audio column reads `—` while the music/sfx one reads `yes`.

68000 (Mega Drive, then Neo Geo), 65816 (SNES, plus the SPC700 for its audio) and
ARM (GBA, NDS) slot in wherever Tier 1 breadth is wanted ahead of Tier 2 depth;
they are ordinary tilemap machines and carry no surprises beyond their encoders.
The ARM pair are, if anything, the *easiest* backends in the set — 16.16 fixed
point is a native 32-bit register there, so the shift-and-subtract arithmetic the
SM83 and 6502 pay for every tick collapses to single instructions.

### Handing a borrowed channel back

A game's music and its sound effects share one chip, and an effect *borrows* a
channel while it plays. The packed music is a **delta stream** — a register is
written when the music's own value for it changes and not otherwise — so once an
effect has borrowed a channel the chip is holding the effect's values for it, and
the music never states its own again. It comes back wrong, and not quietly: the
driver-shaped decay writes a channel's volume several times a note, and each of
those re-triggers the voice through a register whose neighbour still carries the
effect's pitch. On a Game Boy that is a pulse coming back a whole tone sharp and
ringing until the bar ends — heard in pong as a dissonant note on every bounce,
and originally mistaken for a glitch in the demade *music*.

The fix is a copy: the music records every register belonging to a channel an
effect can take, updated whether or not the write reached the chip, and the
release replays it (`audio/src/rom/shared.ts` §`shadowPlan`). It is per CPU,
because it lives inside each stream player's run walk, and the shared battery
asserts it on every console — not that *something* wrote the borrowed channel
afterwards, which is what it used to check, but that what the chip is left
holding is what the schedule says.

**Every driver in the set has it**: SM83, 6502 (the NES and the PC Engine share
the player), Z80 (the Sega 8-bits and the Neo Geo share theirs), 68000, SPC700,
ARM (the Game Boy Advance and the Nintendo DS share theirs), TLCS-900/H and
V30MZ. Four needed more than the generic plan, and each for a reason about its
chip rather than its processor.

The **SN76489** has no register numbers at all — one write port, and the channel
latched in the byte — so its three bytes are told apart by what each byte *is*
(`rom/psg.ts` §`PSG_SHADOW`). The **PC Engine** *selects* a voice rather than
addressing one, so every voice is written through the same ten register numbers
and each needs a window of its own rather than one window per register — which is
why a window is per channel on every console and not per register.

The **Mega Drive** is both of those on one board, and it added the one thing none
of the others needed. Its FM chip has four bus *ports* whose meaning is whatever
the address port last latched, so a copy is indexed by that address — and the
address write and its data write **can land in different runs**. `$28` is the
case that forces it: the key register belongs to no voice until its datum names
one, so its address write is tagged "no channel" and goes down the plain write
path while its data write goes down the recording one. A latch kept only by the
recorder is still holding the register before it, and the key byte is copied into
the frequency's slot — which is what it did, and what a borrowed voice then
replayed. So the latch is a byte of driver state that **every** FM write this
stream makes updates, and `checkMdPairDiscipline` refuses a schedule that would
need two of them.

The **Neo Geo** is the Mega Drive's problem with the latch kept honest by the
packer rather than by the recorder. A packed byte on that board is a *port*, so
an even one latched a register and *is* that register's number while an odd one
is the datum — which means the copy needs a fourth byte to hold the latch beside
the three a square is (`rom/neogeo-driver.ts` §`NEOGEO_SHADOW`), and the recorder
classifies on the port in `c` rather than on anything about the value. What it
does not need is the Mega Drive's rule that every write updates the latch,
because here an address byte is tagged with the channels of **the register it is
about to latch** — so an address and its datum carry the same tag, land in the
same run, and `checkAddressDiscipline` refuses a schedule where they would not.
The replay is three registers because an effect on this console only ever borrows
a square; an FM voice's state is a whole patch, and nothing ever hands one back.

## Phase 6 — 1.0

Freeze CLI/API surfaces; full-corpus nightly green two weeks running; docs complete
(man pages, site, README demo GIF); Homebrew/Scoop; `v1.0.0`.

**Done means**: every doc-01 success criterion checked off in the release PR.

## Phase 7+ — Post-1.0

- **Tier 3 long tail**: 2600 kernels, Atari 8-bit/5200, Intellivision, Virtual Boy,
  Pokémon Mini, and the remainder — each lands with its harness or ships prep-only
  with a documented "codegen pending toolchain validation" status.
  - **Mega Duck** *(games done; the display ROM is what remains)*. Its *data*
    formats are the DMG's exactly, so it always rode the `gb` codegen family for
    `bin`/`asm`/`c`. What it does not share is the display program, and the whole
    of that difference is now written down once in `core/src/asm/megaduck.ts`:
    the video registers at `$FF10`–`$FF1B` in an order of their own rather than
    at an offset, the sound registers at `$FF20`–`$FF46` with four pairs
    swapped, `LCDC`'s bits permuted in a five-bit cycle, and no cartridge header
    or boot ROM at all — so execution begins at `$0000`.

    That table is what `demake build -c megaduck` needed, and nothing else was:
    the backend is the Game Boy's, `@demake/dmg` gained a machine argument
    rather than a second core, and the audio driver applies the map where a
    register number becomes an address. The whole example library traces
    identically on it and its schedules diff exactly, in the same two batteries
    every other console runs. **This is the model for a console that is a
    variant rather than a machine** — see doc 03 §Support and AGENTS.md §How to
    add a console.

    Still withheld is `gen --format rom`: a picture-displaying cartridge needs a
    `gb`-family harness variant of its own, and proving it needs the **SameDuck**
    libretro core (a SameBoy fork, no BIOS files) wired into the doc-10 loop.
    The console spec declares no `rom` format until that exists, so `gen` refuses
    rather than quietly assembling a Game Boy cartridge that shows nothing here.
    SameDuck's `Core/gb.h` and `Core/display.c` are where the table above came
    from and are cited in the spec's `docs.sources`.
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
  - **D4 — breadth** *(`nes`, `sms`/`gg`, `snes` and `md` trace-green)*: `nes`,
    `sms`/`gg`, `md`, `snes` backends, each trace-green then framebuffer-green. A
    backend is per-family; the `Program` it compiles is not.

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
    one console over — `packages/demotic/test/_audio-battery.ts` now runs its whole
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

    **The cartridge budget ran out here too, and the way out was the NES's.**
    Three changes, in the order they were worth: the name tables are packed the
    way the NES's are — literals and runs, but of whole *cells*, because an entry
    is a tile byte and an attribute byte and a run of identical cells has no byte
    runs in it at all (about 1.5 KiB a game); the collision pairs are walked from
    a table rather than copied, with the other object's record in a memory pointer
    and the rule body emitted once (9 KiB on the shooter, which is twenty-seven
    pairs of a bullet against nine aliens); and the integrator groups objects by
    every compile-time question `emitAxis` asks, so nine aliens that move
    identically share one body. The shooter went from 34.6 KiB against a 32.7 KiB
    cartridge to 25.6, and every example game now builds on both machines with at
    least 3 KiB free. `Backend`'s claim is a little stronger for it: the second and
    third of those were ports of code the 6502 backend already had, and neither
    needed anything moved out of `backend.ts` or `shape.ts` — `EntityAddr`'s `ptr`
    case, written for the NES, is what a Z80 rule body compiles against unchanged.

    What is left on this console's budget is the tile bank, which is a quarter of
    the cartridge on its own — 254 tiles at thirty-two bytes, because characters
    here are ROM *and* video RAM. If a game ever needs past that, the way out is
    the one the hardware offers rather than another emitter: these machines take
    **bank-switched cartridges**, the slot at `$8000` is entirely unused today,
    and `@demake/sms` already implements the mapper's registers.

    **The Super Nintendo is the fourth console, and it is the first one that is
    bigger than the language needs.** `demake build -c snes` produces a real
    LoROM cartridge — 65816 machine code written for the game, a Mode 1
    background demade into 4bpp tiles across seven sixteen-colour sub-palettes,
    and art in a second cartridge bank that reaches video RAM by transfer — and
    the whole example library traces identically there, in the same battery, at
    the same one frame a tick. Nothing moved out of `backend.ts` or `shape.ts` for
    it either.

    What the 65816 changes is the *size* of the backend rather than its shape,
    and the reason is one bit of status: with `M` clear the accumulator is
    sixteen bits, so a 16.16 add is two `lda`/`adc`/`sta` triples where the 6502
    needs four, a copy is two loads and two stores, and a zero test is a single
    `ora`. The index registers are sixteen bits with it, which removes the other
    half of the 6502's cost: `$nnnn,x` reaches all of bank zero, so a shared
    helper is handed an address in `X` and there is no page-zero pointer to write
    first. The whole of `codegen/snes/` is about two thirds of `codegen/nes/`.

    The bill for that is a discipline the other three do not have. **The width
    flags are part of the machine state a label promises**: an immediate is one
    byte or two depending on `M`, so a `sep #$20` that is not matched by a
    `rep #$20` does not produce a wrong number, it desynchronises the instruction
    stream and executes an operand. The backend fixes an invariant — sixteen bits
    at every label, every call and every return — and `ctx.narrow()` is the only
    sanctioned way to leave it, for a stretch of straight-line code that cannot be
    branched out of. Byte fields are *read* as words with the neighbour masked
    away, which costs nothing, and *written* under that helper.

    Three of the hardware's own facts are load-bearing and each produces a
    cartridge that traces perfectly and looks wrong. The background is scrolled
    **one line late** — screen line `N` shows background line `VOFS + N + 1` — so
    the vertical register is the camera's minus one, which is the same `$3FF` the
    image E2E's harness has always written. A 64-wide tilemap is **two 32×32
    screens a kilobyte apart** rather than a rectangle, so column 32 is not one
    word past column 31. And an object's Y is **direct**, with none of the NES's
    minus-one convention, so `y 0` is the top of the screen and needs no
    exception — which is one of the two places this console is simply easier than
    its predecessors. The other is that the map is larger than the screen in both
    directions, so both axes scroll by painting a leading edge and neither needs
    the NES's row pinning or the Master System's seam mask.

    Framebuffer-green is what remains here too, behind the same scripted input
    tape. Until then `snes-rom.test.ts` is the rendering oracle — the tilemap
    against the level grid, cell by cell, before and after the camera has crossed
    into the second screen — and `snes-arith.test.ts` the arithmetic one, which
    matters more here than on either predecessor because every routine it covers
    is a *different program* from the eight-bit one those consoles proved.

    **Sound arrived as a whole second program**, which is what this console's
    hardware makes of the question. The S-SMP is an SPC700 with its own 64 KiB,
    its own timers and no access to the cartridge, so `demake build -c snes` emits
    two programs and the cartridge uploads one of them through four mailbox bytes
    at boot. `@demake/chip` gained the S-DSP, `@demake/core` gained an SPC700
    assembler, and `@demake/audio` gained the driver
    (`rom/spc-driver.ts`, `rom/spc-game.ts`). Three things about it are the
    hardware's rather than the pattern's: the clock is the sound processor's own
    timer, so 125 Hz is exact and a frame the game overruns costs no tempo; the
    one shared register is a *pulse*, so preemption is a mask rather than two
    shadows folded; and the chip plays samples, so the waveform bank is part of
    the artifact and the standalone file is an `.spc` rather than a `.vgm`. What
    is still absent in the chip model is the echo unit and pitch modulation —
    accepted and ignored rather than half-implemented — and Gaussian
    interpolation, which is linear here; none of the three touches doc 16's
    Level A, which compares register writes.

    The budget is not the constraint it was on the two 8-bit machines. Bank zero
    is 32 KiB of program and bank one is 32 KiB of tile art the program never
    addresses, so a game with two demade backdrops uses about 12 KiB of the first
    and 11 of the second. What *is* expensive is the demake itself: a 256×224
    picture fitted into seven sixteen-colour sub-palettes is around thirty seconds
    of tournament, three times any other console's screen, which is why the
    conversion memo matters more here and why the parallel suite runs one fixture
    on this console rather than three.

    Sound is no longer the gap: there is a generated Z80 driver (§A5), and both
    machines carry their music and effects. The design question that was blocking
    it was in the packer, and it resolved the way it was expected to — the
    SN76489 puts the channel in the *data* byte and latches it across writes, so
    `channelOf(reg)` became a *factory* for a `channelOf(reg, value)` carrying a
    per-schedule latch, and the driver refuses (`E_PSG_LATCH`) rather
    than guessing if a schedule ever opens a tick with a data byte and no latch in
    front of it. Both of those are `rom/psg.ts`'s now, because they are the
    *chip's* rather than the Z80's — which is what let the Mega Drive's 68000
    driver reuse them unchanged. That refusal is what makes preemption safe: every run of a PSG
    stream begins with a latch byte, so a run the music skips takes its own
    channel selection with it.

    The clock is the other thing this console decided for itself. `psgBinding`
    would fit a rate to the VDP's line interrupt, and that is the wrong answer for
    a *game* — the line counter is reloaded on every scanline outside the active
    display, so a line interrupt every N lines fires a handful of times inside the
    picture and then not at all until the next frame. A game's driver therefore
    rides the frame at 59.92 Hz, like the NES's and for the same kind of reason.
    The candidate survived for standalone tracks on the grounds that only a game
    shares its clock with the picture; the standalone cartridge below is what
    showed that reasoning to be wrong, and it is gone from the binding and from
    the spec.
    **The Mega Drive is the fifth console, and it is the first 16-bit one.**
    `demake build -c md` produces a real Mega Drive cartridge — 68000 machine code
    written for the game, vector table, header and word checksum, art demade into
    a 1408-tile bank across three of the VDP's four sub-palettes — and the whole
    example library traces identically there, in the same battery, at the same
    one frame a tick. Nothing moved out of `backend.ts` or `shape.ts` for it
    either.

    What the wider machine changes is the *shape of the value layer*, and it is
    the clearest evidence yet that the split is in the right place. A 16.16 value
    is a **register** here: `move.l`, `add.l`, `sub.l`, `neg.l`, `asr.l` and
    `cmp.l` each do in one instruction what the Z80 does in four and the 6502 in
    eight, and `cmp.l` sets a signed condition directly rather than leaving one to
    be synthesised. So `codegen/md/val.ts` is a quarter the size of the Sega's and
    an eighth of the NES's, and the only two routines this console pulls in are
    the ones the machine genuinely lacks — a 32×32 multiply, assembled from four
    `mulu.w` products into a 64-bit one, and a divide whose fast path for a
    whole-cell divisor is two `divu.w` instructions rather than a loop. Neither is
    a bit loop, which is why an object whose *speed* can change is affordable here
    in a way it is not on the other three.

    The renderer is easier for one reason and one reason only: **the plane is
    bigger than the screen.** Sixty-four cells by thirty-two against a
    forty-by-twenty-eight window, so a scrolling scene paints its leading edge
    twenty-four columns off the right-hand side and has no seam to hide — the
    whole `R0`-bit-5 mechanism the Master System needs is simply absent. Both
    wraps are powers of two, so the cell address is two masks rather than a
    subtraction loop.

    **Three things the trace could not see were wrong, and all three are the
    68000 rather than the VDP.** A word or long access to an **odd address** is an
    address error, and the shared RAM allocator packs bytes — so `MemoryPlan`
    grew an `align`, and the two lists that interleave a count byte with word
    entries (the tile contacts and the cached cell walk) are read a byte at a
    time. The **backdrop blit** had the same fault from the other side: a packed
    cell follows a control *byte*, so half of them are odd-addressed, and reading
    them as words cost the first cell of every picture. And the trace reader
    itself had to learn a machine's **byte order**, because this is the first
    big-endian console in the set and a little-endian read reports every value
    byte-swapped — which looks like an arithmetic bug three layers from its cause.
    The fourth was a register convention rather than the hardware: `RngAdvance`
    builds a 32-bit product out of `d0`–`d3`, so the draw's bound and count live
    in `d6`/`d7`, and holding them lower produced random numbers that were
    plausible and wrong.

    Framebuffer-green is what remains here too, behind the same scripted input
    tape. Until then `md-rom.test.ts` is the rendering oracle — the plane against
    the level grid, cell by cell, after the camera has travelled — and
    `md-arith.test.ts` the arithmetic one.

    **Sound is built, and it is all ten voices.** Two chips — a YM2612 at
    `$A04000` and an SN76489 at `$C00011` — arranged against as one instrument,
    because that is what they are on the board. The PSG half needed nothing new:
    the same chip at the same master clock over fifteen, in a frame of 262 lines
    of 228 chip cycles, so `mdAudio` and `smsAudio` reduce to the same rational.
    The FM half needed a chip model, a binding, and the first *searched* timbre
    in the project (§A5, doc 17 §Stage 3).

    Two facts about the driver are worth recording. The packed register byte,
    which on a one-chip console names a register, here names one of five
    destinations — the FM chip's four consecutive bus addresses or the PSG — so
    two chips cost the packed format nothing. And ten voices against a four-bit
    channel field do not have to fit: preemption only asks whether an *effect*
    may be using a voice, so only the voices effects were placed on are numbered
    and the FM half of a track plays straight through a sound effect rather than
    ducking for it.

    **The chip model is complete**, which it was not when this console landed:
    the LFO's pitch modulation, the SSG-EG envelope modes and channel 3's
    four-pitch mode — with the timer-driven key-on that rides on it — are all
    modelled now. None of the three is reachable through a register the binding
    writes, so closing them changed no cartridge's audio by a byte; the reason
    to do it before a binding wants them is that a chip with a gap in it is a
    gap to close (AGENTS.md §Iron rules) and a binding that reaches for one now
    gets the hardware rather than a shrug. What the model still does not do is
    the bus's busy flag, which is honest for a model with no bus timing, and the
    difference between the discrete chip's nine-bit operator output and the
    later ASIC's — a *board* difference of the kind `mix()` already takes
    per-chip gains for.

    The cartridge budget has no story here at all, which is itself the news:
    512 KiB against 32, and 64 KiB of work RAM against an NROM cartridge's 2. The
    scarce resources on this machine are the tile bank and the four sub-palettes,
    which is why the art path is where the interesting decisions are — two
    sub-palettes for background art, one for objects, one reserved for the font,
    and the font's ink chosen against the backdrop because colour zero is
    transparent on *both* layers here.

    **The ARM pair is started, and the spine under them is built.** A Game Boy
    Advance and a Nintendo DS are one encoder between them —
    `core/src/asm/arm.ts`, ARMv4T in ARM state — and it is the first in the set
    with two oracles: hand-read encodings, as every other encoder gets, *and* a
    differential battery against `arm-none-eabi-as`, which the display-ROM
    harnesses already provision. That second one earns its place here in a way it
    would not on an 8-bit CPU: those have an opcode per addressing form, so a
    wrong byte is a wrong instruction, while ARM packs five operand shapes into
    twelve bits and a shift written into the wrong nibble still decodes as
    something.

    The architecture's one genuinely new demand on an emitter is the **literal
    pool**: a 32-bit constant does not fit in a 32-bit instruction, so a value the
    rotated immediate cannot express has to be *loaded* from a word within 4 KiB
    of the load that reads it. `ldrConst` emits the load now and `ltorg` places
    the word later, which keeps the encoder single-pass; a pool that cannot be
    reached is an error naming the flush rather than a silent truncation.

    `@demake/gba` is the fifth owned core: an ARM7TDMI, a mode-0 2D engine, DMA,
    timers, and both halves of the sound. Two of its decisions are the ones that
    will shape the backend above it. The **four background layers with
    independent scroll** retire the mechanism every other console here needs — a
    scrolling scene's HUD is drawn with sprites on a Game Boy because the
    background moves as one piece, and here it simply gets a layer. And the
    per-line object budget is measured in **cycles rather than a count of eight**,
    so a wide object is affordable and `E_SPRITE_BUDGET`'s reasoning changes shape
    on this machine.

    Sound is where this console is unlike every predecessor, and the design is
    settled: it has *both* kinds of hardware. Four Game Boy channels sit at
    `$4000060`–`$4000084` under a permuted register map — `@demake/chip`'s
    `GbApu` reached through a machine description, the Mega Duck's arrangement
    exactly — and two direct-sound channels sit beside them being fed eight-bit
    samples by DMA. The second half is a **software mixer**, which is the first
    thing in this project that doc 16's "a timed register-write schedule" does not
    describe, and the contract survives restated one level up: the registers are a
    mixer's rather than a chip's, and what a driver must reproduce is *the samples
    themselves*, byte for byte, against what `@demake/chip`'s new `GbaPcm`
    renders. That is a sharper claim than a register diff, not a weaker one,
    because the comparison is against the audio rather than against an instruction
    to make it — and it is exact, because the mixing is integer throughout.

    **The Game Boy Advance is the sixth console, and it is the first one whose
    hardware is bigger than the language needs in every direction at once.**
    `demake build -c gba` produces a real cartridge — ARM machine code written for
    the game, a 256-colour mode-0 background, a second layer carrying nothing but
    the HUD, and object art in a bank of its own — and the whole example library
    traces identically there, in the same battery, at the same one frame a tick.
    Nothing moved out of `backend.ts` or `shape.ts` for it either.

    Most of what is new about this backend is machinery the other five have that
    it *does not*. Four independently scrolling backgrounds mean the HUD gets a
    layer, so the sprite HUD every other console needs for a scrolling scene, the
    second decimal renderer that drives it and the whole pixel-pinning argument
    are simply absent: layer one's scroll registers are written once at boot, and
    a caption's cell is `floor(pos) − floor(camera)` on both axes. A cell has 256
    colours and no palette field, so a picture is fitted into one flat palette
    rather than partitioned into sub-palettes and `maxSubPalettes` does not apply
    — which is why the font's reservation is expressed in *colours* here, three of
    256 against the quarter a Mega Drive gives up. Backgrounds and objects have
    separate character memory and separate palettes, so this is the first console
    where a full-screen picture cannot starve the sprites and `checkTiles` refuses
    two budgets. And the map is bigger than the screen on both axes, so there is
    no seam to mask.

    What it charges for instead is *addressing*. A halfword transfer reaches ±255
    where a word transfer reaches ±4095, so the value layer has two addressing
    functions and the four narrow forms are only reachable through helpers that
    pick one — an emitter that used the wide one for a `strh` assembles fine until
    a game grows past the first 256 bytes of its own state. The converse bit the
    scroll registers: an address past the base register's reach is materialised
    into `r12` immediately before the access, so a hardware base held there is a
    base the next load overwrites, and the symptom is a register that is never
    written rather than a crash. And a 32-bit constant does not fit in a 32-bit
    instruction, so a rule body longer than 4 KiB has to place its literal pool
    early, over a branch, at a point the emitter chooses.

    Three things are the instruction set's rather than the console's: a collision
    box is one `ldm` and one `stm`, a short conditional is a predicated pair with
    no label, and the decimal renderer keeps its whole state in callee-saved
    registers *across* the call that plots a glyph — which no other backend can
    do, and which is only sound because every routine in this backend keeps
    `r4`–`r11`.

    The rendering oracle is `gba-rom.test.ts`, and it is where the block layout is
    settled: a 64×64 map is four 32×32 screen blocks a kilobyte apart rather than
    a rectangle, so the test computes the address the hardware's way and checks
    every visible cell against the level's own grid once the camera has crossed
    into each of them. It also pins the property the HUD-layer design rests on —
    a camera-pinned caption occupying the same cells for forty frames while the
    picture scrolls under it.

    **And it has sound, which on this console means the driver computes half of
    it.** `demake build -c gba` puts an ARM player in the cartridge
    (`packages/audio/src/rom/gba-driver.ts`, `gba-game.ts`), and it is the sixth
    generated driver and the first that is not only a driver: four of the ten
    voices are a Game Boy's APU and reach it as stores, and the other six are
    `@demake/chip`'s `GbaPcm` — a mixer whose register file is in work RAM and
    whose output the processor has to produce, sample by sample, between one
    block and the next.

    So doc 16's Level A proof arrives in two halves here, and the second is the
    sharper one. The register writes are diffed tick for tick by the same battery
    five other machines run; the samples are diffed **byte for byte** against what
    the model renders from the same schedule, which is a comparison against the
    audio rather than against an instruction to make it, and which is exact
    because the mixing is integer throughout.

    Three of its answers are this console's rather than a predecessor's. **The
    clock is the transfer**: a block of 256 samples is sixteen FIFO refills, so
    the sixteenth refill's interrupt *is* a block boundary, and counting transfers
    is exact where a timer at the same rate is not — a timer runs a fixed number
    of bytes out of phase with a transfer that reads ahead, and the phase depends
    on how deep the hardware's queue is. It also lands the rate on 128 Hz exactly.
    **The mixing is the main loop's**, because twenty thousand cycles inside the
    handler would be two refills the handler then never sees, so the frame-clocked
    consoles' count-and-service split returns for a reason of this console's own.
    And **the driver needs working memory** — two kilobytes of stereo accumulator,
    a hundred times any other console's driver state, in internal RAM because the
    mix loop touches it four times a sample.

    **The mix loop lives there too**, and that is the difference between a mixer
    that fits in a frame and one that does not. An instruction fetched over the
    cartridge bus costs four cycles at the wait states the boot programmes and one
    fetched from internal RAM costs none, so the driver copies the routine and its
    literal pool in at boot and calls the copy — 1.85 frames a game tick against
    1.00, measured with six voices actually sounding. It stayed invisible for as
    long as the example library had four parts and none of them reached the mixer,
    which is the second thing widening the fixtures paid for.

    One thing the driver exposed was not the driver's: **the example library was
    written four parts wide, and a ten-voice machine cannot spend that.** The
    arranger gives each part the channel that serves it best, so four parts took
    four voices — usually the Game Boy's, which have envelopes and duties the
    mixer has not — and the other six sat idle on every track in the library. The
    fixtures are full arrangements now, around ten parts each, so this console
    plays the APU half *and* the mixer half; the demakers were always able to
    spend the machine, and what was missing was material to spend. Whether an
    arranger with spare voices should double a part rather than leave one idle is
    still doc 17's question and still open — but it is now a question about
    genuinely spare voices rather than about a starved input.

    **And the Nintendo DS, which cost a description and no instructions.**
    `demake build -c nds` produces a real `.nds` cartridge carrying the *same ARM
    machine code* a Game Boy Advance build carries, and the whole example library
    traces identically there. That is not a seventh backend: a DS's 2D engine A
    is a Game Boy Advance's at the same register offsets with the same screen
    entries and the same character formats, so it is a variant on the Mega Duck's
    terms, and `codegen/gba/machine.ts` is the whole of it.

    Five entries, and each is a way a cartridge can be perfect and dark. The
    program is **copied into main RAM** rather than run from a bus, so the header
    is a region in front of the image and the limit on a build is the megabyte
    before its own heap. **A video RAM bank has to be pointed somewhere** before
    anything is uploaded into it, and backgrounds and objects are two banks rather
    than one array. **`DISPCNT` is a word**, and the field that decides whether
    the engine's output reaches the screen at all sits in the half a halfword
    store never writes. **The window is 32×24.** And **the loop watches the beam**,
    because this machine's interrupt vector is inside data TCM and its base is a
    CP15 setting rather than an address — a description to get exactly right for a
    gain of nothing, since the main loop is what waits either way.

    `@demake/nds` is the seventh owned core and the smallest, because the
    processor and the engine are `@demake/gba`'s: what is there is the machine
    around them. `nds-rom.test.ts` is the oracle for the description itself, and
    `rom.test.ts` settles the sharper claim — the instructions are the other
    machine's, so a trace that matched on one and not the other would mean part
    of the description had leaked into the code a tick runs.

    **And the DS has sound**, which is a second processor's job in a way no other
    console's is. Its sixteen channels answer to the ARM7 alone, so `demake build
    -c nds` emits *two* programs — and unlike the Super Nintendo's, the second one
    is not uploaded: a `.nds` names two binaries and the loader copies both into
    the four megabytes they share, so the driver is running before the game's
    first frame and the game reaches it by storing two bytes of ordinary main RAM.
    `@demake/chip` gained the SPU, `@demake/audio` gained the binding, the
    thirty-two-sample waveform bank and the driver (`rom/nds-driver.ts`,
    `rom/nds-game.ts`), and `@demake/nds` gained the second processor and its
    world (`arm7.ts`). The whole example library plays it tick for tick in the
    shared battery (`audio-nds.test.ts`).

    Three of its answers are this machine's rather than a restatement. **The
    clock is a hardware tally**: timer 0 reloads at the driver rate and timer 1
    counts its overflows, so the number of ticks that have happened is a register
    the driver *reads* rather than a flag it has to catch — nothing can be missed
    by a tick that overran, and no interrupt is involved in this cartridge's sound
    at all. **Nothing on the chip is shared**, so there is no merge routine
    anywhere: panning is a byte per channel, enabling is the channel's own start
    bit, and there is no key-on pulse. And **sixteen channels against a four-bit
    run field** do not have to fit, on the Mega Drive's terms — only the channels
    an effect was placed on are numbered, so fourteen voices of a track play
    straight through a sound effect.

    What the ARM stream player showed is worth recording too: it moved. Two
    consoles in the set run this architecture, so the walk over packed data is now
    `rom/arm-player.ts` and belongs to the *processor* rather than to either
    machine — the third thing in that directory that is nobody's console
    (`shared.ts` is nobody's CPU, `psg.ts` is one chip's).

  - **D5 — Play ROM in the page** *(done for `gb`, `gbc`, `nes`, `sms`, `gg`,
    `md`, `snes`, `gba` and `nds`)*: the browser
    compiles the
    game itself, because the assembler is ours and written in TypeScript, and
    demakes its art with our own rasteriser rather than the browser's. It boots
    the result in `@demake/dmg`, `@demake/nes`, `@demake/sms`, `@demake/snes`,
    `@demake/md`, `@demake/gba` or `@demake/nds` —
    ours, because
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
    through the same `StreamSink` and the same `@demake/chip` models — including
    the Game Boy Advance's *two*, whose second is a pair of converters rather than
    a chip, and whose relative level is a fact about the board.
  - **D6 — language growth**, driven by fixtures beyond Pong. Levels, tiles, a
    scrolling camera, `stream`-composed courses and a seeded `random` have
    landed (doc 14 §Levels, §Composed levels, §Randomness).

    **`from <side>` builds now**, and it was the language's one entry in
    `unsupportedFor` — a clause the interpreter honoured and no cartridge did,
    so a program using it previewed, traced, and then refused to become a ROM.
    It is closed on all eight backends at once, because the gap was in the
    emitters as a group rather than a difference between them. What made it
    affordable is that the answer was already being computed: separating an
    overlap means choosing an axis and a direction, and *that choice is the
    side*, so each backend's separation was split into a part that decides and a
    part that applies and the new routine is the decision read out as a bit
    rather than a push. Both halves of the contact model are covered — an object
    pair and a level cell — and the narrowing skips the **whole** contact rather
    than only the firing, which is what the interpreter does and what stops a
    cartridge separating out of a contact it never had. Every existing cartridge
    is byte-identical, because the routine is pulled and no fixture said `from`
    before this landed; `platformer` says it now, where landing and bonking are
    two rules naming two sides instead of one rule and a velocity test.

    What is left:
    runtime spawn, a tile layer that can *change* — a door that opens, a block
    that breaks — which needs a way to name a cell, and a camera with more than
    "follow". Scrolling is also where per-scanline sprite pressure bites, so the
    backends will have opinions.

- **Projects in the web app** — **designed, in [doc 19](19-projects.md)**: today
  each section holds one artifact. A *project* is a folder with an optional
  Demakefile at its root and five resource directories — `src/`, `art/`,
  `music/`, `sound/`, `levels/` — and it is the unit the site should actually
  operate on: open one, edit any file in it, build every target. It is the same
  object the CLI already builds, so the work is the browser's file handling (File
  System Access API where available, an in-memory tree elsewhere) plus
  import/export as a zip, not a second configuration model. The shell is a code
  editor's: an explorer down the left, and opening a file opens the editor for its
  type — so the four demakers become what a `.svg`, a `.mid` and a `.wav` open in,
  and their options are written into the Demakefile rather than held beside it.
  Doc 19 §Order of work has the nine steps; the first is a pure resolver in
  `@demake/demotic` that both edges share, and the one open question it leaves is
  whether a game may be split across several `.dmt` files (§Splitting a game — a
  language change, and therefore the maintainer's).

- **A block editor for `.dmt`** — **designed, in [doc 19](19-projects.md) §The
  block editor**: a third view on a game, beside its text and its preview, where a
  program is a list of blocks you drag rather than lines you type. The palette is
  generated from `lang/spec.ts` — the same registry the parser, the reference and
  the highlighter come from — and every field offers what the open project
  actually has: sprites as pictures, tracks you can play, the program's own object
  and scene names. It is tractable only because the language is flat, line-oriented
  and registry-defined, which were choices made so a *model* could write it; the
  same properties turn out to be what a block editor needs. Two boundaries keep it
  from becoming a visual programming language: one block is one line, and
  expressions — the only nested part of the language — stay a text field with
  completion.

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

- **A level editor in the web app** — **built** (doc 19 §The level editor, doc 07):
  `.dmtl` is a text format an LLM can edit, and that was the point — but a person
  drawing a room wants to draw it. Opening one gives text, map, or both: paint
  into a grid, name tiles, mark them solid, bind art picked from the project's own
  pictures, and see the console viewports over what you drew. The file it writes
  is the same `.dmtl` the compiler already reads, so it is a view over the format
  rather than a second one, and a game stays hand-editable whether or not the
  editor was used — the three things it must never do to a file all come from
  `.dmtl` being literal (no reflow, no dropped blank row, a file it did not change
  comes back byte-identical), and the text-surgical model underneath makes all
  three impossible rather than merely unlikely. Still to come: showing a `stream`
  composition read-only, which is doc 19's one deferred piece of this.

- **Tile editing — a question, not a plan**: a tileset exists because hardware
  forces art to be shared, which makes it a *hardware* concern leaking into an
  authoring tool. A tile editor would therefore cut against the premise that you
  describe what you want and the tool handles the constraints. The current
  position is to avoid needing one: push harder on automatic dedup, budget
  reporting, and per-console art variants in the Demakefile. Revisit only if real
  games hit a wall the automatic path cannot clear — and if they do, the honest
  framing is a *tile budget inspector* that explains what was merged and why,
  rather than a manual editor.

- **Declarative art, music and sound — describing the assets in Demotic too**:
  the whole game as text, with no binary file in the project at all. A `.dmt`
  already declares the game and a `.dmtl` declares a level; the missing three are
  a picture, a track and an effect. It is speculative, post-1.0, and it is worth
  writing down because the shape of the tool makes it unusually cheap *if* one
  condition holds — and actively corrosive if it does not.

  **Why it is cheap.** Each of the three has an existing declarative target
  inside the engine, so a Demotic front end would compile *to* something already
  proven rather than reaching pixels or samples on its own:

  - **Art → the SVG document model.** `packages/core/src/image/svg/` is our own
    rasteriser, deterministic and already the path a `.dmt`'s art travels
    (doc 15 §The conversion path). SVG is declarative to begin with, so a Demotic
    art file is a *second syntax for the same document*, and `prep` cannot tell
    the difference. No new code touches a pixel.
  - **Music → `Score`.** `packages/audio/src/score/` is already the hardware-free
    representation, with MIDI as one parser into it (doc 16). A declarative track
    is a second parser into the same `Score`. The arranger, the timbre search and
    the schedule compiler are untouched.
  - **Sound → PCM.** `sfx` fits a chip gesture to a *recording* (doc 18), so a
    declarative effect has to produce samples, and the natural form is a small
    modular-synth description — oscillators, noise, filters, envelopes — rendered
    on `core`'s own math kernels. It renders to exactly what the WAV decoder
    produces, and the class gate and the gesture tournament see a waveform as
    before. This is the cheapest and most defensible of the three: a knock or a
    coin pickup is a few lines, and writing one is easier than writing the
    generator script that currently makes the fixture.

  **The condition, and it is the whole risk.** The format must be a peer of SVG,
  MIDI and WAV — *not* a peer of the console. It has to be able to say more than
  the hardware can show, and the demakers must still have real work to do. Two
  ways that fails, both of which the AGENTS.md authoring rules already warn about
  in their existing form:

  - **Art authored at the target's resolution.** A hand-typed art format invites
    four tones and 8×8 shapes, because that is what is quick to write — and then
    the fit has nothing to quantise and a Mega Drive gains nothing over a Game
    Boy. The library's SVGs are drawn on a 640×576 canvas with detail down to a
    quarter of a Game Boy pixel *deliberately*.
  - **Chip music by the back door.** If the format is easy to write in two voices,
    it will be written in two voices, and the arranger's central decision — what
    to do when there are more parts than channels — is hidden rather than made.
    The library's MIDIs are full arrangements for exactly that reason, and *how*
    full matters at both ends: four parts hides the decision on a four-channel
    console the other way round, by leaving a sixteen-channel one nothing to
    spend. Around ten is what makes every console in the set say something
    different.

  So the test for any proposal here is not "does it produce a nice sprite", it is
  **does the demaker still have something to demake**. A format that can only
  express what one console can display is a tile editor with extra steps, which is
  the previous bullet's argument arriving by a different route.

  **What it would buy**, if that condition is met: a project that is entirely
  text — readable diffs, no zip, and every asset reviewable in a pull request; one
  language, one set of diagnostics, one registry pattern (`.dmt`, `.dmtl` and
  `.test.dmt` already share a lexer and a front end, so a fourth, fifth and sixth
  file type is a known cost); determinism by construction, since nothing decodes
  or rasterises outside our own code; and the visual editors of
  [doc 19](19-projects.md) extending to assets, because a declarative source is
  exactly what a block or grid editor can be a view over. The agent story
  (§Agent-driven demaking) benefits least, and it is worth being clear about that:
  an agent can already emit SVG and generate a MIDI, so the honest argument for
  this is human authorability and diffability rather than machine writability.

  Order, if it is ever taken up: sound first (smallest, and the demaker's input is
  the easiest to synthesise honestly), then music, then art — which has the best
  existing target and the highest chance of quietly undermining the tool's premise.

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
    `.vgm` artifact run on all eight consoles with a chip model — and on the one
    whose chip plays samples the artifact is an `.spc` instead, because a write
    log without the sound processor's RAM is not a piece of music. Tempo is preserved outright rather
    than approximately, and a test shows the error shrinking with length rather
    than compounding. Outstanding: tracker ingest, `bin`/`asm`/`c` emit, driver
    backends beyond the Game Boy, and the listening sheets the judge weights get
    frozen against.
  - **A2.5 — the driver and the proof** *(done for the `gb` family, the NES and the PC Engine)*: `demake gen
    <schedule> --format rom` generates an SM83 driver *for this schedule* — rests
    pulled only if it rests, an order walk only if it has one, a stop path only
    for a one-shot — packs the schedule into deduplicated blocks behind an order
    list, and assembles a 32 KiB cartridge with `core`'s own assembler. Level A
    of doc 16 §The proof runs in `pnpm test`: the ROM boots in `@demake/dmg` and
    every register write it makes is diffed against the `ChipScript`, tick for
    tick, with no tolerance and no toolchain. Both demakers are covered, because
    a track and a one-shot exercise different halves of the driver.

    This is the point at which the audio domain reaches the shape the image
    domain has — constrain → fit → emit → prove on emulated hardware.

    **The NES is the second family**, and it is what turned "what does another
    console cost" from an estimate into a measurement. Nothing about the *player*
    moved: `rom/mos-player.ts` belongs to the processor and a game already used
    it, so the whole of `rom/nes.ts` is the three things a console decides for
    itself. The **clock is the picture's**, because this CPU has no timer a
    driver can have without burning the DMC channel — so where `gb.ts` picks
    between a timer and the frame, here there is nothing to pick and a schedule
    fitted to anything else is refused by name. **There is no entry point**, only
    a vector: the last six bytes of the image are what makes the cartridge boot,
    stamped after assembly because they are addresses of labels inside it. And
    **the picture hardware has to be quietened and then waited for**, because a
    cartridge whose only job is sound still owns it.

    The board is elastic on the language backend's terms — an NROM-128 when the
    schedule fits one — and the proof is the Game Boy's run in `@demake/nes`: the
    same `it.each(audioRomConsoles())` battery, plus a one-shot per console,
    because where a stream *ends* is the order walk's business and that walk is
    the processor's rather than the machine's.

    **The PC Engine is the third, and it is the measurement rather than the
    claim.** Its player is the NES's — literally the same file, because a
    HuC6280 *is* a 6502 — so `rom/pce.ts` is the same three things with different
    answers: a **timer** rather than the frame, a register base at `$0800` in the
    hardware page the boot code maps, and a program that **is not where it was
    assembled**, since reset maps only bank 0 at `$E000` and the boot stub is
    emitted last and swapped into it.

    It also added the one thing neither predecessor needs. This chip's wave RAM
    is reachable only through the register port, so five waveforms is a hundred
    and sixty writes and tick 0 arrives with more writes in it than the packed
    format's run count can hold — the **boot strip** is what makes the schedule
    packable here, rather than merely what stops an effect powering the chip up
    again. `BuiltAudioRom` therefore carries a `performed` schedule, the same
    field and the same reason every game driver in that directory has one, and
    the proof diffs against *that*: what the driver promises, not what the caller
    handed it. A second assertion covers the half no tick diff can see — that the
    waveforms reached the chip before the clock started, because a cartridge that
    skipped the table would be exact in a register diff and silent on the
    machine.

    What each remaining console costs is now the same three things over one
    shared walk. Level B (sample comparison against a third-party core, via the
    libretro harness's audio callback) is the other thing that remains.
  - **A3 — `sfx`** *(built for WAV; the Game Boy boots)*: eight gesture families, the class gate,
    deterministic coordinate descent with every candidate rendered through the
    chip model, and the placement contract each effect declares. A single effect
    builds into a cartridge and is proven by A2.5's Level A suite, and a Demotic
    game is now the bank: every `sound` it names is demade, packed behind one
    index and played under the music by one generated driver, with the same
    proof one level up (`packages/demotic/test/_audio-battery.ts`). Outstanding:
    `--variations`, standalone banks outside a game, and restoring the music's
    interrupted note rather than handing the channel back silent (doc 18
    §Stage 4).
  - **A4 — audio input**: the transcription front end (beat, percussion, bass,
    lead, harmony) with confidences, plus the decoders. *Done means*: an MP3
    becomes a playable cartridge, and the parts it found are reported honestly
    enough that a wrong one can be corrected in one flag.
  - **A5 — breadth** *(`nes`, `sms`, `gg`, `snes`, `md`, `gba` and `nds` done,
    inside a game)*:
    the 2A03, the SN76489, the S-DSP, the YM2612, the Game Boy Advance's mixer and
    the Nintendo DS's SPU each have a chip model, a
    binding and a generated driver — 6502, Z80, SPC700, 68000 and ARM twice — and
    `demake build` puts music and
    effects in the cartridge with doc 16's Level A proof over all of them. Five of
    them now also build a *standalone* audio cartridge — `demake gen … --format
    rom` reaches the Game Boy, the NES, the PC Engine, both Sega 8-bits and the
    Mega Drive — and the rest do not, because a cartridge whose only job is one
    track is what a later caller needed and not what a game did. That last one is
    where the difference between the two callers stops being a matter of
    packaging: on that board the FM chip's timer interrupt goes to the Z80, so a
    driver polls the status byte, and a game's loop is also running a game while a
    standalone cartridge's does nothing else. The same hardware is a usable clock
    for one and not for the other. The Super Nintendo is
    the near miss: `demake arrange -c snes` writes an `.spc`, which is the same
    driver and the same schedules in the format that console's own players read,
    but it is a RAM image rather than a cartridge. The SN76489 is also the
    one that stretched the shared packing layer: its channel is in the data byte
    and latched, so `channelOf` became a factory over a per-schedule latch and a
    schedule that opens a tick with a bare data byte is refused rather than
    guessed at. It is also the chip that made the layering pay: the Mega Drive
    runs the *same* SN76489 at the same clock, so its binding needed no change and
    its driver needed only the parts a 68000 does differently — everything the
    chip decides moved into `rom/psg.ts` and is shared with the Z80's driver
    verbatim. The Mega Drive then went further and became the first *two-chip*
    console: `BoundWrite.chip` carries which device a write addresses, `render()`
    filters per write, `mix()` takes per-chip gains from the binding, and the
    packed register byte names one of five destinations rather than a register.
    It is also the first console whose timbre is *searched* — see §Stage 3 of doc
    17, which had been waiting for an FM target. The Super Nintendo stretched the
    layer in the other direction, and is the first console whose driver does not
    run on its own processor at all — a chip model, an SPC700 assembler, a
    generated driver and a boot upload, all of which §D4 records — and both
    handhelds, whose drivers are ARM and share a stream player
    (`rom/arm-player.ts`) while sharing nothing below it: the Game Boy Advance's
    has to *compute* six of its ten voices, and the Nintendo DS's is a whole
    second binary for a processor the game cannot reach the sound from. Remaining:
    the Tier 2 consoles — each is a chip model, a
    driver backend and a Level A/B harness, on the per-console definition of done
    Phase 2 used for images. Each faces the choice doc 16 §The driver contract
    records: own the CPU's encoder (as the Game Boy does, which buys the browser
    and a toolchain-free proof) or pair generated data with a checked-in driver
    source for a stock assembler (as the image harnesses do). Level A also needs
    a core we own or one that exposes scripted register access.
  - **A5.5 — hardware the models describe and no demaker reaches** *(open)*: the
    iron rule is that a demaker spends the whole machine, and the chip layer has
    now run ahead of the bindings. None of this is a *correctness* gap — every
    cartridge performs exactly the schedule its demaker produced, and the
    schedule is exactly what the model would render — but each line is expression
    the hardware offers and nothing asks for. Closing one changes output bytes on
    the consoles it touches, so each needs re-baselined goldens and a `minor`.

    | Hardware | Modelled | Spent by a demaker |
    | --- | --- | --- |
    | YM2612 LFO (vibrato and tremolo) | yes | no — `binding/md.ts` writes `$22 = 0` and every channel's sensitivity nibble as zero |
    | YM2612 SSG-EG envelope modes | yes | no — those registers are never written |
    | YM2612 channel 3's four-pitch mode | yes | no — `$27`'s mode bits are always zero |
    | HuC6280 LFO | yes | no — the LFO registers appear only in `binding/pce.ts`'s channel *tag*, never in a write |
    | WonderSwan channel 2's PCM voice | yes | no — nothing above the chip layer drives it |
    | PC Engine direct D/A | yes | no — likewise |
    | YM2610 SSG noise | yes | no — `binding/neogeo.ts` writes the mixer once, tone on and noise off |
    | YM2610 ADPCM-A voices 2-6 | yes | no — the *arranger* gives a percussion part one channel |

    Two of those are the Neo Geo's and neither is the binding being lazy. The
    **SSG noise** is refused deliberately: this console has six sample voices
    playing recordings of drums, so putting a hi-hat on a shift register would be
    spending the machine downwards, and not writing `$07` per note is also what
    leaves the console with no shared register to merge. The **five idle sample
    voices** are the interesting one, and they are an *arranger* gap rather than a
    binding one: `plan.ts` assigns one part to one channel, and a General MIDI
    drum track is one part — so a kit lands on one voice and the other five sit
    there. Nothing before this console had more than one percussion voice, so the
    question had never come up. What it needs is for a percussion part to be able
    to take a *pool* of channels, with simultaneous hits spread across them, which
    reaches `plan.ts` and `compile.ts` together.

    **The first line is the one to do first, and it is bigger than the FM chip.**
    Nothing anywhere in `@demake/audio` produces vibrato *at all* — not through a
    chip LFO, and not through per-tick pitch writes on the consoles that have no
    LFO to use. A period arranger uses it constantly, so this is an arranger
    question (doc 17) before it is a binding one: where the depth comes from (a
    source's own modulation controller? its articulation, the way
    `binding/fm-patch.ts` already reads one?), whether it is a per-part decision
    or a per-note one, and what it costs a four-channel console in schedule bytes
    when it has to be written rather than switched on. The last two lines are
    doc 18's rather than doc 17's — a sample player wants a *sound* demaker
    pointed at it, not an arranger.
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
- **Banked cartridges, and the game that needs one**: `quest.dmt` — three
  levels, a boss, a secret room, four tracks and eight effects — is the first
  example the mapper-less cartridge cannot hold. It builds and plays on the Mega
  Drive (140 KiB, on the 256 KiB board its size asks for) and on nothing else, and
  the numbers say what each console is short of rather than by how little:

  | Console | Wall it hits | Needs | Has |
  | --- | --- | --- | --- |
  | Game Boy / Color / Mega Duck | cartridge | ~122 KiB | 32 KiB |
  | Master System / Game Gear | cartridge | ~117 KiB | 48 KiB |
  | NES | work RAM, then cartridge | 1288 B of heap, ~120 KiB of PRG | 1280 B, 32 KiB |
  | Super Nintendo | direct page, then cartridge | 239 B, ~100 KiB | 238 B, 32 KiB of bank zero |

  The RAM half is close on two of them and the cartridge half is not close on
  any: the code alone is around 100 KiB, because a program is unrolled into the
  scenes its rules can fire in and this one has four playfields. So *data*
  banking — art, packed backdrops, audio schedules — is not the answer; the
  banking has to reach code.

  **A bank per scene is the natural shape and it is not enough on half these
  consoles**, which is the one thing here that had to be measured rather than
  reasoned about. Quest has seven scenes, and they are nothing like equal —
  three of them are levels with a full cast of rules and three are title cards.
  On the Game Boy, where the switchable window is 16 KiB:

  | Scene | 0 | 1 | 2 | 3 | 4 | 5 | 6 |
  | --- | --- | --- | --- | --- | --- | --- | --- |
  | Game Boy, bytes | 1778 | **27341** | 12330 | **23872** | **18992** | 1733 | 2274 |
  | Super Nintendo, bytes | 1400 | 19766 | 8237 | 16856 | 13941 | 1303 | 6889 |

  Three of the seven overrun a Game Boy bank, and the largest overruns it by
  two thirds. Splitting at the four routines a scene already has does not rescue
  it — `SceneTick_1` alone is 22153 bytes — so on a 16 KiB-window console
  (the Game Boy, and the NES with UNROM or MMC1) the granularity has to go
  *below* a routine: the seven tick steps would each have to become a callable
  routine of its own, which is `emitTickSteps` in `backend.ts` and therefore all
  thirteen backends at once.

  The Super Nintendo does not have that problem, because a LoROM bank is 32 KiB
  and its largest scene is 19766 bytes. So the ordering that follows from the
  measurement is: **the Super Nintendo first**, where a bank per scene fits, the
  cartridge needs no controller at all (LoROM past bank 1 is address decoding),
  and the 65816 has `jsl`/`rtl` — a real far call, where the other three CPUs
  need a trampoline in the fixed bank. The two 16 KiB-window consoles come after
  the tick steps are routines, and the Sega 8-bits sit between the two: its
  window is 16 KiB as well, but slots 0 and 1 are 32 KiB of *fixed* space rather
  than 16, so the shared half is twice the size before anything has to move.

  What that costs, per family:

  - **Sega 8-bit** — ~~the cheapest, and worth doing first~~ **done, as far as
    flat address space goes.** The mapper is in the cartridge rather than the
    console and slots 0, 1 and 2 come up holding banks 0, 1, 2, so `$0000`–`$BFFF`
    is one continuous image and **48 KiB needs no bank switching at all**. The
    build now takes the smallest flat size that fits, the `TMR SEGA` size nibble
    follows the image, and `sms-flat48.test.ts` boots a 48 KiB cartridge in
    `@demake/sms` and diffs it against the interpreter. Every existing cartridge is
    byte-identical, because a game that fits below `$7FF0` takes the same single
    pass it always did.

    **And the header hole is placed tightly**, which was the prerequisite this
    entry used to name. The header is sixteen bytes **inside** the image at
    `$7FF0`, and the data section used to be padded past it in one move — so the
    whole gap between the end of the code and `$7FF0` was thrown away, up to
    thirty-two kilobytes for a game whose code is short and whose tables are long.
    It is now stepped over one block at a time: everything after the code is
    addressed by label rather than by a branch, so a block that would be laid
    across the header moves past it whole and takes its label with it, and every
    block that fits below stays below. The audio driver's packed schedules place
    themselves, because they are dozens of small blocks rather than one — the same
    `DataHole` the standalone Sega cartridge has always used. The smallest game
    that reaches the larger board at all recovers 1223 bytes;
    `sms-flat48.test.ts` asserts what no wholesale pad can produce, which is a
    data section with blocks on *both* sides of the header.

    The one thing that made it awkward is that a block's length is not known
    until it has been emitted, and by then the decision is made — so the lengths
    come from the pass that has already happened. `sms.ts` assembles once with no
    hole to find out whether the game fits below `$7FF0` at all, that pass emits
    the same blocks in the same order, and the second pass reads the length of the
    block it is about to emit out of what the first measured. The two are compared
    afterwards, because a size list that had drifted would place the hole
    somewhere plausible and wrong. Every existing cartridge is still
    byte-identical: a game that fits below `$7FF0` never makes the second pass.

    What this still does *not* reach is the thing quest needs, and the shape of
    the limit is what is left. The window is games whose *code* ends below the
    header: above that there is nowhere to put it at all and the build says so
    (`E_GAME_TOO_LARGE`, naming `$7FF0`). Past 48 KiB the cartridge has to page
    slot 2, which inherits the same hole — and now inherits the placement with
    it.
  - **Game Boy** — **the cartridge half is done and the codegen half is not.**
    `stampGbHeader` takes the board from the image's own length, so 32 KiB is
    the ROM-only cartridge it always was and anything above it declares MBC5 and
    one of the nine sizes the field can say; `GB_ROM_SIZES`, `GB_BANK_SIZE`,
    `GB_BANK_WINDOW` and the `MBC5` register map are `core`'s, shared by the
    builder that writes the byte and the machine that reads it. `@demake/dmg`
    has the controller: bank 0 stays wired to `$0000`–`$3FFF` because the
    vectors, the entry point and the header are down there, and `$4000`–`$7FFF`
    answers whichever of up to 512 banks the nine-bit register names. Whether
    there is a controller at all is the cartridge's own type byte and never a
    setting — the CGB flag's rule, one header field along — so every ROM-only
    cartridge this project builds today runs through code that cannot tell the
    difference, and `mbc5.test.ts` boots a real banked image and pages it.

    Two things about it are deliberately absent. **Cartridge RAM is not
    modelled**, because no board demake produces declares any: a demade game's
    state is the console's own 8 KiB on every Game Boy build, so `$A000` reads
    open and a runtime that started using it would be visibly wrong here rather
    than subtly wrong. And **MBC1, MBC2 and MBC3 are absent**, because nothing
    builds one and a controller nobody drives is a controller nobody is
    checking.

    What is left is the emitter, and the measurement above says it cannot be a
    bank per scene on this console: three of quest's seven scenes overrun a
    16 KiB window and `SceneTick_1` overruns it on its own. So the Game Boy
    waits on the tick steps becoming callable routines, which is `backend.ts`'s
    change rather than this backend's.
  - **NES** — the only family that needs a *new* mapper in the core as well:
    UNROM/MMC1 for PRG, and MMC1's `$6000` work RAM is the only way the console's
    two kilobytes stop being the binding constraint. Its window is 16 KiB, so it
    is behind the same tick-step split the Game Boy is — and it is the one
    console where the RAM wall comes *first*, which means the `$6000` half is
    worth doing on its own even before a byte of code moves.
  - **Super Nintendo** — **the one to do first**, on the measurement above: a
    LoROM bank is 32 KiB and quest's largest scene is 19766 bytes, so a bank per
    scene fits without the tick ever being split. It is also the cheapest in
    every other direction — extra banks are address decoding rather than a
    controller (DMA already takes its source bank as a byte, which is why the
    tile art costs bank zero nothing), and `jsl`/`rtl` is a real far call where
    the other three CPUs need a trampoline in the fixed bank. Its work RAM is a
    separate opportunity and the wall quest hits first: the plan stops at the
    8 KiB mirrored into bank zero, it needs 239 bytes of a 238-byte direct page,
    and the other 120 KiB is reachable with long addressing or a data-bank
    switch.
  - **Mega Drive** — nothing to do but grow the image, and that is now what
    happens: `MD_ROM_SIZES` runs 128 KiB to 4 MiB and the build takes the
    smallest board that holds the game. Past 4 MiB it wants paging through
    `$A130F1`, and says so.

  **The sizing half of that mechanism is built** (doc 14 §Elastic cartridges).
  Every console's cartridge wrapper declares the boards it came on and every
  backend takes the smallest that fits, in both directions: the NES gained
  NROM-128, the Mega Drive dropped its floor from half a megabyte to one megabit,
  and a silent Super Nintendo cartridge is two banks rather than four. What it
  does *not* do is make a bigger game fit, because none of those boards needs a
  mapper — growing past the last one is still the work above. What it does buy is
  the honest artifact: a game gets the board a game that size shipped on rather
  than a constant somebody picked once.

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
