; demake Super Nintendo ROM harness (doc 06 §rom, doc 10).
;
; A minimal WLA-DX (65816) display program for a LoROM cartridge: it brings the
; CPU up in native mode, initializes the PPU for BG mode 1, DMAs the background
; palette to CGRAM, the 4bpp tiles to VRAM word $0000 and the tilemap to VRAM
; word $7800, then turns the screen on and loops. The CLI writes the generated
; data beside this file as tiles.bin / screen.bin (a full 32×32-entry tilemap
; with the image top-left) / pal.bin.
;
; Data lives in its own ROM banks so each DMA stays inside one 32 KiB bank (the
; A-bus address wraps at a bank boundary): bank 1 tiles, bank 2 tilemap, bank 3
; palette. Only BG1 is enabled on the main screen, so the uninitialized OAM can
; never draw over the image.

.MEMORYMAP
DEFAULTSLOT 0
SLOTSIZE $8000
SLOT 0 $8000
.ENDME

.ROMBANKMAP
BANKSTOTAL 8
BANKSIZE $8000
BANKS 8
.ENDRO

.SNESHEADER
  ID "DMKE"
  NAME "demake image         "
  SLOWROM
  LOROM
  CARTRIDGETYPE $00
  ROMSIZE $08
  SRAMSIZE $00
  COUNTRY $01
  LICENSEECODE $00
  VERSION $00
.ENDSNES

.SNESNATIVEVECTOR
  COP EmptyHandler
  BRK EmptyHandler
  ABORT EmptyHandler
  NMI EmptyHandler
  IRQ EmptyHandler
.ENDNATIVEVECTOR

.SNESEMUVECTOR
  COP EmptyHandler
  ABORT EmptyHandler
  NMI EmptyHandler
  RESET main
  IRQBRK EmptyHandler
.ENDEMUVECTOR

.BANK 0 SLOT 0
.ORG 0
.SECTION "Main" FORCE

EmptyHandler:
  rti

main:
  sei
  clc
  xce                   ; 65816 native mode
  rep #$10              ; X/Y 16-bit
  sep #$20              ; A 8-bit
.ACCU 8
.INDEX 16
  ldx #$1fff
  txs
  lda #$8f
  sta $2100             ; forced blank while we load VRAM
  stz $4200             ; no NMI / IRQ / auto-joypad

  ; --- PPU registers to a known state (reset leaves them undefined) ----------
  stz $2101             ; OBSEL
  stz $2102
  stz $2103
  stz $2105             ; BGMODE (set for real below)
  stz $2106             ; MOSAIC off
  stz $2107
  stz $2108
  stz $2109
  stz $210a
  stz $210b             ; BG12NBA: BG1 chars at word $0000
  stz $210c
  stz $210d             ; BG1HOFS = 0 (write twice: 16-bit register)
  stz $210d
  ; BG1VOFS = -1. The PPU renders screen scanline N from BG line VOFS+N+1, so a
  ; vertical offset of zero would show the tilemap one line down; -1 puts the
  ; image's first line on the first visible scanline.
  lda #$ff
  sta $210e
  sta $210e
  stz $2123             ; window mask selections off
  stz $2124
  stz $2125
  stz $212a
  stz $212b
  stz $212c             ; main screen (set for real below)
  stz $212d             ; sub screen off
  stz $212e             ; window masking off
  stz $212f
  stz $2130             ; CGWSEL: no color math
  stz $2131             ; CGADSUB
  lda #$e0
  sta $2132             ; COLDATA: fixed color black
  stz $2133             ; SETINI: no interlace / pseudo-hires

  ; --- palette -> CGRAM ------------------------------------------------------
  stz $2121             ; CGADD = 0
  lda #$00
  sta $4300             ; DMAP0: A->B, 1 register, auto-increment source
  lda #$22
  sta $4301             ; BBAD0 = $2122 (CGDATA)
  ldx #pal_data
  stx $4302
  lda #:pal_data
  sta $4304
  ldx #(pal_end-pal_data)
  stx $4305
  lda #$01
  sta $420b

  ; --- tiles -> VRAM word $0000 ----------------------------------------------
  lda #$80
  sta $2115             ; VMAIN: +1 word, increment after $2119
  ldx #$0000
  stx $2116
  lda #$01
  sta $4300             ; DMAP0: 2 registers ($2118/$2119)
  lda #$18
  sta $4301
  ldx #tiles_data
  stx $4302
  lda #:tiles_data
  sta $4304
  ldx #(tiles_end-tiles_data)
  stx $4305
  lda #$01
  sta $420b

  ; --- tilemap -> VRAM word $7800 --------------------------------------------
  ldx #$7800
  stx $2116
  lda #$01
  sta $4300
  lda #$18
  sta $4301
  ldx #map_data
  stx $4302
  lda #:map_data
  sta $4304
  ldx #(map_end-map_data)
  stx $4305
  lda #$01
  sta $420b

  ; --- show it ---------------------------------------------------------------
  lda #$01
  sta $2105             ; BGMODE 1, 8×8 tiles
  lda #$78
  sta $2107             ; BG1SC: tilemap at word $7800, 32×32
  lda #$01
  sta $212c             ; TM: BG1 only on the main screen (no sprites)
  lda #$0f
  sta $2100             ; screen on, full brightness
loop:
  bra loop

.ENDS

.BANK 1 SLOT 0
.ORG 0
.SECTION "TileData" FORCE
tiles_data:
  .INCBIN "tiles.bin"
tiles_end:
.ENDS

.BANK 2 SLOT 0
.ORG 0
.SECTION "MapData" FORCE
map_data:
  .INCBIN "screen.bin"
map_end:
.ENDS

.BANK 3 SLOT 0
.ORG 0
.SECTION "PalData" FORCE
pal_data:
  .INCBIN "pal.bin"
pal_end:
.ENDS
