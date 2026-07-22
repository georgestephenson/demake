# 03 — Console Matrix

Scope per the product definition: **every home console up to and including the
SNES / Mega Drive (fourth) generation, and every handheld up to and including the
Nintendo DS.**

Support is tiered by homebrew-toolchain and emulator-automation maturity — *not* by
how much we care. Every raster console in scope gets a `ConsoleSpec`; tiers govern
rollout order (doc 13) and which platforms gate CI.

- **Tier 1** — launch set. Mature toolchains + headless emulators. Full ROM
  screenshot tests gate every merge.
- **Tier 2** — full support, added after Tier 1 ships. Same test bar.
- **Tier 3** — long-tail/exotic. Prep support first (compliant PNG), codegen + ROM
  tests as each toolchain is validated.
- **Excluded** — non-raster or out-of-scope; documented reasons.

Numbers below are working values for planning. Phase 1 of the roadmap includes a
**hardware-spec verification task**: every `ConsoleSpec` file must cite primary
documentation (e.g. Pan Docs, nesdev wiki, SNESdev wiki, Sega retro docs,
GBATEK) and its values are locked in by emulator tests, not by this table.

## Tier 1 — launch set

| Console | Typical target res | Color model / master palette | Tile | Sub-palettes (BG) | Key quirks the fitter must handle |
|---|---|---|---|---|---|
| Game Boy (DMG) | 160×144 | 4 shades (2bpp), green LCD ramp | 8×8, 2bpp | 1 × 4 | Shade-only; luminance mapping is everything |
| Game Boy Color | 160×144 | RGB555 via CGB LCD curve | 8×8, 2bpp | 8 × 4 | Per-tile palette select; VRAM 2 banks (≈512 tiles); the predecessor baseline |
| NES | 256×240 (224 safe) | Fixed ~54-color master (NTSC DAC) | 8×8, 2bpp | 4 × (3+shared backdrop) | **Attribute granularity 16×16 px** (palette chosen per 2×2 tile block); 256-tile pattern table budget |
| SNES | 256×224 | RGB555 CGRAM | 8×8, 4bpp (mode 1) / 8bpp (mode 3) | 8 × 16 (mode 1) | Mode choice is an optimizer decision: mode 3 (256 colors, 1 palette) vs mode 1 (8×16 palettes, per-tile) |
| Mega Drive / Genesis | 320×224 (or 256×224) | RGB333 (512 colors) | 8×8, 4bpp | 4 × (15+transparent) | Only 61 usable colors on screen; strong per-tile palette pressure; VRAM ≈1250 free tiles at 320-wide full screen — unique-tile budget matters |
| Sega Master System | 256×192 | RGB222 (64 colors) | 8×8, 4bpp | 1 × 16 BG (+1 × 16 sprite, BG tiles may use either) | Tiny master palette dominates error |
| Game Boy Advance | 240×160 | RGB555 | tiled 4bpp/8bpp or bitmap | 16 × 16 (4bpp) / 1 × 256 (8bpp) / mode 3 direct 15-bit | Bitmap mode 3 makes "compliant" nearly unconstrained — spec still enforces res + RGB555 snap; mode 4 = 256-color palette |
| Nintendo DS | 256×192 (per screen) | RGB555(+) | tiled 4/8bpp, extended palettes, or 16-bit framebuffer | up to 16 × 16, ext. palettes 16 × 256 | Dual screen = optional 256×384 spanning mode; framebuffer mode like GBA mode 3 |

## Tier 2

| Console | Typical target res | Color model | Tile | Sub-palettes | Key quirks |
|---|---|---|---|---|---|
| PC Engine / TurboGrafx-16 | 256×224 (variable H) | RGB333 (512) | 8×8, 4bpp | 16 × 16 | Big palette count = easy fits; odd VRAM layout in codegen |
| Sega Game Gear | 160×144 | RGB444 (4096) | 8×8, 4bpp | 1 × 16 BG (+16 sprite) | SMS sibling; smaller viewport crop rules |
| SG-1000 / ColecoVision (TMS9918) | 256×192 | fixed 15-color TMS palette | Graphics II: per-8×1 row, 2 colors | — | The classic "2 colors per 8×1 strip" constraint — needs the row-pair fitter (doc 04 §Special cases) |
| Neo Geo (AES/MVS) | 320×224 | RGB666-ish (15-bit + dark bit) | sprite strips 16×N + 8×8 fix layer | 256 × 15 | Sprite-only hardware; "background" = tiled sprite strips; palette abundance makes fitting easy, codegen is the work |
| Atari 7800 | 160×192 (160A/B modes) | 256-color MARIA/TIA palette | variable-width sprites via display lists | 8 × 3 (+BG) | Display-list machine; holey DMA; per-zone palette scheduling |
| WonderSwan / Color | 224×144 | mono 8-shade / RGB444 | 8×8, 2bpp/4bpp | 16 × 4 / 16 × 16 | Portrait-vs-landscape orientation flag |
| Neo Geo Pocket Color | 160×152 | RGB444 | 8×8, 2bpp | 16 × 4 per plane | 2bpp with many small palettes — GBC-like fitter reuse |
| Atari Lynx | 160×102 | RGB444 | framebuffer 4bpp | 1 × 16 (per-frame; per-scanline reload possible) | Framebuffer console; optional per-scanline palette strategy for >16 colors |

## Tier 3 — long tail

