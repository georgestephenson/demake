/**
 * An ARMv4T (ARM7TDMI) assembler.
 *
 * The sixth of `core`'s encoders, and it exists for the reason the other five do
 * (`asm/sm83.ts`, `asm/mos6502.ts`, `asm/z80.ts`, `asm/m68k.ts`,
 * `asm/wdc65816.ts`, doc 14 §Runtime model): a game compiles to machine code,
 * and the encoder is TypeScript because the browser has no assembler. The
 * display-ROM edge shells out to `arm-none-eabi-as` and always could; a
 * cartridge the page has to produce byte-identically cannot.
 *
 * It buys three consoles rather than one — the Game Boy Advance, and both of a
 * Nintendo DS's processors — which is why the file knows nothing about any of
 * them. What is new about the *machine*, and reaches the backend above it:
 *
 *   - **A 16.16 value is a register, and so is its product.** `add`, `sub`,
 *     `rsb`, `cmp` and `asr` are one instruction each, `smull` gives the 64-bit
 *     product a fixed-point multiply needs in one more, and the barrel shifter
 *     folds the normalising shift into the instruction that consumes it. The two
 *     routines the Mega Drive still pulls in reduce to one here: this core has no
 *     divide.
 *   - **Every instruction is conditional.** A two-instruction `if` is a
 *     predicated pair with no branch at all, which is why the condition is a
 *     parameter on every method rather than a property of the branch methods.
 *   - **A 32-bit constant does not fit in a 32-bit instruction.** The immediate
 *     field is an 8-bit value rotated by an even amount, so a third of the
 *     constants a game uses have to be *loaded* — from a literal pool, PC-
 *     relative, reachable across ±4 KiB. That is a discipline the other five
 *     encoders do not impose and this one cannot hide: see {@link AsmArm.ltorg}.
 *
 * **ARM state only, deliberately.** Thumb halves code size and costs a second
 * encoder, a mode-switch discipline and a second set of range rules; the
 * consoles it would matter on have 32 MB and 4 MB of cartridge against a game's
 * tens of kilobytes. If a profile ever says the 16-bit ROM bus is what a frame
 * is spent on, Thumb is an additive change to this file and not a change to
 * anything above it.
 *
 * Like its five predecessors it is one pass plus a fixup sweep: every
 * instruction's length is fixed by the method that emits it — a pooled load is
 * one instruction whether or not its value is known — so nothing relaxes and an
 * address never moves under a reference already resolved.
 *
 * Sources: ARM — *ARM7TDMI Technical Reference Manual* (DDI 0210C, §3 the
 * instruction set) and the *ARM Architecture Reference Manual* (DDI 0100E, §A3
 * ARM instruction encodings and §A5 addressing modes).
 */

import { AsmError, label, type LabelRef, type Ref } from "./sm83.js";

export { AsmError, label };
export type { LabelRef, Ref };

/**
 * A condition code, in the encoding's own order.
 *
 * `nv` is listed because the field has sixteen values and omitting one would
 * make the table lie; ARMv4 leaves it unpredictable and nothing here emits it.
 */
export type ArmCond =
  | "eq"
  | "ne"
  | "cs"
  | "cc"
  | "mi"
  | "pl"
  | "vs"
  | "vc"
  | "hi"
  | "ls"
  | "ge"
  | "lt"
  | "gt"
  | "le"
  | "al"
  | "nv";

const COND_CODE: Readonly<Record<ArmCond, number>> = {
  eq: 0,
  ne: 1,
  cs: 2,
  cc: 3,
  mi: 4,
  pl: 5,
  vs: 6,
  vc: 7,
  hi: 8,
  ls: 9,
  ge: 10,
  lt: 11,
  gt: 12,
  le: 13,
  al: 14,
  nv: 15,
};

/**
 * The opposite of a condition, which is the encoding's own low bit.
 *
 * Every condition is paired with its inverse in adjacent slots, so a backend
 * that wants "branch over the body" out of "branch to the body" flips one bit
 * rather than consulting a table of its own.
 */
export function invertCond(cond: ArmCond): ArmCond {
  if (cond === "al" || cond === "nv") throw new AsmError(`'${cond}' has no inverse`);
  const code = COND_CODE[cond] ^ 1;
  const found = (Object.keys(COND_CODE) as ArmCond[]).find((name) => COND_CODE[name] === code);
  if (found === undefined) throw new AsmError(`no inverse for '${cond}'`);
  return found;
}

/** Register numbers, for call sites that would rather not count. */
export const R0 = 0;
export const R1 = 1;
export const R2 = 2;
export const R3 = 3;
export const R4 = 4;
export const R5 = 5;
export const R6 = 6;
export const R7 = 7;
export const R8 = 8;
export const R9 = 9;
export const R10 = 10;
export const R11 = 11;
export const R12 = 12;
/** The stack pointer, by convention rather than by hardware. */
export const SP = 13;
/** The link register, which `bl` writes and `bx lr` returns through. */
export const LR = 14;
/** The program counter — and it reads as *this instruction plus eight*. */
export const PC = 15;

/**
 * The three registers that are more than a number, under names `core`'s index
 * can export.
 *
 * `R0`–`R12` are not exported from the package at all: what a backend calls them
 * should say what they hold, and `SP` is already the SPC700's stack-pointer
 * operand (doc 02 §Dependency rules has the same story for the 65816's).
 */
export const ARM_SP = SP;
/** The link register, under a name the package can export. */
export const ARM_LR = LR;
/** The program counter, under a name the package can export. */
export const ARM_PC = PC;

/** A barrel-shift kind, in the encoding's own order. */
export type ArmShift = "lsl" | "lsr" | "asr" | "ror";

const SHIFT_CODE: Readonly<Record<ArmShift, number>> = { lsl: 0, lsr: 1, asr: 2, ror: 3 };

