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
 *   - **There is one board, and the elasticity is in the *RAM*.** The size
 *     byte's vocabulary starts at 4 Mbit, so unlike the NES or the Mega Drive
 *     this console has nothing smaller to choose (`backend.ts` §Elastic
 *     cartridges); a WonderSwan cartridge is 512 KiB the way a Game Boy ROM-only
 *     cartridge is 32 KiB, and for the same kind of reason — the header cannot
 *     describe anything else. What it *can* describe is five sizes of save RAM,
 *     and a game that outgrows the console's own memory takes the smallest of
 *     them that holds its heap ({@link WS_SAVE_SIZES}).
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

/** The segment the console answers with the cartridge's save RAM. */
export const WS_SAVE_SEGMENT = 0x1000;

/** The linear address that segment's first byte is, which is what a plan names. */
export const WS_SAVE_BASE = WS_SAVE_SEGMENT << 4;

/**
 * The save memories this cartridge's footer can describe, smallest first.
 *
 * The byte at offset `$05` names a *kind* as well as a size — the codes above
 * `$05` are serial EEPROMs, which answer a port rather than the address space
 * and so are no use to a program that wants somewhere to put its variables. What
 * is here is the five SRAMs, which the console maps at segment `$1` and a
 * program reaches with an ordinary memory access.
 *
 * A demade cartridge declares one only when the game's heap will not fit the
 * console's own memory, and then the smallest that holds it — the elastic-board
 * rule (`backend.ts` §Elastic cartridges) reaching the one direction this
 * console's header leaves open. Nothing is saved between sessions and nothing
 * has to be: what a battery buys a real game is a save file, and what it buys
 * this one is somewhere to compute.
 */
export const WS_SAVE_SIZES: readonly { code: number; bytes: number }[] = [
  { code: 0x01, bytes: 1 * 1024 },
  { code: 0x02, bytes: 4 * 1024 },
  { code: 0x03, bytes: 16 * 1024 },
  { code: 0x04, bytes: 32 * 1024 },
  { code: 0x05, bytes: 64 * 1024 },
];

/** The largest save RAM this console's footer can ask for. */
export const WS_SAVE_MAX = 64 * 1024;

/** The footer code for a save RAM at least `bytes` long, or `undefined` past the largest. */
export function wsSaveCode(bytes: number): number | undefined {
  if (bytes <= 0) return 0x00;
  return WS_SAVE_SIZES.find((size) => size.bytes >= bytes)?.code;
}

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
  /**
   * How many 64 KiB banks `code` is, for a program bigger than one segment.
   *
   * One is the whole of it for a game that fits, and then this changes nothing.
   * A larger program is laid out *backwards from the end* of the cartridge —
   * segment `$F` is the last bank, `$E` the one below it — because those are the
   * segments the processor answers with no banking register ever written, so the
   * image has to end where the address space does (doc 13 §Banked cartridges).
   */
  segments?: number;
  /**
   * Bytes of save RAM the cartridge carries, rounded up to a size it can say.
   *
   * Zero — the default, and every cartridge that fits the console's own memory —
   * declares none. A larger figure is rounded up to the smallest of {@link
   * WS_SAVE_SIZES} that holds it, because what the footer names is a chip.
   */
  saveBytes?: number;
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
  const segments = options.segments ?? 1;
  const image = segments * WS_BANK_SIZE;
  // The last bank's own budget, whatever the program's total: the entry jump and
  // the footer are at the top of it and a program may not reach them.
  const last = segments === 1 ? code.length : code.length - image + WS_BANK_SIZE;
  if (last > WS_CODE_SIZE) {
    throw new Error(`WonderSwan program is ${last} bytes; the bank holds ${WS_CODE_SIZE}`);
  }
  if (code.length > WS_ROM_SIZE) {
    throw new Error(`WonderSwan cartridge is ${WS_ROM_SIZE} bytes; this image is ${code.length}`);
  }
  const rom = new Uint8Array(WS_ROM_SIZE).fill(0xff);
  const bank = WS_ROM_SIZE - WS_BANK_SIZE;
  rom.set(code, WS_ROM_SIZE - image);
  void bank;

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
  const save = wsSaveCode(options.saveBytes ?? 0);
  if (save === undefined) {
    throw new Error(
      `WonderSwan save RAM is ${options.saveBytes} bytes; the largest the footer can say is ${WS_SAVE_MAX}`,
    );
  }
  rom[footer + 5] = save;
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
