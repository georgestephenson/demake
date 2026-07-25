# 09 — Library API (`@demake/core` on npm)

The engine is a normal npm package usable from Node ≥ 20, Bun, Deno, and bundlers
targeting evergreen browsers. The CLI, web app, and desktop app are all consumers of
this exact API — nothing they can do is unavailable to library users.

## Packages

| Package | Contents |
|---|---|
| `@demake/core` | The engine: pipeline, console specs, codegen. Zero platform deps; ESM; ships types. |
| `@demake/demotic` | The game language (doc 14) and the Demakefile (doc 15): compiler, reference interpreter, `.test.dmt` runner, trace oracle, and the console backend — an SM83 assembler and the `gb` code generator. Depends on `core`; zero platform deps. |
| `@demake/dmg` | A Game Boy core: the Demotic conformance harness (doc 10) and the web app's in-page player (doc 07). Depends on nothing; zero platform deps. |
| `demake` | The CLI (`bin`). Depends on all three. Also re-exports them so `npm i demake` alone suffices for scripting. |

`@demake/demotic` is separate from `core` for three reasons: image-only consumers
should not pay for a game language; the two domains' output-stability clocks are
independent (a trace change and a pixel change are different releases); and `core`
must stay standalone, since the dependency runs one way only (doc 02).

Publishing: both from the monorepo on each release tag, with npm provenance
(`--provenance`), `sideEffects: false`, exports map with proper `types` conditions.
Semver applies to the **public API + output stability** (see §Stability).

## Public API surface (v1)

```ts
// --- data in/out -------------------------------------------------------------
// All I/O is Uint8Array; the library never touches fs or fetch.
import {
  prep, gen, inspect,
  consoles, getConsole,
  decodeImage, encodePng,
  type PrepOptions, type GenOptions, type PrepResult, type GenResult,
  type ConsoleSpec, type CompliantImage, type Manifest,
} from "@demake/core";

// --- prep --------------------------------------------------------------------
const res: PrepResult = await prep(inputBytes, {
  console: "gbc",                    // id or alias
  strategy?: "auto" | string,        // "auto" (default) = tournament; name = single candidate
  size?: { w: 128, h: 112 },         // omit → auto (keep dims or largest aspect-fit)
  fit?: "contain" | "cover" | "stretch" | "pad",
  mode?: string | "auto",
  profile?: "art" | "photo" | "auto",
  scale?: "majority" | "lanczos3" | "mitchell" | "box" | "nearest" | "auto",
  dither?: { alg: "none"|"bayer2"|"bayer4"|"bayer8"|"floyd-steinberg"|"atkinson"|"riemersma"|"ramp"; strength?: number },
  protect?: string[] | false,        // pinned colors; false disables auto highlight/outline protection
  palette?: string[],                // palette lock: quantize only to these colors (lattice-snapped)
  focus?: { x: number; y: number } | "auto",  // cover-crop focal point / saliency anchor
  effort?: "fast" | "default" | "max",
  metric?: "oklab" | "wrgb",
  seed?: number,
  background?: string, keepTransparency?: boolean,
  strict?: boolean,
  onProgress?: (stage: string, fraction: number) => void,
  signal?: AbortSignal,
});
// res: { png: Uint8Array; image: CompliantImage; manifest: Manifest;
//        decisions: AutoDecisions; stats: FitStats; warnings: Warning[];
//        tournament: { winner: string; candidates: CandidateScore[] } }
//   CandidateScore = { strategy: string; aggregate: number;
//                      metrics: Record<MetricId, number>;
//                      disqualified?: { reason: string } }

// --- gen ---------------------------------------------------------------------
const out: GenResult = await gen(inputBytesOrCompliantImage, {
  console: "gbc",
  format: "bin" | "asm" | "c" | "rom-plan",
  symbol?: string,
  prep?: PrepOptions,        // used when input isn't compliant (implicit prep)
  strict?: boolean,
});
// out: { artifacts: { name: string; bytes: Uint8Array; kind: "asm"|"c"|"h"|"bin"|"rom" }[];
//        manifest: Manifest; exactPath: boolean }
// Note: format "rom-plan" returns the harness file layout + build commands
// (RomBuildPlan); actually *running* assemblers is the CLI's job (doc 06) —
// the core stays platform-pure. Families with in-TS assembly return kind "rom".

// --- introspection -----------------------------------------------------------
consoles(): ConsoleSpec[];                          // all specs, data-only
strategies(consoleId): StrategyInfo[];              // candidate portfolio for a console
inspect(bytes, { console? }): InspectResult;        // compliant? for which consoles? violations list
judge(sourceBytes, resultBytes, { console, profile? }): JudgeResult;
  // the tournament's own scorer, public: validity gates + fidelity metrics +
  // aggregate (doc 04 §The judge) — what prep used to pick the winner
```

