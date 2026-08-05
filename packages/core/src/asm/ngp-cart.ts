/**
 * The Neo Geo Pocket cartridge wrapper: the 64-byte header at the top of ROM.
 *
 * Here rather than in a caller for the reason `ws-cart.ts` and `gb-cart.ts` are:
 * more than one builder wraps TLCS-900/H code into a cartridge for this console
 * — the Demotic game backend, and the display-ROM harness's builder at the CLI
 * edge — and a header implemented twice is a header that disagrees in one byte
 * in one of them.
 *
 * Four things about this cartridge are the console's rather than a restatement,
 * and each decides something above:
 *
 *   - **The cartridge is mapped at `$200000` and the header is in front of the
 *     program.** There is no reset vector to chase: the boot ROM reads the entry
 *     address out of the header at `$20001C` and jumps to it, so a program can
 *     start anywhere and this file puts it directly after the header. That makes
 *     the header a *region* in front of the image rather than bytes woven into
 *     it, which is the Nintendo DS's arrangement reached by different hardware.
 *   - **The recognition code is a claim, so it is left blank.** The boot ROM
 *     checks the first 28 bytes against SNK's own copyright or licence string,
 *     and a demade cartridge is neither copyright SNK nor licensed by them.
 *     Zeroes go there by default — every emulator boots the cartridge anyway —
 *     and {@link NgpCartOptions.recognition} stamps one for anyone who needs to
 *     run on the hardware. That is exactly the bargain `gb-cart.ts` strikes with
 *     the Nintendo boot logo, and it keeps the CLI's and the browser's output
 *     byte-identical by default.
 *   - **One byte decides which machine will run this.** `$00` at `$200023` is a
 *     cartridge a mono Neo Geo Pocket may run and `$10` is one only the Color
 *     may — a Game Boy Color cartridge's `$C0` reached by different hardware,
 *     and the WonderSwan's minimum-system byte inverted.
 *   - **There is no checksum.** Nothing in the header covers the image, so
 *     unlike the WonderSwan's or the Mega Drive's this wrapper is a function of
 *     its options and its program rather than of the finished cartridge.
 *
 * Sources: the Neo Geo Pocket Color technical reference (`ngpcspec.txt`,
 * devrs.com) — memory map and cartridge header layout.
 */

/** Where the cartridge answers the address bus. */
export const NGP_ROM_BASE = 0x200000;

/** Bytes of header in front of the program. */
export const NGP_HEADER_SIZE = 0x40;

/** Where the boot ROM reads the entry address from, as an offset into the ROM. */
export const NGP_ENTRY_OFFSET = 0x1c;

/**
 * The string the boot ROM checks, for a build that asks for one.
 *
 * Twenty-eight characters exactly, which is the whole field — the two the
 * hardware accepts are this and `" LICENSED BY SNK CORPORATION"`, and both are
 * statements about who owns the cartridge rather than data it needs.
 */
export const NGP_RECOGNITION_CODE = "COPYRIGHT BY SNK CORPORATION";

/** The system byte for a cartridge a mono Neo Geo Pocket may run. */
export const NGP_SYSTEM_MONO = 0x00;

/** The system byte for a cartridge only a Neo Geo Pocket Color may run. */
export const NGP_SYSTEM_COLOR = 0x10;

/**
 * Cartridge sizes, smallest first.
 *
 * Flash boards, and these three are what this console's cartridges actually
 * were: 4, 8 and 16 megabits. The address space would hold 2 MiB and stops
 * there, so the largest board is also the limit rather than an arbitrary
 * ceiling. A demade game takes the smallest that holds it
 * (`backend.ts` §Elastic cartridges); below 4 Mbit the sizes stop being
 * period-correct rather than stopping being expressible.
 */
export const NGP_ROM_SIZES: readonly number[] = [0x80000, 0x100000, 0x200000];

/** Bytes a Demotic cartridge is padded to, at the smallest. */
export const NGP_ROM_SIZE = 0x80000;

