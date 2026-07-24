@ demake Nintendo DS ROM harness — ARM9 binary (doc 06 §rom, doc 10).
@
@ A minimal GNU-as (arm-none-eabi) display program for 2D engine A: power the
@ main engine and the LCDs, map VRAM bank A to background VRAM, copy the
@ palette to engine A's BG palette RAM, the 4bpp tiles to 0x06000000 and the
@ screen entries to screen block 16, then enable BG0 as a 32×32-entry text
@ background in video mode 0. The CLI writes the generated data beside this file
@ as tiles.bin / screen.bin (a full 32-wide screen block with the image
@ top-left) / pal.bin, and packs this binary into a .nds cartridge itself — no
@ devkitARM, no ndstool.
@
@ Engine A is put on the *top* screen (POWCNT1 display swap), which is the first
@ screen in the emulator's stacked framebuffer, so the capture's top-left region
@ is the image.

    .arm
    .section .text
    .global _start

_start:
    @ --- power: LCDs + 2D engines, engine A on the top screen ---------------
    ldr     r0, =0x04000304       @ POWCNT1
    ldr     r1, =0x8203           @ LCD + 2D-A + 2D-B + display swap
    strh    r1, [r0]

    ldr     r0, =0x04000000       @ engine A register base
    mov     r1, #0x80
    strh    r1, [r0, #0x00]       @ DISPCNT: forced blank while loading
    mov     r1, #0
    strh    r1, [r0, #0x6c]       @ MASTER_BRIGHT: none

    @ --- VRAM bank A -> background VRAM of engine A (0x06000000) ------------
    ldr     r0, =0x04000240       @ VRAMCNT_A
    mov     r1, #0x81             @ enable, MST=1 (BG-VRAM), offset 0
    strb    r1, [r0]

    @ --- palette -> 0x05000000 (engine A BG palette) ------------------------
    ldr     r1, =pal_data
    ldr     r2, =0x05000000
    ldr     r3, =pal_size
    bl      copy_bytes

    @ --- tiles -> 0x06000000 (character base block 0) -----------------------
    ldr     r1, =tiles_data
    ldr     r2, =0x06000000
    ldr     r3, =tiles_size
    bl      copy_bytes

    @ --- screen entries -> 0x06008000 (screen base block 16) ----------------
    ldr     r1, =map_data
    ldr     r2, =0x06008000
    ldr     r3, =map_size
    bl      copy_bytes

    @ --- show it ------------------------------------------------------------
    ldr     r0, =0x04000000
    ldr     r1, =0x1000           @ BG0CNT: screen block 16, char block 0, 4bpp
    strh    r1, [r0, #0x08]
    ldr     r1, =0x00010100       @ DISPCNT: display mode 1, BG mode 0, BG0 on
    str     r1, [r0, #0x00]
loop:
    b       loop

@ Copy r3 bytes from r1 to r2, 16 bits at a time (VRAM and palette RAM reject
@ byte writes).
copy_bytes:
    cmp     r3, #0
    bxeq    lr
1:  ldrh    r12, [r1], #2
    strh    r12, [r2], #2
    subs    r3, r3, #2
    bgt     1b
    bx      lr

    @ The literal pool must stay within an ARM `ldr =` reach (±4 KiB) of the
    @ code; the blobs below are far larger.
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
