# 18 — The Sound Demaker (`sfx`)

A recorded sound — a coin chime, a door slam, a shout, a sword hit — becomes a
short chip effect the console can fire on demand, alongside whatever music is
already playing.

It shares its entire substrate with the music demaker: the hardware model, the
`ChipScript` representation, the chip synthesis, and the render contract that
lets you hear the result exactly ([doc 16](16-audio-engine.md)). What differs is
the objective, the search, and the fact that an effect has to *coexist* with
music rather than own the chip.

**Status: built for WAV input, and playable on a Game Boy.** Analysis, the class
gate, eight gesture families, hardware-in-the-loop fitting and the placement
contract all run, and an effect's schedule builds into a cartridge that plays it
once and then falls silent — proven register-for-register in `pnpm test` (doc 16
§The proof). The lossy decoders, banks, `--variations` and the driver-side
stealing logic are not built yet.

The one-shot is where the effect path exercises something the music path does
not: the driver's order list ends in a block that powers every DAC down and then
rests forever, rather than looping. There is no "stopped" state in the driver,
for the same reason there is no `destroy` in Demotic (doc 14) — an inert thing it
already knows how to represent beats a second mode it would have to be right
about.

## The objective: identity, not fidelity

The music judge asks "is it still the tune?". The sound judge asks a blunter
question: **"is it still the thing?"** A coin pickup has to sound like a coin
pickup. An explosion has to sound like an explosion, and specifically must not
come back as a beep — which is the characteristic failure of every naive
spectral fit, because a beep is the closest single sine to almost anything.

That gives the sound demaker a structure the music demaker does not have: a
**class gate before any metric runs**. Every source is classified into a coarse
sonic identity — tonal, noisy, percussive, swept, vocal — and a candidate that
lands in the wrong class is disqualified outright, no matter how well it scores.
It is the same device doc 04 uses when it disqualifies a glitched candidate
before scoring rather than trusting the aggregate to punish it, and it is what
stops "closest by some distance" from producing something recognizably wrong.

Underneath the gate, the priorities in order:

1. **The gesture.** The shape of a sound over time — a rising sweep, a sharp
   attack into noise decay, a two-tone blip — carries its identity far more than
   its spectrum does. Retro sound design is *made of* gestures, which is exactly
   why hardware with four registers per channel could produce sounds people
   remember forty years later.
2. **The envelope.** Attack sharpness and decay length, which decide whether
   something reads as a hit, a chime or a pad.
3. **The spectrum.** Brightness and noisiness, which decide *what material* it
   sounds like — metal, wood, voice, air.