/** What to stamp in the header. */
export interface NgpCartOptions {
  /** Twelve characters of title, padded with spaces and cut if longer. */
  title?: string;
  /** The two-byte software id, which distinguishes a publisher's titles. */
  softwareId?: number;
  /** The id's sub-code, which is the revision. */
  version?: number;
  /** Whether this cartridge needs a Color. Defaults to mono, which both run. */
  color?: boolean;
  /**
   * Where the boot ROM jumps. Defaults to the first byte after the header,
   * which is where {@link packNgpRom} puts the program.
   */
  entry?: number;
  /**
   * Stamp the recognition code the boot ROM checks.
   *
   * Off by default: it is SNK's copyright claim, and a demade cartridge is not
   * theirs. A ROM built without it boots in every emulator and not on the
   * hardware, which is the same trade `--boot-logo` makes on the Game Boy.
   */
  recognition?: boolean;
  /** Bytes the cartridge holds — one of {@link NGP_ROM_SIZES}. */
  size?: number;
}

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
 * The smallest board that holds a program of this size.
 *
 * Separate from {@link packNgpRom} because a backend has to *ask* before it
 * emits — where a build lays its data out can depend on how big the cartridge
 * turned out to be.
 */
export function ngpRomSize(bytes: number): number {
  const size = NGP_ROM_SIZES.find((candidate) => bytes <= candidate);
  if (size === undefined) {
    throw new Error(
      `Neo Geo Pocket program is ${bytes} bytes; the largest cartridge holds ${NGP_ROM_SIZES[NGP_ROM_SIZES.length - 1] as number}`,
    );
  }
  return size;
}

/**
 * Wrap TLCS-900/H code into a bootable cartridge.
 *
 * `code` is the program as it will sit at `$200040`, directly after the header;
 * this stamps the header in front of it and pads to the smallest board that
 * holds the pair. Padding is `$FF`, the erased state of a flash device.
 */
export function packNgpRom(code: Uint8Array, options: NgpCartOptions = {}): Uint8Array {
  const total = NGP_HEADER_SIZE + code.length;
  const size = options.size ?? ngpRomSize(total);
  if (!NGP_ROM_SIZES.includes(size)) {
    throw new Error(`a Neo Geo Pocket cartridge is ${NGP_ROM_SIZES.join(", ")} bytes, not ${size}`);
  }
  if (total > size) {
    throw new Error(
      `Neo Geo Pocket program is ${code.length} bytes; a ${size}-byte cartridge holds ${size - NGP_HEADER_SIZE} after its header`,
    );
  }

  const rom = new Uint8Array(size).fill(0xff);
  // The header is written over the fill rather than into it, so every byte of it
  // is deliberate — including the reserved sixteen, which the reference says to
  // write as zero rather than leave erased.
  rom.fill(0, 0, NGP_HEADER_SIZE);

  if (options.recognition ?? false) {
    rom.set(field(NGP_RECOGNITION_CODE, NGP_ENTRY_OFFSET), 0);
  }

  const entry = options.entry ?? NGP_ROM_BASE + NGP_HEADER_SIZE;
  rom[NGP_ENTRY_OFFSET] = entry & 0xff;
  rom[NGP_ENTRY_OFFSET + 1] = (entry >> 8) & 0xff;
  rom[NGP_ENTRY_OFFSET + 2] = (entry >> 16) & 0xff;
  rom[NGP_ENTRY_OFFSET + 3] = 0x00;

  const softwareId = options.softwareId ?? 0;
  rom[0x20] = softwareId & 0xff;
  rom[0x21] = (softwareId >> 8) & 0xff;
  rom[0x22] = options.version ?? 0;
  rom[0x23] = (options.color ?? false) ? NGP_SYSTEM_COLOR : NGP_SYSTEM_MONO;
  rom.set(field(options.title ?? "", 12), 0x24);

  rom.set(code, NGP_HEADER_SIZE);
  return rom;
}
