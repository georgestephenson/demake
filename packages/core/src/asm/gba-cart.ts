/**
 * The Game Boy Advance cartridge wrapper: the entry branch, the header, its
 * complement check.
 *
 * Here rather than in a caller for the reason `gb-cart.ts`, `nes-cart.ts`,
 * `sms-cart.ts`, `md-cart.ts` and `snes-cart.ts` are: more than one builder
 * wraps ARM code into a cartridge, and a header implemented twice is a header
 * that disagrees in one byte in one of them.
 *
 * Three things about this cartridge are the hardware's rather than a choice:
 *
 *   - **The first word is an instruction.** Not a vector, not a magic number: a
 *     GBA begins executing at `$08000000`, and what has to be there is a branch
 *     over the 188 bytes of header that follow it. So {@link packGbaRom} takes
 *     assembled code that *already starts with that branch* rather than
 *     prepending a header to it — the program and its header interleave, which
 *     no other console in the set does.
 *   - **The complement check covers `$0A0`–`$0BC` and nothing else**, and it is
 *     `−(sum + $19)`, not a sum. The real BIOS refuses a cartridge whose byte is
 *     wrong; every emulator's direct boot ignores it, which is exactly why it is
 *     computed here rather than left to be noticed.
 *   - **The Nintendo logo is 156 bytes the BIOS compares against its own copy.**
 *     demake never ships a copyrighted logo, so the area stays zero — the same
 *     bargain the Game Boy's boot logo gets (AGENTS.md §Gotchas): a built ROM
 *     direct-boots in an emulator and does not boot on original hardware.
 *
 * Sources: GBATEK — *The Cartridge Header*
 * (https://problemkaputt.de/gbatek.htm#gbacartridgeheader) and *GBA Memory Map*.
 */

/** Where a cartridge is mapped, and therefore where its code is assembled. */
export const GBA_ORIGIN = 0x08000000;

/** Bytes of header, from the entry branch to the last reserved pair. */
export const GBA_HEADER_SIZE = 0xc0;

/** First byte the complement check covers. */
export const GBA_CHECK_START = 0xa0;

/** Last byte it covers — the software-version byte, inclusive. */
export const GBA_CHECK_END = 0xbc;

/** Where the complement byte itself lives. */
export const GBA_CHECK_OFFSET = 0xbd;

/** The 256 KiB of external work RAM, on a 16-bit bus with two wait states. */
export const GBA_EWRAM_START = 0x02000000;
/** Last byte of it. */
export const GBA_EWRAM_END = 0x0203ffff;

/** The 32 KiB of internal work RAM: a 32-bit bus, no wait states, no DMA cost. */
export const GBA_IWRAM_START = 0x03000000;
/** Last byte of it. */
export const GBA_IWRAM_END = 0x03007fff;

/**
 * Where the BIOS's interrupt dispatcher reads the user handler's address.
 *
 * A GBA cannot install its own vector — `$00000018` is BIOS ROM — so the BIOS
 * takes the interrupt, saves what it must, and jumps through this pointer in
 * ARM state. It is the last word of internal work RAM, which is why a memory
 * plan stops short of it.
 */
export const GBA_IRQ_VECTOR = 0x03007ffc;

/**
 * Where the BIOS keeps the interrupt flags a handler must also acknowledge.
 *
 * `IF` alone is not enough for the BIOS's own `IntrWait`: it maintains a second
 * copy here, and a handler that clears one without the other leaves `Halt`
 * returning immediately for ever.
 */
export const GBA_BIOS_IF = 0x03007ff8;

/** What a cartridge declares about itself. */
export interface GbaHeaderOptions {
  /** Twelve characters of ASCII title, padded or truncated. */
  title?: string;
  /** Four characters of game code. */
  code?: string;
  /** Two characters of maker code. */
  maker?: string;
  /**
   * Bytes the cartridge image holds.
   *
   * A GBA has no size field and no mirroring rule to satisfy, so this is padding
   * for the sake of a predictable artifact rather than a hardware requirement;
   * it defaults to the assembled length rounded up to 32 KiB.
   */
  size?: number;
}

/** Write `text` as ASCII into `bytes`, padding or truncating to `length`. */
function ascii(bytes: Uint8Array, at: number, text: string, length: number): void {
  for (let index = 0; index < length; index += 1) {
    const code = index < text.length ? text.charCodeAt(index) : 0;
    bytes[at + index] = code < 0x80 ? code : 0x3f;
  }
}

/**
 * The header's complement byte, over an image that already holds the header.
 *
 * Exported because it is the one field nothing else in a build can check, and a
 * test that recomputed it a second way would be testing its own arithmetic.
 */
export function gbaComplement(rom: Uint8Array): number {
  let sum = 0;
  for (let at = GBA_CHECK_START; at <= GBA_CHECK_END; at += 1) sum += rom[at] as number;
  return (-(sum + 0x19) & 0xff) >>> 0;
}

/**
 * Wrap assembled ARM code in a cartridge image.
 *
 * `code` must already begin with the entry branch and reserve the header's
 * bytes — which is what an assembler emitting `b start` followed by
 * `padTo(GBA_HEADER_SIZE)` produces, and what {@link gbaEntry} spells for a
 * caller that would rather not remember the layout.
 */
export function packGbaRom(code: Uint8Array, options: GbaHeaderOptions = {}): Uint8Array {
  if (code.length < GBA_HEADER_SIZE) {
    throw new Error(
      `a Game Boy Advance cartridge is at least ${GBA_HEADER_SIZE} bytes; this one is ${code.length}`,
    );
  }
  const minimum = Math.max(0x8000, code.length);
  const size = options.size ?? Math.ceil(minimum / 0x8000) * 0x8000;
  if (size < code.length) {
    throw new Error(`this program is ${code.length} bytes and the cartridge holds ${size}`);
  }
  const rom = new Uint8Array(size);
  rom.set(code);

  // 0x04–0x9F is the logo area, and it stays as the assembler left it: zero.
  ascii(rom, 0xa0, options.title ?? "DEMAKE", 12);
  ascii(rom, 0xac, options.code ?? "DMKE", 4);
  ascii(rom, 0xb0, options.maker ?? "00", 2);
  rom[0xb2] = 0x96; // fixed value; the BIOS checks this one even on direct boot
  rom[0xb3] = 0x00; // main unit code
  rom[0xb4] = 0x00; // device type
  for (let at = 0xb5; at <= 0xbb; at += 1) rom[at] = 0; // reserved
  rom[0xbc] = 0x00; // software version
  rom[GBA_CHECK_OFFSET] = gbaComplement(rom);
  rom[0xbe] = 0;
  rom[0xbf] = 0;
  return rom;
}
