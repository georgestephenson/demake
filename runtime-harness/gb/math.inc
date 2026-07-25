; 16.16 fixed-point arithmetic, the substrate the whole language runs on.
;
; Every routine here has a counterpart in packages/demotic/src/fixed.ts, and the
; pairing is exact by necessity: a one-bit disagreement in a velocity compounds
; into a visibly different game a thousand ticks later, which is precisely what
; the trace oracle exists to catch. In particular **rounding is floor, toward
; negative infinity, everywhere** — which is what an arithmetic shift already
; does, so it is the cheap rule as well as the stated one.
;
; Values are four-byte little-endian two's complement, clamped to +/-1024 cells
; (0x04000000). That bound is not cosmetic: it keeps a product inside the 56-bit
; accumulator below, so a multiply never silently loses a bit.

DEF FIXED_MAX_HI EQU $04     ; 0x04000000 == 1024.0
DEF FIXED_MIN_HI EQU $FC     ; 0xFC000000 == -1024.0

; wN0 += wN1
Add32:
    ld hl, wN1
    ld de, wN0
    or a
    ld b, 4
.loop:
    ld a, [de]
    adc a, [hl]
    ld [de], a
    inc hl
    inc de
    dec b
    jr nz, .loop
    ret

; wN0 -= wN1
Sub32:
    ld hl, wN1
    ld de, wN0
    or a
    ld b, 4
.loop:
    ld a, [de]
    sbc a, [hl]
    ld [de], a
    inc hl
    inc de
    dec b
    jr nz, .loop
    ret

; HL -> a four-byte value; negate it in place.
Neg32At:
    or a
    ld b, 4
.loop:
    ld a, 0
    sbc a, [hl]
    ld [hl+], a
    dec b
    jr nz, .loop
    ret

Neg32:
    ld hl, wN0
    jr Neg32At

; Z set when wN0 is zero.
IsZeroN0:
    ld a, [wN0]
    ld hl, wN0 + 1
    or [hl]
    inc hl
    or [hl]
    inc hl
    or [hl]
    ret

; Z set when wN1 is zero.
IsZeroN1:
    ld a, [wN1]
    ld hl, wN1 + 1
    or [hl]
    inc hl
    or [hl]
    inc hl
    or [hl]
    ret

; A = 0 when wN0 == wN1, 1 when greater, $FF when less. Signed, and exact:
; the clamped range keeps the difference inside 32 bits, so there is no overflow
; case to reason about.
Cmp32:
    ld hl, wN1
    ld de, wN0
    ld bc, wN2
    or a
    REPT 4
    ld a, [de]
    sbc a, [hl]
    ld [bc], a
    inc hl
    inc de
    inc bc
    ENDR
    ld a, [wN2]
    ld hl, wN2 + 1
    or [hl]
    inc hl
    or [hl]
    inc hl
    or [hl]
    jr z, .equal
    ld a, [wN2 + 3]
    bit 7, a
    jr nz, .less
    ld a, 1
    ret
.less:
    ld a, $FF
    ret
.equal:
    xor a
    ret

; Hold wN0 inside the representable range.
Clamp32:
    ld a, [wN0 + 3]
    bit 7, a
    jr nz, .negative
    cp FIXED_MAX_HI
    jr c, .done
    jr nz, .clampHigh
    ld a, [wN0]
    ld hl, wN0 + 1
    or [hl]
    inc hl
    or [hl]
    jr z, .done
.clampHigh:
    xor a
    ld [wN0], a
    ld [wN0 + 1], a
    ld [wN0 + 2], a
    ld a, FIXED_MAX_HI
    ld [wN0 + 3], a
    ret
.negative:
    cp FIXED_MIN_HI
    jr nc, .done
    xor a
    ld [wN0], a
    ld [wN0 + 1], a
    ld [wN0 + 2], a
    ld a, FIXED_MIN_HI
    ld [wN0 + 3], a
.done:
    ret

; Arithmetic shift right by one — floor division by two, which is what
; `centerx` needs and what `Math.floor(width / 2)` does in the interpreter.
Asr32At:
    ld de, 3
    add hl, de
    sra [hl]
    dec hl
    rr [hl]
    dec hl
    rr [hl]
    dec hl
    rr [hl]
    ret

; --- multiply ----------------------------------------------------------------
; wN0 = floor(wN0 * wN1 / 65536).
;
; Shift-and-add over the multiplier's bits, exiting the moment the multiplier
; runs dry — which is most of the time, because directions are +/-1 and speeds
; are small. The accumulator is 56 bits because the clamped operand range tops
; out at 2^26 each and 2^52 has to fit exactly.

