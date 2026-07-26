/**
 * The engine worker (doc 07 §Principles: everything client-side).
 *
 * This module is the *only* place the web app touches `@demake/core`, and it
 * calls exactly the API the CLI calls — same `prep`, same `gen`, same manifest
 * builder — so browser output is byte-identical to `demake` on the command line
 * (doc 10 §Determinism). Nothing here reads the DOM, the network, or storage.
 *
 * Building a game's cartridge is here for the same reason and one more. The
 * same reason: `buildGame` demakes the art the game names through this very
 * engine, so it is seconds of arithmetic that would otherwise freeze the tab.
 * The one more: it is the *only* place the image engine is bundled, so the
 * whole site ships one copy of it rather than one per thread that wanted it —
 * which is what the doc 07 §Quality bar budget is a sum in order to notice.
 */

import {
  DemakeError,
  buildManifest,
  codegenFamilies,
  consoles,
  encodeManifest,
  encodeRgbaPng,
  gen,
  prep,
  renderCompliant,
  sourceHash,
  strategies,
  type ConsoleSpec,
  type PrepOptions,
} from "@demake/core";
import { buildGame, familyFor, romExtension, unsupportedFor } from "@demake/demotic";

import { buildDemoImage } from "../lib/demo-image.js";
import { toPrepOptions } from "../lib/options.js";
import type {
  BuiltRomPayload,
  ConsoleInfo,
  GenArtifactPayload,
  PaletteSwatches,
  PrepPayload,
  Surface,
  WorkerRequest,
  WorkerResponse,
} from "./protocol.js";

const hex = (n: number): string => n.toString(16).padStart(2, "0");

/** One-line constraint summary for the console picker (derived from the spec). */
function summarize(spec: ConsoleSpec): string {
  const size = `${spec.display.width}×${spec.display.height}`;
  const layout = spec.layout;
  if (layout.kind === "tiles") {
    const { count, size: paletteSize } = layout.subPalettes;
    const colors = `${count} palette${count === 1 ? "" : "s"} × ${paletteSize} colors`;
    const attr =
      layout.attribute.w === layout.tileW && layout.attribute.h === layout.tileH
        ? `${layout.tileW}×${layout.tileH} tiles`
        : `${layout.attribute.w}×${layout.attribute.h} attribute cells`;
    return `${size} · ${colors} · ${attr}`;
  }
  if (layout.kind === "scanline") {
    return `${size} · ${layout.strategy === "tms-rowpair" ? "2 colors per 8×1 row" : layout.strategy}`;
  }
  return `${size} · ${layout.bpp}bpp framebuffer`;
}

function consoleList(): ConsoleInfo[] {
  return consoles().map((spec) => ({
    id: spec.id,
    name: spec.name,
    tier: spec.tier,
    width: spec.display.width,
    height: spec.display.height,
    summary: summarize(spec),
    formats: [...spec.codegen.formats],
    hasCodegen: CODEGEN_FAMILIES.has(spec.codegen.family),
    pixelAspect: [spec.display.pixelAspect[0], spec.display.pixelAspect[1]],
  }));
}

/**
 * Which families `gen` can emit for — asked of the registry, never listed here,
 * so a console gains its export buttons the moment its backend lands.
 */
const CODEGEN_FAMILIES = new Set<string>(codegenFamilies());

function surfaceOf(rendered: { width: number; height: number; data: Uint8Array }): Surface {
  // Copy into a fresh buffer so it can be transferred without detaching core's.
  const copy = new Uint8Array(rendered.data.length);
  copy.set(rendered.data);
  return { width: rendered.width, height: rendered.height, data: copy.buffer };
}

function swatches(
  palettes: readonly {
    colors: readonly {
      display: { r: number; g: number; b: number };
      raw: { r: number; g: number; b: number };
    }[];
  }[],
  useDac: boolean,
): PaletteSwatches[] {
  return palettes.map((p) => ({
    colors: p.colors.map((c) => {
      const rgb = useDac ? c.display : c.raw;
      return `#${hex(rgb.r)}${hex(rgb.g)}${hex(rgb.b)}`;
    }),
  }));
}

async function runPrep(
  source: ArrayBuffer,
  options: PrepOptions,
  onProgress: (stage: string, fraction: number) => void,
): Promise<PrepPayload> {
  const started = performance.now();
  const result = await prep(new Uint8Array(source), { ...options, onProgress });
  const png = new Uint8Array(result.png.length);
  png.set(result.png);
  const manifest = encodeManifest(buildManifest(result, sourceHash(result.png)));
  const manifestCopy = new Uint8Array(manifest.length);
  manifestCopy.set(manifest);
  return {
    png: png.buffer,
    manifest: manifestCopy.buffer,
    raw: surfaceOf(renderCompliant(result.image, false)),
    dac: surfaceOf(renderCompliant(result.image, true)),
    palettes: swatches(result.image.palettes, false),
    decisions: result.decisions,
    stats: result.stats,
    warnings: result.warnings,
    tournament: result.tournament,
    elapsedMs: Math.round(performance.now() - started),
  };
}

