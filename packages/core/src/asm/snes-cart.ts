/**
 * The Super Nintendo cartridge wrapper: the LoROM header, its vectors, and the
 * checksum pair.
 *
 * Here rather than in a caller for the reason `gb-cart.ts`, `nes-cart.ts` and
 * `sms-cart.ts` are: a header implemented twice is a header that disagrees in one
 * byte in one of them, and more than one builder will wrap 65816 code into a
 * cartridge once the S-DSP has a driver.
 *
 * **A 128 KiB LoROM cartridge**, which is four banks, and the split is a hardware
 * fact rather than a convenience:
 *
 *   - **Bank `$00` is the program**, visible at `$00:8000`–`$00:FFFF`. Code, the
 *     level tables, the packed tilemaps and the constant pool all live here, and
 *     every address in them is a sixteen-bit absolute reached with the data bank
 *     at zero — which is also where the console's first 8 KiB of work RAM is
 *     mirrored, so one bank holds everything the CPU touches directly.
 *   - **Bank `$01` is the tile bank**, at `$01:8000`–`$01:FFFF`. It is never
 *     executed and never read by an instruction: it reaches video RAM by DMA,
 *     which takes its source bank as a *data byte* ({@link SNES_TILE_BANK}). That
 *     is what lets a game spend sixteen kilobytes on art without spending it out
 *     of the thirty-two the program has.
 *   - **Bank `$02` is the sound processor's image**, at `$02:8000`–`$02:FFFF`.
 *     It is never executed by *this* processor either: the boot reads it with
 *     `long,X` and hands it over four mailbox bytes at a time
 *     ({@link SNES_SPC_BANK}). A bank of its own because the art and the music
 *     are sized by different things, and the fourth bank is padding to a size the
 *     header's capacity field can express.
 *
 * Three things about this header have bitten somebody:
 *
 *   - **It lives at `$FFC0`, inside the first bank.** Unlike the iNES header,
 *     which is a wrapper the console never sees, this is sixty-four bytes of the
 *     cartridge's own address space — the vectors at `$FFE0`–`$FFFF` included, so
 *     the last sixty-four bytes of bank zero are not the program's to use.
 *   - **The reset vector is a *bank-zero* address and the CPU starts in emulation
 *     mode.** There is no native reset vector: `$FFFC` is read with the CPU
 *     pretending to be a 6502, so the first thing a cartridge does is `clc; xce`.
 *   - **The checksum and its complement must sum to `$FFFF`.** The pair is
 *     computed over the whole image with the two fields held at their neutral
 *     values, which is why it can only be stamped once the image exists.
 *
 * Sources: SNESdev Wiki — ROM header (https://snes.nesdev.org/wiki/ROM_header),
 * Memory map (https://snes.nesdev.org/wiki/Memory_map) and Interrupt vectors
 * (https://snes.nesdev.org/wiki/Interrupts).
 */

/**
 * Bytes of the largest LoROM cartridge a demade game ships on: four banks.
 *
 * Bank zero is the program, bank one is the tile art, bank two is the sound
 * processor's image, and the fourth is padding to the next size the header's
 * capacity field can express. It was two banks while the art and the sound
 * shared one, and that stopped working the moment the example library's music
 * had enough parts to fill eight voices: a track's schedule doubled and took the
 * picture's room with it. A bank each is the arrangement the hardware wants
 * anyway — this console takes cartridges up to four megabytes, so 64 KiB was a
 * choice rather than a limit, and the wrong one.
 *
 * A game with nothing to play needs neither the sound processor's bank nor the
 * padding behind it, and ships on {@link SNES_ROM_SIZES}'s smaller entry.
 */
export const SNES_ROM_SIZE = 0x20000;

/**
 * Cartridge sizes, smallest first — which here is a count of banks.
 *
 * Two, or four. Bank zero and bank one are always spoken for: a program and the
 * tile art it draws with, and every game has both. Bank two is the sound
 * processor's image, and a game with no `music` and no `sound` does not have one —
 * so a silent cartridge is 64 KiB and a sounding one is 128, because three banks
 * is not a size the capacity field can express and a mask ROM was a power of two
 * regardless.
 */
