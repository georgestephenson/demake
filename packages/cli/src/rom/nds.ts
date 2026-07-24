/**
 * `nds` family ROM building (doc 06 §ROM building, doc 10).
 *
 * Assembles the Nintendo DS harness with the local GNU ARM binutils
 * (`arm-none-eabi-as` → `-ld` → `-objcopy -O binary`) and packs the two
 * resulting binaries into a `.nds` cartridge **here** — demake writes the
 * cartridge header itself rather than depending on devkitARM/ndstool, exactly as
 * it writes the GB/NES/MD headers. The layout follows GBATEK's cartridge header:
 * a 0x4000-byte header region, the ARM9 binary at 0x4000 (the offset homebrew
 * uses), then the ARM7 binary, with both CRC16 fields filled in.
 *
 * The image screen entries are placed top-left into a full 32-wide screen block
 * so the harness's flat copy reproduces them in VRAM. Missing toolchain yields a
 * clear `E_TOOLCHAIN_MISSING`.
 */

import { join } from "node:path";

import type { ConsoleSpec, GenResult, TileLayout } from "@demake/core";

import type { CliEnv } from "../env.js";
import { EXIT } from "../exit-codes.js";
import { CliError } from "../io.js";

const AS = "arm-none-eabi-as";
const LD = "arm-none-eabi-ld";
const OBJCOPY = "arm-none-eabi-objcopy";
const MAP_W = 32; // screen-block stride (32×32 entries), the harness's BG0CNT
const MAP_H = 32;
const HEADER_SIZE = 0x4000; // cartridge header region; ARM9 follows it
const ARM9_RAM = 0x02000000;
const ARM7_RAM = 0x02380000;
const INSTALL_HINT =
  "install the GNU arm-none-eabi binutils (run tools/toolchains/install-arm.sh, or " +
  "`pnpm toolchains`), or emit bin/asm/c and assemble it yourself.";

function requireToolchain(env: CliEnv): void {
  for (const tool of [AS, LD, OBJCOPY]) {
    if (!env.which(tool)) {
      throw new CliError(
        EXIT.UNAVAILABLE,
        "E_TOOLCHAIN_MISSING",
        `ARM tool '${tool}' is not on PATH`,
        INSTALL_HINT,
      );
    }
  }
}

function blob(result: GenResult, suffix: string): Uint8Array {
  const art = result.artifacts.find((a) => a.suffix === suffix);
  if (!art) throw new CliError(EXIT.INTERNAL, "E_INTERNAL", `nds gen missing ${suffix}`);
  return art.bytes;
}

/** Build a `.nds` from the NDS-family `bin` artifacts. */
export function buildNdsRom(env: CliEnv, spec: ConsoleSpec, result: GenResult): Uint8Array {
  requireToolchain(env);

  const harnessRoot = env.harnessDir();
  if (!harnessRoot) {
    throw new CliError(EXIT.INTERNAL, "E_HARNESS_MISSING", "could not locate rom-harness/");
  }
  const ndsDir = join(harnessRoot, "nds");
  const sources: Record<string, Uint8Array> = {};
  try {
    for (const name of ["arm9.s", "arm9.ld", "arm7.s", "arm7.ld"]) {
      sources[name] = env.readFile(join(ndsDir, name));
    }
  } catch {
    throw new CliError(
      EXIT.INTERNAL,
      "E_HARNESS_MISSING",
      `cannot read the NDS harness in ${ndsDir}`,
    );
  }

  const layout = spec.layout as TileLayout;
  const screen = placeScreen(blob(result, ".map.bin"), result, layout);

  const dir = env.makeTempDir("demake-nds-");
  try {
    env.writeFileAtomic(join(dir, "tiles.bin"), blob(result, ".tiles.bin"), true);
    env.writeFileAtomic(join(dir, "pal.bin"), blob(result, ".pal.bin"), true);
    env.writeFileAtomic(join(dir, "screen.bin"), screen, true);
    for (const [name, bytes] of Object.entries(sources)) {
      env.writeFileAtomic(join(dir, name), bytes, true);
    }

    const arm9 = assemble(env, dir, "arm9", "arm946e-s");
    const arm7 = assemble(env, dir, "arm7", "arm7tdmi");
    return packCartridge(arm9, arm7);
  } finally {
    env.removeDir(dir);
  }
}

