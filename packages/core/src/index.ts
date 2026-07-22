/**
 * Public API of `@demake/core` (doc 09 §Public API surface).
 *
 * The engine: the conversion pipeline (`prep`), the compliance oracle and judge
 * (`inspect`, `judge`), console introspection (`consoles`, `getConsole`,
 * `strategies`), and the platform-pure image codecs (`decodeImage`,
 * `encodePng`). All I/O is `Uint8Array`; the library never touches fs or fetch.
 * The CLI, web, and desktop apps are all consumers of exactly this surface.
 */

// --- versioning --------------------------------------------------------------
export { CORE_VERSION } from "./version.js";

// --- errors ------------------------------------------------------------------
export { DemakeError, type DemakeErrorCode } from "./errors.js";

// --- data in/out -------------------------------------------------------------
export { decodeImage, detectFormat, type ImageFormat } from "./image/decode.js";
export { encodeIndexedPng, encodeRgbaPng, type IndexedImage } from "./image/png/encode.js";
export { decodePng, isPng, PngDecodeError } from "./image/png/decode.js";
export type { RgbaImage } from "./image/rgba.js";

// --- consoles ----------------------------------------------------------------
export { consoles, getConsole, findConsole } from "./consoles/registry.js";
export type {
  ConsoleSpec,
  ColorSpec,
  DisplaySpec,
  LayoutSpec,
  TileLayout,
  FramebufferLayout,
  ScanlineLayout,
  CodegenFormat,
  RGB8,
  Ratio,
} from "./consoles/types.js";
export type { DacModel } from "./image/dac.js";

// --- prep --------------------------------------------------------------------
export { prep } from "./pipeline/prep.js";
export { portfolioFor, buildPortfolio } from "./pipeline/portfolio.js";
export { renderCompliant, encodeCompliantPng } from "./pipeline/encode-image.js";
export type {
  PrepOptions,
  PrepResult,
  CompliantImage,
  Palette,
  PaletteColor,
  CandidateScore,
  AutoDecisions,
  FitStats,
  Warning,
  Profile,
  Effort,
  ScaleKernel,
  DitherAlg,
  Metric,
} from "./pipeline/types.js";

// --- introspection: inspect + judge ------------------------------------------
export { inspect, checkCompliantImage } from "./inspect/inspect.js";
export type { InspectResult, ConsoleCompliance, Violation } from "./inspect/inspect.js";
export { judge } from "./inspect/judge.js";
export type { JudgeResult, MetricId } from "./inspect/judge.js";

// --- strategies (candidate portfolio for a console) --------------------------
export { strategies, type StrategyInfo } from "./strategies.js";

// --- codegen (gen): image → console data / source ----------------------------
export { gen } from "./codegen/gen.js";
export type { GenOptions, GenResult, GenPath } from "./codegen/gen.js";
export type { GenArtifact, CodegenBackend, EmitOptions } from "./codegen/types.js";
export { detectCompliant } from "./codegen/detect.js";
export { backendFor, codegenFamilies } from "./codegen/registry.js";
export { parseManifest, applyManifest, type CodegenManifest } from "./codegen/manifest.js";
export { sourceHash } from "./codegen/provenance.js";
