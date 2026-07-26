/**
 * The NES cartridge wrapper: the iNES header, NROM's sizes, and the vectors.
 *
 * Here rather than in a caller for the reason `gb-cart.ts` is: more than one
 * backend assembles NES ROMs with `core`'s own {@link Asm6502} — the Demotic
 * game backend, and the audio driver when its NES half lands — and a sixteen-byte
 * header implemented twice is a header that disagrees in one byte in one of them.
 *
 * **NROM-256**, which is the mapper-less cartridge: 32 KiB of program at
 * `$8000`–`$FFFF` and 8 KiB of character ROM the PPU addresses directly. There
 * is no bank switching and no cartridge RAM, so a game's whole state lives in
 * the console's 2 KiB — which is the constraint the backend's RAM plan is
 * written against, and the reason this is `mapper 0` on purpose rather than for
 * want of a reason to use another.
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

/** Bytes of character ROM the PPU sees: two 4 KiB pattern tables. */
export const NES_CHR_SIZE = 0x2000;

/** Bytes of the iNES header that precede the program. */
export const NES_HEADER_SIZE = 16;

/** Where the program is mapped in the CPU's address space. */
export const NES_PRG_ORIGIN = 0x8000;

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
}

/**
 * Wrap a program and a character bank into a complete `.nes` file.
 *
 * `prg` must be exactly {@link NES_PRG_SIZE} and `chr` exactly
 * {@link NES_CHR_SIZE}: NROM has no short banks, and padding one here rather
 * than in the caller is how the two builders that produce them stay identical.
 */
export function packInesRom(
  prg: Uint8Array,
  chr: Uint8Array,
  options: NesHeaderOptions = {},
): Uint8Array {
  if (prg.length !== NES_PRG_SIZE) {
    throw new Error(`an NROM program is ${NES_PRG_SIZE} bytes, not ${prg.length}`);
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
  // Flags 6: mapper 0, no trainer, no battery; bit 0 is the mirroring.
  rom[6] = options.mirroring === "vertical" ? 0x01 : 0x00;
  rom[7] = 0x00; // mapper high nibble, NES 2.0 marker
  rom.set(prg, NES_HEADER_SIZE);
  rom.set(chr, NES_HEADER_SIZE + prg.length);
  return rom;
}

/** Where the program's bytes start in a packed `.nes` file. */
export const NES_PRG_OFFSET = NES_HEADER_SIZE;

/** Where the character bank's bytes start in a packed `.nes` file. */
export const NES_CHR_OFFSET = NES_HEADER_SIZE + NES_PRG_SIZE;
