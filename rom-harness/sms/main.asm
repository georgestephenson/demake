;; demake Master System / Game Gear ROM harness (doc 06 §rom, doc 10).
;;
;; A minimal WLA-DX (z80) display program: it initializes the VDP for mode 4,
;; uploads the background palette to CRAM, the 4bpp planar tiles to VRAM $0000,
;; and the name table to VRAM $3800, then turns the display on and loops. The CLI
;; writes the generated data beside this file as tiles.bin / screen.bin (a full
;; 32-wide name table with the image top-left) / pal.bin.
;;
.memorymap
defaultslot 0
slotsize $4000
slot 0 $0000
.endme
.rombankmap
bankstotal 2
banksize $4000
banks 2
.endro

.smstag

.bank 0 slot 0
.org $0000
  di
  im 1
  ld sp, $dff0
  jp main
.org $0038
  ei
  ret
.org $0066
  retn

.org $0100
main:
  ; VDP register init
  ld hl, vdp_init
  ld b, vdp_init_end - vdp_init
  ld c, $bf
  otir
  ; palette -> CRAM addr 0
  xor a
  out ($bf), a
  ld a, $c0
  out ($bf), a
  ld hl, palette
  ld b, palette_end - palette
  ld c, $be
  otir
  ; tiles -> VRAM $0000
  xor a
  out ($bf), a
  ld a, $40
  out ($bf), a
  ld hl, tiles
  ld bc, tiles_end - tiles
  call write_vram
  ; name table -> VRAM $3800
  xor a
  out ($bf), a
  ld a, $78
  out ($bf), a
  ld hl, screen
  ld bc, screen_end - screen
  call write_vram
  ; terminate the sprite list: SAT (VRAM $3F00) Y[0] = $D0. Fresh VRAM leaves all
  ; 64 sprites at Y=0/X=0 pointing at the sprite pattern base ($2000 = tile 256),
  ; which draws garbage over the top-left once the image exceeds 256 tiles.
  xor a
  out ($bf), a
  ld a, $7f
  out ($bf), a
  ld a, $d0
  out ($be), a
  ; enable display: reg1 = $c0 (bit7 set, bit6 display on)
  ld a, $c0
  out ($bf), a
  ld a, $81
  out ($bf), a
loop:
  jr loop

write_vram:
wv_lp:
  ld a, (hl)
  out ($be), a
  inc hl
  dec bc
  ld a, b
  or c
  jr nz, wv_lp
  ret

vdp_init:
  .db $04, $80
  .db $00, $81
  .db $ff, $82
  .db $ff, $85
  .db $ff, $86
  .db $00, $87
  .db $00, $88
  .db $00, $89
  .db $ff, $8a
vdp_init_end:

tiles:     .incbin "tiles.bin"
tiles_end:
screen:    .incbin "screen.bin"
screen_end:
palette:   .incbin "pal.bin"
palette_end:
