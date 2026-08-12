; demake `gb` family ROM harness (doc 06 §rom, doc 10 §emulator E2E).
;
; A minimal, deterministic display program: it uploads the tiles, map, and
; palettes emitted by `demake gen` and shows the image forever. One harness
; serves all three consoles in this family — the DMG path sets BGP; the GBC path
; (selected by conditional assembly when the generated data defines `demake_pal`)
; uploads BGR555 palettes and the CGB attribute map; and the **Mega Duck** is a
; machine description rather than a harness of its own, which is the same bargain
; `codegen/gb/machine.ts` strikes for games one layer along.
;
; Everything a Mega Duck moves is in `machine.asm`, which the CLI generates from
; `core/src/asm/megaduck.ts` — the LCD registers ($FF10–$FF1B rather than
; $FF40–$FF4B), LCDC's shuffled bits, and whether this cartridge has a header at
; all. Not one instruction below differs, and that is the property worth keeping:
; a register table restated here is a table that disagrees with the emulator and
; the audio driver in one entry, which is exactly what `megaduck.test.ts` exists
; to catch one layer down.
;
; The CLI writes both generated files next to this one: `machine.asm` (the
; console) and `demake.asm` (the picture, with symbol prefix `demake`).

DEF VRAM_TILES EQU $8000
DEF VRAM_MAP   EQU $9800

; The machine first, then the generated data, so the register equates and the
; `demake_pal` conditional-assembly switch are both defined before the code
; below references them.
INCLUDE "machine.asm"
INCLUDE "demake.asm"

IF DEF(DUCK)
; No boot ROM and no cartridge header: a Mega Duck begins executing at $0000.
SECTION "Main", ROM0[$0000]
ELSE
SECTION "Header", ROM0[$100]
    nop
    jp Entry
    ds $150 - @, 0 ; rgbfix fills the logo, title, and checksums

SECTION "Main", ROM0[$150]
ENDC
Entry:
IF !DEF(DUCK)
    ; Wait for VBlank, then turn the LCD off so VRAM is writable. A Game Boy is
    ; handed over by its boot ROM with the LCD *on*, so VRAM is only writable in
    ; the blanking interval and the wait is what makes turning it off safe.
.waitvblank:
    ld a, [rLY]
    cp 144
    jr c, .waitvblank
ENDC
    ; A Mega Duck has no boot ROM at all, so nothing has turned the LCD on and
    ; LY never leaves zero — the wait above would spin for ever, which presents
    ; as a cartridge that is perfect and shows a blank screen.
    xor a
    ld [rLCDC], a

    ; --- tile data -> VRAM --------------------------------------------------
    ; Up to 256 tiles live in bank 0 at $8000; on CGB, tiles 256..511 spill into
    ; bank 1 (the map's attribute byte carries the per-tile bank bit). DMG has a
    ; single bank and the budget stage keeps it within 256 tiles.
IF DEF(demake_pal)
    xor a
    ld [rVBK], a
    ld hl, demake_tiles
    ld de, VRAM_TILES
  IF demake_TILE_COUNT > 256
    ld bc, 256 * 16
  ELSE
    ld bc, demake_TILE_COUNT * 16
  ENDC
    call CopyBytes
  IF demake_TILE_COUNT > 256
    ld a, 1
    ld [rVBK], a
    ld hl, demake_tiles + 256 * 16
    ld de, VRAM_TILES
    ld bc, (demake_TILE_COUNT - 256) * 16
    call CopyBytes
    xor a
    ld [rVBK], a
  ENDC
ELSE
    ld hl, demake_tiles
    ld de, VRAM_TILES
    ld bc, demake_TILE_COUNT * 16
    call CopyBytes
ENDC

IF DEF(demake_pal)
    ; --- GBC: attribute map -> $9800 (VRAM bank 1) --------------------------
    ld a, 1
    ld [rVBK], a
    ld hl, demake_attr
    call CopyMap
    xor a
    ld [rVBK], a

    ; --- GBC: BGR555 palettes -> BG palette RAM -----------------------------
    ld a, $80          ; index 0, auto-increment
    ld [rBCPS], a
    ld hl, demake_pal
    ld c, demake_PAL_COUNT * 8
.copypal:
    ld a, [hli]
    ld [rBCPD], a
    dec c
    jr nz, .copypal
ELSE
    ; --- DMG: background palette register -----------------------------------
    ld a, demake_BGP
    ld [rBGP], a
ENDC

    ; --- tile map -> $9800 (VRAM bank 0) ------------------------------------
    ld hl, demake_map
    call CopyMap

    ; LCD on, BG on, tiles @ $8000, map @ $9800 — in this machine's bit order.
    ld a, LCDC_SHOW
    ld [rLCDC], a
.lock:
    jr .lock

; Copy demake_MAP_W x demake_MAP_H bytes from HL into the tilemap at $9800,
; advancing one 32-tile row of VRAM per source row.
CopyMap:
    ld d, demake_MAP_H
    ld bc, VRAM_MAP
.row:
    ld e, demake_MAP_W
.col:
    ld a, [hli]
    ld [bc], a
    inc bc
    dec e
    jr nz, .col
    push hl
    ld hl, 32 - demake_MAP_W
    add hl, bc
    ld b, h
    ld c, l
    pop hl
    dec d
    jr nz, .row
    ret

; Copy BC bytes from HL to DE.
CopyBytes:
    ld a, [hli]
    ld [de], a
    inc de
    dec bc
    ld a, b
    or c
    jr nz, CopyBytes
    ret
