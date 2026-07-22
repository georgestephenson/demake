/**
 * `gb` family ROM building (doc 06 §ROM building, doc 10).
 *
 * `core` emits platform-pure data; assembling a bootable ROM needs a toolchain,
 * which lives here at the CLI edge. We take the generated RGBDS `asm` (symbol
 * prefix `demake`), drop it next to the on-disk harness in a temp dir, and run
 * the local RGBDS (`rgbasm`→`rgblink`→`rgbfix`) — the same tools CI uses. If the
 * toolchain is absent, we fail with a clear, actionable `E_TOOLCHAIN_MISSING`
 * (install it with `tools/toolchains/install-rgbds.sh`).
 */

import { join } from "node:path";

import type { ConsoleSpec } from "@demake/core";

import type { CliEnv } from "../env.js";
import { EXIT } from "../exit-codes.js";
import { CliError } from "../io.js";

/** RGBDS versions we build and test against (allow-listed, doc 06). */
const ALLOWED_VERSIONS = [/^0\.8\./, /^0\.9\./];
const RGBDS_TOOLS = ["rgbasm", "rgblink", "rgbfix"] as const;

const INSTALL_HINT =
  "install RGBDS (e.g. run tools/toolchains/install-rgbds.sh, or `pnpm toolchains`), " +
  "or emit bin/asm/c and assemble it yourself.";

function toolchainError(message: string): CliError {
  return new CliError(EXIT.UNAVAILABLE, "E_TOOLCHAIN_MISSING", message, INSTALL_HINT);
}

/** Assert every RGBDS tool is present and version-allowed; returns its version. */
function requireToolchain(env: CliEnv): string {
  for (const tool of RGBDS_TOOLS) {
    if (!env.which(tool)) throw toolchainError(`RGBDS tool '${tool}' is not on PATH`);
  }
  const probe = env.run("rgbasm", ["--version"], ".");
  const version = /v?(\d+\.\d+\.\d+)/.exec(probe.stdout + probe.stderr)?.[1];
  if (!version) throw toolchainError("could not determine the RGBDS version");
  if (!ALLOWED_VERSIONS.some((re) => re.test(version))) {
    throw toolchainError(
      `unsupported RGBDS v${version} (need ${ALLOWED_VERSIONS.map(String).join(" or ")})`,
    );
  }
  return version;
}

/**
 * Build a bootable `.gb`/`.gbc` from the generated `gb` data (RGBDS `asm` with
 * the `demake` symbol prefix). Throws a structured {@link CliError} on missing
 * toolchain or a build failure.
 */
export function buildGbRom(env: CliEnv, spec: ConsoleSpec, dataAsm: Uint8Array): Uint8Array {
  requireToolchain(env);

  const harnessRoot = env.harnessDir();
  if (!harnessRoot) {
    throw new CliError(
      EXIT.INTERNAL,
      "E_HARNESS_MISSING",
      "could not locate rom-harness/ in the repo",
    );
  }
  const harnessPath = join(harnessRoot, "gb", "main.asm");
  let harness: Uint8Array;
  try {
    harness = env.readFile(harnessPath);
  } catch {
    throw new CliError(EXIT.INTERNAL, "E_HARNESS_MISSING", `cannot read harness '${harnessPath}'`);
  }

  const isColor = spec.color.model === "rgb";
  const dir = env.makeTempDir("demake-rom-");
  try {
    env.writeFileAtomic(join(dir, "demake.asm"), dataAsm, true);
    env.writeFileAtomic(join(dir, "main.asm"), harness, true);

    runStep(env, dir, "rgbasm", ["-o", "main.o", "main.asm"]);
    runStep(env, dir, "rgblink", ["-o", "out.gb", "main.o"]);
    // rgbfix writes the Nintendo logo, header, and checksums; -C marks a CGB ROM.
    runStep(
      env,
      dir,
      "rgbfix",
      isColor ? ["-v", "-C", "-p", "0xFF", "out.gb"] : ["-v", "-p", "0xFF", "out.gb"],
    );

    return env.readFile(join(dir, "out.gb"));
  } finally {
    env.removeDir(dir);
  }
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
