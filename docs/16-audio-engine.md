# 16 — Audio: the chip layer and the render contract

The fourth and fifth faces of the same verb. `prep` demakes an image; **`arrange`
demakes a track** (doc 17) and **`sfx` demakes a sound effect** (doc 18). This
document is the layer underneath both: the hardware model, the two
representations, the chip synthesis that makes the result audible, and the
contract that says a file you play on your laptop is what the cartridge will
sound like.

It is deliberately structured as doc 03 + doc 06 + doc 10 are for images — the
hardware matrix, the emit path, and the proof — because the audio domain has the
same shape:

> **constrain → fit → emit → prove it on emulated hardware.**

**Status: the spine is built, and every console with a game backend has a
driver.** `@demake/chip` models
the Game Boy APU, the SN76489 and the NES 2A03; `@demake/audio` implements both
demakers over them; `arrange`, `sfx` and `render` are live in the CLI for `dmg`,
`gbc`, `nes`, `sms`, `gg` and `sg1000`. `demake gen <schedule> --format rom`
builds a bootable Game Boy cartridge that plays a track or an effect, from a
driver generated for it (§The driver contract), and **Level A of §The proof runs
in `pnpm test`** — the ROM boots in `@demake/dmg`, whose APU is now
`@demake/chip`'s, and every register write it makes is diffed against the
`ChipScript` tick for tick.

**And there are five more CPUs' drivers**, generated the same way. `demake build -c
nes` puts a game's music and effects in an NROM cartridge as 6502 machine code and
`-c pce` puts them in a HuCard as the *same* 6502, because a HuC6280 is one with a
memory mapper; `-c sms` and `-c gg` put them in a Sega cartridge as Z80; `-c md`
as 68000; `-c snes` as SPC700, on a processor that is not the console's own; and
`-c gba` as ARM. `packages/demotic/test/_audio-battery.ts` runs the whole Level A
battery on every one of them — the Game Boy's driver
on its timer at 120 Hz, the NES's on the picture's own interrupt at 60, the PC
Engine's on the CPU's *own* timer at 120, the Sega's
on the VDP's frame interrupt at 59.92 and writing an I/O port rather than an
address, the Mega Drive's storing a byte to an address, the Super Nintendo's on a
timer of the *sound processor's* at 125 Hz, and the Game Boy Advance's on its own
sample transfer at 128 — diffed against the same schedules with the same
tolerance, which is none. What the extra drivers prove is that the *contract* is the contract rather
than a description of one emitter: they share the packed format and — where the
CPU is the same — the stream player, and nothing below either. The third one
stretched even that, and the seam is recorded in §Two streams,
one clock: an SN76489 puts the channel in the data byte and latches it, so
"which voice does this write belong to" became a question with a running answer.
A HuC6280 asks it a third way — the channel is a *register*, latched across every
write that follows it — and the answer is the same machinery again.

The web app's audio sections are live over the same engine, the browser's `.vgm`,
sidecar, WAV and cartridge are byte-identical to the CLI's (doc 07 §The audio
sections), and the ROM pane plays whichever chip the running cartridge has. What
is not built: the remaining chips (the handhelds), a *standalone* audio cartridge
for the consoles that still have none (the Game Boy and the **NES** build one;
every other console with a driver plays it only from inside a game, and
[`console-support.md`](console-support.md)'s **audio ROM** column is where that
is stated rather than here), driver backends for the remaining consoles,
`bin`/`asm`/`c` emit, Level B sample comparison, and the lossy encoders.

**And a sixth driver, on a console whose second device is not a chip.** `demake
build -c gba` emits an ARM player, and it is the first one that has to *compute*
what it plays: four voices are a Game Boy's APU and reach it as stores, and six
are a software mixer the processor runs. Three of its answers are its own. The
**clock is the sample transfer** — sixteen FIFO refills carry one block, so the
sixteenth refill's interrupt is a block boundary, and counting transfers is exact
where a timer at the same rate is not, because a timer runs a fixed number of
bytes out of phase with a transfer that reads ahead. The **mixing is the main
loop's**, because twenty thousand cycles inside the handler are two refills the
handler then never sees. And the **driver needs working memory**, two kilobytes of
it, which no chip-driven player does.

That console is also what turned two latent bugs into failures. A register number
identifies nothing where a board has two devices — `$25` is the Game Boy channels'
panning byte *and* the mixer's fifth voice's right level — so `PackOptions` grew
`mergeChip` beside `mergeRegs`; and `sfx/index.ts` had been dropping `chip` from
every write it made since it was written, which the Mega Drive survived only
because it places its effects on chip zero.

**And the Super Nintendo, which is a fourth driver and a different shape of
problem.** Its sound hardware is a second computer: an SPC700 with its own 64 KiB,
its own timers and no access to the cartridge, so `demake build -c snes` emits two
programs and the cartridge *uploads* one of them through four mailbox bytes at
boot. Three things about it are new rather than restated:

- **The clock is not the picture's.** An 8 kHz prescaler over an eight-bit divisor
  gives 125 Hz exactly, and a frame the game overruns costs it no tempo — the only
  console in the set where that is true.
- **The shared register is a pulse.** `KON` starts the voices whose bits are set
  and does nothing to the rest, so two streams do not fold shadows the way `NR51`
  and `$4015` force. Each carries one byte — the voices it owns — and the driver
  skips a run naming anything outside it and masks a merge write down to it.
- **The chip plays samples rather than generating them**, so a `ChipScript` is
  only half an artifact. The other half is a bank of single-cycle BRR waveforms
  (§The sample bank), and it is why this console's file is an `.spc` — a snapshot
  of the sound processor's RAM, which is exactly what the cartridge uploads —
  rather than a `.vgm`, a format with no block for a sample player.

The gap that remains on it is the *echo unit* and pitch modulation, which
`@demake/chip`'s S-DSP accepts and ignores rather than half-implementing, and
interpolation, which is linear here and a four-tap Gaussian on the hardware. Both
are stated in the model. Neither touches Level A, which compares register writes.

The **Mega Drive** is the console that made both halves of this real. It has *two*
sound chips — a YM2612 and an SN76489 — and ten voices between them, and the
engine now spends all of them (AGENTS.md §Iron rules: a demaker spends the whole
machine). Three things had to exist and each generalised rather than special-cased:

- **A chip model for the OPN2.** Six four-operator voices, eight algorithms, the
  hardware's own log-sine and exponential ROM tables, envelopes with key scaling,
  detune, feedback, per-voice stereo and the channel-6 DAC — integer and
  table-driven like everything else here. The three parts that were stored and
  inert are now modelled: the LFO's pitch modulation, the SSG-EG envelope modes,
  and channel 3's four-pitch mode with the timer-driven key-on that rides on it.
  None of the three is reachable through a register the Mega Drive binding
  writes, so closing them changed no cartridge's audio by a byte — which is the
  point of doing it before a binding wants them (AGENTS.md §Iron rules: a
  demaker spends the whole machine, and a chip with a gap in it is a gap to
  close).
- **A console with two chips.** `BoundWrite.chip` already existed for it;
  `RegisterWrite` gained the same field, `render()` filters per *write* rather
  than per tick, and `mix()` takes per-chip gains that come from the binding —
  because how loud a PSG is against six FM voices is a fact about the board, and
  a chip model that knew which board it was on would no longer be one model.
- **A timbre that is fitted rather than chosen**, which is §Stage 3 of doc 17
  arriving for the first time. See that document for how the search works; what
  matters here is that it is hardware-in-the-loop — a candidate patch is played
  on the model and *measured*, not scored by a formula about what it ought to
  sound like.

The PSG half needed no change at all: the same chip at the same master clock over
fifteen, in a frame of 262 lines of 228 chip cycles, so `mdAudio` and `smsAudio`
reduce to the same rational and `psgBinding` is called rather than reimplemented.

## The load-bearing idea, restated for sound

The image engine's founding idea is that *the constraint model is data and the
optimizer is generic* (doc 02 §Extensibility). Audio hardware is, if anything, a
better fit for it than video hardware:

| Image | Audio |
|---|---|
| Master palette / RGB lattice | Pitch lattice (period registers), volume lattice (4-bit log attenuation) |
| Colors on screen at once | Channels playing at once |
| Sub-palettes per attribute cell | Channel allocation per musical span |
| Per-tile palette assignment | Which part owns which channel, section by section |
| Tile budget (unique patterns) | Pattern/order budget, ROM bytes, sample RAM |
| Tile dedup, flip-aware | Pattern dedup, **transpose-aware** |
| Dithering — faking colors the hardware lacks | Arpeggios, duty modulation, retrigger echo — faking voices the hardware lacks |
| DAC model → what the screen emits | Chip model → what the speaker emits |
| Pixel-perfect emulator comparison | Register-schedule equality + sample comparison (§The proof) |

Two of those rows are not analogies but the same problem with different units.
Palette fitting *is* channel allocation: N sources, K ≪ N slots, assignment
varying over the surface (space there, time here), solved by alternating
refinement with deterministic restarts. Tile dedup *is* pattern dedup, and
"flip-aware" becomes "transpose-aware" — a bassline repeated a fifth up is the
same pattern with an offset, exactly as a mirrored tile is the same tile with a
flag.

The differences that matter are also real, and the design does not paper over
them:

- **Time is the axis, and it is unforgiving.** A wrong pixel is a wrong pixel; a
  note 30 ms late is a wrong *rhythm*, and the error compounds across a track.
  Timing therefore gets its own fitting stage (doc 17 §Stage 5) and its own
  hard-error budget in parts per million, not a metric weight.
- **The hardware is a state machine, not a frame buffer.** You do not hand a
  console a song; you hand it a program that writes registers at the right
  moments forever. That is why the compliant artifact here is a *schedule*, not
  a picture (§ChipScript).
- **Nobody can look at a waveform and tell you it is right.** The image pipeline
  can put two PNGs side by side and let a person judge. Audio needs the person to
  listen, in real time, to the exact thing the hardware will produce — which is
  the requirement §The render contract exists to satisfy, and it shapes the whole
  package layout.

## Two representations

### `Score` — the source side, hardware-free

The musical content, with no notion of a console. It is what every ingest path
(MIDI, tracker module, or the transcription of an MP3) produces, and it is the
only thing doc 17's arranger reads.

```ts
interface Score {
  ppq: number;                    // pulses per quarter note; fixed at 960
  tempo: TempoPoint[];            // { tick, microsecondsPerQuarter } — the tempo map
  meter: MeterPoint[];            // { tick, numerator, denominator }
  key?: KeyPoint[];               // { tick, tonic, mode } — detected or declared
  parts: Part[];
  sections: Section[];            // structure, with repeats resolved (§Loops)
  loop?: { startTick: number; endTick: number };
  provenance: { format: string; sourceHash: string; confidence?: number };
}

