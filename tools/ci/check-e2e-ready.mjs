#!/usr/bin/env node
/**
 * Guard for the CI E2E job (doc 10, doc 13 §Phase 2).
 *
 * Every pixel-perfect E2E self-skips when its assembler or emulator core is
 * absent — the right behaviour for a developer laptop, and a silent hole in CI,
 * where a provisioning failure would otherwise look like a green run. This
 * asserts the whole Tier 1 loop is actually runnable before `pnpm test` starts:
 * every assembler on PATH, every libretro core built, the capturers present.
 *
 * Exits non-zero with a list of what is missing.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const TC = join(homedir(), ".cache", "demake", "toolchains");

/** Assemblers each `--format rom` family needs. */
const TOOLS = {
  "gb (RGBDS)": ["rgbasm", "rgblink", "rgbfix"],
  "nes (cc65)": ["ca65", "ld65"],
  "sms/gg/sg1000 (WLA-DX z80)": ["wla-z80", "wlalink"],
  "snes (WLA-DX 65816)": ["wla-65816", "wlalink"],
  "md (GNU m68k binutils)": ["m68k-linux-gnu-as", "m68k-linux-gnu-ld", "m68k-linux-gnu-objcopy"],
  "gba/nds (GNU ARM binutils)": ["arm-none-eabi-as", "arm-none-eabi-ld", "arm-none-eabi-objcopy"],
};

/** Emulator artifacts each console family captures frames with. */
const FILES = {
  "gb/gbc (SameBoy capturer)": join(TC, "sameboy-1.0.1", "capture"),
  "libretro runner": join(TC, "libretro", "retrorun"),
  "nes (fceumm)": join(TC, "libretro", "cores", "fceumm_libretro.so"),
  "sms/gg/md/sg1000 (genesis-plus-gx)": join(
    TC,
    "libretro",
    "cores",
    "genesis_plus_gx_libretro.so",
  ),
  "snes (snes9x)": join(TC, "libretro", "cores", "snes9x_libretro.so"),
  "gba (mGBA)": join(TC, "libretro", "cores", "mgba_libretro.so"),
  "nds (DeSmuME)": join(TC, "libretro", "cores", "desmume_libretro.so"),
};

const onPath = (tool) => {
  try {
    execFileSync("command", ["-v", tool], { shell: "/bin/sh", stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

const missing = [];
for (const [label, tools] of Object.entries(TOOLS)) {
  const gone = tools.filter((t) => !onPath(t));
  if (gone.length > 0) missing.push(`${label}: ${gone.join(", ")} not on PATH`);
}
for (const [label, file] of Object.entries(FILES)) {
  if (!existsSync(file)) missing.push(`${label}: missing ${file}`);
}

if (missing.length > 0) {
  console.error("E2E prerequisites are missing — these suites would silently skip:\n");
  for (const line of missing) console.error(`  - ${line}`);
  console.error("\nRun `pnpm toolchains && pnpm emulator` and check their logs.");
  process.exit(1);
}
console.log("E2E prerequisites present: every Tier 1 console can build and boot.");
