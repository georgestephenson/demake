/**
 * The V30MZ encoder against the reference assembler.
 *
 * `v30mz.test.ts` pins hand-read encodings, which is what every encoder in
 * `core` gets and what catches a transcription error. This file is the second
 * oracle, and this architecture is the one that most wants it: an x86 operand is
 * a mod/reg/rm byte with three fields packed into eight bits and a displacement
 * whose *length* depends on its value, so a register written into the wrong
 * field still decodes as an instruction — just not the one that was meant. The
 * ARM encoder has the same shape of hazard and the same answer
 * (`arm-gnu.test.ts`).
 *
 * The reference is NASM, which the WonderSwan display-ROM harness already
 * provisions (doc 10, `tools/toolchains/install-nasm.sh`) — so this costs a
 * bare machine nothing and self-skips without it. Run `pnpm toolchains` to
 * exercise it.
 *
 * Every case here is an instruction with exactly one encoding, or one where the
 * shorter encoding is the one this file deliberately emits: NASM picks the
 * accumulator and sign-extended forms too, so agreeing with it is agreeing about
 * the *choice* as well as the bytes.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { abs, at, Asm30, romAbs, romAt } from "../src/asm/v30mz.js";

/** One instruction, spelled twice: for NASM, and for ours. */
interface Case {
  text: string;
  build: (asm: Asm30) => void;
}

