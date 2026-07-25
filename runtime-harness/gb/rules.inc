; The tick's five rule phases, in doc 14 §Runtime model order.
;
; Everything here mirrors packages/demotic/src/sim.ts step for step, including
; the parts that look like details and are not: `hits` fires on entry while
; `touches` fires every tick; separation re-tests after the rule runs, so a ball
; a rule teleported away is not dragged back to the wall it just left; and a
; level rule naming a class runs once per instance with that instance bound as
; the subject.

DEF CONTACT_EDGE   EQU 0
DEF CONTACT_ENTITY EQU 1

; --- rule record access ------------------------------------------------------

; A = rule id. Caches the record pointer for RuleByte / RuleWord.
SelectRule:
    ld [wRuleIdx], a
    call RulePtr
    ld a, l
    ld [wRulePtr], a
    ld a, h
    ld [wRulePtr + 1], a
    ret

; A = field offset -> A = the byte there.
RuleByte:
    ld e, a
    ld d, 0
    ld a, [wRulePtr]
    ld l, a
    ld a, [wRulePtr + 1]
    ld h, a
    add hl, de
    ld a, [hl]
    ret

; A = field offset -> HL = the little-endian word there.
RuleWord:
    ld e, a
    ld d, 0
    ld a, [wRulePtr]
    ld l, a
    ld a, [wRulePtr + 1]
    ld h, a
    add hl, de
    ld a, [hl+]
    ld h, [hl]
    ld l, a
    ret

; Z set when the selected rule belongs to another scene.
RuleActive:
    ld a, 1
    call RuleByte
    cp NONE
    jr z, .yes
    ld hl, wScene
    cp [hl]
    jr z, .yes
    xor a
    ret
.yes:
    ld a, 1
    or a
    ret

; --- subject binding ---------------------------------------------------------
; A rule naming a class runs once per instance of it, each bound as the subject;
; everything else runs once with nothing bound.

SubjectBegin:
    ld a, 8
    call RuleWord
    ld a, h
    or l
    jr z, .single
    ld a, 1
    ld [wSubjMode], a
    ld a, [hl+]
    ld [wSubjLeft], a
    ld a, l
    ld [wSubjPtr], a
    ld a, h
    ld [wSubjPtr + 1], a
    ret
.single:
    xor a
    ld [wSubjMode], a
    inc a
    ld [wSubjLeft], a
    ret

; Carry set when a subject is bound in wSubject; clear when the rule is done.
SubjectNext:
    ld a, [wSubjMode]
    or a
    jr nz, .list
    ld a, [wSubjLeft]
    or a
    jr z, .done
    xor a
    ld [wSubjLeft], a
    ld a, NONE
    ld [wSubject], a
    ld [wOther], a
    scf
    ret
.list:
    ld a, [wSubjLeft]
    or a
    jr z, .done
    dec a
    ld [wSubjLeft], a
    ld a, [wSubjPtr]
    ld l, a
    ld a, [wSubjPtr + 1]
    ld h, a
    ld a, [hl+]
    ld b, a
    ld a, l
    ld [wSubjPtr], a
    ld a, h
    ld [wSubjPtr + 1], a
    ld a, b
    push bc
    call IsPlayable
    pop bc
    jr z, .list
    ld a, b
    ld [wSubject], a
    ld a, NONE
    ld [wOther], a
    scf
    ret
.done:
    or a
    ret

; --- firing ------------------------------------------------------------------

; A = 1 when the trigger fired. Applies the rule's assignments when it fired and
; its guard held, and its `else` when it was evaluated and did not.
FireRule:
    ld [wFired], a
    or a
    jr z, .otherwise
    ld a, 2
    call RuleWord
    ld a, h
    or l
    jr z, .passed
    call Eval
    call IsZeroN0
    jr z, .otherwise
.passed:
    ld a, 4
    call RuleWord
    jp ApplyAssignments
.otherwise:
    ld a, 6
    call RuleWord
    jp ApplyAssignments

; HL = assignment list (zero for none). Every value is evaluated against the
; pre-rule state and the writes land together, so a rule that reads what it also
; writes sees consistent inputs.
ApplyAssignments:
    ld a, h
    or l
    ret z
    ld a, [hl+]
    ld [wAsgN], a
    or a
    ret z
    cp MAX_ASSIGN + 1
    jr c, .sized
    ld a, MAX_ASSIGN
    ld [wAsgN], a
.sized:
    ld a, l
    ld [wAsgPtr], a
    ld a, h
    ld [wAsgPtr + 1], a
    xor a
    ld [wAsgIdx], a

