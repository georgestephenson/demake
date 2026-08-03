/**
 * The Mega Drive cartridge wrapper: the vector table, the header, its checksum.
 *
 * Here rather than in a caller for the reason `gb-cart.ts`, `nes-cart.ts` and
 * `sms-cart.ts` are: more than one builder wraps 68000 code into a Mega Drive
 * cartridge, and a 256-byte header implemented twice is a header that disagrees
 * in one byte in one of them.
 *
 * Three things about this cartridge are the hardware's rather than a choice, and
 * each is easy to get wrong in a way that boots on one emulator and not another:
 *
 *   - **The first 256 bytes are the CPU's, not the header's.** A 68000 takes its
 *     initial stack pointer from `$000000` and its reset vector from `$000004`,
 *     and the sixty-two exception vectors after them are real: an address error
 *     with an unset vector is a jump to whatever the cartridge happens to hold.
 *     So {@link packMdRom} fills every one of them, and the *header* starts at
 *     `$000100` where the console's boot ROM looks for it.
 *   - **The checksum covers `$000200` onward**, not the whole image — the vectors
 *     and the header are excluded, which is what lets the value be written into
 *     the region it does not cover. It is a sum of *words*, big-endian, which is
 *     the one detail that differs from every other console here.
 *   - **The ROM-end field is an address, not a size.** It is the address of the
 *     last byte, so a 512 KiB cartridge says `$07FFFF`. A builder that wrote the
 *     size instead produces a cartridge some emulators refuse to mirror
 *     correctly.
 *
 * Sources: Sega — Genesis Software Manual (§4, cartridge header) and Plutiedev —
 * ROM header (https://plutiedev.com/rom-header).
 */

/** Where the console's boot ROM looks for the header. */
export const MD_HEADER_OFFSET = 0x0100;

/** Bytes the header occupies. */
export const MD_HEADER_SIZE = 0x0100;

/** Where a cartridge's code starts, past the vectors and the header. */
export const MD_ORIGIN = 0x0000;

/** The first byte the checksum covers. */
export const MD_CHECKSUM_START = 0x0200;

/** Where the checksum word lives inside the header. */
export const MD_CHECKSUM_OFFSET = 0x018e;

/** First byte of the console's 64 KiB of work RAM. */
export const MD_RAM_START = 0xff0000;

/** Last byte of it. */
export const MD_RAM_END = 0xffffff;

/**
 * The autovector the VDP's vertical interrupt takes.
 *
 * Level 6, so vector 30 at `$000078`. The horizontal interrupt is level 4 and
 * takes vector 28 at `$000070`; a game that programmed one without filling that
 * vector would jump into its own tile data on the first raster line.
 */
export const MD_VINT_VECTOR = 0x0078;

/** The horizontal interrupt's autovector. */
export const MD_HINT_VECTOR = 0x0070;

/** What a cartridge declares about itself. */
export interface MdHeaderOptions {
  /** The domestic and overseas names, padded or truncated to 48 characters. */
  title?: string;
  /** Bytes the cartridge holds — one of {@link MD_ROM_SIZES}. */
  size?: number;
  /**
   * Where the vertical interrupt goes.
   *
   * Defaults to the reset address, which is what a cartridge that never enables
   * the interrupt wants; a game does enable it, and a vector left pointing at
   * the reset code would restart the game sixty times a second.
   */
  vint?: number;
  /** The same, for the horizontal interrupt, which nothing here enables. */
  hint?: number;
}

/** Bytes a Demotic cartridge is padded to, at the smallest. */
export const MD_ROM_SIZE = 0x20000;

/**
 * Cartridge sizes, smallest first.
 *
 * There is no mapper in any of these: a Mega Drive maps the whole cartridge from
 * `$000000` and the header records where it ends, so growing one is padding a
 * bigger array and writing a different number at `$1A4`. Powers of two because
 * that is what the boards were, and because `mdChecksum` sums words to the end of
 * the image and an odd length would leave a half-word to decide about.
 *
 * **One megabit is the floor and it is the boards' rather than ours.** A demade
 * game is twenty-odd kilobytes of 68000 with its art beside it, so half a megabyte
 * was four hundred and eighty kilobytes of padding — and 1 Mbit is what the early
 * cartridges of this console actually were. Below it the sizes stop being
 * period-correct rather than stopping being expressible.
 *
 * Four megabytes is where this stops, and it is the flat limit rather than an
 * arbitrary one: past it a cartridge needs bank switching through `$A130F1`, which
 * is a different piece of work (doc 13 §Banked cartridges).
 */
