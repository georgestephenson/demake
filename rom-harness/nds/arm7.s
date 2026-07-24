@ demake Nintendo DS ROM harness — ARM7 binary (doc 06 §rom, doc 10).
@
@ The image is drawn entirely by 2D engine A on the ARM9; the ARM7 has nothing
@ to do, so it parks. It still has to exist: the cartridge header names an ARM7
@ binary and the emulator's direct boot copies and starts it.

    .arm
    .section .text
    .global _start
_start:
    b       _start