.evaluatePhase:
    ld a, [wAsgIdx]
    ld hl, wAsgN
    cp [hl]
    jr z, .writePhase
    call AssignRecord
    ld a, [hl+]
    ld [wAsgKind], a
    ld a, [hl+]
    ld [wAsgRef], a
    ld a, [hl+]
    ld [wAsgEnt], a
    ld a, [hl+]
    ld [wAsgProp], a
    ld a, [hl+]
    ld [wAsgVal], a
    ld a, [hl]
    ld [wAsgVal + 1], a

    ld a, [wAsgKind]
    cp ASSIGN_SCENE
    jr nz, .propTarget
    ld a, [wAsgProp]
    ld [wPending], a
    ld a, NONE
    call StoreWriteTarget
    jr .advance
.propTarget:
    ld a, [wAsgEnt]
    ld b, a
    ld a, [wAsgRef]
    call ResolveRef
    ld [wAsgEnt], a
    cp NONE
    jr nz, .bound
    call StoreWriteTarget
    jr .advance
.bound:
    ld a, [wAsgKind]
    cp ASSIGN_FLIP
    jr nz, .evaluate
    ld a, [wAsgProp]
    ld b, a
    ld a, [wAsgEnt]
    call GetProp
    call Neg32
    jr .keep
.evaluate:
    ld a, [wAsgVal]
    ld l, a
    ld a, [wAsgVal + 1]
    ld h, a
    call Eval
.keep:
    ld a, [wAsgEnt]
    call StoreWriteTarget
    call StoreWriteValue
.advance:
    ld hl, wAsgIdx
    inc [hl]
    jr .evaluatePhase

.writePhase:
    xor a
    ld [wAsgIdx], a
.write:
    ld a, [wAsgIdx]
    ld hl, wAsgN
    cp [hl]
    ret z
    ld a, [wAsgIdx]
    ld d, 0
    ld e, a
    ld hl, wWriteEnt
    add hl, de
    ld a, [hl]
    cp NONE
    jr z, .skip
    ld [wAsgEnt], a
    ld hl, wWriteProp
    add hl, de
    ld a, [hl]
    ld [wAsgProp], a
    ld a, [wAsgIdx]
    call WriteValueSlot
    ld de, wN0
    call Copy32
    ld a, [wAsgProp]
    ld b, a
    ld a, [wAsgEnt]
    call SetProp
.skip:
    ld hl, wAsgIdx
    inc [hl]
    jr .write

; HL = the assignment record at wAsgIdx.
AssignRecord:
    ld a, [wAsgIdx]
    ld l, a
    ld h, 0
    ld d, h
    ld e, l
    add hl, hl          ; 2
    add hl, de          ; 3
    add hl, hl          ; 6
    ld a, [wAsgPtr]
    ld e, a
    ld a, [wAsgPtr + 1]
    ld d, a
    add hl, de
    ret

; A = entity (or NONE). Also records the property, which is already resolved.
StoreWriteTarget:
    ld b, a
    ld a, [wAsgIdx]
    ld d, 0
    ld e, a
    ld hl, wWriteEnt
    add hl, de
    ld [hl], b
    ld hl, wWriteProp
    add hl, de
    ld a, [wAsgProp]
    ld [hl], a
    ret

; Stash wN0 in the pending-write slot for wAsgIdx.
StoreWriteValue:
    ld a, [wAsgIdx]
    call WriteValueSlot
    ld d, h
    ld e, l
    ld hl, wN0
    jp Copy32

; A = index -> HL = the four-byte pending-value slot.
WriteValueSlot:
    ld l, a
    ld h, 0
    add hl, hl
    add hl, hl
    ld de, wWriteVal
    add hl, de
    ret

; --- scene instance iteration ------------------------------------------------

SceneInstancesBegin:
    ld a, [wScene]
    call ScenePtr
    ld a, [hl+]
    ld [wTmpA], a       ; first index into the shared list
    ld a, [hl]
    ld [wListLeft], a
    ld a, [wSceneInstsPtr]
    ld l, a
    ld a, [wSceneInstsPtr + 1]
    ld h, a
    ld a, [wTmpA]
    ld d, 0
    ld e, a
    add hl, de
    ld a, l
    ld [wListPtr], a
    ld a, h
    ld [wListPtr + 1], a
    ret

; Carry set with the next instance id in A.
SceneInstanceNext:
    ld a, [wListLeft]
    or a
    jr z, .done
    dec a
    ld [wListLeft], a
    ld a, [wListPtr]
    ld l, a
    ld a, [wListPtr + 1]
    ld h, a
    ld a, [hl+]
    ld b, a
    ld a, l
    ld [wListPtr], a
    ld a, h
    ld [wListPtr + 1], a
    ld a, b
    scf
    ret
.done:
    or a
    ret