export const MD_ROM_SIZES: readonly number[] = [
  0x20000, 0x40000, 0x80000, 0x100000, 0x200000, 0x400000,
];

/** Pad a field with spaces, or cut it to length — the header's own convention. */
function field(text: string, length: number): number[] {
  const out: number[] = [];
  for (let index = 0; index < length; index += 1) {
    const code = text.charCodeAt(index);
    // Space for anything past the end *and* anything outside printable ASCII: a
    // header is read as text by every cartridge database there is.
    out.push(Number.isNaN(code) || code < 0x20 || code > 0x7e ? 0x20 : code);
  }
  return out;
}

/**
 * Sum the cartridge into the sixteen bits the boot ROM compares against.
 *
 * Words, big-endian, from {@link MD_CHECKSUM_START} to the end of the image. An
 * odd-length image cannot happen here — a cartridge is a power of two — so there
 * is no half-word case to decide.
 */
export function mdChecksum(rom: Uint8Array): number {
  let sum = 0;
  for (let at = MD_CHECKSUM_START; at + 1 < rom.length; at += 2) {
    sum = (sum + (((rom[at] as number) << 8) | (rom[at + 1] as number))) & 0xffff;
  }
  return sum;
}

/**
 * Wrap assembled code into a bootable cartridge.
 *
 * `code` starts at `$000200`: the vectors and the header are this function's,
 * not the emitter's, so a backend never has to know where either lives. `reset`
 * is the address the CPU jumps to, and `stack` is what it loads into `a7` before
 * it does — both are the first two longs of the image and are therefore the only
 * part of the cartridge the hardware reads without being asked.
 */
export function packMdRom(
  code: Uint8Array,
  reset: number,
  stack: number,
  options: MdHeaderOptions = {},
): Uint8Array {
  const size = options.size ?? MD_ROM_SIZE;
  if (size < code.length + MD_CHECKSUM_START) {
    throw new Error(`a ${size}-byte cartridge cannot hold ${code.length} bytes of program`);
  }
  const rom = new Uint8Array(size);

  const long = (at: number, value: number): void => {
    rom[at] = (value >>> 24) & 0xff;
    rom[at + 1] = (value >>> 16) & 0xff;
    rom[at + 2] = (value >>> 8) & 0xff;
    rom[at + 3] = value & 0xff;
  };

  // The vectors. Every one of the sixty-two exceptions points at the reset
  // address rather than at zero: an unhandled trap that ran into tile data would
  // be a hang nobody could name, and one that restarts the game is at least a
  // symptom with a shape.
  long(0x00, stack);
  long(0x04, reset);
  for (let vector = 2; vector < 64; vector += 1) long(vector * 4, reset);
  long(MD_HINT_VECTOR, options.hint ?? reset);
  long(MD_VINT_VECTOR, options.vint ?? reset);

  const header = MD_HEADER_OFFSET;
  const write = (at: number, bytes: readonly number[]): void => {
    for (const [index, byte] of bytes.entries()) rom[at + index] = byte;
  };
  const title = options.title ?? "DEMAKE";
  write(header + 0x00, field("SEGA MEGA DRIVE ", 16));
  write(header + 0x10, field("(C)DEMAKE 2024  ", 16));
  write(header + 0x20, field(title, 48));
  write(header + 0x50, field(title, 48));
  write(header + 0x80, field("GM 00000000-00", 14));
  // The checksum goes in last, once the image it covers exists.
  write(header + 0x90, field("J               ", 16));
  long(header + 0xa0, 0x00000000); // ROM start
  long(header + 0xa4, size - 1); // ROM end, which is an address
  long(header + 0xa8, MD_RAM_START);
  long(header + 0xac, MD_RAM_END);
  write(header + 0xb0, field("            ", 12)); // no save RAM
  write(header + 0xbc, field("            ", 12)); // no modem
  write(header + 0xc8, field("", 40)); // notes
  write(header + 0xf0, field("JUE             ", 16));

  rom.set(code, MD_CHECKSUM_START);

  const sum = mdChecksum(rom);
  rom[MD_CHECKSUM_OFFSET] = (sum >> 8) & 0xff;
  rom[MD_CHECKSUM_OFFSET + 1] = sum & 0xff;
  return rom;
}