export const SNES_ROM_SIZES: readonly number[] = [0x10000, 0x20000];

/** Bytes of one LoROM bank, which is what the CPU sees at `$8000`. */
export const SNES_BANK_SIZE = 0x8000;

/** Where the program is mapped in bank zero, which is where byte zero lands. */
export const SNES_ORIGIN = 0x8000;

/** Where the header sits inside bank zero. */
export const SNES_HEADER_OFFSET = 0x7fc0;

/**
 * Bytes of bank zero a program may use.
 *
 * The header and both vector tables occupy `$FFC0`–`$FFFF`, which is sixty-four
 * bytes *inside* the image. Subtracting them from the budget here is how a
 * program that outgrew the bank becomes a build error naming the game's size
 * instead of a cartridge whose last routine is a vector table.
 */
export const SNES_CODE_SIZE = SNES_HEADER_OFFSET;

/** The bank the tile art lives in, as the DMA controller wants it. */
export const SNES_TILE_BANK = 0x01;

/** Where that bank starts in the CPU's address space. */
export const SNES_TILE_BASE = 0x8000;

/** Bytes of tile art the second bank holds, which is all of it. */
export const SNES_TILE_CAPACITY = SNES_BANK_SIZE;

/** Where that bank's bytes start in the packed image. */
export const SNES_TILE_OFFSET = SNES_BANK_SIZE;

/**
 * The bank the sound processor's image is uploaded from.
 *
 * Its own bank rather than the tail of the art's, because the two are sized by
 * different things and neither can be asked to know how big the other got. The
 * upload reads it with `long,X` and `X` is sixteen bits, so the image is bounded
 * by the bank rather than by the addressing — which is also why it starts at the
 * bank's first byte.
 */
export const SNES_SPC_BANK = 0x02;

/** Where that bank starts in the CPU's address space. */
export const SNES_SPC_BASE = 0x8000;

/** Bytes of it the image may occupy. */
export const SNES_SPC_CAPACITY = SNES_BANK_SIZE;

/** Where its bytes start in the packed image. */
export const SNES_SPC_OFFSET = SNES_BANK_SIZE * 2;

/**
 * The native-mode vectors, as offsets into bank zero.
 *
 * Only two of them matter to a game: `nmi`, which the PPU raises at the start of
 * every vertical blank, and `reset` — which is an *emulation*-mode vector,
 * because that is the mode the CPU comes up in.
 */
export const SNES_VECTORS = {
  nativeCop: 0x7fe4,
  nativeBrk: 0x7fe6,
  nativeAbort: 0x7fe8,
  nativeNmi: 0x7fea,
  nativeIrq: 0x7fee,
  emulationCop: 0x7ff4,
  emulationAbort: 0x7ff8,
  emulationNmi: 0x7ffa,
  emulationReset: 0x7ffc,
  emulationIrq: 0x7ffe,
} as const;

/** What a cartridge declares about itself. */
export interface SnesHeaderOptions {
  /** Up to twenty-one characters, space padded, as the header stores them. */
  title?: string;
  /** The version nibble, 0–15. */
  version?: number;
}

/** The map-mode byte: LoROM, 2.68 MHz. */
const MAP_LOROM = 0x20;

/** The cartridge type: ROM only, no coprocessor, no battery. */
const TYPE_ROM_ONLY = 0x00;

/** The size code, which is `log2(kilobytes)` rather than a number of them. */
function sizeCode(bytes: number): number {
  let code = 0;
  while (1024 << code < bytes) code += 1;
  return code;
}

/**
 * Sum the image into the sixteen bits the header carries.
 *
 * The two fields are held at their neutral values while it is computed — the
 * complement all ones and the checksum all zeros — which is what makes the value
 * reproducible by anything that reads the finished cartridge back.
 */