; --- 2. controls -------------------------------------------------------------

ApplyControls:
    ld a, [wControlCount]
    or a
    ret z
    xor a
    ld [wLoopI], a
.loop:
    ld a, [wLoopI]
    call ControlPtr
    ; The binding is inert unless its object is in the running scene.
    ld a, [hl]
    ld [wEntId], a
    push hl
    call InstancePtr
    ld a, [hl]
    ld hl, wScene
    cp [hl]
    pop hl
    jr nz, .next
    inc hl
    ld a, [hl+]
    ld [wCtlAction], a
    ld a, [hl+]
    ld [wCtlMode], a
    ld a, [hl+]
    ld [wCtlHold], a
    ld a, [hl+]
    ld [wCtlList], a
    ld a, [hl]
    ld [wCtlList + 1], a

    ; The subject of a control is its own object.
    ld a, [wEntId]
    ld [wSubject], a
    ld a, NONE
    ld [wOther], a

    ld a, [wCtlMode]
    cp MODE_PRESS
    jr z, .onPress
    cp MODE_RELEASE
    jr z, .onRelease

    ; on hold: snapshot on the press, apply while down, restore on the release.
    call ActionPressed
    jr z, .notPressed
    call SnapshotHold
.notPressed:
    call ActionHeld
    jr z, .notHeld
    call RunControlAssignments
.notHeld:
    call ActionReleased
    jr z, .next
    call RestoreHold
    jr .next

.onPress:
    call ActionPressed
    jr z, .next
    call RunControlAssignments
    jr .next
.onRelease:
    call ActionReleased
    jr z, .next
    call RunControlAssignments
.next:
    ld hl, wLoopI
    inc [hl]
    ld a, [wControlCount]
    ld hl, wLoopI
    cp [hl]
    jr nz, .loop
    ret

; A = control index -> HL = control record.
ControlPtr:
    ld l, a
    ld h, 0
    add hl, hl
    add hl, hl
    add hl, hl
    ld a, [wControlsPtr]
    ld e, a
    ld a, [wControlsPtr + 1]
    ld d, a
    add hl, de
    ret

RunControlAssignments:
    ld a, [wCtlList]
    ld l, a
    ld a, [wCtlList + 1]
    ld h, a
    jp ApplyAssignments

; NZ when the control's action is in the given input set.
ActionHeld:
    ld a, [wHeld]
    jr TestAction
ActionPressed:
    ld a, [wPressed]
    jr TestAction
ActionReleased:
    ld a, [wReleased]
TestAction:
    ld b, a
    ld a, [wCtlAction]
    ld c, a
    inc c
    ld a, b
.shift:
    dec c
    jr z, .test
    rra
    jr .shift
.test:
    and 1
    ret

; `on hold` restores the property when the button comes up. Snapshots are per
; binding, not per property, so overlapping holds unwind in reverse order —
; press left, press right, release right, and the paddle goes back to left.
SnapshotHold:
    ld a, [wCtlList]
    ld l, a
    ld a, [wCtlList + 1]
    ld h, a
    ld a, h
    or l
    ret z
    ld a, [hl+]
    ld [wAsgN], a
    or a
    ret z
    ld a, l
    ld [wAsgPtr], a
    ld a, h
    ld [wAsgPtr + 1], a
    xor a
    ld [wAsgIdx], a
.loop:
    ld a, [wAsgIdx]
    ld hl, wAsgN
    cp [hl]
    ret z
    call AssignRecord
    ld a, [hl+]
    ld [wAsgKind], a
    ld a, [hl+]
    ld [wAsgRef], a
    ld a, [hl+]
    ld [wAsgEnt], a
    ld a, [hl]
    ld [wAsgProp], a
    ld a, [wAsgKind]
    cp ASSIGN_SCENE
    jr z, .skip
    ld a, [wAsgEnt]
    ld b, a
    ld a, [wAsgRef]
    call ResolveRef
    cp NONE
    jr nz, .haveEntity
    ld a, [wEntId]
.haveEntity:
    ld [wAsgEnt], a
    ld b, a
    ld a, [wAsgProp]
    ld c, a
    ld a, b
    ld b, c
    call GetProp
    call HoldSlot
    ld d, h
    ld e, l
    ld hl, wN0
    call Copy32
    call HoldFlag
    ld [hl], 1
.skip:
    ld hl, wAsgIdx
    inc [hl]
    jr .loop

RestoreHold:
    ld a, [wCtlList]
    ld l, a
    ld a, [wCtlList + 1]
    ld h, a
    ld a, h
    or l
    ret z
    ld a, [hl+]
    ld [wAsgN], a
    or a
    ret z
    ld a, l
    ld [wAsgPtr], a
    ld a, h
    ld [wAsgPtr + 1], a
    xor a
    ld [wAsgIdx], a