const CASES: readonly Case[] = [
  // Moves, every addressing form.
  { text: "mov ax, bx", build: (a) => void a.mov("ax", "bx") },
  { text: "mov si, di", build: (a) => void a.mov("si", "di") },
  { text: "mov sp, bp", build: (a) => void a.mov("sp", "bp") },
  { text: "mov ax, 0x1234", build: (a) => void a.movi("ax", 0x1234) },
  { text: "mov di, 0xfe00", build: (a) => void a.movi("di", 0xfe00) },
  { text: "mov ax, [0x1234]", build: (a) => void a.movm("ax", abs(0x1234)) },
  { text: "mov bx, [0x1234]", build: (a) => void a.movm("bx", abs(0x1234)) },
  { text: "mov [0x1234], ax", build: (a) => void a.movmr(abs(0x1234), "ax") },
  { text: "mov [0x1234], dx", build: (a) => void a.movmr(abs(0x1234), "dx") },
  { text: "mov ax, [bx]", build: (a) => void a.movm("ax", at("bx")) },
  { text: "mov cx, [si]", build: (a) => void a.movm("cx", at("si")) },
  { text: "mov dx, [bp]", build: (a) => void a.movm("dx", at("bp")) },
  { text: "mov bx, [bx+si]", build: (a) => void a.movm("bx", at("bx+si")) },
  { text: "mov bp, [bp+di]", build: (a) => void a.movm("bp", at("bp+di")) },
  { text: "mov ax, [bx+4]", build: (a) => void a.movm("ax", at("bx", 4)) },
  { text: "mov ax, [bx-2]", build: (a) => void a.movm("ax", at("bx", -2)) },
  { text: "mov ax, [si+0x1234]", build: (a) => void a.movm("ax", at("si", 0x1234)) },
  { text: "mov [di+6], si", build: (a) => void a.movmr(at("di", 6), "si") },
  { text: "mov word [0x1234], 0x5678", build: (a) => void a.movmi(abs(0x1234), 0x5678) },
  { text: "mov word [bx+2], 0", build: (a) => void a.movmi(at("bx", 2), 0) },
  { text: "mov al, bl", build: (a) => void a.mov8("al", "bl") },
  { text: "mov ah, dh", build: (a) => void a.mov8("ah", "dh") },
  { text: "mov al, 0x7f", build: (a) => void a.movi8("al", 0x7f) },
  { text: "mov ch, 0xe0", build: (a) => void a.movi8("ch", 0xe0) },
  { text: "mov al, [0x1234]", build: (a) => void a.movm8("al", abs(0x1234)) },
  { text: "mov cl, [0x1234]", build: (a) => void a.movm8("cl", abs(0x1234)) },
  { text: "mov [0x1234], al", build: (a) => void a.movmr8(abs(0x1234), "al") },
  { text: "mov [0x1234], bh", build: (a) => void a.movmr8(abs(0x1234), "bh") },
  { text: "mov al, [bx+si+5]", build: (a) => void a.movm8("al", at("bx+si", 5)) },
  { text: "mov byte [bx+si+5], 3", build: (a) => void a.movmi8(at("bx+si", 5), 3) },
  { text: "mov byte [0x40], 0xff", build: (a) => void a.movmi8(abs(0x40), 0xff) },

  // Segments: the override prefix, and loading a segment register.
  { text: "mov al, [cs:bx]", build: (a) => void a.movm8("al", romAt("bx")) },
  { text: "mov ax, [cs:0x1234]", build: (a) => void a.movm("ax", romAbs(0x1234)) },
  { text: "mov bx, [cs:si+8]", build: (a) => void a.movm("bx", romAt("si", 8)) },
  { text: "mov ds, ax", build: (a) => void a.movsr("ds", "ax") },
  { text: "mov es, bx", build: (a) => void a.movsr("es", "bx") },
  { text: "mov ss, ax", build: (a) => void a.movsr("ss", "ax") },
  { text: "mov ax, ds", build: (a) => void a.movrs("ax", "ds") },
  { text: "mov dx, cs", build: (a) => void a.movrs("dx", "cs") },

  { text: "lea bx, [si+4]", build: (a) => void a.lea("bx", at("si", 4)) },
  { text: "lea di, [bx+si]", build: (a) => void a.lea("di", at("bx+si")) },
  { text: "xchg ax, bx", build: (a) => void a.xchg("ax", "bx") },
  { text: "xchg cx, ax", build: (a) => void a.xchg("cx", "ax") },
  { text: "xchg bx, dx", build: (a) => void a.xchg("bx", "dx") },

  // Stack.
  { text: "push ax", build: (a) => void a.push("ax") },
  { text: "push di", build: (a) => void a.push("di") },
  { text: "pop bp", build: (a) => void a.pop("bp") },
  { text: "push cs", build: (a) => void a.pushSeg("cs") },
  { text: "push ds", build: (a) => void a.pushSeg("ds") },
  { text: "pop es", build: (a) => void a.popSeg("es") },
  { text: "push word 0x1234", build: (a) => void a.pushi(0x1234) },
  { text: "pushf", build: (a) => void a.pushf() },
  { text: "popf", build: (a) => void a.popf() },
  { text: "pusha", build: (a) => void a.pusha() },
  { text: "popa", build: (a) => void a.popa() },

  // The ALU block: every operation once, then every addressing form.
  { text: "add ax, bx", build: (a) => void a.alu("add", "ax", "bx") },
  { text: "or cx, dx", build: (a) => void a.alu("or", "cx", "dx") },
  { text: "adc si, di", build: (a) => void a.alu("adc", "si", "di") },
  { text: "sbb bx, ax", build: (a) => void a.alu("sbb", "bx", "ax") },
  { text: "and dx, dx", build: (a) => void a.alu("and", "dx", "dx") },
  { text: "sub bp, sp", build: (a) => void a.alu("sub", "bp", "sp") },
  { text: "xor ax, ax", build: (a) => void a.alu("xor", "ax", "ax") },
  { text: "cmp si, bx", build: (a) => void a.alu("cmp", "si", "bx") },
  { text: "add ax, [0x100]", build: (a) => void a.aluM("add", "ax", abs(0x100)) },
  { text: "adc dx, [0x102]", build: (a) => void a.aluM("adc", "dx", abs(0x102)) },
  { text: "sub cx, [bx+2]", build: (a) => void a.aluM("sub", "cx", at("bx", 2)) },
  { text: "cmp ax, [cs:si]", build: (a) => void a.aluM("cmp", "ax", romAt("si")) },
  { text: "add [0x100], ax", build: (a) => void a.aluMR("add", abs(0x100), "ax") },
  { text: "adc [bx+2], dx", build: (a) => void a.aluMR("adc", at("bx", 2), "dx") },
  { text: "add ax, 5", build: (a) => void a.aluI("add", "ax", 5) },
  { text: "add ax, -1", build: (a) => void a.aluI("add", "ax", -1) },
  { text: "add ax, 0x1234", build: (a) => void a.aluI("add", "ax", 0x1234) },
  { text: "add bx, 0x1234", build: (a) => void a.aluI("add", "bx", 0x1234) },
  { text: "sub sp, 8", build: (a) => void a.aluI("sub", "sp", 8) },
  { text: "cmp di, 0x8000", build: (a) => void a.aluI("cmp", "di", 0x8000) },
  { text: "and word [0x100], 0x0fff", build: (a) => void a.aluMI("and", abs(0x100), 0x0fff) },
  { text: "add word [0x100], 5", build: (a) => void a.aluMI("add", abs(0x100), 5) },
  { text: "add al, bl", build: (a) => void a.alu8("add", "al", "bl") },
  { text: "or dh, cl", build: (a) => void a.alu8("or", "dh", "cl") },
  { text: "cmp al, [0x100]", build: (a) => void a.aluM8("cmp", "al", abs(0x100)) },
  { text: "and bl, [bx]", build: (a) => void a.aluM8("and", "bl", at("bx")) },
  { text: "or [0x100], al", build: (a) => void a.aluMR8("or", abs(0x100), "al") },
  { text: "or al, 0x80", build: (a) => void a.aluI8("or", "al", 0x80) },
  { text: "or bl, 0x80", build: (a) => void a.aluI8("or", "bl", 0x80) },
  { text: "cmp byte [0x1234], 5", build: (a) => void a.aluMI8("cmp", abs(0x1234), 5) },
  { text: "and byte [bx+1], 0xf0", build: (a) => void a.aluMI8("and", at("bx", 1), 0xf0) },

  { text: "test ax, bx", build: (a) => void a.test("ax", "bx") },
  { text: "test ax, 0x1234", build: (a) => void a.testI("ax", 0x1234) },
  { text: "test bx, 0x1234", build: (a) => void a.testI("bx", 0x1234) },
  { text: "test al, 1", build: (a) => void a.testI8("al", 1) },
  { text: "test bh, 0x40", build: (a) => void a.testI8("bh", 0x40) },
  { text: "test byte [0x100], 2", build: (a) => void a.testMI8(abs(0x100), 2) },

  { text: "inc ax", build: (a) => void a.inc("ax") },
  { text: "dec si", build: (a) => void a.dec("si") },
  { text: "inc word [0x100]", build: (a) => void a.incM(abs(0x100)) },
  { text: "dec word [bx]", build: (a) => void a.decM(at("bx")) },
  { text: "inc byte [0x100]", build: (a) => void a.incM8(abs(0x100)) },
  { text: "dec byte [bx+si]", build: (a) => void a.decM8(at("bx+si")) },

  { text: "not ax", build: (a) => void a.unary("not", "ax") },
  { text: "neg dx", build: (a) => void a.unary("neg", "dx") },
  { text: "mul bx", build: (a) => void a.unary("mul", "bx") },
  { text: "imul cx", build: (a) => void a.unary("imul", "cx") },
  { text: "div bx", build: (a) => void a.unary("div", "bx") },
  { text: "idiv si", build: (a) => void a.unary("idiv", "si") },
  { text: "neg word [0x100]", build: (a) => void a.unaryM("neg", abs(0x100)) },
  { text: "mul word [bx+2]", build: (a) => void a.unaryM("mul", at("bx", 2)) },
  { text: "neg al", build: (a) => void a.unary8("neg", "al") },
  { text: "cbw", build: (a) => void a.cbw() },
  { text: "cwd", build: (a) => void a.cwd() },

  // Shifts, including the immediate count that is the 80186's addition.
  { text: "shl ax, 1", build: (a) => void a.shift("shl", "ax") },
  { text: "shr bx, 1", build: (a) => void a.shift("shr", "bx") },
  { text: "sar dx, 1", build: (a) => void a.shift("sar", "dx") },
  { text: "rol si, 1", build: (a) => void a.shift("rol", "si") },
  { text: "rcr di, 1", build: (a) => void a.shift("rcr", "di") },
  { text: "shl ax, 4", build: (a) => void a.shift("shl", "ax", 4) },
  { text: "sar dx, 8", build: (a) => void a.shift("sar", "dx", 8) },
  { text: "shl ax, cl", build: (a) => void a.shift("shl", "ax", "cl") },
  { text: "sar bx, cl", build: (a) => void a.shift("sar", "bx", "cl") },
  { text: "shl al, 1", build: (a) => void a.shift8("shl", "al") },
  { text: "shr bh, 4", build: (a) => void a.shift8("shr", "bh", 4) },
  { text: "shl word [0x100], 1", build: (a) => void a.shiftM("shl", abs(0x100)) },
  { text: "sar word [bx], 2", build: (a) => void a.shiftM("sar", at("bx"), 2) },

  // Control flow that needs no label.
  { text: "jmp 0xf000:0x0000", build: (a) => void a.jmpFar(0xf000, 0x0000) },
  { text: "call 0xe000:0x1234", build: (a) => void a.callFar(0xe000, 0x1234) },
  { text: "retf", build: (a) => void a.retf() },
  { text: "jmp bx", build: (a) => void a.jmpr("bx") },
  { text: "ret", build: (a) => void a.ret() },
  { text: "iret", build: (a) => void a.iret() },

  // Strings, prefixed and bare.
  { text: "movsb", build: (a) => void a.movsb() },
  { text: "movsw", build: (a) => void a.movsw() },
  { text: "stosb", build: (a) => void a.stosb() },
  { text: "stosw", build: (a) => void a.stosw() },
  { text: "lodsb", build: (a) => void a.lodsb() },
  { text: "lodsw", build: (a) => void a.lodsw() },
  { text: "rep movsw", build: (a) => void a.rep().movsw() },
  { text: "rep stosw", build: (a) => void a.rep().stosw() },

  // Ports.
  { text: "out 0x60, al", build: (a) => void a.out8(0x60) },
  { text: "out 0x10, ax", build: (a) => void a.out16(0x10) },
  { text: "in al, 0xb5", build: (a) => void a.in8(0xb5) },
  { text: "in ax, 0xb5", build: (a) => void a.in16(0xb5) },
  { text: "out dx, al", build: (a) => void a.outDx8() },
  { text: "in al, dx", build: (a) => void a.inDx8() },

  // Flags and idling.
  { text: "cli", build: (a) => void a.cli() },
  { text: "sti", build: (a) => void a.sti() },
  { text: "cld", build: (a) => void a.cld() },
  { text: "std", build: (a) => void a.std() },
  { text: "clc", build: (a) => void a.clc() },
  { text: "stc", build: (a) => void a.stc() },
  { text: "hlt", build: (a) => void a.hlt() },
  { text: "nop", build: (a) => void a.nop() },
];

