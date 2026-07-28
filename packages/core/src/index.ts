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
export { rasterizeSvg, isSvg, type RasterizeOptions } from "./image/svg/index.js";
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
export { latticeMaxHz, latticeMinHz } from "./consoles/audio.js";
export type {
  AudioSpec,
  AudioChannelSpec,
  ChannelKind,
  DriverClock,
  HardwareEnvelope,
  PitchLattice,
  RateSpec,
  VolumeLattice,
} from "./consoles/audio.js";
export type { DacModel } from "./image/dac.js";

// --- deterministic math ------------------------------------------------------
// The engine's own transcendentals and PRNG, public because every package under
// the determinism rule needs them and a second implementation would defeat the
// point (doc 02 §Floating-point discipline, doc 16 §Determinism engineering).
export * as math from "./math/kernels.js";
export { makePrng, type Prng } from "./math/prng.js";

// --- parallelism -------------------------------------------------------------
// The executor seam (doc 04 §Running the tournament). Core describes independent
// work as jobs and never runs it anywhere but here unless an edge hands it
// somewhere else to run; these are what an edge needs to build that somewhere.
export {
  defineJob,
  describeFailure,
  inlineExecutor,
  jobHandlers,
  runJob,
  throwFailure,
  unwrap,
  type AnyJobKind,
  type Executor,
  type Job,
  type JobFailure,
  type JobHandlers,
  type JobKind,
  type JobOutcome,
} from "./parallel/jobs.js";
export { poolExecutor, type Lane } from "./parallel/pool.js";

// --- prep --------------------------------------------------------------------
export { prep, coreJobKinds } from "./pipeline/prep.js";
export {
  buildSpriteBank,
  paletteRegister,
  type SpriteBank,
  type SpriteSource,
  type SpriteOptions,
  type SpriteArt,
} from "./pipeline/sprite.js";
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
export {
  parseManifest,
  applyManifest,
  buildManifest,
  encodeManifest,
  type CodegenManifest,
} from "./codegen/manifest.js";
export { sourceHash } from "./codegen/provenance.js";

// --- assemblers: the encoders the browser needs because it has no toolchain --
export { Asm, AsmError, label } from "./asm/sm83.js";
export type { AluOp, CC, LabelRef, R8, R16, Ref, ShiftOp } from "./asm/sm83.js";
export {
  GB_HEADER_OFFSETS,
  GB_ROM_SIZE,
  stampGbHeader,
  type GbHeaderOptions,
} from "./asm/gb-cart.js";
export {
  Asm6502,
  abs,
  absX,
  absY,
  acc,
  at,
  imm,
  immHigh,
  immLow,
  ind,
  indX,
  indY,
  zp,
  zpX,
  zpY,
  type Imm,
  type Mnemonic,
  type Mode,
  type Operand,
} from "./asm/mos6502.js";
export {
  NES_CHR_OFFSET,
  NES_CHR_SIZE,
  NES_HEADER_SIZE,
  NES_PRG_OFFSET,
  NES_PRG_ORIGIN,
  NES_PRG_SIZE,
  NES_VECTORS,
  packInesRom,
  type NesHeaderOptions,
  type NesMirroring,
} from "./asm/nes-cart.js";
export {
  AsmZ80,
  highByte,
  lowByte,
  type Imm8,
  type Z80AluOp,
  type Z80CC,
  type Z80Index,
  type Z80JrCC,
  type Z80R8,
  type Z80R16,
  type Z80ShiftOp,
} from "./asm/z80.js";
export {
  Asm68k,
  eaA,
  eaAbs,
  eaD,
  eaDisp,
  eaIdx,
  eaImm,
  eaInd,
  eaPc,
  eaPost,
  eaPre,
  fitsAbsWord,
  type Ea,
  type M68kCC,
  type M68kSize,
} from "./asm/m68k.js";
export {
  MD_CHECKSUM_OFFSET,
  MD_CHECKSUM_START,
  MD_HEADER_OFFSET,
  MD_HEADER_SIZE,
  MD_HINT_VECTOR,
  MD_ORIGIN,
  MD_RAM_END,
  MD_RAM_START,
  MD_ROM_SIZE,
  MD_VINT_VECTOR,
  mdChecksum,
  packMdRom,
  type MdHeaderOptions,
} from "./asm/md-cart.js";
export {
  SMS_HEADER_OFFSET,
  SMS_HEADER_SIZE,
  SMS_IRQ_VECTOR,
  SMS_NMI_VECTOR,
  SMS_ORIGIN,
  SMS_RAM_END,
  SMS_RAM_START,
  SMS_ROM_SIZE,
  packSegaRom,
  regionFor,
  segaChecksum,
  type SegaHeaderOptions,
  type SegaRegion,
} from "./asm/sms-cart.js";
