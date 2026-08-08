---
"@demake/neogeo": patch
---

Fix the VRAM port folding every fix-layer write into the sprite control block,
and close the Neo Geo oracle's two open cases.

**`VRAM_WORDS` is `$8800` — 64 KiB plus a 4 KiB upper zone — which is not a power
of two**, so `address & (VRAM_WORDS - 1)` was never a wrap. It clears bits rather
than reducing modulo: `$737A & $87FF` is `$037A`. Every write to the fix map, at
`$7000`, was folded down into the middle of SCB1 — a caption computed correctly,
addressed correctly, written correctly, and landing in the tile numbers of a
strip nobody was looking at. Out-of-range writes are dropped now, because the
address register is sixteen bits and the hardware decodes nothing above the upper
zone.

Nothing could have caught this except a cartridge. The LSPC's own tests write
`vram` directly, so they never went through the port; a trace says nothing about
pixels; and the emitter was correct throughout. What found it was the rendering
oracle asking whether a caption had _arrived_, then following the value from the
emitter to the bus one step at a time — `PokeFix` reached with the right glyph in
`d0`, 1725 writes landing in the fix range, and zero of them present afterwards.
`packages/neogeo/test/lspc.test.ts` now writes through the port for exactly this.

With it fixed, both `it.todo` cases in `neogeo-rom.test.ts` are real assertions:
captions arrive column-major, and a frame's objects are staged and uploaded. The
second was never broken — the probe that reported it simply never pressed a
button, so it was reading the title screen, which has no objects. That case now
plays into the scene before it looks.
