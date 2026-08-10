---
"@demake/audio": minor
---

Place an arrangement across the stereo image, and spend the seven chips that pan
by level — the first A5.5 line closed (doc 13 §A5.5).

**Every demade track was mono.** `ChannelFrame.pan` existed, eleven bindings read
it, and nothing anywhere in `@demake/audio` ever set it — so every part on every
console sat dead centre and a rendered stereo WAV had two bit-identical channels.
The roadmap recorded this as the Neo Geo Pocket's line (`pan` being two booleans
where the T6W28 pans by level); it was six more consoles than that, and under the
missing representation was a missing arranger stage.

`pan` is now a **signed position**, `-1` … `+1`, and the two laws a chip can take
it under live in `binding/pan.ts`. Seven chips pan by _level_ and now spend it —
the T6W28's two attenuators, the S-DSP's signed per-side volumes, the DS SPU's
seven-bit pan, the VSU's two nibbles, the HuC6280's balance byte, the WonderSwan's
volume byte and the Game Boy Advance mixer's byte a side. Four pan by _switch_ and
quantise it through `panSides`: `NR51`, the Game Gear's stereo latch, and the
YM2612's and YM2610's two output bits.

**Centre is both sides at full under both laws**, which is deliberate: it is what
the boolean pair defaulted to, so a part the arranger leaves centred encodes
byte-for-byte what it always did. That makes this a balance law rather than a
constant-power one — these are attenuators feeding a chip whose full level _is_
the ceiling, so the only thing a power law could do at centre is start every voice
quieter than the hardware can play it.

The placement itself is `plan.ts`'s, per channel and constant for the piece, so a
pan register is written once at the first tick and never again — a track is
already kilobytes of schedule on a machine with 32 KiB and no mapper. Bass, the
tune and the kit hold the centre; harmony, pad, arpeggio and effects parts spread
outward, alternating so the image stays balanced. **Only one lead keeps the
centre**: the classifier routinely returns four or five `lead` parts for one piece
and centring all of them is what a mono arrangement does — on a four-channel
console it left nothing to place at all.

A console whose spec says `panning: "none"` is never placed and never _reports_ a
placement, so `--json` and the page's piano roll say what the chip actually does.

Output bytes change on every console with stereo hardware. Sound effects are
unaffected: an effect borrows a channel the music is using, so placing one would
move what the music put there and leave it moved.
