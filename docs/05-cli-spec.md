# 05 — CLI Specification

`retroart` is designed to be a *model* UNIX citizen and the primary interface for
both humans and coding agents. The GUI and web app are skins over exactly this.

## Command shape

Subcommand style (git/ffmpeg convention), because prep and gen are genuinely
different operations with different flags — mirroring the two original tools:

```
retroart <command> [options] [input]

Commands:
  prep       Convert any image into a hardware-compliant image for a console
  gen        Convert an image (raw or prepped) into console data/code/ROM
  consoles   List supported consoles and their constraints
  inspect    Analyze an image: is it compliant? for which consoles? why not?
  completion Emit shell completion (bash/zsh/fish)
  help       Help for any command
```

`gen` on a *non-compliant* source runs the prep pipeline implicitly first (that is
the "source image straight into code" flag combination); `gen` on a compliant image
takes the exact lossless path, auto-detected exactly like `gen-portraits.py` does,
and `--strict` refuses non-compliant input instead of prepping.

### Examples (these go in the man page and README verbatim)

```sh
# Any image → compliant GBC image, auto-sized (keep dims, or largest aspect-fit)
retroart prep photo.jpg --console gbc -o portrait.png

# Explicit size, explicit technique choices
retroart prep art.png -c nes --size 128x128 --dither bayer4 --effort max -o out.png

# Straight from HD source to RGBDS assembly (implicit prep)
retroart gen photo.jpg -c gbc --format asm -o portrait.asm

# Prepped image → C arrays for SGDK; then → a bootable ROM
retroart gen out.png -c md --format c -o image.c
retroart gen out.png -c md --format rom -o show.bin

# UNIX composition: stdin/stdout streams, quiet by default
curl -s $URL | retroart prep - -c snes | retroart gen - -c snes --format asm > img.asm

# Agent introspection
retroart consoles --json
retroart inspect out.png --json
```

## UNIX compliance checklist (each item is a tested requirement)

- **POSIX/GNU conventions**: short `-c`/long `--console` flags, `--` end-of-options,
  bundled short flags, `=`-or-space option values. Flag parsing via a spec-driven
  parser (see §Single source of truth).
- **stdin/stdout**: `-` means stdin/stdout for image and code streams; binary-safe;
  output to a TTY without `-o` is refused for binary formats with a clear error.
- **Quiet by default, chatty on request**: nothing on stdout except the product;
  diagnostics to **stderr**; `-v/--verbose` (repeatable), `-q/--quiet` suppresses
  warnings. `--progress` only when stderr is a TTY, never in pipes.
