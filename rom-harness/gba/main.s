@ demake Game Boy Advance ROM harness (doc 06 §rom, doc 10).
@
@ A minimal GNU-as (arm-none-eabi) display program: the cartridge header, then
@ ARM code that copies the background palette to palette RAM, the 4bpp tiles to
@ VRAM character block 0 and the screen entries to screen block 16, configures
@ BG0 as a 32×32-entry text background and enables it in video mode 0. The CLI
@ writes the generated data beside this file as tiles.bin / screen.bin (a full
@ 32-wide screen block with the image top-left) / pal.bin.
@
@ Only BG0 is enabled, so nothing else can draw over the image; the display
@ starts in forced blank and is switched on once VRAM is loaded.

    .arm
    .section .text
    .global _start

_start:
    b       start                 @ 0x00: ROM entry branch

    @ 0x04: Nintendo logo area. Boot through the real BIOS checks this; both
    @ mGBA's HLE BIOS and every emulator's direct boot skip it, and demake never
    @ ships a copyrighted logo, so it stays zeroed.
    .space  156, 0
    .ascii  "DEMAKE      "        @ 0xA0: game title (12 bytes)
    .ascii  "DMKE"                @ 0xAC: game code
    .ascii  "00"                  @ 0xB0: maker code
    .byte   0x96                  @ 0xB2: fixed value
    .byte   0x00                  @ 0xB3: main unit code
    .byte   0x00                  @ 0xB4: device type
    .space  7, 0                  @ 0xB5: reserved
    .byte   0x00                  @ 0xBC: software version
    .byte   0x00                  @ 0xBD: header complement (unchecked here)
    .space  2, 0                  @ 0xBE: reserved

start:                            @ 0xC0
    mov     r0, #0x04000000       @ REG_BASE
    mov     r1, #0x80             @ DISPCNT = forced blank
    strh    r1, [r0, #0x00]

    @ --- palette -> 0x05000000 (BG palette RAM) ------------------------------
    ldr     r1, =pal_data
    mov     r2, #0x05000000
    ldr     r3, =pal_size
    bl      copy_bytes

    @ --- tiles -> 0x06000000 (character block 0) -----------------------------
    ldr     r1, =tiles_data
    mov     r2, #0x06000000
    ldr     r3, =tiles_size
    bl      copy_bytes

    @ --- screen entries -> 0x06008000 (screen block 16) ----------------------
    ldr     r1, =map_data
    ldr     r2, =0x06008000
    ldr     r3, =map_size
    bl      copy_bytes

    @ --- show it -------------------------------------------------------------
    ldr     r1, =0x1000           @ BG0CNT: screen block 16, char block 0, 4bpp,
    strh    r1, [r0, #0x08]       @         32×32 entries, priority 0
    ldr     r1, =0x0100           @ DISPCNT: video mode 0, BG0 on
    strh    r1, [r0, #0x00]
loop:
    b       loop

@ Copy r3 bytes from r1 to r2, 16 bits at a time (VRAM and palette RAM reject
@ byte writes, so a halfword loop is the portable choice here).
copy_bytes:
    cmp     r3, #0
    bxeq    lr
1:  ldrh    r12, [r1], #2
    strh    r12, [r2], #2
    subs    r3, r3, #2
    bgt     1b
    bx      lr

    @ The literal pool must sit next to the code that loads from it — an ARM
    @ `ldr rX, =value` reaches ±4 KiB, and the blobs below are far larger.
    .pool
    .align 2
tiles_data:
    .incbin "tiles.bin"
tiles_end:
map_data:
    .incbin "screen.bin"
map_end:
pal_data:
    .incbin "pal.bin"
pal_end:

    .equ    tiles_size, tiles_end - tiles_data
    .equ    map_size, map_end - map_data
    .equ    pal_size, pal_end - pal_data
