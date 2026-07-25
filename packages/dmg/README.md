# `@demake/dmg`

A Game Boy (DMG) core in about 1200 lines of dependency-free TypeScript: SM83,
PPU, timer, interrupts, joypad. No sound, no CGB, no mapper.

It exists because two jobs in this repository need an emulator and neither can
take someone else's:

- **The Demotic conformance harness** (doc 10). A `.dmt` built into a ROM has to
  reproduce the reference interpreter's fixed-point state tick for tick. Running
  that here rather than in SameBoy makes it a plain `pnpm test` — no toolchain,
  no emulator install, no self-skip — which is what puts the loop that proves a
  runtime correct on every contributor's machine.
- **The web app's cartridge pane** (doc 07). Fetching a core from a CDN is
  forbidden, and a self-hosted WASM core we cannot read would be the same bargain
  in a different wrapper.

Writing it was the cheaper option once, not twice: one core serves both.

## Scope, and what is deliberately missing

Everything a `demake build` cartridge exercises, and nothing else. In
particular:

- **No MBC.** A build is 32 KiB. When a game outgrows that, the runtime gains a
  mapper and this gains the three lines to match.
- **VRAM is not blocked outside VBlank.** A real DMG drops those writes; the
  runtime is written to do its VRAM work inside the VBlank window regardless, so
  modelling the block here would convert a discipline failure into a mystery
  rather than catching it. The SameBoy E2E is where that gets caught.
- **OAM DMA is instant.** It still costs its cycles at the call site, and nothing
  a demade game does can observe the difference.

The ten-sprites-per-scanline limit _is_ enforced, because doc 14 has the compiler
warn about it and a warning nobody can falsify is not worth having.

```ts
import { Gameboy } from "@demake/dmg";

const machine = new Gameboy(rom); // a 32 KiB Uint8Array
machine.setButtons(["left", "a"]);
machine.runFrame(); // to the next VBlank
machine.framebuffer; // RGBA, 160x144
machine.readMemory(0xc0a0, 36); // work RAM, for a headless harness
```

Platform-pure on the same terms as `@demake/core`: no `fs`, no DOM, no wall
clock. Rendering produces a plain RGBA buffer; where it goes is the caller's
business.
