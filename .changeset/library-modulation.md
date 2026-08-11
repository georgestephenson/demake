---
"@demake/demotic": minor
---

Put the modulation wheel on two of the example library's melodies.

`@demake/audio` produces vibrato — read off controller 1, performed by the
YM2612's own LFO where there is one and by pitch writes everywhere else — and
nothing in the example library reached it. Every one of the eleven fixture MIDIs
was dry, so the feature was proved by tests written for it and by nothing that
ships. That is the gap the four-part fixtures had before they were widened, and
the argument is the same one: hand the demakers what a modern game would have
(§Writing music), and a modern game's MIDI moves the wheel.

The wheel goes on **track 3 of `pong/rally.mid` and of
`platformer/meadow.mid`** — General MIDI programme 80 in both, the synth lead,
which is the one instrument in these arrangements a player leans on a held note
with. Depth 64 of 127, about a quarter of a semitone at the top of the swing.

Two files rather than eleven, and each is a place the suite already looks:

- **`pong`** is the project `packages/demotic/test/_audio-battery.ts` builds for
  its register battery, on every console with a driver. So a vibrato's writes
  are now diffed against the schedule tick for tick on eleven machines, which
  includes both routes to a chip — the Mega Drive's LFO and everybody else's
  moving pitch.
- **`platformer`** is the one fixture whose NES build fits an NROM-128, so it is
  where the size sweep costs vibrato on a small board.

The rest of the library stays dry on purpose. Not every tune is played with
vibrato, and it is not free: a modulated held note is a pitch write per tick
wherever the hardware will not do it.

| console     | writes on `rally.mid` |
| ----------- | --------------------- |
| Mega Drive  | 6483 → 6819 (+5.2%)   |
| Game Boy    | 1418 → 1694 (+19.5%)  |
| Master Sys. | 716 → 1018 (+42.2%)   |
| Neo Geo     | 3550 → 4342 (+22.3%)  |

The Mega Drive's is the LFO doing the work — one depth nibble a note against a
pitch write a tick — and the Neo Geo is beside it as the check that the OPNB's
missing LFO is still refused rather than claimed.

In cartridge bytes, on each game's tightest console: pong on a Game Boy goes
from 12721 free to 11544, and the platformer from 13723 to 12254. Its NES build
loses 590 bytes of 17051 and its Mega Drive build 706 of four megabytes.
