/**
 * The Virtual Boy cartridge wrapper: the header and the vector table, both at
 * the *top* of the image.
 *
 * Here rather than in a caller for the reason `ngp-cart.ts` and `gb-cart.ts`
 * are: more than one builder wraps V810 code into a cartridge for this console —
 * the Demotic game backend, and the display-ROM harness's builder at the CLI
 * edge — and a header implemented twice is a header that disagrees in one byte
 * in one of them.
 *
 * Three things about this cartridge are the console's rather than a restatement:
 *
 *   - **The program is not where it was assembled.** The address bus is 27 bits,
 *     so `$FFFFFFF0` — where the processor fetches its first instruction — *is*
 *     `$07FFFFF0`, the top of the cartridge region, whatever size the board is.
 *     A 1 MiB cartridge therefore answers the reset fetch from its own last
 *     sixteen bytes, mirrored sixteen times up the address space. So the reset
 *     stub cannot jump relatively: it builds the entry address with
 *     `movhi`/`movea` and jumps through a register, which lands in the right
 *     place from whichever mirror the fetch came from.
 *   - **A vector is sixteen bytes of code, not a pointer.** The last 512 bytes
 *     are thirty-two slots the hardware jumps *to*, so installing a handler
 *     means assembling a jump into one — the Neo Geo Pocket's pointer-in-RAM
 *     arrangement inverted. {@link VB_VECTOR_VIP} is the one a frame-clocked
 *     runtime wants.
 *   - **The header sits below the vectors, not at the start.** Thirty-two bytes
 *     at `$FFFFFDE0`, which is `size - 0x220` into the image — so a cartridge's
 *     identity moves when its board size does, and a builder that stamped it at
 *     a fixed offset would write it into the middle of the program on every size
 *     but one.
 *
 * Sources: the Virtual Boy *Sacred Tech Scroll* (`vbtech`) — cartridge header
 * layout and the interrupt vector table; Planet Virtual Boy — *ROM header* wiki
 * page for the field order and widths.
 */

import { Asm810, R1 } from "./v810.js";
import { VB_ROM } from "./vb.js";

/** Bytes of vector table at the top of the cartridge. */
export const VB_VECTOR_BYTES = 0x200;

/** Bytes of header, immediately below the vectors. */
export const VB_HEADER_BYTES = 0x20;

/** Where the header begins, in the address space's own terms. */
export const VB_HEADER_ADDRESS = 0xfffffde0;

/** Where the vector table begins. */
export const VB_VECTOR_BASE = 0xfffffe00;

/** The pad-read interrupt's slot. */
export const VB_VECTOR_KEY = 0xfffffe00;
/** The timer's. */
export const VB_VECTOR_TIMER = 0xfffffe10;
/** The expansion port's. */
export const VB_VECTOR_EXPANSION = 0xfffffe20;
/** The link port's. */
export const VB_VECTOR_LINK = 0xfffffe30;
/** The video processor's — the one a frame-clocked runtime rides. */
export const VB_VECTOR_VIP = 0xfffffe40;
/** A division by zero. */
export const VB_VECTOR_ZERO_DIVIDE = 0xffffff80;
/** An invalid opcode. */
export const VB_VECTOR_INVALID = 0xffffff90;
/** `trap` with a vector of 16–31. */
export const VB_VECTOR_TRAP_HIGH = 0xffffffa0;
/** `trap` with a vector of 0–15. */
export const VB_VECTOR_TRAP_LOW = 0xffffffb0;
/** An address trap. */
export const VB_VECTOR_ADDRESS = 0xffffffc0;
/** A duplexed exception. */
export const VB_VECTOR_DUPLEX = 0xffffffd0;
/** Reset — where the processor starts. */
export const VB_VECTOR_RESET = 0xfffffff0;

/** Bytes in one vector slot. */
export const VB_VECTOR_SLOT = 0x10;

/**
 * Cartridge sizes, smallest first.
 *
 * Powers of two, because the board is decoded by masking rather than by
 * comparison — a cartridge that was not one would mirror unevenly and the reset
 * fetch would land somewhere that is not its own last sixteen bytes. These three
 * are the boards this console's games actually shipped on; a demade game takes
 * the smallest that holds it (`backend.ts` §Elastic cartridges).
 */
export const VB_ROM_SIZES: readonly number[] = [0x80000, 0x100000, 0x200000];

