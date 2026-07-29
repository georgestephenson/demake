# 15 — The Demakefile

A **Demakefile** says how a Demotic game reaches real hardware: which consoles to
build for, how each piece of art is converted, and which artifacts land where.

It is the counterpart to [doc 14](14-demotic.md). The `.dmt` file describes the
game and knows nothing about hardware; the Demakefile describes the build and
knows nothing about gameplay. Neither can do the other's job, and that separation
is enforced, not merely encouraged:

**Where it sits is [doc 19](19-projects.md)**: at the root of a project folder,
beside `src/`, `art/`, `music/`, `sound/` and `levels/`. That folder supplies
three of this document's defaults on its own — `source` is the single `.dmt` in
`src/`, `assets` is the four resource directories, `out` is `build/` — and it is
where the `targets` shorthand and the `music`/`sound` blocks below come from.

> **Delete the Demakefile and the game still plays identically.** Only the
> artifacts change.

## You do not need one

The Demakefile is an *escape from the defaults*, not a prerequisite. With no file
present, `demake build` targets every console that has a runtime, with default
conversion settings, writing `build/<console>/<name>.<ext>`. The web preview
(doc 07) needs no Demakefile at all for the same reason.

**Status.** The zero-config path is what exists today: `demake build game.dmt -o
game.gb` builds for the one console that has a runtime, with `--console`,
`--title` and `--format` standing in for the manifest's fields. The file itself,
its resolver, art binding through `prep`, and `check`/`init`/`fmt` are still to
come (doc 13 §D2). Everything below is the design they will implement, and the
flags that exist now are deliberately named after the directives they anticipate.

`demake init` writes the Demakefile that reproduces exactly what the defaults
already do — so the zero-config path and the file are the same object, one of them
just implicit. Editing a setting in the web preview is editing that file; see
§The equivalence contract.

## Format

Indentation-significant, block-structured, minimal punctuation.

- **Indentation** sets structure. Tabs are accepted; **spaces are canonical** and
  `demake fmt` always writes two spaces per level. One tab is one level; with
  spaces, the file's unit is set by its first indented line and must stay
  consistent. Mixing tabs and spaces *within one file* is an error naming both
  offending lines — the Make footgun, disarmed.
- **Comments** start at `#`, either at line start or preceded by whitespace, so
  `serial GM-00000000#2` keeps its hash.
- **A line is `key value…`**. The first word is the directive. Each directive has
  a fixed arity, and the final field absorbs the rest of the line — so
  `title  Pong Deluxe` needs no quotes, and neither does a path with spaces in it
  when it is the last field.
- **Quotes are optional** and only needed for a value with leading or trailing
  whitespace, or one containing ` # `. Double quotes only.
- **Directive names are case-insensitive; values are literal.** Paths and titles
  keep their case. (This differs from Demotic, which is case-insensitive
  throughout, because a Demakefile carries filenames and ROM header text where
  case matters.)
- Blank lines are ignored anywhere.

A complete example:

```
# Demakefile — how Pong reaches real hardware.
# The game itself is in pong.dmt and knows none of this.

project pong
  title    Pong
  author   George Stephenson
  version  1.0.0

source  pong.dmt
assets  art/
out     build/

defaults
  strategy  auto
  dither    none
  effort    default

target gb
  output  rom  pong.gb
  header
    title  PONG

target gbc
  console  gbc
  output   rom  pong.gbc
  output   png  pong-sheet.png

target nes
  output  rom  pong.nes
  header
    mapper     nrom
    mirroring  vertical

target md
  region  ntsc
  output  rom  pong.bin
  output  asm  pong.s
  header
    title   PONG
    serial  GM 00000000-00
    region  jue

target md-pal
  console  md
  region   pal
  output   rom  pong-pal.bin

art ball.svg
  transparent  magenta
  for gb
    use  ball-mono.png
  for md
    use  ball-hd.svg

art paddle.svg
  dither  none
```

## Directives

### Top level

| Directive | Arity | Meaning | Default |
|---|---|---|---|
| `project <name>` | block | Metadata block | the source file's basename |
| `source <path>` | 1 | The `.dmt` entry point | the single `.dmt` in `src/`, then the one beside the Demakefile |
| `assets <dir>` | 1 | Extra root for asset lookup (repeatable — searched in order, *ahead* of the standard four) | `art/`, `music/`, `sound/`, `levels/`, then the project root (doc 19) |
| `out <dir>` | 1 | Root for every output path | `build/` |
| `defaults` | block | Conversion options, per domain | — |
| `targets <id>…` | n | Shorthand: one default target per console named | every console with a runtime |
| `target <name>` | block | One build | see below |
| `art <name>` | block | How one image asset is converted | — |
| `music <name>` | block | How one track is demade (doc 19) | — |
| `sound <name>` | block | How one effect is demade (doc 19) | — |

