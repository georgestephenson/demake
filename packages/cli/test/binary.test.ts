import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * End-to-end surface check: spawn the *built* binary exactly as a user would,
 * so we test the real ESM entry point, the shebang wiring, and the actual
 * process exit code — not just the in-process {@link run} function.
 *
 * The built artifact only exists after `pnpm build`; when it is absent (a bare
 * `vitest run` with no prior build) the suite skips rather than failing. CI
 * builds before testing, so these always execute there.
 */
const binPath = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const built = existsSync(binPath);

interface Spawned {
  status: number;
  stdout: string;
  stderr: string;
}

function runBinary(args: string[]): Spawned {
  try {
    const stdout = execFileSync(process.execPath, [binPath, ...args], {
      encoding: "utf8",
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

describe.skipIf(!built)("built binary", () => {
  it("prints the version and exits 0", () => {
    const { status, stdout } = runBinary(["--version"]);
    expect(status).toBe(0);
    expect(stdout).toMatch(/^demake \d+\.\d+\.\d+/);
  });

  it("prints help and exits 0", () => {
    const { status, stdout } = runBinary(["--help"]);
    expect(status).toBe(0);
    expect(stdout).toContain("Usage:");
  });

  it("exits 2 on an unknown command", () => {
    const { status, stderr } = runBinary(["frobnicate"]);
    expect(status).toBe(2);
    expect(stderr).toContain("unknown command");
  });
});