Mul32:
    call IsZeroN0
    jp z, .zero
    call IsZeroN1
    jp z, .zero

    ld a, [wN0 + 3]
    ld b, a
    ld a, [wN1 + 3]
    xor b
    and $80
    ld [wSign], a

    ld hl, wN0
    ld de, wU0
    call Copy32
    ld hl, wU0 + 3
    bit 7, [hl]
    jr z, .u0positive
    ld hl, wU0
    call Neg32At
.u0positive:
    ld hl, wN1
    ld de, wU1
    call Copy32
    ld hl, wU1 + 3
    bit 7, [hl]
    jr z, .u1positive
    ld hl, wU1
    call Neg32At
.u1positive:

    ; x * 1 is by far the commonest multiply in a game — every object moving at
    ; a whole direction does two of them per tick — and it is exact, so it can
    ; skip the shift-and-add entirely.
    ld hl, wU1
    call IsOneAt
    jr nz, .notOneU1
    ld hl, wU0
    ld de, wN0
    call Copy32
    jp .applySign
.notOneU1:
    ld hl, wU0
    call IsOneAt
    jr nz, .general
    ld hl, wU1
    ld de, wN0
    call Copy32
    jp .applySign
.general:

    ld hl, wP
    call Zero7At
    ld hl, wM
    call Zero7At
    ld hl, wU0
    ld de, wM
    call Copy32

.loop:
    ld a, [wU1]
    ld hl, wU1 + 1
    or [hl]
    inc hl
    or [hl]
    inc hl
    or [hl]
    jr z, .finish
    ld a, [wU1]
    and 1
    jr z, .noAdd
    ; wP += wM, seven bytes
    ld hl, wM
    ld de, wP
    or a
    ld b, 7
.add:
    ld a, [de]
    adc a, [hl]
    ld [de], a
    inc hl
    inc de
    dec b
    jr nz, .add
.noAdd:
    ; wM <<= 1
    ld hl, wM
    sla [hl]
    REPT 6
    inc hl
    rl [hl]
    ENDR
    ; wU1 >>= 1
    ld hl, wU1 + 3
    srl [hl]
    dec hl
    rr [hl]
    dec hl
    rr [hl]
    dec hl
    rr [hl]
    jr .loop

.finish:
    ld a, [wSign]
    or a
    jr z, .positive
    ; Negate the whole product before the shift: two's complement right shift
    ; is floor, so negating first is what makes -0.5 land on -1 and not on 0.
    ld hl, wP
    or a
    ld b, 7
.negate:
    ld a, 0
    sbc a, [hl]
    ld [hl+], a
    dec b
    jr nz, .negate
.positive:
    ld a, [wP + 2]
    ld [wN0], a
    ld a, [wP + 3]
    ld [wN0 + 1], a
    ld a, [wP + 4]
    ld [wN0 + 2], a
    ld a, [wP + 5]
    ld [wN0 + 3], a
    call Clamp32
    ret
.applySign:
    ld a, [wSign]
    or a
    jr z, .signed
    call Neg32
.signed:
    call Clamp32
    ret
.zero:
    xor a
    ld [wN0], a
    ld [wN0 + 1], a
    ld [wN0 + 2], a
    ld [wN0 + 3], a
    ret

; Z set when the four bytes at HL are exactly 1.0 (65536).
IsOneAt:
    ld a, [hl+]
    or a
    ret nz
    ld a, [hl+]
    or a
    ret nz
    ld a, [hl+]
    dec a
    ret nz
    ld a, [hl]
    or a
    ret

; --- divide ------------------------------------------------------------------
; wN0 = floor(wN0 * 65536 / wN1), and zero when the divisor is zero — the same
; answer `div` gives in fixed.ts, because a runtime that traps here would turn a
; harmless rule into a crash on hardware only.

Div32:
    call IsZeroN1
    jp z, .zero
    call IsZeroN0
    jp z, .zero

    ld a, [wN0 + 3]
    ld b, a
    ld a, [wN1 + 3]
    xor b
    and $80
    ld [wSign], a

    ld hl, wN0
    ld de, wU0
    call Copy32
    ld hl, wU0 + 3
    bit 7, [hl]
    jr z, .u0positive
    ld hl, wU0
    call Neg32At
.u0positive:
    ld hl, wN1
    ld de, wU1
    call Copy32
    ld hl, wU1 + 3
    bit 7, [hl]
    jr z, .u1positive
    ld hl, wU1
    call Neg32At
