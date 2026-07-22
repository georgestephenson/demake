/**
 * The CLI's I/O edge (doc 02 §Dependency rules).
 *
 * All filesystem, stdio, and process concerns live here so command handlers
 * stay pure functions of an injectable {@link CliEnv} — trivially unit-testable
 * without spawning a process. The Node implementation ({@link makeNodeEnv}) is
 * the only place `core`-forbidden platform APIs (fs, process) appear.
 */

import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";

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
  };
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
