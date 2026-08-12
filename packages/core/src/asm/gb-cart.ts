/**
 * The Game Boy cartridge wrapper: size, header fields, both checksums.
 *
 * Two backends assemble Game Boy ROMs with `core`'s own {@link Asm} — the
 * Demotic game backend and the audio driver — and a cartridge header is exactly
 * the kind of small, exactly-specified thing that must not be implemented twice.
 * A second copy would not disagree loudly; it would disagree in one byte, in one
 * of the two, and the symptom would be a ROM that boots in an emulator and not
 * on hardware.
 *
 * Checksums are computed and never authored, which is why they are here rather
 * than in a caller's options: a builder cannot produce an invalid header by
 * omission.
 *
 * The Nintendo boot logo area is left as zeros. We ship no copyrighted data, so
 * a built ROM direct-boots in emulators (including `@demake/dmg` and the
 * libretro cores) and does not boot on original hardware; the CLI's
 * `--boot-logo` runs `rgbfix` for anyone who needs the latter.
 *
 * Source: Pan Docs — The Cartridge Header: https://gbdev.io/pandocs/The_Cartridge_Header.html
 */

/**
 * Bytes in a mapper-less Game Boy cartridge.
 *
 * The size field's smallest code *is* 32 KiB and every code above it names a
 * cartridge with a memory bank controller in it, so a ROM-only Game Boy
 * cartridge is 32 KiB and nothing else. Two banks, both mapped, `$0000`–`$7FFF`.
 * Shrinking below it would mean a cartridge that describes a size it does not
 * have; growing past it means declaring a mapper, which is {@link MBC5}.
 */
export const GB_ROM_SIZE = 0x8000;

/** Bytes in one Game Boy ROM bank, which is also the size of each of the two windows. */
export const GB_BANK_SIZE = 0x4000;

/**
 * Where the switchable window begins.
 *
 * Bank 0 is wired to `$0000`–`$3FFF` and never moves, because that is where the
 * interrupt vectors, the entry point and the header are — a mapper that could
 * page the reset vector out would be a mapper nothing could recover from. So
 * everything a banked cartridge shares between banks lives below this address
 * and everything it pages lives above it.
 */
export const GB_BANK_WINDOW = 0x4000;

/**
 * The MBC5 registers, which are ranges of the ROM's own address space.
 *
 * There is nowhere else to put them: the cartridge sees only the addresses the
 * console drives, so a mapper is programmed by *writing to ROM* and watching
 * which quarter of it the write landed in. Two registers carry the ROM bank
 * because the number is nine bits — 512 banks, which is what makes this the
 * controller with the largest cartridges rather than the most features.
 */
export const MBC5 = {
  /** `$0000`–`$1FFF`: `$0A` in the low nibble enables cartridge RAM, anything else disables it. */
  ramEnable: 0x0000,
  /** `$2000`–`$2FFF`: the low eight bits of the ROM bank. */
  romBankLow: 0x2000,
  /** `$3000`–`$3FFF`: bit 8 of the ROM bank, in bit 0. */
  romBankHigh: 0x3000,
  /** `$4000`–`$5FFF`: the cartridge RAM bank. */
  ramBank: 0x4000,
  /** What `ramEnable` has to be written to open cartridge RAM. */
  ramEnableValue: 0x0a,
} as const;

/**
 * Cartridge sizes the header can describe, smallest first.
 *
 * A power of two from 32 KiB up, because the size byte is a *code* — `$00` is
 * two banks and each code above it doubles — so there is nothing between them to
 * pick. Thirty-two kilobytes is the ROM-only board and everything above it needs
 * a controller; MBC5 reaches the top of this list, which is why it is the one
 * this project declares (§{@link MBC5}).
 */
export const GB_ROM_SIZES: readonly number[] = [
  0x8000, 0x10000, 0x20000, 0x40000, 0x80000, 0x100000, 0x200000, 0x400000, 0x800000,
];

/**
 * The size code for an image length, or `undefined` for a length no board has.
 *
 * `$00` is 32 KiB and each code above it doubles, so this is a base-two logarithm
 * with an offset — written as the lookup it is rather than as arithmetic, because
 * the codes stop at `$08` and a formula would happily name a ninth.
 */
function romSizeCode(bytes: number): number | undefined {
  const index = GB_ROM_SIZES.indexOf(bytes);
  return index < 0 ? undefined : index;
}