`project` fields: `title`, `author`, `version`, `license`. They feed ROM headers
and generated source provenance; none affect gameplay.

### `target <name>`

| Directive | Arity | Meaning | Default |
|---|---|---|---|
| `console <id>` | 1 | Which console | **the target's own name** |
| `region ntsc\|pal` | 1 | Selects the profile variant, hence the tick rate | `ntsc` |
| `output <format> <path>` | 2 | Artifact to emit; repeatable | `rom` where the family has one |
| `header` | block | ROM header fields (see below) | derived from `project` |
| conversion options | 1 | Any `defaults` option, scoped to this target | inherited |

Because `console` defaults to the target name, `target gb` on its own is a
complete, valid target. Name a target something else — `md-pal`, `gb-jp` — and
`console` becomes required.

Output formats are `rom`, `asm`, `c`, `bin`, `png` (the prepped art sheet, for
eyeballing the demade art) and `manifest` (the doc-06 sidecar JSON). Paths are
relative to `out`; a path starting with `/` or `./` escapes it. Paths may contain
`{project}`, `{target}`, `{console}`, `{region}` and `{ext}`, which is how the
zero-config default expresses itself as `{out}/{console}/{project}.{ext}`.

`region pal` on a console that never shipped in PAL is an error, not a silent
no-op. Because region changes the tick rate it changes traces, so each
(console, region) pair is a distinct profile with its own golden trace — the
Demakefile selects a profile, it never edits one (doc 14 §The central split).

### `art <name>`

`<name>` is the asset exactly as the `.dmt` names it in a `sprite` property.

| Directive | Arity | Meaning |
|---|---|---|
| `use <file>` | 1 | Substitute a different source file |
| `transparent <color>` | 1 | Colour key for sprite transparency (default: the alpha channel) |
| `dither`, `strategy`, `effort`, `scale`, `palette`, `protect`, `metric` | 1 | Passed to `prep`; identical names and values to the doc-05 flags |
| `for <target>` | block | Any of the above, for one target only |

**There is no `size` here, deliberately.** A sprite's pixel dimensions are
`width × 8` by `height × 8` from the `.dmt`'s collision box, on every console. If
a 1-cell ball feels small on a Mega Drive, that is the documented consequence of
authoring in cells (doc 14 §3) — the court is bigger and the ball is the same
absolute size, which is what a real Pong does. Letting the Demakefile resize
sprites independently would put the drawn object out of step with the object that
collides, and would need an anchoring rule to disambiguate. Art that deliberately
overhangs its collision box is a real thing and a later feature; it is not this
one.

What per-target art overrides *are* for is richer source art on richer hardware
(`use ball-hd.svg` on Mega Drive, `use ball-mono.png` on Game Boy) and per-console
conversion tuning. Both are realization, not gameplay.

### `header`

ROM header fields, validated against each family's real rules, with actionable
errors — "Game Boy titles are at most 11 characters of uppercase ASCII; 'Pong
Deluxe!' is 12" beats a corrupt cartridge header.

| Family | Fields | Notable rules |
|---|---|---|
| `gb` | `title`, `licensee`, `cgb`, `sgb`, `cartridge`, `version` | title ≤ 11 uppercase ASCII with `cgb`, ≤ 15 without |
| `nes` | `mapper`, `mirroring`, `prg`, `chr`, `battery` | mapper from an allow-list; `nrom` first |
| `sms`, `gg` | `product`, `version`, `region` | header checksum computed, not authored |
| `md` | `title`, `serial`, `region`, `copyright` | domestic and overseas titles padded to 48 |
| `snes` | `title`, `map`, `rom-speed`, `region` | title ≤ 21 ASCII |

Unset fields derive from `project`. Checksums, sizes, and logo data are always
computed — they are never authored, and a Demakefile cannot make an invalid ROM
header by omission.

## Resolution

Conversion options cascade, most specific winning, per domain:

```
defaults/<domain>  <  target  <  <domain> <name>  <  <domain> <name>/for <target>
```

