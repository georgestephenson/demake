/**
 * The CLI's I/O edge (doc 02 §Dependency rules).
 *
 * All filesystem, stdio, and process concerns live here so command handlers
 * stay pure functions of an injectable {@link CliEnv} — trivially unit-testable
 * without spawning a process. The Node implementation ({@link makeNodeEnv}) is
 * the only place `core`-forbidden platform APIs (fs, process) appear.
 */

import { spawnSync } from "node:child_process";
import {
  accessSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/** Everything a command handler needs from the outside world. */
export interface CliEnv {
  /** Write product text to stdout. */
  out(text: string): void;
  /** Write diagnostics to stderr. */
  errOut(text: string): void;
  /** Write binary product to stdout (for piped output). */
  writeStdout(bytes: Uint8Array): void;
  /** Read a file as bytes, or throw if missing. */
  readFile(path: string): Uint8Array;
  /** Atomically write bytes to a path (temp + rename); honor `force`. */
  writeFileAtomic(path: string, bytes: Uint8Array, force: boolean): void;
  /** Read all of stdin as bytes, or `null` if stdin is an interactive TTY. */
  readStdin(): Uint8Array | null;
  /** Whether stdout is a terminal (governs auto-to-stdout + binary-to-TTY guard). */
  stdoutIsTTY(): boolean;
  /** Whether stdin is a terminal. */
  stdinIsTTY(): boolean;
  /** Environment variables (NO_COLOR, etc.). */
  env: Record<string, string | undefined>;
  /** Resolve an executable on `PATH`, or `null` if absent (for `--format rom`). */
  which(command: string): string | null;
  /** Run a command to completion in `cwd`; captures stdout/stderr as text. */
  run(
    command: string,
    args: readonly string[],
    cwd: string,
  ): { code: number; stdout: string; stderr: string };
  /** Create a fresh temporary directory and return its absolute path. */
  makeTempDir(prefix: string): string;
  /** Recursively remove a path (best-effort; used to clean a temp build dir). */
  removeDir(path: string): void;
  /** Absolute path to the repo's `rom-harness/` dir, or `null` if not found. */
  harnessDir(): string | null;
}

/** A `CliEnv` backed by Node's fs/process. */
export function makeNodeEnv(): CliEnv {
  return {
    out: (text) => process.stdout.write(text),
    errOut: (text) => process.stderr.write(text),
    writeStdout: (bytes) => process.stdout.write(bytes),
    readFile: (path) => new Uint8Array(readFileSync(path)),
    writeFileAtomic: (path, bytes, force) => {
      if (!force && existsSync(path)) {
        const err = new Error(`refusing to overwrite existing file '${path}'`);
        (err as { code?: string }).code = "EEXIST";
        throw err;
      }
      const tmp = join(dirname(path) || ".", `.demake-${process.pid}-${basenameSafe(path)}.tmp`);
      writeFileSync(tmp, bytes);
      try {
        renameSync(tmp, path);
      } catch (error) {
        try {
          unlinkSync(tmp);
        } catch {
          // ignore cleanup failure
        }
        throw error;
      }
    },
    readStdin: () => {
      if (process.stdin.isTTY) return null;
      return readAllFd(0);
    },
    stdoutIsTTY: () => process.stdout.isTTY === true,
    stdinIsTTY: () => process.stdin.isTTY === true,
    env: process.env,
    which: (command) => whichOnPath(command),
    run: (command, args, cwd) => {
      const r = spawnSync(command, args as string[], { cwd, encoding: "utf8" });
      return {
        code: r.status ?? (r.error ? 127 : 1),
        stdout: r.stdout ?? "",
        stderr: r.stderr ?? (r.error ? String(r.error.message) : ""),
      };
    },
    makeTempDir: (prefix) => mkdtempSync(join(tmpdir(), prefix)),
    removeDir: (path) => {
      try {
        rmSync(path, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    },
    harnessDir: () => findHarnessDir(),
  };
}

/** Locate an executable on `PATH` (like `command -v`), or return `null`. */
function whichOnPath(command: string): string | null {
  if (command.includes("/")) {
    return isExecutable(command) ? command : null;
  }
  const path = process.env.PATH ?? "";
  for (const dir of path.split(":")) {
    if (dir.length === 0) continue;
    const full = join(dir, command);
    if (isExecutable(full)) return full;
  }
  return null;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Walk up from this module to find the repo's `rom-harness/` directory. */
function findHarnessDir(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    const candidate = join(dir, "rom-harness");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function basenameSafe(path: string): string {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return path.slice(slash + 1).replace(/[^\w.-]/g, "_");
}

/** Read an entire file descriptor synchronously (used for piped stdin). */
function readAllFd(fd: number): Uint8Array {
  const chunks: Buffer[] = [];
  const buf = Buffer.alloc(65536);
  const handle = fd === 0 ? 0 : openSync(String(fd), "r");
  try {
    for (;;) {
      let bytesRead = 0;
      try {
        bytesRead = readSync(handle, buf, 0, buf.length, null);
      } catch (error) {
        if ((error as { code?: string }).code === "EAGAIN") continue;
        if ((error as { code?: string }).code === "EOF") break;
        throw error;
      }
      if (bytesRead === 0) break;
      chunks.push(Buffer.from(buf.subarray(0, bytesRead)));
    }
  } finally {
    if (fd !== 0) closeSync(handle);
  }
  return new Uint8Array(Buffer.concat(chunks));
}