.loop:
    ld a, [wAsgIdx]
    ld hl, wAsgN
    cp [hl]
    ret z
    call AssignRecord
    ld a, [hl+]
    ld [wAsgKind], a
    ld a, [hl+]
    ld [wAsgRef], a
    ld a, [hl+]
    ld [wAsgEnt], a
    ld a, [hl]
    ld [wAsgProp], a
    ld a, [wAsgKind]
    cp ASSIGN_SCENE
    jr z, .skip
    call HoldFlag
    ld a, [hl]
    or a
    jr z, .skip
    ld [hl], 0
    ld a, [wAsgEnt]
    ld b, a
    ld a, [wAsgRef]
    call ResolveRef
    cp NONE
    jr nz, .haveEntity
    ld a, [wEntId]
.haveEntity:
    ld [wAsgEnt], a
    call HoldSlot
    ld de, wN0
    call Copy32
    ld a, [wAsgProp]
    ld b, a
    ld a, [wAsgEnt]
    call SetProp
.skip:
    ld hl, wAsgIdx
    inc [hl]
    jr .loop

; HL = the four-byte snapshot slot for this binding's current assignment.
HoldSlot:
    ld a, [wCtlHold]
    ld hl, wAsgIdx
    add [hl]
    ld l, a
    ld h, 0
    add hl, hl
    add hl, hl
    ld de, wHoldVal
    add hl, de
    ret

; HL = the validity byte for the same slot.
HoldFlag:
    ld a, [wCtlHold]
    ld hl, wAsgIdx
    add [hl]
    ld l, a
    ld h, 0
    ld de, wHoldOk
    add hl, de
    ret

; --- 3. level rules ----------------------------------------------------------

ApplyLevelRules:
    ld a, [wRuleCount]
    or a
    ret z
    xor a
    ld [wLoopI], a
.loop:
    ld a, [wLoopI]
    call SelectRule
    xor a
    call RuleByte
    cp RULE_PREDICATE
    jr nz, .next
    call RuleActive
    jr z, .next
    call SubjectBegin
.subject:
    call SubjectNext
    jr nc, .next
    ld a, 10
    call RuleWord
    call Eval
    call IsZeroN0
    ld a, 0
    jr z, .fire
    inc a
.fire:
    call FireRule
    jr .subject
.next:
    ld hl, wLoopI
    inc [hl]
    ld a, [wRuleCount]
    ld hl, wLoopI
    cp [hl]
    jr nz, .loop
    ret

; --- 4. integration ----------------------------------------------------------
; direction x speed / fps, floored, in that order. Speeds are authored per
; second precisely so the frame rate enters here and nowhere else.

Integrate:
    call SceneInstancesBegin
.loop:
    call SceneInstanceNext
    ret nc
    ld [wEntId], a
    ld b, P_SPEED
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
    ld b, P_VIS
    ld de, wT1
    call LoadStoredProp
    ld a, [wT1]
    ld hl, wT1 + 1
    or [hl]
    inc hl
    or [hl]
    inc hl
    or [hl]
    jr z, .loop

    ld a, P_XDIR
    ld [wTmpA], a
    ld a, P_X
    ld [wTmpB], a
    call StepAxis
    ld a, P_YDIR
    ld [wTmpA], a
    ld a, P_Y
    ld [wTmpB], a
    call StepAxis
    jr .loop

StepAxis:
    ld a, [wEntId]
    ld b, a
    ld a, [wTmpA]
    ld c, a
    ld a, b
    ld b, c
    ld de, wN0
    call LoadStoredProp     ; direction
    ld hl, wT0
    ld de, wN1
    call Copy32             ; speed
    call Mul32              ; velocity
    ; wN1 = fromInt(fps)
    xor a
    ld [wN1], a
    ld [wN1 + 1], a
    ld [wN1 + 3], a
    ld a, [wFps]
    ld [wN1 + 2], a
    call Div32              ; per-tick step
    call IsZeroN0
    ret z
    ld hl, wN0
    ld de, wN1
    call Copy32
    ld a, [wEntId]
    ld b, a
    ld a, [wTmpB]
    ld c, a
    ld a, b
    ld b, c
    ld de, wN0
    call LoadStoredProp     ; the axis position
    call Add32
    ld a, [wTmpB]
    ld b, a
    ld a, [wEntId]
    jp SetProp

; --- 5. collisions -----------------------------------------------------------

ResolveCollisions:
    xor a
    ld [wContactN], a
    ld a, [wRuleCount]
    or a
    jp z, ContactsCommit
    xor a
    ld [wLoopI], a
