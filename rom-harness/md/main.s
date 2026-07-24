| demake Mega Drive / Genesis ROM harness (doc 06 §rom, doc 10).
|
| A minimal m68k display program (GNU as, MIT syntax): 68000 vector table + a
| standard cartridge header, then code that initialises the VDP, uploads the
| background palette to CRAM, the 4bpp tiles to VRAM $0000, and the plane-A name
| table to VRAM $C000, sets the backdrop to palette 0 colour 0, turns the display
| on and loops. The CLI writes the generated data beside this file as tiles.bin /
| screen.bin (a 64-wide plane-A block with the image top-left) / pal.bin.

    .text
    .globl _start

| ---- 68000 vector table (256 bytes) ---------------------------------------
vectors:
    .long 0x00FFFE00        | 0: initial supervisor stack pointer
    .long _start            | 1: reset program counter
    .rept 62
    .long _inthandler       | 2..63: everything else → rte
    .endr

| ---- cartridge header ($100..$1FF, exactly 256 bytes) ---------------------
    .ascii "SEGA GENESIS    "                                 | console name (16)
    .ascii "(C)DEMAKE 24.JUL"                                 | copyright (16)
    .ascii "DEMAKE                                          " | domestic (48)
    .ascii "DEMAKE                                          " | overseas (48)
    .ascii "GM 00000000-00"                                   | serial (14)
    .word  0x0000                                             | checksum (unused)
    .ascii "J               "                                 | I/O support (16)
    .long  0x00000000                                         | ROM start
    .long  0x000FFFFF                                         | ROM end
    .long  0x00FF0000                                         | RAM start
    .long  0x00FFFFFF                                         | RAM end
    .ascii "            "                                      | SRAM info (12)
    .ascii "            "                                      | modem (12)
    .ascii "                                        "         | notes (40)
    .ascii "JUE             "                                 | region (16)

| ---- entry point ($200) ---------------------------------------------------
_start:
    move.w #0x2700, %sr             | mask interrupts
    | TMSS: satisfy the security register on model-1+ hardware / accurate cores.
    move.b 0xA10001, %d0
    andi.b #0x0F, %d0
    beq 1f
    move.l #0x53454741, 0xA14000    | write 'SEGA'
1:
    lea    0xC00004, %a1            | VDP control port
    lea    0xC00000, %a2            | VDP data port

    | VDP register init: word = 0x8000 | (reg<<8) | value.
    movea.l #vdp_regs, %a0
    move.w #0x8000, %d1
    moveq  #23, %d0
0:  move.b (%a0)+, %d1
    move.w %d1, (%a1)
    add.w  #0x0100, %d1
    dbra   %d0, 0b

    | palette → CRAM address 0 (64 words).
    move.l #0xC0000000, (%a1)
    movea.l #palette, %a0
    move.w #(pal_end-palette)/2-1, %d0
0:  move.w (%a0)+, (%a2)
    dbra   %d0, 0b

    | tiles → VRAM $0000.
    move.l #0x40000000, (%a1)
    movea.l #tiles, %a0
    move.w #(tiles_end-tiles)/2-1, %d0
0:  move.w (%a0)+, (%a2)
    dbra   %d0, 0b

    | plane-A name table → VRAM $C000.
    move.l #0x40000003, (%a1)
    movea.l #screen, %a0
    move.w #(screen_end-screen)/2-1, %d0
0:  move.w (%a0)+, (%a2)
    dbra   %d0, 0b

    | display on: reg1 = $74.
    move.w #0x8174, (%a1)
forever:
    bra    forever

_inthandler:
    rte

| ---- VDP register values (reg 0..23) --------------------------------------
vdp_regs:
    .byte 0x04   | 0:  mode 1
    .byte 0x34   | 1:  mode 2 — display OFF during upload, VINT+DMA, MD mode
    .byte 0x30   | 2:  plane A name table  = $C000
    .byte 0x00   | 3:  window name table
    .byte 0x07   | 4:  plane B name table  = $E000
    .byte 0x78   | 5:  sprite attribute table = $F000
    .byte 0x00   | 6:  —
    .byte 0x00   | 7:  backdrop = palette 0 colour 0
    .byte 0x00   | 8:  —
    .byte 0x00   | 9:  —
    .byte 0x00   | 10: H interrupt counter
    .byte 0x00   | 11: mode 3 — full-screen scroll
    .byte 0x81   | 12: mode 4 — H40 (320px)
    .byte 0x2C   | 13: H scroll table = $B000
    .byte 0x00   | 14: —
    .byte 0x02   | 15: auto-increment = 2
    .byte 0x01   | 16: plane size = 64×32
    .byte 0x00   | 17: window H
    .byte 0x00   | 18: window V
    .byte 0x00   | 19: DMA length low
    .byte 0x00   | 20: DMA length high
    .byte 0x00   | 21: DMA source low
    .byte 0x00   | 22: DMA source mid
    .byte 0x00   | 23: DMA source high

    .align 2
tiles:   .incbin "tiles.bin"
tiles_end:
screen:  .incbin "screen.bin"
screen_end:
palette: .incbin "pal.bin"
pal_end:
