/**
 * The NES cartridge wrapper: the iNES header, NROM's sizes, and the vectors.
 *
 * Here rather than in a caller for the reason `gb-cart.ts` is: more than one
 * backend assembles NES ROMs with `core`'s own {@link Asm6502} — the Demotic
 * game backend, and the audio driver when its NES half lands — and a sixteen-byte
 * header implemented twice is a header that disagrees in one byte in one of them.
 *
 * **NROM**, which is the mapper-less cartridge, and it came on two boards: 32 KiB
 * of program at `$8000`–`$FFFF` (NROM-256) or 16 KiB mirrored across both halves
 * of that window (NROM-128). Either way there is 8 KiB of character ROM the PPU
 * addresses directly, no bank switching and no cartridge RAM — so a game's whole
 * state lives in the console's 2 KiB, which is the constraint the backend's RAM
 * plan is written against and the reason this is `mapper 0` on purpose rather
 * than for want of a reason to use another.
 *
 * **The two boards are what makes this cartridge elastic**, and the difference is
 * the origin rather than the code: a 16 KiB image is mapped at `$C000` *and* at
 * `$8000`, so a program assembled for the high mirror finds its vectors at the top
 * of its own image and reads back byte for byte the same as the 32 KiB one would.
 * A game that fits gets the smaller board, which is half the file and the board a
 * game this size actually shipped on.
 *
 * Unlike the Game Boy's, this header has no checksums and no logo: nothing about
 * it is copyrighted and nothing about it is computed, so it is data rather than
 * an algorithm. What it does carry is **nametable mirroring**, which is a
 * cartridge wiring decision the program cannot change — so a game that scrolls
 * horizontally has to ask for vertical mirroring here, before a line of its code
 * is emitted.
 *
 * Source: NESdev Wiki — iNES (https://www.nesdev.org/wiki/INES) and NROM
 * (https://www.nesdev.org/wiki/NROM).
 */

/** Bytes of program in an NROM-256 cartridge, mapped at `$8000`. */
export const NES_PRG_SIZE = 0x8000;

/**
 * Program sizes an NROM cartridge came in, smallest first.
 *
 * NROM-128 and NROM-256, and nothing between them: the board carries one mask ROM
 * and the PPU's address decoding mirrors a short one across the window. A builder
 * picks the first that holds the program, which is how a small game ends up on the
 * board a small game shipped on.
 */
export const NES_PRG_SIZES: readonly number[] = [0x4000, 0x8000];

/**
 * **MMC1**, which is the cartridge a game reaches for when NROM runs out.
 *
 * Two things, and a demade game needs both. Sixteen kilobytes of program are
 * switched at `$8000` while the top sixteen stay put — so the vectors, the boot
 * and everything an always-mapped address reaches live at `$C000` and the rest is
 * paged, which is the Game Boy's arrangement with the halves the other way up.
 * And the board carries **eight kilobytes of RAM at `$6000`**, which is the only
 * reason a game with four levels has anywhere to keep its state: the console's
 * own two kilobytes are what an NROM game gets, and they are the first wall this
 * console hits (doc 13 §Banked cartridges).
 *
 * The register is written a bit at a time — five stores to anywhere in the window,
 * bit 0 each, with the *last* address deciding which of four registers the five
 * bits land in. That is why a cartridge here never touches the mapper from an
 * interrupt: a sequence broken in the middle leaves a state no caller can predict.
 *
 * Source: NESdev Wiki — MMC1 (https://www.nesdev.org/wiki/MMC1).
 */
export const NES_MAPPER_MMC1 = 1;

/**
 * Program sizes an MMC1 cartridge came in, smallest first.
 *
 * From 32 KiB — where the board is pointless but the header is legal — up to the
 * 256 KiB its four PRG bank bits reach. Half a megabyte is SUROM, which steals a
 * CHR line for the fifth bit and is a different board rather than a bigger one;
 * no game here is close, so it is absent rather than half-implemented.
 */
export const NES_MMC1_PRG_SIZES: readonly number[] = [0x8000, 0x10000, 0x20000, 0x40000];

/** Bytes of program in the largest MMC1 cartridge this builder writes. */
export const NES_MMC1_PRG_MAX = NES_MMC1_PRG_SIZES[NES_MMC1_PRG_SIZES.length - 1] as number;

/** Bytes of the switchable window, which is where a paged unit is assembled. */
export const NES_BANK_SIZE = 0x4000;

/** Where the switchable window starts, and where the fixed half does. */
export const NES_BANK_WINDOW = 0x8000;
export const NES_FIXED_WINDOW = 0xc000;

/** The eight kilobytes of cartridge RAM an MMC1 board carries. */
export const NES_PRG_RAM = { start: 0x6000, end: 0x8000 } as const;

/** Bytes of character ROM the PPU sees: two 4 KiB pattern tables. */
export const NES_CHR_SIZE = 0x2000;

/** Bytes of the iNES header that precede the program. */
export const NES_HEADER_SIZE = 16;

/** Where an NROM-256 program is mapped in the CPU's address space. */
export const NES_PRG_ORIGIN = 0x8000;

/**
 * Where a program of `size` bytes is assembled.
 *
 * The image ends at `$FFFF` whichever board it is on, because that is where the
 * vectors are — so a 16 KiB program is assembled at `$C000` and reached through
 * the high mirror. Assembling it at `$8000` would put its vectors at `$BFFA`,
 * which the CPU never reads.
 */
export function nesPrgOrigin(size: number): number {
  return 0x10000 - size;
}

/**
 * The three vectors at the top of the program, in the order the CPU reads them.
 *
 * There is no reset routine at a fixed address the way the Game Boy has an entry
 * point at `$0100`: the CPU takes the address from `$FFFC`. So the last six bytes
 * of the cartridge are what makes a ROM bootable, and a builder that forgets
 * them produces something that jumps into whatever the padding is.
 */
export const NES_VECTORS = { nmi: 0xfffa, reset: 0xfffc, irq: 0xfffe } as const;

/**
 * How the cartridge wires the PPU's two nametables into its four addresses.
 *
 * `vertical` puts them side by side, which gives 512 pixels of horizontal room
 * and is what a side-scrolling game needs; `horizontal` stacks them for vertical
 * scrolling. NROM has no way to switch, so the choice is per cartridge.
 */
export type NesMirroring = "horizontal" | "vertical";

/** What a cartridge declares. */
export interface NesHeaderOptions {
  mirroring?: NesMirroring;
  /**
   * Which mapper the board carries: `0` (NROM) unless said otherwise.
   *
   * The *board* rather than a preference, so the sizes this accepts follow from
   * it — an NROM program is one of two lengths and an MMC1 one is any power of
   * two up to 256 KiB. A builder that declared one and shipped the other would
   * produce a cartridge whose reset vector is not where the console looks.
   */
  mapper?: number;
}

/**
 * Wrap a program and a character bank into a complete `.nes` file.
 *
 * `prg` must be one of {@link NES_PRG_SIZES} and `chr` exactly
 * {@link NES_CHR_SIZE}: NROM has no short banks, and padding one here rather
 * than in the caller is how the two builders that produce them stay identical.
 * The board follows from the length — a 16 KiB program is an NROM-128 and the
 * header's bank count says so — so a builder cannot declare one and ship the
 * other.
 */
export function packInesRom(
  prg: Uint8Array,
  chr: Uint8Array,
  options: NesHeaderOptions = {},
): Uint8Array {
  const mapper = options.mapper ?? 0;
  const sizes = mapper === NES_MAPPER_MMC1 ? NES_MMC1_PRG_SIZES : NES_PRG_SIZES;
  if (!sizes.includes(prg.length)) {
    const board = mapper === NES_MAPPER_MMC1 ? "an MMC1" : "an NROM";
    throw new Error(
      `${board} program is ${sizes.map((n) => n / 1024 + " KiB").join(" or ")}` +
        `, not ${prg.length} bytes`,
    );
  }
  if (chr.length !== NES_CHR_SIZE) {
    throw new Error(`an NROM character bank is ${NES_CHR_SIZE} bytes, not ${chr.length}`);
  }
  const rom = new Uint8Array(NES_HEADER_SIZE + prg.length + chr.length);
  rom[0] = 0x4e; // 'N'
  rom[1] = 0x45; // 'E'
  rom[2] = 0x53; // 'S'
  rom[3] = 0x1a;
  rom[4] = prg.length / 0x4000; // 16 KiB program banks
  rom[5] = chr.length / 0x2000; // 8 KiB character banks
  // Flags 6: no trainer, no battery; bit 0 is the mirroring and the high nibble
  // is the mapper's low four bits.
  rom[6] = (options.mirroring === "vertical" ? 0x01 : 0x00) | ((mapper & 0x0f) << 4);
  rom[7] = mapper & 0xf0; // the mapper's high nibble; no NES 2.0 marker
  rom.set(prg, NES_HEADER_SIZE);
  rom.set(chr, NES_HEADER_SIZE + prg.length);
  return rom;
}

/** Where the program's bytes start in a packed `.nes` file. */
export const NES_PRG_OFFSET = NES_HEADER_SIZE;

/**
 * Where the character bank's bytes start in a packed `.nes` file.
 *
 * A function rather than a constant, because the program in front of it is one
 * board or the other: the header's own bank count is what says which, so a reader
 * that asks the cartridge cannot be told the wrong answer by a builder that chose
 * the small board.
 */
export function nesChrOffset(rom: Uint8Array): number {
  return NES_HEADER_SIZE + (rom[4] as number) * 0x4000;
}