/**
 * The second operand of a data-processing instruction.
 *
 * Built by the constructors below rather than by hand, because the immediate
 * form is not an immediate: it is an eight-bit value rotated right by an even
 * amount, and a number that cannot be expressed that way has to become a pooled
 * load instead. Making that a type the assembler validates is what turns a
 * silent truncation into an {@link AsmError} at the call site.
 */
export type ArmOp2 =
  /** `#imm`, if it can be written as an 8-bit value rotated by an even amount. */
  | { readonly k: "imm"; readonly v: number }
  /** `Rm` */
  | { readonly k: "reg"; readonly r: number }
  /** `Rm, <shift> #n` — `n` is 1–32 for lsr/asr and 0–31 for lsl/ror. */
  | { readonly k: "shift"; readonly r: number; readonly by: ArmShift; readonly n: number }
  /** `Rm, <shift> Rs` */
  | { readonly k: "rshift"; readonly r: number; readonly by: ArmShift; readonly s: number }
  /** `Rm, rrx` — a 33-bit rotate through the carry, which is `ror #0`. */
  | { readonly k: "rrx"; readonly r: number };

/** `#imm` — rejected at encode time if the rotation cannot express it. */
export function armImm(value: number): ArmOp2 {
  return { k: "imm", v: value };
}
/** `Rm`. */
export function armReg(r: number): ArmOp2 {
  return { k: "reg", r };
}
/** `Rm, lsl #n`. */
export function armLsl(r: number, n: number): ArmOp2 {
  return { k: "shift", r, by: "lsl", n };
}
/** `Rm, lsr #n` — `n` is 1–32, because `lsr #0` is how the field spells 32. */
export function armLsr(r: number, n: number): ArmOp2 {
  return { k: "shift", r, by: "lsr", n };
}
/** `Rm, asr #n` — `n` is 1–32, for the same reason. */
export function armAsr(r: number, n: number): ArmOp2 {
  return { k: "shift", r, by: "asr", n };
}
/** `Rm, ror #n`. */
export function armRor(r: number, n: number): ArmOp2 {
  return { k: "shift", r, by: "ror", n };
}
/** `Rm, <shift> Rs`. */
export function armShiftBy(r: number, by: ArmShift, s: number): ArmOp2 {
  return { k: "rshift", r, by, s };
}
/** `Rm, rrx`. */
export function armRrx(r: number): ArmOp2 {
  return { k: "rrx", r };
}

/**
 * A load/store addressing mode.
 *
 * The `sub` flag rather than a signed offset, because the encoding carries a
 * magnitude and a direction bit and a register offset has no sign of its own —
 * so "subtract this register" is a mode, not a negative number.
 */
export type ArmMem =
  /** `[Rn, #±off]`, `[Rn, #±off]!` or `[Rn], #±off`. */
  | {
      readonly k: "imm";
      readonly rn: number;
      readonly off: number;
      readonly pre: boolean;
      readonly wb: boolean;
    }
  /** `[Rn, ±Rm{, shift}]` and its pre/post forms. */
  | {
      readonly k: "reg";
      readonly rn: number;
      readonly rm: number;
      readonly by: ArmShift;
      readonly n: number;
      readonly sub: boolean;
      readonly pre: boolean;
      readonly wb: boolean;
    };

/** `[Rn, #off]` — the offset may be negative, and is encoded as a direction. */
export function armAt(rn: number, off = 0): ArmMem {
  return { k: "imm", rn, off, pre: true, wb: false };
}
/** `[Rn, #off]!` — pre-indexed, writing the address back. */
export function armAtPre(rn: number, off: number): ArmMem {
  return { k: "imm", rn, off, pre: true, wb: true };
}
/** `[Rn], #off` — post-indexed, which always writes back. */
export function armAtPost(rn: number, off: number): ArmMem {
  return { k: "imm", rn, off, pre: false, wb: false };
}
/** `[Rn, Rm{, lsl #n}]`. */
export function armAtIdx(rn: number, rm: number, by: ArmShift = "lsl", n = 0): ArmMem {
  return { k: "reg", rn, rm, by, n, sub: false, pre: true, wb: false };
}
/** `[Rn, -Rm{, lsl #n}]`. */
export function armAtIdxSub(rn: number, rm: number, by: ArmShift = "lsl", n = 0): ArmMem {
  return { k: "reg", rn, rm, by, n, sub: true, pre: true, wb: false };
}
/** `[Rn], Rm{, lsl #n}` — post-indexed by a register. */
export function armAtIdxPost(rn: number, rm: number, by: ArmShift = "lsl", n = 0): ArmMem {
  return { k: "reg", rn, rm, by, n, sub: false, pre: false, wb: false };
}

/** How a block transfer walks the base register. */
export type ArmBlockMode = "ia" | "ib" | "da" | "db";

/** `P` and `U` for each block-transfer mode. */
const BLOCK_BITS: Readonly<Record<ArmBlockMode, { p: number; u: number }>> = {
  ia: { p: 0, u: 1 },
  ib: { p: 1, u: 1 },
  da: { p: 0, u: 0 },
  db: { p: 1, u: 0 },
};

/**
 * Encode a value as the data-processing immediate field, or report that it
 * cannot be.
 *
 * The field is `rotate:4` and `imm:8`, and the value is the immediate rotated
 * *right* by twice the rotate — so the search is over the sixteen left rotations
 * of the target, looking for one that fits in a byte. Returns the twelve-bit
 * field, or `undefined`.
 */
export function encodeArmImm(value: number): number | undefined {
  const v = value >>> 0;
  for (let rot = 0; rot < 16; rot += 1) {
    const n = rot * 2;
    const rotated = n === 0 ? v : ((v << n) | (v >>> (32 - n))) >>> 0;
    if (rotated <= 0xff) return (rot << 8) | rotated;
  }
  return undefined;
}

