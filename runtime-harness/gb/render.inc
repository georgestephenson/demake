; Rendering.
;
; Nothing here feeds back into the simulation — doc 14 §1 is *simulate
; constrained, render unconstrained*, and on hardware "unconstrained" still
; means "whatever the PPU will do", but the direction of the dependency is the
; point: rendering reads state and never writes it.
;
; The background is drawn into a shadow of the visible 20x18 window each frame
; and diffed against what VRAM already holds, so only changed cells are queued.
; That keeps the VBlank window's work proportional to what actually moved — a
; score ticking over is three writes — instead of to the size of the screen.
;
; Objects are hardware sprites, one per cell of their collision box. `number`
; and `text` objects draw on the background, which is what makes them free of
; the sprite budget the compiler reports (doc 14 §Budgets).

BuildFrame:
    ; Erase only what was drawn last frame. A HUD is a handful of cells, and
    ; sweeping the whole window each tick cost more than everything else in the
    ; renderer put together.
    ld a, [wPlotPrevN]
    or a
    jr z, .cleared
    ld b, a
    ld hl, wPlotPrev
.erase:
    ld a, [hl+]
    ld e, a
    ld a, [hl+]
    ld d, a
    push hl
    ld hl, wShadow
    add hl, de
    ld [hl], TILE_BLANK
    pop hl
    dec b
    jr nz, .erase
.cleared:
    xor a
    ld [wPlotN], a
    ld [wOamN], a
    call SceneInstancesBegin
.loop:
    call SceneInstanceNext
    jr nc, .done
    ld [wEntId], a
    ld b, P_VIS
    ld de, wT0
    call LoadStoredProp
    ld a, [wT0]
    ld hl, wT0 + 1
    or [hl]
    inc hl
    or [hl]
    inc hl
    or [hl]
    jr z, .loop
    ld a, [wEntId]
    call InstancePtr
    inc hl
    ld a, [hl]
    cp KIND_NUMBER
    jr z, .number
    cp KIND_TEXT
    jr z, .text
    cp KIND_SPRITE
    jr z, .sprite
    jr .loop
.number:
    call DrawNumber
    jr .loop
.text:
    call DrawText
    jr .loop
.sprite:
    call DrawSprite
    jr .loop
.done:
    call ClearUnusedSprites
    jp DiffShadow

; --- reading positions -------------------------------------------------------

; wEntId's property B, floored to whole cells, in HL (signed).
PropCells:
    ld a, [wEntId]
    ld de, wN0
    call LoadStoredProp
    ld a, [wN0 + 2]
    ld l, a
    ld a, [wN0 + 3]
    ld h, a
    ret

; wEntId's property B, floored to whole pixels, in HL (signed): a cell is eight
; pixels, so this is an arithmetic shift right by thirteen.
PropPixels:
    ld a, [wEntId]
    ld de, wN0
    call LoadStoredProp
    ld a, [wN0 + 1]
    ld l, a
    ld a, [wN0 + 2]
    ld h, a
    ld a, [wN0 + 3]
    ld b, a
    ld c, 5
.shift:
    sra b
    rr h
    rr l
    dec c
    jr nz, .shift
    ret

; --- background --------------------------------------------------------------

; Draw tile A at column wTmpA, row wTmpB, ignoring anything off screen, and
; remember the cell so the diff has a short list to walk.
PlotCell:
    ld c, a
    ld a, [wTmpB]
    cp VIEW_H
    ret nc                  ; also catches negative rows, which wrap high
    ld a, [wTmpA]
    cp VIEW_W
    ret nc
    ; The shadow shares the tilemap's 32-cell stride, so this index is also the
    ; VRAM offset the upload will use.
    ld a, [wTmpB]
    ld l, a
    ld h, 0
    REPT 5
    add hl, hl
    ENDR
    ld a, [wTmpA]
    ld e, a
    ld d, 0
    add hl, de
    ld d, h
    ld e, l                 ; de = cell index
    ld hl, wShadow
    add hl, de
    ld [hl], c
    ld a, [wPlotN]
    cp MAX_PLOT
    ret nc
    ld l, a
    ld h, 0
    add hl, hl
    ld bc, wPlot
    add hl, bc
    ld a, e
    ld [hl+], a
    ld a, d
    ld [hl], a
    ld hl, wPlotN
    inc [hl]
    ret

