/**
 * Which codegen family this edge can assemble a ROM for, as one list.
 *
 * `--format rom` used to be an if/else chain in `gen.ts`, which meant the answer
 * to "does this console build a ROM" was spelled out in a place nothing else
 * could read. That is the arrangement AGENTS.md warns about for the Demotic
 * backends — "one list says which consoles build" — and it had already drifted:
 * eight `ConsoleSpec`s declare `rom` in `codegen.formats` with no builder behind
 * it, so they fail with `E_TOOLCHAIN_MISSING` (a toolchain problem) rather than
 * `E_UNSUPPORTED_OUTPUT` (the truth). This table is what `gen.ts` dispatches on
 * *and* what the support matrix is generated from, so the two cannot disagree.
 *
 * A family is here when demake can turn `gen` output into a bootable cartridge:
 * the toolchain may still be missing on this machine, which is a different
 * failure and stays each builder's own.
 */

import type { ConsoleSpec, GenResult } from "@demake/core";

import type { CliEnv } from "../env.js";

import { buildGbRom } from "./gb.js";
import { buildGbaRom } from "./gba.js";
import { buildMdRom } from "./md.js";
import { buildNdsRom } from "./nds.js";
import { buildNesRom } from "./nes.js";
import { buildPceRom } from "./pce.js";
import { buildSg1000Rom } from "./sg1000.js";
import { buildSmsRom } from "./sms.js";
import { buildSnesRom } from "./snes.js";
import { buildVbRom } from "./vb.js";
import { buildWscRom } from "./wsc.js";

/** How one family turns `gen` output into a cartridge. */
export interface RomBuilder {
  /**
   * The core format the harness consumes.
   *
   * The GB harness is assembled from RGBDS source with a fixed symbol prefix;
   * every other harness includes the `bin` blobs verbatim.
   */
  readonly format: "asm" | "bin";
  /** The assembler this family needs on `PATH`, for the support matrix. */
  readonly toolchain: string;
  /** The file extension the cartridge takes, which the console may decide. */
  suffix(spec: ConsoleSpec): string;
  build(env: CliEnv, spec: ConsoleSpec, result: GenResult): Uint8Array;
}

/** Every family `--format rom` can assemble, keyed by `codegen.family`. */
export const ROM_BUILDERS: Readonly<Record<string, RomBuilder>> = {
  gb: {
    format: "asm",
    toolchain: "RGBDS",
    // A colour spec builds the colour cartridge: same harness, same assembler,
    // and the extension is what says which machine it came out for.
    suffix: (spec) => (spec.color.model === "rgb" ? ".gbc" : ".gb"),
    build: (env, spec, result) => buildGbRom(env, spec, result.artifacts[0]!.bytes),
  },
  nes: { format: "bin", toolchain: "cc65", suffix: () => ".nes", build: buildNesRom },
  sms: {
    format: "bin",
    toolchain: "WLA-DX",
    suffix: (spec) => (spec.id === "gg" ? ".gg" : ".sms"),
    build: buildSmsRom,
  },
  md: { format: "bin", toolchain: "GNU m68k binutils", suffix: () => ".md", build: buildMdRom },
  sg1000: { format: "bin", toolchain: "WLA-DX", suffix: () => ".sg", build: buildSg1000Rom },
  snes: { format: "bin", toolchain: "WLA-DX", suffix: () => ".sfc", build: buildSnesRom },
  gba: { format: "bin", toolchain: "GNU ARM binutils", suffix: () => ".gba", build: buildGbaRom },
  nds: { format: "bin", toolchain: "GNU ARM binutils", suffix: () => ".nds", build: buildNdsRom },
  pce: { format: "bin", toolchain: "WLA-DX", suffix: () => ".pce", build: buildPceRom },
  wsc: { format: "bin", toolchain: "NASM", suffix: () => ".wsc", build: buildWscRom },
  // The one family with no external assembler behind it: no distribution ships
  // a V810 one, so the display program is emitted with `core`'s own encoder —
  // the same one `demake build` compiles a game with. What keeps that honest is
  // that the cartridge is still booted in a third-party emulator by the E2E.
  vb: {
    format: "bin",
    toolchain: "none (demake's own V810 assembler)",
    suffix: () => ".vb",
    build: buildVbRom,
  },
};

/** The builder for a console's family, or `undefined` when this edge has none. */
export function romBuilderFor(spec: ConsoleSpec): RomBuilder | undefined {
  return ROM_BUILDERS[spec.codegen.family];
}
