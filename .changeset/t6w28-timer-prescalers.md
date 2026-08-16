---
"@demake/audio": minor
"@demake/ngp": patch
---

Fix the Neo Geo Pocket's timer prescalers, which were wrong by a factor of two.

`binding/t6w28.ts` offered `[2, 8, 32, 128]` as the divisions a TMP95C061's
8-bit timer can take. Read against Toshiba's own datasheet §3.8, the four
prescaler outputs are **φT1 = 8/fc, φT4 = 32/fc, φT16 = 128/fc and
φT256 = 2048/fc** — so expressed against the chip's own 3.072 MHz clock the
divisions are `[4, 16, 64, 1024]`. Every entry we had was half the hardware's,
and the widest was 128 where the hardware's is 1024.

It is `[4, 64, 1024]` now, which is **timer 1's** three clocks rather than the
union over all four timers, and that is the hardware as well: the datasheet
gives a lower timer (0 or 2) φT1, φT4 and φT16 and an upper one (1 or 3) φT1,
φT16 and φT256, so no single timer offers all four and a driver rides one.
Timer 1 is the pick because φT256 is the only clock that reaches the bottom of
the useful band, and it costs nothing — the one rate φT4 would add inside that
band, 750 Hz at a full reload, is one φT256 hits exactly.

**What changes is the reload, not the rate.** A rate fixes `prescaler × reload`,
so the fraction a schedule declares was right all along and no `ChipScript`'s
timing moves: 240 Hz was 128 × 100 and is 64 × 200. What was wrong is the
`divisor` — the value a cartridge writes to `TREG` — which named a 24 kHz clock
this processor does not have. That reaches `--emit-manifest`, so it is an
output-byte change on `arrange` and `sfx` for `ngp` and `ngpc` whenever the
timer beats the frame. No golden moved, and that is the point: this console has
no standalone cartridge yet, so nothing in the suite could program a reload and
notice.

Two other things the same document settles, recorded where they are relied on:
the up-counter is cleared to zero on the compare match, so the period in input
clocks _is_ the reload and a full 256 is written as zero; and one processor
state is the oscillator divided by two, which is what `@demake/ngp`'s
`MASTER_PER_STATE` has always assumed and can now cite.