4. **Absolute pitch, last.** Almost nothing about an effect's identity depends on
   it landing on a particular note, and where it does (a musical chime that has to
   sit in the key of the level's music) it is a flag, not a default.

## The five-second rule

An arbitrary maximum duration — five seconds by default, `--max-length` — is not
a limitation being tolerated. It is a design decision that buys a great deal, and
it is worth naming what:

- **The search becomes affordable.** A five-second effect at a 60 Hz driver is
  300 ticks. That is small enough to render candidates through the real chip model
  *inside the optimization loop*, thousands of times, which is what makes the
  fitting honest — every candidate score is measured on the hardware's actual
  output, never on an idealization of it.
- **The budget becomes a real constraint with a real answer.** A game ships
  dozens of effects in the ROM space one song occupies. Bounded length makes the
  bank budget tractable and makes "is this effect worth its bytes" a question with
  a number attached.
- **It matches what effects are.** Anything longer is music, a loop, or ambience,
  and those are doc 17's problem. `--max-length` past a few seconds is allowed and
  warns.

Sources longer than the maximum are trimmed intelligently rather than truncated:
the analysis finds the salient event (onset, peak, decay) and keeps that, and
reports what it cut.

## Input

Any common sound file — `.wav`, `.flac`, `.aiff`, `.mp3`, `.ogg`, `.opus`,
`.m4a` — decoded by the same pinned decoders the music path uses and resampled to
the canonical 48 kHz mono analysis rate (doc 16 §Determinism engineering).

Stereo sources fold to mono for analysis, since almost no target can pan a single
effect meaningfully and the ones that can are better served by a placement
decision than by inheriting the source's stereo image.

## Stage 1 — Analysis

Everything downstream is fitted against these tracks, so they are the whole
representation of the source:

| Track | What it is | Why it matters |
|---|---|---|
| **Amplitude envelope** | log-amplitude per analysis frame, plus a fitted attack / decay / sustain / release | the single strongest identity cue |
| **f0 and voicing** | fundamental frequency where one exists, with a confidence per frame | separates tonal from noisy, and gives the sweep its shape |
| **Noisiness** | spectral flatness and harmonic-to-noise ratio per frame | how much of this is noise channel and how much is tone |
| **Brightness** | spectral centroid per frame | maps to duty cycle, waveform choice, noise period |
| **Inharmonicity** | partial deviation from the harmonic series | metal and bells versus voice and strings |
| **Roughness / AM** | amplitude-modulation rate and depth | engines, alarms, growls |
| **Transient sharpness** | attack time and onset spectral flux | click versus swell |
| **Duration** | total and per-phase | trivially important, easily lost |

From those, the coarse class: **tonal**, **noisy**, **percussive**, **swept**,
**vocal**. The class chooses which gesture families are eligible and gates the
judge.

## Stage 2 — Gesture families

The candidate portfolio, and the counterpart of doc 04's strategy portfolio: each
family is a *parameterized register program* — a small function from parameters
to a `ChipScript` — that exists because it wins for some class of sound.

| Family | Shape | Typical source |
|---|---|---|
| `blip` | short tone, fast decay, optional two-step pitch | menu move, select, footstep |
| `sweep-up` | rising pitch ramp with envelope | jump, powerup, launch |
| `sweep-down` | falling ramp | fall, death, cancel, laser |
| `sweep-updown` | ramp up then down | bounce, boing |
| `arp-sparkle` | fast arpeggio through a chord or scale fragment, bright decay | **coin, pickup, treasure, level-up** |
| `noise-burst` | noise with a fitted period and decay envelope | explosion, hit, footstep on gravel |
| `pitched-noise` | noise plus a simultaneous tone component | snare-like impact, punch, sword clash |
| `metallic` | inharmonic partials via periodic-noise or two detuned tones | clang, ricochet, shield |
| `bell` | tone with a long decay and a bright inharmonic attack | chime, alert, magic |
| `formant` | two- or three-tone formant approximation, or a fitted wavetable vowel | **grunt, yell, voice** |
| `engine` | LFO-modulated noise or tone | motor, hum, alarm |
| `click` | single-tick impulse | UI tick, blip |
| `sample` | the source itself, downsampled and bit-reduced | **sampling targets only** — see below |

Families compose where the hardware has channels to spare: an explosion is often
`noise-burst` plus a `sweep-down` tone, and a coin is famously two `blip`s a
fourth apart. `--channels N` allows it; the default is one channel, for the
reason §Living with music explains.

### Two regimes: synthesis and sampling

The target's hardware splits the problem in half, and the split is worth stating
because it changes what "demaking a sound" even means:

- **Synthesis targets** (GB, NES without DPCM, SMS/GG/SG-1000, PCE, WonderSwan,
  Virtual Boy, 2600, Pokémon Mini) have no way to play a recording. The effect
  must be *re-synthesized* as a gesture, which is the interesting problem and the
  one the families above solve. A shout becomes a formant approximation, and it
  will read as "retro game shout" rather than as the actor.
- **Sampling targets** (NES DPCM, SNES, GBA, NDS, Neo Geo ADPCM) can play the
  recording, and then the job becomes the audio counterpart of the image
  pipeline's quantization: resample to the affordable rate, reduce to the
  affordable depth or ADPCM encoding, trim and loop, and fit the whole bank into
  the budget. Here `sample` is usually the winning candidate — but not always,
  and the tournament is what decides: a synthesized gesture that costs 40 bytes
  can beat a 3 KB sample when the bank is full, and the judge sees both.

## Stage 3 — Fitting

For each eligible family, find the parameters that best reproduce the source, and
then let the tournament pick the family. The search is deterministic and
three-tiered.

Families cannot see each other, so this is a fan-out like the image path's: one
family is one job on `demakeSfx`'s `executor`, and with none supplied they are
fitted here in order (doc 04 §Running the tournament). Fitting a family is around
145 ms against a 60 ms prologue — measured on a Game Boy at the game driver's
rate — so an effect goes from 930 ms to roughly 400 ms on four cores. The winner
is reduced in the families' own fixed order, so how many lanes ran them cannot
reach the schedule; `packages/cli/test/pool.test.ts` compares the artifact from a
real thread pool against the inline one.

The three tiers:

1. **Analytic seed.** Most parameters are read straight off the analysis: the
   pitch ramp's endpoints come from the f0 track, the decay rate from the
   envelope fit, the noise period from the brightness track. This alone gets
   close, and at `--effort fast` it is the answer.
2. **Coordinate descent** over a quantized parameter grid — and the grid is the
   *hardware's own lattice*, so there are no unreachable parameter values to
   round off at the end. Sweep each parameter, keep improvements, iterate to a
   fixed point with a fixed iteration cap.
3. **Annealing** at `--effort max`, seeded from the descent's result, with the
   PRNG seeded per doc 02 so the run is reproducible.

Every candidate is scored by rendering it **through the chip model** (doc 16
§Claim 2) and comparing against the source. That is the property that makes this
trustworthy: the optimizer never proposes something the hardware cannot do,
because everything it scores has already been produced by a model of the
hardware.

## Stage 4 — Living with music

An effect that sounds perfect alone and destroys the music when it fires is a
failure, and this is the part of the sound domain that has no image counterpart
at all. The contract:

- **One channel by default.** An effect that needs three channels can only ever
  play when three are free, which in practice means never.
- **Each effect declares a channel preference, ordered.** A noise-burst wants the
  noise channel; a blip wants a pulse channel. The driver honours the preference
  when it can and falls back when it cannot.
- **And a priority.** Effects preempt each other by priority, and a
  lower-priority effect never interrupts a higher-priority one that is still
  playing.
- **Stealing is explicit and bounded.** When an effect takes a channel the music
  is using, the driver saves that channel's state, plays the effect, and restores
  it — including retriggering the interrupted note if it should still be
  sounding. The alternative (leaving the music's channel silent until its next
  note) is what makes retro audio sound broken, and it is entirely avoidable.

  *Built so far:* the Game Boy driver takes the channel, suppresses the music's
  writes to it, and hands it back silent — the music picks it up at its next
  note. Restoring the interrupted note needs a shadow of every register on every
  channel, kept every tick, to close a gap of a few ticks; it is worth doing and
  it is not done yet. What *is* done is the part that cannot be added later
  without breaking the proof: the music's own channels are untouched, `NR51` is
  merged rather than stored, and with nothing preempting, the register stream is
  exactly the schedule's (doc 16 §Two streams, one clock).
- **What to steal is an arrangement decision, not a runtime accident.** Stealing
  the percussion channel for 200 ms is inaudible; stealing the melody is the most
  audible thing the driver can do. So the music demaker's channel plan (doc 17
  §Stage 2) records a *stealing rank* per channel per span, and the effect driver
  reads it. This is the one place the two demakers are genuinely coupled, and it
  is why they are one package.
