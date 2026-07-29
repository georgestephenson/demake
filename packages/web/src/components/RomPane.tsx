/**
 * The cartridge: the same game, running as a real ROM in the page.
 *
 * Doc 13 §D5 says the browser must never need a toolchain, and it does not: the
 * assemblers are ours and written in TypeScript, so the page *compiles* the game
 * — to SM83 for a Game Boy, to 6502 for an NES, to Z80 for a Master System, to
 * 68000 for a Mega Drive — the same way the CLI does and gets the same bytes. What the Download button hands you is byte-identical to
 * what `demake build` writes on the command line, which is the doc-07 parity
 * contract restated for games.
 *
 * The emulators are `@demake/dmg`, `@demake/nes`, `@demake/sms` and `@demake/md`,
 * ours, for the reason doc 07 gives: a core fetched from a CDN is forbidden, and a WASM core we
 * cannot read would be the same bargain in a different wrapper. Which one runs is
 * decided by the console the game was compiled for, and *within* two of the three
 * families by the cartridge itself — a `gbc` build carries the CGB flag in its
 * header and comes up in colour, a `gg` build carries a Game Gear region nibble
 * and comes up as a handheld — so the console selector above this pane changes the
 * **cartridge**, and the player follows it rather than being a setting of its own.
 *
 * **The frame counter under the screen is not decoration.** It is the measured
 * cost of one game tick on an 8-bit CPU, and reporting it is how the pane stays
 * honest about hardware speed rather than hiding behind a multiplier.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";

import { romReady, type Layout, type Program } from "@demake/demotic";
import { Gameboy, SCREEN_HEIGHT, SCREEN_WIDTH, type Button } from "@demake/dmg";
import {
  FRAME_HEIGHT as MD_HEIGHT,
  FRAME_WIDTH as MD_WIDTH,
  Md,
  PSG_MIX_GAIN as MD_PSG_MIX_GAIN,
  type Button as MdButton,
} from "@demake/md";
import { Nes, SCREEN_HEIGHT as NES_HEIGHT, SCREEN_WIDTH as NES_WIDTH } from "@demake/nes";
import {
  FRAME_HEIGHT as SMS_HEIGHT,
  FRAME_WIDTH as SMS_WIDTH,
  GG_HEIGHT,
  GG_WIDTH,
  Sms,
  type Button as SmsButton,
} from "@demake/sms";

import { demoAssetBytes, demoAudioBytes } from "../lib/demo-game.js";
import { download } from "../lib/download.js";
import { audioSupported, RomAudio, type ListenableMachine } from "../lib/rom-audio.js";
import { createEngine } from "../worker/client.js";

/**
 * The portable button set maps one for one onto every machine's pad.
 *
 * Which is what doc 14 §Buttons chose it for: the Game Boy has exactly these
 * seven, the NES has them and a Select besides, and a Master System has six and
 * a Pause key — which is what `start` means there, and the cartridge already
 * knows it.
 */
const BUTTONS: Readonly<Record<string, Button>> = {
  left: "left",
  right: "right",
  up: "up",
  down: "down",
  a: "a",
  b: "b",
  start: "start",
};

/** Frames per second, to the accuracy anyone cares about. Both are ~60. */
const FRAME_RATE = 59.7;

/** What to call the machine in the page's own voice, article and all. */
const MACHINE: Readonly<Record<string, string>> = {
  gb: "a Game Boy",
  gbc: "a Game Boy Color",
  megaduck: "a Mega Duck",
  nes: "an NES",
  sms: "a Master System",
  gg: "a Game Gear",
  md: "a Mega Drive",
};

/**
 * A booted cartridge, whichever console it is for.
 *
 * The pane needs five things of a machine and no more, so this is those five —
 * and the four cores satisfy it without any of them learning about the page or
 * about each other. `chips` is the sound hardware the audio player attaches to,
 * and every console with a backend has some: the Game Boy's APU, the NES's 2A03,
 * the SN76489 on both Sega machines, and *two* on a Mega Drive — each
 * `@demake/chip`'s own model rather than a second copy living in a core. A list
 * rather than one, because that console's two run on different clocks and a sink
 * is built against a clock; an empty one would say a cartridge has nothing to
 * play rather than offering a control that does nothing.
 */
