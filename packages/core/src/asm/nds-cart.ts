/**
 * The Nintendo DS cartridge wrapper: the header, both processors' binaries, and
 * the CRC16 that ties them together.
 *
 * Here for the reason every other console's wrapper is here — two builders pack
 * one of these (the display-ROM edge in `cli/src/rom/nds.ts` and the Demotic
 * backend) and a header written twice disagrees in one byte in one of them — but
 * this console makes the point harder than the others, because **a `.nds` holds
 * two programs**. The header does not merely describe the image; it is the only
 * thing that says which bytes are the ARM9's and which are the ARM7's, and
 * getting that wrong produces a cartridge that boots and then runs the wrong
 * code on the wrong processor.
 *
 * Three things are the hardware's rather than a choice:
 *
 *   - **The header region is 16 KiB**, of which the header proper is 512 bytes.
 *     The ARM9 binary starts at `$4000` because that is where the ROM's own
 *     header field says it does — the offset is data, not a convention, and it
 *     is written here.
 *   - **Both binaries carry a load address and an entry point, separately.**
 *     They are the same value for both programs here, and they are still two
 *     fields, because a cartridge whose entry is not its load address is legal
 *     and a reader has no way to infer one from the other.
 *   - **The Nintendo logo at `$0C0` is checked by the firmware and not by direct
 *     boot.** demake never ships a copyrighted logo, so the area and its CRC
 *     stay zero — the same bargain the Game Boy's boot logo and the GBA's get
 *     (AGENTS.md §Gotchas).
 *
 * Sources: GBATEK — *DS Cartridge Header*
 * (https://problemkaputt.de/gbatek.htm#dscartridgeheader) and *DS Memory Maps*.
 */

/** Bytes of header region; the ARM9 binary follows it. */
export const NDS_HEADER_SIZE = 0x4000;

/** Where the ARM9's binary is loaded, and where it starts executing. */
export const NDS_ARM9_RAM = 0x02000000;

/**
 * Where the ARM7's binary is loaded.
 *
 * Main RAM rather than the ARM7's own 64 KiB, which is the homebrew convention
 * and the one every loader honours. It is 3.5 MiB into a 4 MiB region, so an
 * ARM9 heap that grew past it would overwrite the sound processor's program —
 * which is why the memory plan stops well short.
 */
export const NDS_ARM7_RAM = 0x02380000;

/** First byte of the 4 MiB both processors share. */
export const NDS_MAIN_RAM_START = 0x02000000;
/** Last byte of it. */
export const NDS_MAIN_RAM_END = 0x023fffff;

/** The ARM7's own 64 KiB, which the ARM9 cannot see. */
export const NDS_ARM7_WRAM_START = 0x03800000;
/** Last byte of it. */
export const NDS_ARM7_WRAM_END = 0x0380ffff;

/** What a cartridge declares about itself. */
export interface NdsHeaderOptions {
  /** Twelve characters of ASCII title, padded or truncated. */
  title?: string;
  /** Four characters of game code. */
  code?: string;
  /** Two characters of maker code. */
  maker?: string;
}

/**
 * The CRC16 the DS cartridge header uses: poly `$A001`, initial value `$FFFF`.
 *
 * Exported because it is the one header field nothing else in a build can check.
 */
export function ndsCrc16(bytes: Uint8Array): number {
  let crc = 0xffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) !== 0 ? (crc >> 1) ^ 0xa001 : crc >> 1;
    }
  }
  return crc & 0xffff;
}

/** Round `value` up to a multiple of `to`. */
function align(value: number, to: number): number {
  return Math.ceil(value / to) * to;
}

/** Write `text` as ASCII into `bytes`, padding or truncating to `length`. */
function ascii(bytes: Uint8Array, at: number, text: string, length: number): void {
  for (let index = 0; index < length; index += 1) {
    const code = index < text.length ? text.charCodeAt(index) : 0;
    bytes[at + index] = code < 0x80 ? code : 0x3f;
  }
}

/**
 * Pack the header and both processors' binaries into a `.nds` image.
 *
 * The image is the next power of two at least 128 KiB, which is what the device-
 * capacity field can express and what a loader expects to mirror.
 */
export function packNdsRom(
  arm9: Uint8Array,
  arm7: Uint8Array,
  options: NdsHeaderOptions = {},
): Uint8Array {
  const arm9Offset = NDS_HEADER_SIZE;
  const arm7Offset = align(arm9Offset + arm9.length, 0x200);
  const used = arm7Offset + arm7.length;

  // Counted rather than computed: `Math.log2` is not byte-deterministic across
  // engines, and the capacity field is exactly this count (doc 02 §Determinism).
  let size = 1 << 17;
  let capacity = 0;
  while (size < used) {
    size <<= 1;
    capacity += 1;
  }
  const rom = new Uint8Array(size);
  const view = new DataView(rom.buffer);
  const put = (at: number, value: number): void => view.setUint32(at, value >>> 0, true);

  ascii(rom, 0x000, options.title ?? "DEMAKE", 12);
  ascii(rom, 0x00c, options.code ?? "DMKE", 4);
  ascii(rom, 0x010, options.maker ?? "00", 2);
  rom[0x012] = 0x00; // unit code: an original DS, which every later model runs
  // Capacity is expressed as a shift from 128 KiB, so a 128 KiB image says zero.
  rom[0x014] = capacity;
  put(0x020, arm9Offset);
  put(0x024, NDS_ARM9_RAM); // ARM9 entry
  put(0x028, NDS_ARM9_RAM); // ARM9 load address
  put(0x02c, arm9.length);
  put(0x030, arm7Offset);
  put(0x034, NDS_ARM7_RAM); // ARM7 entry
  put(0x038, NDS_ARM7_RAM); // ARM7 load address
  put(0x03c, arm7.length);
  put(0x060, 0x00586000); // port $40001A4 setting, normal commands
  put(0x064, 0x001808f8); // port $40001A4 setting, KEY1 commands
  put(0x080, used); // total used ROM size
  put(0x084, NDS_HEADER_SIZE);
  // $0C0: the firmware-checked Nintendo logo, and its CRC at $15C. Both stay
  // zero; see the file header.
  view.setUint16(0x15e, ndsCrc16(rom.subarray(0, 0x15e)), true);

  rom.set(arm9, arm9Offset);
  rom.set(arm7, arm7Offset);
  return rom;
}
