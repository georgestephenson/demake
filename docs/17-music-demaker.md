# 17 — The Music Demaker (`arrange`)

Any track — a MIDI file, a tracker module, an MP3 — becomes music the target
console can actually play, with its tempo, its shape and its hook intact, using
every voice the hardware has and making the cuts honestly when it has too few.

This document is doc 04's counterpart: the pipeline, the tournament, the judge,
and the objective they all serve. The layer underneath it — the hardware model,
the `Score` and `ChipScript` representations, the chip synthesis and the render
contract that lets you hear the result exactly — is [doc 16](16-audio-engine.md).
The sound-effect demaker is [doc 18](18-sound-demaker.md), and it shares
everything in doc 16.

**Status: built for MIDI input, and playable on a Game Boy.** Ingest, analysis,
the arrangement tournament, timbre and timing fitting, the judge and the artifact
all exist and run on six consoles, and `demake gen song.json --format rom` turns
the schedule into a cartridge that plays it — proven register-for-register
against the schedule in `pnpm test` (doc 16 §The proof). Tracker modules and the
audio-input transcription front end (§Stage 0) are not built, nor is the
reference synthesizer the timbral metrics need — so the judge is symbolic today
and says so.

## The objective: it still has to be the tune

The image path spent a phase learning that minimizing per-pixel error is the
wrong objective under real constraint, and rewrote doc 04 §The objective around
*perceived equivalence*. The music path starts from that lesson rather than
rediscovering it, because the same inversion is sharper here and easier to
demonstrate: a chip arrangement that reproduces every pitch to the cent but drops
the backbeat is worthless, and one that transposes the whole song up a fourth to
fit the SN76489's pitch floor is *indistinguishable from the original* to almost
every listener.

Three principles, in priority order.

**1. Structure beats accuracy.** What a listener recognizes is melodic contour,
rhythm, and harmonic function — the *relations* between notes. Absolute pitch is
carried by almost nobody. So when the hardware forces a choice between a note at
the right pitch and a note in the right relation, take the relation: fold a bass
note up an octave rather than lose it, keep the interval and accept the detune,
drop the inner voice rather than the syncopation. Every "closest note" optimizer
does the opposite; every chiptune arranger who ever lived did this.

**2. A coherent global transform is nearly free.** A whole track transposed by a
semitone, played 2% faster, or a decibel louder is still the same track — human
hearing adapts to global, consistent change and objects violently to local,
inconsistent change. The judge therefore scores *modulo an allowed grade*: a
single global transpose, a single global tempo scale, a single gain, and
consistent octave displacement per part. This is the exact counterpart of doc 04's
grade-aligned ΔE, and it is what makes hard targets tractable — the Atari 2600's
pitch lattice is unusable without it and merely coarse with it. The grade stays
**bounded** (a few semitones, a few percent of tempo) for the same reason the
image grade does: unbounded, it stops being a grade and becomes a different song.

**3. Voice pressure scales the tradeoff.** How much (1) and (2) matter is a
function of *voice pressure* — the source's simultaneous-voice count and timbral
diversity against what the console affords. On the Pokémon Mini's single pulse
channel, essentially only contour and rhythm survive and the judge should weight
almost nothing else. On the SNES's eight sampled voices, pressure is near zero,
the arrangement is nearly transparent, and absolute fidelity — timbre included —
dominates. The weights slide with pressure; they are not a fixed compromise. This
mirrors doc 04's palette pressure exactly, including the guardrail: at zero
pressure, grading is disallowed and a round trip must be idempotent (a chip track
demade for its own console comes back unchanged).

## The pipeline

```
ingest → analyze ─┬─ candidate A ─ (arrange → timbre → expression → timing → budget) ─┐
                  ├─ candidate B ─ ( … different stage choices … )                    ├─ judge ─ winner → emit
                  └─ candidate N ─ ( … )                                              ┘
```

Same tournament, same rules as doc 04: candidates are a curated portfolio rather
than a cross-product, every stage is deterministic and seeded, explicit flags
constrain the portfolio rather than disabling it, only the winner is emitted, and
the scoreboard appears only under `--json` / `-v`.

Candidates for music are drawn along axes that genuinely trade off:

