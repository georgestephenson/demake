#!/usr/bin/env node
/**
 * Web bundle budget (doc 07 §Quality bar).
 *
 * Lighthouse covers the rendered-page metrics; this covers the one number a
 * pull request can regress silently — how much JavaScript a visitor downloads.
 *
 * **It used to be a per-site sum, and the paragraphs below are the history of
 * that number running out.** A sum could not be satisfied by moving code between
 * chunks, only by there being less of it, which is exactly the property you want
 * right up until the site legitimately has to hold five consoles' emitters and
 * five emulator cores. The standing instruction was that the next thing which
 * did not fit should split `core.worker.ts` by family and let the budget become
 * per-visitor. That has happened, so this is the per-visitor figure:
 *
 *     everything a visitor loads, plus the one console they play
 *
 * Every chunk counts once, except the per-console ones — a Demotic backend and
 * its assembler in the worker, and an emulator core in the page — of which a
 * visitor fetches exactly one family's. Those are grouped by the family in their
 * chunk name and only the largest group is charged, because a visitor who plays
 * a Mega Drive never asks for the Super Nintendo's.
 *
 * It is still not gameable by moving code around: shuffling a module between two
 * always-loaded chunks changes nothing, and moving something *into* a per-family
 * chunk only helps if it genuinely belongs to one family, which is the change
 * that was wanted. A chunk whose name is not a family's counts as always-loaded,
 * so a split that stops working fails loudly rather than quietly passing.
 *
 * Usage: node tools/ci/check-web-budget.mjs [dist-dir]
 */

import { gzipSync } from "node:zlib";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const DIST = process.argv[2] ?? "packages/web/dist";
/**
 * The ceiling, in gzipped kilobytes, over the whole site's JavaScript.
 *
 * It is close, and it moved once. The NES cost 4.6 KB gzipped end to end — a
 * second instruction set, a second emulator and a second set of hardware tables,
 * all of it in the bundle because doc 07 forbids fetching a core — its sound
 * driver a further 1.5 KB, a Sega vertical 21 KB, and a Z80 audio driver after
 * that. By the end of all of it the site sat 36 bytes under 300 KB, which is not
 * headroom so much as a coincidence.
 *
 * Running the tournaments in parallel (doc 04 §Running the tournament) then cost
 * 3.3 KB: the executor seam and the content-keyed prologue cache that stops a
 * fan-out decoding its source once per candidate, both in `@demake/core` and so
 * in every chunk that carries the engine — the CLI pays for them too. The page's
 * own share is nil, because a lane is another instance of `core.worker.ts` rather
 * than a new kind of worker; the alternative was measured at 41 KB.
 *
 * It moved a second time for the Mega Drive, and the measurement is worth
 * recording because it is what a console costs end to end: **23.8 KB gzipped**,
 * of which 18.6 KB is the codegen backend and the 68000 encoder in
 * `core.worker.ts` and 5.2 KB is a fourth emulator in the game section. Splitting
 * was considered and does not apply — the sum is a sum precisely so that moving
 * code between chunks cannot satisfy it — and there is no fat to take out of a
 * backend whose value layer is already a quarter the size of the Sega's. What a
 * visitor actually downloads is unchanged in shape: the entry chunk plus the one
 * section they opened.
 *
 * It moved a third time for the Mega Drive's *sound*, and this one is worth
 * reading as a warning rather than as an entry. **16.9 KB gzipped** — 7.0 KB in
 * `core.worker.ts`, 6.3 KB in `audio.worker.ts` and 3.5 KB in the game section —
 * and almost all of it is one thing in three places: `@demake/chip`'s YM2612 is
 * bundled wherever the engine is, because a game build arranges audio, the music
 * demaker arranges audio, and the page's Mega Drive core has the chip in it. The
 * capability is real (six four-operator voices, and a console that was playing
 * four of its ten), and there is no fat in a synthesizer whose two largest
 * blocks are the tables the hardware itself holds in ROM.
 *
 * **But this is the second raise in one line of work, and that is the signal the
 * paragraph below was written to catch.** The split it describes is now overdue:
 * a visitor who opens the music demaker does not need a 68000 emitter, and a
 * visitor who opens the art demaker needs neither. The next change that does not
 * fit should do that work rather than move this number again.
 *
 * The rule has not changed. The next thing that does not fit should still be made
 * smaller first, and a *fifth* console is the point at which "one more backend"
 * stops being an acceptable answer — the way out then is to stop shipping every
 * console's emitter to every visitor, which means splitting `core.worker.ts` by
 * family and letting the budget become per-visitor rather than per-site.
 *
 * **And the fifth console is here, so this raise is the one the paragraph above
 * names.** The Super Nintendo is **49.5 KB gzipped** against `main` at 349.4:
 * 27.6 KB in `core.worker.ts` for the 65816 and SPC700 assemblers and the largest
 * codegen backend of the five, 14.1 KB in the game section for `@demake/snes` —
 * a 65816 whose registers change width at run time, a Mode 1 S-PPU, and an SPC700
 * with its own RAM and timers — and 7.7 KB in `audio.worker.ts` for the S-DSP,
 * its binding, the waveform bank and the generated SPC700 driver. Two processors,
 * two assemblers, two chip-adjacent models and a backend, against 21 KB for the
 * Sega vertical and 4.6 for the NES, which reused a 6502 assembler already here.
 * Nothing is duplicated across chunks — the SPC700 assembler is in the game
 * section because `@demake/snes` assembles its own boot ROM with it, which is the
 * whole reason no core is fetched — and the emulator reaches neither worker.
 *
 * **This raise does not discharge the split; it is the last one that should be
 * taken instead of it.** The work was measured against 306.9 before either Mega
 * Drive raise landed, so what is recorded here is a merge arriving after the
 * warning rather than an argument against it. A sixth console must split
 * `core.worker.ts` by family — the ask has not moved, and this number should not
 * again.
 */
