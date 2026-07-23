---
"@demake/core": minor
"demake": minor
---

Fix `expandChannel` to use full bit-replication for sub-4-bit channels. The old
expansion replicated a code only once, so a 2-bit channel became `code*0x50`
(0/80/160/240) instead of the hardware/emulator `code*0x55` (0/85/170/255). This
was invisible for the 5-bit GB (a single replication already fills 8 bits) but
would miss RGB222/RGB333 consoles (Master System, Mega Drive) by a few LSBs at
emulator-comparison time. Now every code repeats across all 8 bits.