/** Whether a number can be a `mov` or `mvn` immediate — the cheap two forms. */
export function fitsArmImm(value: number): boolean {
  return encodeArmImm(value) !== undefined;
}

/** Normalise the two spellings of a label reference. */
function asLabelRef(ref: string | LabelRef): LabelRef {
  return typeof ref === "string" ? { label: ref, addend: 0 } : ref;
}

interface Fixup {
  /** Byte offset of the field to patch. */
  at: number;
  kind: "abs32" | "abs16" | "rel24";
  ref: LabelRef;
  /** Address the displacement is measured from — for relative fields. */
  base: number;
}

/** One pending literal-pool load, waiting for the pool it will read from. */
interface PoolEntry {
  /** Byte offset of the `ldr` whose twelve-bit field this fills in. */
  at: number;
  /** The word to place in the pool. */
  value: Ref;
  /** What makes two entries the same word. */
  key: string;
}

/**
 * A growable code buffer with labels and literal pools, for ARM.
 *
 * `origin` is where byte zero lives in the address space — `$08000000` for a
 * Game Boy Advance cartridge, `$02000000` for a DS program in main RAM — so
 * every absolute reference resolves without a caller doing base arithmetic.
 */
export class AsmArm {
  private code: number[] = [];
  private readonly labels = new Map<string, number>();
  private readonly fixups: Fixup[] = [];
  private pool: PoolEntry[] = [];

  constructor(readonly origin = 0) {}

  /** Bytes emitted so far. */
  get length(): number {
    return this.code.length;
  }

  /** The address the next byte will occupy. */
  get pc(): number {
    return this.origin + this.code.length;
  }

  /** Define a label at the current address. */
  label(name: string): this {
    if (this.labels.has(name)) throw new AsmError(`duplicate label '${name}'`);
    this.labels.set(name, this.pc);
    return this;
  }

  /** Define a label at an address the assembler does not own (RAM, hardware). */
  equate(name: string, address: number): this {
    if (this.labels.has(name)) throw new AsmError(`duplicate label '${name}'`);
    this.labels.set(name, address >>> 0);
    return this;
  }

  /** Whether a label has been defined. */
  has(name: string): boolean {
    return this.labels.has(name);
  }

  /** Resolve a label that is already defined. */
  addressOf(name: string): number {
    const at = this.labels.get(name);
    if (at === undefined) throw new AsmError(`undefined label '${name}'`);
    return at;
  }

  // --- raw data --------------------------------------------------------------

  /** Emit literal bytes. */
  db(...values: number[]): this {
    for (const value of values) this.code.push(value & 0xff);
    return this;
  }

  /** Emit a little-endian halfword, resolving a label if given. */
  dh(value: Ref): this {
    if (typeof value === "number") return this.db(value, value >> 8);
    this.fixups.push({ at: this.code.length, kind: "abs16", ref: asLabelRef(value), base: 0 });
    return this.db(0, 0);
  }

  /** Emit a little-endian word, resolving a label if given. */
  dw(value: Ref): this {
    if (typeof value === "number") {
      return this.db(value, value >> 8, value >> 16, value >>> 24);
    }
    this.fixups.push({ at: this.code.length, kind: "abs32", ref: asLabelRef(value), base: 0 });
    return this.db(0, 0, 0, 0);
  }

  /**
   * The 32-bit datum every backend's constant pool emits.
   *
   * An alias for {@link dw} and not a second encoding, exactly as `dd` is on the
   * 68000 — the name is `CtxBase`'s and the bytes are this machine's.
   */
  dd(value: Ref): this {
    return this.dw(value);
  }

  /** Emit `count` bytes of `fill`. */
  ds(count: number, fill = 0): this {
    for (let index = 0; index < count; index += 1) this.db(fill);
    return this;
  }

  /** Emit a block of bytes. */
  bytes(values: ArrayLike<number>): this {
    for (let index = 0; index < values.length; index += 1) this.db(values[index] as number);
    return this;
  }

  /**
   * Pad to a multiple of `to` bytes.
   *
   * Four by default, because that is what an instruction and a pool word need.
   * A run of `db` before a table is the only thing that ever leaves this false.
   */
  align(to = 4): this {
    while (this.code.length % to !== 0) this.db(0);
    return this;
  }

  /** Pad with `fill` until the next byte lands on `address`. */
  padTo(address: number, fill = 0): this {
    if (this.pc > address) {
      throw new AsmError(
        `cannot pad to $${address.toString(16)}: already at $${this.pc.toString(16)}`,
      );
    }
    return this.ds(address - this.pc, fill);
  }

  // --- the encoding's plumbing -----------------------------------------------

  /** Emit one instruction word, little-endian. */
  private emit(word: number): this {
    if (this.code.length % 4 !== 0) {
      throw new AsmError(`an instruction at $${this.pc.toString(16)} is not word-aligned`);
    }
    return this.dw(word >>> 0);
  }

  /** The condition field, in place. */
  private static cc(cond: ArmCond): number {
    return COND_CODE[cond] << 28;
  }

  /** Reject a register number the four-bit field cannot hold. */
  private static reg(r: number, what: string): number {
    if (!Number.isInteger(r) || r < 0 || r > 15) {
      throw new AsmError(`${what}: r${r} is not a register`);
    }
    return r;
  }