/** What to stamp in the header. */
export interface VbCartOptions {
  /** Twenty characters of title, padded with spaces and cut if longer. */
  title?: string;
  /** The two-character maker code. */
  maker?: string;
  /** The four-character game code. */
  code?: string;
  /** The revision byte. */
  version?: number;
  /**
   * Where the reset stub jumps. Defaults to {@link VB_ROM}, which is where
   * {@link packVbRom} puts the program's first byte.
   */
  entry?: number;
  /**
   * Where the video processor's interrupt lands, if the program takes one.
   *
   * A cartridge that omits it gets a vector that returns immediately, so an
   * interrupt enabled by accident is a lost frame rather than a crash.
   */
  vipHandler?: number;
  /** Bytes the cartridge holds — one of {@link VB_ROM_SIZES}. */
  size?: number;
}

/** Pad a field with spaces, or cut it to length — the header's own convention. */
function field(text: string, length: number): number[] {
  const out: number[] = [];
  for (let index = 0; index < length; index += 1) {
    const code = text.charCodeAt(index);
    out.push(Number.isNaN(code) || code < 0x20 || code > 0x7e ? 0x20 : code);
  }
  return out;
}

/**
 * The smallest board that holds a program of this size.
 *
 * Separate from {@link packVbRom} because a backend has to *ask* before it emits
 * — the header and the vectors are at the top of the image, so where they land
 * depends on how big the cartridge turned out to be.
 */
export function vbRomSize(bytes: number): number {
  const needed = bytes + VB_VECTOR_BYTES + VB_HEADER_BYTES;
  const size = VB_ROM_SIZES.find((candidate) => needed <= candidate);
  if (size === undefined) {
    throw new Error(
      `Virtual Boy program is ${bytes} bytes; the largest cartridge holds ${
        (VB_ROM_SIZES[VB_ROM_SIZES.length - 1] as number) - VB_VECTOR_BYTES - VB_HEADER_BYTES
      }`,
    );
  }
  return size;
}

/**
 * A jump to an absolute address, in one vector slot.
 *
 * Three instructions and ten bytes, against a slot of sixteen. It is absolute
 * rather than relative for the reason at the top of this file: a vector is
 * fetched through whichever mirror of the cartridge the address decoder landed
 * on, so a displacement computed against the image's assembled base would be
 * wrong by however far that mirror is from it.
 */
function jumpTo(target: number): Uint8Array {
  const asm = new Asm810(0);
  asm.movImm32(target | 0, R1);
  asm.jmp(R1);
  return asm.assemble();
}

/**
 * Wrap V810 code into a bootable cartridge.
 *
 * `code` is the program as it will sit at {@link VB_ROM}; this pads to the
 * smallest board that holds it and stamps the header and the vector table into
 * the top of the image. Padding is `$FF`, the erased state of a mask ROM's
 * flash-programmed cousins and what every commercial dump of this console shows.
 */
export function packVbRom(code: Uint8Array, options: VbCartOptions = {}): Uint8Array {
  const size = options.size ?? vbRomSize(code.length);
  if (!VB_ROM_SIZES.includes(size)) {
    throw new Error(`a Virtual Boy cartridge is ${VB_ROM_SIZES.join(", ")} bytes, not ${size}`);
  }
  const headerAt = size - VB_VECTOR_BYTES - VB_HEADER_BYTES;
  if (code.length > headerAt) {
    throw new Error(
      `Virtual Boy program is ${code.length} bytes; a ${size}-byte cartridge holds ${headerAt} below its header`,
    );
  }

  const rom = new Uint8Array(size).fill(0xff);
  rom.set(code, 0);

  // The header and the vectors are written over the fill rather than into it, so
  // every byte of both is deliberate.
  rom.fill(0, headerAt, size);

  rom.set(field(options.title ?? "", 20), headerAt);
  // Five reserved bytes at +20 stay zero.
  rom.set(field(options.maker ?? "  ", 2), headerAt + 25);
  rom.set(field(options.code ?? "    ", 4), headerAt + 27);
  rom[headerAt + 31] = options.version ?? 0;

  const slot = (address: number): number => size - (0x100000000 - address);
  rom.set(jumpTo(options.entry ?? VB_ROM), slot(VB_VECTOR_RESET));
  if (options.vipHandler !== undefined) {
    rom.set(jumpTo(options.vipHandler), slot(VB_VECTOR_VIP));
  } else {
    // `reti`, so an interrupt nothing asked for costs a frame rather than the
    // program: an empty slot is zeroes, which decode as `mov r0, r0` and run on
    // into whatever the next slot holds.
    const asm = new Asm810(0);
    asm.reti();
    rom.set(asm.assemble(), slot(VB_VECTOR_VIP));
  }
  return rom;
}