export function snesChecksum(rom: Uint8Array): number {
  let sum = 0;
  for (let index = 0; index < rom.length; index += 1) {
    if (index === SNES_HEADER_OFFSET + 0x1c || index === SNES_HEADER_OFFSET + 0x1d) {
      sum += 0xff;
      continue;
    }
    if (index === SNES_HEADER_OFFSET + 0x1e || index === SNES_HEADER_OFFSET + 0x1f) continue;
    sum += rom[index] as number;
  }
  return sum & 0xffff;
}

/**
 * Stamp the header and the vectors into a two-bank image.
 *
 * `image` must be one of {@link SNES_ROM_SIZES}: a LoROM cartridge has no short
 * banks, and padding here rather than in the caller is how two builders that
 * produce one stay identical. The size code follows from the length, so a
 * two-bank cartridge cannot describe itself as a four-bank one. The sixty-four bytes at
 * {@link SNES_HEADER_OFFSET} are overwritten, so a program that ran past them
 * would have its code replaced — which the game backend avoids by refusing the
 * build up front rather than discovering the overlap in an emulator.
 *
 * `vectors` names the labels the two tables point at. Everything unnamed is
 * pointed at the reset routine, which is the safe answer for an interrupt this
 * runtime does not serve: a spurious one restarts the game rather than executing
 * whatever the padding is.
 */
export function packSnesRom(
  image: Uint8Array,
  vectors: { reset: number; nmi: number; irq?: number },
  options: SnesHeaderOptions = {},
): Uint8Array {
  if (!SNES_ROM_SIZES.includes(image.length)) {
    throw new Error(
      `a LoROM cartridge is ${SNES_ROM_SIZES.map((n) => n / 1024 + " KiB").join(" or ")}` +
        `, not ${image.length} bytes`,
    );
  }
  const rom = Uint8Array.from(image);
  const at = SNES_HEADER_OFFSET;

  // Twenty-one characters of title, space padded and ASCII only: the header has
  // no encoding, so anything outside it becomes a space rather than a byte a
  // cartridge browser shows as a control character.
  const title = (options.title ?? "DEMOTIC").toUpperCase().slice(0, 21).padEnd(21, " ");
  for (let index = 0; index < 21; index += 1) {
    const code = title.charCodeAt(index);
    rom[at + index] = code >= 0x20 && code <= 0x7e ? code : 0x20;
  }
  rom[at + 0x15] = MAP_LOROM;
  rom[at + 0x16] = TYPE_ROM_ONLY;
  rom[at + 0x17] = sizeCode(image.length);
  rom[at + 0x18] = 0x00; // no cartridge RAM
  rom[at + 0x19] = 0x01; // North America / NTSC, which is the 224-line profile
  rom[at + 0x1a] = 0x00; // no licensee
  rom[at + 0x1b] = (options.version ?? 0) & 0x0f;

  const write = (offset: number, value: number): void => {
    rom[offset] = value & 0xff;
    rom[offset + 1] = (value >> 8) & 0xff;
  };
  const irq = vectors.irq ?? vectors.reset;
  write(SNES_VECTORS.nativeCop, vectors.reset);
  write(SNES_VECTORS.nativeBrk, vectors.reset);
  write(SNES_VECTORS.nativeAbort, vectors.reset);
  write(SNES_VECTORS.nativeNmi, vectors.nmi);
  write(SNES_VECTORS.nativeIrq, irq);
  write(SNES_VECTORS.emulationCop, vectors.reset);
  write(SNES_VECTORS.emulationAbort, vectors.reset);
  write(SNES_VECTORS.emulationNmi, vectors.nmi);
  write(SNES_VECTORS.emulationReset, vectors.reset);
  write(SNES_VECTORS.emulationIrq, irq);

  // Last, because it covers every byte before and after it.
  const sum = snesChecksum(rom);
  write(at + 0x1c, sum ^ 0xffff);
  write(at + 0x1e, sum);
  return rom;
}
