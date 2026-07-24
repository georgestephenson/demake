;; demake SG-1000 ROM harness (doc 06 §rom, doc 10).
;;
;; A minimal WLA-DX (Z80) display program for the TMS9918A in Graphics II
;; (bitmap) mode. It programs the eight VDP registers, uploads — with the display
;; off — the pattern generator (6 KiB → VRAM $0000), the color table (6 KiB →
;; $2000) and the name table (768 B → $3800), terminates the sprite list, then
;; turns the display on and loops. The CLI writes the generated data beside this
;; file as pattern.bin / color.bin / name.bin, already arranged into the three
;; 256-tile VRAM banks. VDP ports: $BE data, $BF control/register.

.memorymap
defaultslot 0
slotsize $8000
slot 0 $0000
.endme
.rombankmap
bankstotal 1
banksize $8000
banks 1
.endro

.bank 0 slot 0
.org $0000
  di
  im 1
  ld sp, $c400
  jp main
.org $0038
  ei
  reti
.org $0066
  retn

.org $0100
main:
  ; VDP register init (regs 0..7): out value, then out $80|reg.
  ld hl, vdp_regs
  ld e, $80
reg_loop:
  ld a, (hl)
  out ($bf), a
  ld a, e
  out ($bf), a
  inc hl
  inc e
  ld a, e
  cp $88
  jr nz, reg_loop

  ; pattern generator -> VRAM $0000
  xor a
  out ($bf), a
  ld a, $40
  out ($bf), a
  ld hl, pattern
  ld bc, pattern_end - pattern
  call write_vram

  ; color table -> VRAM $2000
  xor a
  out ($bf), a
  ld a, $60
  out ($bf), a
  ld hl, color
  ld bc, color_end - color
  call write_vram

  ; name table -> VRAM $3800
  xor a
  out ($bf), a
  ld a, $78
  out ($bf), a
  ld hl, name
  ld bc, name_end - name
  call write_vram

  ; terminate the sprite list: SAT ($1B00) Y[0] = $D0
  xor a
  out ($bf), a
  ld a, $5b
  out ($bf), a
  ld a, $d0
  out ($be), a

  ; display on: reg1 = $C0 (16K + display enable)
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

vdp_regs:
  .db $02   ; 0: Mode 2 (Graphics II), no external video
  .db $80   ; 1: 16K, display OFF during upload, 8×8 sprites
  .db $0e   ; 2: name table   = $3800
  .db $ff   ; 3: color table  = $2000 (all three thirds)
  .db $03   ; 4: pattern gen  = $0000 (all three thirds)
  .db $36   ; 5: sprite attr  = $1B00
  .db $03   ; 6: sprite gen   = $1800
  .db $01   ; 7: backdrop / border = black
vdp_regs_end:

pattern: .incbin "pattern.bin"
pattern_end:
color:   .incbin "color.bin"
color_end:
name:    .incbin "name.bin"
name_end:
