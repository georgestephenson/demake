// Deterministic synthetic sources for the prep quality battery (doc 04 §The
// judge, doc 10). Each mimics a real-world input class rather than a unit-test
// pattern: an AA'd pixel-art portrait (the AI-output-with-blur use case the
// predecessor prep script was built for), a title screen with gradient sky +
// logo text, an in-game platformer scene, hi-res painted art, a noisy
// continuous-tone "photo", and already-flat console-native art. Everything is
// generated — nothing to license, nothing binary in git — and stable across
// runs so numbers are comparable over time.
import { encodeRgbaPng } from "../../packages/core/dist/index.js";

function img(w, h) {
  return { w, h, data: new Uint8Array(w * h * 4).fill(255) };
}
function px(im, x, y, [r, g, b]) {
  if (x < 0 || y < 0 || x >= im.w || y >= im.h) return;
  const o = (y * im.w + x) * 4;
  im.data[o] = r;
  im.data[o + 1] = g;
  im.data[o + 2] = b;
  im.data[o + 3] = 255;
}
function get(im, x, y) {
  const cx = Math.min(im.w - 1, Math.max(0, x));
  const cy = Math.min(im.h - 1, Math.max(0, y));
  const o = (cy * im.w + cx) * 4;
  return [im.data[o], im.data[o + 1], im.data[o + 2]];
}
function rect(im, x0, y0, w, h, c) {
  for (let y = y0; y < y0 + h; y += 1) for (let x = x0; x < x0 + w; x += 1) px(im, x, y, c);
}
function disc(im, cx, cy, r, c) {
  for (let y = Math.floor(cy - r); y <= cy + r; y += 1)
    for (let x = Math.floor(cx - r); x <= cx + r; x += 1)
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) px(im, x, y, c);
}
function encode(im) {
  return encodeRgbaPng(im.w, im.h, im.data);
}

// Deterministic LCG so the battery is identical on every run.
function makeRng(seed) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

/** Bilinear upscale + binomial blur — fakes AI-output / scaled-art AA halos. */
function upscaleAA(src, factor) {
  const out = img(src.w * factor, src.h * factor);
  for (let y = 0; y < out.h; y += 1) {
    for (let x = 0; x < out.w; x += 1) {
      const fx = (x + 0.5) / factor - 0.5;
      const fy = (y + 0.5) / factor - 0.5;
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const tx = fx - x0;
      const ty = fy - y0;
      const c00 = get(src, x0, y0);
      const c10 = get(src, x0 + 1, y0);
      const c01 = get(src, x0, y0 + 1);
      const c11 = get(src, x0 + 1, y0 + 1);
      const c = [0, 1, 2].map((i) =>
        Math.round(
          c00[i] * (1 - tx) * (1 - ty) +
            c10[i] * tx * (1 - ty) +
            c01[i] * (1 - tx) * ty +
            c11[i] * tx * ty,
        ),
      );
      px(out, x, y, c);
    }
  }
  const bl = img(out.w, out.h);
  for (let y = 0; y < out.h; y += 1) {
    for (let x = 0; x < out.w; x += 1) {
      const acc = [0, 0, 0];
      let n = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const c = get(out, x + dx, y + dy);
          const w = dx === 0 && dy === 0 ? 4 : dx === 0 || dy === 0 ? 2 : 1;
          acc[0] += c[0] * w;
          acc[1] += c[1] * w;
          acc[2] += c[2] * w;
          n += w;
        }
      }
      px(
        bl,
        x,
        y,
        acc.map((v) => Math.round(v / n)),
      );
    }
  }
  return bl;
}

