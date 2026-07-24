#!/usr/bin/env node
// The prep quality battery (doc 04 §The judge): run every synthetic eval
// source through `prep`, print the tournament scoreboard, and write
// side-by-side comparison sheets (source | winner, nearest-upscaled) for
// human review — quality regressions are caught by *looking*, not only by
// numbers. Build first (`pnpm build`); this consumes the built core.
//
//   pnpm eval:prep                 # gbc battery -> tools/prep-eval/out/
//   pnpm eval:prep -- nes          # another console
//   pnpm eval:prep -- gbc title    # filter sources by substring
//
// Extra local sources (real art, photos — do NOT commit non-public-domain
// files) can be dropped into tools/prep-eval/local/ as *.png; they join the
// battery automatically.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { decodeImage, encodeRgbaPng, prep } from "../../packages/core/dist/index.js";

import { generateBattery } from "./sources.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
mkdirSync(OUT, { recursive: true });

const args = process.argv.slice(2);
const consoleId = args[0] ?? "gbc";
const filter = args[1];

function upscale(img, f) {
  const w = img.width * f;
  const h = img.height * f;
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y += 1)
    for (let x = 0; x < w; x += 1) {
      const si = (Math.floor(y / f) * img.width + Math.floor(x / f)) * 4;
      const oi = (y * w + x) * 4;
      data[oi] = img.data[si];
      data[oi + 1] = img.data[si + 1];
      data[oi + 2] = img.data[si + 2];
      data[oi + 3] = 255;
    }
  return { width: w, height: h, data };
}

function sideBySide(images, pad = 8) {
  const h = Math.max(...images.map((i) => i.height));
  const w = images.reduce((s, i) => s + i.width, 0) + pad * (images.length - 1);
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 34;
    data[i + 1] = 34;
    data[i + 2] = 40;
    data[i + 3] = 255;
  }
  let ox = 0;
  for (const img of images) {
    for (let y = 0; y < img.height; y += 1)
      for (let x = 0; x < img.width; x += 1) {
        const si = (y * img.width + x) * 4;
        const oi = (y * w + ox + x) * 4;
        data[oi] = img.data[si];
        data[oi + 1] = img.data[si + 1];
        data[oi + 2] = img.data[si + 2];
      }
    ox += img.width + pad;
  }
  return encodeRgbaPng(w, h, data);
}

const battery = generateBattery();
const localDir = join(HERE, "local");
if (existsSync(localDir)) {
  for (const f of readdirSync(localDir)) {
    if (f.endsWith(".png")) battery.set(`local-${f.slice(0, -4)}`, readFileSync(join(localDir, f)));
  }
}

let failures = 0;
for (const [name, bytes] of battery) {
  if (filter && !name.includes(filter)) continue;
  const t0 = performance.now();
  let res;
  try {
    res = await prep(bytes, { console: consoleId });
  } catch (err) {
    failures += 1;
    console.error(`${name.padEnd(16)} ${consoleId} FAILED: ${err.message}`);
    continue;
  }
  const ms = Math.round(performance.now() - t0);
  writeFileSync(join(OUT, `${name}.${consoleId}.png`), res.png);
  const srcImg = decodeImage(bytes);
  const outImg = decodeImage(res.png);
  const sf = Math.max(1, Math.round(448 / srcImg.width));
  const of = Math.max(1, Math.round(448 / outImg.width));
  writeFileSync(
    join(OUT, `${name}.${consoleId}.compare.png`),
    sideBySide([upscale(srcImg, sf), upscale(outImg, of)]),
  );
  const board = res.tournament.candidates
    .map(
      (c) =>
        `${c.strategy === res.tournament.winner ? "*" : " "}${c.strategy}=` +
        (c.disqualified ? `DQ:${c.disqualified.reason}` : c.aggregate.toFixed(4)),
    )
    .join(" ");
  console.log(
    `${name.padEnd(16)} ${consoleId} ${String(ms).padStart(5)}ms ` +
      `profile=${res.decisions.profile} size=${res.decisions.size.w}x${res.decisions.size.h} ` +
      `meanDE=${res.stats.meanDeltaE.toFixed(4)} p95DE=${res.stats.p95DeltaE.toFixed(4)} ` +
      `tiles=${res.stats.uniqueTiles}\n  ${board}`,
  );
}
console.log(`\ncompare sheets: ${OUT}`);
if (failures > 0) {
  console.error(`${failures} source(s) failed`);
  process.exit(1);
}