const BUDGET_KB = 400;

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out;
}

let files;
try {
  files = walk(DIST);
} catch {
  console.error(`web budget: no build at ${DIST} — run \`pnpm build:web\` first.`);
  process.exit(1);
}

const scripts = files.filter((f) => f.endsWith(".js"));
if (scripts.length === 0) {
  console.error(`web budget: no JavaScript found in ${DIST} — is this a real build?`);
  process.exit(1);
}

/**
 * The console families a visitor picks exactly one of.
 *
 * `demotic`'s `codegen/registry.ts` and the page's `players/index.ts` both name
 * their modules after the family, so a chunk called `gb-<hash>.js` is the Game
 * Boy's whichever of the two graphs it came out of — and both belong to the same
 * visitor's choice, which is why one list covers them.
 */
const FAMILIES = ["gb", "nes", "sms", "snes", "md", "pce"];

/** The family a chunk belongs to, or null when everyone loads it. */
function familyOf(name) {
  const base = name.slice(name.lastIndexOf("/") + 1).replace(/-[A-Za-z0-9_-]+\.js$/, "");
  return FAMILIES.includes(base) ? base : null;
}

let always = 0;
const perFamily = new Map(FAMILIES.map((f) => [f, 0]));
const rows = [];
for (const file of scripts) {
  const name = file.slice(DIST.length + 1);
  const gz = gzipSync(readFileSync(file), { level: 9 }).length;
  const family = familyOf(name);
  if (family) perFamily.set(family, perFamily.get(family) + gz);
  else always += gz;
  rows.push([name, gz, family]);
}

rows.sort((a, b) => b[1] - a[1]);
for (const [name, gz, family] of rows) {
  console.log(
    `  ${(gz / 1024).toFixed(1).padStart(7)} KB gz  ${name}${family ? `  (${family} only)` : ""}`,
  );
}

const heaviest = [...perFamily.entries()].sort((a, b) => b[1] - a[1])[0] ?? ["none", 0];
const total = always + heaviest[1];
const totalKb = total / 1024;
const siteKb = (always + [...perFamily.values()].reduce((a, b) => a + b, 0)) / 1024;

console.log(`  ${(always / 1024).toFixed(1).padStart(7)} KB gz  every visitor`);
for (const [family, gz] of [...perFamily.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${(gz / 1024).toFixed(1).padStart(7)} KB gz  + ${family}`);
}
console.log(
  `  ${totalKb.toFixed(1).padStart(7)} KB gz  ONE VISITOR (worst family: ${heaviest[0]}) ` +
    `(budget ${BUDGET_KB} KB)`,
);
console.log(`  ${siteKb.toFixed(1).padStart(7)} KB gz  whole site, for reference`);

if (totalKb > BUDGET_KB) {
  console.error(
    `\nweb budget exceeded: ${totalKb.toFixed(1)} KB gzipped > ${BUDGET_KB} KB (doc 07 §Quality bar).`,
  );
  process.exit(1);
}