  /** The twelve bits of a second operand, plus the `I` bit that describes it. */
  private static operand2(op: ArmOp2): { i: number; bits: number } {
    switch (op.k) {
      case "imm": {
        const field = encodeArmImm(op.v);
        if (field === undefined) {
          throw new AsmError(
            `#${op.v} is not an ARM immediate (8 bits rotated by an even amount) — ` +
              `load it with ldrConst instead`,
          );
        }
        return { i: 1 << 25, bits: field };
      }
      case "reg":
        return { i: 0, bits: AsmArm.reg(op.r, "operand") };
      case "shift": {
        let n = op.n;
        if (op.by === "lsr" || op.by === "asr") {
          if (n < 1 || n > 32) throw new AsmError(`${op.by} #${n} is out of range (1–32)`);
          // The field spells 32 as zero; there is no `lsr #0`, because that is
          // the register itself and `armReg` is how you say so.
          if (n === 32) n = 0;
        } else {
          if (n < 0 || n > 31) throw new AsmError(`${op.by} #${n} is out of range (0–31)`);
          if (op.by === "ror" && n === 0) {
            throw new AsmError("ror #0 is rrx — use armRrx");
          }
        }
        return { i: 0, bits: (n << 7) | (SHIFT_CODE[op.by] << 5) | AsmArm.reg(op.r, "operand") };
      }
      case "rshift":
        return {
          i: 0,
          bits:
            (AsmArm.reg(op.s, "shift amount") << 8) |
            (SHIFT_CODE[op.by] << 5) |
            (1 << 4) |
            AsmArm.reg(op.r, "operand"),
        };
      case "rrx":
        return { i: 0, bits: (SHIFT_CODE.ror << 5) | AsmArm.reg(op.r, "operand") };
    }
  }

  /** One data-processing instruction, whatever its opcode. */
  private dp(op: number, s: boolean, rd: number, rn: number, op2: ArmOp2, cond: ArmCond): this {
    const { i, bits } = AsmArm.operand2(op2);
    return this.emit(
      AsmArm.cc(cond) |
        i |
        (op << 21) |
        ((s ? 1 : 0) << 20) |
        (AsmArm.reg(rn, "operand") << 16) |
        (AsmArm.reg(rd, "destination") << 12) |
        bits,
    );
  }

  // --- data processing -------------------------------------------------------

  /** `and rd, rn, op2`. */
  and(rd: number, rn: number, op2: ArmOp2, cond: ArmCond = "al"): this {
    return this.dp(0, false, rd, rn, op2, cond);
  }
  /** `ands rd, rn, op2`. */
  ands(rd: number, rn: number, op2: ArmOp2, cond: ArmCond = "al"): this {
    return this.dp(0, true, rd, rn, op2, cond);
  }
  /** `eor rd, rn, op2`. */
  eor(rd: number, rn: number, op2: ArmOp2, cond: ArmCond = "al"): this {
    return this.dp(1, false, rd, rn, op2, cond);
  }
  /** `eors rd, rn, op2`. */
  eors(rd: number, rn: number, op2: ArmOp2, cond: ArmCond = "al"): this {
    return this.dp(1, true, rd, rn, op2, cond);
  }
  /** `sub rd, rn, op2`. */
  sub(rd: number, rn: number, op2: ArmOp2, cond: ArmCond = "al"): this {
    return this.dp(2, false, rd, rn, op2, cond);
  }
  /** `subs rd, rn, op2`. */
  subs(rd: number, rn: number, op2: ArmOp2, cond: ArmCond = "al"): this {
    return this.dp(2, true, rd, rn, op2, cond);
  }
  /** `rsb rd, rn, op2` — the reverse subtract, which is how a negate is spelled. */
  rsb(rd: number, rn: number, op2: ArmOp2, cond: ArmCond = "al"): this {
    return this.dp(3, false, rd, rn, op2, cond);
  }
  /** `rsbs rd, rn, op2`. */
  rsbs(rd: number, rn: number, op2: ArmOp2, cond: ArmCond = "al"): this {
    return this.dp(3, true, rd, rn, op2, cond);
  }
  /** `add rd, rn, op2`. */
  add(rd: number, rn: number, op2: ArmOp2, cond: ArmCond = "al"): this {
    return this.dp(4, false, rd, rn, op2, cond);
  }
  /** `adds rd, rn, op2`. */
  adds(rd: number, rn: number, op2: ArmOp2, cond: ArmCond = "al"): this {
    return this.dp(4, true, rd, rn, op2, cond);
  }
  /** `adc rd, rn, op2`. */
  adc(rd: number, rn: number, op2: ArmOp2, cond: ArmCond = "al"): this {
    return this.dp(5, false, rd, rn, op2, cond);
  }
  /** `adcs rd, rn, op2`. */
  adcs(rd: number, rn: number, op2: ArmOp2, cond: ArmCond = "al"): this {
    return this.dp(5, true, rd, rn, op2, cond);
  }
  /** `sbc rd, rn, op2`. */
  sbc(rd: number, rn: number, op2: ArmOp2, cond: ArmCond = "al"): this {
    return this.dp(6, false, rd, rn, op2, cond);
  }
  /** `sbcs rd, rn, op2`. */
  sbcs(rd: number, rn: number, op2: ArmOp2, cond: ArmCond = "al"): this {
    return this.dp(6, true, rd, rn, op2, cond);
  }
  /** `rsc rd, rn, op2`. */
  rsc(rd: number, rn: number, op2: ArmOp2, cond: ArmCond = "al"): this {
    return this.dp(7, false, rd, rn, op2, cond);
  }
  /** `rscs rd, rn, op2`. */
  rscs(rd: number, rn: number, op2: ArmOp2, cond: ArmCond = "al"): this {
    return this.dp(7, true, rd, rn, op2, cond);
  }
  /** `tst rn, op2` — an `and` that keeps only the flags. */
  tst(rn: number, op2: ArmOp2, cond: ArmCond = "al"): this {
    return this.dp(8, true, 0, rn, op2, cond);
  }
  /** `teq rn, op2`. */
  teq(rn: number, op2: ArmOp2, cond: ArmCond = "al"): this {
    return this.dp(9, true, 0, rn, op2, cond);
  }
  /** `cmp rn, op2`. */
  cmp(rn: number, op2: ArmOp2, cond: ArmCond = "al"): this {
    return this.dp(10, true, 0, rn, op2, cond);
  }
  /** `cmn rn, op2`. */
  cmn(rn: number, op2: ArmOp2, cond: ArmCond = "al"): this {
    return this.dp(11, true, 0, rn, op2, cond);
  }
  /** `orr rd, rn, op2`. */
  orr(rd: number, rn: number, op2: ArmOp2, cond: ArmCond = "al"): this {
    return this.dp(12, false, rd, rn, op2, cond);
  }
  /** `orrs rd, rn, op2`. */
  orrs(rd: number, rn: number, op2: ArmOp2, cond: ArmCond = "al"): this {
    return this.dp(12, true, rd, rn, op2, cond);
  }
  /** `mov rd, op2`. */
  mov(rd: number, op2: ArmOp2, cond: ArmCond = "al"): this {
    return this.dp(13, false, rd, 0, op2, cond);
  }
  /** `movs rd, op2`. */
  movs(rd: number, op2: ArmOp2, cond: ArmCond = "al"): this {
    return this.dp(13, true, rd, 0, op2, cond);
  }
  /** `bic rd, rn, op2` — clear the bits `op2` sets. */
  bic(rd: number, rn: number, op2: ArmOp2, cond: ArmCond = "al"): this {
    return this.dp(14, false, rd, rn, op2, cond);
  }
  /** `bics rd, rn, op2`. */
  bics(rd: number, rn: number, op2: ArmOp2, cond: ArmCond = "al"): this {
    return this.dp(14, true, rd, rn, op2, cond);
  }
  /** `mvn rd, op2`. */
  mvn(rd: number, op2: ArmOp2, cond: ArmCond = "al"): this {
    return this.dp(15, false, rd, 0, op2, cond);
  }
  /** `mvns rd, op2`. */
  mvns(rd: number, op2: ArmOp2, cond: ArmCond = "al"): this {
    return this.dp(15, true, rd, 0, op2, cond);
  }

