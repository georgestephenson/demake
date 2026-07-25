; demake — the `gb` family Demotic runtime (doc 14 §Runtime model).
;
; This is a *fixed engine*, not generated code. It consumes the program tables
; `demake build` emits (see packages/demotic/src/rom/format.ts) and implements
; the tick order doc 14 specifies, in the order it specifies, because a runtime
; that reorders those steps diverges from the reference interpreter within
; seconds. Adding a language feature adds an opcode here, not a code path in a
; per-game generator — N + M work instead of N x M.
;
; Layout: the runtime lives in the bottom 16 KiB of a 32 KiB cartridge and the
; tables are patched into the top half at DATA_BASE. Nothing here is
; game-specific, so one assembled image serves every game — which is what lets
; the web app play a ROM it never assembled (doc 13 §D5).
;
; What this runtime does not do yet, deliberately: levels, tiles, and the
; camera. Those landed in the language after the runtime scope was fixed
; (doc 14 §Levels); `demake build` refuses a game that uses them rather than
; quietly playing a different game. Sprite art is likewise pending doc 15's
; rasteriser, so objects draw as the built-in block.

; --- hardware ----------------------------------------------------------------

DEF rP1    EQU $FF00
DEF rDIV   EQU $FF04
DEF rIF    EQU $FF0F
DEF rLCDC  EQU $FF40
DEF rSTAT  EQU $FF41
DEF rSCY   EQU $FF42
DEF rSCX   EQU $FF43
DEF rLY    EQU $FF44
DEF rDMA   EQU $FF46
DEF rBGP   EQU $FF47
DEF rOBP0  EQU $FF48
DEF rOBP1  EQU $FF49
DEF rIE    EQU $FFFF

DEF VRAM_TILES EQU $8000
DEF VRAM_MAP   EQU $9800

; --- the table format --------------------------------------------------------
; Every constant below mirrors packages/demotic/src/rom/format.ts. The two are
; one contract; a field moves in both files or in neither.

DEF DATA_BASE EQU $4000
DEF DATA_SIZE_RESERVED EQU $4000

DEF H_VERSION        EQU DATA_BASE + 4
DEF H_FPS            EQU DATA_BASE + 5
DEF H_SCREEN_W       EQU DATA_BASE + 6
DEF H_SCREEN_H       EQU DATA_BASE + 7
DEF H_SEED           EQU DATA_BASE + 8
DEF H_ENTRY_SCENE    EQU DATA_BASE + 12
DEF H_SCENE_COUNT    EQU DATA_BASE + 13
DEF H_INSTANCE_COUNT EQU DATA_BASE + 14
DEF H_CONTROL_COUNT  EQU DATA_BASE + 15
DEF H_RULE_COUNT     EQU DATA_BASE + 16
DEF H_LEVEL_COUNT    EQU DATA_BASE + 17
DEF H_STRING_COUNT   EQU DATA_BASE + 18
DEF H_SCENES         EQU DATA_BASE + 20
DEF H_SCENE_INSTS    EQU DATA_BASE + 22
DEF H_INSTANCES      EQU DATA_BASE + 24
DEF H_CONTROLS       EQU DATA_BASE + 26
DEF H_RULES          EQU DATA_BASE + 28
DEF H_LEVELS         EQU DATA_BASE + 30
DEF H_STRINGS        EQU DATA_BASE + 32
DEF H_TILES          EQU DATA_BASE + 34
DEF H_TILE_COUNT     EQU DATA_BASE + 36
DEF H_HOLD_SLOTS     EQU DATA_BASE + 38

DEF PROP_COUNT   EQU 9
DEF ENTITY_SIZE  EQU PROP_COUNT * 4    ; 36
DEF INSTANCE_SIZE EQU 4 + PROP_COUNT * 4 ; 40
DEF SCENE_SIZE   EQU 8
DEF CONTROL_SIZE EQU 8
DEF RULE_SIZE    EQU 16
DEF ASSIGN_SIZE  EQU 6

DEF P_X      EQU 0
DEF P_Y      EQU 1
DEF P_W      EQU 2
DEF P_H      EQU 3
DEF P_SPEED  EQU 4
DEF P_XDIR   EQU 5
DEF P_YDIR   EQU 6
DEF P_VIS    EQU 7
DEF P_VALUE  EQU 8

DEF KIND_PLAIN  EQU 0
DEF KIND_SPRITE EQU 1
DEF KIND_NUMBER EQU 2
DEF KIND_TEXT   EQU 3

DEF RULE_HITS      EQU 0
DEF RULE_INPUT     EQU 1
DEF RULE_REACHES   EQU 2
DEF RULE_PREDICATE EQU 3

