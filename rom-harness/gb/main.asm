; demake `gb` family ROM harness (doc 06 §rom, doc 10 §emulator E2E).
;
; A minimal, deterministic display program: it uploads the tiles, map, and
; palettes emitted by `demake gen` and shows the image forever. One harness
; serves both consoles — the DMG path sets BGP; the GBC path (selected by
; conditional assembly when the generated data defines `demake_pal`) uploads
; BGR555 palettes and the CGB attribute map. The CLI writes the generated data
; next to this file as `demake.asm`, with symbol prefix `demake`.

DEF rLCDC EQU $FF40
DEF rBGP  EQU $FF47
DEF rLY   EQU $FF44
DEF rVBK  EQU $FF4F ; CGB VRAM bank select
DEF rBCPS EQU $FF68 ; CGB BG palette index (bit 7 = auto-increment)
DEF rBCPD EQU $FF69 ; CGB BG palette data

DEF VRAM_TILES EQU $8000
DEF VRAM_MAP   EQU $9800

; The generated data first, so its symbols and the `demake_pal` conditional-
; assembly switch are defined before the code below references them.
INCLUDE "demake.asm"

SECTION "Header", ROM0[$100]
    nop
    jp Entry
    ds $150 - @, 0 ; rgbfix fills the logo, title, and checksums

SECTION "Main", ROM0[$150]
Entry:
    ; Wait for VBlank, then turn the LCD off so VRAM is writable.
.waitvblank:
    ld a, [rLY]
    cp 144
    jr c, .waitvblank
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

    ; LCD on, BG on, tiles @ $8000, map @ $9800.
    ld a, %10010001
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