interface Part {
  id: string;
  role: "percussion" | "bass" | "lead" | "harmony" | "pad" | "arp" | "fx";
  roleConfidence: number;         // 0..1, reported; `--role` overrides
  notes: Note[];
  polyphony: number;              // mean simultaneous notes
  timbre?: TimbreProfile;         // harmonic amplitudes + envelope (§Timbre)
}

interface Note {
  tick: number; durationTicks: number;
  pitch: number;                  // **integer cents** above MIDI note 0; 6000 = middle C
  velocity: number;               // 0..127
  drum?: DrumClass;               // percussion parts carry a class, not a pitch
  bend?: BendPoint[];             // pitch envelope, cents
  salience: number;               // 0..1, computed in analysis (§Salience)
}
```

Two choices in there are load-bearing:

- **Pitch is integer cents, not a MIDI note number.** Everything interesting in
  this pipeline is a pitch *error*: how far a note moved when it snapped to the
  console's period register, how much the whole track was transposed to make it
  fit, how a bend was approximated. Cents is the unit those errors are measured
  in (and 1 cent is comfortably below the ~5-cent discrimination threshold), so
  the representation carries them exactly and no stage has to invent a
  floating-point pitch. It is the audio counterpart of the image path insisting
  on integer lattice coordinates rather than "roughly this color".
- **Time is musical, not absolute.** Ticks plus a tempo map, because preserving
  BPM is a stated product goal and a track whose time is stored in milliseconds
  has already thrown away the grid it needs to be quantized against. Absolute
  time is derived, never authored.

### `ChipScript` — the hardware side, provably compliant

The audio counterpart of `CompliantImage`: a representation that the hardware can
execute *by construction*, carrying its own provenance, with two serializations.

```ts
interface ChipScript {
  console: string;                // "gb", "nes", … — resolves an AudioSpec
  chips: ChipInstance[];          // usually one; the MD has two (YM2612 + SN76489)
  driver: {
    rate: Rational;               // exact ticks per second, e.g. 59.7275/1 or 150/1
    source: "vblank" | "timer" | "line-irq" | "spc-timer";
    divisor: number;              // the register value that produces `rate`
  };
  ticks: TickWrites[];            // per driver tick, the writes the chip receives
  loopTick: number;               // where playback returns (§Loops)
  channels: ChannelPlan[];        // provenance: which Part each channel carries, when
  budgets: BudgetReport;          // bytes, writes/tick, sample RAM, CPU estimate
}