- **Exit codes** (documented in the man page, stable, tested):
  `0` ok · `1` conversion failed · `2` usage error · `64–78` sysexits where they
  apply (`66` no input, `65` bad input data, `73` can't create output, `70` internal).
- **`--version`**: `retroart X.Y.Z` on stdout, exit 0. **`--help`** everywhere,
  exit 0, ≤ 100 cols, examples included.
- **Man pages**: `retroart(1)`, `retroart-prep(1)`, `retroart-gen(1)`,
  `retroart-consoles(1)`, `retroart-inspect(1)`, plus `retroart-formats(5)` for the
  manifest/JSON schemas. Generated (never hand-drifted) — §Single source of truth.
- **Environment**: honors `NO_COLOR`, `CLICOLOR_FORCE`, `TERM=dumb`; no config file
  in v1 (explicit flags only — better for reproducibility and agents; revisit with
  `RETROART_*` env prefix if ever needed).
- **Determinism & idempotence**: same inputs+options+version → identical bytes; no
  timestamps in outputs; `--seed` for the PRNG (default fixed).
- **Filesystem hygiene**: writes only what `-o` names (plus `--emit-manifest`);
  atomic write (temp + rename); never clobbers input; `--force` required to
  overwrite an existing output... exit `73` otherwise.
- **Signals**: SIGINT/SIGTERM → clean abort, partial outputs removed, exit 130/143.
- **Locale**: bytes-safe paths; messages in C/English; numbers machine-formatted.

## Agent-friendliness (first-class requirement, not a bolt-on)

- **`--json` on every command**: single JSON object on stdout (product goes to
  `-o` file in JSON mode), stable schema, versioned via `"schemaVersion"`. Includes
  everything an agent needs to decide next steps: chosen defaults (size, mode,
  dither), fit error metrics, tile merge counts, warnings, output paths.
- **Structured errors**: on failure with `--json`, stderr carries
  `{"error": {"code": "E_SIZE_TOO_LARGE", "message": ..., "hint": ..., "docs": ...}}`.
  Error codes are enumerated and stable; every error has a `hint` with the likely
  fix (e.g. `"maximum for nes is 256x240; pass --size 256x240 or omit --size"`).
- **Self-description**: `retroart consoles --json` dumps every ConsoleSpec
  (resolutions, palette shapes, formats, modes) — an agent can compute valid
  invocations without external docs. `retroart help --json` dumps the full command/
  flag schema (generated from the same spec as the parser).
- **`AGENTS.md`** at repo root: the tool contract in ~1 page (commands, JSON
  schemas, error codes, examples), plus the same content shipped via
  `retroart help --agents` so installed-tool discovery works offline.
- **No interactivity, ever**: no prompts, no pagers, no "are you sure". Anything
  destructive requires an explicit flag.
- **Predictable defaults, loudly reported**: every auto-decision (profile detected,
  size chosen, mode chosen) appears in `--json` output and `-v` logs, so agents can
  pin them explicitly on the next run.

## Key flags (shared across prep/gen where meaningful)

| Flag | Meaning |
|---|---|
| `-c, --console <id>` | Target console (id or alias; required) |
| `--size WxH` / `--fit contain\|cover\|stretch\|pad` | Target geometry (doc 04 §2); omit for auto behavior |
| `--mode <name>\|auto` | Video mode where applicable (snes: mode1/mode3/mode7…) |
| `--dither <alg>[:strength]` | none/bayer2/4/8/floyd-steinberg/atkinson/riemersma |
| `--scale <kernel>` | majority/lanczos3/mitchell/box/nearest (default auto) |
| `--profile art\|photo\|auto` | Force source-analysis profile |
| `--effort fast\|default\|max` | Optimizer budget (restarts/annealing) |
| `--palette-colors N`, `--palettes N` | Override spec-derived palette shape (clamped to hardware) |
| `--background <color>`, `--keep-transparency` | Alpha policy |
| `--metric oklab\|wrgb`, `--seed N`, `--par auto\|square` | Reproducibility & tuning |
| `--strict` | Fail rather than degrade (no tile merging, no implicit prep in gen) |
| `--emit-manifest [path]` | Sidecar JSON with palettes/assignments/provenance |
| gen: `--format bin\|asm\|c\|rom`, `--symbol <name>`, `--org/layout opts per family` | Doc 06 |

## Single source of truth for the interface

`packages/cli-spec` holds one typed definition of every command, flag, type, default,
error code, and example. From it we generate:

1. the runtime argument parser (no drift between docs and behavior),
2. `--help` text,
3. roff man pages (checked into `packages/cli/man/`, installed by npm/Homebrew/deb),
4. the docs-site CLI reference and `AGENTS.md` core table,
5. the `help --json` machine schema,
6. shell completions (bash/zsh/fish).

A CI check regenerates all six and fails on diff.

## Distribution

- npm: `retroart` package with `bin` entry → `npx retroart`, `npm i -g retroart`.
  Node ≥ 20 LTS.
- Standalone binaries (no Node required): Node SEA (or Bun compile if SEA tooling
  disappoints) for linux-x64/arm64, darwin-x64/arm64, win-x64 — attached to GitHub
  Releases with checksums + provenance (doc 11).
- Homebrew tap (`georgestephenson/tap/retroart`) and Scoop manifest post-1.0.
