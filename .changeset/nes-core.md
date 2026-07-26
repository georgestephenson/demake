---
"@demake/demotic": minor
---

Add `@demake/nes`, a self-hosted NES core, for the two jobs `@demake/dmg` exists
for: booting a built cartridge in Vitest with no toolchain and no emulator
install, and playing one in a page without fetching a core from anywhere. Its
APU is `@demake/chip`'s 2A03 rather than a second implementation, and its PPU
enforces eight sprites a scanline and takes a background palette from a 16×16
attribute cell — the constraints the compiler's budget warnings and the art path
are written against, which a lenient core would make unfalsifiable.