/** Place the image screen entries top-left into the full 32×32-entry block. */
function placeScreen(map: Uint8Array, result: GenResult, layout: TileLayout): Uint8Array {
  const tilesX = result.image.width / layout.tileW;
  const tilesY = result.image.height / layout.tileH;
  const screen = new Uint8Array(MAP_W * MAP_H * 2);
  for (let ty = 0; ty < tilesY && ty < MAP_H; ty += 1) {
    for (let tx = 0; tx < tilesX && tx < MAP_W; tx += 1) {
      const s = (ty * tilesX + tx) * 2;
      const d = (ty * MAP_W + tx) * 2;
      screen[d] = map[s]!;
      screen[d + 1] = map[s + 1]!;
    }
  }
  return screen;
}

/** Assemble + link + objcopy one processor's harness into a flat binary. */
function assemble(env: CliEnv, dir: string, stem: string, cpu: string): Uint8Array {
  runStep(env, dir, AS, [`-mcpu=${cpu}`, `${stem}.s`, "-o", `${stem}.o`]);
  runStep(env, dir, LD, ["-T", `${stem}.ld`, `${stem}.o`, "-o", `${stem}.elf`]);
  runStep(env, dir, OBJCOPY, ["-O", "binary", `${stem}.elf`, `${stem}.bin`]);
  return env.readFile(join(dir, `${stem}.bin`));
}

/** The CRC16 the DS cartridge header uses (poly 0xA001, init 0xFFFF). */
function crc16(bytes: Uint8Array): number {
  let crc = 0xffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >> 1) ^ 0xa001 : crc >> 1;
    }
  }
  return crc & 0xffff;
}

/** Pack the header + both binaries into a `.nds` image (GBATEK cart header). */
function packCartridge(arm9: Uint8Array, arm7: Uint8Array): Uint8Array {
  const arm9Off = HEADER_SIZE;
  const arm7Off = align(arm9Off + arm9.length, 0x200);
  const used = arm7Off + arm7.length;

  let size = 1 << 17; // 128 KiB floor, then the next power of two
  while (size < used) size <<= 1;
  const rom = new Uint8Array(size);
  const view = new DataView(rom.buffer);
  const put = (off: number, value: number): void => view.setUint32(off, value, true);

  ascii(rom, 0x000, "DEMAKE", 12); // game title
  ascii(rom, 0x00c, "DMKE", 4); // game code
  ascii(rom, 0x010, "00", 2); // maker code
  rom[0x012] = 0x00; // unit code: NDS
  rom[0x014] = Math.max(0, Math.round(Math.log2(size)) - 17); // device capacity
  put(0x020, arm9Off);
  put(0x024, ARM9_RAM); // ARM9 entry
  put(0x028, ARM9_RAM); // ARM9 load address
  put(0x02c, arm9.length);
  put(0x030, arm7Off);
  put(0x034, ARM7_RAM); // ARM7 entry
  put(0x038, ARM7_RAM); // ARM7 load address
  put(0x03c, arm7.length);
  put(0x060, 0x00586000); // port 0x40001A4 setting, normal commands
  put(0x064, 0x001808f8); // port 0x40001A4 setting, KEY1 commands
  put(0x080, used); // total used ROM size
  put(0x084, 0x00004000); // ROM header size
  // 0x0C0: the BIOS-checked Nintendo logo. Direct boot (every emulator, and the
  // only way a demake ROM is ever run) does not check it, and demake never ships
  // a copyrighted logo, so the area and its CRC stay zero.
  view.setUint16(0x15e, crc16(rom.subarray(0, 0x15e)), true); // header CRC16

  rom.set(arm9, arm9Off);
  rom.set(arm7, arm7Off);
  return rom;
}

function align(value: number, to: number): number {
  return Math.ceil(value / to) * to;
}

function ascii(rom: Uint8Array, off: number, text: string, len: number): void {
  for (let i = 0; i < len; i += 1) rom[off + i] = i < text.length ? text.charCodeAt(i) & 0x7f : 0;
}

function runStep(env: CliEnv, cwd: string, tool: string, args: readonly string[]): void {
  const r = env.run(tool, args, cwd);
  if (r.code !== 0) {
    const detail = (r.stderr || r.stdout).trim().split("\n").slice(0, 4).join("; ");
    throw new CliError(
      EXIT.FAILURE,
      "E_ROM_BUILD_FAILED",
      `${tool} failed (exit ${r.code})${detail ? `: ${detail}` : ""}`,
      "this is likely a harness/toolchain mismatch; please file a bug with the input.",
    );
  }
}