interface Player {
  readonly width: number;
  readonly height: number;
  readonly framebuffer: Uint8ClampedArray;
  readonly chips: ListenableMachine;
  setButtons(down: Button[]): void;
  runFrame(): void;
  readMemory(address: number, length: number): Uint8Array;
}

/**
 * Boot a cartridge in the core its console needs.
 *
 * The family comes with the cartridge rather than being looked up here: which
 * consoles have a backend is `codegen/registry.ts`'s one list, and the page
 * reads it through the worker like everything else it knows about the engine.
 */
function boot(rom: Uint8Array, family: string, consoleId: string): Player {
  if (family === "md") {
    const machine = new Md(rom);
    return {
      width: MD_WIDTH,
      height: MD_HEIGHT,
      framebuffer: machine.framebuffer,
      // The only console here with two chips, and the cartridge plays both: six
      // four-operator FM voices and four tone generators. They are handed over
      // separately because they run on different clocks — the master clock over
      // seven and over fifteen — and the relative level is the *board's* rather
      // than either chip's, which is why it arrives here rather than being asked
      // of a model (doc 16 §Packages).
      chips: [
        {
          get audioSink() {
            return machine.ymSink;
          },
          set audioSink(sink) {
            machine.ymSink = sink;
          },
          apu: machine.ym,
        },
        {
          get audioSink() {
            return machine.audioSink;
          },
          set audioSink(sink) {
            machine.audioSink = sink;
          },
          apu: machine.psg,
          gain: MD_PSG_MIX_GAIN,
        },
      ],
      setButtons: (down) => machine.setButtons(down as readonly MdButton[]),
      runFrame: () => void machine.runFrame(),
      readMemory: (address, length) => machine.readMemory(address, length),
    };
  }
  if (family === "sms") {
    // Which of the two machines it is comes out of the cartridge's own region
    // nibble, not from `consoleId` — the same rule the Game Boy family runs
    // under, and the reason the selector changes the build rather than a setting.
    const machine = new Sms(rom);
    const view = machine.vdp.view();
    return {
      width: view.width,
      height: view.height,
      framebuffer: view.pixels,
      // The Sega's sound chip is a PSG, not an APU, so it is adapted rather
      // than renamed — the core keeps calling it what it is. What it plays is
      // the cartridge's own generated Z80 driver, through the same `StreamSink`
      // the other two consoles use.
      chips: [
        {
          get audioSink() {
            return machine.audioSink;
          },
          set audioSink(sink) {
            machine.audioSink = sink;
          },
          apu: machine.psg,
        },
      ],
      // A Sega pad has no Select, so the one button the portable set does not
      // include is dropped rather than mapped onto something else.
      setButtons: (down) => machine.setButtons(down as readonly SmsButton[]),
      runFrame: () => {
        machine.runFrame();
        machine.vdp.view();
      },
      readMemory: (address, length) => machine.readMemory(address, length),
    };
  }
  if (family === "nes") {
    const machine = new Nes(rom);
    return {
      width: NES_WIDTH,
      height: NES_HEIGHT,
      framebuffer: machine.framebuffer,
      chips: [machine],
      setButtons: (down) => machine.setButtons(down),
      runFrame: () => void machine.runFrame(),
      readMemory: (address, length) => machine.readMemory(address, length),
    };
  }
  // The one place the console id is needed rather than the family, and the
  // reason is the absence of a fact rather than a preference: a Mega Duck
  // cartridge has no header at all, so unlike the two Game Boys (whose CGB flag
  // decides) and the two Sega machines (whose region nibble does), there is
  // nothing in these bytes to read it out of.
  const machine = new Gameboy(rom, consoleId === "megaduck" ? "megaduck" : "gameboy");
  return {
    width: SCREEN_WIDTH,
    height: SCREEN_HEIGHT,
    framebuffer: machine.framebuffer,
    chips: [machine],
    setButtons: (down) => machine.setButtons(down),
    runFrame: () => void machine.runFrame(),
    readMemory: (address, length) => machine.readMemory(address, length),
  };
}