Design rules:

- **Everything serializable**: options and results are plain JSON-able data (plus
  `Uint8Array`s), so they cross workers/processes untouched — that's what keeps the
  CLI `--json`, the web worker RPC, and this API literally the same shapes.
- **Async by default** with `AbortSignal` + progress callbacks (long `effort: max`
  runs must be cancelable in UIs).
- **No throw for quality issues**: hardware-impossible requests throw typed
  `DemakeError` (with `code` matching CLI error codes); quality degradations
  (tile merges, palette compromise) are `warnings` + stats, or errors under
  `strict` — same semantics as the CLI because it *is* the CLI's semantics.

## `@demake/demotic` surface (v1)

```ts
import {
  compile, check, Sim, trace, tape,          // language
  parseTests, runTests, formatResults,        // .test.dmt
  parseDemakefile, resolveBuild,              // build manifest (doc 15)
  emitTables, buildGbRom, unsupportedFeatures, // the console hand-off (doc 14)
  romTraceLine, RAM,                          // reading a trace out of a running ROM
  profiles, getProfile,
  type Program, type ConsoleProfile, type Diagnostic, type RunResult,
} from "@demake/demotic";

const program = compile(source, { profile: getProfile("gb") });
const { program: maybe, diagnostics } = check(source, { profile });  // never throws

const sim = new Sim(program);
sim.step({ left: true });     // one logical tick, 16.16 fixed point
sim.entities();               // live state
sim.runtimeBudget;            // worst sprites-per-scanline seen

trace(sim, tape("1:a,90:,90:left"));            // the conformance oracle, as text
runTests(parseTests(suite), program);           // assertions, per console

const assets = new Map([["ball.svg", svgBytes]]);                 // the art it names
const { bytes, stats } = buildGbRom(program, { title: "PONG", assets });
unsupportedFeatures(program);                   // [] when the backend can build it
```

`buildGbRom` *compiles* — it generates SM83 machine code for this game, with only
the helper routines something in it reached, and demakes the art it was given
through `@demake/core` on the way. The assembler is TypeScript, so it needs no
toolchain and runs in a browser, and passing the same assets gives the same
bytes on both. It throws rather than emit a cartridge that would play
differently from `Sim`, which is what `unsupportedFeatures` lets a caller ask
about first. `stats` reports the code size, the work RAM used, the helpers that
survived, and any art the program named but was not given.

`resolveBuild` returns a plan and does not execute it: resolving assets and
writing files are the CLI's job, exactly as `gen`'s `rom-plan` already works. The package stays platform-pure, so the same calls back the web
app's Demotic section.

## Stability & determinism guarantees (documented, tested)

- **API stability**: semver on the TS surface; deprecations live one major.
- **Output stability**: byte-identical output is guaranteed for the same
  (input, options, library **minor** version). Algorithm improvements that change
  bytes bump the minor and are release-noted; golden fixtures re-baselined in the
  same PR (doc 10 §Goldens). Patch releases never change output bytes.
- **Cross-platform determinism**: same bytes on Node/browser/all OSes — enforced in
  CI. This is why the core forbids platform codecs and `Math.random` (lint rules).
- **Demotic semantics are output bytes too**: a change that alters any golden
  trace is a minor bump on `@demake/demotic`, with traces re-baselined, a
  changeset and a release-note line, in the same PR. Patch releases never change
  a trace. The two packages version independently (doc 14 §Stability).

## Docs

Typedoc API reference generated into the docs site; every public symbol has TSDoc
with an example. README quick-starts for: Node script, Vite browser usage, and a
build-pipeline recipe (a Vite/webpack loader example that turns `art/*.png` into
generated `.c` at build time — the predecessor workflow, packaged).