where `<domain>` is `art`, `music` or `sound`. Options written directly under
`defaults` are art's, because art was the only domain when this file was written;
`demake fmt` writes the nested form (doc 19 §The Demakefile, still optional).

Everything resolved is reported by `demake build --dry-run --json`: the source,
every target, every asset with its final option set, and every path that will be
written. Nothing about a build should require reading the resolver to predict.

Asset lookup walks each `assets` root in order. A miss is an error listing every
path searched.

### The conversion path

Each sprite goes through the existing image pipeline — no second implementation:

1. Resolve the asset (per target, honouring `use`).
2. Rasterise, if the source is vector. **This exists**, in
   `packages/core/src/image/svg/`, and `decodeImage` sniffs SVG like any other
   format. It is ours rather than the host's for the reason this step was
   deferred over: a canvas antialiases how it likes, so two engines disagree in
   the low bits of every edge pixel and the browser stops producing the CLI's
   bytes. The subset is what vector art is actually drawn in — shapes, paths,
   gradients, strokes, groups, transforms — and anything outside it fails by
   name rather than rendering as nothing.
3. Fit it at `width × 8` by `height × 8` px for the target console — but against
   the console's **sprite** palette shape rather than its background one, where
   the two differ. Sprite index 0 is transparency, not a colour, so a Game Boy
   object gets three shades where a tile gets four, and the NES reserves the
   second set of four.

   Which three is decided by what an object is drawn *over*, not by what the
   source looks like: colour 0 shows the background through, so an object painted
   in the backdrop's shade is invisible. The three darkest shades are the object
   palette, and the art is stretched across them by auto-contrast over every
   asset at once — doc 04 §The objective at eight pixels across, where
   legibility beats error. Downscaling averages premultiplied, or a shape grows
   a halo out of the transparency around it.

   On a **colour** console the same step answers a different question. The
   hardware has several small sub-palettes and an object names one of them, so
   the choice is not which shades but *which assets share a palette* — the
   constrained assignment stage 4 already solves for an image's attribute cells,
   with an asset in place of a cell. An asset is indivisible there because the
   attribute is per object, not per pixel; a build reserves one sub-palette for
   the font and gives the fit the rest.
4. Deduplicate tiles across every asset in the build and pack them into the
   family's tile bank.
5. Emit alongside the compiled game (doc 14 §Runtime model).

**A backdrop is the same picture `demake prep` makes, at the budget the cartridge
can give it.** The build's only input to the conversion is that budget, and it is
the console's own arithmetic: what a pattern table holds, minus the built-in
bank, minus the art already in that table. Nothing about the fit is decided
twice — `packages/demotic/test/nes-rom.test.ts` runs each picture through
`prepSync` and the image backend again at the reported budget and compares the
pattern behind all 960 cells, so "no second art converter" is checked rather than
asserted from the call graph.

Which makes the budget the whole of the quality, and it is worth spending the
hardware on. Three things came out of doing that on the NES, and the first two are
the console's own facilities rather than cleverness:

- **Two pattern tables.** `PPUCTRL` bit 4 chooses which one the background layer
  reads, so a game's pictures are given one each rather than halving a single
  table between them.
- **A pulled built-in bank.** The font, the level patterns and the placeholder
  block are 64 patterns and a game draws about 25 of them — nobody's score needs
  a `?`. On a Game Boy that costs nothing; here it comes out of the same 256 a
  picture is fitted into, so only what a program actually writes is emitted. The
  blank stays at index zero, because that is what an empty cell draws.
- **No reserved palette.** A caption's cells are *replaced* by glyph tiles, so
  only two colours matter there: the universal backdrop every palette shares, and
  whatever sits at the ink's index. The fitter rarely fills all sixteen slots, so
  the font takes one the picture left empty and the picture keeps all four
  sub-palettes. Where the fit really did use every slot, the caption goes in the
  palette with the most contrast at that index — a worse caption and a whole
  picture, rather than the reverse.

Together those took a title screen from **96 patterns to 201–231** and from three
sub-palettes to four; the shooter's merged 216 of its 960 cells and now merges
none. A console with one table shares it, and the reported budget says so.

