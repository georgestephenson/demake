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

| Demaker               | Docs   | State                                                                         |
| --------------------- | ------ | ----------------------------------------------------------------------------- |
| art (images)          | 03–06  | working, seventeen consoles proven on hardware                                |
| game (Demotic `.dmt`) | 14, 15 | language, interpreter, tests, preview — and playable ROMs on sixteen consoles |
| music (`arrange`)     | 16, 17 | MIDI → chip music, eighteen consoles — and every game console plays it        |
| sound (`sfx`)         | 16, 18 | WAV → chip effects, eighteen consoles — same driver, same proof               |

The four are not four tools that share a repo any more: a `.dmt` says
`music theme.mid` and `sound bounce.wav on ball hits paddle`, and `demake build`
demakes the art, the track and the effects into one cartridge — 32 KiB for a game
that fits one, and the smallest banked board its console shipped for a game that
does not (doc 14 §Sound, doc 16 §Two streams, one clock).

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
  `neogeo`, `sg1000`, `gba`, `nds`, `pce`, `ws`, `wsc`, `ngpc` and `vb`
  families, reached via an exact-path detector, a manifest sidecar, or implicit
  `prep`.
- **`--format rom`** builds bootable ROMs for GB + GBC + **Mega Duck** (RGBDS,
  the last of the three through a generated machine include rather than a
  harness of its own), NES (cc65 NROM), SMS + GG + SG-1000 (WLA-DX / Z80), SNES
  (WLA-DX / 65816, LoROM), PC Engine (WLA-DX / HuC6280, 64 KiB HuCard),
  MD/Genesis and the **Neo Geo** (GNU m68k binutils — one processor, two
  families), GBA + NDS (GNU ARM binutils), and **both WonderSwans** (NASM — the
  V30MZ is an 8086-compatible core). Two families need no assembler at all,
  because no distribution ships one for their processor: the **Virtual Boy** and
  the **Neo Geo Pocket Color** emit their display programs with `core`'s own
  V810 and TLCS-900/H encoders — the same ones `demake build` compiles a game
  with — and a third-party emulator is what keeps that honest.
  The z80/6502/65816/huc6280 assemblers are pinned source builds; the m68k and
  ARM binutils and NASM are stock distro packages (apt, main archive) since
  well-tested ones ship there — all via `pnpm toolchains`, no Docker, and no
  devkitARM/ndstool (demake packs the GBA, NDS, WonderSwan, Neo Geo Pocket and
  `.neo` cartridge headers itself).