/** Header field offsets, for callers that read a built ROM back. */
export const GB_HEADER_OFFSETS = {
  logo: 0x0104,
  title: 0x0134,
  cgb: 0x0143,
  cartridgeType: 0x0147,
  romSize: 0x0148,
  ramSize: 0x0149,
  headerChecksum: 0x014d,
  globalChecksum: 0x014e,
} as const;

/** What a cartridge declares beyond its title. */
export interface GbHeaderOptions {
  /**
   * Ask for Game Boy Color hardware.
   *
   * `$C0` — CGB *only* — rather than `$80`, because a build that targets the
   * colour hardware writes colour palettes and a second VRAM bank from its first
   * instruction, and a DMG asked to run it would show the game in whatever the
   * background palette register happened to hold. A cartridge that will not run
   * is a better answer than one that runs wrong, and `demake build -c gb` is the
   * cartridge for that machine.
   *
   * Note that this byte is the last of the title field, so a colour cartridge's
   * title is fifteen characters like a monochrome one's — the flag replaces the
   * sixteenth, which was already reserved.
   */
  cgb?: boolean;
}

/** Cartridge type codes: the two boards this project builds. */
export const GB_CARTRIDGE_TYPE = {
  /** ROM only: two banks, both mapped, nothing to program. */
  romOnly: 0x00,
  /** MBC5, no cartridge RAM. */
  mbc5: 0x19,
} as const;

/**
 * Stamp the cartridge header and both checksums in place.
 *
 * `rom` must already hold the whole cartridge — the global checksum covers every
 * byte of it, so this is the last thing a builder does. Its *length* is what
 * decides the type and size bytes: 32 KiB is the ROM-only board, and anything
 * bigger declares MBC5 because that is the controller a demade cartridge pages
 * with. A builder therefore cannot declare a board it did not produce, which is
 * the rule the NES and Sega wrappers already run under.
 */
export function stampGbHeader(rom: Uint8Array, title: string, options: GbHeaderOptions = {}): void {
  const sizeCode = romSizeCode(rom.length);
  if (sizeCode === undefined) {
    throw new Error(
      `a Game Boy cartridge is ${GB_ROM_SIZES.map((n) => n / 1024 + " KiB").join(", ")}` +
        `, not ${rom.length} bytes`,
    );
  }
  const clean = title
    .toUpperCase()
    .replace(/[^\x20-\x5f]/g, " ")
    .slice(0, 15);
  for (let index = 0; index < 16; index += 1) {
    rom[GB_HEADER_OFFSETS.title + index] = index < clean.length ? clean.charCodeAt(index) : 0;
  }
  rom[GB_HEADER_OFFSETS.cgb] = options.cgb === true ? 0xc0 : 0x00;
  rom[0x0144] = 0x00;
  rom[0x0145] = 0x00;
  rom[0x0146] = 0x00; // no Super Game Boy functions
  rom[GB_HEADER_OFFSETS.cartridgeType] =
    rom.length > GB_ROM_SIZE ? GB_CARTRIDGE_TYPE.mbc5 : GB_CARTRIDGE_TYPE.romOnly;
  rom[GB_HEADER_OFFSETS.romSize] = sizeCode;
  // No cartridge RAM on either board. A demade game's state is the console's
  // own 8 KiB, which is where the layout plan puts it on every Game Boy build —
  // declaring RAM a cartridge does not carry would be a header that lies.
  rom[GB_HEADER_OFFSETS.ramSize] = 0x00;
  rom[0x014a] = 0x01; // non-Japanese
  rom[0x014b] = 0x33; // "see the new licensee code"
  rom[0x014c] = 0x00; // version

  let header = 0;
  for (let at = 0x0134; at <= 0x014c; at += 1) header = (header - (rom[at] as number) - 1) & 0xff;
  rom[GB_HEADER_OFFSETS.headerChecksum] = header;

  rom[GB_HEADER_OFFSETS.globalChecksum] = 0;
  rom[GB_HEADER_OFFSETS.globalChecksum + 1] = 0;
  let global = 0;
  for (const byte of rom) global = (global + byte) & 0xffff;
  rom[GB_HEADER_OFFSETS.globalChecksum] = (global >> 8) & 0xff;
  rom[GB_HEADER_OFFSETS.globalChecksum + 1] = global & 0xff;
}
