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

**The Neo Geo was on that list and should not have been, and is now off it in
both directions** — its own core and a third-party emulator. It is worth
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

**And the display-ROM E2E proved the argument reaches somebody else's emulator
too.** geolith refuses to load a cartridge without a system ROM archive — but its
members are read by *name*, with no checksum anywhere, so
`packages/cli/test/_neogeo-bios.ts` writes one: the same three-line hand-off
`@demake/neogeo` implements, assembled with core's own 68000 encoder and zipped
with core's own PNG primitives. What that buys is the only kind of check a shared
convention can fail, and it failed three of them at once — see
[§the order, item 8](#the-order).

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

1. **Mega Duck** — *done, display ROM included*. Same SM83, same tile and map
   formats, same joypad, same interrupt vectors; a permuted LCD register map, a
   permuted LCDC, a permuted APU register map, no cartridge header and no boot
   ROM. A whole console for a machine-description change — and the display ROM
   kept that bargain exactly: `rom-harness/gb/main.asm` is the Game Boy's,
   `cli/src/rom/gb.ts` generates the `machine.asm` it includes from
   `core/src/asm/megaduck.ts`, and not one instruction differs.

   Two of the three differences are structural rather than numeric and are worth
   knowing before the next variant. **There is no cartridge header**, so there is
   no `rgbfix` step and the pad to 32 KiB is the builder's. And **there is no
   boot ROM**, which is not only a fact about the cartridge: a Game Boy is handed
   over with its LCD *on*, so the harness waits for the blanking interval before
   turning it off, while here nothing has turned it on and `LY` never leaves
   zero — the wait would spin for ever, which presents as a cartridge that is
   perfect and shows a blank screen.

   The proof is **SameDuck**, SameBoy's own fork of this console, on a branch of
   the same repository. `emu-harness/gb/capture.c` is compiled against it as well
   as against SameBoy — one source, two emulators — and that is the third-party
   opinion this console's rewired I/O map most needs, because a register table of
   ours that was wrong and self-consistent would pass everything else in the
   project.
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

   Both machines build a **display ROM** too, and the mono one is the Color's
   builder around a harness that writes its palette to *ports* rather than to
   RAM: four for the shade pool and thirty-two for the sixteen four-entry
   palettes, with the backdrop read back out of the palette block's own first
   byte rather than restated. `packages/cli/test/ws.e2e.test.ts` is what proves
   the **pool** end to end — a shade there is two indirections from a pixel and
   every one of them is a fit decision, so a pool written to the wrong ports, or
   ordered against what the palettes index, is a picture in shades nobody chose
   and no assertion inside the engine can see it.

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
6. **Neo Geo Pocket / Color** — **done, display ROM included.**
   `demake build -c ngpc` produces a playable cartridge that plays its own music
   and effects, and the whole example library traces identically on it and is
   diffed tick for tick by the shared audio battery; `demake arrange -c ngpc`,
   `sfx` and `render` demake its music and effects, on the mono machine too.

   `demake gen -c ngpc --format rom` builds a bootable cartridge and the whole
   shared image battery matches the DAC reference in **beetle-ngp**. This is the
   *second* family with no third-party assembler behind it, after the Virtual
   Boy's: no distribution ships a TLCS-900/H one, so `cli/src/rom/ngpc.ts` emits
   the display program with `Asm900` — the same encoder `demake build` compiles a
   game with — and what keeps that honest is that somebody else's emulator still
   decodes every instruction. It is also where the **BGR**444 palette word is
   settled against something that is not ours, which no byte comparison between
   an encoder and a renderer of our own could do.

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

   The one thing this binding could not spend is now spent. `ChannelFrame.pan`
   was a pair of booleans, so a part reached the chip hard left, hard right or
   both; it is a signed position, the level is scaled per side and inverted into
   each of the two attenuators, and the spec's `lr-level` is finally what the
   demaker produces rather than only what the hardware does. Closing it turned
   out to be six other consoles as well as this one, and an arranger stage under
   all of them — §A5.5.
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

   **And it has a display ROM.** `demake gen -c neogeo --format rom` builds a
   `.neo` and the whole shared image battery matches the DAC reference in
   **geolith**. The picture is twenty sticky-chained sprite strips, so the
   builder's whole share of the hardware's strangeness is transposing `gen`'s
   row-major map into one 64-word column per strip; the `neogeo` codegen family
   beside it is the only one in the set whose *tile is not the console spec's
   tile*, because a pixel costs what an 8×8 4bpp layout says and the hardware's
   unit is 16×16.

   That suite found **three things nothing of ours could**, and all three were
   wrong *and* consistent — our own writer and our own reader agreed, and every
   test in the project passed while no real Neo Geo would have run the file.

   - **The `.neo` container stores its P ROM byte-swapped**, as a MAME set does;
     every emulator swaps it back at load. `packNeoRom` applies it and `loadNeo`
     undoes it, so nothing above the container changed.
   - **A sprite tile's leftmost pixel is the least significant bit**, not the
     most — the reference says "stored right to left" and the encoder had it the
     other way, which draws every tile mirrored.
   - **The palette bank's last entry is the backdrop**, so the console spec
     declares 255 sub-palettes rather than 256: a fit given all of them puts a
     colour where the backdrop goes and has it replaced.

   Two more are the *display program's* rather than the format's, and each is a
   cartridge that is perfect and dark. **SCB2 has to be written**, because zero
   is fully shrunk rather than unshrunk. And **the watchdog has to be kicked**,
   so the lock loop is a loop with a store in it.

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

    `gen --format rom` followed on exactly those terms and needed no harness of
    its own: `rom-harness/gb/main.asm` is the Game Boy's program, and
    `cli/src/rom/gb.ts` generates the `machine.asm` it includes from the table
    above. Two of the three differences are structural rather than numeric —
    there is no cartridge header, so there is no `rgbfix` step and the pad to
    32 KiB is the builder's; and there is no boot ROM, so nothing has turned the
    LCD on and the Game Boy's wait-for-vblank would spin for ever, which presents
    as a cartridge that is perfect and blank. The proof is **SameDuck**, SameBoy's
    own Mega Duck fork on a branch of the same repository, with
    `emu-harness/gb/capture.c` compiled against it as well as against SameBoy —
    one source, two emulators. SameDuck's `Core/gb.h` and `Core/display.c` are
    where the table above came from and are cited in the spec's `docs.sources`.
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
    disagree about a chip they share. **FLAC is built and it is ours**
    (`encode/flac.ts`): constant, fixed and verbatim subframes with Rice-coded
    residuals over a searched partition order, stereo decorrelation, and every
    choice made by measuring the encoded size rather than estimating it. LPC is
    deliberately absent — its coefficients come from floating-point
    autocorrelation, and a predictor derived from `Math` would be a different
    file on a different engine, which is the property the format is here to
    provide. It costs little on this material: 61.7% of the WAV against the
    reference encoder's 59.8% at `-8`. The stream carries an MD5 of its own
    audio, which the format leaves optional, precisely so `flac -t` verifies the
    decode end to end rather than merely parsing — and a self-skipping suite
    beside the encoder holds it to libFLAC, on `arm-gnu.test.ts`'s terms.
    Outstanding: the hardware test ROMs and their provisioner.
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

    **And one console could not be rendered at all — fixed, and it was the one
    renderer rather than that console.** `demake render -c gba` wrote a WAV in
    which every sample after the first was `NaN`, and had since the console was
    added. `GbaPcm.clockHz` is 32768 — the only model in the set whose clock is
    **below** the 48 kHz a render defaults to, because it is a mixer rather than
    an oscillator — and `BoxSink` computes its boundaries as
    `floor(i × clockHz / sampleRate)`. Consecutive boundaries therefore collide,
    the box has zero width, and the mean of no clocks is `0 / 0`. Every other
    chip here clocks in megahertz, so box integration had only ever had to
    *downsample* and the case was never written.

    The answer needed no new mechanism, which is the argument for it: when the
    output rate is above the chip's, a sample's box falls **entirely inside one
    clock**, and the mean of a constant is that constant. Holding the value is
    not a fallback for a degenerate case — it is what box integration *means*
    when the box is narrower than a clock, so upsampling and downsampling are
    one rule rather than two.

    The trap is the accumulator. Clearing it on a zero-width box throws away
    clocks that belong to the box after it, which renders every second sample as
    silence — a far quieter failure than the `NaN` it replaces, and one no
    check for `NaN` would notice. `packages/chip/test/mix.test.ts` pins both,
    and its sharp assertion needs no tolerance argument: a constant rendered
    through a slow clock and a fast one must produce the *same samples*, because
    the mean of a constant does not depend on how the boxes fall.

    Nothing upstream caused it and nothing downstream hid it — the register
    schedule was always correct, and `audio-gba.test.ts`'s byte-for-byte mixer
    proof kept passing because it compares the driver against the model's own
    integer mix rather than against a float render. That is also why Level B
    would have found this the hard way.
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
    | YM2612 LFO (vibrato) | yes | **closed** — `binding/md.ts` programs `$22` and the sensitivity nibble when a part asks |
    | YM2612 LFO (tremolo) | yes | no — nothing above the chip layer asks for amplitude modulation |
    | YM2612 SSG-EG envelope modes | yes | no — those registers are never written |
    | YM2612 channel 3's four-pitch mode | yes | no — `$27`'s mode bits are always zero |
    | HuC6280 LFO | yes | no — the LFO registers appear only in `binding/pce.ts`'s channel *tag*, never in a write |
    | WonderSwan channel 2's PCM voice | yes | no — nothing above the chip layer drives it |
    | PC Engine direct D/A | yes | no — likewise |
    | YM2610 SSG noise | yes | no — `binding/neogeo.ts` writes the mixer once, tone on and noise off |
    | YM2610 ADPCM-A voices 2-6 | yes | **closed** — a percussion part takes a pool of voices |
    | Stereo placement | yes, on eleven bindings | **closed** — see below |

    **The stereo line is closed, and it was wider than it was written down as.**
    It was recorded as the Neo Geo Pocket's — `ChannelFrame.pan` being a pair of
    booleans where the T6W28 pans by level — and the boolean was the smaller
    half of the problem. *Nothing in `@demake/audio` ever set `pan` at all*, by
    any route: eleven bindings read it, every one of them defaulted an absent
    value to both sides at full, and so every demade track on every console was
    mono. A rendered stereo WAV had two bit-identical channels, which no
    assertion in the suite was in a position to notice, because a register diff
    compares a schedule against itself and hears nothing.

    So closing it was two things rather than one. `pan` became a **signed
    position** and `binding/pan.ts` holds the two laws a chip can take it under
    — seven chips pan by *level* and now spend it (the T6W28, the S-DSP, the DS
    SPU, the VSU, the HuC6280, the WonderSwan and the Game Boy Advance mixer),
    four pan by *switch* and quantise it (`NR51`, the Game Gear's stereo latch,
    the YM2612's and the YM2610's output bits). And `plan.ts` gained the stage
    that produces one: per channel, constant for the piece — so a pan register
    is written once at the first tick and costs a schedule nothing — with bass,
    the tune and the kit holding the centre and the accompaniment spread
    outward.

    The part of that with a lesson in it is the **lead**. The classifier
    routinely returns four or five `lead` parts for one piece, because a melody,
    its harmony, a counter-line and an echo all carry a lead patch (AGENTS.md
    §Writing music already records it). Reading that literally and centring
    every one of them is what a mono arrangement does, and on a four-channel
    console it left the placement stage with nothing to place: the arrangement
    there is bass, two leads and the kit, and every one of those centres. So the
    most salient lead keeps the centre and the rest are placed as what they
    musically are. That is a *placement* decision and not a reclassification —
    the part is still a lead everywhere else, and still competes for the channel
    a lead wants.

    Centre is both sides at full under both laws, which is what made the change
    reviewable: a part the arranger leaves alone encodes byte-for-byte what it
    always did, so only a part that is actually placed moves.

    The Neo Geo's **SSG noise** is refused deliberately: this console has six
    sample voices playing recordings of drums, so putting a hi-hat on a shift
    register would be spending the machine downwards, and not writing `$07` per
    note is also what leaves the console with no shared register to merge.

    **The five idle sample voices are closed**, and they were an *arranger* gap
    rather than a binding one. `plan.ts` assigned one part to one channel and a
    General MIDI drum track is one part, so a kit landed on one voice and the
    other five sat there — and worse than idle, the hits that collided on that
    one voice were *dropped*: the example library's overworld theme wrote 96 drum
    notes and the cartridge played 64. A percussion part now takes a **pool**,
    and all 96 play.

    Three decisions shape it and each is a line that could have gone the other
    way. The allocation is **by drum class**, not round-robin over arrivals: a
    kick still ringing is never cut off by the hat on the next eighth, and
    round-robin would put consecutive kicks on different voices, which for
    *recordings* is flanging rather than depth. The two hats deliberately
    **share** a voice, because a closed hat choking a ringing open one is what
    the pedal on a real kit does — getting that out of the allocation is worth
    more than giving each its own. And a pool is built only from **dedicated**
    drum hardware, which is the line the existing suite caught: an FM voice will
    host a kit and `affinity` offers it at 6, but handing the kit every spare one
    would take six four-operator voices and six fitted patches for material a
    single noise generator serves — spending the machine downwards on the
    consoles this exists to spend it upwards on. A kit on a compromise host keeps
    its one channel. `interchangeable` draws the same line inside one `kind`: a
    YM2610's ADPCM-B is a `sample` voice like its ADPCM-A voices and is the only
    one on the chip with a pitch, so pooling it into the kit denied the
    arrangement its one pitched sample voice.

    Two other consoles have spare percussion hardware and gain the same way: a
    Nintendo DS has two noise generators, and a Game Boy Advance has its APU's
    and the mixer's recording of one. Every other console has exactly one, where
    the pool is a pool of one and the schedule is unchanged.

    **And what it exposed is now reported.** A hit dropped for colliding with a
    ringing one was *not counted anywhere*, which the "never lose a part
    silently" rule forbids — 32 notes vanished from that theme and nothing said
    so. The question it raised was a policy one rather than a technical one,
    because `Dropped` feeds `--strict`: is a choked hi-hat a build failure, or an
    `info` the way a merged voice is? **It is a failure.** A merge still plays
    the material on some voice; a choked hit does not sound at all, so it is a
    loss and `--strict` refuses it.

    Three consequences follow and each is deliberate. The drop carries
    `kind: "note"` rather than `"part"`, because the part still plays and only
    some of its hits went — so `--strict` counts parts and notes apart rather
    than calling thirty-two notes thirty-two parts. It has a diagnostic code of
    its own, `choked-note`, at `warning` rather than borrowing `merged-voice`'s
    `info`. And the collision is decided in `compile.ts` rather than in the plan,
    because whether two hits collide depends on the *driver's tick grid* — so
    `compileScript` returns its drops and the tournament merges them into the
    winning candidate's, which is the only plan they are true of.

    Nothing about a schedule changes: this is a report about what was already
    happening. A game build sets no `--strict`, so cartridges are unaffected —
    and the pool above is what makes the number fall rather than the reporting,
    which the Neo Geo demonstrates by dropping to zero.

    **The arranger's half of the first line is closed.** `@demake/audio` produces
    vibrato now, and it produces it the way the rest of this project reads a
    source: **MIDI states vibrato**, on controller 1, so the depth is read off
    the score rather than inferred from a programme or invented from an
    articulation. It is per *note*, because a wheel can swell across a phrase
    and a note takes the highest it reached while sounding. `score/midi.ts` keeps
    that one controller and discards the rest of the control-change bus, since
    volume, expression and pan are either the mixing desk's job or the arranger's
    own decision against the hardware.

    Waiting for §A4's transcription front end would have been the wrong way
    round. An MP3 is where vibrato has to be *inferred*; a MIDI is where it is
    already written down.

    The rate, the width and the delay are the demaker's, because the source does
    not state them — controller 76 exists for the rate and almost nothing writes
    it. The delay is the one that pays twice: a player places a note in tune and
    leans into it, and a delayed oscillator costs no pitch writes at all, so a
    schedule pays for vibrato only on notes long enough to have any.

    **The cost is what this section predicted.** A modulated held note is a pitch
    write per driver tick, so a track of long notes with the wheel at full is two
    to five times the register writes of the same track dry — 80 against 452 on a
    Game Boy. What makes that safe rather than merely measured is that it is
    opt-in by construction: a source that never touches the wheel produces
    byte-for-byte the schedule it always did, which is *every* MIDI in the
    example library, so this closed a line and re-baselined nothing.

    **And the Mega Drive spends its LFO**, which is what that cost was an
    argument for. A YM2612's LFO setting 1 is 5.56 Hz, within a tenth of a hertz
    of the rate the arranger states — so `binding/md.ts` declares its six FM
    voices in `ChipBinding.lfoChannels`, `compile.ts` leaves their pitch alone
    and states a depth instead, and the binding programs `$22` and the
    sensitivity nibble in `$B4`. The measured cost falls from **+122% to +4%**
    over a dry track. `$22` is written lazily rather than at boot, so a track
    with no modulation still writes exactly the registers it always did.

    Two things about the seam are worth keeping. The **delay applies to both
    routes**, so a chip that bends itself starts when one bent by the driver
    would — otherwise the same note is two different notes depending on the
    console. And `lfoChannels` belongs to the **binding** rather than to
    `AudioSpec`, because what it answers is "will this encoder do it in
    hardware", which is a decision about the register map.

    **The Neo Geo deliberately does not**, and it is the sharpest thing this
    section has to say about the two OPN parts. An OPNB is an OPN2 with the LFO
    *removed*: `ym2610.ts` refuses `$22` by design, because routing it through
    would offer a binding hardware the console does not own. Claiming it anyway
    is a silent failure of the worst kind — the binding stops the per-tick pitch
    writes, the chip ignores the registers, and the note comes out straight with
    nothing anywhere reporting a problem. It was written that way first and the
    chip model's own refusal is what caught it. So that console pays the full
    per-tick price (+154%), and `packages/audio/test/vibrato.test.ts` holds both
    halves: no LFO programmed there, *and* the pitch still moving.

    **What remains of the line is the HuC6280's LFO**, and it is a refusal
    rather than a gap. That chip has no oscillator: channel two *is* the
    modulator, so switching vibrato on costs a whole voice to modulate one
    other. On a six-voice console that is spending the machine downwards — the
    same reasoning this section already applies to the YM2610's SSG noise — and
    the per-tick route costs a schedule rather than a voice.

    The last two lines are doc 18's rather than doc 17's — a sample player wants
    a *sound* demaker pointed at it, not an arranger.
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
  Drive (140 KiB, on the 256 KiB board its size asks for), **on the Super
  Nintendo** — 128 KiB, a bank per scene — **on both Sega 8-bits**, where the
  unit is finer still: 128 KiB with a tick's individual steps paged through slot
  2 — **on all three Game Boys**, which is the same unit again on the hardest
  board in the set, **on the NES**, which is the same unit a third time and the
  only console that had to duplicate a table to manage it, **on the PC Engine**,
  which is the same unit a fourth time on the cheapest mapper in the set, and
  **on the WonderSwan Color**, which is the one family where the answer was not a
  mapper at all — every segment is mapped from reset, so what a game outgrows is
  a segment and the unit is a scene again. Every one is traced tick for tick
  against the interpreter by `rom.test.ts`.

  **Every one of the sixteen consoles that build games now builds this one**, and
  the last of them was out of *RAM* rather than out of cartridge:

  | Console | Walls it hit | Result |
  | --- | --- | --- |
  | ~~Game Boy / Color / Mega Duck~~ | ~~cartridge, then the fixed bank~~ | 128 KiB, of 8 MiB |
  | ~~Master System / Game Gear~~ | ~~cartridge~~ | 128 KiB, of 512 |
  | ~~NES~~ | ~~work RAM, page zero, then the fixed bank~~ | 256 KiB, of 256 |
  | ~~Super Nintendo~~ | ~~direct page, then cartridge~~ | 128 KiB, of 4 MiB |
  | ~~PC Engine~~ | ~~the 48 KiB window~~ | 256 KiB, of 1 MiB |
  | ~~Game Boy Advance / Nintendo DS~~ | ~~the literal pool~~ | 224 / 256 KiB |
  | ~~WonderSwan Color~~ | ~~the 64 KiB segment~~ | 512 KiB, spread over three |
  | ~~WonderSwan~~ | ~~work RAM, which no cartridge size can fix~~ | its heap in the board's save RAM |

  The ARM handhelds are in that list and were never a *cartridge* problem: a Game
  Boy Advance has thirty-two megabytes and a Nintendo DS four, so neither pages
  anything and neither will. What stopped `quest` there was the **literal pool** —
  a 32-bit constant is loaded PC-relative from a pool within 4 KiB, a backend
  flushes at safe points it chooses, and this game has a stretch of one rule body
  4160 bytes long. The assembler places a pool itself now when the next
  instruction would put a queued load out of reach (`asm/arm.ts` §rescuePool), so
  the guess is kept for placement and cannot fail.

  The NES had three walls where every other console had one or two, and the third
  was only ever visible once the first two were down — which is the argument for
  measuring rather than estimating, twice over. Its **work RAM** went first
  (MMC1's eight kilobytes at `$6000`), because a board with a second sixteen
  kilobytes of program is the same board that brings the RAM, so those are one
  decision. Its **page zero** went next and is `fastSpills` reaching a second
  console: almost nothing a 6502 backend allocates is dereferenced — the contact
  bitfields are read `$nnnn,x`, a temporary goes through `clamp32` — so a game
  refused for wanting 274 bytes of a 237-byte page was a game refused for wanting
  cheap addresses it did not need. What may *not* spill is a pointer, and there
  are exactly two: the tile walk's cursor and the audio driver's state, both of
  which walk memory through `($nn),y` and nothing else. `pin` is where that is
  said, and `Bump.tryTake`'s `keep` is what makes the two live together — a
  spilling request declines the last bytes of the page, because the pins are still
  to come and the order of these calls is the order of the addresses.

  The Super Nintendo's first wall is gone, and it went for a reason worth
  keeping: the direct page there is a pure size optimisation — `$nn` is two bytes
  where `$nnnn` is three, and the index registers are sixteen bits wide so
  `$nnnn,x` reaches all of bank zero — so nothing the backend allocates *has* to
  be in it, and a game that fills it should get a slightly larger program rather
  than a refusal. `MemoryPlan.fastSpills` says so and only that console's plan
  sets it; on a 6502 the same overrun stays fatal, because page zero is the only
  place a pointer can live. No game that fits moved by an address, because only a
  request the region cannot hold spills.

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
  it either — `SceneTick_1` alone is 22153 bytes — so on a 16 KiB-window console
  (the Game Boy, and the NES with UNROM or MMC1) the granularity has to go
  *below* a routine.

  **A tick's steps are the place, and they are small enough.** `TickSteps.boundary`
  is the seam: `emitTickSteps` names each step as it reaches it, and a backend
  that wants the cut says where "here" is. It is where the cut *has* to be, and
  for a reason rather than for convenience — a step boundary is the only point
  inside a tick at which nothing is live, because the steps hand work to each
  other through the entity records and the contact bitfield and never through a
  register. They have no choice: the interpreter they are written against has no
  registers. The Game Boy backend implements the hook as a label, which costs no
  bytes and makes a profile bucketed by symbol name the *step* rather than the
  whole tick (AGENTS.md §Profile before optimising). Quest's worst scene, in
  bytes of SM83:

  | Step | controls | levelRules | integrate | collisions | tileRules | edgeRules | camera |
  | --- | --- | --- | --- | --- | --- | --- | --- |
  | scene 1 | 129 | 1692 | 2168 | 7505 | **9694** | 592 | 373 |
  | scene 3 | 129 | 1692 | 1920 | 6081 | 8244 | 482 | 373 |

  Nine and a half kilobytes is the largest unit in the whole game, against a
  sixteen-kilobyte window — so **cutting a tick at its steps is enough**, and the
  granularity does not have to go lower. `tick-steps.test.ts` pins both halves of
  that: the boundaries exist in doc 14's order for every scene, and no step of
  any example reaches a window.

  **What is left is the fixed bank, and that is the real blocker now.** Whatever
  the scenes cost, some of the cartridge cannot move: the boot, the main loop, the
  shared helpers, the audio driver (which an interrupt enters, so it has to be
  mapped whatever the game was doing), and every table an always-mapped address
  reaches. For quest on the Game Boy, in bytes:

  | boot + shared | helpers + audio code | level data | defaults | audio data | backdrops | tile bank |
  | --- | --- | --- | --- | --- | --- | --- |
  | 2267 | 6480 | 5748 | 1716 | 13556 | 367 | 2960 |

  That is 29.8 KiB of things that want to be always mapped, against a Game Boy's
  **16 KiB** fixed bank — and 30-odd against a Sega 8-bit's 32, which is the
  fixed half of slots 0 and 1 and leaves almost nothing spare. So neither 8-bit
  console gets there by moving code alone. **On the Game Boy three of those rows
  became paged data units**, and what decided which three is not their size but
  who reads them:

  - **The tile art** (2960) is uploaded to video RAM by the boot and never read
    again, so it costs two instructions to page and nothing else at all. It is
    the Sega's move one console along.
  - **The audio schedules** (13556, the biggest single item) are read by a driver
    an *interrupt* enters, so paging them means the driver saving the current
    bank, mapping its own, and putting the old one back — which needs the running
    bank shadowed in RAM, because MBC5's register cannot be read. That shadow is
    the one thing this console needs that the Sega does not.
  - **The instance defaults** (1716) are read by two things that cannot share a
    copy: the boot restore wants every entity's at once, and each scene's reset
    wants its own — and a reset is itself a paged routine, so it cannot read a
    table in another bank. So the banked build makes **two**: the whole table as
    a unit the boot pages in, and each scene's own riding in the bank its reset
    landed in. The duplicate costs paged bytes, which a banked cartridge has, and
    buys back fixed ones, which is what it is short of.

  **The level data stayed put** (5748), which is the one of the four the estimate
  had wrong: it is read by more than one step of a scene — the collisions, the
  tile rules and the render — so paging it means duplicating it into each bank
  whose steps read it, at about 1.4 KiB a level a bank. It never had to be:
  moving the other three brought quest's fixed bank to **15973 bytes of 16384**,
  and 411 bytes of headroom is a tight cartridge rather than a blocked one. The
  duplication is what is left to reach for if a later game needs it.

  The Sega 8-bits need none of it, because 32 KiB fixed holds the lot — they page
  the tile art alone, and for room rather than out of necessity.

  The Super Nintendo does not have that problem, because a LoROM bank is 32 KiB
  and its largest scene is 19766 bytes. So the ordering that followed from the
  measurement was: **the Super Nintendo first**, where a bank per scene fits, the
  cartridge needs no controller at all (LoROM past bank 1 is address decoding),
  and the 65816 has `jsl`/`rtl` — a real far call, where the other three CPUs
  need a trampoline in the fixed bank. **That one is done** (§Super Nintendo
  below).

  The order for the rest follows from the fixed-bank numbers rather than from the
  window: **the Sega 8-bits next**, because slots 0 and 1 are 32 KiB of *fixed*
  space and hold everything that cannot move, its core already implements the
  mapper (`@demake/sms` decodes `$FFFC`–`$FFFF` out of the RAM mirror and pages
  all three slots), and the header hole its fixed region carries is already
  placed a block at a time. **Then the Game Boy**, which has the controller and
  the core but only 16 KiB of fixed bank, so it needed the paging jobs above
  first — both are done and so is it. Then the NES, which needs a mapper in
  `@demake/nes` as well — and which is the one console where the *RAM* wall comes
  first, so MMC1's `$6000` work RAM is worth doing on its own before a byte of
  code moves.

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

    **And it is banked.** What decided this console rather than the Game Boy is
    not the window — 16 KiB, the same — but the *fixed* half: slots 0 and 1 come
    up holding banks 0 and 1 and a demade cartridge never moves them, so 32 KiB
    holds everything that cannot be paged and a Game Boy's 16 holds about half of
    it. Three of the four pieces were already here: `@demake/sms` decodes
    `$FFFC`–`$FFFF` out of the RAM mirror and pages all three slots, so the core
    needed *nothing*; the header hole at `$7FF0` is inside the fixed half and is
    already placed a block at a time; and the seam a tick is cut at exists.

    **The unit is a tick step**, because a scene will not fit: a scene's tick is
    now a run of calls in the fixed half that pages each of its seven steps in
    turn, plus its reset, camera and render, and the largest piece the library
    produces is nine and a half kilobytes of the sixteen. A step that will not fit
    a window is refused by name, which is what `sms-flat48.test.ts`'s
    thirty-six-rock game now hits — one scene's collisions, unrolled, at twenty
    kilobytes.

    What stays below is everything an always-mapped address reaches: the boot, the
    vectors, the shared helpers, the audio driver **and its schedules** (an
    interrupt enters it, so it has to be mapped whatever the game was doing), the
    level tables and the instance defaults. The tile art goes *up* instead,
    because the boot uploads it once and nothing reads it again — seven kilobytes
    of the thirty-two that cannot move, bought back for two instructions.

    Three things follow and each is what makes it cheap. **Nothing saves or
    restores the bank**: only the fixed half enters a paged routine and only a
    paged routine cares what the window holds, so a caller writes the bank it
    wants and never puts one back. **A paged routine calls and reads downwards**,
    so not one byte of the value layer, the rule bodies or the tile walk changed.
    And **`AsmZ80.section` moves no bytes**, so the paged banks are emitted first
    and the fixed half last — helpers are pulled by whatever calls them, so
    `ctx.finish()` has to be last — and `sms.ts` copies each bank into place.

    `SMS_ROM_SIZES` runs 32 KiB to 512 KiB and the build takes the smallest board
    that holds the banks it opened. Every cartridge that fitted a flat board
    before is byte-identical, because a game that fits pages nothing and its tick
    stays one run of code.
  - **Game Boy** — **done, and it is the hardest board in the set.**
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

    **And the emitter pages it.** The unit is the Sega's — a tick's individual
    steps, plus each scene's reset, camera and render — because a scene will not
    fit a sixteen-kilobyte window and the largest single step the library
    produces is nine and a half. What is this console's rather than the Sega's
    restated is everything below.

    **The fixed bank is half the size**, so three blocks of *data* are paged units
    as well: the tile art, the packed audio schedules, and the instance defaults
    in two copies (§What is left is the fixed bank). Quest's bank zero comes to
    15973 bytes of 16384 — 411 spare, which is the tightest thing in the project
    and is the number to watch when this game grows.

    **The driver saves and restores the bank**, which is the one mechanism the
    Sega has no need for: this console's audio is entered by a *timer interrupt*,
    so a tick can arrive with any bank at all in the window. The handler reads the
    running bank out of a RAM shadow — MBC5's register is write-only — pages the
    schedules, ticks, and puts the old one back. Nearly half of every game tick is
    spent running from the window, so a handler that skipped the restore would
    return into another bank's instructions at the same offset and hang. That is
    invisible to a register diff, because a driver that never restores leaves its
    own bank mapped for ever and goes on playing perfectly while the game around
    it is dead — so `rom.test.ts`'s quest case is handed this game's **audio**,
    which is what puts an interrupt there to arrive at all, and
    `_audio-battery.ts`'s `bankedAudio` owns the other half: that a schedule read
    through a window is still performed tick for tick.

    **The scene dispatches page rather than jump.** A dispatch tails into a
    scene's routine, so `ctx.jumpUnit` writes the bank and jumps and the routine's
    own `ret` still lands back at whatever called the dispatch. Unbanked it is a
    bare `jp` and the bytes are what they always were: every cartridge that fitted
    32 KiB before is byte-identical, all twenty-one of them across the three
    machines in this family.

    `GB_ROM_SIZES` runs 32 KiB to 8 MiB, the build takes the smallest board that
    holds the banks it opened, and `free` is measured against the largest — so a
    game that grows never looks like a game with more room (AGENTS.md §Iron
    rules). Quest takes 128 KiB.
  - **NES** — **done, and it is the only console that had to duplicate a table.**
    This was the only family that needed a *new* mapper in the core as
    well, and it has one: `@demake/nes` implements **MMC1** — sixteen kilobytes
    switched at `$8000`, sixteen fixed at `$C000`, and the eight of cartridge RAM
    at `$6000` — pinned against the hardware's own rules by `mmc1.test.ts`,
    because the cartridge and the core are both ours and a mapper that is wrong
    and consistent would pass everything.

    It is also the one console with **three** walls rather than two, and neither
    of the last two was in this table until the one before it came down:

    | Wall | Wants | Has | |
    | --- | --- | --- | --- |
    | work RAM | 1288 B | 1280 B | the `$6000` RAM |
    | page zero | 274 B | 237 B | spilling, with two pins |
    | fixed bank | 16630 B | 16384 B | the level tables, copied per bank |

    **Page zero** is the one nothing had noticed, because the RAM wall hides it:
    the entities alone overrun the console's two kilobytes, so a build never got
    far enough to ask. What wants it is mostly the two contact bitfields — 71
    bytes each, and read with `$nnnn,x` — so they are exactly what should move.
    `fastSpills` now applies to this family too, and what may *not* move goes
    through `pin`. There are **two** pins and the second was found by building:
    the tile walk's cursor is `($nn),y`, and so is the audio driver's state,
    because a stream player walks its packed data through a pointer. A pointer
    that would not fit is refused by name rather than assembling an instruction
    that reads the wrong two bytes (`layout.ts` §fastSpills).

    The two rules also had to be taught to live together, which is `Bump.tryTake`'s
    `keep`. A spilling request that emptied the page would leave a *pinned* one
    after it with nowhere to go — and serving the pins first is not open to us,
    because the order of these calls is the order of the addresses and every game
    that fits has to keep the map it had. So a request that may spill declines the
    last bytes of the region, which are the pins still to come. Without it the
    build refused quest for wanting 274 bytes of a 237-byte page *after* the
    spilling was working, which reads like the mechanism not being there at all.

    **The emitter pages**, on the Game Boy's unit with the halves the other way
    up: a tick's individual steps plus each scene's reset, camera and render, with
    the fixed half at the *top* because that is where the vectors are and what
    MMC1 mode 3 leaves in place. The packed audio schedules and the instance
    defaults are paged data units, exactly as they are on a Game Boy — and the
    tile art is *not*, because on this console characters are a separate ROM the
    PPU addresses directly rather than bytes in the program, which is the one
    thing that makes this cartridge's fixed half easier than a Game Boy's.

    **And the level tables are copied per bank**, which is the thing no other
    console needed. A Game Boy could leave them mapped and this cannot: quest's
    fixed half came to 16630 bytes, 246 over. So each bank that reads a level
    carries its own copy of that level's grid, its legend tables, its `TileAt`
    routine and its per-rule tile tables — 1575 to 2997 bytes a level — because
    more than one step of a scene reads them and a paged routine cannot reach a
    table in another bank. What made it a change rather than a piece of work is
    that every reader already takes a `LevelData` and reads its labels off it, so
    one `suffix` field and a `levelCopy` are the whole mechanism and no emitter
    has to know that copies exist (`shape.ts` §LevelData.suffix). The planner is
    where it shows: a bank is charged for the copies its units drag in as well as
    for the units, so "does this fit" is a question about the pair.

    That took the fixed half to **8109 bytes of 16384**, which is the roomiest of
    the three 16 KiB-window consoles rather than the tightest — the level tables
    really were the whole of the problem. quest ships on a 256 KiB board.

    **A mapper write is ten instructions here**, which no other console in the set
    can say: MMC1's register is *serial*, five stores of one bit with the
    destination decided by the last store's address, so `ctx.enter` builds the
    value with `lsr` between the stores. And it is never emitted inside an
    interrupt handler — a sequence broken halfway leaves the register holding bits
    from two different values and nothing can put it back. That is affordable only
    because this console already counts its audio tick in the NMI and *performs*
    it in the main loop (`nes/emit.ts` §emitNmi), so the handler touches nothing
    but the frame upload and a counter, both of which stay in the fixed half.
  - **Super Nintendo** — **done.** A LoROM bank is 32 KiB and quest's largest
    scene is nineteen and a half, so a bank per scene fits without the tick ever
    being split, and this console needs no controller at all: banks past the
    first are address decoding, so `SNES_ROM_SIZES` is every power of two up to
    the four megabytes LoROM stops at and the build takes the smallest that holds
    the banks it opened.

    What a scene's routines cost to reach from another bank is one instruction
    each way — `jsl` and `rtl` rather than `jsr` and `rts`, four bytes instead of
    three — and the **switch is all-or-nothing**, because which of `rts` and
    `rtl` a routine ends with has to match how every caller reaches it and "which
    callers share this routine's bank" is not a question an emitter can answer
    while it is still deciding where things go. So a game that fits one bank is
    assembled exactly as it always was and its cartridge is byte-identical, which
    `snes-banked.test.ts` asserts by reading the opcode at `TickDone` on both
    kinds of build.

    Three things made it cheap. **All the data stays in bank zero** — a level's
    grid, a packed backdrop, the instance defaults, the constant pool — so with
    the data bank register at zero a scene in bank four reads its own level with
    the same absolute instruction it used when it was in bank zero itself, and not
    one data access changed. **`Asm65816.section` moves no bytes**: it changes
    what an address *means*, so a label carries its bank for `jsl` and still means
    its low sixteen bits for everything else. And **the extra banks are emitted
    first**, bank zero last, because helpers are pulled by whatever code calls
    them and `ctx.finish()` has to be the last thing to run — `snes.ts` copies
    each 32 KiB chunk to the bank the plan named, which is a copy per bank and no
    more.

    Its first wall went earlier and for its own reason: the direct page there is a
    size optimisation and not a capability, so overrunning it costs a game bytes
    rather than the build (§the table above), and quest was one byte over. What is
    left of the RAM story is an opportunity rather than a wall — the plan stops at
    the 8 KiB mirrored into bank zero, and the other 120 KiB is reachable with
    long addressing or a data-bank switch. And quest's *music* is still cut on
    this console, which is the honest answer rather than a gap: four tracks and
    eight effects pack to 103912 bytes and the sound processor has 64 KiB of its
    own, so no cartridge size can hold it. The bank the image is uploaded from is
    elastic now too — two banks, which is as far as the upload's `long,X`
    reaches — so what refuses it is the S-SMP's memory and nothing else.
  - **Mega Drive** — nothing to do but grow the image, and that is now what
    happens: `MD_ROM_SIZES` runs 128 KiB to 4 MiB and the build takes the
    smallest board that holds the game. Past 4 MiB it wants paging through
    `$A130F1`, and says so.
  - **PC Engine** — **done**, and the mapper cost least of any in the set. It is
    *in the CPU*, so a switch is `lda` and `tam` against MMC1's five serial
    stores; the window is two of this mapper's 8 KiB pages, because one page is
    smaller than a tick's largest step. What stays mapped is `$8000`–`$FFFF`:
    twenty-four kilobytes of program and the boot bank, which is half again what
    a Game Boy or an NES keeps — but not enough for a game's data too, so the
    character bank and the packed schedules are paged units. Both cost one
    `enter` and no more, and the second is why: this console performs its audio
    ticks in the **main loop** rather than in the interrupt that counts them, so
    unlike a Game Boy's there is no bank to save and put back. quest ships on a
    256 KiB HuCard with 26 KiB of fixed half used.
  - **WonderSwan Color** — **done, and it was never a mapper problem.** Segments
    `$8`–`$F` are all cartridge and all mapped at once: `BANK_LINEAR` comes up
    all-ones, so a 512 KiB image is entirely addressable from reset and a demade
    cartridge never writes a banking register (`@demake/wsc` §romAddress). What a
    game outgrows is a **segment** — 64 KiB, against quest's 77 of code alone — so
    this console takes the Super Nintendo's answer rather than the Sega's: a
    **scene per segment**, reached by `call far` and returned from by `retf`,
    all-or-nothing because the two pairs push different amounts of stack.

    What is this console's rather than the Super Nintendo's is the **`cs:`
    override**. A cartridge table is read through the code segment and a block
    copy takes `DS` from `CS`, so a routine in segment `$E` reads segment `$E`'s
    tables or nothing. There is no spare segment register to point at the data
    instead: this CPU has four and a demade cartridge already spends `DS`, `ES`
    and `SS` on RAM — `ES` looks free and is not, because it is the destination of
    the `rep movsw` that stages every collision box, which is the hottest routine
    in the tick. So **each segment carries the tables its own code reads**: the
    level grids, the instance defaults, the backdrops and the constant pool. That
    is the NES's duplication reached by completely different hardware, and it is
    why `CtxBase.emitConstants` exists.

    Three things went wrong building it and each is worth knowing, because each
    produced a cartridge that boots. A **segment register counts paragraphs**, so
    the bank below `$E000` is `$D000` and not `$DFFF` — off by that and a dispatch
    lands sixteen bytes into the right bank. The **groups go into the image back
    to front**, because the emitter walks segments downwards and a file is
    addressed upwards. And a scene handed the **shared** level tables reads them
    out of its own segment, which is not a crash but a tile walk that never
    terminates.

    `wsc-rom.test.ts` follows every far jump in the finished cartridge, and that
    is not belt and braces: the example tape enters one level, a level's routines
    are all in the first paged segment, and a scene in the second is compiled,
    placed and never executed by any test that plays the game. The mutation that
    put a dispatch in the wrong segment passed the trace and failed that.
  - **WonderSwan (mono)** — **done, and the only console here whose wall was work
    RAM.** Two kilobytes of heap for a game that wants six, on a machine with
    sixteen of which the tile bank is the top half:

    | region | bytes | |
    | --- | --- | --- |
    | system + heap | 832 + 2048 | `$0000`–`$0B40` |
    | shadow, object table | 512 + 512 | `$0C00`–`$1000` |
    | two screen maps | 2048 + 2048 | `$1000`–`$2000` |
    | tile bank | 8192 | `$2000`–`$3FFF` |

    No cartridge size fixes that, and the two things that might were measured
    rather than assumed. Letting the heap run to the object shadow buys 192
    bytes. Letting it take the **unused tail of the tile bank** buys 128, because
    quest uses 504 of this machine's 512 tiles — and it would also need the art
    bound before the layout is planned, which is `backend.ts`'s shared order.

    So the answer is the hardware's own: **the cartridge's save RAM at segment
    `$1`**, which is the NES's `$6000` story with a different port. It is the
    elastic-board rule reaching the *RAM* rather than the program — a board brings
    what the game needs, and the footer declares the smallest of the five sizes it
    can name that holds it (`asm/ws-cart.ts` §WS_SAVE_SIZES). Nothing is saved
    between sessions and nothing has to be: what a battery buys a real game is a
    save file, and what it buys this one is somewhere to compute.

    **`DS` and `ES` are the heap; `SS` is the console.** That is what makes it a
    memory *plan* after all rather than a memory model. An unprefixed operand
    still means the heap, so the 16.16 value layer, the expression compiler, the
    rule bodies and the tile walk did not change by one prefix; what moves is the
    six operands that are the display's rather than the allocator's — two screen
    maps, the object shadow, the object table and the tile bank — and each takes
    an `ss:` override, because `SS` is the segment register a demade cartridge
    already points at the console's memory for its stack and never moves. A game
    that fits emits no override and no segment load and is byte-identical.

    **The heap goes whole or not at all**, which is why it is a second
    `MemoryPlan` and not the NES's `heapSpill`. An override reaches a memory
    operand and even a `movs`'s *source*; its destination is `ES`, and no prefix
    changes that — so a copy between two heap addresses cannot have one end in
    each memory, and which one "the heap" means has to be a single answer for the
    whole program. That is the segment banking's own shape reached by a different
    route, and `Backend.memoryUpgrade` is the one place a console is offered the
    second plan.

    Three things went wrong building it and each produced a cartridge that boots.
    A `rep movs` **into the heap and one into the console's memory look identical
    in an emitter** — `emitRomCopy` copies the tile bank *and* every entity's
    declared values — so bracketing both put every object in the game at the
    right offset of the wrong segment: a game whose every entity is zero. The
    **trace reader** takes the allocator's addresses, which are now offsets from a
    segment, so a reader that took them for physical ones reported the interrupt
    vectors as a game's state. And the **audio driver's waveform copy** is the one
    address in it that is not the game's to choose, so it needs `ES` back on the
    console for the length of the copy — without which every channel plays
    sixty-four bytes nothing wrote, on a cartridge that traces perfectly and
    performs every register write in the schedule.

    Finding the third is what found a bug the *segment banking* had shipped: on a
    banked cartridge every scene's backdrop was unpacked from the wrong segment.
    `BlitBackdrop` is a pulled helper, so it is in the fixed segment and its `cs:`
    means the fixed segment however the scene that called it got there — and the
    backdrop was being copied per segment like a level grid. The helper read the
    fixed segment at the paged copy's offset, which is `$FF` padding, and `$FF` is
    a run control byte: it unpacked runs of `$FFFF` upward through the screen maps
    and over the stack until the return address was gone. The rule was right and
    only its application was wrong — a table goes in the segment of the code that
    reads it, and a backdrop's reader is not the scene.

  **The sizing half of that mechanism is built** (doc 14 §Elastic cartridges).
  Every console's cartridge wrapper declares the boards it came on and every
  backend takes the smallest that fits, in both directions: the NES gained
  NROM-128, the Mega Drive dropped its floor from half a megabyte to one megabit,
  and a silent Super Nintendo cartridge is two banks rather than four. **On every
  family that grows at all, that is now the whole story rather than half of it** —
  a Mega Drive grows to four megabytes, a Super Nintendo opens a bank per scene
  and grows the same way, a Sega 8-bit, a Game Boy, an NES and a PC Engine page a
  tick's steps and grow to 512 KiB, 8 MiB, 256 KiB and 1 MiB, and a WonderSwan
  Color opens a segment per scene inside the one board its header can describe.
  The rest were never a cartridge problem: the Neo Geo, the Neo Geo Pocket Color,
  the Virtual Boy and both ARM handhelds hold `quest` on a flat image, and the
  mono WonderSwan's board brings **RAM** rather than more of itself. Nothing in
  the set is refused for its size any more short of the largest board its
  hardware shipped on. What the sizing buys on its own is the honest artifact — a
  game gets the board a game that size shipped on rather than a constant somebody
  picked once.

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