| Axis | Example candidates |
|---|---|
| Voice policy | `full-band` (every channel independent) · `arp-harmony` (chords collapsed onto one arpeggiating channel, freeing a channel for counter-melody) · `melody-first` (protect the lead, drop everything competing) |
| Bass strategy | `bass-pulse` · `bass-wave` (GB) · `bass-triangle` (NES) · `bass-periodic-noise` (SMS, below the pitch floor) · `bass-octave-up` |
| Percussion | `noise-kit` · `dpcm-kit` (NES) · `sample-kit` (SNES/GBA/NDS) · `pitched-thud` (kick on a tone channel) · `no-drums` (spend every channel on pitch) |
| Timing | `exact-bpm-timer` · `vblank-groove` · `tempo-snap` (bounded global scale to land on the grid) |
| Expression | `flat` · `envelopes` (software volume shaping) · `vibrato-delay` · `retrigger-echo` (fake reverb) |
| Console-specific | MD: `fm-fitted` vs `fm-archetype` · SNES: sample-budget splits · GB: wave-channel role |

`--effort fast` runs the single analysis-picked candidate; `default` a pruned
portfolio; `max` the full portfolio plus refinement of the top finishers, which
for music means re-running the arranger's alternating refinement with more
restarts and re-fitting timbres against the winner's actual channel plan.

## Stage 0 — Ingest

Every path produces a `Score` (doc 16), and the differences between them are
entirely in how much is *known* versus *inferred*.

### MIDI (`.mid`, SMF 0/1)

The reference input, and the one with the richest free information. Our own
parser, because determinism (doc 02) and because we need control over the messy
parts: running status, note-on-with-velocity-0 as note-off, overlapping notes on
one channel, tempo and time-signature meta events, key signature, program
changes, CC7/CC11 volume and CC1 modulation, pitch bend with its range
convention, and channel 10 as percussion under the General MIDI drum map.

From it we get, without inference: the tempo map, the meter, the note grid, the
per-track/per-channel separation, and a strong prior on each part's role from its
GM program number. That is why MIDI is the right first target — the user's
instinct here is correct, and the free corpus is enormous.

### Tracker modules (`.mod`, `.xm`, `.s3m`, `.it`)

Almost a transpile. A module is already channelized, already has instruments,
already runs on a tick rate, and its effect columns (arpeggio, portamento,
vibrato, volume slide) map more or less one-to-one onto what a chip driver does.
The interesting work is the reverse of the usual direction: a module's samples
carry a timbre we can *measure* to fit a chip patch, and its channel count often
exceeds the target's, so the arranger still has real work.

### Audio (`.wav`, `.flac`, `.mp3`, `.ogg`, `.opus`, `.m4a`)

The hard path, and the one worth being precise about, because the naive framing
("transcribe the music, then arrange it") sets up a problem nobody has solved and
we do not need to solve.

**The chip is a bottleneck, and the bottleneck makes the problem tractable.** We
never need every note in a mix. We need, at each moment, the few most salient
voices — because that is all the hardware can play. A Game Boy arrangement of a
dense modern track is four voices; extracting four voices is a different and far
more robust problem than extracting forty. The transcription front end is
therefore designed around exactly the parts a chip arrangement consists of, which
happen to be the four things that are individually most extractable:

| Extracted | Method | Robustness |
|---|---|---|
| **Beat, tempo, downbeat** | spectral-flux onset envelope → tempogram over a BPM grid → dynamic-programming beat track → downbeat by spectral-change and bass-onset alignment | high |
| **Percussion** | onsets classified into kick / snare / hat / tom / cymbal by band-energy and spectral-flatness features, through a small fixed-weight classifier with frozen coefficients | high |
| **Bass** | low-passed monophonic f0 (autocorrelation with cumulative mean normalization), octave-corrected against the harmonic series | high |
| **Lead** | predominant-f0 salience over a log-frequency grid, tracked with a Viterbi pass whose transition cost penalizes leaps and voicing changes | medium |
| **Harmony** | chroma folding → chord estimation against a fixed chord dictionary, Viterbi-smoothed to bar-length units | medium-high |

