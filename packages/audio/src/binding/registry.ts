/**
 * Console → binding resolution.
 *
 * The one place a console id becomes a register encoder, and the one place a
 * chip name in a `ConsoleSpec` is checked. `core` names its chips as plain
 * strings because it may not depend on `@demake/chip` (doc 02 §Dependency
 * rules); this is where that string has to mean something, and where a name that
 * does not resolve becomes a clear error rather than silence.
 */

import { consoles, getConsole, type AudioSpec, type ConsoleSpec } from "@demake/core";

import { gbBinding } from "./gb.js";
import { gbaBinding } from "./gba.js";
import { mdBinding } from "./md.js";
import { ndsBinding } from "./nds.js";
import { nesBinding } from "./nes.js";
import { pceBinding } from "./pce.js";
import { psgBinding } from "./psg.js";
import { sdspBinding } from "./sdsp.js";
import type { ChipBinding } from "./types.js";

/** Thrown when a console cannot be demade to audio, with the reason. */
export class UnsupportedConsoleError extends Error {
  constructor(
    readonly consoleId: string,
    message: string,
  ) {
    super(message);
    this.name = "UnsupportedConsoleError";
  }
}

/** Build the binding for a console id or alias. */
export function bindingFor(consoleId: string): ChipBinding {
  const spec: ConsoleSpec = getConsole(consoleId);
  const audio: AudioSpec | undefined = spec.audio;
  if (!audio) {
    throw new UnsupportedConsoleError(
      spec.id,
      `${spec.name} has no audio spec yet — see docs/16-audio-engine.md §The chips for the consoles that do.`,
    );
  }
  // A console with two chips resolves on the pair rather than on the first of
  // them: a Mega Drive is not "a YM2612 that also has a PSG", it is one
  // instrument of ten voices, and the binding that encodes it has to see both.
  if (audio.chips.length > 1) {
    if (audio.chips[0] === "ym2612" && audio.chips[1] === "sn76489") {
      return mdBinding(spec.id, audio);
    }
    // And the Game Boy Advance, whose two chips are different *kinds* of thing:
    // four channels that generate their own waveform, and a mixer that plays
    // samples. The pair is what a binding has to see for the same reason — ten
    // voices are one instrument, not two.
    if (audio.chips[0] === "gb-apu" && audio.chips[1] === "gba-pcm") {
      return gbaBinding(spec.id, audio);
    }
    throw new UnsupportedConsoleError(
      spec.id,
      `no binding for the chip pair '${audio.chips.join(" + ")}' — a multi-chip console needs one encoder that sees both.`,
    );
  }
  const chip = audio.chips[0];
  switch (chip) {
    case "gb-apu":
      return gbBinding(spec.id, audio);
    case "sn76489":
      return psgBinding(spec.id, audio);
    case "nes-apu":
      return nesBinding(spec.id, audio);
    case "s-dsp":
      return sdspBinding(spec.id, audio);
    case "nds-spu":
      return ndsBinding(spec.id, audio);
    case "huc6280-psg":
      return pceBinding(spec.id, audio);
    default:
      throw new UnsupportedConsoleError(
        spec.id,
        `no binding for chip '${String(chip)}' — a chip model exists only when something can drive it.`,
      );
  }
}

/** Console ids the audio demakers can target today. */
export function audioConsoles(): string[] {
  const out: string[] = [];
  for (const spec of consoles()) {
    if (!spec.audio) continue;
    try {
      bindingFor(spec.id);
      out.push(spec.id);
    } catch {
      // A spec whose chip has no binding is not a target yet; asking for it
      // directly still reports why, which is the behaviour that matters.
    }
  }
  return out;
}
