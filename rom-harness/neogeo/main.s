| demake Neo Geo ROM harness (doc 06 §rom, doc 10).
|
| A minimal m68k display program (GNU as, MIT syntax). The 512-byte vector table
| and cartridge header in front of this code are `packNeoHeader`'s, so the boot
| ROM's `JMP USER` lands on `_start`. The CLI writes three generated files beside
| this one: `plane.s` (the machine — every VRAM address and every SCB word, built
| from `core/src/asm/neo-lspc.ts` rather than restated here), `pal.bin` and
| `scb1.bin`.
|
| **This console has no tilemap, and the playfield is sprites.** A sprite is a
| vertical strip sixteen pixels wide whose column of tile numbers is a 64-word
| SCB1 table, and the *sticky* bit chains a strip to the one before it — so the
| strips below carry one position between them and only the anchor's SCB3 and
| SCB4 are written. That is the whole of what a picture costs here: there is
| nothing to upload, because the video hardware reads its pixels from the
| cartridge's C ROM rather than from a bank.
|
| Three things a display program on this console must do that no other one in
| this project does:
|
|   - **Write SCB2.** That word is the shrinking pair, and zero is *fully*
|     shrunk rather than unshrunk — a strip whose SCB2 was never written draws a
|     single line of itself.
|   - **Kick the watchdog.** Writing any value to $300001 resets a counter that
|     reboots the board after roughly eight frames, so the lock loop below is a
|     loop with a store in it rather than `bra .`.
|   - **Say the palette bank and the fix source.** REG_PALBANK0 selects the bank
|     this program writes, and REG_CRTFIX points the fix layer at the cartridge's
|     own S ROM rather than the board's.

    .text
    .globl _start

| Every address and every SCB word this program uses, generated from
| `core/src/asm/neo-lspc.ts` — see plane.s's own header.
    .include "plane.s"

_start:
    move.w  #0x2700, %sr
    movea.l #STACK_TOP, %sp

    | --- palettes -> palette RAM, which is ordinary memory on this bus -------
    lea     pal_data, %a0
    lea     PALETTE_BASE, %a1
    move.w  #PAL_WORDS - 1, %d0
0:  move.w  (%a0)+, (%a1)+
    dbra    %d0, 0b

    | The backdrop is the bank's last entry, and colour zero of every palette is
    | transparent — so what shows through the picture's own index 0 is this word
    | rather than palette zero's first colour.
    move.w  pal_data, BACKDROP

    | --- the fix layer: blank, so nothing shows in front of the picture ------
    move.w  #FIX_MAP, LSPC_ADDRESS
    move.w  #1, LSPC_MODULO
    move.w  #FIX_COLUMNS * FIX_ROWS - 1, %d0
    moveq   #0, %d1
1:  move.w  %d1, LSPC_DATA
    dbra    %d0, 1b

    | --- SCB1: one 64-word table per strip ----------------------------------
    | The generated blob is already in that shape, so this is one address per
    | strip and then a stream of words.
    lea     scb1_data, %a0
    move.w  #STRIPS - 1, %d2
    move.w  #SCB1 + FIRST_SPRITE * SCB1_STRIDE, %d3
2:  move.w  %d3, LSPC_ADDRESS
    move.w  #1, LSPC_MODULO
    move.w  #SCB1_STRIDE - 1, %d0
3:  move.w  (%a0)+, LSPC_DATA
    dbra    %d0, 3b
    add.w   #SCB1_STRIDE, %d3
    dbra    %d2, 2b

    | --- SCB2: full size for every strip ------------------------------------
    move.w  #SCB2 + FIRST_SPRITE, LSPC_ADDRESS
    move.w  #1, LSPC_MODULO
    move.w  #STRIPS - 1, %d0
    move.w  #SCB2_FULL, %d1
4:  move.w  %d1, LSPC_DATA
    dbra    %d0, 4b

    | --- SCB4: the anchor's X. Every strip after it is chained to it. -------
    move.w  #SCB4 + FIRST_SPRITE, LSPC_ADDRESS
    move.w  #1, LSPC_MODULO
    move.w  #SCB4_ANCHOR, LSPC_DATA

    | --- SCB3: the anchor carries Y and height; the rest are sticky ---------
    move.w  #SCB3 + FIRST_SPRITE, LSPC_ADDRESS
    move.w  #1, LSPC_MODULO
    move.w  #SCB3_ANCHOR, LSPC_DATA
    | A `dbra` counts a *word*, so `STRIPS - 2` on a one-strip picture would be
    | -1 and the loop would write sixty-five thousand words through the data
    | port — over SCB1, over the fix map, over everything. There is nothing to
    | chain to a single strip, so the whole loop is assembled away instead.
    .if STRIPS > 1
    move.w  #STRIPS - 2, %d0
    move.w  #SCB3_STICKY, %d1
5:  move.w  %d1, LSPC_DATA
    dbra    %d0, 5b
    .endif

    | --- layers on ----------------------------------------------------------
    move.b  #0, REG_PALBANK0
    move.b  #0, REG_CRTFIX

lock:
    move.b  #0, WATCHDOG
    bra     lock

| ---- generated data ---------------------------------------------------------
    .align 2
pal_data:
    .incbin "pal.bin"
scb1_data:
    .incbin "scb1.bin"
