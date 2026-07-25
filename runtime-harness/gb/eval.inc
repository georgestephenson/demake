; Property access and the expression VM.
;
; Expressions arrive as postfix bytecode (rom/format.ts §OP), which is why this
; is a loop over bytes with an explicit stack rather than a tree walk: the
; machine has no recursion budget worth spending, and a bounded stack in RAM is
; both smaller and impossible to overflow accidentally. Operand order is the
; interpreter's order, which matters because `random` has a side effect.

DEF OP_END    EQU $00
DEF OP_CONST  EQU $01
DEF OP_READ   EQU $02
DEF OP_CAMERA EQU $03
DEF OP_NEG    EQU $04
DEF OP_ADD    EQU $05
DEF OP_SUB    EQU $06
DEF OP_MUL    EQU $07
DEF OP_DIV    EQU $08
DEF OP_LT     EQU $09
DEF OP_GT     EQU $0A
DEF OP_LE     EQU $0B
DEF OP_GE     EQU $0C
DEF OP_EQ     EQU $0D
DEF OP_NE     EQU $0E
DEF OP_ABS    EQU $0F
DEF OP_MIN    EQU $10
DEF OP_MAX    EQU $11
DEF OP_CLAMP  EQU $12
DEF OP_RANDOM EQU $13

; --- properties --------------------------------------------------------------

; A = entity id, B = stored prop id, DE = destination. Copies four bytes.
LoadStoredProp:
    push de
    call EntityPtr
    ld a, b
    ld c, a
    sla c
    sla c
    ld b, 0
    add hl, bc
    pop de
    call Copy32
    ret

; Derived properties, in PROP_IDS order after the stored nine:
; base property, property to add (NONE for none), and whether to halve it.
DerivedTable:
    db P_X, P_W, 1     ; centerx
    db P_Y, P_H, 1     ; centery
    db P_X, NONE, 0    ; left
    db P_X, P_W, 0     ; right
    db P_Y, NONE, 0    ; top
    db P_Y, P_H, 0     ; bottom

; A = entity id (NONE reads as zero), B = prop id -> wN0.
GetProp:
    cp NONE
    jr z, GetPropZero
    ld [wTmpA], a
    ld a, b
    cp PROP_COUNT
    jr nc, .derived
    ld a, [wTmpA]
    ld de, wN0
    jp LoadStoredProp
.derived:
    sub PROP_COUNT
    ld l, a
    ld h, 0
    add hl, hl
    ld d, 0
    ld e, a
    add hl, de          ; index * 3
    ld de, DerivedTable
    add hl, de
    ld a, [hl+]
    ld b, a
    ld a, [hl+]
    ld c, a
    ld a, [hl]
    ld [wTmpB], a
    push bc
    ld a, [wTmpA]
    ld de, wN0
    call LoadStoredProp
    pop bc
    ld a, c
    cp NONE
    ret z
    ld b, c
    ld a, [wTmpA]
    ld de, wN1
    call LoadStoredProp
    ld a, [wTmpB]
    or a
    jr z, .noHalve
    ld hl, wN1
    call Asr32At
.noHalve:
    jp Add32

GetPropZero:
    xor a
    ld [wN0], a
    ld [wN0 + 1], a
    ld [wN0 + 2], a
    ld [wN0 + 3], a
    ret

; A = entity id (NONE is a no-op), B = stored prop id, value in wN0.
SetProp:
    cp NONE
    ret z
    ld [wTmpA], a
    push bc
    call Clamp32
    pop bc
    ld a, [wTmpA]
    push bc
    call EntityPtr
    pop bc
    ld a, b
    ld c, a
    sla c
    sla c
    ld b, 0
    add hl, bc
    ld d, h
    ld e, l
    ld hl, wN0
    jp Copy32

; A = refkind, B = instance id -> A = entity id, or NONE when unbound.
ResolveRef:
    or a
    jr nz, .notInstance
    ld a, b
    ret
.notInstance:
    dec a
    jr nz, .other
    ld a, [wSubject]
    ret
.other:
    ld a, [wOther]
    ret

; A = entity id. Z set when the object is not in play — either it belongs to
; another scene or its `visible` is zero, which doc 14 makes the same thing:
; an object you cannot see must not be collided with or steered either.
IsPlayable:
    push bc
    ld c, a
    call InstancePtr
    ld a, [hl]
    ld hl, wScene
    cp [hl]
    jr nz, .no
    ld a, c
    ld b, P_VIS
    ld de, wVis
    call LoadStoredProp
    ld a, [wVis]
    ld hl, wVis + 1
    or [hl]
    inc hl
    or [hl]
    inc hl
    or [hl]
    pop bc
    ret
.no:
    pop bc
    xor a
    ret

; A = entity id. Z set when the object belongs to another scene.
IsActive:
    push bc
    call InstancePtr
    ld a, [hl]
    ld hl, wScene
    cp [hl]
    pop bc
    jr z, .yes
    xor a
    ret
.yes:
    ld a, 1
    or a
    ret

; --- the expression stack ----------------------------------------------------

StackSlot:
    ld l, a
    ld h, 0
    add hl, hl
    add hl, hl
    ld de, wStack
    add hl, de
    ret

PushN0:
    ld a, [wESP]
    call StackSlot
    ld d, h
    ld e, l
    ld hl, wN0
    call Copy32
    ld hl, wESP
    inc [hl]
    ret

PopN0:
    ld hl, wESP
    dec [hl]
    ld a, [hl]
    call StackSlot
    ld de, wN0
    jp Copy32

PopN1:
    ld hl, wESP
    dec [hl]
    ld a, [hl]
    call StackSlot
    ld de, wN1
    jp Copy32

