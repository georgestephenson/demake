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
 * **A chunk two consoles share is charged to both of them, not to everyone**, and
 * which chunks those are is read out of the build rather than off their names.
 * `codegen/m68k/` is why: it was the Mega Drive's alone and so was bundled into a
 * chunk called `md-*`, and the moment the Neo Geo shared it — which is the whole
 * point of that directory — the bundler lifted it into a chunk named after
 * neither, and 9.8 KB a Game Boy visitor never fetches became 9.8 KB charged to
 * every visitor. `codegen/mos/` is the same thing between the NES and the PC
 * Engine and `rom/z80-player.ts` between the Sega 8-bits and the Neo Geo, so the
 * name-only rule was overstating the page by twenty kilobytes and would have gone
 * on overstating it by more with every processor a second console reused. So the
 * chunks are walked: from the entry the HTML names, never through a per-family
 * chunk, and what that walk cannot reach belongs to the families that can.
 *
 * It is still not gameable by moving code around: shuffling a module between two
 * always-loaded chunks changes nothing, and moving something *into* a per-family
 * chunk only helps if it genuinely belongs to fewer consoles than all of them —
 * a chunk every family reaches is charged to every family, so the largest is the
 * same number it was when it was charged to nobody in particular. A split that
 * stops working puts its chunk back on a path from the entry and lands in the
 * always-loaded pile, which is the loud failure the name-only rule was for.
 *
 * Usage: node tools/ci/check-web-budget.mjs [dist-dir]
 */

import { gzipSync } from "node:zlib";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { familyFor, runtimeFamilies } from "../../packages/demotic/dist/codegen/registry.js";

const DIST = process.argv[2] ?? "packages/web/dist";
/**
 * The ceiling, in gzipped kilobytes, over what **one visitor** downloads.
 *
 * It was a ceiling over the whole site's JavaScript for most of the history
 * below, which is what those paragraphs are arguing about; the split they kept
 * asking for happened, and the shape is now the one this file's own header
 * describes.
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
 *
 * **It has not.** The Neo Geo and the block editor arrived together and put the
 * figure at 404.5, and what was wrong was the measurement rather than the page:
 * that console shares a 68000 backend with the Mega Drive and a Z80 stream player
 * with the Sega 8-bits, which took twenty kilobytes of two-console code out of
 * the chunks named after a console and charged it to everyone. Reading the import
 * graph instead of the names puts a Game Boy visitor at **378.2 KB**, which is
 * what they were downloading all along. The ask above still stands and the
 * ceiling has not moved.
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
 *
 * **It is that registry's list and not a copy of it**, which is the rule the rest
 * of this repository already runs under and the one place it was not being kept.
 * A hand-written copy sat here until the ARM handhelds landed and nobody added
 * them to it, so `gba-*.js` and `nds-*.js` — 26.8 KB gzipped of emulator and
 * emitter, behind an `import()` like every other core — were charged to *every*
 * visitor for as long as the two lists disagreed. A budget that overstates itself
 * fails the next honest change, which is exactly what it did.
 *
 * A chunk may also be named after a *console* rather than its family — `nds` is
 * the case, because a Nintendo DS is a second player inside the Game Boy
 * Advance's family (`players/index.ts`) — so the lookup asks the registry which
 * family a console belongs to before giving up.
 */
const FAMILIES = [...runtimeFamilies];

/** The family a chunk's *name* claims, or null. */
function namedFamily(name) {
  const base = name.slice(name.lastIndexOf("/") + 1).replace(/-[A-Za-z0-9_-]+\.js$/, "");
  if (FAMILIES.includes(base)) return base;
  return familyFor(base) ?? null;
}

/**
 * Which chunk references which, taken out of the build rather than assumed.
 *
 * A chunk names the ones it pulls in — `from"./x-hash.js"` for a static import,
 * `import("./x-hash.js")` for a lazy one, `new URL("assets/x-hash.js",…)` for a
 * worker — and the hash makes the filename unique enough that finding it in the
 * text *is* finding the edge. Crude, and it is the same crudeness the whole file
 * runs on: this is a budget over what a browser fetches, so what a browser can
 * see is exactly the right level to read it at.
 */
