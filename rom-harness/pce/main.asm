; demake PC Engine / TurboGrafx-16 ROM harness (doc 06 §rom, doc 10).
;
; A minimal WLA-DX (huc6280) display program for a 64 KiB HuCard: it maps the
; data banks into the CPU's address space, uploads the VCE background palettes,
; the HuC6270 characters and the BAT, programs the VDC's display timing for a
; 256×224 frame, then turns the background on and loops. The CLI writes the
; generated data beside this file as tiles.bin (characters, with one blank
; character appended) / screen.bin (a full 32×32-entry BAT with the image
; top-left) / pal.bin.
;
; Memory map. The HuC6280 sees eight 8 KiB pages through the MPR registers;
; reset leaves MPR7 = $00, which is why the code lives in ROM bank 0 and the
; reset vector at $FFFE. The three data blobs are laid out contiguously in one
; 40 KiB WLA bank so the block-transfer instructions can address them directly:
; ROM banks 1–5 are mapped edge to edge at $4000–$DFFF.
;
;   $0000  MPR0 = $FF  hardware I/O page (VDC $0000-$0003, VCE $0400-$0407)
;   $2000  MPR1 = $F8  work RAM (zero page $2000, stack $2100)
;   $4000  MPR2 = $01  ┐
;   $6000  MPR3 = $02  │
;   $8000  MPR4 = $03  ├ the 40 KiB data window
;   $A000  MPR5 = $04  │
;   $C000  MPR6 = $05  ┘
;   $E000  MPR7 = $00  this code + the vectors
;
; VRAM. The HuC6270's BAT is fixed at VRAM word $0000 and MWR selects its size;
; a 32×32 BAT occupies words $0000–$03FF, so the characters start at word $0400
; — character number 64 (each character is 16 words). The CLI adds that base to
; every BAT entry it emits.

.MEMORYMAP
DEFAULTSLOT 0
SLOTSIZE $2000
SLOT 0 $E000
SLOTSIZE $A000
SLOT 1 $4000
.ENDME

.ROMBANKMAP
BANKSTOTAL 4
BANKSIZE $2000
BANKS 1
BANKSIZE $A000
BANKS 1
BANKSIZE $2000
BANKS 2
.ENDRO

.BANK 0 SLOT 0
.ORG 0
.SECTION "Main" FORCE

irq_handler:
  rti

main:
  sei                   ; the interrupt controller masks everything at reset;
  csh                   ; keep it that way and run at 7.16 MHz
  cld
  lda #$ff
  tam #$01              ; MPR0 = hardware I/O page
  lda #$f8
  tam #$02              ; MPR1 = work RAM
  ldx #$ff
  txs                   ; stack at $21FF
  lda #$01
  tam #$04              ; MPR2 = data bank 1 -> $4000
  lda #$02
  tam #$08              ; MPR3 = data bank 2 -> $6000
  lda #$03
  tam #$10              ; MPR4 = data bank 3 -> $8000
  lda #$04
  tam #$20              ; MPR5 = data bank 4 -> $A000
  lda #$05
  tam #$40              ; MPR6 = data bank 5 -> $C000

  ; --- VDC control: background and sprites off while VRAM is loaded ---------
  ; CR bits 11-10 select the VRAM auto-increment; zero means +1, which is what
  ; the block transfers below rely on.
  st0 #$05
  st1 #$00
  st2 #$00

  ; --- characters -> VRAM word $0400 ----------------------------------------
  st0 #$00              ; MAWR
  st1 #$00
  st2 #$04
  st0 #$02              ; VWR — $0002/$0003 are now the VRAM data port
  tia chars, $0002, chars_end-chars

  ; --- BAT -> VRAM word $0000 -----------------------------------------------
  st0 #$00
  st1 #$00
  st2 #$00
  st0 #$02
  tia bat, $0002, bat_end-bat

  ; --- palettes -> VCE color table ------------------------------------------
  stz $0400             ; VCE CR: 5.37 MHz dot clock, color, 262-line frame
  stz $0402             ; CTA = 0
  stz $0403
  tia pal, $0404, pal_end-pal

  ; --- VDC display timing ----------------------------------------------------
  st0 #$06              ; RCR — no raster interrupt
  st1 #$00
  st2 #$00
  st0 #$07              ; BXR = 0: BAT column 0 at screen x 0
  st1 #$00
  st2 #$00
  st0 #$08              ; BYR = 0: BAT row 0 on the first active line
  st1 #$00
  st2 #$00
  st0 #$09              ; MWR: 32×32 BAT, no CG mode
  st1 #$00
  st2 #$00
  st0 #$0a              ; HSR: HSW = 2, HDS = 2
  st1 #$02
  st2 #$02
  st0 #$0b              ; HDR: HDW = 31 -> (31+1)*8 = 256 pixels, HDE = 3
  st1 #$1f
  st2 #$03
  st0 #$0c              ; VPR: VSW = 2, VDS = 12
  st1 #$02
  st2 #$0c
  st0 #$0d              ; VDW = 223 -> 224 active lines
  st1 #$df
  st2 #$00
  st0 #$0e              ; VCR = 22, making the frame 262 lines
  st1 #$16
  st2 #$00
  st0 #$0f              ; DCR: no DMA, no SATB transfer
  st1 #$00
  st2 #$00

  ; --- show it ---------------------------------------------------------------
  st0 #$05              ; CR: background on, sprites off, no interrupts
  st1 #$80
  st2 #$00
loop:
  bra loop

.ENDS

.BANK 0 SLOT 0
.ORG $1ff6
.SECTION "Vectors" FORCE
  .dw irq_handler       ; $FFF6 IRQ2 (external / CD)
  .dw irq_handler       ; $FFF8 IRQ1 (VDC)
  .dw irq_handler       ; $FFFA timer
  .dw irq_handler       ; $FFFC NMI
  .dw main              ; $FFFE reset
.ENDS

.BANK 1 SLOT 1
.ORG 0
.SECTION "Data" FORCE
chars:
  .INCBIN "tiles.bin"
chars_end:
bat:
  .INCBIN "screen.bin"
bat_end:
pal:
  .INCBIN "pal.bin"
pal_end:
.ENDS
