/**
 * The Sega 8-bit cartridge wrapper: the `TMR SEGA` header and its checksum.
 *
 * Here rather than in a caller for the reason `gb-cart.ts` and `nes-cart.ts`
 * are: more than one builder wraps Z80 code into a Master System cartridge — the
 * Demotic game backend, and the audio driver when its SN76489 half lands — and a
 * sixteen-byte header implemented twice is a header that disagrees in one byte
 * in one of them.
 *
 * **A flat cartridge**, 32 or 48 KiB: the whole image is visible from reset with
 * no bank switching to arrange and no cartridge RAM. Thirty-two is
 * `$0000`–`$7FFF`; forty-eight reaches `$BFFF`, because the mapper comes up with
 * its three slots holding banks 0, 1 and 2 and a program that never writes a bank
 * register sees one continuous image. Work RAM is the console's 8 KiB at
 * `$C000`–`$DFFF`, which is where the flat image has to stop. That is the same
 * bargain the other two consoles make and it is made for the same reason — a game
 * whose code and data are one image is a game whose every address is known at
 * compile time.
 *
 * Three things about this header are worth stating, because each has bitten
 * somebody:
 *
 *   - **It lives at `$7FF0`, inside the image.** Unlike the iNES header, which
 *     is a wrapper the console never sees, this is sixteen bytes of the
 *     cartridge's own address space. A builder that appends it makes a 32 KiB
 *     ROM plus sixteen bytes, which no emulator will map correctly; it is
 *     *overwritten* into the image, and the region it occupies must be free.
 *   - **The checksum is computed over what comes before it.** `$0000`–`$7FEF`,
 *     summed as bytes into sixteen bits — so it can only be computed once the
 *     whole image exists, exactly like the WonderSwan's footer.
 *   - **Region tells the console which machine it is.** A Game Gear cartridge
 *     with an export-Master-System region code boots into the wrong palette
 *     format on hardware, because the region nibble is how the VDP is told
 *     whether CRAM is one byte a colour or two.
 *
 * Sources: SMS Power! — ROM Header (https://www.smspower.org/Development/ROMHeader)
 * and Memory Map (https://www.smspower.org/Development/MemoryMap).
 */

/** Bytes of a mapper-less Sega 8-bit cartridge. */
export const SMS_ROM_SIZE = 0x8000;

/**
 * Cartridge sizes that need no bank switching, smallest first.
 *
 * Forty-eight kilobytes is flat address space on this hardware and that is worth
 * saying plainly, because it looks like it should not be. The mapper is in the
 * cartridge rather than the console and it comes up with slot 0 holding bank 0,
 * slot 1 bank 1 and slot 2 bank 2 — so `$0000`–`$BFFF` is three banks already
 * mapped, and a program that never writes a bank register sees one continuous
 * image. Work RAM starts at `$C000`, which is where it has to stop.
 *
 * Past that a cartridge is genuinely banked: slot 2 is the switchable window and
 * a program has to page it. That is a different piece of work (doc 13 §Banked
 * cartridges) and this list is where its sizes will go.
 */
export const SMS_FLAT_ROM_SIZES: readonly number[] = [0x8000, 0xc000];

/** Where the header sits inside the image. */
export const SMS_HEADER_OFFSET = 0x7ff0;

/** Bytes the header occupies. */
export const SMS_HEADER_SIZE = 16;

/**
 * Where the program is mapped, which is also where the CPU starts.
 *
 * There is no vector table to fill in and no entry point to jump from: the Z80
 * resets to `$0000`, so the first byte of the cartridge is the first instruction
 * executed.
 */
export const SMS_ORIGIN = 0x0000;

/** The maskable interrupt vector in interrupt mode 1 — the VDP's frame and line interrupts. */
export const SMS_IRQ_VECTOR = 0x0038;

/** The non-maskable interrupt vector — the Pause button, on both machines. */
export const SMS_NMI_VECTOR = 0x0066;

/** First byte of the console's work RAM. */
export const SMS_RAM_START = 0xc000;

/**
 * Last byte of work RAM a game may use.
 *
 * The RAM is 8 KiB at `$C000` and is mirrored at `$E000`, and the mapper's four
 * control registers live at `$FFFC`–`$FFFF` — which is to say at `$DFFC`–`$DFFF`
 * seen through the mirror. Writing there swaps a ROM bank out from under the
 * running program, so those four bytes are not the allocator's to hand out even
 * though they read back as ordinary RAM.
 */
