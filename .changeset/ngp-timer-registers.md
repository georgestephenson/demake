---
"@demake/core": minor
---

Describe the Neo Geo Pocket's on-chip timer block.

`core/src/asm/ngp.ts` gains `TRUN`, the four `TREG`s, `T01MOD` with its two
clock-select fields and its mode field, and the timer interrupt-enable bytes —
beside the vectors it already had. Nothing programs one yet: a demade _game_
rides the picture, and the standalone audio cartridge this exists for is doc 13
§A5's open item. It is here rather than in whichever file first wants it on the
rule every register page in this directory runs under — a machine description
has one home and more than one reader — and `binding/t6w28.ts` is already the
second, deriving its prescalers from `NGP_T1CLK_DIVISORS` instead of restating
them.

Three things in it are worth knowing before using them.

**The two timers of a pair do not offer the same clocks.** A lower timer (0 or 2) takes the external pin or phi-T1, phi-T4, phi-T16; an upper one (1 or 3)
takes its partner's comparator output or phi-T1, phi-T16, phi-T256. So no
single timer can be given all four internal clocks, which is why the music
demaker offers an upper timer's three.

**The priority is the enable.** A timer's interrupt is armed by writing a level
of 1 to 6 into its nibble of `INTET01`/`INTET23`; **both 0 and 7 refuse it**, so
seven is off rather than most urgent.

**A compare match clears the counter**, so the period in input clocks is the
reload itself and a full 256 is written as zero.

Sources: Toshiba TMP95C061 datasheet section 3.8 (8-bit timers), figures 3.8 (4)
and 3.8 (7), the up-counter and prescaler sections, and the interrupt-enable
table in section 3.3.