DrawText:
    ld a, [wEntId]
    call InstancePtr
    ld de, 3
    add hl, de
    ld a, [hl]
    cp NONE
    ret z
    push af
    ld b, P_X
    call PropCells
    ld a, l
    ld [wTmpA], a
    ld a, h
    ld [wTmpC], a           ; high byte, to reject off-screen columns
    ld b, P_Y
    call PropCells
    ld a, l
    ld [wTmpB], a
    ld a, h
    or a
    jr z, .rowOk
    pop af
    ret
.rowOk:
    pop af
    call StringPtr
    ld a, [hl+]
    ld b, a
    or a
    ret z
.loop:
    ld a, [hl+]
    push hl
    push bc
    call PlotCell
    pop bc
    pop hl
    ld a, [wTmpA]
    inc a
    ld [wTmpA], a
    dec b
    jr nz, .loop
    ret

; Powers of ten, largest first, for the digit loop below.
DecimalPowers:
    dw 10000, 1000, 100, 10, 1

DrawNumber:
    ld b, P_X
    call PropCells
    ld a, l
    ld [wTmpA], a
    ld b, P_Y
    call PropCells
    ld a, l
    ld [wTmpB], a
    ld b, P_VALUE
    call PropCells          ; hl = the whole part, signed
    bit 7, h
    jr z, .positive
    ; negative: a minus sign, then the magnitude
    ld a, h
    cpl
    ld h, a
    ld a, l
    cpl
    ld l, a
    inc hl
    push hl
    ld a, "-" - 32
    call PlotCell
    ld a, [wTmpA]
    inc a
    ld [wTmpA], a
    pop hl
.positive:
    ld d, h
    ld e, l                 ; de = remaining value
    ld hl, DecimalPowers
    ld c, 5                 ; five columns of powers
    xor a
    ld [wTmpC], a           ; have we emitted a digit yet?
.power:
    ld a, [hl+]
    ld b, a
    ld a, [hl+]
    push hl
    ld h, a
    ld l, b                 ; hl = this power of ten
    ld b, 0                 ; digit
.subtract:
    ; de -= hl while it fits
    ld a, e
    sub l
    ld a, d
    sbc a, h
    jr c, .digitDone
    ld a, e
    sub l
    ld e, a
    ld a, d
    sbc a, h
    ld d, a
    inc b
    jr .subtract
.digitDone:
    ld a, b
    or a
    jr nz, .emit
    ld a, [wTmpC]
    or a
    jr nz, .emit
    ld a, c
    dec a
    jr nz, .skipDigit       ; suppress leading zeros, but never the units digit
.emit:
    ld a, 1
    ld [wTmpC], a
    ld a, b
    add "0" - 32
    push bc
    push de
    call PlotCell
    pop de
    pop bc
    ld a, [wTmpA]
    inc a
    ld [wTmpA], a
.skipDigit:
    pop hl
    dec c
    jr nz, .power
    ret

; --- sprites -----------------------------------------------------------------

DrawSprite:
    ld b, P_X
    call PropPixels
    ld a, l
    ld [wTmpA], a           ; left, in pixels
    ld b, P_Y
    call PropPixels
    ld a, l
    ld [wTmpB], a           ; top, in pixels
    ld b, P_W
    call PropCells
    ld a, l
    or a
    jr nz, .haveWidth
    inc a
.haveWidth:
    ld [wSprW], a
    ld b, P_H
    call PropCells
    ld a, l
    or a
    jr nz, .haveHeight
    inc a
.haveHeight:
    ld [wSprH], a

    xor a
    ld [wSprRow], a
.rowLoop:
    ld a, [wSprRow]
    ld hl, wSprH
    cp [hl]
    ret z
    xor a
    ld [wSprCol], a
.colLoop:
    ld a, [wSprCol]
    ld hl, wSprW
    cp [hl]
    jr z, .nextRow
    ld a, [wOamN]
    cp 40
    ret nc                  ; the hardware has forty entries and no more
    ld l, a
    ld h, 0
    add hl, hl
    add hl, hl
    ld de, wOAM
    add hl, de
    ; Y = top + row * 8 + 16
    ld a, [wSprRow]
    ld c, a
    ld a, [wTmpB]
    inc c