function portrait() {
  const P = {
    outline: [24, 16, 16],
    skin: [232, 190, 148],
    skinShade: [196, 148, 108],
    hair: [88, 40, 24],
    hairHi: [140, 68, 36],
    eyeWhite: [244, 244, 236],
    iris: [40, 96, 168],
    mouth: [176, 48, 56],
    shirt: [72, 56, 128],
    shirtHi: [108, 88, 168],
    bg: [48, 120, 112],
    bgDark: [32, 88, 84],
  };
  const im = img(56, 56);
  rect(im, 0, 0, 56, 56, P.bg);
  for (let y = 0; y < 20; y += 1)
    for (let x = 0; x < 56; x += 1) if ((x + y) % 11 === 0) px(im, x, y, P.bgDark);
  rect(im, 8, 44, 40, 12, P.shirt);
  rect(im, 8, 44, 40, 2, P.shirtHi);
  rect(im, 6, 46, 2, 10, P.outline);
  rect(im, 48, 46, 2, 10, P.outline);
  rect(im, 24, 38, 8, 8, P.skinShade);
  disc(im, 28, 24, 14, P.skin);
  for (let y = 8; y <= 18; y += 1)
    for (let x = 13; x <= 43; x += 1)
      if ((x - 28) ** 2 + (y - 24) ** 2 <= 208) px(im, x, y, P.hair);
  rect(im, 13, 16, 4, 12, P.hair);
  rect(im, 39, 16, 4, 12, P.hair);
  rect(im, 16, 10, 10, 3, P.hairHi);
  rect(im, 20, 22, 5, 4, P.eyeWhite);
  rect(im, 31, 22, 5, 4, P.eyeWhite);
  rect(im, 22, 23, 2, 3, P.iris);
  rect(im, 33, 23, 2, 3, P.iris);
  rect(im, 19, 21, 7, 1, P.outline);
  rect(im, 30, 21, 7, 1, P.outline);
  rect(im, 27, 28, 2, 3, P.skinShade);
  rect(im, 24, 33, 8, 2, P.mouth);
  for (let y = 16; y <= 36; y += 1)
    for (let x = 14; x <= 19; x += 1)
      if ((x - 28) ** 2 + (y - 24) ** 2 <= 196) px(im, x, y, P.skinShade);
  for (let a = 0; a < 360; a += 1) {
    const x = Math.round(28 + 14 * Math.cos((a * Math.PI) / 180));
    const y = Math.round(24 + 14 * Math.sin((a * Math.PI) / 180));
    if (y >= 18) px(im, x, y, P.outline);
  }
  return im;
}

function titleScreen(rnd) {
  const im = img(160, 144);
  for (let y = 0; y < 96; y += 1) {
    const t = y / 96;
    const c = [Math.round(40 + 180 * t), Math.round(24 + 90 * t), Math.round(96 - 40 * t)];
    for (let x = 0; x < 160; x += 1) px(im, x, y, c);
  }
  disc(im, 128, 26, 12, [252, 240, 200]);
  disc(im, 124, 22, 4, [232, 214, 168]);
  for (let x = 0; x < 160; x += 1) {
    const hgt = 20 + Math.round(14 * Math.abs(Math.sin(x * 0.15))) + (x % 24 < 10 ? 8 : 0);
    for (let y = 96 - hgt; y < 96; y += 1) px(im, x, y, [24, 20, 48]);
  }
  for (let i = 0; i < 40; i += 1) {
    const x = Math.floor(rnd() * 158);
    const y = 70 + Math.floor(rnd() * 22);
    px(im, x, y, [255, 216, 96]);
    px(im, x + 1, y, [255, 216, 96]);
  }
  rect(im, 0, 96, 160, 48, [32, 96, 48]);
  for (let x = 0; x < 160; x += 3) rect(im, x, 96 + (x % 9 === 0 ? 0 : 2), 1, 4, [48, 128, 64]);
  const glyphs = {
    Z: ["#####", "...#.", "..#..", ".#...", "#####"],
    B: ["####.", "#...#", "####.", "#...#", "####."],
    2: ["####.", "....#", ".###.", "#....", "#####"],
  };
  const drawGlyph = (g, ox, oy, s, fill) => {
    const rows = glyphs[g];
    for (let r = 0; r < 5; r += 1)
      for (let c = 0; c < 5; c += 1)
        if (rows[r][c] === "#") rect(im, ox + c * s, oy + r * s, s, s, fill);
  };
  const logo = [
    ["Z", 22],
    ["B", 62],
    ["2", 108],
  ];
  for (const [g, x] of logo) drawGlyph(g, x - 2, 34, 6, [255, 224, 64]);
  for (const [g, x] of logo) drawGlyph(g, x, 36, 6, [200, 32, 40]);
  return im;
}

