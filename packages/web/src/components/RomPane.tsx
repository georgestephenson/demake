/**
 * The cartridge: the same game, running as a real Game Boy ROM in the page.
 *
 * Doc 13 §D5 says the browser must never assemble anything, and it does not.
 * The runtime is a fixed engine assembled once and checked in (`pnpm
 * gen:runtime`); a build patches the compiled program tables into it and fixes
 * the header. So the bytes this pane plays — and the bytes the Download button
 * hands you — are byte-identical to what `demake build` writes on the command
 * line, which is the doc-07 parity contract restated for games.
 *
 * The emulator is `@demake/dmg`, ours, for the reason doc 07 gives: a core
 * fetched from a CDN is forbidden, and a WASM core we cannot read would be the
 * same bargain in a different wrapper.
 *
 * **The frame counter under the screen is not decoration.** This runtime is a
 * table interpreter doing 16.16 arithmetic on a 4 MHz 8-bit CPU, and it does
 * not yet fit a game tick inside one frame. Showing the measured cost is the
 * honest way to present that: the ROM runs at hardware speed, and the number
 * says what that speed is.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";

import { buildGbRom, RAM, unsupportedFeatures, type Program } from "@demake/demotic";
import { Gameboy, SCREEN_HEIGHT, SCREEN_WIDTH, type Button } from "@demake/dmg";

import { download } from "../lib/download.js";

/** The portable button set maps one for one onto the Game Boy's. */
const BUTTONS: Readonly<Record<string, Button>> = {
  left: "left",
  right: "right",
  up: "up",
  down: "down",
  a: "a",
  b: "b",
  start: "start",
};

/** Game Boy frames per second, to the accuracy anyone cares about. */
const FRAME_RATE = 59.7;

export function RomPane({
  program,
  name,
  held,
  latched,
}: {
  program: Program | undefined;
  name: string;
  held: { current: Set<string> };
  latched: { current: Set<string> };
}) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const machine = useRef<Gameboy | null>(null);
  const [cost, setCost] = useState<number | null>(null);

  const built = useMemo(() => {
    if (!program) return { rom: undefined, error: undefined };
    if (program.profile.id !== "gb") {
      return {
        rom: undefined,
        error:
          `Only the Game Boy has a runtime so far. ${program.profile.name} needs its own ` +
          `engine for the same tables — that is doc 13 §D4, and it is the next piece of work.`,
      };
    }
    const missing = unsupportedFeatures(program);
    if (missing.length > 0) {
      return {
        rom: undefined,
        error:
          `This game uses ${missing.join(" and ")}, which the Game Boy runtime does not ` +
          `implement yet. The preview above plays it correctly; a ROM would play something ` +
          `else, so the build refuses rather than pretend.`,
      };
    }
    try {
      return { rom: buildGbRom(program, { title: name }).bytes, error: undefined };
    } catch (error) {
      return { rom: undefined, error: String((error as Error).message ?? error) };
    }
  }, [program, name]);

  const rom = built.rom;

  useEffect(() => {
    if (!rom) {
      machine.current = null;
      return;
    }
    const gameboy = new Gameboy(rom);
    machine.current = gameboy;
    const element = canvas.current;
    const context = element?.getContext("2d");
    if (!context) return;

    let raf = 0;
    let last = performance.now();
    let accumulator = 0;
    let sinceTick = 0;
    let lastTick = 0;
    const image = context.createImageData(SCREEN_WIDTH, SCREEN_HEIGHT);

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      // Real hardware time, not wall-clock catch-up: a game that needs three
      // frames per tick should *look* like it needs three frames per tick.
      accumulator += Math.min(now - last, 250);
      last = now;
      const step = 1000 / FRAME_RATE;

      let budget = 4;
      while (accumulator >= step && budget-- > 0) {
        const down: Button[] = [];
        for (const action of held.current) if (BUTTONS[action]) down.push(BUTTONS[action]);
        for (const action of latched.current) if (BUTTONS[action]) down.push(BUTTONS[action]);
        gameboy.setButtons(down);
        gameboy.runFrame();
        accumulator -= step;
        sinceTick += 1;
        const tick = gameboy.readMemory(RAM.ready, 1)[0] as number;
        if (tick !== lastTick) {
          lastTick = tick;
          latched.current.clear();
          setCost(sinceTick);
          sinceTick = 0;
        }
      }

      image.data.set(gameboy.framebuffer);
      context.putImageData(image, 0, 0);
    };

    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [rom, held, latched]);

  const save = useCallback(() => {
    if (rom) download(`${name}.gb`, rom);
  }, [rom, name]);

  const reset = useCallback(() => {
    if (rom) machine.current = new Gameboy(rom);
  }, [rom]);

  if (!rom) {
    return (
      <div class="rom-pane">
        <h3>The cartridge</h3>
        <p class="hint" data-testid="rom-unavailable">
          {built.error ?? "Fix the errors above and a ROM will build."}
        </p>
      </div>
    );
  }

  return (
    <div class="rom-pane">
      <h3>The cartridge</h3>
      <canvas
        ref={canvas}
        class="rom-canvas"
        data-testid="rom-canvas"
        width={SCREEN_WIDTH}
        height={SCREEN_HEIGHT}
        role="img"
        aria-label="The game, running as a Game Boy ROM"
      />
      <div class="rom-toolbar">
        <button type="button" onClick={reset}>
          Reset
        </button>
        <button type="button" data-testid="rom-download" onClick={save}>
          Download {name}.gb
        </button>
        <span class="rom-stat" data-testid="rom-stat">
          {(rom.length / 1024).toFixed(0)} KiB
          {cost === null
            ? ""
            : ` · ${cost} frame${cost === 1 ? "" : "s"} per tick (${Math.round(FRAME_RATE / cost)} Hz)`}
        </span>
      </div>
      <p class="hint">
        A real 32 KiB cartridge, patched in the page and byte-identical to <code>demake build</code>
        &rsquo;s. It runs at hardware speed here, so the frames-per-tick figure is what the
        interpreter actually costs an SM83 — the runtime is correct before it is fast, and making it
        fast is the next piece of work.
      </p>
    </div>
  );
}