**And the nametable is packed, because a picture costs program space too.** A
screenful is 960 cells and an NROM cartridge is 32 KiB, so two pictures stored raw
were six per cent of the whole program — which is what put the shooter, whose nine
aliens generate a lot of collision code, within a few hundred bytes of not
fitting. A demade screen is mostly runs, so the cells and the attribute table go
in as literals and runs and come out through one walk: 960 bytes becomes 279–682,
and a fixture gains 280–560 per picture. What is guaranteed is the bytes that
reach the PPU, never the encoding — the same rule the audio driver's packing runs
under (doc 16 §The driver format is not part of the contract) — and the test boots
the cartridge and reads the PPU's own memory rather than checking the format.

Steps 3–4 live in `packages/core/src/pipeline/sprite.ts`, beside the rest of the
pipeline. The Demakefile only decides what is fed in and with which options; with
no Demakefile, `demake build` loads the art next to the source and converts it
with the defaults.

## The equivalence contract

The web preview's settings are a *view of a Demakefile*, not a parallel
configuration system. Three properties, all CI-checkable, make that true rather
than aspirational:

1. `fmt(fmt(x)) == fmt(x)` — formatting is idempotent.
2. `emit(parse(x)) == fmt(x)` — the model round-trips through text losslessly.
3. `emit(settings(parse(x))) == fmt(x)` — loading a Demakefile into the preview's
   settings and writing it back reproduces it byte for byte.

Plus the gameplay invariant, which is what the whole split exists to protect:

4. `trace(dmt, console, region)` is byte-identical with and without any
   Demakefile.

The preview therefore shows the **equivalent Demakefile** for its current
settings, the way the image app shows the equivalent CLI command (doc 07). A game
build writes many artifacts, so a file is the honest representation; a single
command line is not.

**And in a project workspace it stops being a display and becomes the storage**
([doc 19](19-projects.md) §Options edit the Demakefile): changing a demaker's
option writes the block for the file you have open, setting one back to its
inherited value deletes the line again, and a project with no Demakefile gets the
one `demake init` would have written. Property 3 above is what makes that safe,
and it is why an option that changes nothing must never leave a directive behind.

## Diagnostics

Same shape as Demotic and the CLI (doc 05 §Agent-friendliness): a stable code, a
line number, a message, and a `hint` with the likely fix. One pass reports every
problem — a bad directive does not hide the six after it — and `--json` emits them
as structured data.

| Code | Meaning |
|---|---|
| `E_MIXED_INDENT` | tabs and spaces in one file; names both lines |
| `E_BAD_INDENT` | indentation is not a multiple of the file's unit |
| `E_UNKNOWN_DIRECTIVE` | with the valid set for that block |
| `E_DUPLICATE_DIRECTIVE` | non-repeatable directive set twice; names both lines |
| `E_ARITY` | wrong field count, with the directive's shape |
| `E_UNKNOWN_CONSOLE` | with the supported list |
| `E_UNKNOWN_TARGET` | a `for` naming no declared target |
| `E_REGION_UNSUPPORTED` | e.g. `region pal` on a Game Boy |
| `E_NO_SOURCE` | no `.dmt` found, or several with no `source` |
| `E_ASSET_MISSING` | with every path searched |
| `E_HEADER_INVALID` | with the family's rule for that field |

## Not in v1

Named so the shape stays honest, and roughly in the order they would arrive.

- **Per-console input remapping.** The portable button set is small enough that
  the runtime's fixed mapping is right for now; a Mega Drive's C button has
  nothing to bind to.
- **Bank layout and memory control.** Needed once a game exceeds one bank; until
  a real game does, any design would be speculative.
- **Art that overhangs its collision box**, with the anchoring rules that implies.
- **Multiple `.dmt` sources**, and `include` in Demotic itself. Doc 19 §Splitting
  a game states the two shapes it could take and the evidence that it is not yet
  urgent; it is a language change, so it is the maintainer's call rather than a
  planning decision.
- **Audio settings** — *designed in [doc 19](19-projects.md), not yet built.*
  The Demotic side is built: a `.dmt` names its music and its effects, and
  `demake build` demakes both into the cartridge (doc 14 §Sound). What has no
  build-file surface yet is the *how*, and doc 19 gives it the shape this
  document already uses for art — `music <name>` and `sound <name>` blocks
  carrying the doc-05 audio flags, and a `defaults` block with a section per
  domain. Never which notes, exactly as an `art` block never says which pixels.
  Today those are the demakers' defaults, chosen by the game's console rather than
  by anything a build file said, which keeps the operational rule intact (a
  Demakefile may not change how a game plays) with no work at all.
- **Custom target inheritance** (`target md-pal extends md`). Two nearly-identical
  targets is not yet enough duplication to justify the concept.