.ruleLoop:
    ld a, [wLoopI]
    call SelectRule
    xor a
    call RuleByte
    cp RULE_HITS
    jp nz, .nextRule
    call RuleActive
    jp z, .nextRule
    ld a, 12
    call RuleWord
    ld a, l
    ld [wLevelFlag], a
    ld a, 10
    call RuleWord
    ; payload: nSubjects, ids, nOthers, ids, nEdges, ids, nTiles, ids
    ld a, [hl+]
    ld [wNSub], a
    ld a, l
    ld [wPSub], a
    ld a, h
    ld [wPSub + 1], a
    ld a, [wNSub]
    ld d, 0
    ld e, a
    add hl, de
    ld a, [hl+]
    ld [wNOth], a
    ld a, l
    ld [wPOth], a
    ld a, h
    ld [wPOth + 1], a
    ld a, [wNOth]
    ld d, 0
    ld e, a
    add hl, de
    ld a, [hl+]
    ld [wNEdge], a
    ld a, l
    ld [wPEdge], a
    ld a, h
    ld [wPEdge + 1], a

    xor a
    ld [wLoopJ], a
.subjectLoop:
    ld a, [wLoopJ]
    ld hl, wNSub
    cp [hl]
    jp z, .nextRule
    ld a, [wPSub]
    ld l, a
    ld a, [wPSub + 1]
    ld h, a
    ld a, [wLoopJ]
    ld d, 0
    ld e, a
    add hl, de
    ld a, [hl]
    ld [wSubject], a
    call IsPlayable
    jp z, .nextSubject
    ld a, NONE
    ld [wOther], a

    ; --- edges
    xor a
    ld [wLoopK], a
.edgeLoop:
    ld a, [wLoopK]
    ld hl, wNEdge
    cp [hl]
    jr z, .others
    ld a, [wPEdge]
    ld l, a
    ld a, [wPEdge + 1]
    ld h, a
    ld a, [wLoopK]
    ld d, 0
    ld e, a
    add hl, de
    ld a, [hl]
    ld [wEdge], a
    call TouchesEdge
    jr z, .nextEdge
    ld a, CONTACT_EDGE
    ld [wQuery + 2], a
    ld a, [wEdge]
    ld [wQuery + 3], a
    call QueryKey
    ld a, [wLevelFlag]
    or a
    jr nz, .fireEdge
    call ContactSeen
    jr z, .separateEdge
.fireEdge:
    ld a, 1
    call FireRule
.separateEdge:
    call TouchesEdge
    jr z, .nextEdge
    call SeparateEdge
    call ContactAdd
.nextEdge:
    ld hl, wLoopK
    inc [hl]
    jr .edgeLoop

    ; --- other objects
.others:
    xor a
    ld [wLoopK], a
.otherLoop:
    ld a, [wLoopK]
    ld hl, wNOth
    cp [hl]
    jr z, .nextSubject
    ld a, [wPOth]
    ld l, a
    ld a, [wPOth + 1]
    ld h, a
    ld a, [wLoopK]
    ld d, 0
    ld e, a
    add hl, de
    ld a, [hl]
    ld hl, wSubject
    cp [hl]
    jr z, .nextOther
    ld [wOther], a
    call IsPlayable
    jr z, .nextOther
    call Overlapping
    jr z, .nextOther
    ld a, CONTACT_ENTITY
    ld [wQuery + 2], a
    ld a, [wOther]
    ld [wQuery + 3], a
    call QueryKey
    ld a, [wLevelFlag]
    or a
    jr nz, .fireOther
    call ContactSeen
    jr z, .separateOther
.fireOther:
    ld a, 1
    call FireRule
.separateOther:
    call Overlapping
    jr z, .nextOther
    call SeparateEntity
    call ContactAdd
.nextOther:
    ld hl, wLoopK
    inc [hl]
    jr .otherLoop

.nextSubject:
    ld a, NONE
    ld [wOther], a
    ld hl, wLoopJ
    inc [hl]
    jp .subjectLoop

.nextRule:
    ld hl, wLoopI
    inc [hl]
    ld a, [wRuleCount]
    ld hl, wLoopI
    cp [hl]
    jp nz, .ruleLoop
    jp ContactsCommit

QueryKey:
    ld a, [wRuleIdx]
    ld [wQuery], a
    ld a, [wSubject]
    ld [wQuery + 1], a
    ret

; Z set when the same contact existed at the end of the previous tick — which
; is exactly what makes `hits` an entry event and `touches` a level one.
ContactSeen:
    ld a, [wContactPrevN]
    or a
    jr z, .absent
    ld b, a
    ld hl, wContactsPrev