function platformer() {
  const im = img(160, 144);
  rect(im, 0, 0, 160, 144, [92, 148, 252]);
  for (const [cx, cy, r] of [
    [30, 24, 9],
    [42, 22, 7],
    [120, 40, 10],
    [132, 38, 6],
  ]) {
    disc(im, cx, cy, r, [248, 248, 248]);
    disc(im, cx + 4, cy + 2, r - 2, [216, 228, 248]);
  }
  for (let x = 0; x < 160; x += 1) {
    const hgt = 26 + Math.round(12 * Math.sin(x * 0.05 + 1));
    for (let y = 112 - hgt; y < 112; y += 1) px(im, x, y, [56, 135, 66]);
  }
  rect(im, 0, 112, 160, 32, [116, 80, 48]);
  rect(im, 0, 112, 160, 4, [60, 172, 72]);
  for (let x = 0; x < 160; x += 8) rect(im, x, 120 + (x % 16), 4, 3, [88, 56, 32]);
  for (const [x, y] of [
    [24, 88],
    [72, 72],
    [120, 88],
  ]) {
    rect(im, x, y, 32, 8, [188, 116, 56]);
    rect(im, x, y, 32, 2, [232, 172, 96]);
    rect(im, x, y + 6, 32, 2, [96, 56, 24]);
  }
  for (const [x, y] of [
    [38, 76],
    [86, 60],
    [134, 76],
  ]) {
    disc(im, x, y, 3, [252, 216, 56]);
    px(im, x - 1, y - 1, [255, 255, 200]);
  }
  const hx = 30;
  const hy = 96;
  rect(im, hx, hy, 10, 4, [216, 40, 32]);
  rect(im, hx + 1, hy + 4, 8, 5, [252, 200, 156]);
  rect(im, hx + 2, hy + 6, 2, 2, [24, 24, 24]);
  rect(im, hx, hy + 9, 10, 5, [216, 40, 32]);
  rect(im, hx + 1, hy + 12, 8, 4, [40, 64, 200]);
  rect(im, 100, 104, 12, 8, [140, 56, 160]);
  rect(im, 102, 106, 3, 3, [255, 255, 255]);
  rect(im, 107, 106, 3, 3, [255, 255, 255]);
  px(im, 103, 107, [0, 0, 0]);
  px(im, 108, 107, [0, 0, 0]);
  return im;
}

function paintedVista() {
  const im = img(640, 576);
  for (let y = 0; y < 576; y += 1) {
    const t = y / 576;
    for (let x = 0; x < 640; x += 1) {
      const s = 0.5 + 0.5 * Math.sin(x * 0.008);
      px(im, x, y, [
        Math.round(30 + 60 * t + 30 * s),
        Math.round(60 + 120 * t),
        Math.round(140 - 60 * t + 20 * s),
      ]);
    }
  }
  disc(im, 480, 140, 90, [229, 200, 130]);
  disc(im, 480, 140, 70, [255, 228, 140]);
  const layers = [
    [[70, 90, 130], 340, 0.01, 90],
    [[45, 65, 100], 420, 0.014, 120],
    [[25, 40, 70], 500, 0.02, 150],
  ];
  for (const [c, base, freq, amp] of layers)
    for (let x = 0; x < 640; x += 1) {
      const hgt = Math.round(amp * (0.6 + 0.4 * Math.sin(x * freq + base)));
      for (let y = base - hgt; y < 576; y += 1) px(im, x, y, c);
    }
  return im;
}

function photoish(rnd) {
  const im = img(320, 288);
  for (let y = 0; y < 288; y += 1)
    for (let x = 0; x < 320; x += 1) {
      const dx = (x - 160) / 160;
      const dy = (y - 144) / 144;
      const v = Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy));
      const n = (rnd() - 0.5) * 14;
      px(
        im,
        x,
        y,
        [
          Math.round(40 + 140 * v + 40 * dx + n),
          Math.round(50 + 120 * v + n),
          Math.round(70 + 100 * v - 30 * dx + n),
        ].map((c) => Math.max(0, Math.min(255, c))),
      );
    }
  for (let y = 54; y < 146; y += 1)
    for (let x = 64; x < 156; x += 1) {
      const d = Math.sqrt((x - 110) ** 2 + (y - 100) ** 2);
      if (d < 46) {
        const l = Math.max(0.3, 1 - d / 60);
        px(im, x, y, [Math.round(210 * l + 20), Math.round(160 * l + 10), Math.round(120 * l)]);
      }
    }
  return im;
}

function flatBadges() {
  const im = img(160, 144);
  const cols = [
    [16, 16, 24],
    [255, 255, 255],
    [224, 56, 72],
    [56, 120, 224],
    [255, 200, 48],
    [40, 168, 96],
    [160, 96, 200],
    [255, 144, 48],
    [120, 120, 128],
  ];
  rect(im, 0, 0, 160, 144, cols[0]);
  let i = 1;
  for (let gy = 0; gy < 3; gy += 1)
    for (let gx = 0; gx < 4; gx += 1) {
      const c = cols[(i++ % 8) + 1] ?? cols[1];
      rect(im, 8 + gx * 38, 10 + gy * 44, 32, 36, c);
      rect(im, 8 + gx * 38, 10 + gy * 44, 32, 3, cols[1]);
      disc(im, 24 + gx * 38, 28 + gy * 44, 6, cols[0]);
    }
  return im;
}

/** The full battery: name → encoded PNG bytes. */
export function generateBattery() {
  const rnd = makeRng(12345);
  const p = portrait();
  return new Map([
    ["portrait-clean", encode(p)],
    ["portrait-aa", encode(upscaleAA(p, 2))],
    ["title-screen", encode(titleScreen(rnd))],
    ["platformer", encode(platformer())],
    ["painted-vista", encode(paintedVista())],
    ["photoish", encode(photoish(rnd))],
    ["flat-badges", encode(flatBadges())],
  ]);
}
