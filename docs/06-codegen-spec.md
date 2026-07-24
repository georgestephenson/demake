# 06 — Code Generation (`gen`)

`gen` turns a `CompliantImage` into artifacts a retro developer (or our own test
harness) can use directly. It generalizes `gen-portraits.py`, which emitted RGBDS
assembly containing 3 BGR555 palettes + a 49-byte tile→palette map + 784 bytes of
2bpp tile data, with an exact path for compliant inputs and a lossy fallback.

## Input paths

1. **Compliant image (exact path)** — detector verifies the pixels satisfy the
   console spec (≤K colors per cell, cells groupable into ≤P palettes, budgets met);
   conversion is then lossless. A manifest sidecar, if present and hash-matching,
   short-circuits detection and pins palette order.
2. **Arbitrary image (implicit prep)** — runs the full doc-04 pipeline first, then
   the exact path. `--strict` disables this.

## Output formats (`--format`)

### `bin` — raw data blobs
Native-endian, hardware-layout binary per asset (tiles, map, palettes), suitable for
`incbin`. One file per asset or a single packed file with a JSON index. This is the
substrate the other formats wrap.

### `asm` — assembler source
Idiomatic source for the console's canonical assembler, with labels, size constants,
and a generated header comment (tool version, source hash, options — no timestamps,
determinism rule). Data encoded as `db`/`dw`/`dc.b` lines or backtick-graphics where
the assembler supports it (RGBDS gets backtick 2bpp rows like `gen-portraits.py`).

### `c` — C arrays + header
`const` arrays with correct types/attributes for the console's C toolchain (GBDK,
SGDK, libgba/libnds, cc65, devkitSMS…), plus a `.h` with extents and palette counts.
`--symbol` sets the identifier prefix.

### `rom` — complete bootable ROM
Data + a minimal display program, assembled/compiled *by us* (see §ROM building).
The ROM boots, initializes video, uploads palettes/tiles/map (or framebuffer),
and displays the image forever. This is both a user feature ("see it on real
hardware / any emulator now") and the foundation of the entire test strategy
(doc 10).

## Per-family backends

Backends live in `core/src/codegen/<family>.ts`; consoles map onto shared families
where the data formats genuinely coincide.

| Family | Consoles | Data emitted | Display code / toolchain for `rom` |
|---|---|---|---|
| `gb` | DMG, GBC (Mega Duck via variant) | 2bpp planar tiles, BG map, BGP shades / BGR555 pals + attr map (bank1) | RGBDS (`rgbasm/rgblink/rgbfix`) |
| `nes` | NES | 2bpp planar CHR, nametable, attribute table, 4×4 palette bytes | ca65/ld65 (NROM harness) |
| `snes` | SNES | 4bpp SNES tiles (plane pairs 0/1 then 2/3), tilemap words, CGRAM BGR555 | WLA-DX (`wla-65816` + `wlalink`), LoROM harness |
| `md` | Mega Drive | 4bpp packed tiles, plane map words (pal/prio bits), CRAM BGR333 | vasm m68k (tiny bare-metal harness) or SGDK for the `c` format |
| `sms` | SMS, GG, SG-1000 mode targets | 4bpp planar tiles, name table, CRAM (RGB222/RGB444); TMS mode: pattern+color tables | WLA-DX or z88dk/devkitSMS |
| `tms` | SG-1000, ColecoVision | Graphics II pattern/color/name tables | z88dk harness per BIOS/boot quirks |
| `gba` | GBA | mode0 4bpp tiles (low-nibble-first) + screen entries + 16 BGR555 pals (mode3/4 bitmaps later) | GNU ARM binutils (`arm-none-eabi-as/ld/objcopy`); header in the harness |
| `nds` | NDS | engine-A text BG: the `gba` formats unchanged (ext. palettes / framebuffer later) | GNU ARM binutils; `.nds` cartridge packed by demake itself, no ndstool |
| `pce` | PC Engine | 4bpp planar-pair tiles, BAT entries, 9-bit palettes | PCEAS or HuC harness |
| `neogeo` | Neo Geo | fix-layer + sprite-strip C-ROM format, palette RAM | ngdevkit |
| `a26` | Atari 2600 | kernel-specific playfield/sprite tables **plus the kernel itself** (the display code *is* the format) | dasm |
| `a78` | Atari 7800 | display lists + graphics data + palette regs | dasm/cc7800 harness |
| `a8` | Atari 5200/8-bit | ANTIC display list + screen data + GTIA regs | MADS/cc65 |
| `lynx` | Lynx | 4bpp framebuffer + palette (+ optional per-line reload table) | cc65 lynx target |
| `ws` | WonderSwan/Color | 2/4bpp tiles, screen map, palettes | Wonderful toolchain |
| `ngpc` | NGP/NGPC | 2bpp tiles, scroll map, palettes | Wonderful toolchain / ngpc sdk |
| `intv` | Intellivision | GRAM cards + BACKTAB words | jzIntv as1600 |
| `mono-misc` | Virtual Boy, Pokémon Mini, Supervision, Game.com | per-platform tile/fb formats | per-platform assemblers, validated in Tier 3 rollout |

Backend contract (uniform, tested):

```ts
interface CodegenBackend {
  family: string;
  emitBin(img: CompliantImage): NamedBlob[];
  emitAsm(img: CompliantImage, opts): string;
  emitC(img: CompliantImage, opts): { c: string; h: string };
  romHarness: {                      // doc 10 uses this
    templateDir: string;             // rom-harness/<family>/
    toolchainImage: string;          // ghcr.io/<owner>/demake-tc-<family>:<tag>
    build(blobs: NamedBlob[]): RomBuildPlan;   // file placements + build cmd
  };
}
```

## ROM building — who runs the toolchain?

The CLI itself does **not** bundle assemblers. `--format rom` works in two ways:

1. **Local toolchain**: if the family's assembler is on `PATH` (detected, versions
   allow-listed), `gen` writes the harness project to a temp dir, builds, and emits
   the ROM. Errors clearly name the missing tool + install hint (`E_TOOLCHAIN_MISSING`).
2. **Docker fallback** (`--rom-builder docker`): uses our published
   `demake-tc-<family>` images — the exact ones CI uses — for a zero-setup,
   reproducible build. Recommended path; documented as the default suggestion.

The **web app** cannot run toolchains: it offers `bin`/`asm`/`c` downloads for all
consoles, plus true in-browser `rom` for families where assembly is simple enough to
implement in TS (GB family and NES NROM first — both are straightforward fixed-layout
links; stretch goal per family thereafter, tracked in the roadmap).

## Tile handling

- Deduplication (with H/V flip where hardware maps support it) is performed by
  `prep`'s budget stage; `gen` emits the deduped tileset + map faithfully.
  `gen-portraits.py` skipped dedup (49 unique tiles); we don't.
- Map origin/layout options per family: `--map-base`, `--tile-base`, padding to
  power-of-two rows, and SGDK/GBDK-compatible layouts so output drops into existing
  projects without munging.

## Output hygiene

- All generated source carries: tool name+version, source file hash, full option
  string, and a "regenerate with:" command line — and **no timestamps** (byte-
  determinism). Headers use each language family's comment syntax.
- `--json` mode reports every artifact written with byte sizes and hashes.
