# 09 — Library API (`@retroart/core` on npm)

The engine is a normal npm package usable from Node ≥ 20, Bun, Deno, and bundlers
targeting evergreen browsers. The CLI, web app, and desktop app are all consumers of
this exact API — nothing they can do is unavailable to library users.

## Packages

| Package | Contents |
|---|---|
| `@retroart/core` | The engine: pipeline, console specs, codegen. Zero platform deps; ESM; ships types. |
| `retroart` | The CLI (`bin`). Depends on core. Also re-exports core so `npm i retroart` alone suffices for scripting. |

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
} from "@retroart/core";

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
  `RetroartError` (with `code` matching CLI error codes); quality degradations
  (tile merges, palette compromise) are `warnings` + stats, or errors under
  `strict` — same semantics as the CLI because it *is* the CLI's semantics.

## Stability & determinism guarantees (documented, tested)

- **API stability**: semver on the TS surface; deprecations live one major.
- **Output stability**: byte-identical output is guaranteed for the same
  (input, options, library **minor** version). Algorithm improvements that change
  bytes bump the minor and are release-noted; golden fixtures re-baselined in the
  same PR (doc 10 §Goldens). Patch releases never change output bytes.
- **Cross-platform determinism**: same bytes on Node/browser/all OSes — enforced in
  CI. This is why the core forbids platform codecs and `Math.random` (lint rules).

## Docs

Typedoc API reference generated into the docs site; every public symbol has TSDoc
with an example. README quick-starts for: Node script, Vite browser usage, and a
build-pipeline recipe (a Vite/webpack loader example that turns `art/*.png` into
generated `.c` at build time — the predecessor workflow, packaged).