Note what the harmony row does: it recovers *chords*, not inner voices. A chip
arrangement plays a chord as an arpeggio or a two-note voicing anyway, so
recovering the chord symbol is both far more robust than recovering the voicing
and closer to what the arranger actually needs. The transcription's output shape
is the shape of the answer.

Explicit non-goals, with reasons:

- **No source separation, and no learned models beyond frozen linear
  coefficients.** A separation network is tens of megabytes and non-deterministic
  in practice — it would break both doc 02's determinism guarantee and doc 07's
  browser budget in one step. The band-limited, salience-based route above stays
  inside both.
- **No claim of transcription accuracy.** Every part carries a confidence, the
  confidences are reported in `--json` and shown in the web app, and a low-
  confidence lead is a thing the user can overrule (`--role`, `--drop`,
  `--transcribe-hint`) — not a thing we quietly present as correct. Doc 05's
  "predictable defaults, loudly reported" is doing real work here.

## Stage 1 — Analysis

For every input, whatever the ingest path knew:

**Tempo.** Detected (audio) or read (MIDI, modules) and then *characterized*: is
it constant, does it drift, is it swung? The output is the tempo map plus a
`groove` measurement (the ratio of off-beat to on-beat spacing), because losing
swing is one of those changes a listener notices instantly and no pitch metric
records. The canonical tempo-octave ambiguity (is that 85 BPM or 170?) is
resolved by a prior over the onset-envelope's autocorrelation peaks plus the
bass-onset rate, reported with its alternatives so `--bpm` can overrule it in one
flag.

**Key and mode**, from a pitch-class histogram against key profiles, used to
bound the allowed transpose and to make chord estimation better.

**Structure.** A self-similarity matrix over chroma and timbre features gives
repeated sections; the repeats give the song's form. Two things depend on it:

- **Loop points**, which are not optional. Game music loops, and a loop that
  clicks or that restates the intro every time is the single most audible way a
  demade track can be wrong. The loop is chosen at a bar line where the harmonic
  and timbral context matches, preferring the end of the first full chorus back to
  the top of the first verse, and the seam is verified by comparing the rendered
  audio either side of it.
- **Budget spending.** A section that occurs six times is worth six times the
  data budget of one that occurs once — the pattern dedup stage will collapse it,
  so it costs almost nothing to keep it detailed.

**Roles.** The user's framing — percussion, bassline, and N melodic or chordal
parts — *is* the model, and this is where it is assigned. Features per part:
mean pitch and range, polyphony, note density, rhythmic regularity, onset
alignment with the beat grid, contour entropy, sustain ratio, GM program family
(MIDI), and channel index (modules). A deterministic scoring function assigns
each part a role and a confidence:

- **percussion** — MIDI channel 10, or unpitched onsets;
- **bass** — low mean pitch, near-monophonic, onsets on strong beats;
- **lead** — mid-to-high, monophonic, high contour entropy, high salience;
- **harmony / pad** — polyphonic, low contour entropy, long sustains;
- **arp** — polyphonic content expressed as fast repeating single notes;
- **fx** — everything else, and the first thing dropped.

Every assignment is reported and overridable (`--role 3=bass`), because the
classifier will be wrong sometimes and a wrong role is a wrong arrangement.

**Salience**, per note. The counterpart of doc 04's insistence that *frequency is
not importance*: the loudest thing in a mix is usually the drums, and the thing
you would hum is usually not the loudest. Salience combines melodic position
(peaks and phrase-final notes score high), metric position (downbeats), duration,
register isolation, and repetition across the song — a three-note hook that
recurs eleven times is the most important material in the file even if it is
quiet. Salience is what the arranger spends its channels on and what the judge
weights its note-recall metric by; it is the direct analogue of the image path's
protected seats for highlights and outlines.

## Stage 2 — Arrangement

The constrained assignment problem, and the heart of the demaker: **map parts
onto channels over time, under a channel model that changes what is possible from
one channel to the next.**

It is doc 04 Stage 4 with time in place of space, and it is solved the same way,
deliberately:

1. **Divide the song into spans** — bars, or sections where the texture is
   stable. A span is the unit of assignment, the way an attribute cell is.
