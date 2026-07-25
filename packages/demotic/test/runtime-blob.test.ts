/**
 * The checked-in runtime image must match the assembly it came from.
 *
 * Same bargain as the man pages (doc 05): the artifact is generated, checked in
 * so that building a ROM needs no toolchain, and guarded by a staleness test so
 * the source and the artifact cannot drift. It self-skips where RGBDS is
 * absent, exactly as the ROM E2E does — CI provisions it and therefore runs it.
 */

import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import { decodeBase64, encodeBase64 } from "../src/rom/gb.js";
import { RUNTIME_GB } from "../src/rom/runtime-gb.generated.js";

function hasRgbds(): boolean {
  try {
    execFileSync("rgbasm", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("the gb runtime image", () => {
  it("decodes to a full 16 KiB engine half", () => {
    const bytes = decodeBase64(RUNTIME_GB);
    expect(bytes.length).toBe(0x4000);
    // $0100 is the cartridge entry point: nop; jp <entry>.
    expect(bytes[0x100]).toBe(0x00);
    expect(bytes[0x101]).toBe(0xc3);
    // The logo area stays zero — we ship no copyrighted data (doc 06).
    expect([...bytes.subarray(0x104, 0x134)].every((byte) => byte === 0)).toBe(true);
  });

  it("round-trips through the base64 the generator writes", () => {
    expect(encodeBase64(decodeBase64(RUNTIME_GB))).toBe(RUNTIME_GB);
  });

  it.skipIf(!hasRgbds())("is current with runtime-harness/gb/main.asm", () => {
    const root = new URL("../../..", import.meta.url).pathname;
    expect(() =>
      execFileSync("node", ["tools/gen-runtime.mjs", "--check"], { cwd: root, stdio: "pipe" }),
    ).not.toThrow();
  });
});
