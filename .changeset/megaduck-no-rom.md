---
"@demake/core": minor
---

`demake gen -c megaduck --format rom` no longer produces a Game Boy cartridge.

The Mega Duck shares the DMG's _data_ formats exactly — 2bpp planar tiles, a
background map, a two-bit-per-shade palette register — which is why it rides the
`gb` codegen family and why `bin`, `asm` and `c` are right for it. It does not
share the DMG's _display program_: its LCD registers are at `$FF10`–`$FF1B`
rather than `$FF40`–`$FF4B` and LCDC's bits are shuffled, so the `gb` ROM
harness assembled a cartridge that runs on a Game Boy and shows nothing on a
Mega Duck. `rom` is dropped from the console's `codegen.formats`, so asking for
it now fails with `E_UNSUPPORTED_OUTPUT` instead of writing a wrong ROM. Doc 13
§Phase 7+ records what the real vertical needs.