| Console | Res | Colors | Notes |
|---|---|---|---|
| Atari 2600 | ~160×192 playfield | 128-color NTSC master | No framebuffer at all; image display = racing-the-beam kernels. We target *known display kernels* (40px playfield mode; 48px "6-digit" sprite kernel; interlaced color modes) — the spec models what a chosen kernel can show per scanline (doc 04 §Special cases) |
| Atari 5200 / 8-bit family | 160×192 (ANTIC E) etc. | 256-color GTIA master | Mode-select optimizer like SNES: ANTIC E (4 hues) vs GTIA 9/10/11 (16 lum / 9 color / 16 hue at 80px) |
| Intellivision | 159×96 background | 16 fixed colors | 8×8 cards, 2 colors/card from constrained sets; GRAM 64-card budget |
| Odyssey² | very coarse grid | 12 fixed colors | Char-grid hardware; best-effort mosaic mode |
| Fairchild Channel F | 102×58 effective | 8 colors, 4/line | Historical-completeness target |
| Virtual Boy | 384×224 | 4 red shades (2bpp) | DMG-like mono pipeline, red ramp |
| Pokémon Mini | 96×64 | 1bpp (+gray via flicker) | 1bpp threshold/dither pipeline |
| Watara Supervision | 160×160 | 4 shades | DMG-family reuse |
| Mega Duck / Cougar Boy | 160×144 | 4 shades | DMG variant, tweaked registers |
| Game.com | 200×160 | 4 shades | DMG-family reuse |
| Casio PV-1000, Epoch Cassette Vision, Arcadia 2001, Bally Astrocade, RCA Studio II, VC 4000, APF-MP1000 | various | various | Spec-only until a trustworthy toolchain+emulator pair is validated; prep (compliant PNG) ships before codegen |

## Excluded — with reasons

| Platform | Reason |
|---|---|
| Vectrex | Vector display; raster conversion is meaningless (a raster→vector plotter is a different product) |
| Home computers (C64, MSX, Amiga, ZX…) | Consoles-only per product definition. The TMS9918 and mono pipelines would make several trivial to add later; the spec schema deliberately doesn't preclude them |
| 32X / Sega CD / N64 / PS1 / Saturn / Jaguar / 3DO / CD-i | Past the generation cutoff (32X/Sega CD are MD add-ons past the constraint-interesting era; note as possible future "extended MD" specs). N64/PS1/Saturn reappear only in the exploratory 3D-asset demake direction (doc 13, Phase 7+) — a separate domain, not raster image conversion |
| PSP / post-DS handhelds | Past the handheld cutoff |

## The `ConsoleSpec` schema (what the table compiles into)

Each console is one declarative TypeScript object, `satisfies ConsoleSpec`:

```ts
interface ConsoleSpec {
  id: string;                    // "gbc", "nes", "md", ...
  name: string;                  // "Game Boy Color"
  aliases: string[];             // "cgb", "gameboy-color"; "genesis" for "md"
  tier: 1 | 2 | 3;
  display: {
    width: number; height: number;      // canonical full-screen target
    altModes?: DisplayMode[];           // 256-wide MD, 512-wide SNES, dual-screen DS…
    overscanSafe?: Rect;                // e.g. NES 8px top/bottom trim guidance
    pixelAspect: Ratio;                 // non-square PAR (e.g. MD 320: 32:35 NTSC) for correct preview + aspect-fit math
  };
  color: {
    model: "fixed-master" | "rgb";      // NES/TMS = fixed list; GBC/SNES/MD = RGB lattice
    masterPalette?: RGB8[];             // for fixed-master
    bitsPerChannel?: [r: number, g: number, b: number]; // 555, 333, 444, 222…
    dac: DacModel;                      // console→sRGB curve used for preview & emulator comparison (doc 10)
  };
  layout:                                // exactly one of:
    | { kind: "tiles"; tileW: 8; tileH: 8; bpp: 1|2|3|4|8;
        subPalettes: { count: number; size: number; sharedIndex0?: "backdrop"|"transparent" };
        attribute: { w: number; h: number };   // palette-choice granularity in px (NES: 16×16!)
        tileBudget?: number;                    // unique tiles that fit VRAM
      }
    | { kind: "framebuffer"; bpp: number; palette?: {...}; perScanlinePalette?: boolean }
    | { kind: "scanline"; strategy: "tms-rowpair" | "a2600-kernel" | "a7800-displaylist"; ... };
  modes?: ConsoleSpec["layout"][];       // selectable modes (SNES mode1/3/7, GBA 0/3/4, ANTIC/GTIA)
  codegen: { family: string; formats: ("bin"|"asm"|"c"|"rom")[] };
  docs: { sources: string[] };           // primary references the numbers came from
}
```

Design rules:

- **Sprites vs backgrounds:** v1 targets background/full-screen layouts (plus
  Neo Geo's sprite-composed "background"). The schema keeps a `spriteModes` slot
  reserved but unimplemented, so the animation/sprite future doesn't require a
  schema break.
- **Modes are optimizer inputs.** Where hardware offers several video modes, `prep`
  may be told one (`--mode mode3`) or may score candidates and pick the best fit
  (doc 04 §Mode selection).
- **Budgets are real constraints.** Tile-count budgets (NES 256, MD VRAM, GB 360
  visible cells needing ≤256 unique patterns per bank…) are enforced by the
  tile-dedup/merge stage, not documented-and-ignored.
