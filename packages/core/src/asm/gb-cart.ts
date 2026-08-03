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
 * The one console here whose cartridge is not elastic, and the reason is the
 * header rather than a decision: the size field's smallest code *is* 32 KiB and
 * every code above it names a cartridge with a memory bank controller in it, so
 * a ROM-only Game Boy cartridge is 32 KiB and nothing else. Two banks, both
 * mapped, `$0000`–`$7FFF`. Shrinking below it would mean a cartridge that
 * describes a size it does not have; growing past it is doc 13 §Banked
 * cartridges.
 */
export const GB_ROM_SIZE = 0x8000;

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

/**
 * Stamp the cartridge header and both checksums in place.
 *
 * `rom` must already hold the whole cartridge — the global checksum covers every
 * byte of it, so this is the last thing a builder does.
 */
export function stampGbHeader(rom: Uint8Array, title: string, options: GbHeaderOptions = {}): void {
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
  rom[GB_HEADER_OFFSETS.cartridgeType] = 0x00; // ROM only: 32 KiB, no mapper
  rom[GB_HEADER_OFFSETS.romSize] = 0x00;
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