.scan:
    ld a, [wQuery]
    cp [hl]
    jr nz, .step
    inc hl
    ld a, [wQuery + 1]
    cp [hl]
    dec hl
    jr nz, .step
    push hl
    inc hl
    inc hl
    ld a, [wQuery + 2]
    cp [hl]
    jr nz, .stepPop
    inc hl
    ld a, [wQuery + 3]
    cp [hl]
    jr nz, .stepPop
    pop hl
    xor a
    ret
.stepPop:
    pop hl
.step:
    ld de, 4
    add hl, de
    dec b
    jr nz, .scan
.absent:
    ld a, 1
    or a
    ret

ContactAdd:
    ld a, [wContactN]
    cp MAX_CONTACTS
    ret nc
    ld l, a
    ld h, 0
    add hl, hl
    add hl, hl
    ld de, wContacts
    add hl, de
    ld d, h
    ld e, l
    ld hl, wQuery
    ld b, 4
.copy:
    ld a, [hl+]
    ld [de], a
    inc de
    dec b
    jr nz, .copy
    ld hl, wContactN
    inc [hl]
    ret

ContactsCommit:
    ; Only the live entries, not the whole table: a game with two contacts was
    ; paying for ninety-six of them every tick.
    ld a, [wContactN]
    ld [wContactPrevN], a
    or a
    ret z
    ld l, a
    ld h, 0
    add hl, hl
    add hl, hl
    ld b, h
    ld c, l
    ld hl, wContacts
    ld de, wContactsPrev
    jp CopyBytes

; --- geometry ----------------------------------------------------------------

; wT0 = property `B` of wSubject; wT1 likewise, for the four-way box tests.
LoadSubject:
    ld a, [wSubject]
    jp LoadStoredProp

; NZ when wSubject touches edge wTmpA. Edge order is EDGES: left right top
; bottom, and the tests are the interpreter's, half-open on the far side.
TouchesEdge:
    ld a, [wEdge]
    or a
    jr z, .left
    dec a
    jr z, .right
    dec a
    jr z, .top
.bottom:
    ld b, P_Y
    ld de, wN0
    call LoadSubject
    ld b, P_H
    ld de, wN1
    call LoadSubject
    call Add32
    ld a, [wScreenH]
    call LoadScreenN1
    jr .greaterEqual
.top:
    ld b, P_Y
    ld de, wN0
    call LoadSubject
    jr .lessEqualZero
.left:
    ld b, P_X
    ld de, wN0
    call LoadSubject
.lessEqualZero:
    call ZeroN1
    call Cmp32
    cp 1
    jr z, .no
    jr .yes
.right:
    ld b, P_X
    ld de, wN0
    call LoadSubject
    ld b, P_W
    ld de, wN1
    call LoadSubject
    call Add32
    ld a, [wScreenW]
    call LoadScreenN1
.greaterEqual:
    call Cmp32
    cp $FF
    jr z, .no
.yes:
    ld a, 1
    or a
    ret
.no:
    xor a
    ret

; A = a cell count -> wN1 = that many cells in 16.16.
LoadScreenN1:
    ld b, a
    xor a
    ld [wN1], a
    ld [wN1 + 1], a
    ld [wN1 + 3], a
    ld a, b
    ld [wN1 + 2], a
    ret

ZeroN1:
    xor a
    ld [wN1], a
    ld [wN1 + 1], a
    ld [wN1 + 2], a
    ld [wN1 + 3], a
    ret

SeparateEdge:
    ld a, [wEdge]
    or a
    jr z, .left
    dec a
    jr z, .right
    dec a
    jr z, .top
    ; bottom: y = screenHeight - height
    ld a, [wScreenH]
    call LoadScreenN1
    ld hl, wN1
    ld de, wN0
    call Copy32
    ld b, P_H
    ld de, wN1
    call LoadSubject
    call Sub32
    ld b, P_Y
    jr .store
.top:
    call ZeroN1
    ld hl, wN1
    ld de, wN0
    call Copy32
    ld b, P_Y
    jr .store
.left:
    call ZeroN1
    ld hl, wN1
    ld de, wN0
    call Copy32
    ld b, P_X
    jr .store
.right:
    ld a, [wScreenW]
    call LoadScreenN1
    ld hl, wN1
    ld de, wN0
    call Copy32
    ld b, P_W
    ld de, wN1
    call LoadSubject
    call Sub32
    ld b, P_X
.store:
    ld a, b
    ld [wTmpB], a
    ld a, [wSubject]
    ld b, 0
    ld c, a
    ld a, [wTmpB]
    ld b, a
    ld a, c
    jp SetProp

