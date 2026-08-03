/**
 * The PC Engine's cartridge, which is barely one.
 *
 * A HuCard has no header, no checksum, no title field and no vendor logo: it is
 * an image of 8 KiB banks that the CPU's `MPR` registers map wherever a program
 * asks for them. The only structure the *console* imposes is where execution
 * begins — the five vectors in the last ten bytes of bank 0, which reset leaves
 * mapped at `$E000` because `MPR7` powers up holding bank zero.
 *
 * That makes this file the shortest cartridge wrapper here, and it makes the
 * elastic-cartridge rule (`demotic/src/codegen/backend.ts` §Elastic cartridges)
 * unusually literal: the boards this console shipped on run from 128 KiB to a
 * megabyte and a cartridge is the smallest of them that holds the game. There is
 * no size code to write and nothing to patch, so growing one really is "the same
 * bytes, in a bigger array".
 *
 * The one thing that is *not* a free choice is which bank the program lives in.
 * Bank 0 has to end with the vectors, so the code goes there and the data above
 * it — which is also why {@link PCE_BANK_SIZE} is the unit everything here counts
 * in rather than the cartridge's own length.
 *
 * Sources: Archaic Pixels — HuCard format and the HuC6280 reset vectors.
 */

/** Bytes in one mapper page: the granularity `tam` deals in. */
export const PCE_BANK_SIZE = 0x2000;

/**
 * Cartridge sizes this console shipped, smallest first.
 *
 * Every one is a whole number of banks and every one after the first is a power
 * of two, because a HuCard's address lines are wired straight through: a size the
 * hardware never had would boot in an emulator and read as mirrored nonsense on a
 * console, which is the difference this list exists to keep
 * (`backend.ts` §Elastic cartridges).
 */
export const PCE_ROM_SIZES: readonly number[] = [
  0x20000, // 128 KiB — the smallest board with games on it
  0x40000, // 256 KiB
  0x60000, // 384 KiB — three of the above; a handful of titles
  0x80000, // 512 KiB
  0x100000, // 1 MiB, the largest a plain HuCard reaches
];

/** The largest cartridge this builder makes. */
export const PCE_ROM_SIZE = PCE_ROM_SIZES[PCE_ROM_SIZES.length - 1] as number;

/**
 * Where the program is assembled, and therefore where its `tam` must put bank 0.
 *
 * `MPR7` holds bank 0 at reset and the vectors are read through it, so the code
 * bank is at `$E000` before a program can say otherwise — and a program that
 * moved it would have to be assembled twice to find out where it had gone.
 */
export const PCE_CODE_ORIGIN = 0xe000;

/** The five vectors, in the order the CPU reads them from `$FFF6`. */
export const PCE_VECTORS = ["irq2", "irq1", "timer", "nmi", "reset"] as const;

/** Bytes the vector block takes: five addresses, `$FFF6` to `$FFFF`. */
export const PCE_VECTOR_BYTES = PCE_VECTORS.length * 2;

/** Bytes of bank 0 a program may use: everything below its own vectors. */
export const PCE_CODE_SIZE = PCE_BANK_SIZE - PCE_VECTOR_BYTES;

/** What a cartridge needs beyond its code and data. */
export interface PceCartOptions {
  /** Address of each vector, by name; anything absent reads as `$0000`. */
  vectors: Partial<Record<(typeof PCE_VECTORS)[number], number>>;
}

/**
 * Wrap a program into a HuCard image.
 *
 * `banks` is the whole cartridge in bank order — bank 0's code first, then
 * whatever the build put above it — and this pads to the smallest board that
 * holds it and writes the vectors into bank 0's last ten bytes. Padding is `$FF`
 * rather than zero because that is what an unprogrammed mask ROM reads as, and a
 * program that ran off its own end would then hit `$FF` (`bbs7`) rather than
 * `brk`, which is a livelock a debugger can see instead of a reset loop.
 */
export function packHuCard(banks: Uint8Array, options: PceCartOptions): Uint8Array {
  const size = PCE_ROM_SIZES.find((bytes) => banks.length <= bytes);
  if (size === undefined) {
    throw new Error(`a HuCard holds ${PCE_ROM_SIZE} bytes and this image is ${banks.length}`);
  }
  const rom = new Uint8Array(size).fill(0xff);
  rom.set(banks, 0);
  // The vectors are the last ten bytes of bank 0, which reset maps at `$E000`.
  const base = PCE_BANK_SIZE - PCE_VECTOR_BYTES;
  for (const [index, name] of PCE_VECTORS.entries()) {
    const target = options.vectors[name] ?? 0;
    rom[base + index * 2] = target & 0xff;
    rom[base + index * 2 + 1] = (target >> 8) & 0xff;
  }
  return rom;
}