.u1positive:

    ; A divisor that is a whole number of cells has zero fractional bits, so
    ; `a * 65536 / (k * 65536)` is just `a / k` — a 32-by-8 division that fits
    ; entirely in registers. Every `speed / fps` in the engine takes this path,
    ; and it is an order of magnitude cheaper than the general one.
    ld a, [wU1]
    or a
    jr nz, .general
    ld a, [wU1 + 1]
    or a
    jr nz, .general
    ld a, [wU1 + 3]
    or a
    jr nz, .general
    ld a, [wU1 + 2]
    or a
    jr z, .general
    call DivByWholeCells
    jp .signAndFloor
.general:

    ; Dividend = |wN0| << 16, in the low six bytes of wM. The quotient grows
    ; into the same six bytes as the dividend vacates them.
    ld hl, wM
    call Zero7At
    ld a, [wU0]
    ld [wM + 2], a
    ld a, [wU0 + 1]
    ld [wM + 3], a
    ld a, [wU0 + 2]
    ld [wM + 4], a
    ld a, [wU0 + 3]
    ld [wM + 5], a
    xor a
    ld [wR], a
    ld [wR + 1], a
    ld [wR + 2], a
    ld [wR + 3], a

    ld a, 48
    ld [wTmpC], a
.loop:
    ld hl, wM
    sla [hl]
    REPT 5
    inc hl
    rl [hl]
    ENDR
    ld hl, wR
    REPT 4
    rl [hl]
    inc hl
    ENDR
    ; Trial subtraction: wN2 = wR - wU1, and carry says whether it fit.
    ld hl, wU1
    ld de, wR
    ld bc, wN2
    or a
    REPT 4
    ld a, [de]
    sbc a, [hl]
    ld [bc], a
    inc hl
    inc de
    inc bc
    ENDR
    jr c, .noFit
    ld hl, wN2
    ld de, wR
    call Copy32
    ld hl, wM
    set 0, [hl]
.noFit:
    ld hl, wTmpC
    dec [hl]
    jr nz, .loop

    ld hl, wM
    ld de, wN0
    call Copy32
.signAndFloor:
    ld a, [wSign]
    or a
    jr z, .done
    call Neg32
    ; floor, not truncate: a negative quotient with a remainder rounds away
    ; from zero, which is what an arithmetic shift would have done.
    ld a, [wR]
    ld hl, wR + 1
    or [hl]
    inc hl
    or [hl]
    inc hl
    or [hl]
    jr z, .done
    ld hl, wN0
    ld b, 4
    scf
.borrow:
    ld a, [hl]
    sbc a, 0
    ld [hl+], a
    dec b
    jr nz, .borrow
.done:
    call Clamp32
    ret
.zero:
    xor a
    ld [wN0], a
    ld [wN0 + 1], a
    ld [wN0 + 2], a
    ld [wN0 + 3], a
    ret

; |wU0| / wU1's cell count, leaving the quotient in wM and the remainder in wR.
; Restoring division with the dividend, quotient and remainder all in registers:
; b c d e carry the dividend and take the quotient as it vacates, a holds the
; remainder, h the divisor, l the bit counter.
DivByWholeCells:
    ld a, [wU0 + 3]
    ld b, a
    ld a, [wU0 + 2]
    ld c, a
    ld a, [wU0 + 1]
    ld d, a
    ld a, [wU0]
    ld e, a
    ld a, [wU1 + 2]
    ld h, a
    ld l, 32
    xor a
.loop:
    sla e
    rl d
    rl c
    rl b
    ; The remainder can reach 2*(k-1)+1, which overflows a byte when k > 128;
    ; the carry out of that shift is the ninth bit and always means "subtract".
    rla
    jr c, .subtract
    cp h
    jr c, .next
.subtract:
    sub h
    inc e
.next:
    dec l
    jr nz, .loop
    ld [wR], a
    xor a
    ld [wR + 1], a
    ld [wR + 2], a
    ld [wR + 3], a
    ld a, e
    ld [wM], a
    ld a, d
    ld [wM + 1], a
    ld a, c
    ld [wM + 2], a
    ld a, b
    ld [wM + 3], a
    ld hl, wM
    ld de, wN0
    jp Copy32
; --- the game's generator ----------------------------------------------------
; A 32-bit LCG with Numerical Recipes' constants, reproduced bit for bit from
; packages/demotic/src/rng.ts. It is part of the language, not a convenience:
; two implementations that disagree about it cannot be compared at all.

DEF RNG_MUL EQU 1664525
DEF RNG_ADD EQU 1013904223

