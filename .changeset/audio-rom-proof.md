---
"@demake/core": minor
---

Audio: a schedule becomes a bootable ROM, and the ROM is proven in an emulator.

`demake gen <schedule> -c dmg --format rom` builds a 32 KiB Game Boy cartridge
that plays an arranged track or a demade sound effect. The driver is generated
for that schedule rather than fixed — a track that never rests ships no rest
handling, a one-shot ships a stop path and a track does not — and it is
assembled by `core`'s own SM83 encoder, so no toolchain is involved and the
browser can build the same bytes.

Doc 16's Level A proof now runs in `pnpm test`: the cartridge boots in
`@demake/dmg`, whose APU is now `@demake/chip`'s `GbApu`, and every register
write it makes is diffed against the `ChipScript` tick for tick, with no
tolerance. That is the audio counterpart of the pixel-perfect emulator E2E.

Two output-affecting changes come with it. The SM83 assembler and the Game Boy
cartridge header moved from `@demake/demotic` into `@demake/core` (`src/asm/`),
since two backends now emit Game Boy machine code; `@demake/demotic` re-exports
them, so `Asm`, `AsmError` and `label` keep working. And a `sfx` schedule now
records the timer reload alongside the rate it produces, which changes the bytes
of the `--emit-manifest` sidecar — a ROM has to program a register, and
re-deriving one from a rational would be a second timing fit that could disagree
with the first. `sfx --emit-manifest` also actually writes its sidecar now,
where before the flag was accepted and ignored.