; wN0 = 65536 when Z is clear on entry... written as an explicit helper instead:
; A = 1 for true, 0 for false.
SetBool:
    or a
    jr z, .false
    xor a
    ld [wN0], a
    ld [wN0 + 1], a
    ld [wN0 + 3], a
    ld a, 1
    ld [wN0 + 2], a
    ret
.false:
    xor a
    ld [wN0], a
    ld [wN0 + 1], a
    ld [wN0 + 2], a
    ld [wN0 + 3], a
    ret

; --- the VM ------------------------------------------------------------------

; HL = bytecode address (zero means "nothing to evaluate", yielding zero).
; Result in wN0.
Eval:
    ld a, h
    or l
    jp z, GetPropZero
    ld d, h
    ld e, l
    xor a
    ld [wESP], a
.next:
    ld a, [de]
    inc de
    cp OP_END
    jr z, .end
    cp OP_CONST
    jr z, .const
    cp OP_READ
    jr z, .read
    cp OP_CAMERA
    jr z, .camera
    cp OP_NEG
    jr z, .neg
    cp OP_ABS
    jp z, .abs
    cp OP_MIN
    jp z, .minmax
    cp OP_MAX
    jp z, .minmax
    cp OP_CLAMP
    jp z, .clamp
    cp OP_RANDOM
    jp z, .random
    jp .binary

.end:
    call PopN0
    ret

.const:
    ld hl, wN0
    REPT 4
    ld a, [de]
    ld [hl+], a
    inc de
    ENDR
    push de
    call PushN0
    pop de
    jp .next

.read:
    ld a, [de]
    inc de
    ld [wTmpC], a           ; refkind
    ld a, [de]
    inc de
    ld b, a                 ; instance id
    ld a, [de]
    inc de
    ld [wTmpB], a           ; prop
    push de
    ld a, [wTmpC]
    call ResolveRef
    ld b, a
    ld a, [wTmpB]
    ld c, a
    ld a, b
    ld b, c
    call GetProp
    call PushN0
    pop de
    jp .next

.camera:
    ; Without a level the viewport never leaves the origin (doc 14 §Levels),
    ; and this runtime does not build levels, so the read is a constant.
    inc de
    push de
    call GetPropZero
    call PushN0
    pop de
    jp .next

.neg:
    push de
    call PopN0
    call Neg32
    call Clamp32
    call PushN0
    pop de
    jp .next

.abs:
    push de
    call PopN0
    ld a, [wN0 + 3]
    bit 7, a
    jr z, .absDone
    call Neg32
.absDone:
    call PushN0
    pop de
    jp .next

.minmax:
    ld [wTmpA], a
    push de
    call PopN1
    call PopN0
    call Cmp32
    ld b, a
    ld a, [wTmpA]
    cp OP_MIN
    jr nz, .wantMax
    ld a, b
    cp $FF
    jr z, .keep
    jr .takeN1
.wantMax:
    ld a, b
    cp 1
    jr z, .keep
.takeN1:
    ld hl, wN1
    ld de, wN0
    call Copy32
.keep:
    call PushN0
    pop de
    jp .next

.clamp:
    push de
    call PopN1
    ld hl, wN1
    ld de, wT1
    call Copy32             ; hi
    call PopN1
    ld hl, wN1
    ld de, wT0
    call Copy32             ; lo
    call PopN0
    ld hl, wT0
    ld de, wN1
    call Copy32
    call Cmp32
    cp $FF
    jr nz, .checkHigh
    ld hl, wT0
    ld de, wN0
    call Copy32
    jr .clampDone
.checkHigh:
    ld hl, wT1
    ld de, wN1
    call Copy32
    call Cmp32
    cp 1
    jr nz, .clampDone
    ld hl, wT1
    ld de, wN0
    call Copy32
.clampDone:
    call PushN0
    pop de
    jp .next

.random:
    push de
    call PopN1
    call PopN0
    call RngPick
    call PushN0
    pop de
    jp .next

.binary:
    ld [wTmpA], a
    push de
    call PopN1
    call PopN0
    ld a, [wTmpA]
    cp OP_ADD
    jr nz, .notAdd
    call Add32
    call Clamp32
    jr .binDone
.notAdd:
    cp OP_SUB
    jr nz, .notSub
    call Sub32
    call Clamp32
    jr .binDone
.notSub:
    cp OP_MUL
    jr nz, .notMul
    call Mul32
    jr .binDone
.notMul:
    cp OP_DIV
    jr nz, .compare
    call Div32
    jr .binDone
.compare:
    call Cmp32
    ld b, a
    ld a, [wTmpA]
    cp OP_LT
    jr nz, .notLt
    ld a, b
    cp $FF
    jr .boolFromZ
.notLt:
    cp OP_GT
    jr nz, .notGt
    ld a, b
    cp 1
    jr .boolFromZ
.notGt:
    cp OP_LE
    jr nz, .notLe
    ld a, b
    cp 1
    jr .boolFromNz
.notLe:
    cp OP_GE
    jr nz, .notGe
    ld a, b
    cp $FF
    jr .boolFromNz
.notGe:
    cp OP_EQ
    jr nz, .notEq
    ld a, b
    or a
    jr .boolFromZ
.notEq:
    ld a, b
    or a
    jr .boolFromNz

.boolFromZ:
    ld a, 0
    jr nz, .setBool
    ld a, 1
    jr .setBool
.boolFromNz:
    ld a, 1
    jr nz, .setBool
    ld a, 0
.setBool:
    call SetBool
.binDone:
    call PushN0
    pop de
    jp .next
