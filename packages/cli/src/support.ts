/**
 * The console support matrix: one answer to "what works on this machine today".
 *
 * Every domain used to state its own support in prose — doc 03's tier tables,
 * doc 13's phase notes, AGENTS.md's opening, each `ConsoleSpec`'s comment — and
 * prose drifts. It had: eight specs declare `rom` in `codegen.formats` with no
 * builder behind it. So the table is *derived* instead, from the registries that
 * decide the answers, and `docs/console-support.md` is generated from it with a
 * staleness test the way the man pages are from `cli-spec` (doc 05).
 *
 * This is the one place in the repo that can see all four domains at once —
 * `@demake/core`'s specs, this edge's ROM builders, `@demake/demotic`'s game
 * backends and `@demake/audio`'s drivers — which is why it lives at the CLI
 * rather than in an engine package. Nothing here decides anything: every column
 * is a lookup, and a console becomes supported by gaining a backend, never by
 * being added to a list here.
 */

import { consoles, type ConsoleSpec } from "@demake/core";
import { audioConsoles, gameDriverRate, hasGameAudio } from "@demake/audio";
import { familyFor } from "@demake/demotic";

import { romBuilderFor } from "./rom/registry.js";

/**
 * Families whose ROM output is compared against a real emulator, pixel for
 * pixel (doc 10).
 *
 * The one column that is not a lookup, because a test suite is not a registry —
 * so `test/support.test.ts` cross-checks it against the `*.e2e.test.ts` files on
 * disk in both directions, which is the cheapest thing that cannot go stale
 * silently. Keyed by console id rather than family: the SMS and the Game Gear
 * share a family and are captured from different cores.
 */
export const EMULATOR_PROVEN: Readonly<Record<string, string>> = {
  dmg: "SameBoy",
  gbc: "SameBoy",
  nes: "fceumm",
  snes: "snes9x",
  md: "genesis-plus-gx",
  sms: "genesis-plus-gx",
  gg: "genesis-plus-gx",
  sg1000: "genesis-plus-gx",
  gba: "mGBA",
  nds: "DeSmuME",
  pce: "beetle-pce-fast",
  wsc: "beetle-wswan",
};

/** What works for one console, across all four domains. */
export interface ConsoleSupport {
  id: string;
  name: string;
  tier: 1 | 2 | 3;
  family: string;
  /** `prep`/`inspect` — true for every console with a spec, which is all of them. */
  prep: true;
  /** Codegen formats that really produce something, `rom` included only if it builds. */
  formats: readonly string[];
  /** The assembler `--format rom` needs, when this family builds one. */
  toolchain?: string;
  /** The libretro/SameBoy core the image E2E compares against, when there is one. */
  emulator?: string;
  /** The Demotic codegen family that builds a game for this console, if any. */
  game?: string;
  /** `arrange`/`sfx`/`render` — true where the console's sound hardware is modelled. */
  audio: boolean;
  /** The rate a game's embedded audio driver ticks at here, when a driver exists. */
  gameAudioHz?: number;
}

/**
 * The Demotic backend family for a console, resolved through its aliases.
 *
 * Demotic names the original Game Boy `gb` where the `ConsoleSpec` calls it
 * `dmg` — one of the spec's own aliases, and the reason `findConsole` exists.
 * Asking with the spec id alone would report the Game Boy as having no game
 * backend, which is the sort of quiet wrongness a generated table is supposed to
 * remove rather than enshrine.
 */
function gameFamily(spec: ConsoleSpec): string | undefined {
  for (const id of [spec.id, ...spec.aliases]) {
    const family = familyFor(id);
    if (family !== undefined) return family;
  }
  return undefined;
}

/**
 * Whether a console's chip has a driver a *game* can embed, and at what rate.
 *
 * Two registries have to agree before there is a rate to report, and neither is
 * the console spec: a backend has to exist for the cartridge to go in, and a
 * driver has to exist for that machine's CPU. The Game Boy Advance is why this
 * asks rather than reading `spec.audio` — its sound hardware is fully described
 * and its ARM driver is not written, so the spec alone would say it plays music.
 */
function gameAudio(spec: ConsoleSpec, game: string | undefined): number | undefined {
  if (game === undefined || !hasGameAudio(spec.id)) return undefined;
  return gameDriverRate(spec.id);
}