const chunkNames = scripts.map((file) => file.slice(DIST.length + 1));
const source = new Map(chunkNames.map((n, i) => [n, readFileSync(scripts[i], "utf8")]));
const basename = (n) => n.slice(n.lastIndexOf("/") + 1);
const imports = new Map(
  chunkNames.map((n) => [
    n,
    chunkNames.filter((m) => m !== n && source.get(n).includes(basename(m))),
  ]),
);

/**
 * The chunks a visitor loads whichever console they play.
 *
 * Walked from the entry the page's own HTML names, and **not through a
 * per-family chunk** — so what this set holds is everything reachable without
 * having chosen a console. Anything outside it is reachable only *through* a
 * family, which is the thing a name alone could not say.
 *
 * A name is still what makes a chunk a family's, so the loud failure the header
 * describes is intact: a split that stops working puts its chunk back on a path
 * from the entry, and it lands here rather than quietly costing one console.
 */
const html = readFileSync(join(DIST, "index.html"), "utf8");
const entry = chunkNames.filter((n) => html.includes(basename(n)));
if (entry.length === 0) {
  console.error(`web budget: index.html names no chunk in ${DIST} — is this a real build?`);
  process.exit(1);
}
const always = new Set();
for (const start of entry.filter((n) => !namedFamily(n))) {
  const stack = [start];
  while (stack.length > 0) {
    const at = stack.pop();
    if (always.has(at)) continue;
    always.add(at);
    for (const to of imports.get(at)) if (!namedFamily(to)) stack.push(to);
  }
}

/**
 * Which families reach a chunk that is nobody's by name and not always loaded.
 *
 * `codegen/m68k/` is the case that made this necessary: it was the Mega Drive's
 * alone, so it was bundled into a chunk called `md-*` and charged to that
 * console. The Neo Geo now shares it — which is the whole point of the directory
 * — so the bundler lifted it into a chunk named after neither, and 9.8 KB that a
 * Game Boy visitor does not fetch started being charged to every visitor.
 * `codegen/mos/` is the same thing between the NES and the PC Engine, and
 * `rom/z80-player.ts` between the Sega 8-bits and the Neo Geo.
 *
 * A chunk every family reaches costs the same either way — it moves out of the
 * always-loaded pile and into all ten families, and the largest of them is what
 * is charged — so this only ever changes the answer for code a *proper subset*
 * of consoles needs, which is exactly what it should be able to say.
 */
const reachedBy = new Map(chunkNames.map((n) => [n, new Set()]));
for (const chunk of chunkNames) {
  const family = namedFamily(chunk);
  if (!family) continue;
  const stack = [...imports.get(chunk)];
  const seen = new Set();
  while (stack.length > 0) {
    const at = stack.pop();
    if (seen.has(at) || always.has(at) || namedFamily(at)) continue;
    seen.add(at);
    reachedBy.get(at).add(family);
    stack.push(...imports.get(at));
  }
}

let alwaysBytes = 0;
const perFamily = new Map(FAMILIES.map((f) => [f, 0]));
const rows = [];
for (const [index, file] of scripts.entries()) {
  const name = chunkNames[index];
  const gz = gzipSync(readFileSync(file), { level: 9 }).length;
  const family = namedFamily(name);
  const owners = family ? [family] : [...reachedBy.get(name)];
  // Charged to *each* family that can reach it, because only one of them is the
  // console a visitor picked and the largest is what the total takes.
  for (const owner of owners) perFamily.set(owner, perFamily.get(owner) + gz);
  if (owners.length === 0) alwaysBytes += gz;
  rows.push([name, gz, family, owners]);
}

rows.sort((a, b) => b[1] - a[1]);
for (const [name, gz, family, owners] of rows) {
  const label = family
    ? `  (${family} only)`
    : owners.length > 0
      ? `  (${owners.sort().join(", ")})`
      : "";
  console.log(`  ${(gz / 1024).toFixed(1).padStart(7)} KB gz  ${name}${label}`);
}

const heaviest = [...perFamily.entries()].sort((a, b) => b[1] - a[1])[0] ?? ["none", 0];
const total = alwaysBytes + heaviest[1];
const totalKb = total / 1024;
// Every chunk once, which is no longer the sum of the columns: a chunk two
// families reach is charged to both of them and shipped only the once.
const siteKb = rows.reduce((sum, [, gz]) => sum + gz, 0) / 1024;

console.log(`  ${(alwaysBytes / 1024).toFixed(1).padStart(7)} KB gz  every visitor`);
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
