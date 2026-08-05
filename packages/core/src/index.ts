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
// The PNG codec's own primitives, public because an *edge* needs them: a project
// is saved and opened as a zip (doc 19 §Opening, saving, and the parity claim),
// and a zip is a header format over exactly this deflate, this inflate and this
// CRC. Exporting them is what keeps the browser from shipping a second
// compressor beside the one it already has.
export { crc32 } from "./image/png/checksums.js";
export { deflateStored } from "./image/png/deflate.js";
export { inflateRaw } from "./image/png/inflate.js";
export { rasterizeSvg, isSvg, type RasterizeOptions } from "./image/svg/index.js";
export type { RgbaImage } from "./image/rgba.js";

// --- consoles ----------------------------------------------------------------
export { consoles, getConsole, findConsole, withMode } from "./consoles/registry.js";
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
export { DITHER_ALGS, EFFORTS, METRICS, PROFILES, SCALE_KERNELS } from "./pipeline/types.js";
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
// The mono WonderSwan's pool: derived from a picture rather than stored in it,
// because a compliant image holds the *level* a palette entry shows and not the
// slot it came from (`pipeline/fit-mono-tiled.ts`). One definition, because
// `demake build` has to agree with `demake gen` about which slot is which.
export { poolFor, WS_POOL_SIZE, WS_TILE_BYTES } from "./codegen/ws.js";
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
  GB_TO_MEGADUCK,
  MEGADUCK_ROM_SIZE,
  MEGADUCK_TO_GB,
  MEGADUCK_UNMAPPED,
  lcdcFromDuck,
  lcdcToDuck,
  megaduckRegister,
} from "./asm/megaduck.js";
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
  indZp,
  zp,
  zpX,
  zpY,
  type Imm,
  type Mnemonic,
  type Mode,
  type Operand,
} from "./asm/mos6502.js";
export { Asm6280, type BlockMove, type Mnemonic6280 } from "./asm/huc6280.js";
export {
  PCE_BANK_SIZE,
  PCE_CODE_ORIGIN,
  PCE_CODE_SIZE,
  PCE_ROM_SIZE,
  PCE_ROM_SIZES,
  PCE_VECTOR_BYTES,
  PCE_VECTORS,
  packHuCard,
  type PceCartOptions,
} from "./asm/pce-cart.js";
export {
  NES_CHR_SIZE,
  NES_HEADER_SIZE,
  NES_PRG_OFFSET,
  NES_PRG_ORIGIN,
  NES_PRG_SIZE,
  NES_PRG_SIZES,
  NES_VECTORS,
  nesChrOffset,
  nesPrgOrigin,
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
  MD_ROM_SIZES,
  MD_VINT_VECTOR,
  mdChecksum,
  packMdRom,
  type MdHeaderOptions,
} from "./asm/md-cart.js";
export {
  SMS_HEADER_OFFSET,
  SMS_FLAT_ROM_SIZES,
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
// The 65816's operand constructors overlap the 6502's by name and not by type —
// `abs` there produces a `Operand`, here an `Operand65816`, and the two address
// modes are spelled differently ("zp" against "dp") because the CPUs spell them
// differently. The five that collide are exported under a prefix and aliased back
// in one place (`codegen/snes/ops.ts` in the Demotic backend), so a call site
// still reads like assembly and nothing can pass the wrong operand to the wrong
// assembler.
export {
  Asm65816,
  abs as snesAbs,
  absInd,
  absIndLong,
  absIndX,
  absX as snesAbsX,
  absY as snesAbsY,
  acc65816,
  at65816,
  dp,
  dpInd,
  dpIndLong,
  dpIndLongY,
  dpIndX,
  dpIndY,
  dpX,
  dpY,
  imm16,
  imm8,
  immBank,
  immHigh as snesImmHigh,
  immLow as snesImmLow,
  long,
  longX,
  sr,
  srY,
  type Imm65816,
  type Mnemonic65816,
  type Mode65816,
  type Operand65816,
} from "./asm/wdc65816.js";
// The SPC700's constructors collide with both of the above for the same reason
// and are prefixed for the same reason: `dp` on this CPU is an operand of a
// different type, in a different address space, on a different processor. The
// registers (`A`, `X`, `Y`, `YA`, `SP`, `PSW`, `C`) are operands rather than
// modes here, so they have no counterpart to collide with and keep their names.
export {
  A,
  Asm700,
  C,
  PSW,
  SP,
  X,
  Y,
  YA,
  abs as spcAbs,
  absX as spcAbsX,
  absY as spcAbsY,
  dp as spcDp,
  dpX as spcDpX,
  dpY as spcDpY,
  idxIndY as spcIdxIndY,
  imm as spcImm,
  indIdxX as spcIndIdxX,
  indX as spcIndX,
  indXInc as spcIndXInc,
  indY as spcIndY,
  type Branch700,
  type Implied700,
  type Mnemonic700,
  type Spc700Operand,
  type Spc700Tag,
} from "./asm/spc700.js";
export {
  SNES_BANK_SIZE,
  SNES_CODE_SIZE,
  SNES_HEADER_OFFSET,
  SNES_ORIGIN,
  SNES_ROM_SIZE,
  SNES_ROM_SIZES,
  SNES_SPC_BANK,
  SNES_SPC_BASE,
  SNES_SPC_CAPACITY,
  SNES_SPC_OFFSET,
  SNES_TILE_BANK,
  SNES_TILE_BASE,
  SNES_TILE_CAPACITY,
  SNES_TILE_OFFSET,
  SNES_VECTORS,
  packSnesRom,
  snesChecksum,
  type SnesHeaderOptions,
} from "./asm/snes-cart.js";
// ARM's operand constructors are already prefixed at the source, for the reason
// the 65816's and the SPC700's are aliased here: `imm` and `at` on this CPU are
// operands of different types in a different encoding, and nothing should be
// able to hand one to another assembler. The register *numbers* stay unexported
// — a backend names them for what they hold (`codegen/gba/regs.ts`), which is
// more useful at a call site than `R4`, and `SP` is already the SPC700's.
export {
  ARM_LR,
  ARM_PC,
  ARM_SP,
  AsmArm,
  armAsr,
  armAt,
  armAtIdx,
  armAtIdxPost,
  armAtIdxSub,
  armAtPost,
  armAtPre,
  armImm,
  armLsl,
  armLsr,
  armReg,
  armRor,
  armRrx,
  armShiftBy,
  encodeArmImm,
  fitsArmImm,
  invertCond,
  type ArmBlockMode,
  type ArmCond,
  type ArmMem,
  type ArmOp2,
  type ArmShift,
} from "./asm/arm.js";
export {
  GBA_BIOS_IF,
  GBA_CHECK_END,
  GBA_CHECK_OFFSET,
  GBA_CHECK_START,
  GBA_EWRAM_END,
  GBA_EWRAM_START,
  GBA_HEADER_SIZE,
  GBA_IRQ_VECTOR,
  GBA_IWRAM_END,
  GBA_IWRAM_START,
  GBA_ORIGIN,
  gbaComplement,
  packGbaRom,
  type GbaHeaderOptions,
} from "./asm/gba-cart.js";
export {
  GB_TO_GBA_SOUND,
  GBA_SOUND_ADDRESS,
  GBA_SOUND_BASE,
  GBA_SOUND_TO_GB,
  GBA_SOUND_UNMAPPED,
  gbaSoundAddress,
  gbaSoundRegister,
} from "./asm/gba-sound.js";
export {
  NDS_ARM7_RAM,
  NDS_ARM7_WRAM_END,
  NDS_ARM7_WRAM_START,
  NDS_ARM9_RAM,
  NDS_HEADER_SIZE,
  NDS_MAIN_RAM_END,
  NDS_MAIN_RAM_START,
  ndsCrc16,
  packNdsRom,
  type NdsHeaderOptions,
} from "./asm/nds-cart.js";
// The V30MZ's operand constructors collide with the 6502's and the 65816's for
// the third time and are prefixed for the third reason: `abs` here is a 16-bit
// x86 memory operand carrying an optional base register and an optional segment,
// which is not an address mode either of those CPUs has. `codegen/wsc/ops.ts` in
// the Demotic backend aliases them back in one place, so a call site still reads
// like assembly and nothing can hand one CPU's operand to another's instruction.
export {
  abs as x86Abs,
  at as x86At,
  Asm30,
  invert as x86Invert,
  rom as x86Rom,
  romAbs as x86RomAbs,
  romAt as x86RomAt,
  type Mem as X86Mem,
  type X86AluOp,
  type X86Base,
  type X86CC,
  type X86R8,
  type X86R16,
  type X86Seg,
  type X86ShiftOp,
  type X86UnaryOp,
} from "./asm/v30mz.js";
// The TLCS-900/H, for the Neo Geo Pocket pair. Its operand constructors collide
// by name for the fourth time and are prefixed for a fourth distinct reason:
// `at` here is a 32-bit base register with a displacement, in a 24-bit address
// space, which is not an addressing mode any of the other three CPUs has.
export {
  abs as t9Abs,
  at as t9At,
  Asm900,
  indexed as t9Indexed,
  invert as t9Invert,
  postinc as t9Postinc,
  predec as t9Predec,
  sizeOf as t9SizeOf,
  type Mem as T9Mem,
  type T9AluOp,
  type T9CC,
  type T9MemMode,
  type T9R8,
  type T9R16,
  type T9R32,
  type T9Reg,
  type T9ShiftOp,
  type T9Size,
} from "./asm/tlcs900.js";
export {
  packWsRom,
  wsChecksum,
  WS_BANK_SIZE,
  WS_CODE_SEGMENT,
  WS_CODE_SIZE,
  WS_ENTRY_OFFSET,
  WS_FOOTER_OFFSET,
  WS_ROM_SIZE,
  type WsCartOptions,
} from "./asm/ws-cart.js";