- **Headroom is budgeted.** Effects are normalized as a bank, with a fixed
  headroom against the music's mix level, so a chip that sums channels digitally
  (or non-linearly, on the NES) does not clip when an effect lands on a loud bar.

`--reserve <channel>` pins a channel for effects, trading a music voice for
guaranteed effect latency — the right call on some games and the wrong call on
most, so it is a flag and not a default.

## Stage 5 — Emit

An effect alone is a `ChipScript` and a `.vgm`, like any other artifact. A game
wants a **bank**: many effects sharing one driver, one envelope-table space, and
one index, emitted through `gen` as `bin` / `asm` / `c` / `rom` — where the `rom`
harness is a small program that fires each effect in turn, which is exactly what
the proof loop needs anyway.

*Built:* a Demotic game is that bank. `demake build` demakes every `sound` the
`.dmt` names, packs them behind one index, and emits one driver that plays any of
them under the music (doc 16 §Two streams, one clock); `packages/demotic/test/
audio.test.ts` fires one from a button press and diffs what the chip received
against the effect's own schedule, on every console with a driver. An effect
fitted for a game is fitted to the game's driver rate rather than to the
standalone 240 Hz — `SfxOptions.rateHz` — because one interrupt produces one
rate, and *which* rate is the console's: 120 Hz where there is a timer to
programme, the frame rate where the picture's interrupt is the only clock (doc 16
§Two streams, one clock). What that costs on such a machine is the resolution of
an attack, sixteen milliseconds instead of eight — which is the tick its own
games drove their drivers with.

