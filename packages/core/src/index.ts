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
export { decodeImage, detectFormat, type DecodeOptions, type ImageFormat } from "./image/decode.js";
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
export { consoleNames, consoleLabel } from "./consoles/names.js";
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
  SourceInfo,
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
// The Virtual Boy's character packer, public for the reason `poolFor` is: the
// game backend and `demake gen` have to agree byte for byte about which two bits
// a pixel is, and the wrong one of this console's two candidate orders mirrors
// every tile in place rather than failing.
export { packPacked2Le } from "./codegen/tiles.js";
export { VB_CHAR_BYTES, VB_GEN_PARALLAX } from "./codegen/vb.js";
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
  NEO_BLOCK_ORIGINS,
  NEO_CODE_ORIGIN,
  NEO_CONTAINER_HEADER,
  NEO_FIX_TILE_BYTES,
  NEO_HEADER_OFFSET,
  NEO_TILE_BYTES,
  NEO_TILE_PLANE_BYTES,
  NEO_USER_ENTRY,
  packNeoCharacters,
  packNeoFix,
  packNeoHeader,
  packNeoRom,
  unpackNeoCharacters,
  unpackNeoFix,
  type NeoHeaderOptions,
  type NeoRegions,
} from "./asm/neo-cart.js";
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
  NGP_BACKGROUND_PALETTE,
  NGP_BGC,
  NGP_BUTTON_BITS,
  NGP_BUTTONS,
  NGP_CHARACTER_BYTES,
  NGP_CHARACTER_COUNT,
  NGP_CHARACTERS,
  NGP_CONTROL,
  NGP_DAC_LEFT,
  NGP_DAC_RIGHT,
  NGP_INTERNAL_IO,
  NGP_K1GE_PALETTE,
  NGP_MODE,
  NGP_PALETTE,
  NGP_PALETTE_STRIDE,
  NGP_PLANE_COLUMNS,
  NGP_PLANE_PRIORITY,
  NGP_PLANE_ROWS,
  NGP_PLANE1,
  NGP_PLANE2,
  NGP_PO_H,
  NGP_PO_V,
  NGP_RAM,
  NGP_RAM_RESERVED,
  NGP_RAM_SIZE,
  NGP_RAM_USABLE,
  NGP_RAS_H,
  NGP_RAS_V,
  NGP_REF,
  NGP_S1SO_H,
  NGP_S1SO_V,
  NGP_S2SO_H,
  NGP_S2SO_V,
  NGP_SCREEN_HEIGHT,
  NGP_SOUND_ENABLE,
  NGP_SOUND_ENABLE_HIGH,
  NGP_SOUND_ENABLE_HIGH_VALUE,
  NGP_SOUND_ENABLE_VALUE,
  NGP_SOUND_LEFT,
  NGP_SOUND_RIGHT,
  NGP_SCREEN_WIDTH,
  NGP_SPRITE_COUNT,
  NGP_SPRITE_PALETTES,
  NGP_SPRITES,
  NGP_STATUS,
  NGP_VECTOR_TIMER0,
  NGP_VECTOR_TIMER1,
  NGP_VECTOR_TIMER2,
  NGP_VECTOR_TIMER3,
  NGP_VECTOR_VBLANK,
  NGP_VECTOR_Z80,
  NGP_VIDEO,
  NGP_WBA_H,
  NGP_WBA_V,
  NGP_WSI_H,
  NGP_WSI_V,
  NGP_Z80_RAM,
} from "./asm/ngp.js";
export {
  ngpRomSize,
  packNgpRom,
  NGP_ENTRY_OFFSET,
  NGP_HEADER_SIZE,
  NGP_RECOGNITION_CODE,
  NGP_ROM_BASE,
  NGP_ROM_SIZE,
  NGP_ROM_SIZES,
  NGP_SYSTEM_COLOR,
  NGP_SYSTEM_MONO,
  type NgpCartOptions,
} from "./asm/ngp-cart.js";
export {
  Asm810,
  highHalf,
  invertCond as invertV810Cond,
  SR_ADTRE,
  SR_CHCW,
  SR_ECR,
  SR_EIPC,
  SR_EIPSW,
  SR_FEPC,
  SR_FEPSW,
  SR_PIR,
  SR_PSW,
  SR_TKCW,
  V810_EP,
  V810_GP,
  V810_HP,
  V810_LP,
  V810_R0,
  V810_R1,
  V810_SP,
  V810_TP,
  type V810Cond,
  type V810Reg,
} from "./asm/v810.js";
export {
  VB_ADDRESS_MASK,
  VB_BGMAP,
  VB_BGMAP_BYTES,
  VB_BGMAP_COUNT,
  VB_BGMAP_H,
  VB_BGMAP_W,
  VB_BKCOL,
  VB_BRTA,
  VB_BRTB,
  VB_BRTC,
  VB_CHR_BYTES,
  VB_CHR_COUNT,
  VB_CHR_MIRROR,
  VB_COLUMN_TABLE_L,
  VB_COLUMN_TABLE_R,
  VB_CTA,
  VB_DPCTRL,
  VB_DPCTRL_ON,
  VB_DPSTTS,
  VB_DP_DISP,
  VB_DP_DPBSY,
  VB_DP_DPRST,
  VB_DP_FCLK,
  VB_DP_LOCK,
  VB_DP_RE,
  VB_DP_SCANRDY,
  VB_DP_SYNCE,
  VB_FB_COLUMN,
  VB_FB_L0,
  VB_FB_L1,
  VB_FB_R0,
  VB_FB_R1,
  VB_FRAME_HZ,
  VB_FRMCYC,
  VB_GPLT0,
  VB_GPLT1,
  VB_GPLT2,
  VB_GPLT3,
  VB_HARDWARE,
  VB_INTCLR,
  VB_INTENB,
  VB_INTPND,
  VB_INT_FRAMESTART,
  VB_INT_GAMESTART,
  VB_INT_LFBEND,
  VB_INT_RFBEND,
  VB_INT_SBHIT,
  VB_INT_SCANERR,
  VB_INT_TIMEERR,
  VB_INT_XPEND,
  VB_JPLT0,
  VB_JPLT1,
  VB_JPLT2,
  VB_JPLT3,
  VB_KEY_A,
  VB_KEY_B,
  VB_KEY_LD,
  VB_KEY_LL,
  VB_KEY_LR,
  VB_KEY_LT,
  VB_KEY_LU,
  VB_KEY_PWR,
  VB_KEY_RD,
  VB_KEY_RL,
  VB_KEY_RR,
  VB_KEY_RT,
  VB_KEY_RU,
  VB_KEY_SEL,
  VB_KEY_SGN,
  VB_KEY_STA,
  VB_OAM,
  VB_OBJ_ATTR,
  VB_OBJ_BYTES,
  VB_OBJ_COUNT,
  VB_OBJ_HFLIP,
  VB_OBJ_JLON,
  VB_OBJ_JP,
  VB_OBJ_JRON,
  VB_OBJ_JX,
  VB_OBJ_JY,
  VB_OBJ_VFLIP,
  VB_REST,
  VB_ROM,
  VB_SCR,
  VB_SCREEN_H,
  VB_SCREEN_W,
  VB_SCR_HW_READ,
  VB_SCR_STAT,
  VB_SDHR,
  VB_SDLR,
  VB_SPT0,
  VB_SPT1,
  VB_SPT2,
  VB_SPT3,
  VB_SRAM,
  VB_VER,
  VB_VIP,
  VB_VIP_REGS,
  VB_VSU,
  VB_WORLDS,
  VB_WORLD_BGM_AFFINE,
  VB_WORLD_BGM_HBIAS,
  VB_WORLD_BGM_NORMAL,
  VB_WORLD_BGM_OBJ,
  VB_WORLD_BYTES,
  VB_WORLD_COUNT,
  VB_WORLD_END,
  VB_WORLD_GP,
  VB_WORLD_GX,
  VB_WORLD_GY,
  VB_WORLD_H,
  VB_WORLD_HEAD,
  VB_WORLD_LON,
  VB_WORLD_MP,
  VB_WORLD_MX,
  VB_WORLD_MY,
  VB_WORLD_OVERPLANE,
  VB_WORLD_OVR,
  VB_WORLD_PARAM,
  VB_WORLD_RON,
  VB_WORLD_W,
  VB_WRAM,
  VB_WRAM_SIZE,
  VB_XPCTRL,
  VB_XPSTTS,
  VB_XP_OVERTIME,
  VB_XP_XPBSY,
  VB_XP_XPEN,
  VB_XP_XPRST,
  vbFramebufferBit,
  vbParallax,
  vbShade,
  VB_DEPTH,
  VB_NEARER_SIGN,
  vbObjPalette,
  vbWorldScx,
  vbWorldScy,
} from "./asm/vb.js";
export {
  packVbRom,
  vbRomSize,
  VB_HEADER_ADDRESS,
  VB_HEADER_BYTES,
  VB_ROM_SIZES,
  VB_VECTOR_ADDRESS,
  VB_VECTOR_BASE,
  VB_VECTOR_BYTES,
  VB_VECTOR_DUPLEX,
  VB_VECTOR_EXPANSION,
  VB_VECTOR_INVALID,
  VB_VECTOR_KEY,
  VB_VECTOR_LINK,
  VB_VECTOR_RESET,
  VB_VECTOR_SLOT,
  VB_VECTOR_TIMER,
  VB_VECTOR_TRAP_HIGH,
  VB_VECTOR_TRAP_LOW,
  VB_VECTOR_VIP,
  VB_VECTOR_ZERO_DIVIDE,
  type VbCartOptions,
} from "./asm/vb-cart.js";
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