2. **Init by affinity.** Score every (part, channel) pair by role-to-kind
   affinity (a lead wants a pulse channel; a bass wants the NES triangle or the
   GB wave; percussion wants noise, DPCM or a sample voice), by pitch-range
   feasibility against the channel's lattice, and by salience. Assign greedily.
3. **Alternating refinement.** Reassign each span to the channel set that
   minimizes its loss → re-derive each channel's role and timbre from the spans
   it now holds → repeat to convergence. `R` deterministic restarts with jittered
   inits; `--effort` scales `R`; `--effort max` adds an annealing pass that moves
   single parts between channels and re-splits the worst-fitting span.
4. **Switching costs are in the objective.** A channel that changes timbre
   mid-phrase is audible in a way that has no image counterpart, so the loss
   function charges for role changes within a phrase and forgives them at section
   boundaries — which is exactly where a human arranger puts them.

The loss for a span is a weighted sum of: salience-weighted loss of dropped
notes; pitch-snapping error in cents (from the channel's lattice); octave
displacement; timbre mismatch; polyphony overflow; and switching cost.

### When there are fewer channels than parts

This is the case the user named, and it deserves the detail. In priority order,
the arranger reaches for:

1. **Merge duplicates.** Parts in unison or in octaves are one part; detecting and
   collapsing them is free and often reclaims a whole channel from a doubled
   melody.
2. **Reduce chords by function.** A four-note chord on one channel becomes its
   most informative subset — root and third carry the harmony's *function*; the
   fifth is nearly always the first to go; a seventh outranks a fifth in jazz-
   inflected material. Fixed, documented priority, not taste.
3. **Arpeggiate.** A chord that must fit one channel becomes a fast cycle through
   its tones at the driver rate. This is the *dither* of the music pipeline — a
   trick that fakes more voices than the hardware has by alternating faster than
   the ear separates, exactly as ordered dither fakes colors by alternating
   finer than the eye separates — and like dither, it is a candidate dimension,
   not a default, because on slow or sparse material it sounds like a mistake
   rather than a chord.
4. **Time-share.** Two parts that are never simultaneously active share one
   channel outright. This is where span-level assignment pays: a pad in the verse
   and a counter-melody in the chorus are one channel's job.
5. **Drop, by salience, and say so.** Every dropped part and every dropped note
   is counted in the manifest and in `--json`, with its salience and the bar range
   it occupied. Silent loss is the one unacceptable outcome; `--strict` turns any
   drop into an error.

### When there are more channels than parts

The instruction is to use them, and the ways are: detune-doubling a lead across
two channels for thickness (a period technique with a real timbral effect), true
stereo placement where the hardware pans (GB, GG, NGPC, PCE, VB, SNES),
harmonizing a lead in thirds, adding the octave below a bass, and giving
percussion its own channel instead of stealing one. Each is a candidate, judged
like anything else — unused channels are not a failure, and a track that sounds
better sparse should stay sparse.

### Percussion

Its own sub-problem, because drums are where a chip arrangement most obviously
succeeds or fails. Per drum class, per chip: noise-channel bursts with fitted
period and decay (kick = low period, fast decay; snare = mid period with a short
pitched component if a tone channel is free; hats = high period, very short), the
pitched-thud technique for a kick on a tone channel where no noise channel is
free, DPCM or sampled kits where the hardware has them and the budget allows, and
the honest option of no drums at all when every channel is worth more to the
pitch material. The choice is a candidate axis; the judge decides.

## Stage 3 — Timbre fitting

Choose what each channel *sounds* like — the counterpart of Stage 3 in doc 04,
and on some consoles literally a quantization problem:

- **PSG (pulse) channels.** Duty cycle is chosen by comparing the source
  instrument's harmonic amplitude profile against each duty's known harmonic
  series (a 50% square has only odd harmonics; 12.5% is bright and dense). One
  computable match, four choices, no search needed.
- **Wavetable channels** (GB wave, PCE, WonderSwan, VB). Fit a 32-sample,
  4-to-6-bit waveform to the target harmonic profile: synthesize the waveform
  from the measured harmonic amplitudes with a fixed phase convention, then
  quantize to the lattice. That is doc 04 in one dimension, dithering included —
  noise-shaped quantization of the waveform beats naive rounding, for the same
  reason it does on images, and the audible artifact of getting it wrong (a
  harsh, aliased buzz) is the audio form of banding.
- **FM (YM2612, YM2610, YM2413).** The one place the timbre is *searched*: a 4-op
  patch is fitted by coordinate descent over operator ratios, total levels and
  envelope rates, seeded from a bank of archetype patches generated by a
  checked-in script from harmonic templates — **no third-party patch banks are
  vendored**, on the same reasoning that produced a purpose-made
  `hd-many-colors.png` rather than a licensed photo. The scoring function renders
  each candidate patch *through our own chip model* and compares its log-spectrum
  and envelope against the target, which means a fitted patch is achievable by
  construction and cannot be an idealization the hardware would refuse.
- **Sample chips** (SNES, GBA, NDS, ADPCM on Neo Geo). Now it is literally
  palette fitting: cluster the source's instruments by spectral similarity,
  allocate the sample budget by salience, choose base pitch and loop points per
  sample, encode to BRR or ADPCM, and if the set does not fit, merge the closest
  pair and re-point — the tile-merge stage with different units, including the
  reporting rule that merges are counted in the manifest and `--strict` errors
  instead.

## Stage 4 — Expression

The tricks that make a chip arrangement sound like music rather than a test tone,
each an explicit candidate: vibrato (delay, rate, depth — a table, not a
continuous function), portamento, software volume envelopes on chips with none
(the SN76489's entire expressive range is this), duty-cycle modulation for a
chorusing shimmer, retrigger echo for fake reverb, note-cut and note-delay for
groove, and pitch-drop transients at note onsets to imply a pluck.

Every one costs driver writes per tick and therefore data and CPU, which is why
they belong in the tournament rather than in a defaults table: on a target with a
tight budget the judge should be free to decide that a flat, clean arrangement
beats an expressive one that had to drop a voice to pay for itself.

## Stage 5 — Timing

Tempo is not a metric here; it is a **hard budget with a reported error**, and
the goal stated in the product brief — preserve BPM — is met exactly rather than
approximately wherever the hardware has a usable timer.

The mechanism: pick rows-per-beat `R` (4, 6, 8, 12 or 24, from the source's
smallest meaningful subdivision), which fixes the required driver rate at
`BPM × R / 60` ticks per second, then pick the timer divisor that produces it.
Most targets can: the Game Boy's timer, the NES's DMC/frame IRQ, the SMS's VDP
line interrupt, the SPC700's timers, the YM2612's timer A. The residual is
reported in **parts per million**, and it is typically single-digit.

Where the driver must ride vblank, the row length becomes a **groove table** —
alternating tick counts that sum exactly over a bar. The property that matters is
not that jitter is small but that it is **non-accumulating**: a bar boundary must
land where it should, forever. A track whose tempo error accumulates is wrong
after ninety seconds no matter how small the per-row error was, and that is a
diagnostic, not a metric.

Reported in `--json` and the manifest, every time: requested BPM, achieved BPM,
error in ppm, worst-case onset deviation in milliseconds, whether the error
accumulates (it must not), the driver clock source, and the divisor.

`--bpm <n>` overrides detection. `--tempo exact|snap` chooses between holding the
source tempo and allowing the bounded global tempo grade of §The objective to
land on a cheaper grid.

## Stage 6 — Budget

The tile-budget stage, transposed:

- Rows dedup into patterns; patterns into an order list; a pattern that recurs
  **transposed** is stored once with an offset (the counterpart of flip-aware tile
  dedup, and worth as much — sequenced music is far more repetitive than tile
  art).
- Instrument and envelope tables are shared across the track and, where the
  Demakefile groups them, across a whole game's music and effects.
- Sample data is budgeted against ARAM or ROM.
- The driver's per-tick write count is budgeted against the console's cycle
  allowance, because a tick that overruns is not a quality problem — it is a
  dropped frame or a crashed driver.

Over budget, the reductions are ordered and reported: drop the least salient
expression effects, then coarsen envelope resolution, then reduce the sample set,
then drop the least salient part. `--strict` errors instead of degrading, and
every degradation appears in `--json` with what it cost.

## Stage 7 — Emit

Doc 16 §The driver contract: a `ChipScript` out of the tournament, then the
artifact (`.vgm` / `.spc` / `.dmm`) plus the manifest, and `gen` from there to
`bin` / `asm` / `c` / `rom`. `--preview song.flac` renders the exact audio
through our chip models (doc 16 §The render contract).

`rom` is live for the Game Boy family: `--emit-manifest` writes the schedule,
and `demake gen <that file> -c dmg --format rom` builds a 32 KiB cartridge whose
driver was generated for this track. Stage 6's reductions are what it reports —
packed bytes, blocks before and after dedup, and the driver routines the track
actually pulled in, so a track that never rests ships no rest handling.

## Diagnostics — hardware traps as errors, not surprises

Doc 14's rule for games applies verbatim to music: *a hardware trap is a compile
error, not an emulator surprise.* Each of these is a named diagnostic located at a
bar and beat, not a warning buried in a log:

| Diagnostic | Trap |
|---|---|
| `pitch below channel floor` | the part needs notes the channel physically cannot produce (SN76489 under ~109 Hz) |
| `polyphony overflow` | more simultaneous notes than channels, at a specific tick, after all reductions |
| `envelope faster than driver rate` | a 5 ms attack requested against a 60 Hz driver |
| `tempo drift accumulates` | the chosen clock cannot express this BPM without unbounded error |
| `write budget exceeded` | this tick asks for more register writes than the CPU allowance |
| `sample set over budget` | ARAM/ROM overflow, with the merge that would fix it |
| `loop seam discontinuity` | the loop point clicks, or restates material |
| `channel never used` | a wasted voice — usually a role-classification error worth surfacing |
| `transpose exceeds bound` | the fit only works by moving further than a grade is allowed to |

## The judge

Same three-part structure as doc 04: gates, then metrics in two groups, then a
pressure-weighted geometric aggregate.

**1. Validity gates (disqualification).** The doc-16 compliance oracle must pass.
Then the glitch detectors — the audio counterparts of attribute-cell tearing and
degenerate palettes: accumulating tempo drift, a missing downbeat, envelope
clicks (discontinuities at note boundaries), clipping in the mix, a channel that
is silent for the entire track, notes rendered below the channel's floor, and a
loop seam whose two sides do not match. A disqualified candidate is reported with
its reason; all candidates disqualified is `E_NO_VALID_CANDIDATE`, never a silent
bad output.

**2. Metrics.** Computed against a fixed reference — for audio input, the source
itself; for MIDI and modules, the source rendered by a **checked-in deterministic
reference synthesizer** (a purpose-made additive/subtractive instrument table, not
a licensed soundfont, for exactly the reasons doc 10 gives for generating
`hd-many-colors.png` rather than licensing a photo).

*Relational* — what a listener recognizes; they carry the weight under pressure:

| Metric | Captures |
|---|---|
| **Melodic contour correlation** | does the tune's shape survive, invariant to transposition by construction |
| **Interval preservation** | semitone deltas between consecutive melody notes |
| **Onset F-score** (per part, tolerance-windowed) | are the rhythms still there |
| **Beat and downbeat alignment** | the groove, and whether the grid ever slips |
| **Harmonic function retention** | pitch-class-set distance per bar — does the chord still do its job |
| **Structure contrast** | sections that differed still differ; the chorus must not sound like the verse |
| **Voice separability** | can the parts still be told apart — register spacing, panning, timbral distance between simultaneous channels |
| **Dynamic contour correlation** | the arc of loud and quiet |

*Absolute* — anchors and guardrails; they dominate at low pressure:

| Metric | Captures |
|---|---|
| **Grade-aligned pitch error** (cents, mean + p95) | residual after fitting the single allowed global transpose |
| **Tempo error** (ppm) and worst onset deviation (ms) | the timing budget, scored as well as gated |
| **Timbral distance** | log-mel spectral distance between our render and the reference |
| **Salience-weighted note recall** | every high-salience note exists somewhere — the counterpart of highlight retention, and for the same reason: losing the three-note hook must cost more than losing a long quiet pad, regardless of duration |
| **Loudness and dynamic range** | no crushed or anaemic mix |
| **Grade bounds** | transpose, tempo scale and gain within their limits — the "this stopped being a grade" detector |

**3. Aggregation.** Normalized to [0,1] against fixed anchors, combined by
weighted geometric mean so one catastrophic metric cannot be averaged away.
Weights are per-role-mix and slide with **voice pressure**, and they are
calibrated against a human-ranked listening set, then frozen and versioned —
changing them is an output-affecting minor release like any algorithm change
(doc 09 §Stability). Ties break deterministically by candidate ID.

The judge is exposed, not internal: `demake inspect track.vgm --source song.mid
--json` scores any pair with the same metrics, and the library exports it.

## Evaluation

Doc 04's hardest-won lesson is that quality changes need *eyes*, not just
numbers, and the audio counterpart needs ears. The evaluation battery renders the
source and every candidate to audio and builds an HTML sheet with inline players,
the scoreboard, the channel plan as a piano roll, and the diagnostics — the
counterpart of `tools/prep-eval/out/`. A judge-score regression is confirmed by
listening before any baseline moves, and the listening corpus deliberately
over-represents the cases where the metrics are weakest: dense modern
productions, tempo-flexible material, swung rhythms, sparse ambient tracks where
there is almost nothing to reduce, and material whose hook lives in the timbre
rather than the notes.

Sources for the corpus are public-domain or purpose-made, checked in; anything
local and unlicensed goes in a gitignored directory the way
`tools/prep-eval/local/` already works.

## Demotic integration — decided, and built

The shape is **Option B**: a `.dmt` names a track and an effect, and the demakers
decide everything about what the hardware does with them — precisely the split
doc 14 already draws for art (*Demotic describes the game; the Demakefile
describes the build*).

```
music rally.mid in play
sound bounce.wav on ball hits paddle
```

`music` is scoped to a scene: entering it starts the track, leaving it stops it.
`sound` takes `when`'s own triggers, verbatim — collisions, button edges,
`reaches`, plain conditions, narrowed by `in` and guarded by `if` — so there is
one trigger vocabulary in the language and no second one to keep in step. What a
`sound` has no room for is `then`, which is the reason it is a statement of its
own: Demotic rules assign properties, and "play a sound" is not a property
assignment. Fitting it into the rule form would have meant `then` meaning two
things (the option this section used to call C, rejected then and still).

Doc 14 §Sound is the language reference for both. Three consequences of the
decision live elsewhere and are worth naming here:

- **Audio events are in the conformance trace.** A trace line carries
  `audio=<track>,<effect>` — the track the scene asks for, and the effect a rule
  asked for on this tick. It records the *request*, not what the chip did: which
  channel an effect actually got is hardware arbitration, the way sprite priority
  is, but *when* a sound fires is the game, and an interpreter and a ROM that
  could disagree about it would be two games again.
- **A sound with a trigger a rule already has rides that rule**, merged in the
  compiler so both implementations agree about the order requests are made in.
  Unmerged, a `sound … on shot hits alien` next to the rule that scores the hit
  costs a second pass over every shot-and-alien pair.
- **Music and effects share one interrupt**, so a game states the driver rate and
  every piece is fitted to it. `ArrangeOptions.driverHz` and `SfxOptions.rateHz`
  exist for that and for nothing else; doc 16 §Two streams, one clock has the
  rest of the mechanism.

## Performance

The image path's targets scale by pixels; these scale by song length and channel
count, and the numbers that matter are the interactive ones — the web app has to
feel like an instrument.

- A 3-minute MIDI → any Tier 1 console: `--effort fast` **< 1 s**, `default`
  **< 5 s**, `max` < 30 s in Node.
- Audio-input transcription of the same 3 minutes: **< 15 s** at `default` —
  it is the dominant cost and it is dominated by the FFTs, which are shared
  across every candidate by the stage-DAG memoization the tournament already has.
- **Rendering must beat real time by a wide margin**, because the browser plays
  it: a 3-minute track renders in **under 2 s**, so preview after an edit feels
  immediate.
- Same implementation rules as doc 04: typed arrays throughout, no allocation in
  inner loops, benchmarks in CI with regression thresholds.