; wRng = wRng * 1664525 + 1013904223, mod 2^32.
RngAdvance:
    ; 32 x 32 multiply, low 32 bits only: shift-and-add over the constant.
    ld hl, wU0
    ld de, wRng
    push de
    ld d, h
    ld e, l
    pop hl
    ld bc, 4
    call CopyBytes          ; wU0 = wRng
    ld hl, wP
    ld bc, 4
    call ZeroBytes
    ld a, LOW(RNG_MUL)
    ld [wU1], a
    ld a, HIGH(RNG_MUL)
    ld [wU1 + 1], a
    ld a, LOW(RNG_MUL >> 16)
    ld [wU1 + 2], a
    ld a, HIGH(RNG_MUL >> 16)
    ld [wU1 + 3], a
.loop:
    ld a, [wU1]
    ld hl, wU1 + 1
    or [hl]
    inc hl
    or [hl]
    inc hl
    or [hl]
    jr z, .add
    ld a, [wU1]
    and 1
    jr z, .noAdd
    ld hl, wU0
    ld de, wP
    or a
    ld b, 4
.acc:
    ld a, [de]
    adc a, [hl]
    ld [de], a
    inc hl
    inc de
    dec b
    jr nz, .acc
.noAdd:
    ld hl, wU0
    sla [hl]
    REPT 3
    inc hl
    rl [hl]
    ENDR
    ld hl, wU1 + 3
    srl [hl]
    dec hl
    rr [hl]
    dec hl
    rr [hl]
    dec hl
    rr [hl]
    jr .loop
.add:
    ld hl, .increment
    ld de, wP
    or a
    ld b, 4
.final:
    ld a, [de]
    adc a, [hl]
    ld [de], a
    inc hl
    inc de
    dec b
    jr nz, .final
    ld hl, wP
    ld de, wRng
    call Copy32
    ret
.increment:
    db LOW(RNG_ADD), HIGH(RNG_ADD), LOW(RNG_ADD >> 16), HIGH(RNG_ADD >> 16)

; random(low, high): wN0 = low, wN1 = high, result in wN0.
;
; The draw happens here and nowhere else, so *when* a rule evaluates a `random`
; is part of the game's behaviour — which is why it cannot be folded away.
RngPick:
    ; lo = floor(wN0 / 65536), hi = floor(wN1 / 65536), both signed 16-bit.
    ld a, [wN0 + 2]
    ld c, a
    ld a, [wN0 + 3]
    ld b, a
    push bc                 ; lo
    ld a, [wN1 + 2]
    ld c, a
    ld a, [wN1 + 3]
    ld b, a
    pop de                  ; de = lo, bc = hi
    ; count = hi - lo + 1; when hi <= lo the answer is lo, with no draw.
    ld a, c
    sub e
    ld l, a
    ld a, b
    sbc a, d
    ld h, a                 ; hl = hi - lo
    bit 7, h
    jr nz, .low
    ld a, h
    or l
    jr z, .low
    inc hl                  ; hl = count
    push de
    push hl
    call RngAdvance
    pop bc                  ; bc = count
    pop de                  ; de = lo
    ; The low bits of an LCG cycle short, so the draw comes from the high half.
    ld a, [wRng + 2]
    ld l, a
    ld a, [wRng + 3]
    ld h, a
    call ModHlBc            ; hl = hl mod bc
    add hl, de
    jr .store
.low:
    ld h, d
    ld l, e
.store:
    ; Sign-extend the 16-bit cell count back into 16.16.
    xor a
    ld [wN0], a
    ld [wN0 + 1], a
    ld a, l
    ld [wN0 + 2], a
    ld a, h
    ld [wN0 + 3], a
    ret

; HL = HL mod BC, unsigned, by repeated subtraction of shifted divisors.
ModHlBc:
    ld a, b
    or c
    ret z
.reduce:
    ; while hl >= bc: hl -= bc, with the divisor doubled while it still fits.
    ld d, b
    ld e, c
.scale:
    ; de doubled while de <= hl/2
    ld a, d
    cp $40
    jr nc, .subtract
    sla e
    rl d
    ld a, h
    cp d
    jr c, .halve
    jr nz, .scale
    ld a, l
    cp e
    jr c, .halve
    jr .scale
.halve:
    srl d
    rr e
.subtract:
    ld a, l
    sub e
    ld l, a
    ld a, h
    sbc a, d
    ld h, a
    ; if that went negative, put it back and stop scaling down
    jr nc, .again
    add hl, de
    ret
.again:
    ld a, h
    cp b
    jr c, .no
    jr nz, .reduce
    ld a, l
    cp c
    jr c, .no
    jr .reduce
.no:
    ret