; NZ when wSubject and wOther overlap. Half-open on both axes, so an object
; resting against another is touching it and not inside it.
Overlapping:
    ld a, P_X
    ld [wTmpB], a
    ld a, P_W
    ld [wTmpC], a
    call AxisOverlap
    jr z, .no
    ld a, P_Y
    ld [wTmpB], a
    ld a, P_H
    ld [wTmpC], a
    call AxisOverlap
    jr z, .no
    ld a, 1
    or a
    ret
.no:
    xor a
    ret

; NZ when the subject's and other's spans overlap on the axis in wTmpB/wTmpC.
AxisOverlap:
    ; subject.pos < other.pos + other.size
    ld a, [wTmpB]
    ld b, a
    ld de, wN0
    call LoadSubject
    ld a, [wOther]
    ld b, a
    ld a, [wTmpB]
    ld c, a
    ld a, b
    ld b, c
    ld de, wN1
    call LoadStoredProp
    ld hl, wN1
    ld de, wE0
    call Copy32
    ld a, [wOther]
    ld b, a
    ld a, [wTmpC]
    ld c, a
    ld a, b
    ld b, c
    ld de, wE1
    call LoadStoredProp
    ld hl, wE0
    ld de, wN0
    call Copy32
    ld hl, wE1
    ld de, wN1
    call Copy32
    call Add32
    ld hl, wN0
    ld de, wE2
    call Copy32             ; other.pos + other.size
    ld a, [wTmpB]
    ld b, a
    ld de, wN0
    call LoadSubject
    ld hl, wE2
    ld de, wN1
    call Copy32
    call Cmp32
    cp $FF
    jr nz, .no
    ; subject.pos + subject.size > other.pos
    ld a, [wTmpB]
    ld b, a
    ld de, wN0
    call LoadSubject
    ld a, [wTmpC]
    ld b, a
    ld de, wN1
    call LoadSubject
    call Add32
    ld hl, wE0
    ld de, wN1
    call Copy32
    call Cmp32
    cp 1
    jr nz, .no
    ld a, 1
    or a
    ret
.no:
    xor a
    ret

; Push the subject clear along the axis of least penetration, the same rule the
; interpreter uses: resolving the deeper axis would teleport a walking object
; over something it merely brushed.
SeparateEntity:
    ; wE0 = overlapLeft  = s.x + s.w - o.x      (push -left)
    ; wE1 = overlapRight = o.x + o.w - s.x
    ld a, P_X
    ld [wTmpB], a
    ld a, P_W
    ld [wTmpC], a
    call AxisPush           ; -> wE2 = chosen x push
    ld hl, wE2
    ld de, wE3
    call Copy32
    ld a, P_Y
    ld [wTmpB], a
    ld a, P_H
    ld [wTmpC], a
    call AxisPush           ; -> wE2 = chosen y push
    ; |xPush| < |yPush| ?
    ld hl, wE3
    ld de, wN0
    call Copy32
    call AbsN0
    ld hl, wE2
    ld de, wN1
    call Copy32
    ld hl, wN1
    call AbsAt
    call Cmp32
    cp $FF
    jr z, .useX
    ; y
    ld a, P_Y
    ld [wTmpB], a
    ld hl, wE2
    ld de, wN1
    call Copy32
    jr .apply
.useX:
    ld a, P_X
    ld [wTmpB], a
    ld hl, wE3
    ld de, wN1
    call Copy32
.apply:
    ld hl, wN1
    ld de, wE0
    call Copy32
    ld a, [wTmpB]
    ld b, a
    ld de, wN0
    call LoadSubject
    ld hl, wE0
    ld de, wN1
    call Copy32
    call Add32
    ld a, [wTmpB]
    ld b, a
    ld a, [wSubject]
    jp SetProp

; wE2 = the push along the axis in wTmpB/wTmpC, signed.
AxisPush:
    ; near = subject.pos + subject.size - other.pos
    ld a, [wTmpB]
    ld b, a
    ld de, wN0
    call LoadSubject
    ld a, [wTmpC]
    ld b, a
    ld de, wN1
    call LoadSubject
    call Add32
    ld a, [wOther]
    ld b, a
    ld a, [wTmpB]
    ld c, a
    ld a, b
    ld b, c
    ld de, wN1
    call LoadStoredProp
    call Sub32
    ld hl, wN0
    ld de, wE0
    call Copy32
    ; far = other.pos + other.size - subject.pos
    ld a, [wOther]
    ld b, a
    ld a, [wTmpB]
    ld c, a
    ld a, b
    ld b, c
    ld de, wN0
    call LoadStoredProp
    ld a, [wOther]
    ld b, a
    ld a, [wTmpC]
    ld c, a
    ld a, b
    ld b, c
    ld de, wN1
    call LoadStoredProp
    call Add32
    ld a, [wTmpB]
    ld b, a
    ld de, wN1
    call LoadSubject
    call Sub32
    ld hl, wN0
    ld de, wE1
    call Copy32
    ; push = near < far ? -near : far
    ld hl, wE0
    ld de, wN0
    call Copy32
    ld hl, wE1
    ld de, wN1
    call Copy32
    call Cmp32
    cp $FF
    jr z, .takeNear
    ld hl, wE1
    ld de, wE2
    jp Copy32
