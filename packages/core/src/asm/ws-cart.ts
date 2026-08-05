/**
 * The WonderSwan cartridge wrapper: the ten-byte footer and its checksum.
 *
 * Here rather than in a caller for the reason `sms-cart.ts` and `gb-cart.ts`
 * are: more than one builder wraps V30MZ code into a WonderSwan cartridge — the
 * Demotic game backend, and the display-ROM harness's builder at the CLI edge —
 * and a header implemented twice is a header that disagrees in one byte in one
 * of them.
 *
 * Four things about this cartridge are the console's rather than a restatement,
 * and each decides something above:
 *
 *   - **The program is in the *last* bank, and reset lands past its end.** The
 *     V30MZ starts fetching at `FFFF:0000`, which is physical `$FFFF0` — sixteen
 *     bytes before the top of the address space and inside the footer's own
 *     region. So the entry point is a far jump *at* `$FFF0` of the bank, and the
 *     program it jumps to starts at the bank's first byte. A build therefore has
 *     `$0000`–`$FFEF` and not a byte more, whatever size the cartridge is.
 *   - **The bank answers segment `$F000` with no mapper set up.** The ROM banking
 *     registers come up all-ones, so the highest 64 KiB of the cartridge is
 *     mapped from reset and a program that never writes one sees a flat window.
 *     That is the same bargain the Sega 8-bits make, arrived at by different
 *     hardware.
 *   - **The checksum covers every byte but its own two.** It can only be computed
 *     once the whole cartridge exists — padding included — which is why this is a
 *     function over a finished image rather than a field somebody fills in.
 *   - **There is one board.** The size byte's vocabulary starts at 4 Mbit, so
 *     unlike the NES or the Mega Drive this console has nothing smaller to
 *     choose (`backend.ts` §Elastic cartridges); a WonderSwan cartridge is
 *     512 KiB the way a Game Boy ROM-only cartridge is 32 KiB, and for the same
 *     kind of reason — the header cannot describe anything else.
 *
 * Sources: WSdev wiki — Cartridge header (ws.nesdev.org), and the footer layout
 * the `rom-harness/wsc` display program already boots from in beetle-wswan.
 */

/** Bytes of the smallest cartridge this console's header can describe: 4 Mbit. */
export const WS_ROM_SIZE = 512 * 1024;

/** Bytes of the bank the processor answers segment `$F000` with. */
export const WS_BANK_SIZE = 64 * 1024;

/** The segment a cartridge's last bank is mapped at from reset. */
export const WS_CODE_SEGMENT = 0xf000;

/** Where the reset far jump sits inside the bank. */
export const WS_ENTRY_OFFSET = 0xfff0;

/**
 * Bytes a program may occupy.
 *
 * The entry jump is at `$FFF0` and the footer runs from `$FFF6` to the end of the
 * bank, so everything a build emits has to end at or before `$FFF0`. This is the
 * capacity `RomStats.free` is measured against.
 */
export const WS_CODE_SIZE = WS_ENTRY_OFFSET;

/** Where the footer's fields begin. */
export const WS_FOOTER_OFFSET = 0xfff6;

/** What to stamp in the footer. */
export interface WsCartOptions {
  /** Developer id; zero is the unregistered one, which is what a demake is. */
  developer?: number;
  /** `0` for a mono WonderSwan, `1` for a Color — the machine a cartridge needs. */
  minimumSystem?: number;
  /** Cartridge id, which distinguishes a publisher's titles from each other. */
  cartridgeId?: number;
  /** `0x04` portrait, `0x05` landscape — the orientation the game is played in. */
  orientation?: number;
}

/**
 * Wrap a bank of V30MZ code into a bootable cartridge.
 *
 * `code` is the program from offset zero; this places it at the bottom of the
 * last bank, puts the far jump the processor resets into at `$FFF0`, stamps the
 * footer, pads the rest to `$FF` — the erased state of a mask ROM — and computes
 * the checksum over the finished image.
 */
export function packWsRom(code: Uint8Array, options: WsCartOptions = {}): Uint8Array {
  if (code.length > WS_CODE_SIZE) {
    throw new Error(`WonderSwan program is ${code.length} bytes; the bank holds ${WS_CODE_SIZE}`);
  }
  const rom = new Uint8Array(WS_ROM_SIZE).fill(0xff);
  const bank = WS_ROM_SIZE - WS_BANK_SIZE;
  rom.set(code, bank);

  // `jmp $F000:$0000` — five bytes, at the address the processor fetches from.
  const entry = bank + WS_ENTRY_OFFSET;
  rom[entry] = 0xea;
  rom[entry + 1] = 0x00;
  rom[entry + 2] = 0x00;
  rom[entry + 3] = WS_CODE_SEGMENT & 0xff;
  rom[entry + 4] = (WS_CODE_SEGMENT >> 8) & 0xff;
  rom[entry + 5] = 0xff;

  const footer = bank + WS_FOOTER_OFFSET;
  rom[footer] = options.developer ?? 0x00;
  rom[footer + 1] = options.minimumSystem ?? 0x01;
  rom[footer + 2] = options.cartridgeId ?? 0x00;
  rom[footer + 3] = 0x00; // reserved
  rom[footer + 4] = 0x02; // ROM size: 4 Mbit
  rom[footer + 5] = 0x00; // no save memory
  rom[footer + 6] = options.orientation ?? 0x05;
  rom[footer + 7] = 0x00; // no real-time clock

  const sum = wsChecksum(rom);
  rom[WS_ROM_SIZE - 2] = sum & 0xff;
  rom[WS_ROM_SIZE - 1] = (sum >> 8) & 0xff;
  return rom;
}

/** The footer checksum: every byte of the cartridge but the two it lives in. */
export function wsChecksum(rom: Uint8Array): number {
  let sum = 0;
  for (let index = 0; index < rom.length - 2; index += 1)
    sum = (sum + (rom[index] as number)) & 0xffff;
  return sum;
}