  /** `mov r0, r0` — the canonical do-nothing, and the padding a table wants. */
  nop(cond: ArmCond = "al"): this {
    return this.mov(R0, armReg(R0), cond);
  }

  // --- multiply --------------------------------------------------------------

  /**
   * `mul rd, rm, rs`.
   *
   * `rd` and `rm` may not be the same register: the core reads `Rm` after it has
   * begun writing `Rd`, and ARMv4 leaves the result unpredictable. It is an
   * error here rather than a surprise there.
   */
  mul(rd: number, rm: number, rs: number, cond: ArmCond = "al"): this {
    if (rd === rm) throw new AsmError("mul cannot write its own first operand");
    return this.emit(
      AsmArm.cc(cond) |
        (AsmArm.reg(rd, "destination") << 16) |
        (AsmArm.reg(rs, "operand") << 8) |
        0x90 |
        AsmArm.reg(rm, "operand"),
    );
  }

  /** `mla rd, rm, rs, rn` — `rd = rm × rs + rn`. */
  mla(rd: number, rm: number, rs: number, rn: number, cond: ArmCond = "al"): this {
    if (rd === rm) throw new AsmError("mla cannot write its own first operand");
    return this.emit(
      AsmArm.cc(cond) |
        (1 << 21) |
        (AsmArm.reg(rd, "destination") << 16) |
        (AsmArm.reg(rn, "accumulator") << 12) |
        (AsmArm.reg(rs, "operand") << 8) |
        0x90 |
        AsmArm.reg(rm, "operand"),
    );
  }

  /** One of the four long multiplies; `u` is the signed bit, `a` the accumulate. */
  private mullForm(
    u: boolean,
    a: boolean,
    rdLo: number,
    rdHi: number,
    rm: number,
    rs: number,
    cond: ArmCond,
  ): this {
    if (rdLo === rdHi || rdLo === rm || rdHi === rm) {
      throw new AsmError("a long multiply needs three distinct registers");
    }
    return this.emit(
      AsmArm.cc(cond) |
        (1 << 23) |
        ((u ? 1 : 0) << 22) |
        ((a ? 1 : 0) << 21) |
        (AsmArm.reg(rdHi, "destination") << 16) |
        (AsmArm.reg(rdLo, "destination") << 12) |
        (AsmArm.reg(rs, "operand") << 8) |
        0x90 |
        AsmArm.reg(rm, "operand"),
    );
  }

  /** `umull rdLo, rdHi, rm, rs`. */
  umull(rdLo: number, rdHi: number, rm: number, rs: number, cond: ArmCond = "al"): this {
    return this.mullForm(false, false, rdLo, rdHi, rm, rs, cond);
  }
  /** `umlal rdLo, rdHi, rm, rs`. */
  umlal(rdLo: number, rdHi: number, rm: number, rs: number, cond: ArmCond = "al"): this {
    return this.mullForm(false, true, rdLo, rdHi, rm, rs, cond);
  }
  /**
   * `smull rdLo, rdHi, rm, rs` — the whole of a 16.16 multiply's arithmetic.
   *
   * A fixed-point product is the middle 32 bits of a 64-bit one, so the pair
   * this writes is shifted rather than truncated, and nothing about it is a
   * loop. That is the single biggest difference between this backend's value
   * layer and the 8-bit consoles'.
   */
  smull(rdLo: number, rdHi: number, rm: number, rs: number, cond: ArmCond = "al"): this {
    return this.mullForm(true, false, rdLo, rdHi, rm, rs, cond);
  }
  /** `smlal rdLo, rdHi, rm, rs`. */
  smlal(rdLo: number, rdHi: number, rm: number, rs: number, cond: ArmCond = "al"): this {
    return this.mullForm(true, true, rdLo, rdHi, rm, rs, cond);
  }

  // --- load and store --------------------------------------------------------