interface TickWrites {
  writes: { reg: number; value: number }[];   // ordered; chip-address space
  samples?: SampleRef[];                       // for sample-playing chips
}
```

**A ChipScript is a timed register-write schedule and nothing else.** That is the
single most important decision in this document, and it is what makes the render
contract below provable, because it makes four things the same object:

1. what our chip model synthesizes to produce a WAV,
2. what the generated driver must write on the console, tick for tick,
3. what an emulator's chip *actually receives* when the ROM runs — observable,
   and therefore diffable,
4. what the compliance oracle checks (every value in range, no channel
   over-committed, writes per tick within the driver's cycle budget, data within
   the ROM/RAM budget).

There is no "musical" layer left in it to disagree about. A note is not a note by
the time it reaches a ChipScript; it is a period register, a volume register and
the tick they were written on.

The two serializations mirror `CompliantImage`'s PNG-plus-manifest exactly:

1. **A native, standard file** — `.vgm` for the register-driven chips (VGM *is* a
   timestamped register log, so this is a format match rather than an export),
   `.spc` for the SNES, our own `.dmm` for the handful VGM has no chip ID for.
   Playable in existing players, which means a demade track is listenable by
   people who have never installed demake. §Artifacts has the detail and the one
   rounding caveat.
2. **A manifest sidecar** (`--emit-manifest`) with exact tick timing, the channel
   plan, budgets, the arranger's decisions, and the source hash — so `gen` can
   skip re-deriving anything and an agent can introspect the result.

## The render contract — hearing it exactly

This is the requirement that shapes the package layout, so it is stated before
the hardware tables rather than after them:

> **A file demake writes must sound exactly like the cartridge.** Not "close
> enough to judge by" — exactly, and provably, in the CLI, in the browser, and on
> the desktop.

That claim decomposes into three smaller claims, each of which is separately
testable. Together they are the audio form of doc 10's pixel-perfect credo, and
the decomposition is the same one the image path already uses: *the emulator's
framebuffer is never compared to the PNG, it is compared to `DAC(compliantImage)`*
— our model of what the hardware emits. Here it is compared to
`chip(chipScript)`.

### Claim 1 — the ROM writes exactly this schedule

The generated driver, running on the console, delivers the ChipScript's writes on
the ticks the ChipScript names. This is exact, integer, and diffable: capture the
register writes the emulated chip receives, group them by driver tick, and `diff`
against the ChipScript. No tolerance, no metric, no judgement — the same
relationship `packages/demotic/test/rom.test.ts` has with a golden trace, and for
the same reason (game state and register writes are both small exact objects,
unlike a framebuffer).

This claim is where "sounds the same" actually comes from. A sound chip is a
deterministic state machine: identical writes at identical times produce
identical output, on hardware and in any correct model of it. Everything else is
about making sure our model is correct.

### Claim 2 — our chip model is a correct model of the chip

`@demake/chip` (§Packages) implements each sound chip as a cycle-clocked,
integer, register-driven synthesizer producing samples at the chip's **native**
rate. It is a tested artifact in exactly the sense doc 10 means when it says the
DAC models are tested artifacts — it decides comparisons, so it is validated
three ways:

- **Hardware test ROMs.** The chip-behaviour suites the homebrew community
  already trusts (`dmg_sound`, `cgb_sound`, the NES APU tests) run inside our own
  cores and must pass. These are not checked in — a provisioner fetches them and
  the suite self-skips without it, exactly like the emulator harnesses.
- **Analytic unit tests.** Frequency of a written period register against the
  documented formula; envelope step timing against the frame sequencer; LFSR tap
  sequences against the documented polynomial; the NES's non-linear mixing
  against its published curve. Hand-computed vectors, like the color-space tests.
- **Cross-validation against reference cores.** Same ROM, same frames, our model
  versus the emulator's own audio output at native rate (§The proof).

### Claim 3 — every surface plays that model's output and nothing else

One renderer, all three faces, mirroring the image path's "one engine, four
faces" rule and doc 07's "the web app must never grow conversion logic":

- The **CLI** writes the file by calling `render(chipScript)`.
- The **web app** plays the *same* PCM buffer through a Web Audio
  `AudioBufferSourceNode`. Web Audio is a playback device here, never a
  synthesizer: no `OscillatorNode`, no `BiquadFilterNode`, no
  `AudioWorklet` DSP. The moment the browser synthesizes anything, the page has a
  second implementation and the guarantee is gone.
- The **desktop app** plays the file the sidecar CLI produced (doc 08's parity
  argument, unchanged).

There is a fourth face, and it is the one that made the rule concrete: a
**running cartridge**. The page's ROM pane plays a game's sound while the
emulator executes it, which is the same claim with no schedule to render ahead of
time — the chip has to be listened to as it goes. `StreamSink` is that, and it is
deliberately not a second renderer: same box integration, same boundary
arithmetic from an absolute sample index, same DC blocker, carried across calls
rather than restarted (restarting it per chunk is a step at every frame boundary,
which is sixty clicks a second). `packages/chip/test/stream.test.ts` asserts the
two produce identical samples for identical writes, in any chunk size, which is
what keeps "the page plays the chip" true of the emulator as well as of a
preview.

One consequence for whoever drives it: **with sound on, the audio device is the
clock.** The pane runs emulator frames until the chip has produced the samples
the player still needs, rather than on the frame clock. A tab's display and audio
clocks differ by a few parts per million, which is a click every few minutes if
the emulator follows the wrong one.

Two browser traps this rule walks straight into, both documented because both
will otherwise be found the hard way:

- **Sample-rate conversion.** A `AudioBuffer` whose rate differs from the
  `AudioContext`'s is resampled by the browser, differently per engine. So the
  context is constructed as `new AudioContext({ sampleRate: 48000 })` and we
  render at 48 kHz. If the constructor rejects that rate (rare, but permitted),
  the page renders at the context's actual rate — through *our* resampler — and
  says so.
- **Nothing else in the graph.** No gain automation, no `preservesPitch`, no
  compressor. Volume is applied inside our render or not at all.

The determinism suite (doc 10 §5) grows the audio counterpart of its PNG
byte-identity check: convert a fixture in Node and in each browser engine, and
the exported audio bytes must be identical. That is the same test the image path
already has, and it is what makes Claim 3 a fact rather than a policy.

### What "exactly" means — raw chip versus board

There is one honest wrinkle, and it is the direct counterpart of doc 04's
author-space-versus-panel-filter rule, so it gets the same treatment: an explicit
model, a stated default, and a flag.

A console's speaker output is the chip's output *after an analog stage* — the
DMG's high-pass capacitor (the reason a Game Boy's square waves sag toward zero),
the NES's RC filters and its non-linear channel mixing, the Mega Drive's
notoriously coloured output amplifier and the YM2612's ladder-DAC crossover
distortion, the SNES's Gaussian sample interpolation and echo FIR.

The split is the same one doc 04 draws between a DAC that *is* the hardware's
output and a panel filter layered on top:

- **Inside the chip → always modelled.** NES non-linear mixing, SNES Gaussian
  interpolation and echo, YM2612 operator arithmetic and its DAC's actual
  quantisation. These are not colouration; they are what the chip computes, and
  omitting them would make our model wrong, not merely dry.
- **Outside the chip → modelled, opt-in, off by default.** Board-level filters
  and amplifier character live behind `--output-stage board` (default `raw`).
  Emulators differ here — some apply a high-pass, some do not — so `raw` is the
  encoding in which our model and a core can actually be compared, and it is
  therefore the default for exactness. `board` is the "what it sounds like in
  your hands" render, and it says so in the manifest.

`--output-stage` is recorded in the manifest and in `--json`, because an audio
file that does not say which of the two it is would be as ambiguous as a PNG that
does not say whether it holds author-space or panel-filtered colors.

### Artifacts — which file formats carry the guarantee

The guarantee is a property of *lossless* audio. Stating it precisely:

| Format | Flag | Exact? | Purpose |
|---|---|---|---|
| **WAV** (PCM s16/s24, 48 kHz) | default for `--preview` | **yes**, byte-golden | the canonical render; CI goldens; the thing every other file is derived from |
| **FLAC** | `--preview-format flac` | **yes**, sample-identical to the WAV | the recommended shareable file: lossless *and* plays natively in Chrome, Firefox, Safari, macOS and Windows |
| **M4A / AAC**, **Opus**, **MP3** | `--preview-format m4a\|opus\|mp3` | **no** — lossy by construction | convenience for sharing and for size; encoder pinned so the *bytes* stay deterministic, but the *audio* is an approximation of the exact render |
| `.vgm` / `.spc` | the primary artifact | exact (it *is* the schedule) | plays in chip-music players; feeds `gen` |

So the answer to "give me a standard file I can play in a browser or on my
desktop that is guaranteed to sound like the ROM" is **FLAC** — and this is worth
saying loudly in the README, because the instinct is to reach for M4A and M4A
cannot carry the guarantee. AAC at 256 kbps is transparent to most listeners on
most material, but "transparent to most listeners" is not the claim this project
makes anywhere else and it will not start making it here. A lossy export
therefore carries a manifest note and a `--json` field saying it is lossy, and
`inspect --source` refuses to score one against a chip artifact without
`--allow-lossy`, because the metrics would be measuring the encoder.

Encoders are pinned WASM builds used identically on Node and in the browser, on
exactly the doc-02 reasoning that governs the JPEG/WebP decoders.

## The `AudioSpec` schema

One declarative object per console, living in `core` beside the `ConsoleSpec` and
referenced from it, so `demake consoles --json` self-describes audio without
`core` growing an audio pipeline (doc 02's dependency direction, unchanged):

```ts
interface AudioSpec {
  chips: ChipRef[];               // ["gb-apu"] | ["ym2612", "sn76489"] | ["s-dsp"]
  driver: {
    sources: DriverClock[];       // vblank | timer | line-irq | spc-timer
    rateRange: [min: Rational, max: Rational];
    writesPerTick: number;        // cycle budget expressed as a write count
  };
  budgets: {
    romBytes?: number;            // data budget for music + effects
    sampleRamBytes?: number;      // SNES ARAM, NDS main-RAM share
    cpuFraction: number;          // fraction of a frame the driver may spend
  };
  mixing: {
    channels: 1 | 2;              // mono or stereo out
    perChannelPan: boolean;
    nonLinear?: "nes-tnd" | "none";
  };
  outputStage: OutputStageModel;  // §What "exactly" means
  docs: { sources: string[] };    // primary references, as doc 03 requires
}
```

A **chip** is defined once and shared by every console that has one — the
SN76489 appears on the SMS, the Game Gear, the SG-1000, the ColecoVision *and*
alongside the YM2612 on the Mega Drive, and it must be one implementation in one
place. Each chip declares its channels:

```ts
interface ChannelSpec {
  kind: "pulse" | "wave" | "noise" | "triangle" | "fm" | "sample" | "poly";
  pitch?: {
    formula: "period-divide" | "rate-multiply" | "poly-divider";
    clockHz: number; bits: number; divisor: number;
    // → the exact set of frequencies this channel can produce; the pitch lattice
  };
  volume: { steps: number; law: "linear" | "db"; stepDb?: number };
  duties?: number[];              // e.g. [0.125, 0.25, 0.5, 0.75]
  envelope?: HardwareEnvelope;    // what the chip does without driver help
  waveform?: { samples: number; bits: number };   // wavetable RAM shape
  noise?: { lfsrBits: number[]; periods: number[] };
  panning?: "none" | "lr-enable" | "lr-level";
}
```

The pitch lattice is the part that earns its keep. From `formula`, `clockHz`,
`bits` and `divisor` the engine derives the complete set of frequencies a channel
can emit, and therefore the *cents error* of any requested note — the audio
counterpart of snapping a color to RGB555 and knowing exactly how far it moved.
Two consequences fall straight out and are used all over doc 17:

- **The error is not uniform.** On the Game Boy a pulse channel's period register
  gives roughly −0.6 cents at A4 and about +11 cents at A6 — the lattice
  coarsens as pitch rises, so a melody in the top octave detunes while the bass
  is nearly exact.
- **Channels have hard pitch floors and ceilings.** The SN76489 cannot go below
  about 109 Hz (A2) at all: its 10-bit divider runs out. A bassline that lives
  below that is not "slightly off" on an SMS, it is *unplayable as written*, and
  the arranger must octave-fold it or hand it to the periodic-noise channel,
  which is exactly the trick period SMS composers used. A constraint the spec
  states is a constraint the optimizer can plan around; one it omits becomes a
  bug report about a bassline that vanished.

## The chips

Values here are planning working values, and doc 03's rule applies unchanged:
every spec file cites primary documentation, and the numbers are ultimately
locked by the tests, not by this table.

### Tier 1 — the launch set (matching doc 03's tiers)

| Console | Chip(s) | Channels | The constraint that shapes arrangement |
|---|---|---|---|
| **Game Boy / Color** | GB APU (DMG/CGB) | 2 pulse (4 duties, 4-bit envelope, sweep on ch1), 1 wave (32 × 4-bit RAM), 1 noise (15/7-bit LFSR) | Four voices, one of which only does noise. The wave channel is the swing vote: bass, or a distinctive lead, not both. Hardware envelopes are decay-only, so swells cost driver writes. Stereo panning per channel (NR51) is free and under-used |
| **NES** | 2A03 | 2 pulse (4 duties, envelope, sweep), 1 triangle (**no volume control**), 1 noise (16 periods, tonal short mode), 1 DPCM | The triangle is on/off — it is a bass voice and cannot be dynamic. DPCM buys real drums for real ROM bytes, and stalls the CPU while it plays. Non-linear mixing means channel balance is not additive |
| **SMS / GG / SG-1000** | SN76489 (T6W28-like stereo on GG) | 3 square (fixed 50% duty), 1 noise (3 rates or ch3's pitch) | **No envelopes at all** — every volume shape is driver writes, so expression has a direct data cost. No duty variation, so timbre comes from arpeggio and vibrato. Hard pitch floor ~109 Hz; periodic noise is the bass trick. GG adds per-channel stereo |
| **Mega Drive** | YM2612 + SN76489 | 6 FM (4-operator, 8 algorithms), ch6 switchable to 8-bit PCM; plus the 4 PSG channels | The only Tier-1 target where *timbre is fitted*, not chosen: a 4-op FM patch is a search problem against the source's spectrum (doc 17 §Stage 3). PCM on ch6 costs CPU per sample. **Built, both chips**, and the first console here to need per-write chip routing |
| **SNES** | SPC700 + S-DSP | 8 sample voices, ADSR/GAIN, per-voice stereo, echo (8-tap FIR), noise, pitch modulation | Sampling, not synthesis: the "palette" is a **sample set in 64 KB of ARAM**, shared by the whole track, minus driver and echo buffer. This is the tile-budget problem with different units. The driver is a separate program for a separate CPU. Pitch is a **multiplier**, not a divider — the only chip here that counts up, so its lattice is uniform in frequency and nothing needs octave-folding |
| **GBA** | 2 DirectSound PCM + the 4 GB APU channels | software-mixed voices at a timer rate | The constraint is *CPU*, not channels: a software mixer costs cycles per sample per voice. Budget is mixing rate × voices, and ROM for samples |
| **NDS** | NDS SPU | 16 sample players, of which ch8–13 switch to a duty generator and ch14–15 to a noise shift register; seven-bit panning *level* per channel | **Built.** The widest palette in the set by a factor of three, and the one with *nothing shared*: no panning byte, no enable mask, no key-on pulse, so two streams sharing the chip never write the same register. The channels answer the **ARM7 alone**, so the driver is the cartridge's second binary and the game reaches it by writing two bytes of shared main RAM. Pitch is a divider whose *step* is the channel's kind — one sample, an eighth of a square-wave cycle, one shift |

### Tier 2

| Console | Chip | Channels | Notes |
|---|---|---|---|
| PC Engine | HuC6280 PSG | 6 × 32-sample, 5-bit wavetable; ch5/6 noise; direct DAC write mode; ch2 modulates ch1 | **Built.** Every voice is a wavetable, so which timbre a voice plays is the demaker's choice rather than the hardware's — and the demaker makes it at **boot**, because a driver uploads a waveform through the register port rather than selecting one. The five pitched voices therefore hold five different shapes at once, which is more than any other eight-bit console here can hold. Volume is three attenuators in series in 1.5 dB steps; the channel is a *register* and the chip latches it, so the driver skips a preempted run whole as an SN76489 driver does; and no register is written by both streams, so the build emits no merge routine. The **LFO** is modelled and is unlike every other vibrato in the set: there is no oscillator, channel two *is* the modulator, so switching it on costs a voice and the depth is a shift on the *divider* rather than on the pitch. Fitting a 32 × 5-bit waveform to a target spectrum is Stage 3 in miniature, and demake does not attempt it yet; nor does anything above the chip layer stream samples into the direct D/A |
| Neo Geo | YM2610 | 4 FM + 3 SSG square + 6 ADPCM-A + 1 ADPCM-B | Abundant; the work is the ADPCM budget and the Z80 sound program |
| WonderSwan / Color | WS sound | 4 × 32-sample 4-bit wavetable; ch2 PCM voice, ch3 sweep, ch4 noise | **Built, both machines.** The only chip here whose waveforms are the *console's own RAM* — port `$8F` names a sixty-four-byte page and the four channels take sixteen bytes each — so a timbre is a memory write, the bank is bytes a driver copies rather than register writes it performs, and the address is one constant three things read. Its pitch register is the only one in the matrix that counts *up*: it is subtracted from 2048, so a larger value is a higher note. Noise is a **tap** rather than a rate — eight positions on a fifteen-bit register decide the sequence's length while the channel's own divider decides its pitch — so a drum has a colour and a pitch where a Game Boy's has only a period. `$90` carries all four enables and is the byte two streams merge into. Channel two's **PCM voice** is modelled too — `$90` bit 5 turns that channel into a direct D/A whose sample is the whole of `$89` and whose only level is the full-or-half pair in `$94` — so this hardware can play a recording on one of its four voices, which nothing above the chip layer asks it to yet |
| Neo Geo Pocket (C) | T6W28 | 3 square + 1 noise, **independent L/R attenuation** | A genuinely stereo PSG — panning is a real arrangement tool |
| Atari Lynx | 4 × poly-counter channels | 4 | Polynomial taps rather than duty; timbre is chosen from a small discrete set |
| Atari 7800 | TIA (+ optional POKEY) | 2 (+4) | See the 2600 note below; POKEY carts change the picture entirely |

### Tier 3 — the long tail, and the interesting extremes

| Console | Chip | Why it is worth doing |
|---|---|---|
| **Atari 2600** | TIA | 2 channels, 5-bit frequency divider, 4-bit volume, 4-bit waveform select. The pitch lattice is so coarse that most notes are *unplayable in tune* — this is the console where "preserve intervals and let the whole thing transpose" stops being a nicety and becomes the only way to produce music at all. The showcase for doc 17 §The judge |
| **Virtual Boy** | VSU | 6 channels, 5 wavetable + noise, sweep/modulation, 4-bit stereo per side |
| **Pokémon Mini** | single pulse | **One channel.** The DMG of audio: the extreme reduction case, and the best test the arranger will ever get of "what is this song, minimally?" |
| Intellivision | AY-3-8914 | 3 square + noise + shared envelope generator |
| Atari 5200 / 8-bit | POKEY | 4 channels, poly distortion, paired 16-bit mode for accurate pitch |
| ColecoVision | SN76489 | free once the SMS family exists |
| Supervision, Game.com, Mega Duck | GB-APU-like variants | ride the GB family with register remapping |

Primary sources each spec must cite (the doc-03 verification rule, extended):
Pan Docs §Audio for the GB APU; the nesdev wiki APU pages; SMS Power's SN76489
documentation; the YM2612 register documentation and Nuked-OPN2's behavioural
notes; fullsnes and anomie's SPC700/S-DSP documents; GBATEK for GBA and NDS
sound; the neogeodev wiki for the YM2610; the Virtual Boy programmers' manual;
`wsman` for the WonderSwan; the Stella Programmer's Guide for the TIA; the POKEY
datasheet; and the VGM specification for the artifact format.

## Determinism engineering

`@demake/audio` lives under the same two lint rules as `core` — platform-purity
and determinism — and audio DSP strains the second one much harder than image
code does. The rules that follow from it:

- **No `Math.*` transcendentals.** FFT twiddle factors, window functions, mel
  filterbanks, dB conversions and resampler kernels all come from
  `packages/core/src/math/kernels.ts`. An FFT seeded with `Math.cos` is an FFT
  that returns different low bits in Firefox, and every downstream metric
  inherits it.
- **Analysis runs at one canonical rate.** All decoded input is resampled to
  **48 kHz mono float32** for analysis and to 48 kHz stereo for render, by our own
  deterministic polyphase sinc resampler. Input sample rates vary wildly; the rest
  of the engine must not have to care.
- **Chip models are integer.** They generate samples at the chip's native rate
  using the same arithmetic the hardware does. Float appears only in the mix and
  resample stage, at defined points.
- **The mixdown is fixed-order.** Chips are summed in spec order, resampled after
  summing, and the final quantization to s16 rounds half-to-even with **no
  dither** — dither would be a random process in an output that has to be
  byte-golden.
- **Decoders are pinned WASM** (MP3, AAC, Vorbis, Opus) or pure TS where the
  format is integer (WAV, AIFF, FLAC). Same reasoning, same vendors, same pinning
  discipline as the image codecs.
- **No wall clock anywhere**, including in the "how long is this effect" logic.

## The driver contract

`gen` on an audio artifact emits the same four formats it emits for images
(doc 06), with one addition that has no image counterpart: **the player code**.

| Format | What it is for audio |
|---|---|
| `bin` | the packed music/effect data blobs, in the driver's own format |
| `asm` | the data plus the driver source for the family's assembler |
| `c` | the data as arrays plus a header, for GBDK/SGDK/devkit users |
| `rom` | a bootable ROM that plays the track — the audio counterpart of the display harness, and the foundation of the proof loop |

**Built today: `rom`, for the Game Boy family** — and, inside a game rather than
as a cartridge of its own, a driver for every other console with a backend: 6502
for the NES, Z80 for the Sega 8-bits, 68000 for the Mega Drive, SPC700 for the
Super Nintendo and ARM for both handhelds (§Two streams, one clock). Two of those
are not on the console's own processor at all, and the two are not alike: a Super
Nintendo's is *uploaded* into a chip's private RAM through four mailbox bytes, and
a Nintendo DS's is simply **the cartridge's other binary** — a `.nds` names two
programs, the loader copies both into the memory they share, and the driver is
running before the game's first frame.
`bin`/`asm`/`c` are named
errors rather than approximations, because the order list holds *absolute
addresses* the driver resolves at assembly time: a relocatable blob would be a
second data format, and two formats is how the ROM and the blob quietly stop
agreeing. They land with an emitter that shares one format with the ROM.

Unlike the image path, this driver is not assembled by a third-party toolchain.
The image `rom` builders pair generated *data* with a checked-in display program
per CPU family, so buying eight assemblers off the shelf was far cheaper than
writing eight encoders — but it costs the browser, which has none of them. A
driver is generated code and there is no harness to check in, so the Game Boy
backend does what the Demotic backend already does: emits SM83 through `core`'s
own assembler (`packages/core/src/asm/sm83.ts`, shared by both). The NES driver
emits 6502 through `core`'s (`asm/mos6502.ts`) and the Sega driver Z80 through
`core`'s (`asm/z80.ts`), each shared with that console's game backend the same
way. That is what makes Level A a test with no toolchain and the page a place a
cartridge can be built — on every console with a backend.

The driver is generated, not fixed, and for exactly the reason doc 14 §2 gives
for games: *a fixed engine ships every feature because it cannot know which ones
this song uses.* A track with no vibrato ships no vibrato code; a track that never
touches the noise channel ships no noise handling. The pull-based
`ctx.need(name, body)` discipline the Demotic backend already uses is the model,
and the same rule applies — helpers are pulled, never pushed, and never pruned
afterwards.

What the driver must guarantee is narrow and testable: **on tick N it performs
exactly the writes `ChipScript.ticks[N]` lists, in order, within the cycle
budget.** Everything else — how the data is compressed, whether patterns are
shared, how the order list is walked — is the emitter's business, because none of
it is observable in the register stream.

Data compression is the tile-budget stage's counterpart: rows dedup into
patterns, patterns into an order list, and a pattern that recurs *transposed* is
stored once with an offset. Over budget, the emitter reports what it dropped and
`--strict` errors instead.

## Two streams, one clock

A cartridge whose only job is one track is the easy case, and it is not the case
a *game* presents. A game has a track per scene and an effect per event, both
wanting the same four channels at the same moment, on a machine with one timer.
Three decisions follow, and they are all facts about the hardware rather than
preferences.

**One interrupt, one rate.** The Game Boy has one timer, so music and effects
step on the same tick. The game states the rate and everything is fitted to it —
`arrange` takes `driverHz` and `sfx` takes `rateHz`, and both go through the
binding's own `fitRate`, so the two agree by construction rather than by
arithmetic. The rate a game uses on that machine is half the rate a standalone
effect gets: music barely notices it (row placement is absolute, so the tempo is
exact at any rate), an effect notices it twice — a long one packs to fewer bytes,
and eight milliseconds is still twice as fine as the sixty-hertz tick the
machine's own games drove their drivers with.

**And *which* interrupt is the console's answer, not the game's.** The NES has no
general-purpose timer a driver can have without burning the DMC channel, so its
one honest clock is the frame the picture already runs on, and its games run at
the console's frame rate rather than at 120 Hz. Asking for a finer rate there
would not buy resolution: the driver would tick twice in a row at the top of a
frame and then not at all for sixteen milliseconds — a schedule performed
correctly and heard wrongly. `gameDriverRate` is where that is decided, in the
package that owns the drivers, because it is a fact about the code that has to
keep the rate rather than about the game asking for one.

The Sega 8-bits reach the same answer by a different route, and it is worth
recording because their spec says otherwise. `AudioSpec` lists `line-irq` among
their clock sources and `psgBinding.fitRate` will happily return a rate a long way
above the frame — but the VDP's line counter is **reloaded on every scanline
outside the active display**, so an interrupt programmed for every N lines fires a
handful of times inside the picture and then not at all until the next frame.
That is a usable raster effect and not a tempo. A game's driver therefore rides
the frame at 59.92 Hz, and `fitRate` treats the frame as the candidate every other
clock has to beat rather than as a fallback for when none is in range.

The frame is also *counted* rather than ridden directly, on both frame-clocked
machines: the handler increments a byte and the main loop performs whatever it
says, so a frame the game overran is caught up rather than lost, and the blanking
interval stays the picture's. A driver tick taken inside the handler is a driver
tick the tilemap upload waits behind.

**Preemption is by run, not by write.** An effect takes a channel while it plays
and gives it back when it ends; the music stream skips the writes that would
fight it. Deciding that per write would cost the test on every write of every
tick, so the packed data groups *consecutive* writes that agree about which
channel they belong to and the decision is taken once per group. The grouping
never reorders anything, which is the property the proof rests on: with nothing
preempting, a run-packed stream performs exactly the writes the `ChipScript`
lists, in the order it lists them, exactly as the flat encoding does.

**And on one chip, which channel a write belongs to is a running answer.** Two of
these chips put the channel in the register's address; the SN76489 has one write
port and puts it in the top bits of the *data* byte — and only in some bytes,
because a byte with bit 7 clear continues whatever the byte before it selected.
So `channelOf` is a **factory** for a tag carrying a per-schedule latch, and every
write is offered to it, including the ones the run format then never asks about.
Grouping by run is also what makes skipping safe here: every run of a PSG stream
opens with a latch byte, so a run the music skips takes its own selection with it
and the next one that *is* written selects again before it writes anything. That
property is checked rather than assumed — `E_PSG_LATCH` refuses a schedule whose
tick opens with a data byte and no latch in front of it, because the symptom of
getting it wrong is a note on the wrong voice several ticks later.

**`NR51` is merged, never stored.** One byte carries every channel's panning, so
a stream that wrote it whole would erase the other stream's channels. Each stream
keeps a shadow of the value it wants and the driver folds the two under the mask
of what is currently borrowed — which means that with nothing preempting, the
byte the chip receives is exactly the one the schedule asked for, and the
exactness above survives the sharing. Every chip has such a byte and the rule
generalises unchanged: on the NES it is `$4015`, the channel enable mask, whose
four bits *are* the four channel bits — so the fold is two `and`s where the Game
Boy needs a nibble swapped first, and clearing a bit is also how that machine
silences a channel at all.

Not *quite* every chip, as it turns out. A Master System's PSG has four
independent attenuation latches and nothing shared, so there is no byte for one
stream to erase the other's half of and no merge routine anywhere in the
cartridge. A Game Gear is the same chip with a stereo latch bolted beside it,
carrying every channel's left and right enables four bits apart — `NR51`'s exact
shape, reached by different hardware — and the merge comes straight back. Two
machines, one backend, and this is the only thing in the driver that differs
between them.

A PC Engine has no shared register either, for a third set of reasons: the
driver writes the chip's global level once at boot, panning is the channel's own
balance byte, and the chip has no enable mask and no key-on pulse — so two streams
sharing it never write the same register. What the two streams *do* share is the
**channel selection**: register `$00` says which channel the eight registers above
it address, so a run the driver skips must carry its own select, and every run
must therefore open with one. That is the SN76489's latch discipline reached
through a register rather than through a data bit, and `checkSelectDiscipline`
refuses a schedule in which some run does not open with a select.

The Nintendo DS says the same thing from the other end of the range. Sixteen
channels, and *nothing* is shared: panning is a byte per channel rather than two
bits of one, enabling is the channel's own start bit rather than a mask, and there
is no key-on pulse to mask either. So the widest palette in the set and the
narrowest one reach the same driver — no merge routine at all — for opposite
reasons, and what preemption costs there is the four-bit run field, which sixteen
channels do not fit and do not need to (§the Mega Drive's answer, one console
over: only the channels an effect was placed on are numbered).

Two things are *not* in the schedules and are performed once at boot instead: the
chip's power-up writes, and the wave-table upload. An effect that re-ran the
chip's initialisation would silence the music every time it fired. And an effect
is restricted to the channel it borrows — its schedule opens by stating every
channel's state, which is right for a cartridge that owns the chip and wrong for
one borrowing a voice — with the writes that were dropped counted in the build
report, on the "never lose a part silently" rule.

Only what a game uses is emitted. A game with music and no effects packs the flat
format, stores `NR51` outright and has no preemption test anywhere in it; one
with effects and no music has no music player at all. That is the same
pulled-not-pushed discipline as everything else here, applied inside a routine
rather than between routines.

## The sample bank

Every other chip demake targets generates its own waveform from a duty cycle, a
staircase or a shift register. Two do not — the S-DSP and the Nintendo DS's SPU —
and a third, the Game Boy Advance's mixer, is demake's own software. The S-DSP
generates nothing: a voice reads
compressed blocks out of the sound processor's RAM, so a demade arrangement needs
waveforms to *exist* before a note can sound. `packages/audio/src/binding/sdsp-bank.ts`
is where they come from, and three decisions in it are load-bearing.

**They are single cycles, sixteen samples long** — one BRR block each, looping to
itself. That is not a compromise: sixteen samples is the block length the format
is built around, a looping single cycle is what an oscillator *is*, and it makes
the pitch register a plain multiplier of `32000 / 16 = 2000 Hz`. The whole bank is
under a hundred bytes of the 64 KiB.

**The file is one definition with two readers.** The binding puts a waveform's
index in a voice's `SRCN`; the driver builder uploads those bytes to that address.
A second copy of either number is a game whose bass plays the snare.

**A schedule carries the bank rather than assuming it.** `ChipScript.sampleRam`
exists for exactly this, and `render()` defaults it to the built-in bank — so the
CLI's WAV, the page's playback and the cartridge's output are the same waveforms
without every caller having to remember. It is the one place the "a schedule is a
complete artifact" claim needed qualifying, and it is a fact about sample hardware
rather than a leak in the representation.

**The Nintendo DS's bank is the same three decisions with the addresses moved**
(`packages/audio/src/binding/nds-bank.ts`). Single cycles, but **thirty-two
samples** rather than sixteen, because this chip's pitch is a *divider*: a longer
cycle is a larger period and therefore a finer lattice everywhere a melody lives,
for eight bytes a waveform. And the bank is not uploaded into a private memory —
a channel's source register is an **absolute address**, so the bank has to *be*
somewhere both the binding and the driver name, and it is a page of main RAM below
the ARM7's binary that the driver copies its own bytes into at boot. Main RAM
rather than the sound processor's faster private 64 KiB deliberately: every piece
of software on the console streams from main RAM, so a model that turned out to be
wrong about the other could not hide behind a cartridge written to the same wrong
belief.

## The proof

Doc 10 gains an audio section; the summary of it belongs here because it is the
justification for the whole ChipScript design.

**Level A — schedule equality (exact, runs in `pnpm test`).** *Built for the Game
Boy as a cartridge of its own (`packages/audio/test/rom.test.ts`), and for every
console with a game backend inside a game — the Game Boy, the NES, the Sega
8-bits, the Mega Drive, the Super Nintendo, the Game Boy Advance and the Nintendo
DS (`packages/demotic/test/_audio-battery.ts`).*
Boot the generated ROM in a core we own,
log every write to the chip with its tick, and diff against the ChipScript.
`@demake/dmg` grew its APU by consuming `@demake/chip` — which it needed anyway
for the web app to have sound — and the audio conformance suite is a plain unit
test with no toolchain and no emulator install, exactly as
`packages/demotic/test/rom.test.ts` is. This is the strongest oracle in the audio
domain and it is where the sound guarantee actually comes from.

Two details of the built version are load-bearing. Ticks are attributed **by
program counter**, not by a marker the ROM writes: the driver's `Tick` label
comes back in the build's symbol table, so nothing is added to the cartridge to
make it observable and the ROM under test is the ROM that ships. And the tap
(`Gameboy.apuTap`) *observes* rather than intercepts — the write still reaches
the chip — because an oracle that changed what the hardware saw would be testing
itself.

**Level A, for a console whose chip is a mixer.** The Game Boy Advance is the one
machine here where "the writes the chip received" does not describe half the
sound: six of its ten voices are `@demake/chip`'s `GbaPcm`, a register file of
demake's own that the *processor* reads, so nothing about them crosses a bus and
there is no register stream to diff. What the driver owes there is **the samples
themselves**, byte for byte, against what the model renders from the same
schedule — and that is a sharper claim than a register diff, not a weaker one,
because the comparison is against the audio rather than against an instruction to
make it. It is exact because the mixing is integer throughout. The two halves are
proved in the two places that can prove them: the four Game Boy channels by the
shared battery, and the six mixer voices by
`packages/demotic/test/audio-gba.test.ts`, which taps the bytes crossing into the
converters' queues (`Gba.fifoTap`) and observes rather than intercepts, exactly as
the register tap does.

One trap is worth stating, because it makes such a test pass while proving
nothing: the arranger gives each part the channel that serves it best, so a
four-part MIDI on a ten-voice console uses four voices — and on this one they
would usually be the Game Boy's. A mixer diff pointed at such a track compares
silence with silence. That is why the example library is written around ten parts
wide rather than four (AGENTS.md §Writing music), and why the proof still *names*
the track it is pointed at rather than trusting any track to reach the mixer.

**Level B — sample comparison against third-party cores (CI).** The existing
libretro harness already receives an audio callback and currently discards it;
writing those samples out is a small extension to `emu-harness/libretro/`. The
core's audio is compared against our chip model's render.

Honesty about what this level can claim, in the spirit of doc 10's existing notes
about RGB565 and RGB555 comparisons: **it is not bit-exact, and it should not
pretend to be.** Cores resample and filter on their own terms, and several model
the analog stage we deliberately leave out of `raw`. The comparison is therefore
a pinned spectral-and-envelope distance with a per-core threshold, plus **exact
equality of transient onset ticks**, which is the part that would actually catch a
driver-timing bug. Where a core exposes scripted register access (Mesen 2's Lua
interface, for instance), that console gets Level A too and Level B becomes a
cross-check rather than the primary oracle.

**Level C — chip-model validation.** §Claim 2's three-way validation, run as its
own suite.

**Goldens.** Because our synthesis is deterministic, the rendered **WAV is a
golden artifact** — byte-compared like a PNG, with the same re-baselining
discipline (doc 09 §Stability: an output-byte change needs a minor changeset and
a release note in the same PR). This is a much cheaper and much sharper
regression net than any perceptual metric, and it exists only because §The render
contract insisted on one renderer.

**Listening, not just measuring.** Doc 04's hard-won lesson — that prep quality
changes need eyes on `pnpm eval:prep` sheets and not just numbers — applies with
double force to audio, where the metrics are further from perception than image
metrics are. The evaluation batteries (doc 17 §Evaluation, doc 18) produce HTML
sheets with the source and every candidate as inline players, and a judge-score
change is confirmed by ear before any baseline moves.

## Packages

Two new packages, and one small addition to an existing one:

| Package | Contents | Depends on |
|---|---|---|
| **`@demake/chip`** | Every sound chip as a cycle-clocked, integer, register-driven model; the deterministic mixer and resampler; the output-stage models | **nothing** |
| **`@demake/audio`** | The two demakers: ingest, analysis, arrangement, timbre fitting, the judge, the drivers and emitters | `core`, `chip` |
| `@demake/dmg` | *gained* an APU, implemented by consuming `@demake/chip` | `chip` |

`core` also holds the **SM83 assembler and the Game Boy cartridge header**
(`src/asm/`). They moved there out of `@demake/demotic` when the audio driver
became the second thing that emits Game Boy machine code; a header implemented
twice would not disagree loudly, it would disagree in one byte, in one of the
two, and the symptom would be a ROM that boots in an emulator and not on
hardware.

`@demake/chip` depending on nothing is the same rule `@demake/dmg` already
follows, and for the same reason: it is a hardware model, not conversion logic,
and the dependency direction is what keeps that honest.

**Why the chip models are not inside `@demake/audio`:** `@demake/dmg` needs a
Game Boy APU to give the web app sound, and `@demake/audio` needs a Game Boy APU
to render a preview. Those must be the *same* APU. A second implementation of a
chip is how the preview and the emulator quietly stop agreeing — the same failure
mode doc 07 names when it forbids the web app from growing its own conversion
logic, and doc 14 names when it forbids a second art converter in `demotic`.

`core` gains only data: `src/consoles/audio.ts` (the `AudioSpec` and
`ChannelSpec` types) and an `audio` block on each `ConsoleSpec`. No audio
pipeline enters `core`, and nothing in `core` imports `chip` or `audio`.

## CLI surface

Two new verbs, one extended verb, one convenience — following doc 05's flat verb
convention, and dispatching on the input's format the way `check` and `inspect`
already dispatch on file extension.

```
demake arrange <track>  -c <console>   # doc 17: any music → compliant chip music
demake sfx     <sound>  -c <console>   # doc 18: any sound → a compliant chip effect
demake gen     <chip artifact> -c <console> --format bin|asm|c|rom
demake render  <chip artifact> -o out.wav|flac|m4a
demake inspect <chip artifact> [--source <original>] --json
```

`gen` extends rather than forks because its job is already "emit code for this
console", and its exact-path detector has a precise audio counterpart: a `.vgm`
whose chip, driver rate and register usage already satisfy the target's
`AudioSpec` takes a lossless path straight to driver data; anything else runs
`arrange` implicitly, and `--strict` refuses instead.

`render` exists as its own verb rather than only as `--preview` because the thing
it does — *play me what this will sound like on the hardware* — is the domain's
central question, applies to artifacts demake did not produce, and is what the
web and desktop apps call.

Shared flags (the full table lands in doc 05): `--preview <file>`,
`--preview-format wav|flac|m4a|opus|mp3`, `--output-stage raw|board`,
`--effort fast|default|max`, `--strategy auto|<name>|list`, `--seed`,
`--emit-manifest`, `--strict`, `--json`.

## Open decisions

Recorded here as doc 13's standing decision log records the image ones; each
becomes an ADR when made.

1. **Verb names.** `arrange` / `sfx` read well and keep the verb tree flat, but
   `sfx` is a noun. Alternatives considered: overloading `prep` by input type
   (elegant, but the flag surface would mix `--dither` with `--bpm` under one
   `--help`), or a nested `demake audio …` noun (breaks the flat convention the
   Demotic verbs already set).
2. **Expanded chip sets.** VRC6/MMC5/FDS/N163/5B on the NES, the YM2413 FM unit
   on the SMS, POKEY on the 7800 — each is a real, period-authentic option that
   changes the arrangement problem completely. The image path's precedent
   (32X/Sega CD as possible "extended MD" specs) suggests these are separate spec
   entries selected by `--chip`, post-1.0.
3. ~~**Demotic integration.**~~ **Decided and built**: `music <file>` scoped to a
   scene and `sound <file> on <trigger>` reusing `when`'s triggers. Doc 17
   §Demotic integration records the decision, doc 14 §Sound is the reference, and
   §Two streams, one clock above is what the hardware does about it.
4. **Which handful of consoles get `.dmm` instead of a standard artifact**, and
   whether `.dmm` is JSON or a compact text format. Decide when the first
   VGM-less console is implemented, not before.