.shiftY:
    dec c
    jr z, .storeY
    add 8
    jr .shiftY
.storeY:
    add 16
    ld [hl+], a
    ; X = left + column * 8 + 8
    ld a, [wSprCol]
    ld c, a
    ld a, [wTmpA]
    inc c
.shiftX:
    dec c
    jr z, .storeX
    add 8
    jr .shiftX
.storeX:
    add 8
    ld [hl+], a
    ld a, TILE_OBJECT
    ld [hl+], a
    xor a
    ld [hl], a
    ld hl, wOamN
    inc [hl]
    ld a, [wSprCol]
    inc a
    ld [wSprCol], a
    jr .colLoop
.nextRow:
    ld a, [wSprRow]
    inc a
    ld [wSprRow], a
    jr .rowLoop

; Park every unused entry off the top of the screen.
ClearUnusedSprites:
    ld a, [wOamN]
    cp 40
    ret nc
    ld l, a
    ld h, 0
    add hl, hl
    add hl, hl
    ld de, wOAM
    add hl, de
    ld a, 40
    ld b, a
    ld a, [wOamN]
    ld c, a
    ld a, b
    sub c
    ld b, a
.loop:
    xor a
    ld [hl+], a
    ld [hl+], a
    ld [hl+], a
    ld [hl+], a
    dec b
    jr nz, .loop
    ret

; --- upload ------------------------------------------------------------------

; Queue every cell whose content changed, walking last frame's list and this
; frame's rather than the whole window. Cells in both lists are visited twice
; and the second visit finds them already equal, which is cheaper than
; deduplicating them would be.
DiffShadow:
    xor a
    ld [wQueueN], a
    ld a, [wPlotPrevN]
    ld hl, wPlotPrev
    call DiffList
    ld a, [wPlotN]
    ld hl, wPlot
    call DiffList
    ; This frame's list becomes next frame's erase list.
    ld a, [wPlotN]
    ld [wPlotPrevN], a
    or a
    ret z
    ld l, a
    ld h, 0
    add hl, hl
    ld b, h
    ld c, l
    ld hl, wPlot
    ld de, wPlotPrev
    jp CopyBytes

; A = entry count, HL = list of 16-bit cell indices.
DiffList:
    or a
    ret z
    ld [wTmpA], a
.each:
    ld a, [hl+]
    ld e, a
    ld a, [hl+]
    ld d, a
    push hl
    ld hl, wShadow
    add hl, de
    ld c, [hl]              ; what the cell should hold
    ld hl, wUploaded
    add hl, de
    ld a, [hl]
    cp c
    jr z, .same
    ld [hl], c
    ld hl, VRAM_MAP
    add hl, de
    ld b, h
    ld a, c                 ; the tile to write
    ld c, l                 ; bc is now the VRAM address
    call QueuePush
.same:
    pop hl
    ld a, [wTmpA]
    dec a
    ld [wTmpA], a
    jr nz, .each
    ret

; A = tile, BC = VRAM address. Preserves every register the diff loop holds.
QueuePush:
    ld [wTmpC], a
    ld a, [wQueueN]
    cp QUEUE_MAX
    ret nc
    push hl
    push de
    ld l, a
    ld h, 0
    ld d, h
    ld e, l
    add hl, hl
    add hl, de              ; index * 3
    ld de, wQueue
    add hl, de
    ld a, c
    ld [hl+], a
    ld a, b
    ld [hl+], a
    ld a, [wTmpC]
    ld [hl], a
    ld hl, wQueueN
    inc [hl]
    pop de
    pop hl
    ld a, [wTmpC]
    ret

; Flush the queue and hand OAM to the DMA. Both fit inside VBlank by
; construction: the queue is capped, and anything left over goes next frame.
UploadFrame:
    ld a, [wQueueN]
    or a
    jr z, .sprites
    ld b, a
    ld hl, wQueue
.loop:
    ld a, [hl+]
    ld e, a
    ld a, [hl+]
    ld d, a
    ld a, [hl+]
    ld [de], a
    dec b
    jr nz, .loop
    xor a
    ld [wQueueN], a
.sprites:
    call hDma
    ret