  /**
   * The `P U B W L` bits and the offset field of a word/byte transfer.
   *
   * The `I` bit means the opposite here of what it means in a data-processing
   * instruction: set, the offset is a *register*. It is the one place in this
   * encoding where the same bit name reverses sense, so it is stated rather than
   * left to be noticed.
   */
  private transfer(load: boolean, byte: boolean, rd: number, mem: ArmMem, cond: ArmCond): this {
    let i = 0;
    let u: number;
    let offset: number;
    if (mem.k === "imm") {
      const magnitude = Math.abs(mem.off);
      if (magnitude > 0xfff) {
        throw new AsmError(`offset ${mem.off} does not fit a 12-bit load/store field`);
      }
      u = mem.off < 0 ? 0 : 1;
      offset = magnitude;
    } else {
      i = 1 << 25;
      u = mem.sub ? 0 : 1;
      // `lsl #0` encodes as a bare register, which is what `operand2` produces
      // for it — so the shifted and unshifted forms need no separate case.
      offset = AsmArm.operand2({ k: "shift", r: mem.rm, by: mem.by, n: mem.n }).bits;
    }
    return this.emit(
      AsmArm.cc(cond) |
        (1 << 26) |
        i |
        ((mem.pre ? 1 : 0) << 24) |
        (u << 23) |
        ((byte ? 1 : 0) << 22) |
        ((mem.wb ? 1 : 0) << 21) |
        ((load ? 1 : 0) << 20) |
        (AsmArm.reg(mem.rn, "base") << 16) |
        (AsmArm.reg(rd, "transfer") << 12) |
        offset,
    );
  }

  /** `ldr rd, <mem>`. */
  ldr(rd: number, mem: ArmMem, cond: ArmCond = "al"): this {
    return this.transfer(true, false, rd, mem, cond);
  }
  /** `str rd, <mem>`. */
  str(rd: number, mem: ArmMem, cond: ArmCond = "al"): this {
    return this.transfer(false, false, rd, mem, cond);
  }
  /** `ldrb rd, <mem>`. */
  ldrb(rd: number, mem: ArmMem, cond: ArmCond = "al"): this {
    return this.transfer(true, true, rd, mem, cond);
  }
  /** `strb rd, <mem>`. */
  strb(rd: number, mem: ArmMem, cond: ArmCond = "al"): this {
    return this.transfer(false, true, rd, mem, cond);
  }

  /**
   * The halfword and signed-byte forms, which are a different encoding entirely.
   *
   * They predate the ARM7 and were fitted into a hole in the data-processing
   * space, which is why the offset is eight bits split in two halves and why the
   * register form has no shift. A backend that reaches past ±255 on one of these
   * has to build the address first.
   */
  private halfTransfer(
    load: boolean,
    s: boolean,
    h: boolean,
    rd: number,
    mem: ArmMem,
    cond: ArmCond,
  ): this {
    let i = 0;
    let u: number;
    let offset: number;
    if (mem.k === "imm") {
      const magnitude = Math.abs(mem.off);
      if (magnitude > 0xff) {
        throw new AsmError(
          `offset ${mem.off} does not fit the 8-bit halfword/signed field — build the address first`,
        );
      }
      i = 1 << 22;
      u = mem.off < 0 ? 0 : 1;
      offset = ((magnitude & 0xf0) << 4) | (magnitude & 0x0f);
    } else {
      if (mem.n !== 0) throw new AsmError("a halfword transfer has no shifted index");
      u = mem.sub ? 0 : 1;
      offset = AsmArm.reg(mem.rm, "index");
    }
    return this.emit(
      AsmArm.cc(cond) |
        ((mem.pre ? 1 : 0) << 24) |
        (u << 23) |
        i |
        ((mem.wb ? 1 : 0) << 21) |
        ((load ? 1 : 0) << 20) |
        (AsmArm.reg(mem.rn, "base") << 16) |
        (AsmArm.reg(rd, "transfer") << 12) |
        (1 << 7) |
        ((s ? 1 : 0) << 6) |
        ((h ? 1 : 0) << 5) |
        (1 << 4) |
        offset,
    );
  }

  /** `ldrh rd, <mem>`. */
  ldrh(rd: number, mem: ArmMem, cond: ArmCond = "al"): this {
    return this.halfTransfer(true, false, true, rd, mem, cond);
  }
  /** `strh rd, <mem>`. */
  strh(rd: number, mem: ArmMem, cond: ArmCond = "al"): this {
    return this.halfTransfer(false, false, true, rd, mem, cond);
  }
  /** `ldrsb rd, <mem>`. */
  ldrsb(rd: number, mem: ArmMem, cond: ArmCond = "al"): this {
    return this.halfTransfer(true, true, false, rd, mem, cond);
  }
  /** `ldrsh rd, <mem>`. */
  ldrsh(rd: number, mem: ArmMem, cond: ArmCond = "al"): this {
    return this.halfTransfer(true, true, true, rd, mem, cond);
  }

  // --- block transfer --------------------------------------------------------

  /** The register list, as the sixteen-bit field. */
  private static list(regs: readonly number[]): number {
    let mask = 0;
    for (const r of regs) mask |= 1 << AsmArm.reg(r, "register list");
    if (mask === 0) throw new AsmError("an empty register list transfers nothing");
    return mask;
  }

  /** `ldm<mode> rn{!}, {regs}`. */
  ldm(
    rn: number,
    regs: readonly number[],
    mode: ArmBlockMode = "ia",
    writeback = false,
    cond: ArmCond = "al",
  ): this {
    const { p, u } = BLOCK_BITS[mode];
    return this.emit(
      AsmArm.cc(cond) |
        (1 << 27) |
        (p << 24) |
        (u << 23) |
        ((writeback ? 1 : 0) << 21) |
        (1 << 20) |
        (AsmArm.reg(rn, "base") << 16) |
        AsmArm.list(regs),
    );
  }