DEF ASSIGN_PROP  EQU 0
DEF ASSIGN_SCENE EQU 1
DEF ASSIGN_FLIP  EQU 2

DEF REF_INSTANCE EQU 0
DEF REF_SUBJECT  EQU 1
DEF REF_OTHER    EQU 2

DEF MODE_HOLD    EQU 0
DEF MODE_PRESS   EQU 1
DEF MODE_RELEASE EQU 2

DEF NONE EQU $FF

; Built-in tile bank indices (packages/demotic/src/rom/graphics.ts).
DEF TILE_BLANK  EQU 0
DEF TILE_OBJECT EQU 63

; Runtime capacities, matching LIMITS in rom/tables.ts.
DEF MAX_ENTITIES  EQU 64
DEF MAX_CONTACTS  EQU 96
DEF MAX_HOLD      EQU 64
DEF MAX_RULES     EQU 128
DEF MAX_ASSIGN    EQU 8
DEF STACK_DEPTH   EQU 16
DEF QUEUE_MAX     EQU 160
DEF MAX_PLOT      EQU 96

DEF VIEW_W EQU 20
DEF VIEW_H EQU 18

; --- work RAM ----------------------------------------------------------------
; Fixed addresses, because the conformance harness reads the entity table
; straight out of WRAM (doc 14 §Conformance): a trace is then a memory dump
; rather than a serial protocol the runtime would have to spend cycles on.

SECTION "OAM buffer", WRAM0[$C000]
wOAM:: ds 160

SECTION "Entities", WRAM0[$C0A0]
wEntities:: ds MAX_ENTITIES * ENTITY_SIZE

SECTION "Trace block", WRAM0[$C9A0]
wTick::     ds 2   ; ticks completed
wScene::    ds 1   ; running scene index
wPending::  ds 1   ; pending scene change, or NONE
wRng::      ds 4   ; the game's generator state
wHeld::     ds 1
wPressed::  ds 1
wReleased:: ds 1
wReady::    ds 1   ; bumped after each completed tick: the harness's handshake
wBooted::   ds 1   ; set once initialisation is done and input is being read

SECTION "Engine state", WRAM0[$C9B0]

; Cached header pointers, so the hot loops never re-read the header.
wScenesPtr:      ds 2
wSceneInstsPtr:  ds 2
wInstancesPtr:   ds 2
wControlsPtr:    ds 2
wRulesPtr:       ds 2
wLevelsPtr:      ds 2
wStringsPtr:     ds 2
wSceneCount:     ds 1
wInstanceCount:  ds 1
wControlCount:   ds 1
wRuleCount:      ds 1
wScreenW:        ds 1
wScreenH:        ds 1
wFps:            ds 1

; Fixed-point scratch. wN0/wN1 are the ALU's operands; wN2 is its spill.
wN0: ds 4
wN1: ds 4
wN2: ds 4
wT0: ds 4
wT1: ds 4
wE0: ds 4
wE1: ds 4
wE2: ds 4
wE3: ds 4
; Multiply / divide working set.
wU0: ds 4
wU1: ds 4
wP:  ds 7
wM:  ds 7
wR:  ds 4
wSign: ds 1

; Expression VM.
wStack:  ds STACK_DEPTH * 4
wESP:    ds 1
wCode:   ds 2

; Rule / control iteration.
wRulePtr:    ds 2
wRuleIdx:    ds 1
wSubject:    ds 1
wOther:      ds 1
wSubjPtr:    ds 2
wSubjLeft:   ds 1
wSubjMode:   ds 1
wTmpA:       ds 1
wTmpB:       ds 1
wTmpC:       ds 1
wVis:        ds 4
wFired:      ds 1
; The control and collision loops need state that survives a rule firing, and a
; rule fires `Eval`, which owns wTmp*. Hence dedicated slots rather than reuse.
wCtlAction:  ds 1   ; the button TestAction examines, for controls and rules alike
wCtlMode:    ds 1
wCtlHold:    ds 1
wCtlList:    ds 2
wEdge:       ds 1
wLoopI:      ds 1
wLoopJ:      ds 1
wLoopK:      ds 1
wEntId:      ds 1
wListPtr:    ds 2
wListLeft:   ds 1

; Assignment application, kept apart from wTmp* because `Eval` and `GetProp`
; use those and an assignment's loop straddles both.
wAsgN:       ds 1
wAsgIdx:     ds 1
wAsgPtr:     ds 2
wAsgKind:    ds 1
wAsgRef:     ds 1
wAsgEnt:     ds 1
wAsgProp:    ds 1
wAsgVal:     ds 2