- **Pixel-perfect emulator E2E** for every console that builds a display ROM —
  GB/GBC (SameBoy), the **Mega Duck** (SameDuck, SameBoy's own fork of that
  console, whose capturer is the Game Boy's source compiled a second time), and
  NES + SMS + GG + MD + SG-1000 + SNES + GBA + NDS + PCE + both WonderSwans +
  NGPC + Neo Geo + Virtual Boy (libretro cores via one generic
  `emu-harness/libretro/` runner) — all marching through the same shared
  extensive image battery (`packages/cli/test/_emu-battery.ts`).

Phase 5 then opened Tier 2 with the **PC Engine** and the **WonderSwan Color**,
both riding that same loop end to end (`wla-huc6280` on the existing WLA-DX
build and beetle-pce-fast; NASM and beetle-wswan). Doc 13 §Phase 5 records what
blocks each remaining Tier 2 console.

**And the mono WonderSwan demakes art now**, which took a fit path rather than a
toolchain. That console's palette has a level of indirection nothing else in the
matrix has: a tile is 2bpp, a cell names one of sixteen four-entry palettes, and
each entry is a three-bit index into a **shared pool of eight shades** — itself
chosen from the sixteen levels the panel can show. So a fit chooses four things
where `fit-mono.ts` chooses none (the pool, the shared backdrop, each palette,
each cell), and `pipeline/fit-mono-tiled.ts` is where. What makes it unlike
`fit-tiled.ts` is that the problem is **small and discrete**: once the pool
exists there are exactly seventy quartets a cell could be given, so the per-cell
question is answered by evaluating all of them rather than by clustering toward
one — exact rather than nearly right, deterministic, and cheaper than a single
k-means restart. `E_SHADE_POOL` is the compliance rule that keeps the pool a
_pool_, and it is checked rather than assumed because a fit that reached for a
ninth level would otherwise be silently truncated.

Phase 7+ then opened the **Demotic backend**: `demake build` _compiles_ a `.dmt`
into a real Game Boy cartridge — 32 KiB and mapper-less for a game that fits,
MBC5 with its tick's steps paged for one that does not — SM83 machine code
written for that game, with the art it names demade by the image pipeline on the
way, and the web app plays it in the page. There is no fixed engine and nothing is patched: the
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
LoROM cartridge — 128 KiB with its music in it, 64 without — 65816 machine code
written for the game, a Mode 1
background demade into 4bpp tiles across seven sixteen-colour sub-palettes, and
tile art in a _second cartridge bank_ that no instruction ever addresses because
it reaches video RAM by DMA — and the whole example library traces identically
there too, in the same battery, at the same one frame per tick. The page plays it
in `@demake/snes`, one of the eight self-hosted cores.

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

**And it builds for a Mega Drive.** `demake build -c md` produces a real
cartridge — one megabit for every game in the library, which is the smallest
board this console came on — 68000 machine code written for the game, the art
demade into a
1408-tile bank across three of the VDP's four sub-palettes — and the whole
example library traces identically there, in the same battery, at the same one
frame per tick. This is the first 16-bit console in the set and the first
big-endian one, and both facts reach further than the emitter.

The value layer is where the machine shows. **A 16.16 value is a register
here**: `move.l`, `add.l`, `sub.l`, `neg.l`, `asr.l` and `cmp.l` each do in one
instruction what the Z80 does in four and the 6502 in eight, and `cmp.l` sets a
signed condition rather than leaving one to be synthesised — so
`codegen/md/val.ts` is a quarter the size of the Sega's, and the only two
routines this console pulls in are the two the hardware genuinely lacks. Neither
is a bit loop: the multiply assembles four `mulu.w` products into a 64-bit one
and the divide's fast path for a whole-cell divisor is two `divu.w` instructions,
which is what makes an object whose _speed_ changes affordable here.

The renderer is easier for exactly one reason: **the plane is bigger than the
screen**. Sixty-four cells by thirty-two against a forty-by-twenty-eight window,
so a scrolling scene paints its leading edge twenty-four columns off the
right-hand side and has no seam to hide — the whole masking mechanism the Master
System needs is absent, and both wraps are powers of two.

**And it has sound — all ten voices of it.** This is the first console here with
_two_ sound chips and the first with FM: a YM2612 at `$A04000` and an SN76489 at
`$C00011`, arranged against as one instrument, because that is what they are on
the board. `@demake/chip` models the OPN2 in full — six four-operator voices,
eight algorithms, the hardware's own log-sine and exponential ROM tables,
envelopes with key scaling, detune, feedback, per-voice stereo and the channel-6
DAC — and it is integer and table-driven throughout, so a render is reproducible
sample for sample.

**Timbre is _searched_ here, not selected** (`binding/fm-patch.ts`, doc 17 §Stage
3). Every other console offers a fixed palette — a Game Boy pulse has four duties
and that is the whole choice — but an FM voice is thirty-odd register bits, far
too large a space to pick from a list. So a candidate patch is _played on the chip
and measured_, hardware-in-the-loop on the sound demaker's precedent: where its
energy sits, how fast it arrives, how much is left after half a second. What the
part asks for is read off the source — the General MIDI family it named, and the
articulation it is actually played with, because a source labelled "strings"
playing staccato sixteenths is not asking for a slow swell.

The **PSG half needed no change at all**: the same chip at the same master-clock
÷15, in a frame of 262 lines of 228 chip cycles, so `mdAudio` and `smsAudio`
reduce to the same rational and `psgBinding` is called rather than reimplemented.

What the driver (`rom/md-driver.ts`, `md-game.ts`, `md-chips.ts`) had to learn is
what having two chips costs, and the answer is: one byte. The packed register byte
already existed and now says which of five destinations a write goes to — the FM
chip's four consecutive bus addresses, or the PSG — so the write loop is an
indexed store with one comparison in front of it. Two other things are this
machine's: a move sets the flags, so one `move.b (a0)+,d0` answers both of the
dispatch's questions where the Z80 needs `or a` then `bit 7,a`; and a stream
pointer is a **longword**, because the packed data is anywhere in half a megabyte,
which is also why the tables start on an even address.

**Ten voices against a four-bit channel field**, and they do not have to fit. What
preemption asks is whether an _effect_ may be using a voice, so only the voices
effects were placed on are numbered and everything else tags zero — which means
the FM half of a track plays _through_ a sound effect instead of ducking for it.
That is better than any four-voice console can manage, and it is the hardware's
doing rather than the driver's.

**The chip model is the whole chip**, and the three things that were stored and
inert are the reason to say so. The LFO's _pitch_ modulation is applied to the
F-number rather than to the increment, which is what makes one depth the same
interval in every octave; SSG-EG runs the envelope four times as fast, stops it
at half attenuation and then holds, folds or re-attacks it; and channel 3 can
hold four F-numbers, which are **not** in slot order — `$A9`, `$AA`, `$A8` and
the channel's own feed S1 to S4 — with a timer-driven key-on riding on top of
the same mode bits. None of the three is reachable through a register `md.ts`
writes, so closing them changed no cartridge's audio by a byte; the point of
doing it first is that a binding reaching for one now gets the hardware rather
than a shrug (§Iron rules).

Two things it still does not do, and both are deliberate rather than gaps: the
bus's **busy flag** is always clear, which is the honest answer for a model with
no bus timing, and the **discrete chip's nine-bit operator output** is not
distinguished from the later ASIC's — a difference between two _boards_, of
exactly the kind `mix()` already takes per-chip gains for.

**And it builds for a second machine.** `demake build -c nes` produces a real
NROM cartridge — 6502 machine code written for the game, its art demade for a
fixed master palette and 16×16 attribute cells — and every game in the example
library traces identically there too, in the same battery, at the same one frame
per tick. What the second console changed is the shape of the first: compiling a
Demotic program is now an **interface** (`codegen/backend.ts`) that a console
implements, and what a program _means_ is shared (`codegen/shape.ts`), so the
only thing a backend owns is its instruction set.

**And it builds for a Nintendo DS, for the price of a description.**
`demake build -c nds` produces a real `.nds` cartridge — the _same ARM machine
code_ as a Game Boy Advance build, on a screen a third bigger — and the whole
example library traces identically there, in the same battery, at the same one
frame per tick. It is not a seventh backend: a DS's 2D engine A **is** a Game Boy
Advance's, at the same register offsets with the same screen entries and the same
character formats, so this is a _variant_ on the Mega Duck's terms and what it
added is `codegen/gba/machine.ts` — five entries and not one instruction.

Those five are worth knowing, because each is a way a cartridge can be perfect
and dark. **The program is copied rather than run**: there is no cartridge in the
address space at all, so the header is a region in front of the image instead of
the first 192 bytes of it, and the limit on a build is the megabyte before its
own heap rather than a bus. **A video RAM bank has to be pointed somewhere**
before anything is uploaded into it, and background and object characters are two
banks rather than one array with the objects on top. **`DISPCNT` is a word here**,
and the field that decides whether the engine's output reaches the screen at all
is in the half a halfword store never writes. **The window is 32×24**, so a build
that kept the other machine's would leave two columns and four rows of every
scene unpainted. And **the loop watches the beam**, because this machine's
interrupt vector lives inside data TCM and its base is a CP15 setting rather than
an address — a description this project would have to get exactly right for a
gain of nothing, since the main loop is what waits either way.

`@demake/nds` is the seventh owned core, and it is the only one that is _two_
processors: the ARM9 is `@demake/gba`'s `Arm7` and so is the 2D engine, because on
everything a demade game touches they are the same processor and the same engine,
and beside them is `arm7.ts` — the second processor's whole world, because this
console's sound channels answer it alone.

**And it has sound, on the other side of a bus the game cannot cross.**
`demake build -c nds` emits _two_ programs: ARM for the game, and an ARM7 driver
(`packages/audio/src/rom/nds-driver.ts`, `nds-game.ts`) that is simply **the
cartridge's other binary**. A `.nds` names two of them and the loader copies both
into the four megabytes they share, so unlike the Super Nintendo's there is no
upload, no handshake and no boot protocol — the driver is running before the
game's first frame, and asking for a track is one `strb` to ordinary main RAM.
Three things follow and none is true of any other console here. The **clock is a
hardware tally**: timer 0 reloads at the driver rate and timer 1 counts its
overflows, so how many ticks have happened is a register the driver _reads_ rather
than a flag it must catch, no interrupt is involved anywhere in this cartridge's
sound, and a tick cannot be lost by a driver that was busy. **Nothing on the chip
is shared**, so no merge routine is emitted at all — panning is a byte per
channel, enabling is the channel's own start bit, and there is no key-on pulse;
the widest palette in the set and the narrowest (a Master System's) reach the same
answer for opposite reasons. And **sixteen channels against a four-bit run field**
do not have to fit, on the Mega Drive's terms: only the channels an effect was
placed on are numbered, so fourteen voices of a track play straight _through_ a
sound effect.

The ARM stream player moved when the second ARM console arrived, and that is the
rule rather than a tidy-up: `packages/audio/src/rom/arm-player.ts` is the walk
over packed data, and it belongs to the **processor** — the third thing in that
directory that is nobody's console, beside `shared.ts` (nobody's CPU) and `psg.ts`
(one chip's). What each console still owns is `AudioWrite` and its hardware.

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
a bit is also how a channel is silenced. `packages/demotic/test/_audio-battery.ts`
runs its whole battery on every machine with a driver, tick for tick, with no
tolerance.

**And the page plays it, with sound.** The console selector in the web app's game
section changes the _cartridge_: pick NES and the browser compiles 6502, demakes
the art for that machine and boots the result in `@demake/nes` — byte-identical
to `demake build -c nes`, pinned by `determinism.spec.ts` on every console with a
backend (doc 07 §Playing the real ROM in the page) — and the sound button plays
whichever chip the running core has, through the same `StreamSink`. Every console
with a backend now has one — the Mega Drive included, and the Game Boy Advance,
whose _second_ device is a pair of converters rather than a chip — so the only
thing that can take the button away is a browser that will not give the page an
`AudioContext`.

**And the ARM handhelds are started.** `core/src/asm/arm.ts` is the sixth
encoder and the first that buys three processors — a Game Boy Advance, and both
of a Nintendo DS's — and `@demake/gba` is the fifth owned core: an ARM7TDMI in
ARM state, a mode-0 2D engine with four independently scrolling background layers
and a per-line object budget measured in cycles rather than a count of eight, DMA,
timers, and both halves of this console's sound. The Game Boy channels are
`@demake/chip`'s `GbApu` behind a permuted register map (the Mega Duck's
arrangement), and the direct-sound half is a _software mixer_ — the first thing
here that doc 16's "timed register-write schedule" does not describe, and the
contract survives restated: what a driver has to reproduce is the samples
themselves, byte for byte, against what `GbaPcm` renders. What is still to come
for these two is in doc 13 §D4.

**And it builds for a Game Boy Advance.** `demake build -c gba` produces a real
cartridge — ARM machine code written for the game, a 256-colour mode-0 background
and a second layer that carries nothing but the HUD — and the whole example
library traces identically there, in the same battery, at the same one frame per
tick. This is the sixth backend and the first whose console is bigger than the
language needs in every direction at once, so most of what is new about it is
machinery the other five have that this one _does not_.

The **HUD gets a layer of its own**, which is the first real use of having four
backgrounds. On every other console a scrolling scene has to draw its captions
with hardware sprites, because the background moves as one piece and a cell of it
cannot be held still; here layer one's scroll registers are written once at boot
and never again, so a caption's cell is `floor(pos) − floor(camera)` and cannot
drift by a pixel. The sprite HUD, the second decimal renderer that drives it and
the whole pinning argument are absent rather than reimplemented.

**A cell has 256 colours and no palette field, and objects have a bank and a
palette of their own.** A screen entry in this mode is ten bits of tile and two
flip bits — the hardware ignores the palette nibble — so a picture is fitted into
one palette of 256 rather than partitioned into sub-palettes at all, and
`maxSubPalettes` does not apply. The reservation for the font is therefore in
_colours_: three of 256, against the quarter a Mega Drive gives up. And 48 KiB of
background character memory sits beside 32 KiB of object character memory, so
this is the first console here where a full-screen picture cannot starve the
sprites — `checkTiles` refuses two budgets rather than one.

**The map is bigger than the screen on both axes and is four screen blocks.**
64×64 cells against 30×20, so a scrolling scene paints its leading edge where
nobody is looking and none of the Master System's masking exists — but "the cell
after column 31" is a kilobyte away rather than one halfword, which is the Super
Nintendo's tilemap hazard with two more blocks in it. `gba-rom.test.ts` computes
the address the hardware's way and checks every visible cell against the level's
own grid once the camera has crossed into each block.

Three things are the instruction set's rather than the console's. A collision box
is one `ldm` and one `stm`; a short conditional is a predicated pair with no
label at all; and the decimal renderer keeps its whole state in callee-saved
registers _across_ the call that plots a glyph, which no other backend can do —
the Mega Drive's keeps its digit and its running value in render words precisely
because a 68000 helper helps itself to every register there is.

**And it has sound — ten voices, and the driver has to _compute_ six of them.**
`demake build -c gba` now puts an ARM driver in the cartridge
(`packages/audio/src/rom/gba-driver.ts`, `gba-game.ts`), and it is the sixth
generated player and the first that is not only a player: four of this machine's
voices are a Game Boy's APU and reach it as stores, and the other six are
`@demake/chip`'s `GbaPcm` — a _mixer_, whose register file is in work RAM and
whose output the processor produces. So doc 16's Level A proof arrives here in
two halves and the second is the sharper one: the register writes are diffed tick
for tick by the shared battery, and the **samples themselves** are diffed byte for
byte against what the model renders (`packages/demotic/test/audio-gba.test.ts`).
The mixing is integer throughout, so "byte for byte" means byte for byte.

Three things about it are this console's rather than a predecessor's restated.
**The clock is the transfer, not a timer**: a block of 256 samples is sixteen
FIFO refills, so the sixteenth refill's interrupt _is_ a block boundary, and
counting transfers is exact where a timer at the same rate is not — a timer runs
a fixed number of bytes out of phase with a transfer that reads ahead, and the
phase depends on how deep the hardware's queue is. It also makes the rate 128 Hz
exactly, because 32768 ÷ 256 has no remainder. **The mixing is the main loop's**,
because a mix inside the handler would be twenty thousand cycles with interrupts
masked, which is two refills the handler would then never see — so the
frame-clocked consoles' `AudioFrame`/`AudioService` split returns here for a
reason of this console's own. And **the driver needs working memory**: two
kilobytes of stereo accumulator, which is why `GBA_MEMORY.audioBytes` is a
hundred times any other console's and why it is in internal RAM rather than
beside the ring in external RAM — one cycle an access against six.

**An effect only ever borrows a Game Boy channel**, because that is where the
sound demaker places one: a pitched gesture on the first pulse, a noise gesture
on the noise channel. So the whole preemption machinery is the Game Boy's
unchanged — four channel bits, a steal mask, `NR51` merged and never stored — and
the mixer's six voices tag no channel at all and play _through_ an effect. An
effect placed on a mixer voice is refused by name rather than half-handled.

**Ten voices are ten parts here**, because the example library is written to fill
the widest machine in the set rather than the narrowest: each part gets the
channel that serves it best, and a ten-part arrangement takes the Game Boy
channels _and_ the mixer's. That is what makes the mixer proof mean something —
pointed at a track whose parts all landed on the Game Boy half, a diff of silence
against silence would pass on a driver that did nothing.

**And the mix loop runs from work RAM, not from the cartridge.** On this console
every instruction fetched over the cartridge bus costs the wait states `WAITCNT`
names — four cycles a word at the setting the boot writes — and one fetched from
internal RAM costs none, so an eleven-instruction inner loop run six times a
sample is five times dearer out there. The driver therefore copies `AudioMix` and
its literal pool into internal RAM at boot and calls the copy; the routine is
position-independent by construction, because every constant it loads is
PC-relative, every branch it takes is its own, and it calls nothing. Measured on
the shooter with six voices sounding, that is 1.85 frames a game tick against
1.00 — the difference between a mixer that fits in a frame and one that does not,
and the reason every real mixer on this machine does the same thing. It was
invisible for as long as the example library's tracks did not reach the mixer at
all (§Writing music).

The _demakers_ reach it too: `demake arrange -c gba`, `sfx` and `render` demake
this console's ten voices through `binding/gba.ts`, which is the second two-chip
binding and the first whose chips are different kinds of thing — the Game Boy
half is `gb.ts` called rather than restated, and the mixer half has no shared
register to merge because `KON` is a pulse. Two things about it are worth
knowing before touching either. **Noise is a sample**, because a mixer has no
noise generator: percussion plays a recording of the Game Boy's own shift
register out of `binding/gba-bank.ts`, which is why the spec declares one noise
period rather than sixteen. And **the artifact is a WAV**, because half the
schedule addresses a register file that is demake's own — a VGM carrying only
the four Game Boy channels would be a schedule with two thirds of the music
missing, presented as the schedule.

This console is also why **the support matrix asks the encoders rather than the
specs**. "Does this console demake music" is `audioConsoles()` — the binding
registry — and "does a cartridge play it" is `gameAudioConsoles()`, which is the
audio driver table AGENTS.md's §Iron rules already counted as one of the four.
Both used to read `spec.audio`, and the moment this console's hardware was
described that said yes to both — a year before the ARM driver existed. A driver
is a _CPU's_: the same `gb-apu` is driven by an SM83 on a Game Boy and by an ARM7
here, so those tables are keyed by console and not by chip.

**And it builds for the first Tier 2 console, on a processor it already had.**
`demake build -c pce` produces a real HuCard — HuC6280 machine code written for
the game, art demade into 4bpp characters across fifteen sixteen-colour
sub-palettes — and the whole example library traces identically there, in the
same battery, at the same one frame per tick. What this console changed is the
shape of the _shared_ code rather than the size of the backend, because its CPU
is a 6502 with three habits: `Asm6280` **extends** `Asm6502`
(`core/src/asm/huc6280.ts`), so `codegen/mos/` — the 16.16 value layer, the
expression compiler, the rule bodies, the tile walk and tile collision — is one
copy that two consoles run. The seventh backend is the smallest in the set and
owns nothing but a renderer.

Three of its habits are worth knowing before touching it. **Zero page is at
`$2000`** and the stack at `$2100`, which the CPU does with arithmetic no memory
map can move — so a plan's addresses are the machine's, an _indexed_ access takes
them as absolute, and `mos/zp.ts` names both windows in one place because that is
what makes `absX(layout.contacts)` mean the same thing on both machines. **A
program lives in a 48 KiB window rather than in its cartridge**: the mapper's
eight pages hold the hardware, work RAM, the code and the data, and `$4000`–
`$FFFF` is what is left — so the boot stub is emitted _last_, padded to `$E000`,
because reset maps cartridge bank 0 there and nothing else is mapped at all until
four `tam`s have run. And **one instruction fills video RAM**: `tia src, $0002, n`
streams a run into the data port with the destination alternating between its two
bytes, which is exactly a word write, so the character bank, the sprite patterns
and each palette upload are one instruction rather than a loop.

The renderer is the easiest in the set for two reasons and the hardest for one.
The map is **64×32 against a 32×28 window**, so a scrolling scene paints its
leading edge where nobody is looking and both wraps are powers of two — the Mega
Drive's arrangement on an 8-bit CPU, and the cell address is two masks and a
shift where the NES needs a modulo. A **BAT entry carries its own sub-palette**,
so there is no attribute table, no 16×16 block to reason about and no compile-time
attribute machinery — a caption's cell simply names the font's palette. What
costs is that **there is no 8×8 sprite**: an object is 16×16 at its smallest, so a
one-cell object is a pattern with three quarters of it transparent and a HUD glyph
is a whole 128 bytes. The upside is the same fact — an object `w` cells wide is
`ceil(w/2)` entries against every other console's `ceil(w)`, into a per-line
budget of sixteen rather than eight — and the glyph patterns are _pulled_ like a
helper, so a game with no scrolling HUD ships none.

**And it has sound, which is six wavetables and a clock the NES could not have.**
`@demake/chip` models the HuC6280's PSG — thirty-two five-bit samples of RAM per
channel, a twelve-bit divider, and a shift register on two of the six — and the
cartridge carries a **generated HuC6280 driver** whose stream player is the NES's
(`rom/mos-player.ts`, shared because a HuC6280 _is_ a 6502). Three things are this
machine's rather than the NES's restated. The **clock is the CPU's own timer**, a
seven-bit reload at master ÷ 3 ÷ 1024, so a game's audio runs at 120 Hz where a
NES game's runs at 60. The handler still only counts the tick and the main loop
performs it, because the blanking interval belongs to the picture. **Nothing on
the chip is shared**, so the build emits no merge routine at all — the third
console in the set with no shared register, and the third to have none because
its hardware shares less rather than more. And the **channel is a register and it
is latched**, so `pceChannelTag` carries a select the way the SN76489's tag
carries a data-byte latch, preemption skips whole runs, and
`checkSelectDiscipline` refuses a schedule where a run would not open with a
select.

**Timbre here is a boot decision, which no other chip in the set allows.** A
waveform is _uploaded_ through the register port rather than selected, so there is
no bank in ROM at all — `binding/pce-bank.ts` produces register writes, and they
reach the cartridge as part of the driver's own initialisation. Since a strategy's
duty is a whole-track constant, the five pitched voices take five _different_
shapes instead of five copies of one: a triangle, a saw, and three pulse widths.
That is more timbre than any other eight-bit console here can hold at once, and
the demaker is what spends it: the hardware offers six identical voices and says
nothing about what to put in them.

**And it builds for a WonderSwan Color.** `demake build -c wsc` produces a real
512 KiB cartridge — V30MZ machine code written for the game, art demade into a
bank of 4bpp tiles the boot code copies into the console's own RAM — and the
whole example library traces identically there, in the same battery, at the same
one frame per tick. The encoder (`core/src/asm/v30mz.ts`) is 16-bit x86 and the
second one here with two oracles — hand-read encodings and a differential battery
against NASM, which this architecture wants for the ARM encoder's reason
inverted: it packs three fields into a mod/reg/rm byte and gives a displacement a
length that depends on its _value_, so a register in the wrong field still
decodes as an instruction. `@demake/wsc` is the ninth owned core, and the page
plays this console too.

The value layer is small, and not because the register file is wide — a V30MZ is
sixteen bits like the Z80. What buys it is an **ALU that reaches memory on both
sides** and a **real multiplier**: `add [dst],ax` / `adc [dst+2],dx` is a 32-bit
add with no pointer and no scratch, and a 16.16 multiply is four multiplies and
no loop, which no other backend here can say.

**And this is the first console where a read has to say which _segment_ it
means.** `DS` is the machine's 64 KiB of RAM and `CS` is the cartridge's mapped
bank, so a level's grid, a packed picture and a pooled 16.16 constant are all
read with a one-byte override and a game's own state is read without one. That
distinction is not a detail an emitter can leave to a convention: `val.ts` keys
it on the reference's own type — a number is RAM and a label is cartridge — and
before it did, every comparison against a pooled constant read a game's
variables instead, which is a program that traces perfectly for one tick.

The renderer is the easiest in the set and it is the hardware's doing. **There is
no video memory at all**: the two screen maps, the tile bank, the object table
and palette RAM are addresses in the same 64 KiB the variables are in, so nothing
is uploaded through a port, the object table is not a shadow, and a cell is one
store. **The HUD gets a plane of its own** — `SCR2` scrolls independently of
`SCR1` and draws in front of it, so a caption's cells are written once and its
scroll registers never again, which is the Game Boy Advance's arrangement on a
tenth of the hardware and the second time in the set the sprite HUD is absent
rather than reimplemented. And the **map is 32×32 against a 28×18 window**, so a
scrolling scene paints its leading edge where nobody is looking and both wraps
are powers of two.

**And it has sound, on a clock that is not an interrupt at all.** `@demake/chip`
models the WonderSwan's four wavetable channels, `binding/wsc.ts` drives them and
the cartridge carries a **generated V30MZ driver** (`rom/wsc-driver.ts`,
`wsc-game.ts`) — the sixth processor to get one, and the whole example library
plays its music and effects on it, diffed tick for tick by the shared battery.

Three things about it are this machine's. The **waveforms are in the console's
own RAM**: port `$8F` carries bits 6–13 of an address and the chip reads
sixty-four bytes from there, so the bank is _bytes the driver copies_ rather than
register writes it performs — the third kind of bank in the set, after a sample
block and a stream of port writes — and `WS_WAVE_BASE` is one number with three
readers because a second copy of it is a game whose bass plays the snare — and it
is at `$0300`, inside the interrupt vectors, because that is the only page free
on both WonderSwans. The
**clock is a tally**: this cartridge takes no interrupts anywhere, so `AudioFrame`
reads the vertical-blank timer's _counter_ and pays whatever frames it finds owed
— which is the frame-counting discipline every other frame-clocked console needs
a handler for, and the Nintendo DS's argument reached by different hardware. And
the **pitch register counts the wrong way**: it is subtracted from 2048 rather
than dividing, so a larger value is a higher note, and the spec declares the
lattice while the binding does the subtraction.

**And it builds for the mono machine too, for the price of a description.**
`demake build -c ws` produces a real WonderSwan cartridge — the _same V30MZ
machine code_, with the art demade through `fit-mono-tiled.ts` instead of the
RGB lattice — and the whole example library traces identically on it, plays its
music and effects on it, and is diffed tick for tick by the same two batteries.
It is not a ninth backend: these two consoles are one processor and one display
controller, so this is a _variant_ on the Mega Duck's terms and what it added is
`codegen/wsc/machine.ts` — four entries and not one instruction.

Those four are worth knowing, because each is a way a cartridge can be perfect
and dark. **There is a quarter of the memory**, and the tile bank is the top half
of it — 512 tiles of _sixteen_ bytes at `$2000` rather than thirty-two at
`$4000` — so every address in the plan moves and the heap is 2 KiB against 7,
which is the NES's budget on a console with four times its screen. **A tile is
planar 2bpp**, which is the Game Boy's format and not the Mega Drive's, so the
built-in bank is `builtinTiles()` called rather than restated. **A palette is
thirty-six ports rather than five hundred and twelve bytes of RAM** — four for
the shade pool at `$1C`–`$1F` and thirty-two for the palettes at `$20`–`$3F` —
so `emitPaletteBlock` is the one place the two renderers part company, and they
part about the _destination_ rather than the bytes. And **the footer's
minimum-system byte says a mono console may run this**, which is a Game Boy
Color cartridge's `$C0` reached by different hardware and inverted.

One thing about the art is this machine's rather than a restatement.
**Every scene brings its own shade pool**, because the eight levels are a global
choice: a picture's fit chooses them, and the objects and the font drawn over it
ride along without being refitted, since both name pool _slots_ rather than
levels. That is what `buildSpriteBank`'s `spread` buys — an object's three shades
are spread across the pool by index rather than counted up from it — and it is
why `WS_WAVE_BASE` had to move. That page has to be sixty-four-byte aligned and
below `$4000` on _both_ machines, and the colour one's roomy gap under the tile
bank is tiles over here; the interrupt vectors are what both have spare, because
neither cartridge takes an interrupt anywhere.

**And it builds for a Neo Geo Pocket Color.** `demake build -c ngpc` produces a
real four-megabit flash cartridge — TLCS-900/H machine code written for the game,
art demade into 2bpp characters across fifteen four-colour palettes — and the
whole example library traces identically on it, in the same battery, at the same
one frame per tick. This is the ninth backend, the tenth processor, and the
widest one in the set: thirty-two-bit registers over a twenty-four-bit space, so
a 16.16 value is a register and the only two routines this console pulls in are
the multiply and the divide.

Three things about it are worth knowing and none is a predecessor restated. **The
operand prefix comes before the opcode**, which is the one genuinely unusual
thing about this architecture and the reason `@demake/core`'s decoder is two
stages — a prefix byte names an operand _and its size_, and the opcode after it
says what to do. **A conditional branch never has to be inverted**, because this
is the only processor here with both a long conditional relative branch and a
conditional absolute jump, so `ctx.far` and `ctx.farJump` are each one
instruction where three other backends invert a condition over a jump. And **an
interrupt handler is a pointer in RAM**: the boot ROM owns the processor's own
vector table and dispatches through one of its own, so a cartridge installs a
vertical-blank handler by writing four bytes.

The renderer is the WonderSwan's arrangement one console along — **there is no
video memory at all**, so the tile bank reaches the display by one `ldir` and a
cell is one store — with a 32×32 map against a 20×19 window on a plane that is
exactly 256 pixels square, which makes the scroll registers _be_ the wrap. What
is this console's alone is that **a palette block belongs to a layer**: sixteen
four-colour palettes for the objects and sixteen for each scroll plane, so a
picture and its sprites can never compete for one and there is no split to force.
And that **the palette word is BGR**, red in the low nibble, which is the
opposite of every other RGB444 console here — the art path had it backwards and
only the core, written from the reference first, could tell.

**And it plays them.** `demake build -c ngpc` puts a **generated TLCS-900/H
driver** in the cartridge (`packages/audio/src/rom/ngp-driver.ts`,
`ngp-game.ts`) — the seventh processor to get one — and the whole example
library plays its music and effects on it, diffed tick for tick by the shared
battery. Two things about it are this machine's. The **chip has to be asked
for**: its own bus belongs to a Z80 sound processor, so the driver writes
`$55` and `$AA` to two bytes of the main CPU's I/O page before anything it sends
is listened to, and `@demake/ngp` refuses every port write until both arrive.
And **there is nothing to merge** — the fourth console here with no shared
register and the first to have none because its hardware pans _more_ — so
handing a borrowed channel back replays _six_ bytes rather than three, because
both of a voice's levels are things the music stated and the effect overwrote.

**And it demakes the Virtual Boy, which is the first console here with a third
axis.** `demake gen -c vb --format rom` builds a bootable cartridge and the whole
shared image battery matches the DAC reference in beetle-vb — _in both eyes_,
because this display is two scanning LED arrays and its video processor draws
every scene twice. That is not a rendering detail: a **world** is a display-list
entry that says where a rectangle of a BGMap goes on the screen _and how far
apart its two eyes' copies are pulled_, so a layer can sit in front of or behind
the display plane, and nothing else in this project has a depth to spend at all.
`VB_NEARER_SIGN` is the sign that means nearer, it has one definition, and
`packages/cli/test/vb.e2e.test.ts` settles it against a third-party emulator
rather than against our own model — a scene with two depths in it, run in
beetle-vb and in `@demake/vb`, compared pixel for pixel in both eyes.

**What goes where is `VB_DEPTH`**, and it is one table rather than a number per
emitter: **scenery at the display plane, objects in front of it, captions in
front of them.** Written down once because depth is the one quantity a reader
has to check against the _rest_ of the scene — a caption behind the object it
labels is not a wrong number anywhere, it is a wrong number relative to another
one. And deliberately shallow: this display's two eyes are about sixty pixels
apart, disparity beyond a handful asks them to converge harder than is
comfortable for a session, and every commercial game on this console keeps its
foreground within a few pixels of the plane. A demaker spends the whole machine
(§Iron rules), and on this one that means using the axis rather than exhausting
it.

Four things about this console are worth knowing before touching any of it. The
**encoder is the smallest in the set**: a V810 is a RISC with thirty-two 32-bit
registers and a hardware multiply _and_ divide, so a game backend here will pull
in no arithmetic helper at all. The **boot is three lines**, because a 27-bit
address bus puts the reset fetch inside the cartridge's own last sixteen bytes —
which is also why the reset stub jumps absolutely, since it runs from a mirror
the image was not assembled at. The **display ROM has no toolchain behind it**:
no distribution ships a V810 assembler, so this is the one family whose display
program demake emits with its own encoder, and what keeps that honest is that a
third-party emulator still decodes every instruction. And **shade 0 is the LEDs
being off**, which is the opposite end of the ramp from where every other mono
console here puts index 0 — `vbShade` is the one place that reversal happens, and
the emulator caught its absence on the first run as a picture that was a
photographic negative.

**And it builds games, which is where the third axis stops being a rendering
detail.** `demake build -c vb` produces a real cartridge — V810 machine code
written for the game, art demade into 2bpp characters, and a _display list_
rather than a stack of layers — and the whole example library traces identically
on it in `@demake/vb`, in the same battery, at the same one frame per tick. This
is the sixteenth console to run it and the only one that draws every scene twice.

**`VB_DEPTH` is spent rather than described**: the scenery world sits at the
display plane, every object carries `vbParallax(VB_DEPTH.object)` in its own
attribute entry, and the captions get a second BGMap world of their own at the
nearest rung — so a demade game reads as three planes in depth on hardware that
no other console in the matrix has anything to compare with. `vb-rom.test.ts`
reads the ladder back off the worlds, off the object table and off the _pixels_,
because a sign convention that was consistently wrong would satisfy any one of
the three alone.

Four things about the renderer are this console's. **A scene is a display list**,
so what it costs is the worlds it uses: seven, written once at boot, and the four
object worlds among them are four rather than one because the drawing processor
decides which group a world draws by _how many object worlds came before it_.
**Scrolling is two halfword stores** — the scenery world's own source origin —
against a 64×64 map and a 48×28 window, so the leading edge is painted sixteen
columns off the right-hand side and neither the NES's row pinning nor the Master
System's seam mask exists. **The HUD gets a plane of its own**, whose origin is
written at boot and never again, which is the WonderSwan's arrangement with a
depth on top and the third time in the set the sprite HUD is absent rather than
reimplemented. And **an unaligned access is masked rather than faulted**: a V810
clears the low bits of an address instead of raising, so an `ld.h` at an odd
address reads the halfword below it and reports nothing — which is why the tile
cell list and both tile-contact lists are read a byte at a time and why the
shared constant pool grew an `align` hook.

**A caption here is chosen against the picture, not against the backdrop**, and
that is the one place this console's HUD plane costs something the NES's shared
backdrop does not. On that machine a caption's paper _is_ the backdrop register,
so the ink is picked against it; here the caption is on a plane in front of the
picture and what shows through its paper is the picture. Picking against the
backdrop gave the caves title screen dark ink over a three-quarters-dark picture
whose lightest colour was rare — a caption placed correctly, demade correctly and
invisible, which no register comparison can see. `vb-art.ts` counts the shades the
demade picture actually places and ramps the font the other way.

**And it plays them.** `demake build -c vb` puts a **generated V810 driver** in
the cartridge (`packages/audio/src/rom/vb-game.ts`, `v810-player.ts`) — the
eighth processor to get one, and the last game console in the matrix to have
none, so all sixteen now play their audio. Three things about it are this
machine's. The **tick is a call rather than a handler**: this cartridge takes no
interrupt anywhere and its main loop already waits a frame per pass on the
drawing processor, so a tick per pass _is_ a tick per frame and there is nothing
to count — which makes `resolveVbClock` the only clock resolver in the set with
exactly one answer to give, at 50.2 Hz, the coarsest driver rate here. There is
**no merge arm at all**, for the reason the chip section below gives, so no
schedule for this console ever sets the run format's merge bit. And **register
liveness is the caller's question at every `jal`**, because a V810 routine saves
its return address and nothing else: `AudioSfxRelease` reads the steal mask into
the same register both of its callers are holding something in, and `keep`/
`unkeep` are that pair — without them a game's sound never fires and its music is
otherwise perfect, which is what the shared battery's borrowed-channel case
reported.

**And it demakes music and effects.** `@demake/chip` models the VSU — six voices,
five of them wavetables of thirty-two six-bit samples — and `demake arrange -c vb`,
`sfx` and `render` all work, on the Neo Geo Pocket's precedent that a demaker is
per-domain and does not wait for a cartridge. Three things about that chip decide
what a driver for it will look like. The **waveform tables are a shared pool of
five** rather than one per channel, so a table is a timbre and the bank is
register writes a boot performs (`binding/vb-bank.ts`, the fifth kind of bank in
the set). **Every channel has a hardware envelope**, so a drum's decay is one
write rather than one a tick — which neither of the other two wavetable consoles
here can say. And **nothing is shared between channels**: panning is two nibbles
in the channel's own byte, enabling is its own bit 7, and the one global register
is a panic button — so this console emits **no merge routine at all**, the sixth
in the matrix and the fourth whose reason is that its hardware shares _less_
rather than more.

The binding spends both of the output stage's multiplies rather than one: the
note's **level goes in the envelope register** and the **pan in the level
register**, so a volume step and a pan change are one write each and neither
disturbs the other. Every other wavetable console in the set packs both into one
byte and rewrites it for either.

**And it demakes music and sound, on both Neo Geo Pockets.** `@demake/chip`
models the T6W28: a Master System's four voices with the thing that chip is
poorest in — **stereo that is a level rather than a switch**, two four-bit
attenuators per channel, one a side — and the arranger now places a part
anywhere across that image rather than switching it fully to one side, which was
this console's last unspent line (§Working on audio). It is the fourth console
in the set with no
shared register and the first to have none because its hardware pans _more_. Two
write ports carry different registers (the tone periods on the left, the noise's
own divisor on the right), so a driver that had them backwards would produce
silence; the chip test pins that, because a register diff could not. The mono
machine is on that list too, because it has the same sound hardware and a
demaker is per-domain — so `arrange -c ngp` works on a console `build -c ngp`
cannot target.

**And it demakes music and sound for the Neo Geo, which is fourteen voices on one
die.** `@demake/chip` models the whole YM2610 — four four-operator FM channels,
three squares with a shared noise generator, six fixed-rate ADPCM sample channels
and one variable-rate one — and `binding/neogeo.ts` drives all of it, so
`arrange -c neogeo`, `sfx` and `render` produce a `.vgm` carrying the chip's own
commands _and_ both of its sample ROMs as data blocks. Four things about it are
worth knowing and none is a predecessor restated.

**The FM section is a YM2612, and that is the hardware rather than a shortcut.**
The register map says so out loud: `$30`–`$B6` is addressed at per-channel offsets
**1 and 2** on each port with offset 0 absent, and `$28` names the four channels
`001`, `010`, `101`, `110` — a six-channel part with 1 and 4 removed. The sample
rate agrees, 8 MHz over 144. So `Ym2612` _is_ that section and `FM_SLOT` is
`[1, 2, 4, 5]`, which is the check rather than the convention: running those four
through the shared key-on encoding reproduces the documented codes exactly. What
`ym2610.ts` owes is **refusing** what the OPNB does not have — the LFO, the DAC and
both missing channels — because a model that plays six voices on four-voice
hardware sounds right here and silent on the board.

**The percussion is a recording, and it is the first in the matrix that is.**
Six voices playing 4-bit ADPCM at a fixed 18518.5 Hz, so `binding/neogeo-bank.ts`
is the fourth kind of bank in the set and the first that is _two_ ROMs in two
codecs — drums for A, single-cycle waveforms for the one sample voice that has a
pitch. Both encoders run the decoders' own arithmetic, because the two codecs are
not one: **A wraps a twelve-bit accumulator** (so an overdriven drum folds rather
than flattening) and **B clamps a sixteen-bit one** with a step that scales by a
multiplier. A shared decoder would be wrong in both directions at once.

**There is no shared register, for two reasons at once.** The SSG mixer at `$07` is
the one byte three channels share and it is written _once_ at boot — tone on, noise
off — because a note here is silenced by its own level; and the ADPCM key-on byte
is a **pulse**, acting on the voices its mask names and leaving the rest alone,
which is the Super Nintendo's `KON` on completely different hardware. Six consoles
now emit no merge routine and this is the first whose reason is two.

**The clock is a timer and only a timer**, because this is the only console in the
matrix whose sound processor cannot see the picture: the Z80 takes an IRQ from the
chip's own timers and an NMI when the 68000 sends it a byte, and the vertical blank
reaches the 68000 alone. So `fitRate` has no frame candidate to beat — the only one
in the set that does not — and timer A puts 120 Hz on count 463, which is 119.99 Hz.

Two things it does not reach and both are recorded (doc 13 §A5.5). The SSG's
**noise** is refused on purpose: with six sample voices playing real drums, putting
a hi-hat on a shift register is spending the machine downwards. And **five of the
six drum voices sit idle**, which is an _arranger_ gap rather than a binding one —
`plan.ts` gives one part one channel and a General MIDI drum track is one part, a
question no console before this one could raise.

**And it has a sound program, which is a cartridge region of its own.**
`packages/audio/src/rom/neogeo-game.ts` is the eighth generated driver and the
first that is neither routines a game calls, nor a block a cartridge uploads, nor
a second binary in shared memory: it is a whole **Z80 program in the M region**, on
a bus the 68000 cannot see. It boots itself, clocks itself, and a game reaches it
by storing one byte to `REG_SOUND`. `packages/audio/test/neogeo-driver.test.ts` is
doc 16's Level A proof for it on its own — every tick's writes, in order, for music
and for an effect — and `@demake/neogeo`'s `sound.ts` is the machine it runs on.

Four things about it are this console's. **The clock is the chip's own timer and
the interrupt comes here**, which is the Mega Drive's hardware with the wire the
other way round: there the line goes to the Z80 so a _game_ polls it from a loop
that is also running a game, and here the driver _is_ the Z80 and keeps 119.99 Hz
exactly. **A request is an interrupt rather than a poll**, so asking for a track
costs one store with no handshake. **A write has to settle** — seventeen chip
cycles after an address and eighty-three after a datum, which the hardware
documentation warns is why some homebrew plays in an emulator and not on a board —
so `neogeoWrite` pads with two `push af`/`pop af` pairs. And **the register is
latched**, so the channel tag is a factory carrying it and an address byte is
tagged by the register it is _about to_ latch: that keeps an address and its datum
in one run, where tagging the address as nobody's would split every register write
in half.

**Two tags rather than one**, which no console before this needed. Preemption asks
which of four borrowable channels a run is on; restriction asks which of
_fourteen_ voices a write belongs to. Numbering only the borrowable ones for both
calls the other ten "nobody" and keeps an effect's whole opening statement of the
chip — a sound effect that silences the music every time it fires.

**And `demake build -c neogeo` puts it in the cartridge.** The `.neo` container
carries the M and V regions — a Z80 program and the two sample ROMs — and the
68000's whole share of the audio is one byte stored to `REG_SOUND` at a scene
change. `packages/demotic/test/audio-neogeo.test.ts` runs the shared battery on
it, so the fifteenth console plays its own music and effects and is diffed tick
for tick.

Three things about the wiring are this console's. **A tick nothing is playing is
not a tick**: this driver runs from boot whether or not a game has asked for
anything — it is a separate program, so there is nobody to start it — and ticking
through silence would put a schedule's tick 0 several ticks after the first one
the hardware delivered. Every other console is spared that because its driver is a
routine the game calls. **The request can arrive before the driver is listening**,
because a 68000 boots in a few hundred cycles and this program takes tens of
thousands; the hardware latches the byte either way and only the interrupt is
lost, so the boot ends by reading the port — without which a cartridge is silent
until its second scene. And **one host step is not one instruction of the
processor the driver runs on**, so the conformance harness watches the Z80's
instruction stream (`Sound.watch`) exactly as it watches a Super Nintendo's sound
processor; sampling the program counter after each 68000 instruction sees one
arrival as dozens.

**A borrowed channel comes back holding the music's own registers here too**, and
what is this console's is how the copy is filled in. A packed byte is a _port_
rather than a register number, so the recorder cannot tell one of a channel's
bytes from another by looking at it: an even port latched a register and the byte
_is_ that number, an odd one is the datum and the latch says which of the three
copies it belongs to — which is why the shadow is four bytes rather than three
(`rom/neogeo-driver.ts` §`NEOGEO_SHADOW`). Three is the whole replay because an
effect only ever borrows a square; an FM voice's state is a patch, and nothing
ever hands one of those back. What made this land was one word in the packer: a
game's effect ends with `stop` and not `silence`, because the silence block turns
_every_ channel off and then rests for ever — so it takes the music with it and
holds the borrowed channel long after the effect is over.

The battery skips one thing for this console and it is recorded rather than
tolerated: the **size sweep**, on the Game Boy Advance's
terms. A game is tens of kilobytes of a megabyte P region with its sound program
in 32 KiB of its own, so there is no budget to catch — and what the sweep would
still have bought, that a driver's reported sizes are real, is asserted on an
art-free build in `packages/audio/test/neogeo-driver.test.ts`.

**And a game bigger than one cartridge takes a bigger one, on every family that
had a bigger one to take** (doc 13 §Banked cartridges). `quest` — three levels, a
boss, a secret room, four tracks and eight effects — is the example that needed
it, and it now builds and plays on **every one of the sixteen consoles that build
games**: a Mega Drive at 140 KiB, a Super Nintendo at 128 with a bank per scene,
both Sega 8-bits and all three Game Boys at 128 with a tick's individual _steps_
paged, an NES at 256 KiB on an MMC1, a PC Engine at 256 on a HuCard, a
WonderSwan Color spread over three of its 64 KiB segments, and the Neo Geo, the
Neo Geo Pocket Color, the Virtual Boy and both ARM handhelds on boards big
enough to need no paging at all. The Super Nintendo is the only paging
console where a scene fits a bank; everywhere else the window is sixteen kilobytes
and the largest scene is twenty-seven, so the unit is one step of one tick — which
is why `TickSteps.boundary` exists and why the seam is _there_ rather than
somewhere convenient: a step boundary is the only point inside a tick at which
nothing is live, because the steps hand work to each other through the entity
records and the contact bitfield and never through a register.

**The last one was out of RAM rather than out of cartridge, and it takes the
board's**: the mono WonderSwan wants six kilobytes of heap and has two, on a
machine with sixteen of which the tile bank is the top half. No cartridge size
fixes that, and both cheaper answers were measured rather than assumed — running
the heap to the object shadow buys 192 bytes and taking the unused tail of the
tile bank buys 128, because `quest` uses 504 of that machine's 512 tiles. So the
cartridge brings **save RAM**, which this console maps at segment `$1`, and a
game the console's own memory cannot hold puts its whole heap there
(`codegen/layout.ts` §WS_SAVE_MEMORY). That is the NES's `$6000` story with a
different port, and it is the elastic-board rule reaching the RAM: the footer
declares the smallest of the five sizes it can name that holds the game.

**`DS` and `ES` are the heap and `SS` is the console**, which is what makes it
cost nothing above the memory plan. An unprefixed operand still means the heap,
so the value layer, the expression compiler, the rule bodies and the tile walk
are unchanged prefix for prefix on a game whose variables are in a cartridge;
what moves is the six operands that are the _display's_ rather than the
allocator's — two screen maps, the object shadow, the object table and the tile
bank — and those take an `ss:` override, because that is the segment register a
demade cartridge already points at the console's memory and never moves. The heap
goes **whole or not at all**, which is why it is a second `MemoryPlan` rather
than the NES's `heapSpill`: an override reaches a memory operand and even a
`movs`'s source, but its destination is `ES` and no prefix changes that, so a
copy between two heap addresses cannot have one end in each memory.

What each console then paid is its own, and the three 16 KiB-window machines
differ most. A Sega 8-bit pays nothing: slots 0 and 1 are 32 KiB of fixed space and
hold everything that cannot move. A Game Boy has half that, so its tile art, its
packed audio schedules and its instance defaults become paged _data_ units, and
its audio driver — entered by a timer interrupt — saves and restores the running
bank from a RAM shadow, because MBC5's register cannot be read. An NES has the
same half and a bigger program, so it goes further still: it is the one console
that **duplicates**, giving each bank its own copy of the level tables its steps
read, because a paged routine cannot reach a table in another bank. And a PC
Engine pays least of all, because its mapper is in the CPU — `lda` and `tam`
against MMC1's five serial stores — and keeps `$8000`–`$FFFF` mapped, so only its
character bank and its schedules go up. Every cartridge that fitted a
mapper-less board before is byte-identical, on all seven.

Still to come: the remaining Tier 2/3 consoles (each =
a codegen backend, a ROM harness + toolchain, and a libretro core + DAC
calibration), the remaining framebuffer/scanline layout paths (Lynx, GBA/NDS
bitmap modes, 2600/7800), and the rest of the Demotic runtime story (the speed
work doc 14 §Runtime model names).

**The audio spine is built, and two consoles boot** (docs
[16](docs/16-audio-engine.md), [17](docs/17-music-demaker.md),
[18](docs/18-sound-demaker.md)): `@demake/chip` models the Game Boy APU, the
SN76489, the NES 2A03, the YM2612, the Super Nintendo's S-DSP, the Nintendo DS's
SPU, the HuC6280's wavetable PSG, the WonderSwan's, the Neo Geo Pocket's
T6W28 and the Neo Geo's whole YM2610; `@demake/audio`
holds both demakers; and `demake arrange`, `demake sfx` and `demake render` work
for `dmg`, `gbc`, `megaduck`, `nes`, `sms`, `gg`, `sg1000`, `snes`, `md`, `gba`,
`nds`, `pce`, `neogeo`, both WonderSwans and both Neo Geo Pockets — the mono machine included, because it has the
same sound hardware and a demaker is per-domain, so `arrange -c ws` works on a
console `build -c ws` cannot target. A
track becomes a `.vgm` plus a WAV that is exactly what the schedule produces — or,
on the one console whose chip plays samples rather than generating them, an
`.spc`, which is a snapshot of the sound processor's RAM and therefore exactly
what a cartridge uploads. The Mega Drive is on that list for all ten of its
voices — six four-operator FM and four tone — which is the first console here
whose spec names two chips.

`demake gen <schedule> -c dmg --format rom` then turns that schedule into a real
32 KiB cartridge, with an SM83 driver **generated for it** — no fixed player, no
checked-in harness, no toolchain — and `-c nes`, `-c pce`, `-c sms`, `-c gg` and
`-c md` do the same on an NROM board, a HuCard, a flat Sega cartridge and a
one-megabit Mega Drive board, which is what turned "what does another console cost"
into a measurement: the stream player is the _processor's_ and moved not at all
between them, so each is a boot sequence, a clock and a cartridge wrapper
and nothing else. The fourth reused a player written for a _game_ and
changed it in one place — an emitter that can lay packed data either side of a
hole, because this console's cartridge header is sixteen bytes inside its own
address space. The fifth changed nothing at all, and is where **a standalone
cartridge stops being a game with the game taken out**: its clock is the FM
chip's own timer, which a _game_ on that console cannot have, because the timer's
interrupt goes to the Z80 and a game polling the status byte would be reading it
once per pass of a loop that is also running a game. A loop that does nothing
else polls it every few microseconds and keeps the timer's rate exactly — so
`resolveMdClock` and `resolveMdAudioClock` refuse _opposite_ sources, which is
the sharpest statement in the set of what a caller is (§The 68000 half).
And **doc 16's Level A proof runs in `pnpm test`**: the ROM boots in `@demake/dmg`, whose APU is now `@demake/chip`'s,
and every register write it makes is diffed against the `ChipScript` tick for
tick, with no tolerance (`packages/audio/test/rom.test.ts`). That is the audio
counterpart of the pixel-perfect emulator E2E, and it is sharper, because the
artifact _is_ the schedule.

`demake build` then puts that driver _inside a game_: a track per scene, an
effect per event, one clock serving both, and the same proof one level up —
`packages/demotic/test/_audio-battery.ts` boots a cartridge that is playing a game
and diffs every register write against the schedules the demakers produced.
It does that on **every** console the game backend builds for — all sixteen of
them, so a demade game plays its music and effects wherever it plays at all —
over twelve
drivers that share only the packed format and — where the CPU is the same — the
stream player, and below that only what the chip decides: an SM83 player on a
programmable timer, a 6502 player on the picture's interrupt, the _same_ 6502
player on a timer one console over, a Z80 player writing an I/O port, a 68000
player storing a byte to an address, an SPC700 player that is not on the console's
processor at all, an ARM player clocked by its own sample transfer that has to
_compute_ six of its ten voices before it can play them, a TLCS-900/H player
that has to _ask_ for its chip before anything it sends is listened to, a V30MZ
player that takes no interrupt at all and reads a timer's counter instead, a V810
player whose tick is a _call_ from the game's own loop rather than a handler, and
the _same_ Z80 player one board over as a whole program of its own, on a bus the
game cannot see.

**And both demakers are on the web** (doc 07 §The audio sections): a music
section and a sound section over their own worker, carrying the whole
`arrange`/`sfx`/`render` flag surface — roles and drops per part, the channel
plan as a piano roll, the tournament as a strategy picker — and handing back the
`.vgm`, the `--emit-manifest` sidecar, the sample-exact WAV and a cartridge, all
four pinned byte-identical to the CLI's by
`packages/web/test/e2e/determinism.spec.ts`.

Still to come for audio: `bin`/`asm`/`c` emit, a _standalone_ audio cartridge for
the consoles that still have none — the Game Boy, the **NES**, the **PC Engine**,
both **Sega 8-bits**, the **Mega Drive**, both **ARM handhelds**, the **Virtual
Boy** and both **WonderSwans** build one today,
and the Neo Geo Pocket Color has a driver only inside a
game, while the Super Nintendo's writes an `.spc` rather than a cartridge. What
each of
them costs is no longer an estimate but a measurement: the stream player belongs
to the _processor_ and is already written, so a console adds a boot sequence, a
clock and a cartridge wrapper and nothing else — which is why the third of them
reused the second's player unchanged, the fourth reused a _game's_, the fifth
changed not one instruction of one, the sixth changed not one instruction of
a _game's_ either, and the seventh changed not one instruction of **two** shared
files. What the fourth and fifth did was find, twice, the
bill for a clock nobody had ever had to keep. The Sega binding would fit a rate
to the VDP's line interrupt, and that interrupt fires only inside the active
display, so the first cartridge to ride one would have played at half the rate it
declared (§The Z80 half). And the Mega Drive's core only advanced its FM chip
when something was listening to the speakers — which is invisible for a
write-only chip and fatal for one whose _timer_ a driver polls, so the first
cartridge to ride that would have spun for ever (§The 68000 half). The seventh
found a third: `gbaBinding.fitRate` was searching that machine's spare timers,
and on a console where a driver tick _is_ a block of mixer samples there is only
one rate — 32768 ÷ 256 — so the example library's own fixtures were being fitted
at 56 Hz, which is a schedule no cartridge there can play. Also: driver backends for the remaining
consoles (each needs a CPU encoder or a checked-in driver source, plus a core to
prove it in), Level B sample comparison, the remaining chips (the rest of the
handhelds), and — the one that is an _iron-rule_ gap rather than a missing
feature — **hardware the chip layer models and no binding reaches** (doc 13
§A5.5). Six lines of it: the YM2612's LFO, its SSG-EG modes and its channel-3
four-pitch mode, the HuC6280's LFO, and the two sample players nothing above
the chip layer drives (the PC Engine's direct D/A and the WonderSwan's PCM
voice — doc 18's work rather than doc 16's). None of it is a correctness
problem: every cartridge performs exactly the schedule its demaker produced, and
the models were completed _before_ any binding wanted them, so closing those gaps
changed no cartridge's audio by a byte. It is expression the hardware offers and
nothing asks for, which is the rule a demaker spends the whole machine pointing
the other way. The first line is closed: `@demake/audio` produces vibrato now,
read off the source's own modulation wheel, and the Mega Drive spends its LFO
for it (§Working on audio). The HuC6280's LFO is a refusal rather than a gap —
channel two _is_ the modulator on that chip, so it costs a voice.
Also: tracker and lossy-audio input with
the transcription front end, and FLAC/M4A export. Read doc
16 before touching any of it — several of its decisions are load-bearing and easy
to undo by accident (§Working on audio).

## Layout map

```
packages/core/       @demake/core — the engine (zero platform deps; ESM; ships types)
  src/asm/           the SM83, 6502, HuC6280, Z80, 65816, SPC700, 68000, ARM,
                     V30MZ and TLCS-900/H assemblers + the GB, iNES, Sega, LoROM,
                     Mega Drive, GBA, DS, WonderSwan, Neo Geo Pocket and Neo Geo
                     cartridge wrappers — neo-lspc.ts beside the last of those is
                     that console's *video memory* rather than its cartridge, here
                     for megaduck.ts's reason: the emulator reads a sprite strip,
                     the game backend writes one and the display-ROM builder
                     places a picture, and three copies of an SCB word encoder
                     disagree in one entry in one of them —
                     shared by the Demotic game backends and the audio drivers, so
                     no backend owns the encoder for its own CPU. megaduck.ts is
                     the Mega Duck's I/O map, here because three things read it
                     (the core, the audio driver, the game backend). The SPC700 is
                     the odd one out: it is nobody's main processor, and the only
                     thing written in it is a sound driver. arm.ts is the
                     opposite: one encoder for three consoles (a GBA, and both
                     of a DS's processors), and the only one whose *constants*
                     need a mechanism — a 32-bit literal does not fit in a
                     32-bit instruction, so `ldrConst`/`ltorg` are a literal
                     pool rather than an addressing mode. huc6280.ts is the one
                     that *extends* another rather than restating it — a PC
                     Engine's CPU is a 6502 with a memory mapper, block transfers
                     and a zero page at $2000 — and that inheritance is what lets
                     `demotic/src/codegen/mos/` be one copy for two consoles.
                     gba-sound.ts is that
                     console's sound page, here for megaduck.ts's reason: the
                     core routes a store by it and the ARM driver emits one from
                     it, and two copies would cancel each other's errors out.
                     v30mz.ts is 16-bit x86 — the WonderSwan's V30MZ is an 8086
                     core with the 80186's additions — and it is the one encoder
                     whose *operand* is a value the caller builds rather than a
                     spelling of a method name, because this architecture spends
                     a mod/reg/rm byte where every 8-bit CPU here spends an
                     opcode per addressing form
  src/math/          deterministic kernels (exp/log/pow/cbrt/sin) + PCG32 PRNG
  src/parallel/      the executor seam: work described as jobs, run wherever the
                     edge says. `jobs.ts` is the contract and the inline runner
                     (the reference answer); `pool.ts` is the scheduling every
                     edge shares — core supplies no threads and never will
  src/color/         sRGB/linear/Oklab, hardware-lattice snapping, color parsing
  src/image/         every codec, all of them ours: PNG (inflate/deflate/decode/
                     encode), BMP, GIF and baseline JPEG, plus DAC models and the
                     decode dispatch. The lossless three are ours for PNG's
                     reason; JPEG is ours for a stronger one — it is *lossy*, so
                     the standard fixes its inverse transform only to a
                     tolerance and two correct libraries disagree in the low
                     bits, which across the CLI and the page is two different
                     demakes of one photograph. WebP is absent and says so
  src/consoles/      ConsoleSpec schema + one declarative spec per console (21 of
                     them). vb.ts's ramp is a *tested artifact* on md-vdp's
                     terms: it reproduces what beetle-vb renders at the
                     brightness a demade cartridge programs, which is unevenly
                     spaced because that emulator applies a gamma to the LED
                     intensities
  src/pipeline/      stages 0–7, the tiled fitter, mono + tiled-mono + TMS
                     row-pair paths, tournament. fit-mono-tiled.ts is the one
                     whose problem is *discrete*: a pool of eight and palettes
                     of four leave seventy quartets a cell could be given, so it
                     evaluates every one rather than clustering toward it
  src/pipeline/candidate.ts  one candidate, start to finish — the unit of parallel
                     work, and the content-keyed prologue memo that stops a
                     fan-out decoding its source once per candidate
  src/codegen/       gen: per-family backends (gb, nes, snes, sms, md, neogeo,
                     sg1000, gba, nds, pce, ws, wsc, ngpc, vb), detector. vb.ts is
                     the only one that emits a *world* — on every other console
                     "where the picture goes" is a scroll register, and here it is
                     a 32-byte display-list entry with a depth field in it.
                     neogeo.ts is the only one whose *tile is not the console
                     spec's tile*: a pixel costs what an 8×8 4bpp layout says, but
                     the hardware's unit is 16×16 and so is the attribute cell, so
                     it asks `extractTiles` for the bigger tile and gets the
                     composition, the flip dedup and the palette in one pass
  src/image/svg/     our SVG rasteriser: XML, shapes, paint, scanline fill (doc 15
                     step 2). The one decoder whose *output size* is a question
                     rather than a fact, which is what `decodeImage`'s `atLeast`
                     is for
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
rom-harness/{gb,nes,snes,sms,md,neogeo,sg1000,gba,nds,pce,ws,wsc}/  the display
                     programs `gen --format rom` assembles. The `gb` one is three
                     consoles, because the Mega Duck is a machine description
                     rather than a display program of its own — `cli/src/rom/gb.ts`
                     generates the `machine.asm` it includes. Two families have
                     none: no distribution ships a V810 or a TLCS-900/H
                     assembler, so `cli/src/rom/vb.ts` and `ngpc.ts` emit their
                     display programs with core's own encoders rather than
                     assembling a source file
emu-harness/gb/      the headless capturer for the `gb` family's pixel-perfect E2E
                     (doc 10), compiled *twice*: against SameBoy for the two Game
                     Boys and against SameDuck for the Mega Duck. One source, two
                     emulators — nothing about capturing a frame differs, and
                     each build refuses the models its library is not
emu-harness/libretro/  generic retrorun frontend — one capturer for every libretro
                     core, pixels *and* (with `audio_out=`) the audio callback,
                     which is doc 16's Level B
tools/toolchains/    provisioners (cached): RGBDS, cc65, WLA-DX, SameBoy and
                     SameDuck source builds; GNU m68k + arm-none-eabi binutils and
                     NASM (apt); libretro cores (fceumm, genesis-plus-gx, snes9x,
                     mgba, desmume, mednafen_pce_fast, mednafen_wswan,
                     mednafen_vb, mednafen_ngp, geolith)
packages/nds/        @demake/nds — a self-hosted Nintendo DS core, and the only
                     one of the seven that is *two* processors: the ARM9 and the
                     2D engine are @demake/gba's, because a DS's engine A *is* a
                     Game Boy Advance's, and arm7.ts is the second processor's
                     world — shared main RAM, its own 64 KiB, four timers and
                     @demake/chip's NdsSpu — because the sound channels answer it
                     alone. The rest is the machine around them: 4 MiB a cartridge
                     is *copied into* rather than run from, nine video RAM banks of
                     which two are mapped, and a screen a third bigger. Engine B,
                     the second screen, interrupts (on both processors) and every
                     ARM7 peripheral that is not the sound are absent rather than
                     half-implemented, and each raises
packages/vb/         @demake/vb — a self-hosted Virtual Boy core, and the only one
                     that renders *two* pictures. Its video processor is a
                     display list rather than a stack of layers: thirty-two
                     worlds processed from 31 down to 0, each naming a rectangle
                     of a BGMap, where it goes, and **how far apart its two eyes'
                     copies are** — which is this project's only depth axis.
                     VB_NEARER is that sign, with one definition, asserted about
                     *pixels* rather than about the constant because two
                     wrong-but-agreeing definitions would put a cartridge's
                     sprites behind its scenery and pass everything. Its
                     framebuffers are *columns* (384 of 256 pixels at 2bpp), so
                     a reader that walked one row-major would produce noise
                     rather than a wrong picture, and `vbFramebufferBit` has one
                     definition for that reason. Its CPU is written against the
                     published instruction set and driven in its tests by core's
                     own encoder. Its sound is @demake/chip's VSU, advanced by
                     the same crystal the processor counts at a quarter of it,
                     with `vsuTap` as the window doc 16's Level A reads through
                     — and its register page answers **zero** when read rather
                     than the byte last written, because nothing on this chip
                     reads back and a shadow kept to read would be a second
                     model of it. The affine and h-bias world modes, the
                     hardware timer and the LED brightness curve are absent
                     rather than half-implemented
packages/ngp/        @demake/ngp — a self-hosted Neo Geo Pocket core, mono *and*
                     Color, decided by a constructor argument the way @demake/wsc
                     is. Its display has no memory of its own, on that core's
                     terms — the registers, the palettes, the two scroll maps,
                     the object table and the character bank are one region of
                     the same address space the variables are in — and its
                     renderer is per scanline: a per-line object list, a per-line
                     resolved palette cache, and one map entry and one character
                     row per eight pixels. The *boot ROM is ours*, on
                     @demake/snes's terms: read the entry address out of the
                     header, point the stack, jump, and dispatch the vertical
                     blank through the pointer a cartridge writes into RAM. The
                     CPU is written against the published instruction set and
                     driven in its tests by core's own encoder — and on it **the
                     operand comes before the opcode**, which is why the decoder
                     is two stages. Its sound is @demake/chip's T6w28, reached
                     through two I/O bytes and refusing every port write until
                     the main CPU has *asked* for the chip — which is the one
                     thing about this console's audio no register diff could
                     check. The Z80 sound processor itself and the on-chip timers
                     and DMA are absent rather than half-implemented
packages/pce/        @demake/pce — a self-hosted PC Engine core. Its PSG is
                     @demake/chip's Huc6280Psg, not a second one, and `psgTap`
                     is the window doc 16's Level A proof reads through. The CPU
                     is transcribed rather than copied from @demake/nes's, for
                     the reason every decoder here is written twice; the picture
                     hardware has nothing in common with a 2C02 at all — word-
                     addressed video RAM behind a port, a sub-palette in the
                     cell's own map entry, sixteen-pixel sprites and a sprite
                     table the chip *copies* out of video RAM once a frame
packages/wsc/        @demake/wsc — a self-hosted WonderSwan core, Color *and*
                     mono, decided by a constructor argument the way @demake/dmg
                     is decided by its cartridge header — because these two
                     machines do not differ in anything a header could record.
                     It is the only core whose display has no memory of its own:
                     the two screen maps, the tile bank, the object table and
                     (on the Color) palette RAM are addresses in the same memory
                     the game's variables are in, so `Display` is handed the
                     console's RAM and nothing is ever uploaded through a port.
                     Its second background layer is a *layer* rather than a
                     window, and colour zero is transparent on both. The mono
                     machine is two lookups rather than a second renderer:
                     planar 2bpp tiles in the top half of its 16 KiB, and a
                     palette of four three-bit indices into a shared eight-shade
                     pool that lives in *ports* rather than in RAM. Its sound is
                     @demake/chip's WsSound, handed the same RAM for the same
                     reason the display is. The CPU is written against the
                     published 8086 instruction set rather than transcribed from
                     another emulator, and its tests are driven by core's own
                     encoder. The two window units and the interrupt controller
                     are absent rather than half-implemented — a demade
                     cartridge polls the line counter rather than taking an
                     interrupt, and its audio driver reads a timer's counter
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
                     is where its output goes. It has one memory bank controller
                     and it is MBC5, decided by the header's type byte for the
                     same reason: bank 0 stays wired to $0000 because the
                     vectors, the entry point and the header are down there, and
                     up to 512 banks answer $4000. Cartridge RAM at $A000 is
                     absent rather than half-implemented — no board demake
                     produces declares any — and so are MBC1, MBC2 and MBC3,
                     because nothing builds one
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
                     @demake/chip's, not a second one. Its LoROM decoding is
                     generic — bank `k` shows ROM offset `k x $8000` — so a
                     banked cartridge needed nothing here at all, which is what
                     "no controller, just address decoding" means in practice
packages/neogeo/     @demake/neogeo — a self-hosted Neo Geo core, and the eleventh.
                     sound.ts is a whole second computer: a Z80 with its own ROM
                     on its own bus, a YM2610, and one byte in each direction
                     between the two processors. The chip is advanced *between*
                     instructions rather than in a lump — a caller hands over a
                     frame at a time, and advancing it all at once collapses
                     hundreds of timer overflows into one flag, which is a driver
                     playing at whatever rate its caller polls at. The three
                     clocks divide exactly, so none of it rounds.
                     Its 68000 is @demake/md's rather than a second transcription,
                     on the terms @demake/nds borrows @demake/gba's ARM. **Its
                     boot ROM is ours and it is three lines** — stack pointer from
                     the cartridge's first longword, enter at the header's USER
                     vector — because a demade cartridge calls none of what a
                     commercial one uses the system ROM for, which is what took
                     this console off doc 13's "gated on a BIOS" list. The LSPC is
                     the interesting part: a sprite is a *vertical strip* whose
                     column of tile numbers is a 64-word table, and the sticky bit
                     chains each to the one before it, so a row of strips is a
                     tilemap carrying one position between all of them. Its fix
                     layer is 8×8, column-major and in front of every sprite. The
                     Z80 sound processor, the memory card, the calendar and the
                     sprite shrinking hardware are absent rather than
                     half-implemented
packages/md/         @demake/md — a self-hosted Mega Drive core, and the only one
                     with *two* sound chips: the SN76489 at $C00011 and the
                     YM2612 at $A04000, both @demake/chip's rather than second
                     copies, with a tap each — and the FM one reports the bus
                     *port* rather than a decoded register, because that is what
                     a schedule's register number is on this machine. The FM chip
                     runs whether or not a sample sink is attached, which the PSG
                     does not, and the difference is that this one can be *read*:
                     its status byte carries the timer overflow flags, and a
                     standalone audio cartridge's clock is timer A polled from
                     the main loop. Gating it on a sink would be a model of the
                     speakers rather than of the chip. The Z80 is absent — a
                     second processor `demake build` emits no program for — so
                     its RAM answers as RAM, which is what the hardware does to a
                     68000-only program. Its *reset line* is not absent, and that
                     is the one thing this core models about a chip it does not
                     have: `$A11200` is wired to the YM2612's own reset as well,
                     and the console powers up with it held, so the FM chip
                     discards every write until a cartridge releases it. Before
                     that was modelled the six FM voices answered a core with no
                     Z80 in it and every demade Mega Drive cartridge was silent
                     on the board with a perfect register diff — §Gotchas' wrong
                     and consistent description, reached through the peripheral
                     this core deliberately leaves out
packages/gba/        @demake/gba — a self-hosted Game Boy Advance core: an
                     ARM7TDMI in ARM state, a mode-0 2D engine with four
                     background layers and 128 objects, DMA, timers, and both
                     halves of the sound. The Game Boy channels are
                     @demake/chip's GbApu behind a *permuted register map*, which
                     is `core`'s `asm/gba-sound.ts` and not this package's;
                     `sound.ts` is the pair of converters DMA feeds, which is not
                     the same object as the mixer that decides what to feed them. Thumb, the affine
                     modes and every bitmap mode are absent rather than
                     half-implemented, and the interrupt dispatcher is six
                     instructions of ours rather than Nintendo's BIOS
packages/demotic/    @demake/demotic — Demotic, the `.dmt` game language (docs 14, 15)
  src/lang/          lex → parse → flat statement AST (one statement per line, no nesting)
  src/lang/slots.ts  where a statement's editable parts are, and what may go in
                     each — the parsers' side channel, kept for the block editor
                     the way `lex.ts` keeps comment ranges for the highlighter.
                     Nothing in the compiler reads it, and the one rule that
                     matters is that slots tile the statement they describe.
                     `SourceList` is the half a slot cannot say: which parts of
                     a statement *repeat*, so a rule can be given a third target
                     rather than only the two somebody already typed
  src/lang/highlight.ts  TextMate scopes for `.dmt` source — the registry's words,
                     the lexer's boundaries, and no colours (those are the page's).
                     Its `Scope` union is the repo's whole scope vocabulary, not
                     this grammar's: demakefile/highlight.ts emits from the same
                     one, so a Demakefile and a game share the page's stylesheet
  src/demakefile/    parse, emit, resolve — and highlight.ts, whose word lists are
                     model.ts's own (SINGLE_DIRECTIVES, BLOCK_DIRECTIVES,
                     TARGET_FIELDS) and whose comment rule is parse.ts's own
                     `uncomment`, so a file is never coloured differently from how
                     it is read
  src/compile.ts     AST + console profile → resolved Program tables (constants folded)
  src/sim.ts         the reference interpreter — the semantic definition of the language
  src/level/         .dmtl levels: parse, camera + tile collision, `stream` composition
  src/rng.ts         the game's seeded generator — one definition, shared build and run
  src/testing/       .test.dmt: assertions run against every console at once, and
                     spec.ts — that grammar's own registry, separate from
                     lang/spec.ts because they are separate languages: a `play`
                     in the language reference is a statement no game may use
  src/trace.ts       state traces: the cross-implementation conformance oracle
  src/rom/           the console hand-off: table format, expression bytecode, the
                     built-in tile bank and the trace readers
  src/codegen/       the console backends and what they share:
    backend.ts       the contract — the six questions a console answers, the
                     build's order, and doc 14's seven tick steps in one function
    mos/             the *6502 family's*, not one console's: the 16.16 value
                     layer, the expression compiler, the rule bodies, the tile
                     walk and step 6 of the tick, all shared verbatim by the NES
                     and the PC Engine because a HuC6280 is a 6502 with a mapper.
                     zp.ts names both CPUs' cheap-page windows ($0000 and $2000)
                     in one place, which is what makes an *indexed* access mean
                     the same thing on both
    pack.ts          the run encoder for a map whose entry is a word, which two
                     consoles have — a Sega name-table entry and a PC Engine BAT
                     entry are both two bytes a cell
    shape.ts         what both backends decide identically: scene membership,
                     mutability questions, a tick of movement, the level tables.
                     Anything that would emit an instruction is *not* here
    layout.ts        one RAM allocator over a per-console MemoryPlan (8 KiB of
                     work RAM, or a console with 2 KiB until its cartridge brings
                     eight more). Its cheap region has three behaviours rather
                     than one: it can refuse, it can *spill* to the heap, and a
                     request can *pin* itself to it — which is a 6502's `($nn),y`
                     stated one layer up, where a build report can name page zero
                     rather than an address in hexadecimal
    registry.ts      which backend builds which console; the CLI reads this
    gb.ts, emit/rules/expr/val/tiles.ts   the SM83 backend
    nes.ts, nes-art.ts, nes/              the 6502 backend and its image path
    sms.ts, sms-art.ts, sms/              the Z80 backend and its image path
    snes.ts, snes-art.ts, snes/           the 65816 backend and its image path,
                     and the only one that emits a *banked* cartridge: a game
                     whose program outgrows one 32 KiB LoROM bank gets a bank per
                     scene, reached by `jsl` and returned from by `rtl`. The
                     switch is all-or-nothing and off for a game that fits, so
                     every cartridge that fitted before is byte-identical
    m68k/            the *68000's*, not one console's, and the second directory
                     of its kind after mos/: the 16.16 value layer, the
                     expression compiler, the rule bodies, the tile walk and the
                     tile rules, shared verbatim by the Mega Drive and the Neo
                     Geo. The five files needed no surgery to move, which is the
                     evidence the line was already right — none of them imported
                     a VDP register or a memory plan. What a backend owns beside
                     it is a renderer and nothing else
    md.ts, md-art.ts, md/                 the 68000 backend and its image path
    pce.ts, pce-art.ts, pce/              the HuC6280 backend and its image path,
                     and the smallest in the set — everything but the renderer is
                     `mos/`'s, because this console's CPU is the NES's with a
                     mapper on it
    wsc.ts, wsc-art.ts, wsc/              the V30MZ backend and its image path,
                     and *two* machines: the screen maps, the tile bank, the
                     object table and (on the Color) palette RAM are addresses in
                     the console's own RAM, so `emit.ts` copies rather than
                     uploads and this renderer writes almost no port at all.
                     wsc/machine.ts is the description that makes the mono
                     WonderSwan a variant rather than a ninth backend, on the
                     Mega Duck's terms — four entries, of which the interesting
                     one is that a palette *is* a port over there. val.ts is
                     where this machine's other fact lives — `source()`/`dest()`
                     decide the *segment* a 16.16 read means, because a table is
                     in the cartridge and a variable is not; ops.ts is
                     snes/ops.ts's file for the third CPU whose `abs` means
                     something else again, and is also where `vram` lives —
                     the six operands that mean the *console's* memory rather
                     than the heap, which are the whole cost of the mono
                     machine's heap moving to the cartridge's save RAM
    ngpc.ts, ngpc-art.ts, ngpc/           the TLCS-900/H backend and its image
                     path, and the one whose renderer writes almost nothing at
                     all: there is no video memory, so the tile bank is one
                     `ldir` and a cell is one store. ctx.ts is the shortest in
                     the set — this is the only processor here with both a long
                     conditional branch and a conditional absolute jump, so
                     neither `far` nor `farJump` has a condition to invert.
                     emit.ts's `mapWord` is the PC Engine's and the WonderSwan's
                     shape a third time: nine bits of character and four of
                     palette, so there is no attribute table anywhere in it
    neogeo.ts, neogeo-art.ts, neogeo/     the *second* 68000 backend, and the one
                     that owns least: everything but the renderer is m68k/'s. Its
                     playfield is not a tilemap — twenty-one sticky-chained sprite
                     strips are — so scrolling is two writes and there is no edge
                     painter at all, because a 21×15 plane repaints whole for a
                     few thousand cycles. Its HUD is the hardware's fix layer,
                     8×8 and in front of everything, so the write queue, the erase
                     list and PlotCell are absent rather than reimplemented.
                     machine.ts is where the one expensive fact lives: a hardware
                     cell is 16×16 and a language cell is 8×8, so neogeo-art.ts
                     composes every 2×2 block into one tile at *build* time —
                     legal only while a tile layer cannot change
    gba.ts, gba-art.ts, gba/              the ARM backend and its image path,
                     which is *two* machines: gba/machine.ts is the description
                     that makes a Nintendo DS a variant rather than a seventh
                     backend, on the Mega Duck's terms
    vb.ts, vb-art.ts, vb/                 the V810 backend and its image path,
                     and the only renderer here that emits a *display list*
                     rather than programming layers: seven world entries written
                     once at boot, of which one is the scenery, four are the
                     object worlds the drawing processor counts through to reach
                     group 0, one is the caption plane at its own depth and one
                     ends the list. Scrolling is two halfword stores into the
                     scenery world, so the leading-edge painter is the smallest
                     in the set. Three things in it have no counterpart
                     elsewhere. The multiply pulls in *nothing* — mul leaves the
                     whole 64-bit product and a 16.16 product is its middle
                     thirty-two bits, with no floor correction because an
                     arithmetic shift of a two's-complement product already is
                     one. A `jal` returns through a *register*, so a helper that
                     calls a helper destroys its own return address, which reads
                     as a hang rather than as a wrong number — ctx.enter/leave
                     are the answer, and no other backend needs one because every
                     other console pushes. And an *unaligned* access is masked
                     rather than faulted, so the three structures that interleave
                     a count byte with halfword entries are read and written a
                     byte at a time and the constant pool is aligned before it is
                     emitted (CodeBuffer.align)
    audio.ts         the hand-off to @demake/audio, art.ts's twin
  demo/              terminal runner (play.mjs) and test runner (test.mjs)
packages/chip/       @demake/chip — every sound chip as a register-driven model (doc 16)
  src/gb-apu.ts      Game Boy APU: 2 pulse + wave + noise, envelopes, panning
  src/sn76489.ts     the SMS/GG/SG-1000/MD PSG: no envelopes, ~109 Hz pitch floor
  src/ym2610.ts      the Neo Geo's whole sound system: four four-operator FM
                     channels, three squares, six fixed-rate ADPCM sample voices
                     and one variable-rate one. Its FM section *is* ym2612.ts —
                     OPNB and OPN2 are one core, and the register map says so:
                     offsets 1 and 2 with 0 absent, and key-on codes 001, 010,
                     101, 110. So what this file owes is refusing what the OPNB
                     lacks. Its two ADPCM codecs are not one — A wraps a
                     twelve-bit accumulator and B clamps a sixteen-bit one — and
                     its run loop steps to the nearest event over all four
                     sections, which is why Ym2612 and Ym2610Ssg each say when
                     they will next move
  src/ym2610-ssg.ts  that chip's tone generator, a file of its own because it is
                     a separate generator: its own divider, its own register file
                     at $00-$0D and none of the FM core's arithmetic
  src/t6w28.ts       the Neo Geo Pocket's: that chip's four voices with *two*
                     four-bit attenuators each, one a side — the only stereo in
                     the set that is a level rather than a switch, and the reason
                     this console has no shared register at all. Two write ports
                     carry different registers (tone periods on the left, the
                     noise's own divisor on the right), so `write`'s first
                     argument is the *port*; a driver with the two backwards
                     produces silence rather than a wrong note
  src/ym2612.ts      the Mega Drive's OPN2: 6 four-operator FM voices, 8 algorithms,
                     the hardware's own log-sine and exponential ROM tables. Its
                     LFO modulates the *F-number* rather than the increment,
                     which is what makes one depth the same interval in every
                     octave; SSG-EG is a fold rather than a change, so the
                     envelope keeps counting and only its *reading* inverts; and
                     channel 3's four F-numbers are not in slot order, which is
                     why `SLOT3_FREQUENCY` is a table
  src/nes-apu.ts     the 2A03: volume-less triangle, non-linear mixing
  src/s-dsp.ts       the Super Nintendo's: eight sample-playing voices, BRR
                     decoding, ADSR and GAIN, and a pitch register that
                     *multiplies* where every other chip here divides. Echo and
                     pitch modulation are absent rather than half-implemented
  src/gba-pcm.ts     the Game Boy Advance's sample half, and the only model here
                     that is a *mixer* rather than a generator: six voices, a
                     pitch that multiplies, and an exact integer mix the ARM
                     driver has to reproduce sample for sample. Its register
                     file is demake's own, deliberately shaped like the S-DSP's
  src/huc6280-psg.ts the PC Engine's: six channels and every one of them a
                     wavetable — thirty-two five-bit samples of RAM apiece, which
                     is why this console's *timbre* is a boot decision and not a
                     duty bit. Volume is three attenuators in series in 1.5 dB
                     steps, so a level is a table lookup on a sum. Its LFO is
                     unlike every other vibrato in the set: there is no
                     oscillator, channel two *is* the modulator, so switching it
                     on costs a voice and the depth is a shift on the *divider*.
                     Direct D/A is modelled; what nothing above this file does is
                     stream samples into it
  src/ws-sound.ts    the WonderSwan's: four channels and every one of them a
                     wavetable — thirty-two four-bit samples apiece, and the only
                     chip here whose waveforms are the *console's own RAM* rather
                     than a register file or a sample block, so the model is
                     handed the machine's memory the way its display is. Volume
                     is four linear bits a side; the noise voice picks a *tap*
                     rather than a rate, so a drum has a colour and a pitch.
                     Channel two's PCM voice is modelled — `$90` bit 5 makes the
                     whole of `$89` one sample and `$94` its only level — so this
                     chip can play a recording on one of its four voices. The
                     Hyper Voice stage is a Color addition on ports of its own
                     and is absent; so are the readable output registers, which
                     no reference this project could reach describes
  src/nds-spu.ts     the Nintendo DS's: sixteen channels that are sample players
                     first, six of which switch to a duty generator and two to a
                     noise register — an S-DSP and a Game Boy APU on one die, with
                     a seven-bit panning *level* per channel and nothing shared
                     between them at all. Its source register is an absolute
                     address, so the model is told where the memory it was handed
                     begins. IMA-ADPCM, the capture units and the 32.7 kHz output
                     stage are absent rather than half-implemented
  src/mix.ts         exact box-integration render, DC block, the one renderer.
                     Its one subtlety is a box *narrower than a clock*, which
                     only `GbaPcm` reaches (32768 Hz against a 48 kHz render,
                     because it is a mixer rather than an oscillator): such a
                     box lies inside one clock, so its mean is that clock's
                     value. Dividing by the zero width is `0/0` — an all-NaN
                     WAV — and clearing the accumulator there silences the
                     *next* sample, which is the quieter of the two bugs
  src/stream.ts      the same renderer for a chip that is still running: the
                     ring buffer the web app's ROM pane plays from
packages/audio/      @demake/audio — the music + sound demakers (docs 16, 17, 18)
  src/score/         Score: the hardware-free representation, and the MIDI parser
  src/analysis.ts    roles, salience, sections, loop choice
  src/arrange/       assignment, exchange refinement, and the schedule compiler
  src/binding/       per-console register encoders + the driver-rate fits.
                     pan.ts is the one that is nobody's console and nobody's
                     chip: a stereo position reduces exactly two ways, and which
                     one a channel takes is `AudioSpec.panning`'s answer — two
                     attenuators (`panGains`) or one bit a side (`panSides`).
                     Centre is both sides at full under *both*, which is what
                     lets a part the arranger leaves alone encode byte-for-byte
                     what it did before placement existed.
                     md.ts is the one that drives two chips at once; fm-patch.ts
                     is where a timbre is *searched* rather than selected;
                     t6w28.ts is the one whose `BoundWrite.reg` is a *port*
                     rather than a register number, because that chip has two of
                     them and they carry different things; neogeo.ts is four
                     encoders under one `encode` and the second FM console, so
                     the FM half is fm-patch.ts's called rather than restated and
                     what it supplies is a channel map and a clock. fm-patch.ts
                     is where the *shared* FM encoding lives — the patch and
                     pitch writes, the F-number at a given sample rate, and total
                     level — because two consoles run that core
  src/timing.ts      absolute row placement: the tempo guarantee lives here
  src/sfx/           gesture families, class gate, hardware-in-the-loop fitting
  src/rom/           the console hand-off: schedule packing (data.ts, shared) +
                     a generated driver per CPU (doc 16). SM83: one stream player
                     (gb-driver.ts), two callers — the cartridge (gb.ts) and the
                     driver a game embeds (gb-game.ts). 6502: mos-player.ts, which
                     is the *processor's* rather than either machine's, and three
                     callers — the cartridge (nes.ts) and the drivers two games
                     embed (nes-game.ts, pce-game.ts), because a HuC6280 is a
                     6502 with a mapper. nes.ts and pce.ts are the second and
                     third standalone cartridges in the set and the measurement
                     of what a fourth costs: the player moved not at all between
                     them, so what each owns is a boot sequence, a clock and a
                     cartridge wrapper. pce.ts is also the only one that *has* to
                     strip the boot prefix — five waveforms is a hundred and
                     sixty writes through the register port, more than the packed
                     format's run count holds, so on this console the strip is
                     what makes a schedule packable rather than merely what stops
                     an effect powering the chip up again;
                     Z80: z80-player.ts, which is the *processor's* — a second
                     console started driving one and the walk moved, on
                     mos-player.ts's terms, leaving a chip two hooks: how a
                     packed write leaves the CPU and how a borrowed channel's
                     byte reaches a shadow. sms-driver.ts is what an SN76489 on
                     this CPU owns, with two callers, a game (sms-game.ts)
                     and the fourth standalone cartridge (sms.ts) — which is one
                     file for *two* machines, because a Game Gear is a Master
                     System whose stereo latch is a write like any other, and the
                     only one whose data has a *hole* in it: this console's
                     header is sixteen bytes inside the address space, so the
                     larger board lays its blocks either side of $7FF0 and
                     `DataHole` is where that is decided (padding the whole data
                     section past it, which is what the game backend does because
                     there the code fills that region, would make the larger
                     board unreachable); 68000:
                     md-driver.ts with two callers, a game (md-game.ts) and the
                     fifth standalone cartridge (md.ts) — and the pair is where
                     what a *caller* is gets sharpest, because their two
                     `resolve…Clock`s refuse opposite sources: on this board the
                     FM timer's interrupt goes to the Z80, so a game has to poll
                     it from a loop that is also running a game and gets the
                     loop's rate, while a cartridge whose loop does nothing else
                     gets the timer's. md.ts is also the only one whose *clock
                     register is on the chip it is playing*, which is why it
                     strips the boot prefix — the binding's own `$27 = 0` would
                     otherwise switch off the timer mid-stream; SPC700: spc-driver.ts and
                     spc-game.ts, and it is one of the two that do not run on the
                     console's own processor — what it builds is a block to
                     *upload*. ARM is two consoles and therefore three files:
                     arm-player.ts is the stream walk, which is the *processor's*
                     and neither machine's, and gba-driver.ts/gba-game.ts and
                     nds-driver.ts/nds-game.ts are what each adds to it — a mixer
                     on one, and a whole second binary on the other, because a DS's
                     sound channels answer the ARM7 alone. The Game Boy Advance
                     has two callers — a game (gba-game.ts) and the seventh
                     standalone cartridge (gba.ts), which is the only one in the
                     set whose idle loop is not idle, because half its voices are
                     a mixer the processor computes. The pair is also where the
                     Mega Drive's caller distinction *stops* mattering: neither
                     polls, because the sample transfer's own interrupt counts
                     the blocks out, so both get 128 Hz exactly and the standalone
                     calls resolveGbaClock rather than mirroring it. The DS has
                     two callers as well — a game (nds-game.ts) and the ninth
                     standalone cartridge (nds.ts), which is the only one in the
                     set whose *main processor does nothing at all*: the sound
                     channels answer the ARM7 alone and the loader enters both
                     binaries, so the ARM9's whole program is a branch to itself.
                     TLCS-900/H: ngp-driver.ts and ngp-game.ts, and the only
                     driver that has to *ask* for its chip — a T6W28's own bus is
                     the Z80 sound processor's, so two bytes of the main CPU's
                     I/O page hand it over before anything else is listened to;
                     t6w28.ts is what the *chip* owns, psg.ts's file for a part
                     with two write ports carrying different registers.
                     The Neo Geo's is neogeo-driver.ts and neogeo-game.ts, and
                     it is the only one that is a *cartridge region of its own*:
                     a whole Z80 program in the M region, on a bus the 68000
                     cannot see, clocked by the chip's own timer and asked for
                     things by one byte. It is also the only driver with *two*
                     channel tags — preemption asks which of four borrowable
                     channels a run is on, restriction which of fourteen voices a
                     write belongs to — and the only one whose write has to
                     *settle*, which the hardware documentation warns is why some
                     homebrew plays in an emulator and not on a board;
                     V30MZ: wsc-driver.ts, with two callers, a game
                     (wsc-game.ts) and the sixth standalone cartridge (wsc.ts) —
                     the only driver whose clock is not an interrupt, because
                     this cartridge takes none and reads the vertical-blank
                     timer's counter instead, paying what it finds owed. The pair
                     is the Mega Drive's caller distinction on hardware that
                     reaches it differently: a game polls from a loop that is
                     also running a game and its drift is bounded by a frame,
                     while this one's loop does nothing else and its drift is
                     bounded by a poll — which here buys accuracy rather than a
                     rate, since the counter only moves once a frame. One file
                     for *two* machines, on sms.ts's terms: the two WonderSwans
                     have the same sound hardware, so all it asks the console is
                     the footer's minimum-system byte.
                     V810: v810-player.ts, with two callers, the eighth
                     standalone cartridge (vb.ts) and a game (vb-game.ts) — the
                     only driver whose tick is a *call* rather than a handler or
                     a poll, because this cartridge takes no interrupt anywhere
                     and its main loop already waits a frame per pass on the
                     drawing processor. So `resolveVbClock` is the one clock
                     resolver in the set with exactly one answer to give, and
                     `keep`/`unkeep` in vb-game.ts are what a processor with no
                     push list costs: a routine saves its return address and
                     nothing else, so which registers survive a call is the
                     *caller's* question at every one of them.
                     shared.ts is what none of
                     them owns — the boot strip, the channel restriction, the
                     player's shape — and psg.ts is what the *chip* owns, shared
                     by the two CPUs that drive an SN76489; md-chips.ts is the
                     same for a console with two of them. gameDriverRate says
                     which clock a game's driver rides on a console
  src/binding/sdsp-bank.ts  the Super Nintendo's built-in waveforms: single-cycle
                     BRR blocks, one definition read by the binding (which puts
                     one in a voice's SRCN) and the driver (which uploads them)
  src/binding/gba-bank.ts  the Game Boy Advance mixer's, and nothing like it:
                     signed 8-bit PCM read straight out of cartridge ROM, so the
                     driver lays these same bytes down rather than uploading them
  src/binding/neogeo-bank.ts  the Neo Geo's, and the fourth kind again — *two*
                     ROMs in two codecs, because that chip's two sample sections
                     do not share a decoder. Drums for ADPCM-A (which has no
                     pitch, so a recording is the only thing it can usefully be)
                     and single-cycle waveforms for ADPCM-B (whose rate is a
                     phase increment). Both encoders run the decoders' own
                     arithmetic, which is the only way a search over sixteen
                     codes lands on what was intended
  src/binding/wsc-bank.ts  the WonderSwan's, and the third kind again: this
                     chip reads sixty-four bytes of the console's *own RAM*, so
                     what this produces is a page of bytes the driver copies —
                     neither a sample block nor a stream of port writes. WS_WAVE_BASE
                     is where they go, and it has one definition and three
                     readers, because the binding writes the register, the
                     renderer places the page and the memory plan reserves it
  src/binding/pce-bank.ts  the PC Engine's, and the one that is not a bank at
                     all: this chip's wave RAM is only reachable through the
                     register port, so what this file produces is *register
                     writes* — nothing in ROM, nothing to copy, no address anybody
                     has to agree about. It is also where the five pitched voices
                     are given five different shapes, because on identical
                     hardware which timbre a channel plays is the demaker's
                     choice and it is made once, at boot
  src/binding/nds-bank.ts  the Nintendo DS's: thirty-two-sample cycles, because
                     that chip's pitch is a *divider* and a longer cycle is a finer
                     lattice. A channel reads an absolute address, so the bank has
                     to *be* at the one the binding named — a page of main RAM the
                     driver copies its own bytes into at boot
  src/dsp.ts         deterministic FFT/resampler/pitch, all on core's kernels
  src/manifest.ts    the --emit-manifest sidecar: one shape, two callers (CLI, web)
  src/render.ts      ChipScript → PCM; the only way anything makes sound
  src/encode/        the artifacts. flac.ts is ours for the reason every codec
                     here is — a byte-identical file across three surfaces
                     cannot depend on a library that ships three versions — and
                     is integer throughout. It writes the stream's own MD5,
                     which the format leaves optional, so `flac -t` verifies a
                     decode end to end rather than parsing; LPC is absent
                     because its coefficients are floating-point and this
                     package is under the determinism rule. pcm.ts is the one
                     quantizer, which is what makes "a FLAC and a WAV of one
                     render are sample-identical" true by construction
packages/web/        the site (doc 07): a window — title bar, menus, explorer,
                     one editor, status bar — over seven editors, all but the art
                     demaker code-split (docs 07 §The workbench, 19)
  src/worker/        core.worker.ts (images *and* game cartridges) and
                     audio.worker.ts (music + sound): the only places the page
                     touches an engine, and the only places @demake/core is
                     bundled — a second copy is what the JS budget notices. Extra
                     instances of core.worker are the pool lanes, which is why
                     they cost nothing to download
  src/sections/      the lazy sections; art's panes live in src/components/.
                     LevelEditor.tsx and TextEditor.tsx are the two that edit a
                     *file* rather than demaking one — over lib/dmtl.ts and over
                     nothing at all respectively, since a text editor is a
                     textarea and whichever of the engine's grammars fits
  src/components/    the art panes, the block editor (BlockEditor.tsx over
                     lib/blocks.ts, one component for both `.dmt` grammars) and
                     its symbols (StatementSymbol.tsx — the one thing about a
                     statement the engine does not decide), plus the chrome every
                     section sits inside:
                     Explorer.tsx (the tree, and the only place a file is created,
                     renamed, moved or deleted), MenuBar.tsx (the menus *and* the
                     keybindings, from one array), QuickOpen.tsx (Ctrl+P) and
                     SourceEditor.tsx (a textarea under a coloured <pre>, handed
                     spans rather than fetching them — which is what keeps the
                     language out of the chunks that only need a box to type in)
  src/players/       one module per emulator core, reached through `bootPlayer`'s
                     `import()`, so a visitor downloads the console they are
                     playing rather than all of them. player.ts is the part that is
                     safe to import eagerly: an interface and each console's
                     framebuffer size, pinned against the cores' own constants
  src/lib/           option records ⇄ engine options ⇄ equivalent command line,
                     blocks.ts (a `.dmt` as rows you can drag, where every edit is
                     a splice — the dmtl.ts bargain one file type along) and
                     suite.ts (running a `.test.dmt` on every console, one
                     implementation and two callers),
                     the bundled example projects, and audio-player.ts (playback
                     only). project.ts is the folder the whole page is about;
                     dmtl.ts edits a level as *text* (never a parsed model, so a
                     file the editor did not change comes back byte-identical);
                     tiles.ts draws a tile, for the two panes that draw one;
                     route.ts is what decides which editor a path opens, and the
                     only place that question is asked
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
pnpm gen:console-docs  # regenerate docs/console-support.md + the README tables (build first)
pnpm cli -- build packages/demotic/fixtures/projects/pong/src/pong.dmt -o pong.gb  # a playable cartridge
pnpm cli -- build packages/demotic/fixtures/projects/pong/src/pong.dmt -c nes -o pong.nes  # the same game, 6502
pnpm cli -- build packages/demotic/fixtures/projects/pong/src/pong.dmt -c snes -o pong.sfc # the same game, 65816
pnpm cli -- build packages/demotic/fixtures/projects/pong/src/pong.dmt -c pce -o pong.pce  # the same game, HuC6280
pnpm dev:web       # run the web app against the workspace core (build core first)
pnpm build:web     # typecheck + bundle the web app into packages/web/dist
pnpm test:rom-e2e  # just the emulator E2E suites (needs toolchains + emulator)
pnpm test:browser  # Playwright: web functional + browser-vs-Node determinism
pnpm check:web-budget  # assert the app's gzipped JS stays under the doc-07 budget
pnpm toolchains    # provision every assembler `gen --format rom` needs (cached)
pnpm emulator      # provision the SameBoy capturer + libretro cores for the E2E
```

## Iron rules

- **A demaker spends the whole machine.** The tool constrains a modern asset
  exactly as far as the hardware forces it and no further — a console with ten
  voices gets ten, a console with four sub-palettes gets four. So a `ConsoleSpec`
  describes **what the hardware can do**, not what the engine currently
  implements: a chip with no model is a _gap to close_, never a reason to narrow
  the spec, and "the arranger would promise something it cannot keep" is an
  argument for building the model, not for declaring less hardware. The same rule
  the art path already runs under — an under-fed fit looks like a bad fit
  (§Gotchas) — and it is the reason the tool exists at all. If a demake cannot
  yet reach some of the hardware, say so in the report and in doc 13, and leave
  the spec honest.
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
  `docs/console-support.md` and the **README's two tables** are generated by
  `pnpm gen:console-docs` from the four registries that decide it — the console
  specs, `cli/src/rom/registry.ts`, `demotic/src/codegen/registry.ts` and the
  audio driver table — and `packages/cli/test/support.test.ts` fails if either
  goes stale. Never state a console's support level in prose: prose drifts, and
  both of these had (eight specs claimed a `rom` format with no builder behind
  it; the README claimed six game consoles when there were sixteen). Doc 03
  §Support explains what the columns mean and what _supported_ is.

  The README is **spliced** rather than written, between
  `<!-- generated:name -->` markers, because unlike the matrix it is mostly prose
  somebody meant — so only the part that is a _fact_ is generated and the voice
  around it stays hand-written. Two things about `support.ts`'s splicer are
  load-bearing. It **throws on a missing marker** rather than appending, because
  a generator that silently wrote nothing would leave the staleness test passing
  for ever over a frozen table. And the ladder's rows are stated as **deltas
  computed against each other** (`against()`) rather than as four lists: a
  console that gained a game backend without a display ROM turns that row into a
  list of names instead of a sentence that had quietly become false.

- **A console is called every name it was sold under, and the join has one
  answer** (doc 03 §Names). Half these machines had two — a Mega Drive is a
  Genesis, a PC Engine is a TurboGrafx-16, an NES is a Family Computer — so a
  spec carries `otherNames` in region order (British, Japanese, American, then
  elsewhere, and a region that kept the previous name is not listed twice) and
  every picker shows `consoleLabel(spec)` rather than joining the list itself.
  Two things follow. A regional name must also be an **alias**, or a picker
  offers a name the parser rejects, and `consoles.test.ts` checks all of them.
  And `@demake/demotic`'s profile table restates the label because the simulator
  imports nothing — `profiles.test.ts` cross-checks it against `consoleLabel`,
  exactly as it already does the screen dimensions.
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
- **An entity record is as long as the object needs.** `codegen/layout.ts`'s
  `entityBytes` allocates up to the highest slot the program can _observe_ — the
  collision box always, whatever a rule can write, `value` for a `number`, and
  the movement trio only for something that can move — because the backend
  already folds the rest into the instructions that use it. That is why `PROPS`
  puts `visible` and `value` ahead of `speed`/`xdirection`/`ydirection`: where a
  property sits decides what a coin costs, and a coin is most of the objects in
  a game. Three things read `Layout.entitySizes` and none of them may recompute
  it — the boot restore, each scene's reset, and the `Defaults_` table they copy
  from — and so does `rom/trace.ts`, which reports the _declared_ value for a
  property with no storage rather than whatever the next object left there. Any
  new emitter that reads a property off a record has to ask whether that slot is
  allocated for that instance; reading past the end is a wrong game, not a crash.
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
- **A cartridge is as big as the game needs and no bigger, in every direction the
  hardware allows** (doc 14 §Elastic cartridges). Every console that shipped its games on more than one board takes
  the smallest that holds the program — an NROM-128 rather than an NROM-256, 32
  KiB of Sega rather than 48 and up to 512 for a game that pages, one megabit of
  Mega Drive rather than four, two LoROM banks rather than four, and up to four
  megabytes for a game whose code outgrows a bank — and grows only when the game does. Which boards
  exist is the **console's** answer and lives beside its header in
  `core/src/asm/*-cart.ts`; a backend's job is to pick, and where picking the
  small one moves the code, it emits the program a second time rather than
  patching the first attempt. Never add a size the hardware did not ship: the
  point is the board a game that size shipped on, not the smallest file that
  boots. A Game Boy ROM-only cartridge is 32 KiB and cannot move _down_, because
  the header's smallest size code _is_ 32 KiB; every code above it names a
  mapper, and `stampGbHeader` declares MBC5 for any image longer than that — up
  to the eight megabytes the field can say, which is where a game that pages its
  tick's steps grows (doc 13 §Banked cartridges).
- **`free` is measured against the largest board, never the one that shipped.**
  It is the budget-regression signal (§Testing truths), and a headroom figure
  that jumped by sixteen kilobytes the moment a game crossed a boundary would
  move in the wrong direction — a game getting bigger must never look like a game
  with more room. What was written is `stats.cartridge`.
- **A game that will not fit loses its music first, and is told so.** The build
  binds the audio again with no asset bytes at all and reports it in `stats.cut`,
  so what ships is exactly the cartridge a project with its music left out
  already produces — request bytes and all, so the _trace is unchanged_ and only
  the listening differs. A cartridge somebody can play beats a build error; a
  cartridge that plays silently and does not say why does not, which is why the
  CLI prints a `warning:` line and the page puts a note under the screen.
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
- **An `on hold` snapshot belongs to the property, not to the binding, and the
  hold engages on the button being _down_.** Both halves are what make `left` and
  `right` on one paddle behave: the value saved is the one the property held
  before _either_ went down, so releasing them in the order they were pressed
  cannot write back a direction nothing is asking for, and the survivor takes the
  property over within the tick rather than after a frame of standing still. And
  a scene entered with a direction already held never saw that press — the edge
  belonged to the scene the player left, where the control does not run — so an
  engage keyed on the edge saves nothing and restores nothing, which is a hero
  who keeps walking into the wall after the button is up. `sim.ts`'s
  `updateHolds` is the specification and `codegen/analyze.ts`'s `holdTargets`
  groups the bindings the eight backends share a slot between.
- **A jump needs a `when a pressed if` rule, not a `control`.** Controls run at
  the top of the tick, before anything has been collided with, so a control
  cannot ask whether there is ground underfoot — and a jump that cannot ask is a
  jump you can press forever.
- **A delta a rule adds every tick is written against `fps`, or the game is a
  different game on the WonderSwan.** A `speed` is cells per _second_ and the
  compiler resolves it against the console's rate, but a rule that adds to a
  property runs once a tick and nothing scales what it adds — so gravity written
  as `ydirection + 0.04` falls half again as hard on a machine that ticks 75
  times a second as on one that ticks 60. The caves' hero cleared five cells
  everywhere and four on the WonderSwan, which stopped its climb two thirds of
  the way up the cavern and was invisible from every other console.
  `2.4 / fps` folds to the same constant a 60 Hz console already had, so the
  code eleven of the twelve emit does not change by one byte.
  **And an impulse needs the same treatment, for the other half of the same
  reason.** A tick pulls before it moves, so the first tick of a jump is already
  slowed and a slower machine loses more of the rise — which put the Virtual Boy
  at 50.2 Hz a hundredth of a cell short of a ledge every other console cleared,
  on a staircase whose step _is_ the jump. `- 1.2 / fps` on the impulse is half of
  what the next tick will subtract, and it collapses the apex spread tenfold. What it costs is
  four bytes of RAM: the emitter folds a constant subexpression
  (`codegen/expr.ts` §emitExpr) but `analyze.ts` measures the tree it was
  handed, so the division buys an expression temporary it never uses — and would
  pull in the divider on a game that otherwise never divides. Every fixture in
  the library already divides, so today it is four bytes and a shifted RAM map.
  **A duration is the same problem**: `guard.value as 120` is two seconds only on
  a machine that ticks 60 times a second, so quest writes `2 * fps` and reads its
  boss timer at `fps * 7 / 6`.
- **A level is at least as big as the widest screen that will show it.** Which
  is forty-eight cells by twenty-eight, the Virtual Boy's — a third wider than a
  Mega Drive's, which held the record until this console arrived and quietly made
  `quest`'s vault too small (`E_LEVEL_TOO_SMALL`). A level meant to fill the view
  exactly and never scroll has to be sized against the _widest_ machine in the
  table rather than the one it was drawn on.
- **A ledge wants three clear rows above it and a surface within four rows
  below.** A hero is two cells tall and a jump rises five, of which the top one
  is spent getting _above_ the ledge rather than into its side — so a ledge four
  rows above the one below it is a step, one six rows above it is scenery, and
  one flush under a level's roof has nowhere to be above and cannot be landed on
  at all. The caves' exit and one of its coins sat on two of those for months:
  drawn, demade, shipped, and reachable only by a _wall hop_ — a solid ledge
  grants footing from its side, so a falling hero can take footing off the face
  of one and jump again — which is a bug being exploited, not a route.
  `level.test.ts` checks both conditions on the cavern; the horizontal reach it
  cannot check, and the interpreter is the oracle for that.
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
  fixture is held above a kilobyte of headroom by the audio battery, because a
  fixture built to the last hundred bytes turns the next codegen change into a
  mystery.
- **And it costs differently on the NES.** The audio itself is _cheaper_ on that
  machine — 1742 bytes against the Game Boy's 2076 for the shooter, because the
  driver ticks at 60 Hz rather than 120 — but the game around it is not: the same
  program's 6502 code is about 3.8 KiB larger than its SM83 code, and a backdrop
  is a 960-cell nametable against 360. The shooter used to be a couple of hundred
  bytes _over_ there and the battery asserted the overflow; the packed name
  tables, the looped collision pairs and the grouped integrator won it back, and
  it won that back. `OVER_BUDGET` is empty as a result, and the emptiness is the
  record.
- **And `free` is no longer where a budget regression shows, on any console.**
  Every family now pages, so `free` is measured against the largest board its
  hardware shipped on — eight megabytes on a Game Boy, 512 KiB on a Sega 8-bit,
  256 on an NES — and a fixture with a quarter of a megabyte spare is not a
  fixture anybody is watching. **What a banked cartridge cannot grow is its fixed
  bank**, and that is the number to watch instead: quest's is 15973 bytes of
  16384 on a Game Boy and 8109 of 16384 on an NES, so 411 bytes is the tightest
  figure in the project. Nothing about taking a bigger board adds a byte to the
  half that cannot move (doc 13 §Banked cartridges), so an emitter that puts
  something new in the always-mapped half is spending that 411 — and a size sweep
  measuring `free` will not notice.
- **New language features come from the example library, not from theory**
  (`packages/demotic/fixtures/games/`). Each example is there for something the
  others do not exercise; `touches`, the `reaches` crossing rule and `visible`'s
  collision meaning were all found by writing one.
- **A rule that names a class covers every scene that class lives in.** `quest`
  is written that way — almost every rule names `hero` rather than one of its
  four hero objects — because a class rule binds each instance in turn and skips
  the ones whose scene is not running. One line of gravity is gravity in all four
  levels. What cannot do it is a rule a _button_ fires: an input trigger binds
  nothing, so `a pressed` has to name an object and is written per scene.
- **State that outlives a level is declared in the scene the game starts on.**
  Entering a scene resets that scene's objects, so a counter declared in `play`
  is a counter that goes back to zero every time the player dies. `quest` keeps
  coins, lives and the power-up in `title` and reads them from everywhere, which
  also makes "reaching `title` is a new game" a fact rather than a reset routine.
- **A landing rule wants `ydirection > 0`, not `>= 0`.** A cell-wide hero under a
  ledge touches two of its cells in one tick; the first hit sets `ydirection` to
  zero and `>= 0` reads that back as a landing on the second — so bonking your
  head hands you a jump, in mid-air, for ever.
- **A contact says which side it happened on, and `from` is how a rule asks.**
  `when hero touches ledge from above` fires only where the hero was above the
  ledge — the subject's side, not the direction of travel — so footing is taken
  from a landing and not from a platform's edge. The side and the separation are
  one decision (`level/scene.ts` §contactOf: choosing the shallower axis and a
  direction _is_ choosing the side), so a rule and the push that follows it
  cannot disagree — which is why every backend now emits **one** piece of
  arithmetic for both. Separation was split into a part that _decides_
  (`emitPairPushes`, `emitTilePushes`) and a part that _applies_, and
  `ContactSide` / `emitTileSide` are the decision read out as a {@link
  SIDE_BITS} bit instead of a push. Three things about the shape are worth
  keeping. The bit numbering is `shape.ts`'s and comes from the language
  registry, so a rule compiles to one `and` and one branch on every console and
  no backend picks its own encoding. The gate is placed so a side the rule did
  not name skips the **whole** contact — no fire, no separation, no contact bit
  — because that is what the interpreter's `continue` does, and a cartridge that
  separated anyway would drift a tick later. And it is _pulled_: a game with no
  `from` in it emits not one instruction, which is what kept every existing
  cartridge byte-identical when this landed.
- **Without `from`, a contact still says nothing**, which is what shaped `quest`.
  An `else` that stops a rise belongs on a rule naming only tiles that are
  overhead, or it cancels a jump every time the hero brushes the edge of the
  platform it was aiming for. And footing granted by a landing surface is granted
  from its _sides_ too, so a solid slab of ground is a slab you can inch up:
  `quest`'s levels make every landing surface one cell thick with `bedrock`
  underneath, and its pits six cells wide, because a hero two cells tall catches
  the far lip of anything narrower instead of falling clear. Those are geometry
  standing in for a rule, and they are rules now that the backends have caught
  up — `platformer` is the one that says so, where landing and bonking are two
  rules naming two sides rather than one rule and a velocity test.
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
- **And write a duration in _seconds_, for the same reason.** `play 4 seconds`
  and `hold left for 5 seconds` are resolved against the console's `fps` by the
  runner — the one place a rate enters a script — exactly as a `speed` is
  resolved at compile time. A tick count was portable only while every console
  ticked sixty times a second, and the WonderSwan Color does not: it runs at
  75.47 Hz, so `hold right for 42 ticks` covers three quarters of the ground
  there. `ticks` is still a unit, and the suites keep it for the two- and
  eight-tick waits that give a rule an edge to fire on — but anything that means
  _an amount of elapsed game_ is a duration.
- **An assertion about what happens after a scene change is usually not
  portable.** `quest`'s pit test asserted a power-up's value after a death _and a
  level restart_ — a second run at the same level, whose progress when the script
  stops depends on where the first one ended, which tick quantisation makes
  differ per console. What such a test can assert is the scene.
- **Every suite opens with `press a`,** because every game opens on its title
  screen. It is one line of ceremony in exchange for the title screen being part
  of what the suite checks rather than something it routes around.

## Writing music and sounds for the example library

Same bargain as the art: hand the demakers what a modern game would have and let
them do the work. Generators live in the session scratchpad; the `.mid` and
`.wav` files are the artefact.

- **Do not write chip music, and do not write for the smallest machine.** The
  MIDIs are full arrangements — around ten parts: bass, sub, chords, pad,
  arpeggio, melody, harmony, counter-line, echo, drum kit — because the demakers
  are supposed to be handed what a modern game would have. Two things go wrong if
  they are not. A two-voice MIDI proves nothing and hides every interesting
  decision on a four-channel console. And a _four_-part MIDI hides every
  interesting decision on the wide ones: a Mega Drive has ten voices and a
  Nintendo DS sixteen, so four parts leave twelve channels idle and make a
  spent machine look identical to a starved one. The fixtures were four-part
  once and that is exactly what it cost — the rule is the art path's, restated
  (§Drawing art: never author at the smallest target's resolution).
- **A part count is a floor, not a target.** The arranger takes as many parts as
  the console can play and drops the rest by salience, so more parts is strictly
  more information: the small consoles show it _choosing_ and the wide ones show
  it spending everything. `demake arrange --json` reports the channels used, the
  parts dropped and where each channel was **placed** across the stereo image;
  check all three when you add a tune.
- **A tune with one accompaniment line is a tune with nothing to place.** The
  arranger centres bass, percussion and the most salient lead, and spreads what
  is left — so a MIDI whose parts all classify as `lead` or `bass` produces a
  nearly mono arrangement on a wide console however many voices it fills. That
  is the classifier being coarse rather than the placement being timid (five
  `lead` parts is the usual result for these fixtures), and it is another reason
  to give every part the General MIDI programme a real arranger would.
- **Give every part the General MIDI programme a real arranger would.** It is not
  decoration: `analysis.ts` takes a _role prior_ from it, so a programme is how a
  part says what it is for. A counter-line under a lead patch is classified as a
  lead, competes with the tune for the channel that suits one, and wins on a tie
  — which is exactly how a Game Boy came to play two accompaniment lines and no
  bass. Check the roles the classifier settled on before checking anything else.
- **A widened arrangement is also a test of the arranger, and it found two
  faults.** Salience saturated — every lead-role note scored exactly 1.0, so two
  leads were indistinguishable — and the planner ranked purely by worth, so five
  melodic parts filled a four-channel console and left no room for the bass or
  the kit. Both are fixed (`analysis.ts` §scoreSalience, `plan.ts`
  §byWorthThenBreadth). Neither was reachable with four-part fixtures, which is
  the argument for widening them in one line.
- **Two of the melodies move the modulation wheel, and the rest are dry on
  purpose.** Vibrato is read off controller 1, so a library that never touched
  it left the feature proved by tests written for it and by nothing that ships —
  the four-part problem again. `pong/rally.mid` and `platformer/meadow.mid` put
  it on track 3, which is programme 80 in both: the synth lead, the one
  instrument in these arrangements a player leans on a held note with. Those two
  files rather than any others because each is where a suite already looks —
  `pong` is the project `_audio-battery.ts` builds for its register battery on
  every console with a driver, so a vibrato's writes are diffed tick for tick on
  every machine with a driver and on both routes to a chip; and the platformer is the one
  fixture whose NES build fits an NROM-128, so it is where the size sweep pays
  for vibrato on a small board. Leave the rest dry: not every tune is played
  with vibrato, and a modulated held note is a pitch write per tick wherever the
  hardware will not do it — `rally.mid` costs the Mega Drive 5.2% more writes
  and a Master System 42%, which is the difference between spending an LFO and
  writing the modulation.
- **Do not synthesize square waves for effects either.** The sounds are built
  from harmonics, filtered noise and decay envelopes, so the class gate has
  something to classify and the gesture tournament has something to choose
  between. A source that is already a chip blip makes the sound demaker look
  perfect and tests nothing.
- **Length is the cost, and density is too.** Bars are cartridge: eight bars is
  around five kilobytes of schedule on a four-channel console, and a game with
  4 KB free gets two bars. Adding _parts_ is nearly free there — only four of
  them are ever played — but adding sixteenth-note lines is not, because whatever
  channel takes one writes four times a beat. A sixteenth-note arpeggio across
  eight bars is what put the library over the Game Boy's 16 KiB schedule budget
  the first time these were widened. Check the headroom before making a tune
  longer _or_ busier.
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
- **And the console with the shortest frame is where it is measured second.** A
  WonderSwan draws 75.47 times a second where every other machine here draws
  sixty, so a tick has a fifth less time to fit in and this is the machine a
  costly routine shows up on first. It is what found the decimal renderer walking
  the powers of ten by subtraction — an eighth of a tick spent printing a
  two-digit coin counter, on a processor that can divide — and `rom.test.ts` now
  measures `caves` there as well as on the Game Boy. The profile that found it is
  the same one every other optimisation came from, weighted by _cycles_ rather
  than by instructions: on a machine whose main loop polls a line counter, two
  thirds of the instructions retired are the poll, and an unweighted histogram
  says nothing at all.
- **Profile before optimising, with the real tool.** Build with
  `--format sym`, run the ROM in `@demake/dmg`, and bucket `cpu.pc` by symbol.
  Because the code is generated _for this game_, the histogram names the game's
  own rules — not which part of an interpreter is slow. Every optimisation so far
  came from that histogram and none from intuition.
- **The conformance suite is the safety net, so use it.** `pnpm test
packages/demotic/test/rom.test.ts` builds every fixture game and diffs raw
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
  is the tightest fixture; the audio battery holds the three biggest above 512
  bytes free, against 1 KiB for the monochrome build, and the difference is
  measured rather than a policy.
- **Demaking a picture in colour is seconds, not milliseconds**, because it is
  the whole `prep` tournament rather than the mono path. `bindArt` memoises the
  conversion by content hash, which is what keeps the web app's per-keystroke
  rebuild instant and the test suite under its budget; the cache is a speed
  optimisation over a pure function and must never become one that changes
  bytes. The web app's ROM pane says "demaking…" and stays live while it happens,
  because a tab that silently stopped for five seconds looks broken.
- **And every art module memoises, so a new one is not finished until it does.**
  All eight keep the same pair of caches, because the argument is the console's
  only in its numbers: a picture is a tournament and the callers ask for the same
  one over and over. `nes-art.ts` was the one that did not, and it cost 98
  seconds in a single test file — a fixture built four times over is four whole
  fits of the same two pictures. Two things about the key. **The budget is in
  it** on any console that shares a bank out (the NES, the Mega Drive, the Game
  Boy Advance): what a picture may spend is what the ones before it left, so the
  same bytes at different room are two different fits and a key that dropped it
  would hand the second one the first one's pixels. And **the executor is not**,
  for the reason `convertBackdrop` states — which is what `_fanout.ts` builds
  spread-first to work around, so a battery that warmed the cache the other way
  round would compare two cache hits and pass without a candidate ever running.
- **A build is a fan-out, and the order things are _interned_ is not the order
  they are demade in.** `buildRom` demakes art and audio at the same time
  (`allSettled`, so art's error still wins), and the Game Boy converts a scene's
  backdrops concurrently — but interns them in scene order, because a tile's
  number is where it landed. The NES converts its backdrops one at a time instead:
  what a picture may spend is what the ones before it left. Both are correct and
  they are correct for different reasons, so neither may be made to look like the
  other. `packages/demotic/test/_fanout.ts` builds the library under an
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
- **A game that outgrows 32 KiB pages its tick's steps, and the hard part is
  bank zero.** The Sega's unit reached one console along — a step, plus each
  scene's reset, camera and render, all entered through `ctx.callUnit` /
  `ctx.jumpUnit` — but the _fixed_ half here is sixteen kilobytes against that
  machine's thirty-two, so three blocks of **data** are paged units as well: the
  tile art, the packed audio schedules, and the instance defaults. Quest's bank
  zero is 15973 bytes of 16384, which is the tightest figure in the project, so
  anything a new emitter puts in the always-mapped half is worth counting. The
  level tables are what is left to page if it ever runs out, and they cost
  duplication rather than two instructions, because more than one step of a scene
  reads them (doc 13 §Banked cartridges).
- **The instance defaults are paged _twice_, and the second copy is the point.**
  The boot restore wants every entity's at once and pages the whole table in; a
  scene's reset wants its own scene's and is itself a paged routine, so it cannot
  read a table in another bank and carries a copy of just those. Both go through
  `shape.ts`'s `emitInstanceDefaults` rather than restating the encoding, so the
  copy really is a copy.
- **The timer handler saves the bank and puts it back, from a shadow.** MBC5's
  bank register is write-only, so `Ctx.bankShadow` is the only record of what is
  in the window — and this console's audio is entered by an _interrupt_, so a
  tick can arrive with any bank at all. Nearly half of every game tick runs from
  `$4000`, so skipping the restore returns into another bank's instructions at
  the same offset. It is invisible to an audio diff, because a driver that never
  restores leaves its own bank mapped for ever and plays on perfectly while the
  game is dead — which is why `rom.test.ts`'s quest case is the one there that is
  handed a game's audio.
- **Emit the paged banks first and bank zero last.** `Asm.section` moves no
  bytes, so the order is free — and it has to be this one, because helpers are
  _pulled_ by whatever calls them and `ctx.finish()` has to be the last thing
  that runs. `gb.ts` copies each bank into place afterwards, which is a copy per
  bank and no more.

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
- **But it _spills_, and what may not spill is decided per request.** Almost
  nothing the allocator places on this CPU is ever dereferenced — a contact
  bitfield is read `$nnnn,x`, a temporary goes through `clamp32` — so a game
  refused for wanting 274 bytes of a 237-byte page was a game refused for wanting
  cheap addresses it did not need. `fastSpills` is set here now and the overflow
  goes to the board's own RAM. What may not move goes through `pin`, and there
  are exactly **two**: the tile walk's cursor, and the audio driver's state,
  because a stream player walks packed data through a pointer like everything
  else on this machine. Add a third and it has to be `pin` as well — a pointer
  that spilled would assemble an instruction reading the wrong two bytes rather
  than failing.
- **A spilling request leaves room for the pins still to come.** `Bump.tryTake`'s
  `keep` is that, and it exists because serving the pins first is not open to us:
  the order of these calls is the order of the addresses, so reordering would move
  every address in every game that already fits. Without it the build refuses a
  game for wanting a page it was perfectly willing to spill out of, which reads
  like the spilling not being there at all.
- **A game that outgrows 32 KiB takes an MMC1 and pages its tick's steps, and
  the halves are the other way up.** The fixed sixteen kilobytes is at `$C000`,
  because that is where the vectors are and what mode 3 leaves in place, so a
  paged unit is assembled at `$8000` and the boot, the helpers, the audio driver's
  code and the dispatches stay above it. Two data blocks go up with the scenes —
  the packed schedules and the instance defaults — and the tile art does not,
  because characters here are a separate ROM the PPU addresses directly.
- **A mapper write is ten instructions, and never one an interrupt can split.**
  MMC1's register is _serial_: five stores of one bit each, so `ctx.enter` builds
  the value with `lsr` between them, and a sequence broken halfway leaves the
  register holding bits from two different values with nothing able to put it
  back. That is affordable only because this console counts its audio tick in the
  NMI and _performs_ it in the main loop, so the handler touches nothing but a
  counter and the frame upload — both in the fixed half. An emitter that put a
  bank write in a handler would break a cartridge in a way no register diff can
  see.
- **The level tables are copied into every bank that reads one.** More than one
  step of a scene reads a level — the tile rules and the render — and a paged
  routine cannot reach a table in another bank, so this is the one console in the
  set that duplicates rather than shares. It is one field: `LevelData.suffix`,
  set by `levelCopy`, and every reader already takes a `LevelData` and reads its
  labels off it — so no emitter knows copies exist. The planner is where it
  shows, because a bank is charged for the copies its units drag in.
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

### The HuC6280 half

`demake build -c pce` builds a playable HuCard, and the whole example library
traces identically on it. Almost nothing here is arithmetic: the CPU is a 6502
with three habits and `codegen/mos/` is shared verbatim, so what is left is a
renderer and the four ways this machine's _addresses_ differ.

- **Zero page is at `$2000` and the stack at `$2100`.** The CPU adds the base to
  every zero-page operand and no memory map moves it, so a plan's addresses are
  the machine's: `PCE_MEMORY`'s cheap page runs from `$2013` to `$2100` and its
  heap from `$2400`. An _unindexed_ access takes the operand — `mos/zp.ts`'s
  `mem` reduces it — and an **indexed** one takes the address as absolute, which
  is why `absX(layout.contacts)` needs no translation and is the whole reason the
  two windows are named in one file. Get it backwards and a game's contact bits
  land in the video chip's register page: it traces almost right and one alien
  never turns round.
- **A pointer is an operand and a plan's pointer is an address.** `($nn),y`
  encodes an offset into the cheap page, so anything the allocator _placed_ — the
  tile walk's cursor, the object shadow's — goes through `slotOf` before it
  reaches an instruction. It raises rather than assembling something that reads
  the wrong two bytes.
- **The program is not where it was assembled.** The mapper's eight pages hold
  the hardware, work RAM, and the code and data between them, so a build has
  `$4000`–`$FFFF` and no more. Reset maps cartridge bank 0 at `$E000` and nothing
  else at all, so the boot stub is emitted _last_, padded to `$E000`, and
  `assemble` swaps the halves: the top 8 KiB of the window is bank 0 of the image
  and everything below it follows. A build that wrote them in the obvious order
  boots into the middle of a rule body.
- **One instruction fills video RAM.** `tia src, $0002, n` walks the source into
  the data port with the destination alternating between its two bytes, which is
  exactly a word write — so the character bank, the sprite patterns and a palette
  upload are one instruction each. It destroys `A`, `X` and `Y`, which is why the
  object upload is the last thing `BuildFrame` does.
- **The map is bigger than the screen on both axes and both wraps are powers of
  two.** 64×32 against 32×28, so a scrolling scene paints its leading edge where
  nobody is looking, none of the Master System's masking exists, and the cell
  address is `(row & 31) << 6 | (col & 63)`. A level the map holds whole is
  painted once and scrolled by the register alone, which is the NES's `pinsRows`
  problem simply not arising.
- **A cell carries its own sub-palette**, so there is no attribute table and no
  16×16 block: a caption's cell names the font's palette and the NES's whole
  compile-time attribute machinery is absent. Fifteen sub-palettes are the art's
  and the sixteenth is the font's, on both layers.
- **Colour zero of every background palette is the one shared backdrop**, so a
  caption's _paper_ is whatever the picture chose and only its ink is decided —
  and it is decided per scene, against that backdrop, exactly as the NES's is.
- **There is no 8×8 sprite.** An object is 16×16 at its smallest, so `pce-art.ts`
  composes four 8×8 tiles into each pattern and an object `w` cells wide is
  `ceil(w/2)` entries — a quarter of what it costs elsewhere, into a per-line
  budget of sixteen. A HUD glyph is a whole 128-byte pattern, so those are
  _pulled_ like a helper and a game with no scrolling HUD ships none.
- **The sprite table is copied, not read.** The chip fetches 256 words from
  `DVSSR` at the top of every blank, so the runtime writes its shadow into video
  RAM during _active display_ — from the main loop, not the handler — and the
  objects then land on the same frame as the background the blank uploads. Doing
  it in the blanking interval instead is a game whose sprites lag its scenery.
- **`CR`'s increment select is bits 12 and 11.** A step of one map row is `$10`
  in the high byte and not `$08`; one bit out and it steps thirty-two words, so
  every other cell of a scrolled column lands a row early. `packages/pce/test/vdc.test.ts`
  is what found it.
- **The audio clock is the CPU's own timer, and the game only counts it.** Seven
  bits of reload at master ÷ 3 ÷ 1024 gives 54.6 Hz to 6991 Hz, so 120 Hz is half
  a hertz out and a game gets the Game Boy's rate rather than the NES's. The
  handler increments a byte and the main loop performs what it says — the vertical
  blank belongs to the picture — and counting rather than riding is what makes a
  frame the game overran cost it no tempo. Which interrupts the cartridge answers
  is decided in the _reset's_ mask, because that is the console's policy; the
  driver's `AudioInit` programmes the timer's two registers and nothing else.
- **The chip's initialisation is a table, not a run of stores.** Uploading five
  waveforms is a hundred and sixty writes through the register port, so `AudioInit`
  walks `(register, value)` pairs with a `$FF` terminator — four hundred bytes of
  data instead of a kilobyte of code. It borrows the run walk's scratch as its
  pointer, which is safe because nothing else is running yet and those two bytes
  are adjacent for the stream player's sake.
- **Six channels against a four-bit run field, and they do not have to fit.**
  `pcePackTag` numbers only the channels effects were placed on, exactly as the
  Mega Drive's and the Nintendo DS's do, so the other voices tag zero and a track
  plays _through_ an effect rather than ducking for it.

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
- **Past 48 KiB the cartridge pages slot 2, and the unit is a tick step.** This
  console's window is 16 KiB and the biggest scene in the library is 26, so
  unlike the Super Nintendo it cannot take a scene per bank: a scene's tick
  becomes a run of calls in the fixed half that pages each of its seven steps in
  turn, plus its reset, camera and render. What decides the split is that **slots
  0 and 1 never move**, so 32 KiB holds everything an always-mapped address
  reaches — the boot, the vectors, the helpers, the audio driver _and its
  schedules_, because an interrupt enters it — while the tile art goes _up_,
  since the boot uploads it once and nothing reads it again. Three things follow.
  Nothing saves or restores the bank, because only the fixed half enters a paged
  routine. A paged routine calls and reads downwards, so not one byte of the
  value layer or the rule bodies changed. And `AsmZ80.section` moves no bytes, so
  the paged banks are emitted first and the fixed half last — `ctx.finish()` has
  to be last — and `sms.ts` copies each bank into place. A game that fits a flat
  board pages nothing and is byte-identical.
- **Forty-eight kilobytes is flat, and that is the mapper's doing not ours.** The
  mapper is in the cartridge rather than the console and comes up with its three
  slots holding banks 0, 1 and 2, so `$0000`–`$BFFF` is one continuous image and a
  program that never writes a bank register never notices. `SMS_FLAT_ROM_SIZES`
  is the list; the build assembles the 32 KiB cartridge first and only
  reassembles when the game does not fit, which is what keeps every existing
  cartridge byte-identical. The catch is the header: sixteen bytes _inside_ the
  image at `$7FF0`, and a game whose _code_ runs past it cannot be laid out this
  way at all and is told so by name.
- **The header hole is stepped over one data block at a time, and the sizes come
  from the pass before.** Everything after `ctx.finish()` is addressed by label
  rather than by a branch, so a block that moves takes its label with it and
  nothing else notices — which means the question is per block ("would _this_ one
  be laid across `$7FF0`?") rather than one wholesale pad to `$8000`. It has to
  be, because padding the whole data section past the header throws away
  everything between the end of the code and `$7FF0`: up to thirty-two kilobytes
  for a game whose code is short and whose tables are long, and 1223 bytes on the
  smallest game that reaches the larger board at all. What makes it possible is
  that the answer needs a length the emitter does not have until the block has
  been emitted — so it is taken from the pass that has already happened.
  `sms.ts` assembles once with no hole to find out whether the game fits below
  `$7FF0`, that pass emits the same blocks in the same order, and
  `EmittedProgram.blocks` is what it measured. The two passes are compared
  afterwards, because a size list that had drifted would place the hole somewhere
  plausible and wrong. The audio driver's schedules are the one block that places
  _itself_ — dozens of small label-addressed blocks rather than one, so
  `emitData` is handed the hole and steps over it at whichever of its own
  boundaries falls there, exactly as the standalone cartridge already did. It had
  to come before slot-2 paging, because paging inherits the same hole: a banked
  cartridge's fixed half is still slots 0 and 1, and `$7FF0` is still inside it.
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
- **The frame is the driver's clock, and the line interrupt is not — on either
  kind of cartridge.** This VDP reloads its line counter on every scanline
  outside the active display, so an interrupt programmed for every 65 lines
  fires twice inside the picture and then not at all for seventy lines: two
  ticks a frame, in a burst, out of the four the rate claims. `psgBinding.fitRate`
  used to offer those rates to a _standalone_ track on the grounds that only a
  game shares its clock with the picture, which is the wrong reason — the reload
  is the hardware's and does not care who is asking. It offers the frame and
  nothing else now, and the spec's `driver.sources` says so.
- **A Master System has no register two streams share.** Four attenuation latches,
  four channels, nothing carrying more than one of them — so no merge routine is
  emitted at all. The Game Gear's stereo latch is `NR51`'s exact shape and brings
  it back, expanded by one instruction because the Z80 has no `swap`. That is the
  only thing in the driver that differs between the two machines.

### The 65816 half

`demake build -c snes` builds a playable LoROM cartridge, and the whole
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
- **The direct page is the one cheap region in the project that is an
  optimisation and not a capability, so filling it costs bytes rather than the
  build.** Two hundred and thirty-eight bytes, and `$nn` is two where `$nnnn` is
  three — but the index registers reach all of bank zero, so nothing the
  allocator hands out _has_ to be down there and `at65816` already picks the long
  form for an address that is not. `MemoryPlan.fastSpills` is set here and
  nowhere else: on a 6502 the same overrun has to stay fatal, because `($nn),y`
  is that CPU's one indirect mode and a pointer that spilled to the heap could
  not be dereferenced at all. Only a request the region cannot hold moves, so a
  game that fits keeps every address it had — which is what let this land with no
  trace re-baselined. `quest` was one byte over.
- **A program that outgrows a bank calls with `jsl` and returns with `rtl`, and
  the switch is all-or-nothing.** `jsr`, `rts` and `jmp` carry sixteen bits and
  take the seventeenth from whichever bank the processor is already in, so a
  scene emitted into bank four cannot be reached or returned from by any of them.
  Which of `rts` and `rtl` a routine ends with has to match how _every_ caller
  reaches it, and "which callers share this routine's bank" is not a question an
  emitter can answer while it is still deciding where things go — so `ctx.banked`
  converts the whole program or none of it, and `snes.ts` assembles a game that
  fits one bank exactly as it always did. Every existing cartridge is
  byte-identical because of that, and `snes-banked.test.ts` reads the opcode at
  `TickDone` on both kinds of build to say so.
- **All the data stays in bank zero, which is what makes banking cheap here.** A
  level's grid, a packed backdrop, the instance defaults and the constant pool
  are read with the data bank register at zero, so a scene in bank four reads its
  own level with the same absolute instruction it used when it was in bank zero.
  Not one data access changes. The corollary is the constraint: anything an
  emitter puts in a high bank has to be reached by `long`, and nothing does.
- **`Asm65816.section` moves no bytes.** It says which bank the code after it
  lives in, so a label carries all twenty-four bits for `jsl`/`jml` and still
  means its low sixteen everywhere else — which is the hardware's own rule. The
  image stays one linear buffer, and `snes.ts` copies each 32 KiB chunk to the
  bank its plan named. That is also why the emitter puts the **extra banks first
  and bank zero last**: helpers are pulled by whatever code calls them, so
  `ctx.finish()` has to be the last thing that runs.
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
  both screens carry cells once the camera has crossed. **And it is why a
  backdrop is packed thirty-two cells to a row, not sixty-four** — a picture fills
  the left half of the map, but "the left half of a 64-wide row" is not a thing
  the hardware has: screen zero's rows are contiguous at thirty-two words each. A
  row of sixty-four with the right half blank streams into video RAM as a picture
  stretched to double height with every other row empty. It shipped that way and
  a browser is where it was seen, because the level tests walk a grid cell by cell
  and a picture is a _block copy_ — no test in that file could see its stride
  until one was written for it.
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
- **The image has a cartridge bank of its own**, and it did not always. It shared
  the tile art's bank until the example library's music grew enough parts to fill
  eight voices, at which point a track's schedule doubled and took the picture's
  room with it — a game refused for having too much art when what it had too much
  of was music. Bank zero is the program, bank one is the art, bank two (and
  three, where it is long enough) is the sound processor's image, and the three
  are refused separately. **The image is bounded by the _addressing_ and not by a
  bank**: the upload indexes it with `long,X` and `X` is sixteen bits, so it
  reaches 64 KiB from the first byte of bank two — which is why it starts there,
  and why capping it at one bank was an arbitrary halving that went when the
  cartridge stopped being a fixed four banks. What refuses a longer one now is the
  sound processor's own 64 KiB, which is `@demake/audio`'s number rather than a
  board's.

### The 68000 half

`demake build -c md` builds a playable Mega Drive cartridge, and the whole
example library traces identically there. What is new about this machine is that
most of the value layer stops being a problem and three new ones appear.

- **An odd address is an address error, so the allocator aligns.** A word or long
  access to an odd address faults on this CPU, and the shared RAM allocator packs
  bytes — so `MemoryPlan.align` is 2 here and `Bump.take` pads before anything
  wider than a byte. Only multi-byte requests are aligned, which is why no other
  console's memory map moved. The two structures the allocator _cannot_ fix are
  the tile-contact list and the cached cell walk, whose shared strides interleave
  a count byte with word entries: those are read and written a byte at a time.
- **And so is a packed backdrop.** A cell in `packCells`'s stream follows a
  control _byte_, so half of them are odd-addressed. Reading one with `move.w`
  cost the first cell of every picture, which `md-rom.test.ts` found and a
  screenshot would not have.
- **This is the first big-endian console, and `rom/trace.ts` had to learn.** The
  trace reader pulls a game's 16.16 state straight out of work RAM, and a
  little-endian read reports every value byte-swapped — which presents as an
  arithmetic bug three layers from its cause. `MemoryPlan.bigEndian` is how it
  knows. The same fact is why `CELL_OFFSET` is 0 here where every other backend
  says `+2`: the whole-cell part of a coordinate is the _high_ word.
- **`RngAdvance` owns `d0`–`d3`, so a draw's bound lives in `d6`/`d7`.** The
  generator's multiply is three `mulu.w` products and uses the low registers, so
  anything held there across the call is gone by the time the draw needs it. It
  presents as random numbers that are plausible and wrong.
- **A `Bcc` reaches a rule body, not a program.** Sixteen signed bits, which
  covers any one routine and nothing further, so `ctx.far` is one instruction and
  `ctx.farJump` — an inverted branch over an absolute `jmp` — is for the handful
  of places that cross the whole program. Scene dispatch is a _jump table_ rather
  than the comparison chain the other three emit, because a scene's tick routine
  really can be further than a branch reaches.
- **Four sub-palettes, shared between the planes and the sprites.** Not a bank
  each, as on the Sega 8-bits: background art gets two, objects get one, and the
  font gets the fourth. And **colour zero is transparent on both layers**, so a
  caption's paper is register 7's backdrop — which is why the system palette's
  ink is chosen against it, the way the NES backend chooses its caption ink. A
  fixed ramp is invisible over a picture whose colour zero happens to match it.
- **The plane is bigger than the screen, so there is no seam.** 64×32 against
  40×28. A scrolling scene paints its leading edge into a column nobody is
  looking at, both wraps are powers of two, and none of the Master System's
  masking exists here.
- **A sprite list is linked, so parking one means fixing a link.** Each entry
  names the next and a link of zero ends it, which is also why the upload is as
  long as the list rather than as long as the table.
- **The control port is a longword, which the processor performs as two words.**
  Acknowledging the frame interrupt means reading that port, which resets the
  half-written state — the Master System's hazard, reached by different hardware.
  The full redraw runs with interrupts masked for exactly that reason; everything
  else runs a few instructions after the interrupt it waited for.
- **A cartridge is the smallest board that holds the game.** `MD_ROM_SIZES` runs
  128 KiB to 4 MiB and needs no mapper: the console maps the whole cartridge from
  `$000000` and the header records where it ends, so growing one is a bigger array
  and a different number at `$1A4`. One megabit is the floor because that is what
  the early boards of this console were, and every example game is six times
  smaller than one — half a megabyte was four hundred and eighty kilobytes of
  padding. Past 4 MiB it wants paging through `$A130F1`.
- **There is no cartridge-budget story here, and that is the news.** 128 KiB
  against 32 and four megabytes to grow into, and 64 KiB of work RAM against an
  NROM cartridge's 2. The scarce
  resources are the tile bank and the four sub-palettes, so the art path is where
  the interesting decisions are — not the emitter. It is also why the audio
  driver steps over a packed byte rather than forking the packed format to save
  it: on this machine that byte costs nothing worth having.
- **Two sound chips, and the packed byte says which.** The FM chip's four bus
  addresses at `$A04000` are consecutive, so a write to one is an indexed store
  off a held base and the PSG at `$C00011` is one comparison away. Both bases
  live in address registers across the write loop. Nothing about having twice the
  hardware costs the packed format a second shape.
- **A call into the audio driver is a `jsr`, not a `bsr`.** `bsr` is the same
  sixteen signed bits `Bcc` is, and the driver is emitted after every rule body in
  the program — tens of kilobytes away in a real game. Inside the driver the same
  call is a `bsr`, because there the distance is a few hundred bytes and visible
  in one file.
- **`$A11200` is the FM chip's reset, not only the Z80's**, and a console powers
  up with it held. So a cartridge that wants the YM2612 has to take the sound
  processor's bus and then _release_ the reset, in that order — the bus first is
  what makes releasing it safe, because a Z80 whose bus the 68000 holds never
  fetches an instruction. `md-chips.ts`'s `emitZ80Handover` is the one place both
  callers do it, and it is called from the audio driver's own `AudioInit` rather
  than from a game's boot, so a game with no audio emits neither store. Every
  cartridge this tool built left it held until doc 16's Level B measured one:
  0.00046 RMS against genesis-plus-gx where a released chip gives 0.28203, with a
  register diff that was perfect throughout. That is §Gotchas' wrong-and-
  consistent description — `@demake/md` models no Z80, so the store went nowhere
  and the FM voices answered anyway — and the answer was to model the _line_ in
  the core, which is now what makes a cartridge that forgets it fail in
  `pnpm test`.
- **A standalone audio cartridge here has a clock a game cannot have, and that is
  a fact about the caller rather than about the hardware.** The YM2612's timer A
  is a real programmable clock, but on this board its interrupt line goes to the
  Z80 — so a driver has to _poll_ the status byte. A game polls it once per pass
  of a loop that is also running a game, which keeps the loop's rate and not the
  timer's; a cartridge whose loop does nothing else polls every few microseconds
  and keeps the timer's exactly, with the drift bounded by one poll rather than
  by one frame. `resolveMdClock` (`md-game.ts`) and `resolveMdAudioClock`
  (`md.ts`) therefore refuse **opposite** sources, and each says which caller it
  is. Two things follow that no other console needs. The overflow is
  acknowledged with the run bit still set, so the counter is never reloaded and
  the poll's own latency cannot accumulate. And the boot prefix _has_ to be
  stripped — the binding's initialisation writes `$27 = 0`, which is the timer
  control register, so left at the head of the stream tick 0 would switch off the
  clock that was about to deliver tick 1. That is the third distinct reason a
  console strips its boot prefix, after "stop an effect powering the chip up
  again" and "make tick 0 packable at all".
- **The FM chip's timers are bus-visible state, so `@demake/md` clocks it when
  anything can _observe_ it.** Every other chip in the set is write-only, which
  made "advance only when a sample sink is attached" indistinguishable from
  "always advance" — until a driver's clock became a register a cartridge
  _reads_. Two things can observe this one: a sink, and a running timer
  (`Ym2612.timersRunning`), and the condition is both rather than either.
  Gating on the sink alone leaves a standalone cartridge spinning for ever on a
  flag nothing can set; gating on nothing charges every _game_ for six
  four-operator voices no test can hear, because a demade game programmes no
  timer at all — and that is not a rounding error, it is a fifth of the Mega
  Drive audio battery's time budget and it turned CI red on the slower of two
  Node versions. `packages/md/test/sound.test.ts` pins the property; the PSG
  keeps the old arrangement, because nothing can read it.
- **And that battery's cases state their own timeout, because one console's
  binding is a _search_.** `BUILDS_TIMEOUT` in `_audio-battery.ts` is 120 s
  against a default of 20, and the Mega Drive is why: its timbre is searched
  hardware-in-the-loop rather than selected (`binding/fm-patch.ts`), so
  `arrangeScore` takes **8685 ms** on the shooter's theme there against **9 ms**
  on a Master System. That case was spending nineteen of its twenty seconds
  inside a search that is the design working, which is a coin toss on a loaded
  runner rather than a signal. Before optimising anything that battery does,
  check whether what you are looking at is the FM search.

### The ARM half

`demake build -c gba` builds a playable Game Boy Advance cartridge, and the whole
example library traces identically on it. What this architecture makes an
emitter's business:

- **A 32-bit constant does not fit in a 32-bit instruction.** The immediate field
  is an eight-bit value rotated by an even amount, so `movImm32` takes `mov`,
  `mvn` or a _pooled load_ depending on the value — one instruction either way,
  which is what keeps the assembler single-pass. The pool it loads from has to be
  within 4 KiB _ahead_ of the load, so `ltorg()` goes after every routine, past
  the instruction that returns. A pool in the middle of a reachable instruction
  stream is executed.
- **A halfword transfer reaches ±255 and a word transfer ±4095.** That is not a
  detail: the I/O page is a kilobyte and almost every register on this console is
  a halfword, so one held base register cannot reach all of it. It is also why
  `val.ts` has two addressing functions rather than one — `mem` for `ldr`/`str`
  and the four narrow forms only through `loadHalf`/`storeHalf`/`loadHalfSigned`,
  which pick the addressing rather than take it. An emitter that used `mem` for a
  `strh` assembles fine right up until a game grows past the first 256 bytes of
  its own state.
- **`r12` may not hold anything across a call into `val.ts`.** That is the
  converse of the same rule: an address past the base register's reach is
  materialised into `r12` immediately before the access that uses it, so an
  emitter that set a hardware base up there and then loaded a value has silently
  changed where its store lands. It presents as a register that is never written
  — the scroll registers, in the flesh — rather than as a crash.
- **A pool has to be placed, and `poolCheck` is where.** A rule body can be
  longer than the 4 KiB a pooled load reaches, so an emitter calls
  `ctx.poolCheck()` at a safe point — between rules, between objects, inside a
  tile walk — and it puts the pool down over a branch. The check happens while
  the code is being _emitted_, so it costs nothing at run time.
- **`ltorg()` does not branch over what it emits**, so a flush belongs past a
  return or after an _unconditional_ branch and nowhere else. After a conditional
  one the not-taken path falls straight into the words — and a pooled address
  looks like `$030006F4`, which decodes as `mrs r6, cpsr`: a register written
  that the code after the pool may not even be using. The audio driver had
  exactly that for an afternoon and every test passed, because the two registers
  the pool happened to overwrite were dead. Nothing static can catch this; the
  rule is that a flush follows something that never falls through.
- **A 16.16 value is a register, and so is its product.** `smull` gives the
  64-bit product a fixed-point multiply needs, and the barrel shifter folds the
  normalising shift into the instruction that consumes it — so the value layer
  should be smaller than the Mega Drive's, and this is the first console in the
  set with _no_ divide instruction at all.
- **Every instruction is conditional**, so a short `if` is a predicated pair with
  no branch. That is why `ArmCond` is a parameter on every method rather than a
  property of the branch methods.
- **This backend builds two machines, and the difference is a description.** A
  Nintendo DS's 2D engine A is a Game Boy Advance's, so `gba/machine.ts` carries
  the five places they differ and every emitter reads it: where the program lives,
  where objects answer, what has to be switched on, `DISPCNT`'s width, and whether
  the loop waits on a handler or on the beam. Anything that became a `if
(console === "nds")` in an emitter would break the property `rom.test.ts` rests
  on — that the _instructions_ are the same on both — which is the Game Boy
  Color's argument one family along.
- **`DISPCNT` is a halfword on one machine and a word on the other**, and the
  field a Nintendo DS needs is in the half a `strh` never writes. A halfword store
  leaves display mode 0 — the screen blanked — with every other register exactly
  right, which no trace and no register assertion can see. `setDispcnt` is the one
  place it is written for that reason.
- **A video memory the engine allocates is a video memory nobody wrote to.** The
  DS's banks belong to the _machine_, because a bus routes to them; handing the
  renderer its own array instead produced a picture uploaded to one place and read
  from another, with every register correct and the screen black. `PpuOptions`
  takes both arrays for exactly that reason, and `nds-rom.test.ts`'s "draws
  something" case is what found it.
- **Work RAM is two regions and they are not interchangeable.** 32 KiB of
  internal RAM on a 32-bit bus with no wait states, and 256 KiB of external RAM
  on a 16-bit bus with two — so a game's state goes in the internal one and the
  bus model in `@demake/gba` charges for the difference. `wait()` is where that
  is stated.
- **The interrupt vector is not a cartridge's to install.** `$00000018` is BIOS
  ROM, so a handler is reached through the pointer at `$03007FFC`, in IRQ mode,
  with `r0`–`r3`, `r12` and `lr` already saved by the dispatcher and everything
  else the handler's own business. **A game with sound has two sources through
  that one vector**, so the handler becomes a dispatcher: what it takes is what
  is both raised and enabled, and it acknowledges before either half runs — a
  refill that lands during the frame's own work is still counted rather than
  lost.
- **An interrupt return is not an arrival, and a harness has to know.** The BIOS
  returns with `subs pc, lr, #4`, which lands on the instruction it interrupted —
  so a routine's entry address is seen a second time without having been reached
  a second time. On every other console that is a curiosity; here the sample
  transfer interrupts sixteen times a driver tick, so a conformance harness that
  attributes by program counter sees a phantom tick within a few hundred and
  everything after it is one late. `_audio-battery.ts`'s Game Boy Advance target
  filters it by where the step came _from_: a real arrival is from the cartridge
  and a return is from the BIOS.

### The V30MZ half

`demake build -c wsc` builds a playable cartridge, and the whole example library
traces identically on it. This machine's habits are an addressing mode's rather
than an arithmetic unit's — the value layer is the smallest in the set after the
Mega Drive's — so almost everything below is about _where_ a byte is rather than
what is done to it.

- **An operand is a byte after the opcode, not part of it.** Every 8-bit CPU here
  spends an opcode per addressing form and this one spends a _mod/reg/rm_ byte,
  so `ops.ts`'s `abs`/`at` are values a caller builds and one encoder method
  covers every form the operand can take. That is also why this file's `abs`
  collides with the 6502's and the 65816's by name and not by type, and why
  `codegen/wsc/ops.ts` exists to alias the prefixed exports back — the Super
  Nintendo's `snes/ops.ts` for the third CPU.
- **A conditional branch reaches ±128 bytes**, because a near conditional jump is
  an 80386 instruction. `ctx.far` inverts and jumps, exactly as the 6502
  backend's does; a bare `jcc` is for a target a few instructions away in the
  same emitter. The assembler raises rather than wrapping, but the failure would
  still only appear in large games, which is the class of bug `far` exists to
  make impossible.
- **A table is in a different segment from the state.** `DS` is the console's RAM
  and `CS` is the cartridge, so a level's grid or a packed backdrop is read with
  a one-byte override (`romAt`, `romAbs`) and a property is read without one. A
  block copy out of ROM loads `DS` for the length of the copy instead, with
  interrupts off, rather than relying on a prefix surviving one.
- **And a pooled constant is a table.** `ctx.constant()` emits a 16.16 literal
  into the code stream, so it is in the cartridge and reading it with a plain
  data access reads a game's own variables. `val.ts` decides the segment from the
  reference's own type — `source()` for a read, `dest()` for a write, a number is
  RAM and a label is cartridge — rather than leaving it to each emitter to
  remember. Before it did, every comparison against a constant compared against
  whatever state happened to sit at that address, and a game froze on its second
  tick with nothing about the arithmetic wrong.
- **`mul` writes `dx`, and `dl` is a register an emitter reaches for.** The
  product's high half goes there whether the caller wants it or not, so anything
  held in `dx` across a multiply is gone. The cell walk was carrying a legend
  index in `dl` across the entry-offset arithmetic, so every cell of every level
  was recorded as tile zero — a hero standing on solid ground the grid says is
  air, and a trace that names the tick and not the instruction. A stride that is
  a shift and an add costs one byte more and touches nothing.
- **The map a picture is packed into is packed by the art path, not the
  emitter.** `wsc-art.ts` encodes it as it interns the tiles, exactly as the PC
  Engine's does, because the tile pool is what decides a cell's number. Packing
  it again on the way out encodes the _stream_ as a run of literal cells, which
  the blit then unpacks into RAM verbatim: a title screen that boots as its own
  compression format, in every colour the fit chose.
- **There is no video memory.** The screen maps, the tile bank, the object table
  and palette RAM are addresses in the same 64 KiB the game's variables are in,
  so nothing is ever uploaded and the object table is **not a shadow** — the
  display reads it where the runtime wrote it, which is why `WSC_MEMORY`'s
  `oamShadow` names the hardware's own table. Writing it still belongs in the
  blanking interval, because the chip reads as it scans.
- **The HUD gets a plane of its own**, which only the Game Boy Advance has so
  far. `SCR2` scrolls independently of `SCR1` and draws in front of it, and
  colour zero is transparent on both, so a caption's cell is held still while the
  picture slides under it: layer two's scroll registers are written once at boot.
  The sprite HUD, the second decimal renderer and the whole pinning argument are
  absent rather than reimplemented.
- **A cell carries its own palette**, four bits of the map word, so there is no
  attribute table and no 16×16 block — the PC Engine's arrangement. The split is
  the Game Boy Color's and it is forced by the hardware: a sprite's palette field
  is three bits and selects among palettes 8–15, so background art gets 0–6 with
  7 for the font, and objects get 8–14 with 15 for theirs.
- **The map is 32×32 against a 28×18 window**, so a scrolling scene paints its
  leading edge where nobody is looking and both wraps are powers of two. Neither
  the NES's row pinning nor the Master System's seam mask exists here.
- **There is no 8×16 object**, so a wide object costs its width in entries — but
  into a per-line budget of thirty-two, which is four times what the 8-bit
  consoles allow.
- **The loop watches the beam.** This console's interrupt controller vectors
  through the processor's own table in the first kilobyte of RAM, and a main loop
  that waits either way gains nothing from it — the Nintendo DS's reasoning. So
  `WSC_MEMORY` takes no `interruptBytes`, leaves that kilobyte alone, and the
  day this console gets an audio driver is the day one of those vectors is
  wanted.
- **A digit is a division here, not a subtraction loop.** Every 8-bit backend in
  this project walks the powers of ten subtracting one at a time, because none of
  their processors can divide; this one can. Four unsigned comparisons pick the
  power to start at, so a leading zero is never produced rather than suppressed,
  and each digit after that is one `div` whose remainder is what is left to
  print. That was an eighth of a tick on `caves` — a two-digit coin counter — and
  it is the difference between 1.29 frames a tick on this console and 1.09.
- **A cartridge is 512 KiB and cannot move**, because the header's size byte has
  no smaller value to say. Only the last 64 KiB answers segment `$F000` from
  reset, so a program has `$0000`–`$FFEF` — the entry far jump is at `$FFF0`
  because that is physically where the processor starts fetching — and `free` is
  measured against that rather than against the file.

### The TLCS-900/H half

`demake build -c ngpc` builds a playable Neo Geo Pocket Color cartridge, and the
whole example library traces identically on it. This is the widest processor in
the set — thirty-two-bit registers over a twenty-four-bit address space — and
almost everything below is a consequence of one fact about how it is _encoded_
rather than of what it can compute.

- **The operand prefix comes before the opcode.** That is the single unusual
  thing about this architecture and it is why `@demake/core`'s decoder is two
  stages: a byte with bit 7 set names a register or a memory form _and the size
  of the operand_, and the opcode after it says what to do with it. So a
  destination prefix carries no size and a source prefix does, and an emitter
  that hands one where the other is wanted assembles something that decodes.
- **A conditional branch never has to be inverted.** This is the only processor
  in the set with both a long conditional relative branch and a conditional
  _absolute_ jump, so `ctx.far` is a `jrl` — three bytes, ±32 KiB, which covers
  any routine — and `ctx.farJump` is a `jp cc` reaching the whole space in five.
  The 6502, the Z80 and the V30MZ all invert a condition over an unconditional
  jump for the long case; here there is nothing to invert.
- **A shift is one to sixteen, so widening by shifting is two instructions.**
  `exts` sign-extends a word into its long in one, which is what a 16.16 cell
  conversion wants — `sll 16` / `sra 19` is a shift count this assembler refuses
  rather than an instruction that quietly does something else.
- **The index registers have no byte name.** `XIX`, `XIY` and `XIZ` are nameable
  at thirty-two and sixteen bits and not at eight, so a byte held in one comes
  down through `XWA` — `ld xwa, xiy` and then `A` — rather than through a `ld
a, iy` the encoder will not take. Two emitters carry a byte in an index
  register across arithmetic for exactly this reason: the object builder's
  palette and the tile walk's legend index.
- **The program is not addressed where it was assembled from.** The cartridge
  answers the bus at `$200000` and the header is a _region_ in front of the
  image rather than bytes woven into it, so a build assembles at `$200040` and
  `packNgpRom` stamps the sixty-four bytes ahead of it. There is no reset vector:
  the boot ROM reads a 24-bit entry field out of the header and jumps to it.
- **An interrupt handler is a pointer in RAM.** The processor has a vector table
  and the boot ROM owns it, dispatching through a table of its own — so a
  cartridge installs a vertical-blank handler by writing four bytes at `$6FCC`,
  and `$6C00`–`$6FFF` is the boot ROM's and may not be allocated over.
- **There is no video memory.** The two scroll maps, the character bank, the
  object table and the palettes are ordinary addresses in the same space the
  variables are in, so the tile bank reaches the display by one `ldir`, a palette
  block is a second, and a cell is one store. The WonderSwan's arrangement, and
  it deletes about a third of what the Mega Drive's emitter is.
- **The map is 32×32 against a 20×19 window and the plane is exactly 256 pixels
  on both axes**, so the scroll registers _are_ the wrap: a scrolling scene
  paints its leading edge where nobody is looking, and neither the Master
  System's seam mask nor the Mega Drive's `and` exists here.
- **A cell carries its own palette**, four bits of its map word, so there is no
  attribute table and no 16×16 block — the PC Engine's arrangement. Fifteen of
  the sixteen are the art's and the sixteenth is the font's, on _each layer_,
  because this controller keeps a block of sixteen palettes per layer rather than
  one pool: a picture and its sprites can never compete for one.
- **The palette word is BGR, not RGB.** Red is the low nibble and blue the high
  one, which is the opposite of every other RGB444 console in the set. The image
  backend and the art path had it the other way round and it was caught only
  because `@demake/ngp` had been written from the reference first — an encoder
  and a renderer that agreed with each other would have drawn every picture in
  exactly the wrong colours and passed every byte comparison there is.
- **A row of a character is a little-endian halfword**, leftmost pixel in the
  highest two bits, so the _first_ byte of a row holds its right-hand four
  pixels. That is `packPacked2Word` and the `packed2` sprite packing, a packer of
  its own rather than a flag on the planar one.
- **Priority is what hides an object**, and there is no link field. Sixty-four
  fixed entries of four bytes; an entry the frame did not use has its flags byte
  cleared. And the per-line budget is the whole table — sixty-four — which no
  other 8-bit console here can say, so a wide object costs entries and can never
  be clipped mid-line.
- **The map a picture is packed into is packed by the art path, not the
  emitter.** The PC Engine's rule and the WonderSwan's, and this backend broke it
  once: `emit.ts` had a byte-for-byte copy of `pack.ts`'s `packCellPairs` and ran
  it over a map the art path had already packed, so the blit unpacked a title
  screen into the plane as its own compression format.
- **The controller byte's bit layout is unverified and says so.** `$6F82` is
  confirmed by every reference this project could reach and its bit order is in
  none of them, so `NGP_BUTTON_BITS` writes down the natural reading as a _guess_
  — and both the cartridge and the core read it through that one declaration,
  which is precisely the shape §Gotchas warns about. It is a one-line change when
  a source turns up.
- **A processor state is not a master cycle**, and the audio is what made it
  visible. This CPU's instruction timings are in _states_ — the crystal halved —
  and the display controller counts the crystal, so `@demake/ngp` hands the
  display twice what the processor spent and hands the sound chip it unchanged
  (`MASTER_PER_STATE`). Before it did, an emulated frame was twice the
  hardware's, and nothing could see it: a trace is per tick and a tick is per
  frame either way. A chip handed the wrong number of clocks renders at the
  wrong speed, which is why this surfaced the day the driver landed.
- **The sound chip has to be asked for**, which no other console in the set
  does. On the board the T6W28's own bus belongs to a Z80 sound processor, and
  `demake build` emits no Z80 program — so the driver writes `$55` and `$AA` to
  two bytes of the main CPU's own I/O page and then reaches the chip through two
  more. A cartridge that skipped them would be perfect and silent.
- **A replay's port is a number, not an address.** `portOfSlot` answers in the
  binding's numbering and every caller puts it through `ngpPortByte`; storing it
  directly writes to `$0000`/`$0001`, which are two bytes of the processor's own
  register page. That is a release that reaches nothing at all on a cartridge
  whose every other register write is perfect — found by the battery's
  borrowed-channel case and by nothing else.

## Working on audio

The spine, both demakers and four CPUs' drivers are built; these are the rules
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
- **The two lossless encoders share one quantizer** (`encode/pcm.ts`), so
  "sample-identical" is true by construction rather than by two rounding rules
  agreeing — which they do right up until somebody fixes one of them. And the
  FLAC stream carries an **MD5 of its own audio** even though the format lets it
  be zero: that is what makes `flac -t` an end-to-end oracle for our encoder
  instead of a parser of it, and it is why `flac-reference.test.ts` can hold a
  codec we wrote to somebody else's decoder. Do not add an LPC subframe without
  reading doc 16 first — its coefficients are floating-point, and this package
  is under the determinism rule.
- **A box narrower than a clock is still a box.** `renderSchedule` integrates a
  chip's output between boundaries at `floor(i × clockHz / sampleRate)`, and
  every model but one clocks in megahertz — so a box is thousands of clocks wide
  and nobody had to think about the other direction. `GbaPcm` is a _mixer_ at
  32768 Hz, below the 48 kHz a render defaults to, so its boundaries collide and
  the box has **zero width**. The rule still covers it: such a box lies entirely
  inside one clock, and the mean of a constant is that constant. Two things go
  wrong here and each did. Dividing by the width without asking whether it is
  zero is `0/0`, which is how `render -c gba` wrote an all-NaN WAV for as long
  as that console existed. And **the accumulator must survive a zero-width
  box** — no clock elapsed in it, so what it holds belongs to a box still to
  come, and clearing it silences every second sample, which is much quieter than
  a NaN and no NaN check finds it.
- **Exactness lives in the schedule, not in a waveform diff.** Level A (diff the
  register writes an owned core observes against the `ChipScript`) is exact and
  runs in `pnpm test`. Comparing our audio to a third-party core's is a
  tolerance-based cross-check and must never be written as if it were bit-exact —
  cores resample and filter on their own terms.
- **Level B compares _spectra_, and the threshold was measured rather than
  chosen.** `audio-level-b.e2e.test.ts` boots a standalone audio cartridge in a
  third-party core, captures its audio callback and compares the long-term
  average magnitude spectrum with `render()`'s, as a cosine similarity. A
  waveform diff was tried and is not available: against fceumm the level differs
  by 19% and cross-correlation locks onto the music's own periodicity, its best
  lag wandering between 899 and 4456 samples in one capture. The gate is 0.99
  because the _chip model mutated_ — `nes-apu.ts` with its duty bit inverted,
  which keeps Level A green — scores 0.9801 against a correct 0.9992. Do not
  raise it without re-measuring that row, and do not swap the metric for a
  waveform one without reading doc 16 §The proof first.
- **A console is in `TARGETS` once its row has _run_ and passed, never because
  it qualifies.** A row self-skips when its libretro core is absent, so adding
  one on a machine with two of the five cores provisioned adds a test that says
  nothing — which is what happened to the Mega Drive's and the PC Engine's, and
  both were failing by the time anybody ran them. Six consoles qualify and two
  are in the suite; the other four are held out with their measurements written
  down in that file's own header, because on each of them the two sides differ
  by something that is neither model's chip (a level, a balance, or a
  reconstruction filter). Run `pnpm emulator` and the row before you add it, and
  if it does not pass, write down what you measured rather than lowering the
  gate — the gate is the only thing that makes the passing rows mean anything.
- **Two of the audio roadmap's open items are blocked on a _source_, not on
  work, and both have been looked for.** The Neo Geo Pocket's standalone
  cartridge needs the TLCS-900/H's timer block in `@demake/ngp`, and the
  register block behind it has no citable description this project could reach:
  the reference the console's machine description already cites gives the four
  timer vectors and nothing else, Toshiba's own datasheet is a 192-page **scan**
  with no text layer, and emulator authors report the datasheets that circulate
  disagree about the internal register addresses. `binding/t6w28.ts`'s four
  prescalers are the one number in the audio path with nothing under them. And
  the Mega Drive's FM-against-PSG balance needs a level off a board or the Model
  1 schematic's own resistor values — the two chips are summed by a network, so
  neither model can be asked and `MD_CHIP_GAINS` has to state something. In both
  cases building the thing anyway produces an artifact that is right in our own
  core and wrong on the hardware, with a perfect register diff either way, which
  is §Gotchas' wrong-and-consistent description exactly. Doc 13 §A5 and §A5.5
  record what each needs; do not close either by matching an emulator.
- **Audio DSP is where determinism breaks first.** FFT twiddles, windows, mel
  banks, dB conversions and resampler kernels all come from
  `packages/core/src/math/kernels.ts`. An FFT seeded with `Math.cos` returns
  different low bits in Firefox and every metric downstream inherits it.
- **Tempo is a budget, not a metric.** The requirement is that timing error does
  not _accumulate_; a bar boundary must land where it should after ninety
  seconds. Report requested BPM, achieved BPM, ppm error and worst onset
  deviation every time.
- **A part that can only reach a channel by being mangled is dropped, not
  mangled.** A drum part on a pitched channel plays General MIDI's _drum
  numbers_ as pitches — 36 is a kick, not a C2 — so a console handed one plays
  the drum map as a bassline in whatever key it lands in, which is what the
  `melody-first` candidate did to two of the quest tracks. `plan.ts`'s `UNUSABLE`
  affinity is infinite cost, so the part falls through to the drop list and is
  counted.
- **Never lose a part silently.** Every dropped note, merged voice and stolen
  channel is counted in the manifest and `--json`; `--strict` turns any of them
  into an error. The image path's tile-merge reporting is the precedent.
- **A choked drum hit is a loss, not a reduction.** Two hits on one tick and one
  drum voice means one of them never sounds, which for most music is most bars —
  the example library's overworld theme wrote 96 drum notes and a Game Boy played
  64, uncounted, until `compile.ts` started reporting it. It is `kind: "note"`
  (the part still plays; some of its hits went), it carries its own diagnostic
  code `choked-note` at `warning` rather than borrowing `merged-voice`'s `info`,
  and `--strict` refuses it — a merge still plays the material on some voice and
  this does not. It is decided in `compile.ts` rather than in the plan because
  whether two hits collide depends on the **driver's tick grid**, so
  `compileScript` returns its drops and the tournament merges them into the
  winning candidate's plan. A game build sets no `--strict`, so cartridges are
  unaffected.
- **The driver is generated, and helpers are pulled.** `packages/audio/src/rom/`
  emits SM83 _for this schedule_: a track that never rests ships no rest
  handling, a one-shot ships a stop path and a track does not. Never add a
  routine unconditionally and never prune afterwards — the same rule the Demotic
  backend runs under, and `stats.helpers` is what makes it checkable.
- **Which is why a branch across a driver's run walk is a long branch.** That
  walk's length _is_ the schedule — a recording body per borrowable channel, a
  merge loop, a preemption test, each pulled or not — so the distance is data and
  not something visible in the emitter. The SM83 player used `jr` for four of
  them and assembled for every game in the library until one placed effects on
  all four channels, at which point the branch was 202 bytes out of range and
  `demake build` reported invalid code instead of the answer it owed. `jp` there,
  `jr` only for a loop back or a skip over one instruction — the game backend's
  rule (§Working on the console backend), which the driver is not exempt from.
  `packages/audio/test/gb-branches.test.ts` builds the widest shape a Game Boy
  can ask for, because the example library cannot reach it.
- **A per-channel dispatch lets the _first_ channel fall through, not the last.**
  Every stream player emits one body per borrowable channel and tests one channel
  fewer than it has; the bodies are laid out in index order directly below the
  tests, so the fall-through reaches body zero and the channel that must go
  untested is the first. All eight tested `0..n-2` instead, which made the _last_
  channel's body unreachable and recorded its music into the first channel's copy
  — a borrowed channel handed back holding another channel's registers. Nothing
  saw it because the shared battery builds one effect, and with one borrowable
  channel a dispatch has no tests at all; `quest` is the example game that reaches
  it, with its smash on the noise channel and everything else on the first pitched
  one. `gb-branches.test.ts` asserts every body is reachable, which is the only
  place the question can be asked.
- **A driver's size is a query, not a value.** The emitter is a closure the
  assembler runs, so `stats.code`, `stats.data` and `stats.helpers` are all zero
  or empty until it has — which happens in `assemble`, one step after
  `bindAudio`. A backend that copies them out of the binding reports that zero,
  and `demake build` did exactly that for every cartridge it made until PR #31
  caught it in passing. `BoundAudioShape` states the rule for all three;
  `demotic/test/_audio-battery.ts`'s size sweep asserts the numbers are real, which
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
  that has to keep it: a Game Boy has a timer and gets 120 Hz; an NES, a Sega
  8-bit and a Mega Drive have the frame the picture runs on and get 60. The Mega
  Drive is the interesting one: its YM2612 _has_ a programmable timer and
  `fitRate` will offer it to a standalone track, but on that board the chip's
  interrupt line goes to the Z80 rather than the 68000 — so a game would have to
  poll it from the main loop, which is the loop's rate and not the timer's. Never
  ask a frame-clocked
  console for a multiple of its frame rate to "improve resolution" — the driver
  would tick twice at the top of a frame and then not at all for sixteen
  milliseconds, which is a schedule performed correctly and heard wrongly. And
  never trust a clock a `fitRate` will _offer_ without asking what the hardware
  does with it: the Sega VDP's line interrupt fit beautifully, fired only inside
  the active display, and was performed at half the rate it declared — which
  nothing noticed for as long as nothing consumed it, because a game asks
  `gameDriverRate` and the first standalone Sega cartridge did not exist. Both
  the candidate and the spec entry behind it are gone.
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
- **A trigger belongs to the note, not to the pitch — and which state that
  restarts is the channel's.** A key-on bit rides along on the register a pitch
  write lands in on several of these chips, so an encoder that sets it
  unconditionally restarts something every time a note bends. What that costs
  differs per channel and the differences are the hardware's: a Game Boy pulse's
  trigger reloads the frequency timer and does _not_ touch the duty step, which
  is what makes re-triggering it every tick safe (`binding/gb.ts` §header); its
  **wave** channel's resets the wave position, so a bend restarts the waveform;
  its noise channel's restarts the shift register, which `encodeNoise` has always
  guarded; and an NES pulse's `$4003` resets the sequencer phase, which
  `binding/nes.ts` guards by writing the high byte only when it changes. Two
  things reach a mid-note bend and only one of them is a feature: vibrato, and a
  sustained chord whose chosen note moves while it is still sounding. The second
  needed nothing new and was live in the example library — `keep.mid` restarted
  the Game Boy's waveform 47 times and `vault.mid` 11. None of it is visible to
  doc 16's Level A, because the cartridge performs the schedule exactly and the
  schedule is what is wrong.
- **A borrowed channel is given back holding the music's own registers.** The
  packed music is a delta stream, so a register the music's own value did not
  change is one it never states again — and after an effect has borrowed the
  channel the chip is holding the effect's value for it. Releasing it is
  therefore a _replay_ from a copy the run walk keeps (`rom/shared.ts`
  §`shadowPlan`), not a note-off: the music's next volume step re-triggers the
  voice, and on a Game Boy that meant a pulse coming back a whole tone sharp and
  ringing until the bar ended, on every bounce in pong. Every driver in the set
  has it (doc 13 §Handing a borrowed channel back), and the battery asserts on
  every console that what the chip is left holding is what the schedule says,
  which is a sharper claim than "something wrote it afterwards". Three chips
  needed more than a register-indexed copy and each says so where the chip's
  other rules live: the SN76489 has no register numbers, the PC Engine _selects_
  a voice rather than addressing one, and the YM2610's packed byte is a _port_ —
  so its copy carries the latch as a fourth byte and the recorder classifies on
  which port the byte was going to rather than on the byte.
- **A stereo position is the arranger's; which law it reaches the chip under is
  the spec's.** `ChannelFrame.pan` is `-1` … `+1` and `binding/pan.ts` reduces
  it, because the hardware splits two ways and neither is the other's
  approximation: seven chips have two attenuators and place a voice anywhere
  (`panGains`), four have one bit a side (`panSides`). Never flatten the
  distinction to booleans "because most consoles only switch" — that is exactly
  what the representation used to do, and it is why the T6W28's spec claimed
  `lr-level` for a year while the demaker could only say full or cut. Three
  things about it are load-bearing. **Centre is both sides at full under both
  laws**, so a part nobody placed encodes what it always did; a constant-power
  law would start every voice below the chip's own ceiling. **Placement is per
  channel and constant for the piece**, so a pan register is written once — a
  per-note pan would be a schedule several kilobytes larger on a machine with
  32 KiB and no mapper. And **a channel whose spec says `panning: "none"` is
  never placed and never reports one**, because a binding that ignores a
  position encodes identically and _says_ something false.
- **An effect is never placed**, for the reason a borrowed channel is replayed
  rather than silenced: an effect borrows a channel the music is using, so
  placing one moves what the music put there and leaves it moved.
- **Vibrato is read off the source, never invented.** MIDI states it — General
  MIDI puts depth on controller 1 — so `score/midi.ts` keeps that one controller
  and `Note.vibrato` carries it, per note rather than per part, taking the
  highest the wheel reached while the note sounded (a swell into a held note is
  the usual way it is written, and sampling the onset alone reads that as dry).
  What the source does _not_ state is the demaker's: the rate, the width and the
  delay are constants in `compile.ts`, and `math.sin` rather than `Math.sin`
  because this package is under the determinism rule. Two things follow. **A
  source that never touches the wheel is byte-identical**, which is every MIDI
  in the example library and the reason closing this re-baselined nothing. And
  **it costs**: a modulated held note is a pitch write per tick, two to five
  times a dry track's writes on a console that has to write the modulation
  rather than switch an LFO on — **except on the Mega Drive**, whose YM2612 has
  an LFO at 5.56 Hz and takes a depth instead, for four per cent. Do not widen
  the default depth or shorten the delay without measuring what it does to the
  tightest cartridge in the library.
- **`lfoChannels` is the seam, and the Neo Geo is deliberately not in it.** A
  binding that names a channel there promises to perform the vibrato in
  hardware, so `compile.ts` stops moving that channel's pitch. An OPNB is an
  OPN2 with the LFO _removed_ — `ym2610.ts` refuses `$22` by design — so
  claiming it on that console stops the pitch writes, has the register writes
  ignored, and plays the note straight with nothing reporting a problem. The
  chip model's own refusal is what caught it. The HuC6280's LFO is a separate
  refusal: channel two _is_ the modulator there, so vibrato costs a whole voice
  to modulate one other.
- **A kit takes every _dedicated_ drum voice, and takes them by drum class.** A
  General MIDI drum track is one part, so one part on one channel left a Neo
  Geo's other five ADPCM-A voices idle _and_ dropped every hit that collided
  with a ringing one — 96 notes in, 64 out. `plan.ts`'s `poolPercussion` spreads
  it and `compile.ts`'s `DRUM_VOICE` says which class goes where. Three things
  are load-bearing. **By class, never round-robin**: these are recordings, so
  consecutive kicks on alternating voices is flanging rather than depth, and a
  ringing kick must not be cut by the next hat. **The two hats share on
  purpose**, because that is the pedal on a real kit. And **only voices
  `affinity` scores at zero** — a noise generator or a fixed-rate sample voice.
  An FM voice hosts a kit at 6 and must never be pooled: six four-operator
  voices and six fitted patches for what one noise channel serves is spending
  the machine downwards, which the existing suite caught. `interchangeable`
  draws the same line inside one `kind`, because a YM2610's ADPCM-B is a
  `sample` voice too and is the only one with a pitch.
- **`NR51` is merged, never stored, whenever two streams share the chip.** One
  byte carries every channel's panning. Each stream keeps a shadow and the driver
  folds them under the steal mask, which is what makes the register stream exactly
  the schedule's when nothing is preempting — the whole proof rests on that. The
  NES's `$4015` and the Game Gear's stereo latch are the same problem and the same
  answer; a Master System and a Mega Drive are the two machines with no such
  byte, and they emit no merge at all rather than a merge that folds nothing —
  on the Mega Drive because panning is a per-voice FM register rather than a
  shared one.
- **A console with two chips tags the write, not the tick.** `BoundWrite.chip`
  and `RegisterWrite.chip` say which device a write addresses, `render()` filters
  per write, and `mix()` takes per-chip gains from the binding — because how loud
  a PSG is against six FM voices is a fact about the _board_, and a chip model
  that knew which board it was on would no longer be one model.
- **And on such a console a register number identifies nothing.** Anything that
  asks a question _about a register_ has to ask it about the chip too. `$25` is
  the Game Boy channels' panning byte on a Game Boy Advance **and** the mixer's
  fifth voice's right level, so `PackOptions.mergeRegs` needed `mergeChip` beside
  it — without it a schedule that set that voice's level had the write packed as a
  merge and the driver folded it into `NR51`, which is the music's stereo image
  replaced by a volume at the first tick of every build with an effect in it. The
  same trap is why `sfx/index.ts` keeps `chip` on every write it makes: it used to
  drop it, and that went unseen for as long as it did because the only two-chip
  console before this one places its effects on the first _pitched_ channel, which
  is chip zero — a wrong answer that happens to equal the right one.
- **A driver whose chip is a mixer reproduces samples, not writes.** Doc 16's
  contract survives restated one level up and gets _sharper_: the Game Boy
  Advance's six sample voices are `@demake/chip`'s `GbaPcm`, a register file of
  demake's own that no bus ever sees, so what the ARM driver owes is the bytes
  themselves against what the model renders. `emitMix` is written against
  `GbaPcm.mix` operation for operation for exactly that reason — a 32-bit
  accumulator per side per sample, voices summed in index order, the model's shift
  and the model's clamp. The one thing in it that is an optimisation rather than a
  transcription is the silent-voice path, and it is exact: a level of zero
  contributes nothing to either side, and the position still advances.
- **Counting transfers beats riding a timer, where the hardware will let you.**
  The Game Boy Advance driver's clock is its own FIFO refill interrupt: sixteen
  refills carry one block, so the sixteenth _is_ a block boundary and re-pointing
  the transfer there cannot repeat a byte or skip one. A timer at the same rate
  would be a fixed number of bytes out of phase with a transfer that reads ahead,
  and the phase depends on how deep the queue is — deterministic, and impossible
  to state without knowing the hardware's prefetch. It also lands the rate on
  128 Hz exactly, because 32768 divides by 256 with no remainder.
- **Timbre on an FM voice is searched, and the search is hardware-in-the-loop.**
  `binding/fm-patch.ts` plays each candidate on `Ym2612` and measures it; it does
  not score a patch by a formula about what it should sound like. Memoise per
  part, never per tick — the search is about a second and the arranger runs four
  candidates over the same parts.
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
   `_audio-battery.ts`'s: running the whole example library on every machine is what
   makes `Backend` a contract rather than a resemblance.

**Check first whether the console is a variant rather than a machine.** Five of
the consoles that build games are not backends: the Game Boy Color is the Game
Boy's machine code with a second half on the renderer, the Game Gear is the
Master System's family with a different crop, the Mega Duck is a Game Boy whose
I/O pins moved — a register table, an `LCDC` permutation, an entry point and a
cartridge with no header (`core/src/asm/megaduck.ts`) — the Nintendo DS is a
Game Boy Advance's 2D engine on a bigger screen, which is five entries in
`codegen/gba/machine.ts` and not one instruction, and the mono WonderSwan is a
WonderSwan Color with a quarter of the memory and a quarter of the depth, which
is four entries in `codegen/wsc/machine.ts` and not one instruction either. A
variant costs a machine description and no instructions; if you find yourself
copying an emitter, you are writing the wrong one of the two.

**A console can be a variant for step 4 and not for the driver.** The Nintendo DS
is the case: its game backend is a description, and its _sound_ is a whole ARM7
program, because the sound registers answer a processor the game cannot reach.
Ask the four questions separately — the answer to "is this a variant" is per step,
not per console.

**And a console can gain a chip model, both demakers and a game backend without
gaining an in-game driver.** No console is in that state today — the Virtual Boy
was the last and is not any more — but the shape is worth keeping, because it is
what the four columns exist to say: a build that traces identically to one that
plays its music is a legitimate intermediate state, and the in-game-audio column
says `—` for it because `GAME_DRIVERS` does not list the console. That list is
the fourth registry the support matrix reads and it is keyed by _console_ rather
than by chip, precisely so that describing hardware cannot claim a driver
(§Iron rules — what each console supports is derived, never written down). One
console is still in the neighbouring state, which is the same rule from the other
side: the mono Neo Geo Pocket demakes music (`arrange -c ngp`) and the driver
that would play it is already written, because that machine's sound hardware is
the Color's — what it has no backend for is the _game_.

## Testing truths

- `pnpm test` runs the Vitest unit suite locally with no Docker. Most of it is
  the game-audio battery: `packages/demotic/test/_audio-battery.ts` builds every
  example game _with its art and its audio_ on every console with a driver, and
  demaking a picture is the whole `prep` tournament. That is the price of the size
  assertions — they are the only thing that would catch a cartridge overflowing —
  so before trimming it, check that what you are removing is not the coverage.
  **The size assertion is `stats.cartridge` against `BOARD`, not `stats.free`.**
  Paging is what moved it: every family grows onto a bigger board now, so `free`
  is measured against megabytes and a Game Boy fixture clears its kilobyte floor
  by eight million bytes. What a regression looks like today is a fixture that
  _takes a mapper_ — a cartridge four times the size, two extra assembly passes,
  for a game the library says should fit — so the board it shipped on is asserted
  exactly. Only the consoles with a fixture near an edge are listed, on `SWEEP`'s
  own terms. Two
  consoles run the whole register-conformance battery but **one fixture** of the
  size sweep, for opposite reasons that `SWEEP` states in the file: the Mega Drive
  because a game is twenty-odd kilobytes of a half-megabyte image and there is no
  overflow for the assertion to catch, and the Super Nintendo because a picture
  there is thirty seconds of tournament rather than five. Both build the shooter,
  because a budget can only decide a cartridge already near the edge.
- **A test file is the unit Vitest schedules, so a long one pins a core and
  idles the rest.** That is why the two heavy suites are batteries pointed at one
  console from a file each — `_audio-battery.ts` behind `audio-<id>.test.ts`, and
  `_fanout.ts` behind `parallel-<id>.test.ts` — rather than one file looping over
  the consoles. As one file they were 777 s and 454 s of an 836 s suite, which
  made the whole of CI as long as the slowest console's sweep; split, the same
  work fits across the runner's cores and nothing about what is asserted changed.
  Two rules follow. Split per **console**, never per battery: `builds` is memoized
  per module, so a machine's register battery and its size sweep have to stay in
  one file or every build happens twice. And splitting is what makes `--shard`
  worth anything: it distributes _files_, so it cannot help a suite whose floor is
  one of them, which is what this suite was before the batteries were split and
  is why the note here used to say sharding was not the fix. It is now — CI runs
  four shards (doc 11 §Sharding) — and the floor is once again the slowest single
  file, which is what to look at before raising the count.
- **The suite shares demade art between its worker processes, and two things
  depend on that being invisible.** A test file is a process, so the same fixture
  used to be fitted from scratch in every file that built it — a fifth of all the
  conversion time a run spends. `packages/demotic/test/_art-store.ts` is a store on
  disk behind the `ArtStore` seam, installed by `setupFiles` and by nothing in
  production, and it is keyed on a digest of every source file under
  `packages/core/src` and `packages/demotic/src` so that a change to a fitter
  cannot be answered from a previous version's cache. The hazard it is written
  against is §Gotchas' own — a cache that is _wrong and consistent_ passes
  everything, because both sides of a comparison read it — so
  `art-store.test.ts` builds a cartridge cold, then from the store, and compares
  bytes. And `_fanout.ts` **opts out**: its whole point is that the first of its
  two builds fans out, so a battery handed pre-demade backdrops would compare two
  cartridges neither of which was built. A new test that asserts a conversion
  _happened_ has to opt out the same way.
- **A frame boundary is not a tick boundary, so never read a game's own variable
  out of an emulated machine's RAM.** `runFrame` returns where the raster says,
  which is anywhere in the tick — including the six instructions between the
  camera's subtraction and the clamp that follows it, where the variable holds a
  value the clamp is about to reject. `md-rom.test.ts` compared the VDP's scroll
  registers against the camera read that way and was asserting about wherever
  the boundary happened to land: it passed for months and then failed because a
  coin four cells away moved, which shifted the tick by a few instructions.
  Nothing about the cartridge was wrong either time. A rendering oracle wants
  hardware state (video RAM, registers, the object table) on one side and the
  **interpreter** on the other, which is the oracle everywhere else in the
  project; `layout` is for _finding_ things the runtime owns and reading the
  ones nothing is mid-way through writing. The NES, Sega, Super Nintendo, Game
  Boy Advance and Nintendo DS oracles still take their camera out of RAM, so
  each is a coin toss waiting to be spent.
- `packages/demotic/test/audio-ngpc.test.ts` is the tenth machine the shared
  battery is pointed at, and the only one whose driver has to **ask for its
  chip**: the T6W28's bus belongs to a Z80 sound processor, so a cartridge that
  skipped the two bytes that hand it over would show an _empty_ register stream
  rather than a wrong one — which is what makes the first assertion in that pass
  about permission rather than about notes. It is also where a replay to the
  wrong destination was caught: `portOfSlot` answers in the binding's port
  numbering and the release stored to it as an address, so the borrowed channel
  came back holding the effect's period on a cartridge whose every other write
  was exact. Only the borrowed-channel case could see it.
- `packages/demotic/test/audio-vb.test.ts` is the eleventh and the last — with it
  every console that builds a game is diffed tick for tick — and the only one
  whose driver is entered by a **call**. There is no interrupt in this cartridge
  at all, so a pass here is the claim that a tick per pass of the game's own loop
  keeps a schedule's tempo, at 50.2 Hz, which is the coarsest driver clock in the
  project. It is also where the cost of a processor with **no push list** was
  caught, and only the borrowed-channel case could catch it: `AudioSfxRelease`
  reads the steal mask into the register its callers are holding the request byte
  and the effect's table entry in, so an effect was started from a pointer into
  whatever the release left behind — which fires nothing, writes nothing, and
  leaves every other assertion in the battery passing.
- **`unsupported` names language gaps, not hardware ones**, and every console's
  list is empty. It stayed empty on the Super Nintendo through the period when
  that machine had no sound, because a `.dmt` that says `music theme.mid`
  compiled, recorded the request its rules made, and traced identically to a build
  that played it. A gap that changed what a _trace_ says is the one that must be
  named.
- **A 256-colour fit is expensive because K is large, not because the picture
  is.** A k-means iteration is O(pixels × centroids), so the Game Boy Advance's
  240×160 against 252 centroids costs minutes where a Mega Drive's 320×224
  against sixteen costs seconds. That is why this console is in `rom.test.ts`
  (no art) and in the browser determinism spec (once) but _not_ in
  `parallel.test.ts`, which would build it twice — the omission is stated in
  that file rather than left to be discovered, and what it would have covered is
  `fairShares` and `TilePool`, which the other two consoles run.
- **The parallel contract is tested at four levels, and they are not redundant.**
  `packages/core/test/parallel.test.ts` pins the ordering rules with executors
  that run jobs backwards and interleave two tournaments (fast, no threads);
  `packages/cli/test/pool.test.ts` does it over real `worker_threads` and is
  therefore run against the _built_ pool, self-skipping without `dist` the way
  `binary.test.ts` does; `packages/demotic/test/_fanout.ts` compares whole
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
  Game Boys, the Mega Duck, the NES, both Sega 8-bits, the Super Nintendo, the
  Mega Drive, the Neo Geo, the Game Boy Advance, the Nintendo DS, the PC Engine,
  both WonderSwans, the Neo Geo Pocket Color and the Virtual Boy — and runs it in the matching
  self-hosted core, asserting the
  trace
  matches the reference interpreter tick for tick. No toolchain, no emulator
  install, so it runs everywhere `pnpm test` does. Running the same battery on
  every one of them is what makes `Backend` a contract rather than a resemblance,
  and each
  console proves something different: the colour build that the attribute work
  never touched simulation state, the NES, the Master System and the Mega Drive
  that a second, third and fifth CPU's arithmetic and ordering agree to the bit,
  the Mega Duck that a machine description never leaked into the code the tick
  runs, the Super Nintendo that a value layer whose accumulator is _sixteen_
  bits agrees too — every routine there is a different program from the one the
  8-bit consoles share — and the WonderSwan Color that an emitter which has to
  name a _segment_ on every read still reads the same values, which is the one
  question no console before it could ask, and the Neo Geo Pocket Color that a
  processor whose _operand prefix comes before the opcode_ still assembles the
  same program — an encoder and a decoder that agreed with each other about
  which byte was which would not survive running the library. It also checks the Duck's cartridge _fails_ on a Game
  Boy — identical traces are also what a register map that had quietly become the
  identity would produce.
- `packages/demotic/test/neogeo-rom.test.ts` and `neogeo-arith.test.ts` are the
  Neo Geo's pair, and the first of them is where a bug lived that **nothing else
  in the project could have reached**. The LSPC's own tests write `vram`
  directly, so they never went through the address port; `VRAM_WORDS` is `$8800`,
  which is not a power of two, so `address & (VRAM_WORDS - 1)` was never a wrap —
  it clears bits instead of reducing, and `$737A & $87FF` is `$037A`. Every write
  to the fix layer was folded into the middle of SCB1: a caption computed
  correctly, addressed correctly, written correctly, landing in the tile numbers
  of a strip nobody was looking at. A trace says nothing about pixels and the
  emitter was right throughout, so the only route in was to ask whether a caption
  had _arrived_ and then follow the value from emitter to bus. Write through the
  port when testing a machine whose program can only reach memory that way.
  The arith file is thin on `pce-arith.test.ts`'s terms — the emitters are
  `m68k/`'s, so what it proves is that the same instructions mean the same thing
  on a machine whose work RAM is at `$100000` rather than `$FF0000` and which is
  entered through a header rather than a reset vector.
- `packages/demotic/test/collision-sides.test.ts` runs the same battery for
  `from <side>`, which the example library reaches on one console's worth of
  geometry and this reaches on all four sides of both kinds of contact. Two
  things about the program it builds are load-bearing and easy to undo. **Every
  probe starts already overlapping**, because a probe that had to travel would
  arrive on a different tick on every machine — the screens differ fourfold in
  area and the tick rates by a quarter — and a case that never arrives compares
  zero with zero and passes. And **the wrong-side rule is written first**: a
  contact the clause admits is also separated, so a rule written after one that
  fired finds the boxes already pushed apart and stays silent whether or not it
  was narrowed, which reads as a pass on a backend that never looked at the
  clause. Reordering those two lines is what turned it from vacuous into the
  thing that caught the emitters.
- `packages/demotic/test/ngpc-rom.test.ts` is the Neo Geo Pocket Color's
  rendering oracle, and every case is one that produces a cartridge which ticks
  perfectly and shows nothing: the entry address the boot ROM reads out of the
  header (there is no reset vector on this machine), the character bank and the
  palettes arriving in the display's own memory (no port, so nothing about the
  arrival is observable but the bytes), the plane against the level's own grid
  before and after the camera has travelled, and the objects a frame did not use
  having their priority cleared — which is the only way to hide one here. Its
  picture case compares against the _art path's own packed map_ rather than
  against a threshold, because the two ways that goes wrong — the window's stride
  instead of the hardware's, and packing a map that was already packed — both
  present as art running past the last visible column and neither is visible in
  a count. Both were found by writing it.
- `packages/demotic/test/audio-pce.test.ts` is the second console to run
  `mos-player.ts`, so what it proves that `audio-nes.test.ts` does not is the
  _machine_ around those instructions: a different register base, a clock that is
  a timer rather than the frame, and a channel selection that has to survive a run
  being skipped. It is also where the harness learned that **an interrupt return
  is not an arrival** for the second time — a timer firing 120 times a second
  right where the service loop calls the tick lands on that instruction sooner or
  later, and it presents as a phantom empty tick with everything after it one
  late. The Game Boy Advance filters it by where the step came from; this console
  cannot, because its handler is in the same cartridge, so it filters on the
  _opcode_ at the address the step came from: a real arrival is a `jsr` and a
  return is an `rti`.
- `packages/demotic/test/audio-ws.test.ts` is the ninth, and the first whose
  console shares its _whole_ sound path with another — one chip, one binding, one
  driver, one waveform page. So what it settles is not the driver but **where
  that page is**: this machine has sixteen kilobytes with its tile bank in the
  top half, so the gap the colour machine keeps the waveforms in is tiles over
  here, and `WS_WAVE_BASE` sits inside the interrupt vectors because that is the
  only aligned page free on both. A build that put it anywhere else produces a
  game whose bass plays a corner of its own title screen.
- `packages/demotic/test/audio-wsc.test.ts` is the eighth machine the shared
  battery is pointed at, and the only one whose driver has no interrupt at all.
  What it proves that no other console's pass does is that a **tally** keeps
  tempo: this cartridge takes none, so the driver reads the vertical-blank
  timer's counter and pays whatever frames it finds owed, and a tick lost
  anywhere in that chain is a schedule performed at the wrong time. It also
  found two sixty-hertz assumptions written as arithmetic in the shared battery
  — "a hundred and twenty frames is two seconds" is not true on a machine that
  draws 75.47 of them — which is the same class of finding the `.test.dmt`
  duration unit came from, one layer down.
- `packages/demotic/test/audio-nds.test.ts` is the seventh machine the shared
  battery is pointed at, and the second whose driver is not on the console's own
  processor — but for a different reason from the Super Nintendo's, which is the
  thing it exists to hold. There is no upload: the cartridge carries two programs,
  the loader copies both into the memory they share, and the game asks for a track
  by storing a byte the ARM7 reads. It runs no size sweep, for the Game Boy
  Advance's reason, and asserts instead that the driver's reported sizes are real
  — which is worth more here, because on this machine those numbers describe a
  whole second binary rather than routines inside the first.
- `packages/demotic/test/audio-gba.test.ts` is the one console whose Level A proof
  is in two halves, because its two sound devices are not both chips. The shared
  battery diffs the four Game Boy channels tick for tick, exactly as it does on
  five other machines; the six mixer voices write a register file in work RAM and
  cross no bus, so what is compared there is the **samples** the converters
  received against what `GbaPcm` renders from the same schedule — byte for byte,
  which is exact because the mixing is integer throughout. Point a mixer proof at
  a track the arranger put on the _Game Boy_ channels and it compares silence
  with silence and passes; `runner`'s `updraft.mid` is the one in the library
  whose parts land on the sample voices, which is why that test names a project
  the rest of the file does not. It runs no size sweep, and the omission is
  stated in the file: this cartridge is thirty-two megabytes against a game's
  twenty-odd kilobytes so there is no budget to catch, and a build with art here
  is the whole `prep` tournament against a _256-colour_ palette — minutes rather
  than seconds. What the sweep would still have bought (that a driver's reported
  sizes are real rather than the zero they hold before `assemble`) is asserted on
  an art-free build instead.
- `packages/demotic/test/nds-rom.test.ts` is the Nintendo DS's oracle, and what it
  checks is the _machine description_ rather than the code: the two programs a
  `.nds` names, the two video RAM banks, the power and display-mode registers, the
  bigger window painted to its last row, and one game tick per frame. Every case
  is one a Game Boy Advance build would pass while a DS cartridge sat dark. Trace
  conformance is `rom.test.ts`'s, and on this console it settles something sharper
  than usual: the instructions are the other machine's, so a trace that matched on
  one and not the other would mean part of the description had leaked into the
  code a tick runs.
- `packages/demotic/test/gba-arith.test.ts` and `gba-rom.test.ts` are the Game
  Boy Advance's pair, and the second is where the things a trace cannot see are
  checked: that _two_ banks arrived in two places, that the map's four screen
  blocks are all painted once the camera has crossed into them, that the reserved
  colours survive whatever the art chose, that the object entries a frame did not
  use are _hidden_ — this hardware has no link field to cut — and that a
  camera-pinned caption occupies the same HUD cells for forty frames while the
  picture scrolls under it. That last one is the claim the whole HUD-layer design
  rests on, and it is the one property none of the other five backends can have.
- `packages/demotic/test/md-arith.test.ts` and `md-rom.test.ts` are the Mega
  Drive's two oracles, and they are the pair every new backend gets: the first
  assembles each 16.16 operation on its own and compares with `fixed.ts`, the
  second checks the plane against the level grid cell by cell and a demade
  backdrop word for word. Between them they caught a packed cell read as a word
  from an odd address and an unwidened column index in the grid lookup, neither
  of which a trace can see.
- `packages/chip/test/ws-sound.test.ts` is where this console's _chip_ is held to
  the hardware, and two of its cases are about the thing that makes it unlike
  every other model here: the waveforms are the console's own RAM, so the
  packing order of the two samples in a byte is observable and a base register
  written un-shifted plays whatever else is at that address. Neither is
  something the register diff one layer up can see.
- `packages/demotic/test/wsc-arith.test.ts` and `wsc-rom.test.ts` are the
  WonderSwan's pair. The first is where a new value-layer emitter is proven and
  the file to run when touching `codegen/wsc/val.ts`; two of its vectors are aimed
  at answers this machine gives
  that no predecessor does. The multiply is four multiplies and no loop, which is
  only right if the sign reaches all forty-eight bits of the product before its
  middle thirty-two are taken — `THIRD × -THIRD` is where truncation and floor
  come apart, and a version that shifted first passes every other case in the
  file. And the divide has _three_ paths rather than two, so the vectors name a
  whole number of cells, a divisor below one, and the fractional divisor of a cell
  or more that reaches the bit loop — which nothing in the example library does,
  making this the only place that path runs at all. The second checks the things
  a trace cannot see, and every case is one this hardware alone can get wrong:
  that the tile bank and palette RAM arrived in the console's _own_ memory
  (nothing is uploaded here, so a short copy is a perfect game on a blank
  screen), that every visible cell of the world plane matches the level's own
  grid before and after the camera has travelled, that a picture went in at the
  hardware's thirty-two-cell row rather than the window's twenty-eight (the Super
  Nintendo's stride hazard, two consoles along), that both reserved palettes
  survived the fit, and that the HUD plane's scroll registers stay at zero for
  hundreds of frames while the world plane's move — which is the claim the whole
  HUD-layer design rests on and the second time in the set it can be made at all.
  Its last block is the **mono** machine, and every case there is one that
  console alone can get wrong: that everything the display reads is inside
  sixteen kilobytes, that a planar 2bpp bank arrived in the top half of them,
  that the palettes reached _ports_ with a pool of eight distinct levels in it
  (all zeroes is eight copies of white, which is a screen with one shade on it),
  that a scene with a picture brings a pool of its own, and — the end-to-end
  one — that more than three greys are on the panel, because any of the others
  being wrong is a picture nobody can see.
  `packages/wsc/test/{cpu,display}.test.ts` sit under it: the CPU is driven by
  `core`'s own V30MZ assembler, so an encoder and a decoder that agreed with each
  other and not with the hardware would still fail against NASM, which
  `packages/core/test/v30mz-nasm.test.ts` compares the same battery with. The
  display file's second block is the **mono** machine, and what it proves is
  that a pool is a pool: two palettes naming the same entry show the same grey,
  and moving that entry moves both — a renderer (or a fit) that treated a
  palette entry as a _level_ passes the first half of that and fails the second.
- `packages/core/test/fit-mono-tiled.test.ts` is the tiled-mono fit's, and its
  load-bearing case is that a budget of one palette **is** the plain mono
  answer, so a fit computing the per-cell choice and discarding it would score
  the same. The rest is what a compliant PNG cannot show: that all eight pool
  levels are spent, that entry zero is shared, and that a picture showing nine
  distinct levels is refused by `E_SHADE_POOL` even though every cell of it is
  uniform and the palette cover fits.
- `packages/demotic/test/pce-arith.test.ts` and `pce-rom.test.ts` are the PC
  Engine's pair, and the first of them looks like a copy of the NES's on purpose:
  the _emitters_ are the same file, so what it proves is not the arithmetic a
  second time but that the same instructions still mean the same thing on the
  second machine that runs them — which on this console turns entirely on the
  cheap page being at `$2000`. The second checks the things a trace cannot see and
  every case is one this hardware alone can get wrong: that the boot stub landed
  in the bank reset maps, that four `tam`s ran, that the character bank and the
  sprite patterns arrived in video RAM, that a picture went in at the _hardware's_
  sixty-four-cell row rather than its own thirty-two (the Super Nintendo's stride
  hazard, one console along), that the font's sub-palette survived the fit, and
  that the object table reached the copy the chip fetches rather than the one the
  runtime wrote.
- `packages/pce/test/{cpu,vdc}.test.ts` sit under those. The CPU is driven by
  `core`'s own HuC6280 assembler, so an encoder and a decoder that agreed with
  each other and not with the hardware would still fail against the published
  opcode bytes `packages/core/test/huc6280.test.ts` pins — and the VDC test is
  where the _increment select_ was found to be one bit out, which no trace and no
  register assertion could have seen.
- `packages/demotic/test/vb-arith.test.ts` and `vb-rom.test.ts` are the Virtual
  Boy's pair. Three of the first's
  vectors are aimed at answers this machine gives that no predecessor does: a
  multiply with **no** floor correction (an arithmetic shift of the hardware's
  own 64-bit product already is one, so `THIRD × -THIRD` is where a version that
  assembled the product from unsigned halves would fail and pass everything
  else), a divide with _two_ paths of which the example library only ever
  reaches the first, and a pooled constant that is in the cartridge where a
  variable is not. Its generator case is what caught the integer part being
  taken with a logical shift: the Neo Geo Pocket subtracts in a sixteen-bit
  register and gets the sign extension from the wrap, and `random(-1, 1)` on a
  thirty-two-bit one computes a count of −65534.
  The second is the rendering oracle, and it is the only one in the project that
  can read a **depth** back off the hardware: the two worlds, the object table
  and the pixels themselves, checked together because a sign convention that was
  consistently wrong would satisfy any one of the three alone and put a game's
  captions behind its scenery. Its other cases are the ways this cartridge can be
  perfect and dark — a display list written one entry short (a scene with no
  captions), a character bank that never arrived (nothing is uploaded through a
  port here, so a short copy is a blank screen and nothing else), the plane
  against the level's own grid, and the caption plane's origin staying at zero
  while the scenery's moves. It scrolls the caves **vertically** to prove the
  last one, because this is the widest screen in the matrix — forty-eight cells,
  so a level that scrolls sideways on a Game Boy has both its edges on screen
  here and the camera never leaves its horizontal clamp.
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
  against the schedule. It exists because a failure in the game-audio battery on that
  console could be the driver, the cartridge's upload or the request protocol, and
  this file can only be the first.
- The audio ROM conformance suite (`packages/audio/test/rom.test.ts`) is its
  counterpart for sound, and doc 16 §The proof's Level A: it builds a cartridge
  from an arranged track and from a demade effect, boots each in the console's
  own core, and diffs the register writes the chip receives against the
  `ChipScript`, tick for tick, on every console `audioRomConsoles()` names. Ticks
  are attributed by watching the driver's `Tick` symbol, so
  nothing is added to the ROM to make it observable. Also toolchain-free.
  **The Sega block is where a wrong _tempo_ is caught**, which is the one thing a
  register diff cannot see: a handler that did not read the VDP's status byte
  would leave the interrupt pending, re-enter the moment `ei` ran, and perform
  the whole schedule in a few frames — every write correct, in order, and at ten
  thousand times the speed. So that case measures the CPU cycles between two
  `Tick` arrivals and asserts a frame. Its other case is the one that made the
  larger board reachable: 32 KiB is this cartridge's floor and 48 its ceiling,
  and between them is a sixteen-byte header _inside_ the address space, so the
  test checks that no packed block overlaps it.
  **The Mega Drive block measures the same thing against the timer**, and adds
  the two this console alone can get wrong: that the program was assembled where
  the cartridge _puts_ it (a build assembled at zero has a perfect symbol table
  and jumps two hundred bytes short of everything, which is a cartridge that
  boots and executes its own title), and that no tick writes `$27` — the register
  the clock lives in — which is what stripping the boot prefix buys.
  It is also the console that made the harness's tick attribution honest: a group
  used to run from one `Tick` entry to the next, which is only the same thing as
  "the writes this tick made" while nothing writes the chip _between_ ticks. Here
  the timer acknowledge does, so a driver may name a `TickEnd` label — no
  instruction, so the ROM is unchanged — and the group closes there instead.
- The game-audio conformance suite (`packages/demotic/test/_audio-battery.ts`, run
  from `audio-<id>.test.ts`) is
  doc 16's Level A for a cartridge that is also playing a game, **on every console
  with a driver**: it boots a built `.gb` in `@demake/dmg`, a built `.nes` in
  `@demake/nes`, a built `.sms` in `@demake/sms` and a built `.md` in
  `@demake/md`, watches `AudioTick` by program
  counter, and diffs the writes the chip receives against the schedules the
  demakers produced — the music's when nothing preempts, the effect's own channel
  while one does. The battery is written once against a `Target`; the only
  per-console entries are the channel _tag_ (a factory, because one chip latches
  it), the shared register (`null` where there is none), the merge helper's name
  and the ratio a window written in ticks is scaled by, because a frame-clocked
  driver ticks half as often as a Game Boy's. The Game Gear gets its own short
  block rather than a fifth pass, because the stereo latch is the only thing
  about it the Master System's pass does not already run. Also toolchain-free, and
  it is the file to run when touching any driver.
- `packages/cli/test/vb.e2e.test.ts` is the Virtual Boy's, and the only E2E in
  the project that checks **two pictures**: the core is asked for a side-by-side
  capture, so a still picture is compared against the same reference in both
  eyes — which is the claim a backdrop makes on this console, since a layer at
  the display plane is one the eyes see in the same place. It is also the only
  one that needs _no assembler_, and therefore the sharpest test of an encoder
  there is: every instruction in the cartridge is ours and a third-party
  emulator is what decodes them. Its depth case is where a scene with two depths
  is run in beetle-vb **and** in `@demake/vb` and compared pixel for pixel —
  every other assertion about depth in this repository is against our own model,
  and that one is against somebody else's.
- The pixel-perfect emulator E2E (`packages/cli/test/emu.e2e.test.ts`, doc 10)
  boots the ROM in SameBoy and asserts the framebuffer matches the DAC reference
  byte-for-byte; it self-skips without the capturer, so run `pnpm emulator`
  (which needs `pnpm toolchains` first) to exercise it. The capturer is built
  from `emu-harness/gb/capture.c` against `libsameboy`; web sessions get it via
  the `.claude/` SessionStart hook. **The Mega Duck is in that file rather than
  one of its own**, because it is the same harness, the same assembler and the
  same battery — the console is a machine description, and a second suite would
  be asserting that a description is a console. What differs is the emulator, and
  it skips separately: SameDuck's capturer is the same source compiled against
  SameBoy's own Mega Duck fork. **The shade ramp is passed to the capturer**
  rather than carried in C, because a DAC model is a tested artifact of the
  console spec and a second copy of one disagrees in an entry.
- `packages/cli/test/neogeo.e2e.test.ts` is the Neo Geo's, and it is the only one
  that has to **write the emulator a system ROM** — geolith will not load a
  cartridge without a system ROM archive, and its members are read by _name_ with
  no checksum, so `_neogeo-bios.ts` builds the same three-line hand-off
  `@demake/neogeo` implements and puts it in a zip made with core's own PNG
  primitives. Nothing copyrighted is shipped or needed, which is the position doc
  13 §Axis 3 already takes about this console. It is also the suite that found
  three things nothing of ours could: the container stores its P ROM
  **byte-swapped**, a sprite tile's leftmost pixel is the **least** significant
  bit, and the palette bank's **last entry is the backdrop** rather than a colour
  an art path may spend. All three were wrong _and consistent_ — our own writer
  and our own reader agreed — which is the failure mode a third-party emulator
  exists to catch (§Gotchas).
- **The ARM encoder has two oracles, and the second is the reference
  assembler.** `packages/core/test/arm.test.ts` pins hand-read encodings, which
  is what every other encoder here gets; `arm-gnu.test.ts` assembles the same
  battery with `arm-none-eabi-as` — already provisioned for the display-ROM
  harnesses — and compares word for word, self-skipping without it. That is worth
  more on this architecture than on the 8-bit ones: those have an opcode per
  addressing form, so a wrong byte is a wrong instruction and a decoder finds it,
  while ARM packs five operand shapes into twelve bits and a shift field written
  into the wrong nibble still decodes as _something_.
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
- **A drawing has no size, so asking for a bigger one is free — but somebody has
  to ask.** `decodeImage`'s `atLeast` is that request: an `<svg>` is rasterised
  at whatever size its author declared, and a 64×64 file demade at 160×144 used
  to be a 64×64 raster stretched, which is a blur the file never contained. Two
  callers pass it and they are the two places a target size is known — an
  explicit `--size` (`candidate.ts`; the _auto_ size can never exceed the
  source's own dimensions, so it does not ask) and a sprite's cell box
  (`sprite.ts`). It scales the document's declared size and never the box, so
  the framing every later stage is written against — `--fit`, the auto size, the
  cell box — is untouched and only the resolution moves. Every raster format
  ignores it, because there the pixels _are_ the file.
- **A raster decoder is held to a second implementation, never to an encoder
  written beside it.** `packages/core/test/raster.test.ts`'s fixtures are pairs:
  the file, and the RGBA a browser produced from those exact bytes. BMP and GIF
  are lossless so the comparison is exact; JPEG is compared to ±2, and the bound
  is tight on purpose — a loose one passes a decoder with the chroma upsampling
  wrong, which is what a first attempt here had. Replicating the chroma sample
  rather than interpolating it was **110 levels** out and still looked like a
  photograph, which is precisely the class of wrongness a demake would turn into
  a palette nobody could account for. Same argument as `arm-gnu.test.ts`, one
  layer down.
- **The one JPEG path nothing exercises is the restart interval.** No encoder
  reachable from this repo emits `RSTn` markers, so the code that resets the
  predictions and starts a fresh bit reader at each one is written from the
  standard and unproven. It is the first thing to suspect if a camera JPEG comes
  out drifting in brightness from a band partway down, and the first thing to
  test if a fixture with restarts ever becomes available.
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
- **The mono WonderSwan's `shades` and `levels` are different numbers, and the
  difference is the point.** `color.shades` is 8 — how many the pool holds, so
  how many the screen shows at once — and `color.levels` is 16, the LCD levels
  the pool is chosen _from_. A `codes` entry holds the **level**, 0–15, not the
  pool index, which is what lets `inspect` state "at most eight distinct ones"
  as a rule it can check. Every other mono console leaves `levels` unset, and
  `isMonoTiled` — not the field — is what routes a console to the tiled-mono
  portfolio, because the deciding fact is `subPalettes.count > 1` on a mono
  machine.
- **And its `sharedIndex0` is real, so the fit chooses a backdrop.** Colour zero
  is transparent on both of this console's background layers, so a pixel of
  value 0 shows the backdrop register wherever it appears — the NES's rule
  reached by different hardware. `fit-mono-tiled.ts` sweeps all eight pool
  entries and solves the palette choice exactly under each, because picking the
  backdrop by frequency first is how a fit comes to hold three usable shades on
  hardware that has four.
- **The Virtual Boy's shade 0 is the LEDs being off**, which inverts the
  convention every other mono console in this project shares: a fit's index 0 is
  its _lightest_ colour, and here the lightest is shade 3. `vbShade` is the one
  place the reversal happens and it has three readers — the `vb` codegen family,
  `@demake/vb`'s renderer and (later) the game backend's palette emitter. A copy
  in any one of them is a picture that is a photographic negative, which is
  exactly what the E2E caught the first time it ran.
- **And its backdrop is a palette entry, not a register somebody chooses.** Pixel
  value 0 is transparent on _both_ of this console's layers, so a picture's
  lightest shade only ever reaches the screen through `BKCOL` — the NES's shared
  index 0 reached by different hardware. That is why `.pal.bin` is five bytes:
  four `GPLT` registers and then the backdrop, because a family that emitted the
  four and left the fifth to a caller would have every picture's paper decided by
  whoever wrote the display program.
- **The Virtual Boy's two flip bits mean opposite things on its two layers.** A
  BGMap entry mirrors horizontally on bit 12 and vertically on bit 13; an object
  attribute is the other way round. It is the hardware rather than a
  transcription error, and it is exactly the asymmetry a reader will helpfully
  "correct" — so it was settled with a probe cartridge rather than by reading:
  one lit pixel at a character's top-left corner, run in beetle-vb, moves to
  (0, 7) with bit 12 set and to (7, 0) with bit 13. The background half is
  settled by the pixel-perfect E2E, whose fits are flip-aware, so a mirrored tile
  there is a byte-comparison failure.
- **A Virtual Boy framebuffer is columns.** 384 of them, 256 pixels at two bits
  each, so consecutive bytes are _vertical_ neighbours — a reader that walked one
  row-major produces noise rather than a wrong picture. `vbFramebufferBit` has
  one definition for that reason, and both the core's renderer and its tests read
  through it.
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
- **A lazy section that does not arrive has to say so.** Every editor but the art
  demaker is an `import()`, and a rejected one used to be dropped on the floor —
  so the page sat on "Loading…" for ever with no message, while the art demaker
  went on working because it is in the entry chunk. Opening a `.wav` did nothing
  and explained nothing. The cause is ordinary rather than exotic: a tab left
  open across a deploy is holding a shell that names hashed chunks the server has
  replaced, so the _first_ lazy section it asks for 404s. `site.tsx` records the
  failure per section and offers a reload — and a reload is the only thing it
  offers, because asking for the same module again in the same document is
  answered from the browser's module map, which is holding the failure. A "try
  again" button there would never once have worked.
- **And a failed module load survives a reload in WebKit but not in Chromium**,
  which is the trap the test above is written around rather than against.
  Reload a page whose `import()` of some URL failed, and Chromium re-requests it
  while WebKit answers from its cache of the failure and issues **no request at
  all** — the error comes straight back. That is not what a visitor meets, and
  the reason is worth holding on to: the case this path exists for is a stale
  shell, so the shell the reload fetches names a chunk with a _different_ hash
  and there is no cached failure against it in any engine. The scenario where a
  reload genuinely does not help is a chunk URL that fails _transiently_ and is
  then asked for again unchanged, and nothing in JavaScript can force a
  cache-bypassing reload to fix it. So `workbench.spec.ts` proves the section
  loads on a fresh page rather than driving the button: pinning the reload would
  pin the artificial half of the setup, and it is what turned that test red on
  WebKit only.
- **An engine imported on the UI thread is a second copy of it in the bundle.**
  A worker is a separate bundle, so `@demake/core` reached from a component is
  shipped twice — and both copies are always-loaded chunks, so the doc-07 JS
  budget counts both and the duplication shows up.
  The game section built its cartridge inline until the Sega backend needed the
  room; it goes through `core.worker.ts` now, which is where every path that
  touches `@demake/core` belongs anyway. What may stay on the main thread is what
  has no engine under it: the language front end, the interpreter, and the
  emulator cores, because playing a cartridge is what the page does with one.
- **What the service worker may cache for ever is decided by the URL.** Vite
  writes every content-hashed artifact under `assets/`, so a request inside it
  can never mean two different files and is cache-first; everything else
  same-origin — `index.html`, the manifest, the icon — has a stable URL and
  changing contents, so it is network-first with the cache as the offline
  fallback. `index.html` is the one that matters, because it is what names the
  hashed chunks: cached, it asks for the chunks it already has, so a returning
  visitor stays on the build they first loaded and a deploy reaches new visitors
  only.
- **And "network-first" has to mean past the _browser's_ cache too.** The shell
  is fetched with `cache: "no-store"`, because Pages sends `max-age=600` on it
  and a fetch the HTTP cache answers is not a fetch. That is the same bug a
  second time with a ten-minute window instead of an unbounded one, which is
  exactly how it survived the first fix.
- **Three things outside the worker finish the job** (`main.tsx`), each a way a
  visitor gets stuck: registration asks for `updateViaCache: "none"`, so `sw.js`
  itself is never HTTP-cached (a worker that cannot be re-read cannot be
  replaced); the page calls `registration.update()` on load and on becoming
  visible, because a browser checks on navigation and this app is one page
  somebody leaves open for a week; and a page an _old_ worker was running
  reloads once when a _new_ one claims it — guarded on there having been a
  controller, or every first visit would reload. No browser test can catch any
  of this — a Playwright context always starts with empty storage, so the suite
  only ever sees a first visit — which is why `packages/web/test/sw.test.ts`
  runs the worker in a fake global instead. Changing `CACHE`'s name is still
  what rescues a visitor holding a poisoned cache.
- **A menu entry and its keybinding are one declaration.** `MenuBar`'s array is
  what is drawn _and_ what `useMenuKeys` binds, so a menu cannot advertise a
  shortcut nothing listens for and a disabled row cannot have a live key. Same
  rule as `cli-spec` for flags and `lang/spec.ts` for the language: the second
  list is the one that goes stale. `Mod` is the platform's modifier, decided in
  that one file and never at a call site.
- **A tap's `pointerenter` is the first half of that tap, not a hover.** A finger
  has no hover, so a handler that treats entering as its own interaction runs
  twice for one gesture: the menu bar switched to a menu on the enter and toggled
  it shut on the click, and every switch took two taps on a phone. Hover-switching
  is guarded on `pointerType === "mouse"`, and a click on the title the pointer
  just switched to keeps that menu open rather than closing what the same gesture
  opened. Both halves are pinned in `workbench.spec.ts`, the touch one in a
  context of its own — the default Playwright context has no touch, so nothing
  the rest of the suite does can see this.
- **A command offered twice states its key once.** The explorer's toggle is in
  the View menu _and_ on the title bar, because a control that lives only in a
  menu is one you have to already know about — so `EXPLORER_KEY` is a constant in
  `site.tsx` that the menu entry and the button's tooltip both read, and the
  tooltip renders it through `MenuBar`'s own `accelerator()`. A second literal is
  how a button comes to advertise a shortcut the menu has since changed, which is
  the one-declaration rule arriving through the other door.
- **The explorer opens contracted below 1000px**, which is the same width the
  stylesheet stacks it above the editor at — `STACKED` in `site.tsx` mirrors that
  `@media` query and the two have to move together, or the tree collapses at a
  width where it was still a perfectly good sidebar. It is the page's _opening_
  decision and nothing watches the viewport afterwards: a rotation is not a
  reason to overrule the button somebody just pressed. And the stacked layout
  needs a one-row template when the tree is off (`.workbench.no-explorer`), or
  the editor sits in a row sized to its content and the window clips it with
  nothing to scroll.
- **A grid that states its rows must state its column too.** An implicit track is
  sized to its widest item's _max-content_, so `.workspace` — rows pinned,
  column left to itself — was as wide as the widest toolbar or line of source in
  whatever section was open: on a phone the title bar, the editor and the status
  bar were all 410px inside a 375px window, and `overflow: hidden` cut the
  surplus off with nothing able to scroll to it. `minmax(0, 1fr)` is the fix and
  the symptom is worth recognising, because it does not look like a layout bug —
  it looks like a button that is missing and a caption that stops mid-word.
- **The window's name moves on a narrow screen rather than going away.** Below
  900px the title flows to the right of the menus and below 640px the strip wraps
  and gives it the row above them; only the engine note is dropped. It used to
  drop the tagline and then the name, which left the one thing on screen that
  says what is open with nothing on it — on the machine most likely to have
  arrived from a link. `workbench.spec.ts` pins both halves at 390px.
- **Which is why two of the commands have no accelerator and two are `native`.**
  ⌘N is the browser's new window and cannot be prevented; ⌘⌫ deletes the previous
  word in a text box and must not be taken over by a delete with no undo behind
  it — so neither is offered. Undo and redo _are_ offered and are marked
  `native`: the key stays the browser's, because a `<textarea>`'s own ⌘Z drives
  the native undo stack the user has been filling by typing, and a journal of our
  own beside it is a second history that disagrees with the key. Before adding a
  binding, ask which of those three a key is.
- **A path opens exactly one editor, and `route.ts` is where that is decided.**
  `sectionForFile` reads the kind `@demake/demotic` already assigns by extension,
  names the two cases the language has no kind for (`.dmt`, and text), and is
  read by the explorer, the router and the lazy-import switch. A component that
  asked "what kind of file is this?" for itself would be the second answer.
- **A project opens in two halves, so late-arriving bytes must be _merged_.**
  `exampleSkeleton` gives the explorer every file on the first frame with the
  binaries empty, and the fetch fills those placeholders in — it must never
  assign a whole project, which is what it used to do: the arriving bytes came
  wrapped in a pristine skeleton, so a file created, renamed, deleted or typed
  into before the art landed was silently discarded. A placeholder is an entry
  with _no bytes_, and filling only those is what makes the fetch safe to land
  late. The race is invisible on a fast machine and reliable on a loaded one, so
  it is pinned in `packages/web/test/files.test.ts` rather than in the browser
  suite, which passed it four times and failed the fifth.
- **A blob URL needs a media type or an `<img>` shows nothing.** A browser
  believes a blob's `type` and does not sniff for SVG, so `mediaTypeOf` is one
  table in `lib/project.ts` with two callers — the explorer's pictures and the
  art demaker's source pane. The second one built its blob without a type for
  months: every drawing in every project was a broken image _beside a demade
  result that had come out perfectly_, because the engine reads the bytes and
  never the URL.
- **The page never lexes a format the engine parses.** `.dmt` colours come from
  `highlight()` and a Demakefile's from `highlightDemakefile()`, both in
  `@demake/demotic`; `SourceEditor` is handed spans and owns no grammar, which is
  also what keeps the language out of the chunks that only need a box to type in.
  A file with no grammar is drawn plain rather than approximated with a regular
  expression — that is the forbidden second implementation for a smaller prize.
- **And it never decides what part of a statement means.** The block editor's
  fields come from `parse()`'s and `parseTests()`' own `spans` — the parser
  already knew that the word after `backdrop` is a picture and the word after
  `in` is a scene, and `lang/slots.ts` is that decision kept rather than made
  twice. The same seam the highlighter runs on, one phase along. Two properties
  hold it up and `demotic/test/slots.test.ts` checks both against every `.dmt` in
  the repository: slots are in source order and never overlap, and a statement
  reassembled from its slots and the text between them is byte-identical. A line
  whose slots did not tile it shows as the text it could not read, which is the
  safe failure — a _wrong_ slot would be an editor rewriting the wrong bytes.
- **A slot describes a statement of fixed shape, and half the grammar is not that
  shape.** `when ball hits a, b, c` has as many targets as the author wrote, so
  `SourceList` records the repetition the parser already walked — each item's
  range, the clause's extent, and the three strings an edit writes. Four things
  about it are load-bearing (doc 19 §A statement's arity is editable too). A list
  _contains_ slots rather than replacing them, so the tiling property is
  untouched. An **absent** clause is a list with no items rather than no list, so
  `from above` and a `create`'s first `(…)` are reachable at all — the opener
  brings the word or the brackets with it, and dropping the last item takes them
  back out. The strings are the **grammar's**: a page that spelled ` from above`
  itself would be a second statement of the syntax, and a property list's template
  is computed from the list it is going into, because `E_DUPLICATE_PROP` makes a
  fixed one an error on the row it was just added to. And the positional
  `(x, y) as (8, 4)` is **one** list written as two halves that the language
  refuses to let drift (`E_ARITY`), so they carry each other's index and one edit
  moves both.
- **A block edit is a splice, never a re-emit.** `web/src/lib/blocks.ts` sets one
  slot's range, moves one line, inserts one line — so a row nobody touched comes
  back byte-identical because nothing rewrote it, not because something was
  careful. That is `dmtl.ts`'s bargain with a level one file type along, and it
  is what makes the editor safe to open a hand-written game with. Two characters
  are taken out of a value on the way and both would otherwise change the
  program: a newline (the language is one statement per line) and a quote (a
  Demotic string cannot contain one, since the lexer ends the literal at the
  first it meets).
- **Moving a row is an edit, so nothing may sort or tidy on its own.** Entities
  live in declaration order, which decides what is drawn over what and which
  sprite the hardware drops first past its per-scanline budget; a rule's place in
  the file is its place in the tick. An editor that grouped a file by scene on
  open would be an output-byte change dressed as a view.
- **And a drag is the weakest of the three ways to make that move.** Demotic is
  flat, so a drag expresses one number — which index — rather than a nesting the
  way it does in a language with sockets. It is also O(distance) in a list that
  scrolls, has no keyboard, and does not fire on touch at all. So the row list
  scrolls itself near an edge (without which a long move was impossible _with a
  mouse_), `Space` on the grip picks a row up for the arrows to carry with every
  step announced, and clicking the grip picks a destination out of a filtered
  list — which is O(1) and the only one of the three that is better for being a
  form. Before adding a gesture here, ask what it does for somebody with a
  keyboard and a phone, because this one did nothing for either.
- **A block editor shows a problem where the problem is.** A diagnostic goes
  against its own row, the row is marked, the count above the list leads to the
  first, and one that names no row — the _game's_, when a suite is open — goes at
  the top rather than nowhere. A list of line numbers under the editor is the text
  view's answer; a graphical view that borrowed it would be asking you to count
  lines in a thing that has no line numbers to count.
- **A row of controls per line is a tab stop per control unless something stops
  it.** Pong is 352 of them, which is a worse barrier for a keyboard than the drag
  the keyboard moves were added to replace — so the rows are a roving-tabindex
  list: Tab reaches the active row, the arrows walk between rows, and only the
  active row's fields are in the tab order. Any focus inside a row makes it
  active, which is also what decides where a new statement lands.
- **A `.test.dmt` is not a game and does not open the game demaker.** `isSuite` is
  the engine's own question and `route.ts` asks it first, because a suite is a
  `.dmt` too and the longer extension is the whole distinction. It opens the suite
  editor: the same two views over the file, the cross-console run, and no console
  picker, no cartridge and no preview — it builds to nothing.
- **The web JS budget is what one visitor downloads, not what the site is.**
  `pnpm check:web-budget` charges every chunk once _except_ the per-console ones,
  of which it charges only the largest family — because a visitor plays one
  console. The split that makes that true lives in two places and both have to
  stay split: `demotic`'s `codegen/registry.ts` answers every question about a
  family from a static description and `import()`s the emitter only when
  something builds, and the page's `src/players/` does the same for the emulator
  cores. Chunks are matched to a family **by name**, so a module that
  has to be per-family belongs in a file named after it; anything else counts as
  always-loaded, which fails loud rather than passing quietly — **unless the
  import graph proves only families reach it**, which is how a chunk _two_
  consoles share is charged to both of them rather than to everyone. That case is
  not hypothetical and it is what a shared backend costs: `codegen/m68k/` was the
  Mega Drive's alone and sat in a chunk called `md-*` until the Neo Geo shared it,
  at which point the bundler named the chunk after neither and 9.8 KB nobody on a
  Game Boy fetches was charged to every visitor. `codegen/mos/` is the same
  between the NES and the PC Engine, `rom/z80-player.ts` between the Sega 8-bits
  and the Neo Geo, and together they were overstating the page by twenty
  kilobytes. A chunk _every_ family reaches costs the same either way, so this can
  only ever help code a proper subset of consoles needs. **There is a third
  place that has to stay split, and it is `@demake/audio`'s `rom/index.ts`**:
  `buildAudioRom` reaches each console's cartridge builder through an `import()`
  for the same reason, because behind each one is a whole CPU's assembler. It
  was five static imports until the Sega and Mega Drive cartridges landed and
  put the Z80 and the 68000 in every visitor's bundle — which is what the budget
  is for. Splitting it took the _Game Boy's_ driver out of there too, where it
  had been since that feature existed: 328 KB for a visitor against 369 before.
  The shared shape a dispatch has to name lives in `rom/artifact.ts` and owns no
  assembler, because importing `BuiltAudioRom` from `gb.ts` would drag that
  family back in and quietly undo the whole thing. **The list of
  families is `codegen/registry.ts`'s own** — `runtimeFamilies`, plus `familyFor`
  for a chunk named after a console rather than its family, which `nds` is. It
  used to be a copy, and the copy went stale the moment the ARM handhelds landed:
  `gba-*.js` and `nds-*.js` are 26.8 KB gzipped of emulator and emitter behind an
  `import()` like every other core, and they were charged to _every_ visitor for
  as long as the two lists disagreed. A budget that overstates itself fails the
  next honest change, which is what it did. Current figures:
  398 KB for a visitor against a 400 KB budget, 696 KB for the whole site — and
  a new example game costs about fourteen of those kilobytes, because the page
  bundles every fixture SVG twice (raw text for the ROM build, a URL for the
  preview). The worst family is the Game Boy at 88 KB on top of the 311 every
  visitor fetches, which is where paging landed: a banked backend is three
  assembly passes and a bank planner, and it is charged to the console that has
  one rather than to everybody. **The margin is under two kilobytes**, so the next
  thing that lands in the always-loaded half is what fails this gate — measure
  before and after rather than at the end. Measure with a **clean** `dist`: the checker reads every `.js` it
  finds, so comparing two runs without deleting it in between compares two
  builds' chunks added together, which is how a passing gate can look like a
  failing one.
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
- **A 68000 `move.w` leaves a register's high half alone, so an index has to be
  widened.** `move.w col,d0` followed by `add.l d0,d1` adds whatever the last
  thing to touch `d0` left above the low word — which is a grid lookup that is
  right until it is not, and it survived two hundred and eighty ticks of a level
  game before it named itself. `ext.l` is the fix and the reason it is easy to
  miss is that the low half is always correct.
- **A machine description that is wrong _and consistent_ passes everything.**
  The Mega Duck's I/O map is used to build the cartridge and to route its writes
  in `@demake/dmg`, so a swapped pair cancels out: the game traces perfectly, the
  audio diff matches, and the ROM would do nothing on real hardware. That is why
  `packages/core/test/megaduck.test.ts` carries SameDuck's numbers _literally_
  and compares against those rather than against the table's own inverse — and
  it caught exactly that, twice. Any future variant console needs the same
  treatment: pin the description against the hardware, not against itself.
- **And a _format_ that is wrong and consistent passes everything too**, which is
  what the Neo Geo's display ROM found three times over. Its `.neo` container
  stores the P ROM **byte-swapped** (a MAME set's convention, and every emulator
  swaps it back at load); a sprite tile's **leftmost pixel is the least
  significant bit**, not the most; and the palette bank's **last entry is the
  backdrop** rather than a colour a fit may spend. In each case `packNeo…` and
  `unpackNeo…` agreed with each other, `@demake/neogeo` agreed with both, and
  every test in the project passed while no real Neo Geo would have run the file.
  The rule the encoders' own header already states — pin an encoder against byte
  offsets computed from the format description rather than against a decoder of
  ours — is necessary and was not sufficient; what settled it was booting the
  cartridge in somebody else's emulator.
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
- **Write it so it can only be read one way.** These docs compress hard, and past
  a point that stops being concision and becomes a riddle — a reader cannot
  recover a word that is not on the page. Two habits produce the bad lines and
  both were in one table in doc 13. A **pronoun pointing at a column heading**:
  "the SG-1000 needs no more of it", where _it_ was the Z80 encoder two columns
  away. And a **noun standing in for the whole action performed on it**: "a
  camera it must refuse", which meant that a game declaring a camera is rejected
  at build time, by name. Both were shorter than the clear version by about six
  words, and both cost a reader the sentence. So: name the actor, name what is
  done to it, and expand a pronoun whose referent is not in the same sentence.
  A line that needs the surrounding paragraph to be decoded is a line to rewrite,
  not to annotate. Vivid is welcome — the voice in these docs is deliberate —
  but ambiguous never is, and the test is whether one sentence read cold has
  exactly one meaning.