  /** `stm<mode> rn{!}, {regs}`. */
  stm(
    rn: number,
    regs: readonly number[],
    mode: ArmBlockMode = "ia",
    writeback = false,
    cond: ArmCond = "al",
  ): this {
    const { p, u } = BLOCK_BITS[mode];
    return this.emit(
      AsmArm.cc(cond) |
        (1 << 27) |
        (p << 24) |
        (u << 23) |
        ((writeback ? 1 : 0) << 21) |
        (AsmArm.reg(rn, "base") << 16) |
        AsmArm.list(regs),
    );
  }

  /** `push {regs}` — `stmdb sp!`, which is the full-descending stack ARM uses. */
  push(regs: readonly number[], cond: ArmCond = "al"): this {
    return this.stm(SP, regs, "db", true, cond);
  }

  /** `pop {regs}` — `ldmia sp!`. */
  pop(regs: readonly number[], cond: ArmCond = "al"): this {
    return this.ldm(SP, regs, "ia", true, cond);
  }

  // --- branches --------------------------------------------------------------

  /** `b target` — a signed 24-bit word displacement, so ±32 MB. */
  b(target: Ref, cond: ArmCond = "al"): this {
    return this.branch(target, false, cond);
  }

  /** `bl target`, which leaves the return address in `lr`. */
  bl(target: Ref, cond: ArmCond = "al"): this {
    return this.branch(target, true, cond);
  }

  private branch(target: Ref, link: boolean, cond: ArmCond): this {
    const word = AsmArm.cc(cond) | (5 << 25) | ((link ? 1 : 0) << 24);
    if (typeof target === "number") {
      const delta = target - (this.pc + 8);
      if (delta % 4 !== 0)
        throw new AsmError(`branch target $${target.toString(16)} is not aligned`);
      const offset = delta >> 2;
      if (offset < -0x800000 || offset > 0x7fffff) {
        throw new AsmError(`branch to $${target.toString(16)} is out of range`);
      }
      return this.emit(word | (offset & 0xffffff));
    }
    const at = this.code.length;
    this.fixups.push({
      at,
      kind: "rel24",
      ref: asLabelRef(target),
      base: this.origin + at + 8,
    });
    return this.emit(word);
  }

  /**
   * `bx rn` — the only instruction that can change instruction set.
   *
   * Nothing here emits Thumb, so every use of this is a return through `lr` or a
   * jump through a table, both with bit 0 clear. It is here because that is what
   * a return *is* on this architecture.
   */
  bx(rn: number, cond: ArmCond = "al"): this {
    return this.emit(AsmArm.cc(cond) | 0x012fff10 | AsmArm.reg(rn, "target"));
  }

  /** `bx lr`, spelled the way a call site means it. */
  ret(cond: ArmCond = "al"): this {
    return this.bx(LR, cond);
  }

  // --- program status --------------------------------------------------------

  /** `mrs rd, cpsr` (or `spsr`). */
  mrs(rd: number, spsr = false, cond: ArmCond = "al"): this {
    return this.emit(
      AsmArm.cc(cond) | 0x010f0000 | ((spsr ? 1 : 0) << 22) | (AsmArm.reg(rd, "destination") << 12),
    );
  }

  /**
   * `msr cpsr_<mask>, rm` (or `spsr`).
   *
   * The mask names which byte fields the write reaches: bit 0 is control (the
   * mode and interrupt bits), bit 3 is flags. Writing the whole register when
   * only the interrupt mask was meant is how a handler comes back in the wrong
   * processor mode.
   */
  msr(rm: number, mask = 0b1001, spsr = false, cond: ArmCond = "al"): this {
    return this.emit(
      AsmArm.cc(cond) |
        0x0120f000 |
        ((spsr ? 1 : 0) << 22) |
        ((mask & 0xf) << 16) |
        AsmArm.reg(rm, "source"),
    );
  }

  /** `msr cpsr_<mask>, #imm`. */
  msrImm(value: number, mask = 0b1001, spsr = false, cond: ArmCond = "al"): this {
    const field = encodeArmImm(value);
    if (field === undefined) throw new AsmError(`#${value} is not an ARM immediate`);
    return this.emit(
      AsmArm.cc(cond) | 0x0320f000 | ((spsr ? 1 : 0) << 22) | ((mask & 0xf) << 16) | field,
    );
  }

  /** `swi #imm` — the BIOS call, which is how a GBA program reaches `Halt`. */
  swi(comment: number, cond: ArmCond = "al"): this {
    return this.emit(AsmArm.cc(cond) | (0xf << 24) | (comment & 0xffffff));
  }

  // --- coprocessor -----------------------------------------------------------

  /**
   * `mcr p<cp>, op1, rd, c<crn>, c<crm>, op2` — a write to a coprocessor.
   *
   * The only coprocessor either console has is the DS's CP15, and the only
   * things written to it are the caches, the protection regions and the two
   * tightly-coupled memories. A Game Boy Advance has none at all.
   */
  mcr(
    cp: number,
    op1: number,
    rd: number,
    crn: number,
    crm: number,
    op2 = 0,
    cond: ArmCond = "al",
  ): this {
    return this.emit(
      AsmArm.cc(cond) |
        (0xe << 24) |
        ((op1 & 7) << 21) |
        ((crn & 0xf) << 16) |
        (AsmArm.reg(rd, "source") << 12) |
        ((cp & 0xf) << 8) |
        ((op2 & 7) << 5) |
        (1 << 4) |
        (crm & 0xf),
    );
  }

  /** `mrc p<cp>, op1, rd, c<crn>, c<crm>, op2` — a read from a coprocessor. */
  mrc(
    cp: number,
    op1: number,
    rd: number,
    crn: number,
    crm: number,
    op2 = 0,
    cond: ArmCond = "al",
  ): this {
    return this.emit(
      AsmArm.cc(cond) |
        (0xe << 24) |
        ((op1 & 7) << 21) |
        (1 << 20) |
        ((crn & 0xf) << 16) |
        (AsmArm.reg(rd, "destination") << 12) |
        ((cp & 0xf) << 8) |
        ((op2 & 7) << 5) |
        (1 << 4) |
        (crm & 0xf),
    );
  }