/**
 * Branches, separately: a relative target is what the label is *for*, so each of
 * these is a two-instruction program whose second instruction is the target.
 */
const BRANCHES: readonly Case[] = [
  { text: "jmp near .t\n.t: nop", build: (a) => void a.jmp("t").label("t").nop() },
  { text: "jmp short .t\n.t: nop", build: (a) => void a.jmpShort("t").label("t").nop() },
  { text: "jz .t\n.t: nop", build: (a) => void a.jcc("z", "t").label("t").nop() },
  { text: "jnz .t\n.t: nop", build: (a) => void a.jcc("nz", "t").label("t").nop() },
  { text: "jl .t\n.t: nop", build: (a) => void a.jcc("l", "t").label("t").nop() },
  { text: "jge .t\n.t: nop", build: (a) => void a.jcc("ge", "t").label("t").nop() },
  { text: "jle .t\n.t: nop", build: (a) => void a.jcc("le", "t").label("t").nop() },
  { text: "jg .t\n.t: nop", build: (a) => void a.jcc("g", "t").label("t").nop() },
  { text: "jb .t\n.t: nop", build: (a) => void a.jcc("b", "t").label("t").nop() },
  { text: "jae .t\n.t: nop", build: (a) => void a.jcc("ae", "t").label("t").nop() },
  { text: "jbe .t\n.t: nop", build: (a) => void a.jcc("be", "t").label("t").nop() },
  { text: "ja .t\n.t: nop", build: (a) => void a.jcc("a", "t").label("t").nop() },
  { text: "js .t\n.t: nop", build: (a) => void a.jcc("s", "t").label("t").nop() },
  { text: "jns .t\n.t: nop", build: (a) => void a.jcc("ns", "t").label("t").nop() },
  { text: "jo .t\n.t: nop", build: (a) => void a.jcc("o", "t").label("t").nop() },
  { text: "call .t\n.t: nop", build: (a) => void a.call("t").label("t").nop() },
  { text: "loop .t\n.t: nop", build: (a) => void a.loop("t").label("t").nop() },
];