export function RomPane({
  program,
  name,
  held,
  latched,
  restarts,
  pending = false,
}: {
  program: Program | undefined;
  name: string;
  held: { current: Set<string> };
  latched: { current: Set<string> };
  /**
   * True while the editor is still being typed in and this cartridge is a
   * version behind. The pane keeps playing the ROM it has — a screen that
   * blanked on every keystroke would be worse than a stale one — and says so.
   */
  pending?: boolean;
  /**
   * Bumped by the section's Restart button.
   *
   * The pane has no Restart of its own: with the cartridge as the default view,
   * two buttons a few centimetres apart doing the same thing to two different
   * machines is a worse answer than one that restarts what you are looking at.
   */
  restarts: number;
}) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const machine = useRef<Player | null>(null);
  const [cost, setCost] = useState<number | null>(null);
  // The player, and whether the user has asked for it. It lives in a ref so the
  // frame loop can read it without being rebuilt every time it is toggled, and
  // it is created on the first click because a browser will not start an
  // `AudioContext` without a user gesture.
  const player = useRef<RomAudio | null>(null);
  // Two states, because they are two different facts. `sound` is what the
  // *listener* asked for and flips the moment they ask; `playing` is whether the
  // device is really running, which is the browser's decision and can arrive
  // later or never — Firefox resolves `resume()` before the state flips, and a
  // machine with no audio device never flips it at all. Reporting the first as
  // if it were the second is how a button comes to lie in one browser.
  const [sound, setSound] = useState(false);
  const [playing, setPlaying] = useState(false);
  // The music and the effects are binary and are fetched rather than bundled,
  // so the build waits for them. It waits rather than building without them
  // because a cartridge missing its audio would not be the one `demake build`
  // writes, and that is the one thing this pane promises.
  const [audio, setAudio] = useState<Map<string, Uint8Array> | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void demoAudioBytes().then((bytes) => {
      if (live) setAudio(bytes);
    });
    return () => {
      live = false;
    };
  }, []);

  // The build happens in the engine worker, and that is not an optimisation:
  // demaking a *colour* backdrop is the whole `prep` tournament, seconds of
  // arithmetic the first time the page sees a picture, and it is synchronous.
  // On this thread a tab would simply stop for those seconds and look broken.
  // The pane's own worker, because the game section is not the art section and
  // neither should wait on the other; the module is the same file either way,
  // which is why the site still ships one copy of the engine.
  const engine = useMemo(() => createEngine(), []);
  const [built, setBuilt] = useState<{
    /**
     * The console this cartridge is for, the extension it is named with, and
     * the family whose core plays it.
     *
     * The pane keeps playing the ROM it has while the next one demakes, so for
     * those seconds the picker and the cartridge disagree — and everything on
     * screen describes the *cartridge*. Without this the Download button would
     * offer `.nes` and hand you a Game Boy.
     */
    consoleId?: string;
    extension?: string;
    family?: string;
    rom?: Uint8Array;
    layout?: Layout;
    error?: string;
  }>({});
  const [demaking, setDemaking] = useState(false);

  useEffect(() => {
    // The early exit clears the flag as well as the cartridge: a build that is
    // never going to start must not leave the pane saying it is demaking, which
    // is how "fix the errors above" came to be unreachable once the badge could
    // outlive its effect.
    if (!program || !audio) {
      setBuilt({});
      setDemaking(false);
      return;
    }
    let live = true;
    setDemaking(true);
    // The bundled art goes in as *source bytes*: the conversion happens inside
    // the build, so the page and the CLI cannot diverge on it.
    const assets = demoAssetBytes();
    for (const [file, bytes] of audio) assets.set(file, bytes);
    void engine
      .buildGame(program, name, assets)
      .then((result) => {
        if (!live) return;
        const where = {
          consoleId: result.console,
          extension: result.extension,
          family: result.family,
        };
        if (result.unsupported.length > 0) {
          setBuilt({
            ...where,
            error:
              `This game needs ${result.unsupported.join(" and ")}. The preview above plays ` +
              `it correctly; a ROM would play something else, so the build refuses rather ` +
              `than pretend.`,
          });
          return;
        }
        setBuilt({ ...where, rom: new Uint8Array(result.rom!), layout: result.layout! });
      })
      .catch((error: unknown) => {
        if (!live) return;
        setBuilt({
          consoleId: program.profile.id,
          error: String((error as Error).message ?? error),
        });
      })
      .finally(() => {
        if (live) setDemaking(false);
      });
    return () => {
      live = false;
    };
  }, [engine, program, name, audio]);

  const { rom, layout } = built;
  // The cartridge's console, not the picker's: they differ for as long as a build
  // takes, and everything below describes what is on screen. A colour build is a
  // different cartridge rather than a setting on this one, and so is an NES one.
  const consoleId = built.consoleId ?? program?.profile.id ?? "gb";
  const family = built.family ?? "gb";
  const extension = built.extension ?? "gb";
  // Whether the browser will give us an `AudioContext`. Every console with a
  // backend now has a chip the cartridge's own driver plays, so this is the only
  // question left — a control that did nothing would be worse than none.
  const canSound = audioSupported();
  // The canvas is sized by the console, not by CSS: these are two genuinely
  // different screens (160×144 against 256×240, and not the same aspect), and a
  // buffer put into a canvas of the wrong size is silently cropped.
  const screen =
    family === "nes"
      ? { width: NES_WIDTH, height: NES_HEIGHT }
      : family === "md"
        ? { width: MD_WIDTH, height: MD_HEIGHT }
        : family === "sms"
          ? consoleId === "gg"
            ? { width: GG_WIDTH, height: GG_HEIGHT }
            : { width: SMS_WIDTH, height: SMS_HEIGHT }
          : { width: SCREEN_WIDTH, height: SCREEN_HEIGHT };

  useEffect(() => {
    if (!rom || !layout) {
      machine.current = null;
      return;
    }
    const booted = boot(rom, family, consoleId);
    machine.current = booted;
    if (booted.chips.length > 0) player.current?.attach(booted.chips);
    const element = canvas.current;
    const context = element?.getContext("2d");
    if (!context) return;

    let raf = 0;
    let last = performance.now();
    let accumulator = 0;
    let sinceTick = 0;
    let lastTick = 0;
    const image = context.createImageData(booted.width, booted.height);

    /** One console frame, with the pad and the tick bookkeeping around it. */
    const runFrame = (target: Player) => {
      const down: Button[] = [];
      for (const action of held.current) if (BUTTONS[action]) down.push(BUTTONS[action]);
      for (const action of latched.current) if (BUTTONS[action]) down.push(BUTTONS[action]);
      target.setButtons(down);
      target.runFrame();
      sinceTick += 1;
      const tick = romReady(layout, (address, length) => target.readMemory(address, length));
      if (tick !== lastTick) {
        lastTick = tick;
        latched.current.clear();
        setCost(sinceTick);
        sinceTick = 0;
      }
    };

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      // Read the machine each frame rather than closing over it, so Reset
      // actually resets and a stream stays attached to the machine that is
      // running.
      const current = machine.current;
      if (!current) return;
      const audio = player.current?.active === true ? player.current : null;

      if (audio) {
        // Audio has no tolerance for a late buffer, so with sound on the device
        // is the clock: run until the chip has produced what the player still
        // needs. The wall clock is reset alongside it, or turning sound off
        // would leave a backlog to sprint through.
        let budget = 8;
        while (budget-- > 0 && audio.demand() > 0) runFrame(current);
        audio.flush();
        last = now;
        accumulator = 0;
      } else {
        // Real hardware time, not wall-clock catch-up: a game that needs three
        // frames per tick should *look* like it needs three frames per tick.
        accumulator += Math.min(now - last, 250);
        last = now;
        const step = 1000 / FRAME_RATE;
        let budget = 4;
        while (accumulator >= step && budget-- > 0) {
          runFrame(current);
          accumulator -= step;
        }
      }

      image.data.set(current.framebuffer);
      context.putImageData(image, 0, 0);
    };

    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [rom, layout, consoleId, family, held, latched, restarts]);

  // The context outlives every ROM built in the section, and is closed once.
  useEffect(() => () => player.current?.close(), []);

  const toggleSound = useCallback(() => {
    if (!canSound) return;
    let audio = player.current;
    if (!audio) {
      audio = new RomAudio();
      player.current = audio;
      const created = audio;
      created.watch(() => setPlaying(created.active));
    }
    if (sound) {
      setSound(false);
      void audio.suspend(machine.current?.chips ?? null).then(() => setPlaying(audio.active));
      return;
    }
    // The click *is* the gesture a browser wants before it will start a
    // context, which is the whole reason this is a button and not a default.
    setSound(true);
    void audio
      .resume()
      .then(() => {
        if (machine.current?.chips.length) audio.attach(machine.current.chips);
        setPlaying(audio.active);
      })
      .catch(() => setPlaying(false));
  }, [sound, canSound]);

  const save = useCallback(() => {
    if (rom) download(`${name}.${extension}`, rom);
  }, [rom, name, extension]);

  if (!rom) {
    return (
      <div class="rom-pane">
        <h3>The cartridge</h3>
        <p class="hint" data-testid="rom-unavailable">
          {built.error ??
            (program && !audio
              ? "Demaking this game\u2019s music and effects\u2026"
              : demaking
                ? "Demaking this game\u2019s art and building the cartridge\u2026"
                : "Fix the errors above and a ROM will build.")}
        </p>
      </div>
    );
  }

  return (
    <div class="rom-pane">
      <h3>The cartridge</h3>
      <div class="rom-screen">
        <canvas
          ref={canvas}
          class="rom-canvas"
          data-testid="rom-canvas"
          // Which machine is running, for anything that needs to wait for a
          // particular one: the picker changes the moment it is clicked, and the
          // cartridge arrives a demake later.
          data-console={consoleId}
          width={screen.width}
          height={screen.height}
          role="img"
          aria-label={`The game, running as ${MACHINE[consoleId] ?? "a console"} ROM`}
          style={{ aspectRatio: `${screen.width} / ${screen.height}` }}
        />
        {pending || demaking ? (
          <p class="rom-building" data-testid="rom-building" role="status">
            Demaking&hellip;
          </p>
        ) : null}
      </div>
      <div class="rom-toolbar">
        <button
          type="button"
          data-testid="rom-sound"
          aria-pressed={sound}
          onClick={toggleSound}
          disabled={!canSound}
        >
          {sound ? "Sound on" : "Sound off"}
        </button>
        <button type="button" data-testid="rom-download" onClick={save}>
          Download {name}.{extension}
        </button>
        <span class="rom-stat" data-testid="rom-stat">
          {(rom.length / 1024).toFixed(0)} KiB
          {cost === null
            ? ""
            : ` · ${cost} frame${cost === 1 ? "" : "s"} per tick (${Math.round(FRAME_RATE / cost)} Hz)`}
        </span>
      </div>
      {sound && !playing ? (
        <p class="hint" data-testid="rom-sound-blocked">
          Your browser has not started audio yet. Click the screen, or check that this tab is
          allowed to play sound.
        </p>
      ) : null}
    </div>
  );
}
