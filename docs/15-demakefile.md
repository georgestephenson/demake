# 15 — The Demakefile

A **Demakefile** says how a Demotic game reaches real hardware: which consoles to
build for, how each piece of art is converted, and which artifacts land where.

It is the counterpart to [doc 14](14-demotic.md). The `.dmt` file describes the
game and knows nothing about hardware; the Demakefile describes the build and
knows nothing about gameplay. Neither can do the other's job, and that separation
is enforced, not merely encouraged:

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
| `source <path>` | 1 | The `.dmt` entry point | the single `.dmt` beside the Demakefile |
| `assets <dir>` | 1 | Root for art lookup (repeatable — searched in order) | `art/`, then the project root |
| `out <dir>` | 1 | Root for every output path | `build/` |
| `defaults` | block | Conversion options applied to all art | — |
| `target <name>` | block | One build | see below |
| `art <name>` | block | How one asset is converted | — |

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

Conversion options cascade, most specific winning:

```
defaults  <  target  <  art  <  art/for <target>
```

Everything resolved is reported by `demake build --dry-run --json`: the source,
every target, every asset with its final option set, and every path that will be
written. Nothing about a build should require reading the resolver to predict.

Asset lookup walks each `assets` root in order. A miss is an error listing every
path searched.

### The conversion path

Each sprite goes through the existing image pipeline — no second implementation:

1. Resolve the asset (per target, honouring `use`).
2. Rasterise, if the source is vector. **This step does not exist yet**;
   deterministic SVG rasterisation across Node and browsers fights the
   byte-determinism rule (doc 14 §Known gaps). Until it does, ROM builds require a
   raster source and SVG is a preview convenience.
3. `prep` it at `width × 8` by `height × 8` px for the target console, using the
   resolved options — but against the console's **sprite** palette shape rather
   than its background one, where the two differ. A Game Boy has two sprite
   palettes of three colours plus transparent; the NES reserves the second set of
   four. Sprite index 0 is transparency, not a colour.
4. Deduplicate tiles across every asset in the build and pack them into the
   family's tile bank.
5. Emit alongside the program tables and the runtime (doc 14 §Runtime model).

Steps 3–4 are `prep` and the doc-06 tile budget stage exactly as they already
exist. The Demakefile only decides what is fed in and with which options.

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
- **Multiple `.dmt` sources**, and `include` in Demotic itself.
- **Audio**, which arrives with the doc-13 audio demake domain.
- **Custom target inheritance** (`target md-pal extends md`). Two nearly-identical
  targets is not yet enough duplication to justify the concept.
