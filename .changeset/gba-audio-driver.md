---
"@demake/audio": minor
"@demake/core": minor
"@demake/demotic": minor
"@demake/gba": minor
"@demake/web": minor
---

Play a Game Boy Advance game's music, with an ARM driver that computes half of
it.

`demake build -c gba` now puts a generated ARM player in the cartridge, and it is
the sixth of these and the first that is not only a player. Four of this
machine's ten voices are a Game Boy's APU and reach it as ordinary stores; the
other six are `@demake/chip`'s `GbaPcm` — a mixer whose register file is in work
RAM and whose output the processor has to produce, sample by sample, between one
block and the next. So doc 16's Level A proof arrives in two halves, and the
second is the sharper one: the register writes are diffed tick for tick by the
same battery five other consoles run, and the **samples themselves** are diffed
byte for byte against what the model renders. That is a comparison against the
audio rather than against an instruction to make it, and it is exact, because the
mixing is integer throughout.

Three of the driver's answers are this console's rather than a predecessor's
restated:

- **The clock is the transfer, not a timer.** A block of 256 samples is sixteen
  FIFO refills, so the sixteenth refill's interrupt _is_ a block boundary —
  re-pointing the transfer there cannot repeat a byte or skip one, whatever the
  queue happens to be holding. A timer at the same rate would be a fixed number
  of bytes out of phase with a transfer that reads ahead, and the phase depends
  on how deep the hardware's queue is. It also lands the rate on 128 Hz exactly,
  because 32768 divides by 256 with no remainder.
- **The mixing is the main loop's**, because twenty thousand cycles inside the
  handler would be two refills the handler then never sees.
- **The driver needs working memory** — two kilobytes of stereo accumulator,
  which no chip-driven player does, and which is in internal RAM rather than
  beside the sample ring in external RAM because the mix loop touches it four
  times a sample.

An effect only ever borrows a Game Boy channel, because that is where the sound
demaker places one, so the whole preemption machinery is the Game Boy's
unchanged. An effect placed on a mixer voice is refused by name.

Two latent bugs became failures on the way, both of them "a register number
identifies a register", which stops being true on a board with two devices:

- `PackOptions` grew `mergeChip` beside `mergeRegs`. `$25` is the Game Boy
  channels' panning byte _and_ the mixer's fifth voice's right level, so a
  schedule that set that voice's level had the write packed as a merge and the
  driver folded it into `NR51` — the music's stereo image replaced by a volume,
  at the first tick, on every build with an effect in it.
- The sound demaker was dropping `chip` from every write it made. The Mega Drive
  survived that only because it places its effects on the first _pitched_
  channel, which is chip zero — a wrong answer that happens to equal the right
  one. **This changes the packed bytes of a Mega Drive cartridge whose effect
  lands on a tone or noise voice**, which is an output-byte change.

The Game Boy Advance's sound page moved to `@demake/core` (`asm/gba-sound.ts`) so
that the core routing a store and the driver emitting one read the same table —
the Mega Duck's rule, and for its reason: a machine description that is wrong and
_consistent_ passes everything. `@demake/gba` therefore depends on `@demake/core`
at run time, as `@demake/dmg` already did.

The web app's Game Boy Advance player now offers sound, with both halves of the
hardware behind the same `StreamSink`.