async function runGen(
  source: ArrayBuffer,
  options: PrepOptions,
  format: "asm" | "c" | "bin",
  stem: string,
): Promise<GenArtifactPayload[]> {
  const { console: consoleId, ...prepOnly } = options;
  const result = await gen(new Uint8Array(source), {
    console: consoleId,
    format,
    symbol: symbolFor(stem, consoleId),
    prep: prepOnly,
    sourceName: `${stem}.png`,
    optionString: `-c ${consoleId} --format ${format}`,
    command: `demake gen ${stem}.png -c ${consoleId} --format ${format}`,
  });
  return result.artifacts.map((a) => {
    const copy = new Uint8Array(a.bytes.length);
    copy.set(a.bytes);
    return { name: `${stem}${a.suffix}`, kind: a.kind, bytes: copy.buffer };
  });
}

/** Mirror the CLI's default symbol derivation so emitted code matches. */
function symbolFor(stem: string, consoleId: string): string {
  const cleaned = stem.replace(/[^A-Za-z0-9_]/g, "_").replace(/^_+/, "");
  const s = cleaned.length > 0 ? cleaned : `${consoleId}_gfx`;
  return /^[0-9]/.test(s) ? `_${s}` : s;
}

/** Tile-budget-aware demo image: colorful, and small enough to convert fast. */
function demoPng(): ArrayBuffer {
  const { width, height, data } = buildDemoImage();
  const png = encodeRgbaPng(width, height, data);
  const copy = new Uint8Array(png.length);
  copy.set(png);
  return copy.buffer;
}

/**
 * Compile a game to a cartridge, exactly as `demake build` does.
 *
 * The refusal case is a *result*, not an error: a console whose backend cannot
 * do what the `.dmt` asks for has a working game and no cartridge, and the
 * caller needs the console and the extension in order to say so.
 */
function runBuildGame(
  program: Parameters<typeof buildGame>[0],
  title: string,
  assets: Map<string, Uint8Array>,
): BuiltRomPayload {
  const consoleId = program.profile.id;
  const base = {
    console: consoleId,
    family: familyFor(consoleId) ?? "gb",
    extension: romExtension(program),
    unsupported: [...unsupportedFor(program)],
  };
  if (base.unsupported.length > 0) return base;
  const built = buildGame(program, { title, assets });
  // `slice()` because the ROM is transferred: a cartridge built out of a bank
  // the assembler still holds a view on would be handed away underneath it.
  return { ...base, rom: built.bytes.slice().buffer, layout: built.layout };
}

function post(message: WorkerResponse, transfer: Transferable[] = []): void {
  (self as unknown as Worker).postMessage(message, transfer);
}

function errorResponse(id: number, err: unknown): WorkerResponse {
  if (err instanceof DemakeError) {
    return {
      id,
      ok: false,
      code: err.code,
      message: err.message,
      ...(err.hint !== undefined ? { hint: err.hint } : {}),
    };
  }
  return { id, ok: false, code: "E_INTERNAL", message: String((err as Error)?.message ?? err) };
}

self.addEventListener("message", (event: MessageEvent<WorkerRequest>) => {
  const req = event.data;
  void (async () => {
    try {
      switch (req.kind) {
        case "consoles": {
          post({ id: req.id, ok: true, kind: "consoles", consoles: consoleList() });
          return;
        }
        case "strategies": {
          post({
            id: req.id,
            ok: true,
            kind: "strategies",
            strategies: strategies(req.console),
          });
          return;
        }
        case "demo": {
          const png = demoPng();
          post({ id: req.id, ok: true, kind: "demo", png }, [png]);
          return;
        }
        case "prep": {
          const result = await runPrep(req.source, toPrepOptions(req.options), (stage, fraction) =>
            post({ id: req.id, progress: { stage, fraction } }),
          );
          post({ id: req.id, ok: true, kind: "prep", result }, [
            result.png,
            result.manifest,
            result.raw.data,
            result.dac.data,
          ]);
          return;
        }
        case "gen": {
          const artifacts = await runGen(
            req.source,
            toPrepOptions(req.options),
            req.format,
            req.stem,
          );
          post(
            { id: req.id, ok: true, kind: "gen", artifacts },
            artifacts.map((a) => a.bytes),
          );
          return;
        }
        case "build-game": {
          const result = runBuildGame(req.program, req.title, req.assets);
          post(
            { id: req.id, ok: true, kind: "build-game", result },
            result.rom ? [result.rom] : [],
          );
          return;
        }
      }
    } catch (err) {
      post(errorResponse(req.id, err));
    }
  })();
});