  // --- constants -------------------------------------------------------------

  /**
   * `ldr rd, =value` — one instruction now, one pool word at the next
   * {@link ltorg}.
   *
   * This is the machine's answer to "a 32-bit constant does not fit in a 32-bit
   * instruction", and it is why an ARM emitter has a shape the other five do not.
   * The load is PC-relative with a twelve-bit unsigned displacement, so the pool
   * it reads from has to be within 4 KiB *ahead* of it — which is a property of
   * how often the backend flushes, not of this call.
   */
  ldrConst(rd: number, value: Ref, cond: ArmCond = "al"): this {
    const key =
      typeof value === "number"
        ? `#${(value >>> 0).toString(16)}`
        : typeof value === "string"
          ? `@${value}+0`
          : `@${value.label}+${value.addend}`;
    this.pool.push({ at: this.code.length, value, key });
    // The field is filled in by `ltorg`; the base register and the load bit are
    // what make it an instruction rather than a placeholder.
    return this.emit(AsmArm.cc(cond) | 0x059f0000 | (AsmArm.reg(rd, "destination") << 12));
  }

  /**
   * Put a 32-bit value in a register by whichever means is cheapest.
   *
   * `mov` if the rotation can express it, `mvn` if it can express the
   * complement, and a pooled load otherwise — one instruction in every case, so
   * the length is fixed at the call and the one-pass rule holds. A label always
   * takes the pool, because its address is not known yet.
   */
  movImm32(rd: number, value: Ref, cond: ArmCond = "al"): this {
    if (typeof value === "number") {
      if (fitsArmImm(value)) return this.mov(rd, armImm(value), cond);
      if (fitsArmImm(~value >>> 0)) return this.mvn(rd, armImm(~value >>> 0), cond);
    }
    return this.ldrConst(rd, value, cond);
  }

  /**
   * Emit the pending literal pool here.
   *
   * Call it after every routine, past the instruction that returns — a pool in
   * the middle of a reachable instruction stream would be *executed*. Identical
   * values share one word, and a load that cannot reach the pool it was given is
   * an {@link AsmError} naming this method, because the fix is always another
   * flush rather than a different instruction.
   */
  ltorg(): this {
    if (this.pool.length === 0) return this;
    this.align(4);
    const placed = new Map<string, number>();
    const pending = this.pool;
    // Cleared before emitting, so a value emitted into the pool can never queue
    // a second entry against the pool it is already part of.
    this.pool = [];
    for (const entry of pending) {
      let address = placed.get(entry.key);
      if (address === undefined) {
        address = this.pc;
        placed.set(entry.key, address);
        this.dw(entry.value);
      }
      const delta = address - (this.origin + entry.at + 8);
      if (delta < 0 || delta > 0xfff) {
        throw new AsmError(
          `a pooled constant is ${delta} bytes from the load that reads it — ` +
            `call ltorg() more often`,
        );
      }
      this.code[entry.at] = delta & 0xff;
      this.code[entry.at + 1] =
        ((this.code[entry.at + 1] as number) & 0xf0) | ((delta >> 8) & 0x0f);
    }
    return this;
  }

  /** Constants waiting for a pool — what a backend checks before a long table. */
  get pending(): number {
    return this.pool.length;
  }

  /**
   * How far the *oldest* waiting constant's load is behind the current address,
   * or −1 when nothing is waiting.
   *
   * What a code generator needs to know that no other encoder here makes it
   * ask: a pooled load reaches 4 KiB ahead of itself, so a routine longer than
   * that cannot put its whole pool at the end. An emitter watches this and
   * flushes early — over a branch, since a pool in a reachable stream is
   * executed — and the alternative is an {@link AsmError} in the middle of a
   * game that happened to grow.
   */
  get poolAge(): number {
    const oldest = this.pool[0];
    return oldest === undefined ? -1 : this.pc - (this.origin + oldest.at);
  }

  // --- finishing -------------------------------------------------------------

  /**
   * Resolve every reference and return the assembled bytes.
   *
   * Any constants still pending get a final pool, which is right for the last
   * routine in a program and wrong for a program that never flushed — and the
   * second of those fails here rather than quietly, because the range check
   * happens either way.
   */
  assemble(): Uint8Array {
    this.ltorg();
    for (const fixup of this.fixups) {
      const base = this.labels.get(fixup.ref.label);
      if (base === undefined) throw new AsmError(`undefined label '${fixup.ref.label}'`);
      const value = base + fixup.ref.addend;
      switch (fixup.kind) {
        case "abs32":
          this.code[fixup.at] = value & 0xff;
          this.code[fixup.at + 1] = (value >>> 8) & 0xff;
          this.code[fixup.at + 2] = (value >>> 16) & 0xff;
          this.code[fixup.at + 3] = (value >>> 24) & 0xff;
          break;
        case "abs16":
          this.code[fixup.at] = value & 0xff;
          this.code[fixup.at + 1] = (value >>> 8) & 0xff;
          break;
        case "rel24": {
          const delta = value - fixup.base;
          if (delta % 4 !== 0) throw new AsmError(`branch to '${fixup.ref.label}' is not aligned`);
          const offset = delta >> 2;
          if (offset < -0x800000 || offset > 0x7fffff) {
            throw new AsmError(`branch to '${fixup.ref.label}' is ${delta} bytes away`);
          }
          this.code[fixup.at] = offset & 0xff;
          this.code[fixup.at + 1] = (offset >> 8) & 0xff;
          this.code[fixup.at + 2] = (offset >> 16) & 0xff;
          break;
        }
      }
    }
    return Uint8Array.from(this.code);
  }

  /** Every label and its address — the map a profiler or a harness reads. */
  symbols(): ReadonlyMap<string, number> {
    return new Map(this.labels);
  }
}