.takeNear:
    ld hl, wE0
    ld de, wE2
    call Copy32
    ld hl, wE2
    jp Neg32At

AbsN0:
    ld hl, wN0
AbsAt:
    push hl
    ld de, 3
    add hl, de
    bit 7, [hl]
    pop hl
    ret z
    jp Neg32At

; --- 7. edge rules -----------------------------------------------------------

ApplyEdgeRules:
    ld a, [wRuleCount]
    or a
    ret z
    xor a
    ld [wLoopI], a
.loop:
    ld a, [wLoopI]
    call SelectRule
    xor a
    call RuleByte
    cp RULE_INPUT
    jr z, .input
    cp RULE_REACHES
    jp z, .reaches
    jp .next
.input:
    call RuleActive
    jp z, .next
    ld a, 10
    call RuleWord
    ld a, l
    ld [wCtlAction], a      ; the button TestAction examines
    ld a, 12
    call RuleWord
    ld a, l
    or a
    jr nz, .released
    call ActionPressed
    jr .haveEdge
.released:
    call ActionReleased
.haveEdge:
    ld a, 0
    jr z, .noEdge
    inc a
.noEdge:
    ld [wFired], a
    ; An unguarded input rule only has something to say when the edge happens;
    ; a guarded one is evaluated every tick so its `else` can run.
    ld a, 2
    call RuleWord
    ld a, h
    or l
    jr nz, .runInput
    ld a, [wFired]
    or a
    jp z, .next
.runInput:
    call SubjectBegin
.inputSubject:
    call SubjectNext
    jp nc, .next
    ld a, [wFired]
    call FireRule
    jr .inputSubject

.reaches:
    call RuleActive
    jp z, .next
    ld a, NONE
    ld [wSubject], a
    ld [wOther], a
    ld a, 10
    call RuleWord
    call Eval
    ld hl, wN0
    ld de, wE0
    call Copy32
    ld a, 12
    call RuleWord
    call Eval
    ld hl, wN0
    ld de, wN1
    call Copy32
    ld hl, wE0
    ld de, wN0
    call Copy32
    call Sub32              ; delta
    ld hl, wN0
    ld de, wE0
    call Copy32
    ; previous delta, then remember this one either way
    call ReachFlag
    ld a, [hl]
    ld [wTmpB], a
    ld [hl], 1
    call ReachSlot
    ld de, wE1
    call Copy32             ; previous
    call ReachSlot
    ld d, h
    ld e, l
    ld hl, wE0
    call Copy32
    ld a, [wTmpB]
    or a
    jp z, .next             ; no history: a value that starts on its target
                            ; has not *reached* it
    ; landed = delta == 0 && previous != 0
    ; crossed = previous != 0 && delta != 0 && the sign changed
    ld hl, wE1
    ld de, wN0
    call Copy32
    call IsZeroN0
    ld a, 0
    jp z, .decided          ; previous was zero: neither landed nor crossed
    ld hl, wE0
    ld de, wN0
    call Copy32
    call IsZeroN0
    jr nz, .bothNonZero
    ld a, 1                 ; landed
    jr .decided
.bothNonZero:
    ld a, [wE0 + 3]
    ld b, a
    ld a, [wE1 + 3]
    xor b
    and $80
    jr z, .noCross
    ld a, 1
    jr .decided
.noCross:
    xor a
.decided:
    ld [wFired], a
    or a
    jr nz, .runReaches
    ld a, 2
    call RuleWord
    ld a, h
    or l
    jp z, .next
.runReaches:
    call SubjectBegin
.reachSubject:
    call SubjectNext
    jr nc, .next
    ld a, [wFired]
    call FireRule
    jr .reachSubject

.next:
    ld hl, wLoopI
    inc [hl]
    ld a, [wRuleCount]
    ld hl, wLoopI
    cp [hl]
    jp nz, .loop
    ret

ReachSlot:
    ld a, [wRuleIdx]
    ld l, a
    ld h, 0
    add hl, hl
    add hl, hl
    ld de, wReachVal
    add hl, de
    ret

ReachFlag:
    ld a, [wRuleIdx]
    ld l, a
    ld h, 0
    ld de, wReachOk
    add hl, de
    ret