const ALL = [...CASES, ...BRANCHES];

/** Assemble the whole battery with NASM, or report that it is not installed. */
function reference(): Uint8Array | undefined {
  const dir = mkdtempSync(join(tmpdir(), "demake-v30mz-"));
  // Each case gets a label of its own so `.t` is local to it — NASM scopes a
  // dot-label to the last global one, which is exactly the isolation wanted.
  const body = ALL.map((entry, index) => `c${index}:\n${entry.text}`).join("\n");
  writeFileSync(join(dir, "battery.asm"), `bits 16\norg 0\n${body}\n`);
  try {
    execFileSync("nasm", ["-f", "bin", "-o", join(dir, "battery.bin"), join(dir, "battery.asm")]);
  } catch {
    return undefined;
  }
  return new Uint8Array(readFileSync(join(dir, "battery.bin")));
}

const REFERENCE = reference();

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(" ");

describe.skipIf(REFERENCE === undefined)("the V30MZ encoder against NASM", () => {
  it("assembles the same bytes, instruction for instruction", () => {
    const expected = REFERENCE as Uint8Array;
    const mismatches: string[] = [];
    let offset = 0;
    for (const entry of ALL) {
      const asm = new Asm30();
      entry.build(asm);
      const ours = asm.assemble();
      const theirs = expected.subarray(offset, offset + ours.length);
      if (hex(ours) !== hex(theirs)) {
        mismatches.push(`${entry.text.split("\n")[0]}: nasm ${hex(theirs)}, ours ${hex(ours)}`);
        // Lengths have diverged or the stream has, so everything after this is
        // being compared against the wrong bytes: one honest failure beats a
        // hundred consequential ones.
        break;
      }
      offset += ours.length;
    }
    expect(mismatches).toEqual([]);
    if (mismatches.length === 0) expect(offset).toBe(expected.length);
  });
});
