---
"@demake/chip": minor
---

Fix the WonderSwan's noise generator, which Level B found.

`WsSound`'s fifteen-bit shift register fed back the exclusive-or of bit 14 with
bit `14 − tap`. The hardware's feedback is the **inverted** exclusive-or of bit 7
with the tap bit, and the difference is not a shade of timbre: a register with a
tap has exactly one observable that is not a matter of taste — how many steps it
takes before it repeats — and this chip's eight modes produce eight documented
lengths.

| mode | tap | documented | what we produced |
| ---- | --- | ---------- | ---------------- |
| 0    | 14  | 32767      | 32767            |
| 1    | 10  | 1953       | 35               |
| 2    | 13  | 254        | 4599             |
| 3    | 4   | 217        | 32767            |
| 4    | 8   | 73         | 32767            |
| 5    | 6   | 63         | 93               |
| 6    | 9   | 42         | 93               |
| 7    | 11  | 28         | 32767            |

One right out of eight, and mode 0 by coincidence: a maximal-length sequence is
32767 whatever the tap. What shipped was therefore close to white noise on every
mode where the hardware has eight distinct colours, so a demade kit had one drum
sound rather than a range.

`packages/chip/test/ws-sound.test.ts` pins all eight lengths against the
documented table, walking the register itself rather than the audio — 28 steps
and 42 steps both sound like a buzz, and only one of them is what mode 7 does.
That is the one oracle for this generator that cannot be satisfied by agreeing
with ourselves.

**Level B is what found it** (doc 16 §The proof). Every register write was
already exact — Level A is green on that console for a track and for an effect —
so nothing below the schedule was in question until a third-party core's samples
were compared with ours: the noise voice peaked at 1497 Hz where beetle-wswan
peaked at 140, while every pitched voice agreed to the hertz. With the generator
right it lands beside the core's, 54 Hz against 43 and 118 against 54.

This changes rendered audio on both WonderSwans, and can change a demade sound
effect's chosen gesture, since `sfx` fits candidates by playing them through the
chip model.