; `hits` payload cursors.
wPSub:       ds 2
wNSub:       ds 1
wPOth:       ds 2
wNOth:       ds 1
wPEdge:      ds 2
wNEdge:      ds 1
wLevelFlag:  ds 1
wQuery:      ds 4

; Pending writes, so a rule's assignments apply simultaneously.
wWriteN:     ds 1
wWriteEnt:   ds MAX_ASSIGN
wWriteProp:  ds MAX_ASSIGN
wWriteVal:   ds MAX_ASSIGN * 4

; Collision bookkeeping. A contact is (rule, subject, kind, target).
wContacts:     ds MAX_CONTACTS * 4
wContactsPrev: ds MAX_CONTACTS * 4
wContactN:     ds 1
wContactPrevN: ds 1

; `on hold` snapshots: a 32-bit value plus a validity byte per binding slot.
wHoldVal:   ds MAX_HOLD * 4
wHoldOk:    ds MAX_HOLD

; `reaches` history: last tick's delta per rule, plus a validity byte.
wReachVal:  ds MAX_RULES * 4
wReachOk:   ds MAX_RULES

; Rendering. The shadow uses the tilemap's own 32-cell stride so a cell index is
; also its VRAM offset — which is what lets the diff work from a list of cells
; that were actually drawn instead of sweeping the whole window.
wShadow:    ds 32 * VIEW_H
wUploaded:  ds 32 * VIEW_H
wPlot:      ds MAX_PLOT * 2
wPlotPrev:  ds MAX_PLOT * 2
wPlotN:     ds 1
wPlotPrevN: ds 1
wQueue:     ds QUEUE_MAX * 3
wQueueN:    ds 1
wOamN:      ds 1
wSprW:      ds 1
wSprH:      ds 1
wSprRow:    ds 1
wSprCol:    ds 1

SECTION "HRAM", HRAM
hDma: ds 16

; --- cartridge ---------------------------------------------------------------

SECTION "VBlank", ROM0[$0040]
    reti

SECTION "Header", ROM0[$100]
    nop
    jp Entry
    ds $150 - @, 0 ; the ROM writer fills logo, title, and checksums

SECTION "Runtime", ROM0[$150]

Entry:
    ld sp, $DFFF
    call WaitLcdOff
    call InitVideo
    call CacheHeader
    call InitState
    call BuildFrame
    call UploadFrame
    ; LCD on, BG on, OBJ on, tiles @ $8000, map @ $9800.
    ld a, %10010011
    ldh [rLCDC], a
    ld a, 1
    ldh [rIE], a
    xor a
    ldh [rIF], a
    ei
    ; From here the loop reads input every tick, which is the point the
    ; conformance harness can start offering it.
    ld a, 1
    ld [wBooted], a

Main:
    call WaitVBlank
    call UploadFrame
    call ReadInput
    call Tick
    call BuildFrame
    jr Main

WaitLcdOff:
.wait:
    ldh a, [rLY]
    cp 144
    jr c, .wait
    xor a
    ldh [rLCDC], a
    ret

WaitVBlank:
    halt
    ret

; --- initialisation ----------------------------------------------------------

InitVideo:
    ; Tile bank -> VRAM.
    ld a, [H_TILES]
    ld l, a
    ld a, [H_TILES + 1]
    ld h, a
    ld de, VRAM_TILES
    ld a, [H_TILE_COUNT]
    ld c, a
    ld a, [H_TILE_COUNT + 1]
    ld b, a
    ; bc = tiles; byte count = tiles * 16
    sla c
    rl b
    sla c
    rl b
    sla c
    rl b
    sla c
    rl b
    call CopyBytes

    ; Blank the whole 32x32 map so nothing stale shows through.
    ld hl, VRAM_MAP
    ld bc, 32 * 32
.blank:
    ld a, TILE_BLANK
    ld [hl+], a
    dec bc
    ld a, b
    or c
    jr nz, .blank

    ; Shades: 0 lightest through 3 darkest, the same on BG and OBJ.
    ld a, %11100100
    ldh [rBGP], a
    ldh [rOBP0], a
    ldh [rOBP1], a
    xor a
    ldh [rSCX], a
    ldh [rSCY], a

    ; The OAM DMA kernel has to run from HRAM, since DMA holds the main bus.
    ld hl, DmaKernel
    ld de, hDma
    ld bc, DmaKernelEnd - DmaKernel
    call CopyBytes
    ret

DmaKernel:
    ld a, HIGH(wOAM)
    ldh [rDMA], a
    ld a, 40
.spin:
    dec a
    jr nz, .spin
    ret
DmaKernelEnd:

CacheHeader:
    ld hl, H_SCENES
    ld de, wScenesPtr
    ld bc, 14          ; seven pointers, in header order
    call CopyBytes
    ld a, [H_SCENE_COUNT]
    ld [wSceneCount], a
    ld a, [H_INSTANCE_COUNT]
    ld [wInstanceCount], a
    ld a, [H_CONTROL_COUNT]
    ld [wControlCount], a
    ld a, [H_RULE_COUNT]
    ld [wRuleCount], a
    ld a, [H_SCREEN_W]
    ld [wScreenW], a
    ld a, [H_SCREEN_H]
    ld [wScreenH], a
    ld a, [H_FPS]
    ld [wFps], a
    ret

InitState:
    ld hl, wTick
    ld bc, 8
    call ZeroBytes
    ld a, NONE
    ld [wPending], a
    ld hl, H_SEED
    ld de, wRng
    ld bc, 4
    call CopyBytes
    ld a, [H_ENTRY_SCENE]
    ld [wScene], a

    xor a
    ld [wContactN], a
    ld [wContactPrevN], a
    ld [wQueueN], a
    ld hl, wHoldOk
    ld bc, MAX_HOLD
    call ZeroBytes
    ld hl, wReachOk
    ld bc, MAX_RULES
    call ZeroBytes
    ld hl, wUploaded
    ld bc, 32 * VIEW_H
    call ZeroBytes
    xor a
    ld [wPlotN], a
    ld [wPlotPrevN], a

    ; Every entity starts from its instance defaults, not just the entry
    ; scene's: a scene the game has not visited must still read back its
    ; declared values, because a rule may name an object in another scene.
    ld a, [wInstanceCount]
    or a
    ret z
    ld b, a
    xor a
.each:
    push af
    push bc
    call ResetEntity
    pop bc
    pop af
    inc a
    dec b
    jr nz, .each
    ret

; Copy one instance's declared values into its live entity record. A = id.
ResetEntity:
    push af
    call InstancePtr
    ld de, 4
    add hl, de          ; hl -> the instance's value block
    ld b, h
    ld c, l             ; keep it in bc: EntityPtr needs de for its own base
    pop af
    push bc
    call EntityPtr      ; hl -> the live record
    ld d, h
    ld e, l
    pop hl              ; hl -> the declared values
    ld bc, ENTITY_SIZE
    jp CopyBytes

; Reset every entity belonging to scene A.
ResetScene:
    ld [wTmpA], a
    ld a, [wInstanceCount]
    or a
    ret z
    ld b, a
    xor a
    ld [wTmpB], a
.each:
    ld a, [wTmpB]
    call InstancePtr
    ld a, [hl]          ; instance scene
    ld hl, wTmpA
    cp [hl]
    jr nz, .skip
    ld a, [wTmpB]
    push bc
    call ResetEntity
    pop bc
.skip:
    ld a, [wTmpB]
    inc a
    ld [wTmpB], a
    dec b
    jr nz, .each
    ret

; --- pointer helpers ---------------------------------------------------------

; A = entity id -> HL = entity record (id * 36 + wEntities).
EntityPtr:
    ld l, a
    ld h, 0
    add hl, hl          ; 2
    add hl, hl          ; 4
    ld d, h
    ld e, l
    add hl, hl          ; 8
    add hl, hl          ; 16
    add hl, hl          ; 32
    add hl, de          ; 36
    ld de, wEntities
    add hl, de
    ret

; A = instance id -> HL = instance record (id * 40 + table).
InstancePtr:
    ld l, a
    ld h, 0
    add hl, hl          ; 2
    add hl, hl          ; 4
    add hl, hl          ; 8
    ld d, h
    ld e, l
    add hl, hl          ; 16
    add hl, hl          ; 32
    add hl, de          ; 40
    ld a, [wInstancesPtr]
    ld e, a
    ld a, [wInstancesPtr + 1]
    ld d, a
    add hl, de
    ret

; A = scene index -> HL = scene record.
ScenePtr:
    ld l, a
    ld h, 0
    add hl, hl
    add hl, hl
    add hl, hl          ; 8
    ld a, [wScenesPtr]
    ld e, a
    ld a, [wScenesPtr + 1]
    ld d, a
    add hl, de
    ret

; A = rule id -> HL = rule record.
RulePtr:
    ld l, a
    ld h, 0
    add hl, hl
    add hl, hl
    add hl, hl
    add hl, hl          ; 16
    ld a, [wRulesPtr]
    ld e, a
    ld a, [wRulesPtr + 1]
    ld d, a
    add hl, de
    ret

