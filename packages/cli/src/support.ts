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

import {
  backendFor as codegenBackendFor,
  consoles,
  consoleLabel,
  type ConsoleSpec,
} from "@demake/core";
import { audioConsoles, audioRomConsoles, gameDriverRate, hasGameAudio } from "@demake/audio";
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
  // SameBoy's own Mega Duck fork, on a branch of the same repository. It is the
  // third-party opinion this console's rewired I/O map most needs: a register
  // table of ours that was wrong and self-consistent would draw a blank screen
  // there and nothing else in the project could see it.
  megaduck: "SameDuck",
  nes: "fceumm",
  snes: "snes9x",
  md: "genesis-plus-gx",
  sms: "genesis-plus-gx",
  gg: "genesis-plus-gx",
  sg1000: "genesis-plus-gx",
  gba: "mGBA",
  nds: "DeSmuME",
  pce: "beetle-pce-fast",
  neogeo: "geolith",
  ngpc: "beetle-ngp",
  ws: "beetle-wswan",
  wsc: "beetle-wswan",
  vb: "beetle-vb",
};

/** What works for one console, across all four domains. */
export interface ConsoleSupport {
  id: string;
  name: string;
  /** Every name the console was sold under, as one string (doc 03 §Names). */
  label: string;
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
  /**
   * Whether `demake gen <schedule> --format rom` builds a cartridge of its own.
   *
   * A different question from the one beside it, and the pair is why this is a
   * column rather than a sentence: a Master System's cartridges play music
   * inside a *game* and there is no standalone player for that CPU, while every
   * console here that has one has the other. Stating that in prose is what the
   * `--format rom` claim in eight console specs did before this table existed.
   */
  audioRom: boolean;
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
    // A builder is necessary and not sufficient, because a family's builder can
    // serve consoles the family's *spec* does not claim `rom` for. The spec's
    // own `formats` is what `gen` gates on, and it is the narrower of the two.
    //
    // And a *codegen family* is necessary before any of them: `gen` raises
    // `E_UNSUPPORTED_FAMILY` for a console whose family has no backend, whatever
    // format was asked for, so a spec that declares `bin` for one is declaring
    // something no invocation can reach. Six of them did — every console that
    // has a spec and no backend behind it — which is the same overstatement the
    // `rom` filter below already existed to catch, one column to the left.
    const declared = codegenBackendFor(spec.codegen.family) ? spec.codegen.formats : [];
    const builder = declared.includes("rom") ? romBuilderFor(spec) : undefined;
    const formats = declared.filter((format) => format !== "rom" || builder !== undefined);
    const game = gameFamily(spec);
    return {
      id: spec.id,
      name: spec.name,
      label: consoleLabel(spec),
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
      audioRom: audioRomConsoles().includes(spec.id),
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
    "| **audio ROM** | `demake gen <schedule> --format rom` builds a cartridge whose only job is that schedule. |",
    "| **in-game audio** | A generated driver plays that audio inside a `demake build` cartridge, at this tick rate. |",
  );
  out.push("");
  for (const tier of [1, 2, 3] as const) {
    const inTier = rows.filter((row) => row.tier === tier);
    if (inTier.length === 0) continue;
    out.push(`## Tier ${tier}`);
    out.push("");
    out.push(
      "| Console | id | family | art | data | ROM | emulator | game | music/sfx | audio ROM | in-game audio |",
      "|---|---|---|---|---|---|---|---|---|---|---|",
    );
    for (const row of inTier) {
      const data = row.formats.filter((format) => format !== "rom");
      const cells = [
        row.label,
        `\`${row.id}\``,
        `\`${row.family}\``,
        "yes",
        data.length > 0 ? data.map((format) => `\`${format}\``).join(" ") : "—",
        cell(row.toolchain),
        cell(row.emulator),
        cell(row.game === undefined ? undefined : `\`${row.game}\``),
        row.audio ? "yes" : "—",
        row.audioRom ? "yes" : "—",
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
    `- **${rows.filter((row) => row.audio).length}** demake music and sound effects; **${rows.filter((row) => row.gameAudioHz).length}** play it from inside a game, and **${rows.filter((row) => row.audioRom).length}** build a cartridge whose only job is one schedule.`,
  );
  out.push("");
  return out.join("\n");
}

// --- the README's two tables -------------------------------------------------

/**
 * A count and the consoles behind it, phrased against a set the reader has
 * already been given.
 *
 * The README's capability ladder is four rows that overlap almost entirely —
 * every console that compiles a game also builds a display ROM, and every one
 * that demakes music does too bar one — so naming seventeen machines four times
 * is both unreadable and the thing that went stale. This says what is *different*
 * instead: "those seventeen, plus the Neo Geo Pocket", "those seventeen without
 * the Sega SG-1000".
 *
 * It falls back to naming the whole set when the relationship stops holding,
 * which is the property that makes it safe to leave unattended: a console that
 * gained a game backend without a display ROM would turn the row into a list
 * rather than into a sentence that had quietly become false.
 */
export function describeAgainst(
  base: readonly ConsoleSupport[],
  subset: readonly ConsoleSupport[],
): string {
  const baseIds = new Set(base.map((row) => row.id));
  const extra = subset.filter((row) => !baseIds.has(row.id));
  const missing = base.filter((row) => !subset.some((other) => other.id === row.id));
  const names = (rows: readonly ConsoleSupport[]): string =>
    rows.map((row) => `the ${row.name}`).join(", ");
  if (extra.length === 0 && missing.length === 0) return `the same ${base.length}`;
  if (extra.length > 0 && missing.length === 0) return `those ${base.length}, plus ${names(extra)}`;
  if (extra.length === 0 && missing.length > 0) {
    return `those ${base.length} without ${names(missing)}`;
  }
  return subset.map((row) => row.name).join(", ");
}

/** Where a generated region starts and ends in a hand-written file. */
const BEGIN = (name: string): string => `<!-- generated:${name} -->`;
const END = (name: string): string => `<!-- /generated:${name} -->`;

/**
 * The four-row demaker table at the top of the README.
 *
 * The first three columns are editorial and live here as literals, exactly as
 * `console-support.md`'s "what the columns mean" table does; only the status
 * column is derived, and it is the only one that had gone stale — it claimed six
 * game consoles when there were sixteen.
 */
export function readmeDemakerTable(): string {
  const rows = consoleSupport();
  const n = (predicate: (row: ConsoleSupport) => unknown): number => rows.filter(predicate).length;
  const specs = rows.length;
  const proven = n((row) => row.emulator);
  const games = n((row) => row.game);
  const audio = n((row) => row.audio);
  const inGame = n((row) => row.gameAudioHz !== undefined);
  const audioRom = n((row) => row.audioRom);
  const table: [string, string, string, string][] = [
    [
      "**art**",
      "any image",
      "hardware-compliant art, palettes, tile maps, asm/C/binary, bootable ROMs",
      `${specs} consoles; ${proven} proven pixel-perfect in an emulator`,
    ],
    [
      "**game**",
      "a [Demotic](docs/14-demotic.md) `.dmt` script + art",
      "one game, every console",
      `language, preview and playable ROMs on ${games} consoles`,
    ],
    [
      "**music**",
      "a MIDI track",
      "chip music, audio that sounds exactly like the hardware will, and a ROM",
      `${audio} consoles; ${inGame} play it from inside a game, ${audioRom} from a cartridge of its own`,
    ],
    [
      "**sound**",
      "a WAV effect",
      "a chip sound effect, placed and prioritised, and a ROM",
      `${audio} consoles; the same driver, the same cartridge, the same proof`,
    ],
  ];
  const out = ["| Demaker | Input | Output | Status |", "|---|---|---|---|"];
  for (const cells of table) out.push(`| ${cells.join(" | ")} |`);
  return out.join("\n");
}

/**
 * The README's capability ladder: what each rung means, and how many machines
 * are on it.
 *
 * Counts and deltas rather than four long lists — see {@link describeAgainst}. Which
 * console is on which rung is `console-support.md`'s job and is generated there
 * per console, so this table is the shape and that one is the detail.
 */
export function readmeLadderTable(): string {
  const rows = consoleSupport();
  const rom = rows.filter((row) => row.toolchain);
  const game = rows.filter((row) => row.game);
  const audio = rows.filter((row) => row.audio);
  const out = ["| Capability | Consoles |", "|---|---|"];
  out.push(
    `| \`prep\` + \`inspect\` (compliant PNG) | **${rows.length}** — every console with a spec |`,
  );
  out.push(
    "| `gen` (bin/asm/C data) + `--format rom` + **pixel-perfect emulator proof** | " +
      `**${rom.length}** — one rung, not three: nothing emits data it cannot also boot and prove |`,
  );
  out.push(
    `| \`build\` (a Demotic game as a playable ROM) | **${game.length}** — ${describeAgainst(rom, game)} |`,
  );
  out.push(
    `| \`arrange\` / \`sfx\` (chip music and effects) | **${audio.length}** — ${describeAgainst(rom, audio)} |`,
  );
  return out.join("\n");
}

/** Every generated region of `README.md`, keyed by its marker name. */
export function readmeRegions(): Record<string, string> {
  return { "demaker-table": readmeDemakerTable(), "console-ladder": readmeLadderTable() };
}

/**
 * Replace each `<!-- generated:name -->…<!-- /generated:name -->` region.
 *
 * Throws rather than appending when a marker is missing, because a generator
 * that silently wrote nothing is exactly the failure the staleness test exists
 * to prevent — it would pass while the table it was meant to keep current sat
 * frozen in the file.
 *
 * Each body is emitted behind a `prettier-ignore`, and that is not cosmetic: the
 * README is *not* in `.prettierignore` (it is prose somebody meant, and its
 * prose should stay formatted), so without this Prettier would repad every
 * generated table on `lint:fix` and the byte-exact staleness check would fail the
 * moment anyone formatted the repo. Exempting the two blocks keeps the check a
 * byte comparison rather than a fuzzy one — `docs/console-support.md` gets the
 * same guarantee by being in an ignored directory.
 */
export function spliceRegions(text: string, regions: Record<string, string>): string {
  let out = text;
  for (const [name, body] of Object.entries(regions)) {
    const begin = out.indexOf(BEGIN(name));
    const end = out.indexOf(END(name));
    if (begin < 0 || end < 0 || end < begin) {
      throw new Error(`no '${name}' generated region: expected ${BEGIN(name)} … ${END(name)}`);
    }
    const region = `\n\n<!-- prettier-ignore -->\n${body}\n\n`;
    out = out.slice(0, begin + BEGIN(name).length) + region + out.slice(end);
  }
  return out;
}
