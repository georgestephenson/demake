/**
 * The schedule sidecar — what `--emit-manifest` writes (doc 16 §Artifacts).
 *
 * It lives here rather than in the CLI because it is not a CLI concern: the
 * sidecar carries the *whole* `ChipScript`, exact tick timing included, and it is
 * what `demake render` and `demake gen --format rom` read back. Two callers
 * produce it — the command line and the web app — and a shape defined in one of
 * them is a shape the other can only reimplement, which is the failure the image
 * path's `buildManifest`/`encodeManifest` already exist to prevent.
 *
 * The encoding is pinned here too, down to the trailing newline, because these
 * are output bytes: the file the page downloads has to be the file the CLI
 * writes, byte for byte, or feeding one back into the other is a guess.
 */

import type { ArrangeResult } from "./arrange/index.js";
import type { SfxResult } from "./sfx/index.js";
import type { ChipScript, Dropped } from "./chipscript.js";

/** The sidecar `demake arrange --emit-manifest` writes. */
export interface ArrangeManifest {
  schemaVersion: 1;
  script: ChipScript;
  dropped: Dropped[];
  diagnostics: ArrangeResult["diagnostics"];
  tournament: ArrangeResult["tournament"];
}

/** The sidecar `demake sfx --emit-manifest` writes. */
export interface SfxManifest {
  schemaVersion: 1;
  script: ChipScript;
  soundClass: SfxResult["soundClass"];
  placement: SfxResult["placement"];
  diagnostics: SfxResult["diagnostics"];
  tournament: SfxResult["tournament"];
}

/** Either sidecar; both are read back through {@link ChipScript}. */
export type AudioManifest = ArrangeManifest | SfxManifest;

/** The sidecar for an arrangement. */
export function arrangeManifest(result: ArrangeResult): ArrangeManifest {
  return {
    schemaVersion: 1,
    script: result.script,
    dropped: result.dropped,
    diagnostics: result.diagnostics,
    tournament: result.tournament,
  };
}

/** The sidecar for a demade effect. */
export function sfxManifest(result: SfxResult): SfxManifest {
  return {
    schemaVersion: 1,
    script: result.script,
    soundClass: result.soundClass,
    placement: result.placement,
    diagnostics: result.diagnostics,
    tournament: result.tournament,
  };
}

/** Encode a sidecar exactly as it is written to disk (2-space JSON, UTF-8). */
export function encodeAudioManifest(manifest: AudioManifest): Uint8Array {
  return utf8(JSON.stringify(manifest, null, 2) + "\n");
}

/**
 * UTF-8, written out rather than borrowed.
 *
 * `TextEncoder` is a host global and this package may not reach for one (doc 02
 * §Dependency rules) — and a diagnostic's message can carry an em dash, so
 * truncating to bytes the way the image manifest does would corrupt it.
 */
function utf8(text: string): Uint8Array {
  const bytes: number[] = [];
  for (const character of text) {
    const code = character.codePointAt(0)!;
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return Uint8Array.from(bytes);
}
