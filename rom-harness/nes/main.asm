; demake NES (NROM / mapper 0) ROM harness (doc 06 §rom, doc 10 §emulator E2E).
;
; A minimal display program: after the standard 2-vblank warm-up it uploads the
; 16-byte background palette, the 1024-byte screen block (a full 32x30 nametable
; with the image placed top-left, immediately followed by its 64-byte attribute
; table — they are contiguous at $2000..$23FF), turns the background on, and
; loops forever. The CHR pattern data lives in CHR-ROM, read by the PPU directly.
; The CLI writes the generated data beside this file as pal.bin / screen.bin /
; chr.bin.

.segment "HEADER"
    .byte "NES", $1a
    .byte 1          ; 1 x 16 KiB PRG
    .byte 1          ; 1 x 8 KiB CHR
    .byte $00, $00   ; mapper 0, horizontal mirroring
    .res 8, $00

.segment "CODE"
.proc reset
    sei
    cld
    ldx #$40
    stx $4017        ; disable APU frame IRQ
    ldx #$ff
    txs
    inx              ; x = 0
    stx $2000        ; PPUCTRL = 0 (NMI off)
    stx $2001        ; PPUMASK = 0 (rendering off)
    stx $4010        ; DMC IRQ off
    bit $2002
:   bit $2002        ; wait for first vblank
    bpl :-
:   bit $2002        ; wait for second vblank (PPU warmed up)
    bpl :-

    ; --- background palette -> $3F00 (16 bytes) -----------------------------
    bit $2002
    lda #$3f
    sta $2006
    lda #$00
    sta $2006
    ldx #$00
:   lda palette, x
    sta $2007
    inx
    cpx #16
    bne :-

    ; --- nametable + attribute -> $2000 (1024 bytes) ------------------------
    bit $2002
    lda #$20
    sta $2006
    lda #$00
    sta $2006
    lda #<screen
    sta $10
    lda #>screen
    sta $11
    ldx #$04         ; 4 pages of 256 = 1024 bytes
    ldy #$00
:   lda ($10), y
    sta $2007
    iny
    bne :-
    inc $11
    dex
    bne :-

    ; --- scroll to origin, enable background --------------------------------
    bit $2002
    lda #$00
    sta $2005
    sta $2005
    lda #$00
    sta $2000        ; nametable $2000, BG pattern table 0
    lda #$0a         ; show BG + leftmost 8px
    sta $2001
forever:
    jmp forever
.endproc

.proc nmi_irq
    rti
.endproc

.segment "RODATA"
palette: .incbin "pal.bin"
screen:  .incbin "screen.bin"

.segment "VECTORS"
    .word nmi_irq    ; NMI (disabled)
    .word reset      ; RESET
    .word nmi_irq    ; IRQ/BRK

.segment "CHARS"
    .incbin "chr.bin"