/** The support matrix, in the registry's own order (tier, then id). */
export function consoleSupport(): ConsoleSupport[] {
  return consoles().map((spec) => {
    // A builder is necessary and not sufficient: the Mega Duck rides the `gb`
    // family for its data and still withholds `rom`, because its display program
    // is not the Game Boy's. The spec's own `formats` is what `gen` gates on.
    const declared = spec.codegen.formats;
    const builder = declared.includes("rom") ? romBuilderFor(spec) : undefined;
    const formats = declared.filter((format) => format !== "rom" || builder !== undefined);
    const game = gameFamily(spec);
    return {
      id: spec.id,
      name: spec.name,
      tier: spec.tier,
      family: spec.codegen.family,
      prep: true,
      formats,
      ...(builder ? { toolchain: builder.toolchain } : {}),
      ...(EMULATOR_PROVEN[spec.id] ? { emulator: EMULATOR_PROVEN[spec.id]! } : {}),
      ...(game ? { game } : {}),
      // What `arrange`, `sfx` and `render` can actually demake, which is the
      // binding registry rather than the spec: a console can have its hardware
      // described before anything encodes for it.
      audio: audioConsoles().includes(spec.id),
      ...((): { gameAudioHz?: number } => {
        const hz = gameAudio(spec, game);
        return hz === undefined ? {} : { gameAudioHz: hz };
      })(),
    };
  });
}

/** A cell for a column that is either a thing or nothing. */
function cell(value: string | undefined): string {
  return value ?? "—";
}

/**
 * A driver rate, to two decimals.
 *
 * The NES's is the console's real frame rate — 60.0988… Hz — and printing every
 * digit of a float in a table is how a regenerated doc gains a diff for no
 * change. Two decimals still distinguish the machines, which is the column's
 * whole job.
 */
function round(hz: number): string {
  return String(Math.round(hz * 100) / 100);
}

/**
 * The generated `docs/console-support.md`.
 *
 * Deterministic and dateless, for the same reason the man pages are: a
 * regenerate-and-diff staleness check cannot tolerate a timestamp.
 */
export function supportMarkdown(): string {
  const rows = consoleSupport();
  const out: string[] = [];
  out.push("# Console support");
  out.push("");
  out.push(
    "**Generated — do not edit.** Run `pnpm gen:console-docs` after changing a console",
    "spec, a ROM builder, a Demotic backend or an audio driver; `packages/cli/test/support.test.ts`",
    "fails CI if this file goes stale. The hardware constraints behind these",
    "columns are [doc 03](03-console-matrix.md); the plan for the empty cells is",
    "[doc 13](13-roadmap.md).",
  );
  out.push("");
  out.push("## What the columns mean");
  out.push("");
  out.push(
    "| Column | Means |",
    "|---|---|",
    "| **art** | `demake prep` fits an image to the hardware and `demake inspect` proves the result compliant. Every console with a `ConsoleSpec` has this. |",
    "| **data** | `demake gen` emits native tiles/maps/palettes as `bin`, `asm` or `c`. |",
    "| **ROM** | `demake gen --format rom` assembles a bootable cartridge that displays the art. Blank means no builder exists at this edge — not that the toolchain is missing on your machine. |",
    "| **emulator** | The ROM's framebuffer is compared against the DAC reference byte for byte in a headless core (doc 10). This is what *supported* means here. |",
    "| **game** | `demake build` compiles a `.dmt` into a cartridge for this console, proven against the reference interpreter tick for tick. |",
    "| **music/sfx** | `demake arrange`, `demake sfx` and `demake render` demake audio for this console's sound hardware. |",
    "| **in-game audio** | A generated driver plays that audio inside a `demake build` cartridge, at this tick rate. |",
  );
  out.push("");
  for (const tier of [1, 2, 3] as const) {
    const inTier = rows.filter((row) => row.tier === tier);
    if (inTier.length === 0) continue;
    out.push(`## Tier ${tier}`);
    out.push("");
    out.push(
      "| Console | id | family | art | data | ROM | emulator | game | music/sfx | in-game audio |",
      "|---|---|---|---|---|---|---|---|---|---|",
    );
    for (const row of inTier) {
      const data = row.formats.filter((format) => format !== "rom");
      const cells = [
        row.name,
        `\`${row.id}\``,
        `\`${row.family}\``,
        "yes",
        data.length > 0 ? data.map((format) => `\`${format}\``).join(" ") : "—",
        cell(row.toolchain),
        cell(row.emulator),
        cell(row.game === undefined ? undefined : `\`${row.game}\``),
        row.audio ? "yes" : "—",
        cell(row.gameAudioHz === undefined ? undefined : `${round(row.gameAudioHz)} Hz`),
      ];
      out.push(`| ${cells.join(" | ")} |`);
    }
    out.push("");
  }
  const proven = rows.filter((row) => row.emulator).length;
  const games = rows.filter((row) => row.game).length;
  out.push("## Totals");
  out.push("");
  out.push(
    `- **${rows.length}** consoles have a spec, so all ${rows.length} do art.`,
    `- **${rows.filter((row) => row.toolchain).length}** build a display ROM; **${proven}** of those are proven pixel-perfect in an emulator.`,
    `- **${games}** compile a Demotic game.`,
    `- **${rows.filter((row) => row.audio).length}** demake music and sound effects; **${rows.filter((row) => row.gameAudioHz).length}** play it from inside a game.`,
  );
  out.push("");
  return out.join("\n");
}