`--variations N` produces a set of related effects from one source by perturbing
pitch and decay within bounded ranges (the four coin sounds, the three footsteps)
— a per-effect cost of a few bytes, and the difference between a game that
sounds alive and one that sounds like a loop.

## The judge

**Gates.** The doc-16 compliance oracle, then: the class gate (§The objective),
silence (a candidate that renders to nothing), clipping, an effect that exceeds
`--max-length`, an effect whose first audible sample is more than one driver tick
after its trigger (latency is identity for interactive sound), and DC offset that
would click.

**Metrics**, against the source directly (there is no reference-synth question
here — the input *is* audio):

| Metric | Captures |
|---|---|
| **Envelope correlation** | log-amplitude contour, the primary identity cue |
| **f0 contour correlation** | over voiced frames only — the gesture's pitch shape |
| **Noisiness track correlation** | tonal-versus-noisy over time, which is what separates a hit from a chime |
| **Log-mel spectral distance** | timbre, with a ±1-frame tolerance so a one-tick offset is not scored as a total mismatch |
| **Onset sharpness match** | attack character |
| **Duration ratio** | inside a tolerance band; outside it, a gate |
| **Peak and perceived loudness** | banked consistency |
| **Byte cost** | scored, not just budgeted — a candidate that matches 3% better for 8× the bytes should usually lose, and the weight slides with how full the bank is |

Aggregated by weighted geometric mean, as everywhere else in this project, with
weights per class — a percussive source weights envelope and onset, a tonal one
weights f0 and spectrum — calibrated against a human-ranked listening set and
then frozen.

## Diagnostics

| Diagnostic | Trap |
|---|---|
| `source longer than max length` | with what was trimmed and why |
| `class mismatch` | every candidate in the eligible families landed in the wrong class — usually a sign the source is a mix, not an effect |
| `no free channel` | the effect's preferences conflict with the music's plan on every channel |
| `bank over budget` | with the per-effect byte costs, so the choice of what to cut is the user's |
| `latency exceeds one tick` | the effect cannot start on the tick it is triggered |
| `steal would silence the melody` | the only available channel is the one carrying the lead |

## Testing

Everything in doc 16 §The proof applies unchanged, plus the pieces specific to
effects:

- **Golden WAV per effect**, byte-compared — cheap and sharp, because our
  synthesis is deterministic.
- **Analytic fixtures**: a synthetic sweep must be fitted by the sweep family and
  must not be fitted by `noise-burst`; a white-noise burst must not come back
  tonal. These are the anti-gaming fixtures of doc 10 §4, in audio.
- **The bank-in-a-ROM E2E**: fire every effect in the bank in sequence over a
  playing track, capture the register schedule, and diff it against the
  ChipScript — which proves the *stealing and restore* logic, the part most
  likely to be subtly wrong and least likely to be noticed.
- **A listening sheet** (`--effort max` on the corpus, rendered to an HTML page
  with inline players) reviewed by ear before any weight change, as with images
  and music.

## Performance

- A 5-second source → any Tier 1 console: `--effort fast` **< 500 ms**,
  `default` **< 3 s**, `max` < 20 s.
- The dominant cost is rendering candidates through the chip model, which is
  bounded by §The five-second rule and parallelizes across the worker pool the
  tournament already uses.