export const SMS_RAM_END = 0xdffb;

/** Which machine, and which market, the cartridge declares itself for. */
export type SegaRegion = "sms-japan" | "sms-export" | "gg-japan" | "gg-export" | "gg-international";

const REGION_CODE: Readonly<Record<SegaRegion, number>> = {
  "sms-japan": 3,
  "sms-export": 4,
  "gg-japan": 5,
  "gg-export": 6,
  "gg-international": 7,
};

/**
 * The size nibble, which is a code and not a number of kilobytes.
 *
 * Only the sizes this builder can produce are listed: the codes run on past
 * these for banked cartridges, and a builder that cannot make one has no
 * business naming them.
 */
const SIZE_CODES: Readonly<Record<number, number>> = { 0x8000: 0x0c, 0xc000: 0x0d };

/** What a cartridge declares about itself. */
export interface SegaHeaderOptions {
  /** Which machine and market. Defaults to an exported Master System. */
  region?: SegaRegion;
  /**
   * The five-digit product code, as a number.
   *
   * Stamped as BCD across two and a half bytes. Zero is what a cartridge that is
   * nobody's product says, and it is the default for the same reason the Game
   * Boy builder leaves the licensee bytes empty.
   */
  product?: number;
  /** The version nibble, 0–15. */
  version?: number;
}

/** Encode one byte as two BCD digits. */
function bcd(value: number): number {
  return ((Math.floor(value / 10) % 10) << 4) | (value % 10);
}

/**
 * Sum the cartridge into the sixteen bits the BIOS compares against.
 *
 * The range stops at the header: `$0000`–`$7FEF`. Everything after it — the
 * header itself, and on a banked cartridge the higher banks — is excluded, which
 * is what lets the value be written into the region it does not cover.
 */
export function segaChecksum(rom: Uint8Array): number {
  let sum = 0;
  for (let index = 0; index < SMS_HEADER_OFFSET; index += 1) sum += rom[index] as number;
  return sum & 0xffff;
}

/**
 * Stamp the header into a flat image and return the finished cartridge.
 *
 * `image` must be one of {@link SMS_FLAT_ROM_SIZES}: a flat cartridge has no
 * short banks, and rejecting anything else here rather than in a caller is how
 * two builders that produce one stay identical. The size nibble follows from the
 * length, so a 48 KiB image cannot be stamped as a 32 KiB one. The sixteen bytes at {@link SMS_HEADER_OFFSET}
 * are overwritten, so a program that ran code or stored data there would have it
 * replaced — which the game backend avoids by reserving the region up front
 * rather than discovering the overlap in an emulator.
 */
export function packSegaRom(image: Uint8Array, options: SegaHeaderOptions = {}): Uint8Array {
  const sizeCode = SIZE_CODES[image.length];
  if (sizeCode === undefined) {
    throw new Error(
      `a flat Sega cartridge is ${SMS_FLAT_ROM_SIZES.map((n) => n / 1024 + " KiB").join(" or ")}` +
        `, not ${image.length} bytes`,
    );
  }
  const rom = Uint8Array.from(image);
  const at = SMS_HEADER_OFFSET;

  // "TMR SEGA", which is what the BIOS looks for before it checksums anything.
  const magic = [0x54, 0x4d, 0x52, 0x20, 0x53, 0x45, 0x47, 0x41];
  for (const [index, byte] of magic.entries()) rom[at + index] = byte;
  rom[at + 8] = 0x00;
  rom[at + 9] = 0x00;

  const product = Math.max(0, Math.floor(options.product ?? 0));
  rom[at + 12] = bcd(product % 100);
  rom[at + 13] = bcd(Math.floor(product / 100) % 100);
  // Two and a half bytes: the fifth digit shares a byte with the version nibble.
  rom[at + 14] = ((Math.floor(product / 10000) % 10) << 4) | ((options.version ?? 0) & 0x0f);
  rom[at + 15] = (REGION_CODE[options.region ?? "sms-export"] << 4) | sizeCode;

  // Last, because it covers every byte before it — including the ones just written
  // would be a checksum that cannot be verified, and the range stops short of them.
  const sum = segaChecksum(rom);
  rom[at + 10] = sum & 0xff;
  rom[at + 11] = (sum >> 8) & 0xff;
  return rom;
}

/** The region a console id declares itself as. */
export function regionFor(consoleId: string): SegaRegion {
  return consoleId === "gg" ? "gg-international" : "sms-export";
}
