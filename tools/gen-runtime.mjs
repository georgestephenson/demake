#!/usr/bin/env node
/**
 * Assemble `runtime-harness/gb/main.asm` and check the image in as TypeScript.
 *
 * The runtime is fixed — a game changes the tables, never the engine — so the
 * assembler belongs at *authoring* time, the way `pnpm gen:man` puts roff
 * generation there. A checked-in image is what lets `demake build` and the web
 * app produce a ROM with no toolchain at all, and a staleness test (the same
 * shape the man pages use) is what stops the source and the image drifting.
 *
 * Only the runtime half of the cartridge is stored. The top 16 KiB is the
 * game's data window, which is zeros in the image and patched per build.
 *
 * Usage: node tools/gen-runtime.mjs [--check]
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const harness = join(root, "runtime-harness", "gb");
const target = join(root, "packages", "demotic", "src", "rom", "runtime-gb.generated.ts");

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function encode(bytes) {
  let text = "";
  for (let at = 0; at < bytes.length; at += 3) {
    const a = bytes[at];
    const b = at + 1 < bytes.length ? bytes[at + 1] : undefined;
    const c = at + 2 < bytes.length ? bytes[at + 2] : undefined;
    text += BASE64[a >> 2];
    text += BASE64[((a & 3) << 4) | ((b ?? 0) >> 4)];
    text += b === undefined ? "=" : BASE64[((b & 15) << 2) | ((c ?? 0) >> 6)];
    text += c === undefined ? "=" : BASE64[c & 63];
  }
  return text;
}

function assemble() {
  const dir = mkdtempSync(join(tmpdir(), "demake-runtime-"));
  try {
    execFileSync("rgbasm", ["-o", join(dir, "main.o"), "main.asm"], {
      cwd: harness,
      stdio: ["ignore", "pipe", "pipe"],
    });
    execFileSync(
      "rgblink",
      // -t: one 32 KiB ROM0 bank. -w: the DMG's WRAM is 8 KiB and unbanked.
      ["-t", "-w", "-o", join(dir, "runtime.gb"), join(dir, "main.o")],
      { cwd: harness, stdio: ["ignore", "pipe", "pipe"] },
    );
    return readFileSync(join(dir, "runtime.gb")).subarray(0, 0x4000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function render(bytes) {
  const encoded = encode(bytes);
  const lines = [];
  for (let at = 0; at < encoded.length; at += 96) {
    lines.push(`  "${encoded.slice(at, at + 96)}" +`);
  }
  lines[lines.length - 1] = lines[lines.length - 1].replace(/ \+$/, ";");
  return [
    "/**",
    " * The assembled `gb` Demotic runtime — generated, never hand-edited.",
    " *",
    " * Produced by `pnpm gen:runtime` from `runtime-harness/gb/main.asm`; a test",
    " * fails if the two drift. Only the engine half of the cartridge is stored: the",
    " * top 16 KiB is the game's data window, which `buildGbRom` patches per build.",
    " *",
    " * Base64 rather than a byte array because a 16 KiB array literal is a megabyte",
    " * of source and parses like one.",
    " */",
    "",
    "/** The runtime image, base64. */",
    "export const RUNTIME_GB =",
    ...lines,
    "",
  ].join("\n");
}

const check = process.argv.includes("--check");
let assembled;
try {
  assembled = assemble();
} catch (error) {
  const detail = error?.stderr?.toString().trim() || error?.message || String(error);
  console.error(`gen:runtime — RGBDS is required to regenerate the runtime image.\n${detail}`);
  process.exit(1);
}

const rendered = render(assembled);
if (check) {
  const current = readFileSync(target, "utf8");
  if (current !== rendered) {
    console.error("gen:runtime — the checked-in runtime image is stale; run `pnpm gen:runtime`.");
    process.exit(1);
  }
  console.log("gen:runtime — the checked-in runtime image is current.");
} else {
  writeFileSync(target, rendered);
  console.log(`gen:runtime — wrote ${assembled.length} bytes to ${target}`);
}