; A = string index -> HL = string body (length byte first).
StringPtr:
    ld l, a
    ld h, 0
    add hl, hl
    ld a, [wStringsPtr]
    ld e, a
    ld a, [wStringsPtr + 1]
    ld d, a
    add hl, de
    ld a, [hl+]
    ld h, [hl]
    ld l, a
    ret

; Copy BC bytes HL -> DE.
CopyBytes:
    ld a, b
    or c
    ret z
.loop:
    ld a, [hl+]
    ld [de], a
    inc de
    dec bc
    ld a, b
    or c
    jr nz, .loop
    ret

; Zero BC bytes at HL.
ZeroBytes:
    ld a, b
    or c
    ret z
.loop:
    xor a
    ld [hl+], a
    dec bc
    ld a, b
    or c
    jr nz, .loop
    ret

; Copy 4 bytes HL -> DE. Unrolled: this is the single most-called routine in the
; engine, and the loop overhead was most of its cost.
Copy32:
    REPT 4
    ld a, [hl+]
    ld [de], a
    inc de
    ENDR
    ret

; Zero seven bytes at HL — the multiply and divide accumulators, which are
; cleared twice per operation and were paying a 16-bit loop counter for it.
Zero7At:
    xor a
    REPT 7
    ld [hl+], a
    ENDR
    ret

INCLUDE "math.inc"
INCLUDE "eval.inc"
INCLUDE "rules.inc"
INCLUDE "render.inc"

; --- the tick ----------------------------------------------------------------
; The order is doc 14 §Runtime model, and it is load-bearing. Tile collision and
; the camera are the two steps this runtime does not have yet; `demake build`
; refuses a game that would need them, so their absence can never be silent.

Tick:
    call ApplyControls
    call ApplyLevelRules
    call Integrate
    call ResolveCollisions
    call ApplyEdgeRules
    call ApplySceneChange
    ld hl, wTick
    inc [hl]
    jr nz, .noCarry
    inc hl
    inc [hl]
.noCarry:
    ld hl, wReady
    inc [hl]
    ret

ApplySceneChange:
    ld a, [wPending]
    cp NONE
    ret z
    ld [wScene], a
    push af
    ld a, NONE
    ld [wPending], a
    pop af
    call ResetScene
    ; A fresh scene replays its draws, and inherits no contact or rule history.
    ld hl, H_SEED
    ld de, wRng
    ld bc, 4
    call CopyBytes
    xor a
    ld [wContactN], a
    ld [wContactPrevN], a
    ld hl, wHoldOk
    ld bc, MAX_HOLD
    call ZeroBytes
    ld hl, wReachOk
    ld bc, MAX_RULES
    call ZeroBytes
    ret

; --- input -------------------------------------------------------------------
; Abstract buttons are bits 0..6 in ACTIONS order: left right up down a b start.

ReadInput:
    ld a, [wHeld]
    ld [wTmpA], a       ; what was held last tick
    ; Direction pad.
    ld a, $20
    ldh [rP1], a
    ldh a, [rP1]
    ldh a, [rP1]
    cpl
    and $0F             ; bit0 right, 1 left, 2 up, 3 down
    ld b, 0
    bit 1, a
    jr z, .noLeft
    set 0, b
.noLeft:
    bit 0, a
    jr z, .noRight
    set 1, b
.noRight:
    bit 2, a
    jr z, .noUp
    set 2, b
.noUp:
    bit 3, a
    jr z, .noDown
    set 3, b
.noDown:
    ; Face buttons.
    ld a, $10
    ldh [rP1], a
    ldh a, [rP1]
    ldh a, [rP1]
    ldh a, [rP1]
    ldh a, [rP1]
    cpl
    and $0F             ; bit0 a, 1 b, 2 select, 3 start
    bit 0, a
    jr z, .noA
    set 4, b
.noA:
    bit 1, a
    jr z, .noB
    set 5, b
.noB:
    bit 3, a
    jr z, .noStart
    set 6, b
.noStart:
    ld a, $30
    ldh [rP1], a

    ld a, b
    ld [wHeld], a
    ld hl, wTmpA
    ; pressed = now & ~before
    ld a, [hl]
    cpl
    and b
    ld [wPressed], a
    ; released = before & ~now
    ld a, b
    cpl
    ld c, a
    ld a, [hl]
    and c
    ld [wReleased], a
    ret

; The game's tables are patched in here. Reserving the space in the image is
; what lets `demake build` — and the web app — produce a ROM without an
; assembler: one blob, one fixed window, one checksum to recompute.
SECTION "Game data", ROM0[DATA_BASE]
    ds DATA_SIZE_RESERVED, 0
