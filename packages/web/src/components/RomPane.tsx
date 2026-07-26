/**
 * The cartridge: the same game, running as a real ROM in the page.
 *
 * Doc 13 §D5 says the browser must never need a toolchain, and it does not: the
 * assemblers are ours and written in TypeScript, so the page *compiles* the game
 * — to SM83 for a Game Boy, to 6502 for an NES — the same way the CLI does and
 * gets the same bytes. What the Download button hands you is byte-identical to
 * what `demake build` writes on the command line, which is the doc-07 parity
 * contract restated for games.
 *
 * The emulators are `@demake/dmg` and `@demake/nes`, ours, for the reason doc 07
 * gives: a core fetched from a CDN is forbidden, and a WASM core we cannot read
 * would be the same bargain in a different wrapper. Which one runs is decided by
 * the console the game was compiled for, and *within* the Game Boy family by the
 * cartridge itself — a `gbc` build carries the CGB flag in its header and comes
 * up in colour — so the console selector above this pane changes the
 * **cartridge**, and the player follows it rather than being a setting of its own.
 *
 * **The frame counter under the screen is not decoration.** It is the measured
 * cost of one game tick on an 8-bit CPU, and reporting it is how the pane stays
 * honest about hardware speed rather than hiding behind a multiplier.
 */

import { useCallback, useEffect, useRef, useState } from "preact/hooks";

import {
  buildGame,
  familyFor,
  romExtension,
  romReady,
  unsupportedFor,
  type BuiltRom,
  type Program,
} from "@demake/demotic";
import { Gameboy, SCREEN_HEIGHT, SCREEN_WIDTH, type Button } from "@demake/dmg";
import { Nes, SCREEN_HEIGHT as NES_HEIGHT, SCREEN_WIDTH as NES_WIDTH } from "@demake/nes";

import { demoAssetBytes, demoAudioBytes } from "../lib/demo-game.js";
import { download } from "../lib/download.js";
import { audioSupported, RomAudio, type Listenable } from "../lib/rom-audio.js";

/**
 * The portable button set maps one for one onto both machines' pads.
 *
 * Which is what doc 14 §Buttons chose it for: the Game Boy has exactly these
 * seven, and the NES has them and a Select besides.
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
};

/**
 * The CPU the frames-per-tick figure is measured on, per family.
 *
 * Named rather than elided because the number means nothing without it: three
 * frames a tick is a different verdict on a 4 MHz SM83 than on a 1.8 MHz 6502.
 */
const CPU: Readonly<Record<string, string>> = { gb: "an SM83", nes: "a 6502" };

/**
 * A booted cartridge, whichever console it is for.
 *
 * The pane needs five things of a machine and no more, so this is those five —
 * and the two cores satisfy it without either learning about the page or about
 * each other. `chip` is the sound hardware the audio player attaches to, and
 * both consoles have one: the Game Boy's APU and the NES's 2A03, each
 * `@demake/chip`'s own model rather than a second copy living in a core.
 */
interface Player {
  readonly width: number;
  readonly height: number;
  readonly framebuffer: Uint8ClampedArray;
  readonly chip: Listenable;
  setButtons(down: Button[]): void;
  runFrame(): void;
  readMemory(address: number, length: number): Uint8Array;
}

/** Boot a cartridge in the core its console needs. */
function boot(rom: Uint8Array, consoleId: string): Player {
  if (familyFor(consoleId) === "nes") {
    const machine = new Nes(rom);
    return {
      width: NES_WIDTH,
      height: NES_HEIGHT,
      framebuffer: machine.framebuffer,
      chip: machine,
      setButtons: (down) => machine.setButtons(down),
      runFrame: () => void machine.runFrame(),
      readMemory: (address, length) => machine.readMemory(address, length),
    };
  }
  // A Mega Duck cartridge has no header, so nothing in the bytes says which
  // machine to boot it as — unlike the two Game Boys, whose CGB flag decides.
  const machine = new Gameboy(rom, consoleId === "megaduck" ? "megaduck" : "gameboy");
  return {
    width: SCREEN_WIDTH,
    height: SCREEN_HEIGHT,
    framebuffer: machine.framebuffer,
    chip: machine,
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

  // The build is deferred until after a paint rather than run inline, and that
  // is not cosmetic: demaking a *colour* backdrop is the whole `prep`
  // tournament, which is seconds of arithmetic the first time the page sees a
  // picture, and it is synchronous — nothing repaints while it runs. A tab that
  // simply stopped for those seconds would look broken, so the pane gets its
  // "demaking" badge *on screen* first and does the work after. Repeat builds
  // hit the conversion cache and are instant.
  const [built, setBuilt] = useState<{
    /**
     * The console this cartridge is for, and the extension it is named with.
     *
     * The pane keeps playing the ROM it has while the next one demakes, so for
     * those seconds the picker and the cartridge disagree — and everything on
     * screen describes the *cartridge*. Without this the Download button would
     * offer `.nes` and hand you a Game Boy.
     */
    consoleId?: string;
    extension?: string;
    rom?: Uint8Array;
    layout?: BuiltRom["layout"];
    error?: string;
  }>({});
  const [demaking, setDemaking] = useState(false);

  useEffect(() => {
    // Both early exits clear the flag as well as the cartridge: a build that is
    // never going to start must not leave the pane saying it is demaking, which
    // is how "fix the errors above" came to be unreachable once the badge could
    // outlive its effect.
    if (!program || !audio) {
      setBuilt({});
      setDemaking(false);
      return;
    }
    const target = program.profile.id;
    const named = romExtension(program);
    const missing = unsupportedFor(program);
    if (missing.length > 0) {
      setBuilt({
        consoleId: target,
        extension: named,
        error:
          `This game needs ${missing.join(" and ")}. The preview above plays it correctly; ` +
          `a ROM would play something else, so the build refuses rather than pretend.`,
      });
      setDemaking(false);
      return;
    }
    let live = true;
    let timer = 0;
    setDemaking(true);
    // `requestAnimationFrame` then `setTimeout`, and the order is the point: a
    // rAF callback runs *before* the frame is painted, so scheduling the work
    // inside it is scheduling it after the badge is actually on screen. A bare
    // `setTimeout(0)` is a macrotask that can beat the paint, which on a slow
    // colour build means the tab freezes for several seconds having shown
    // nothing — the exact failure the deferral exists to avoid.
    const frame = requestAnimationFrame(() => {
      timer = setTimeout(() => {
        if (!live) return;
        try {
          // The bundled art goes in as *source bytes*: the conversion happens
          // inside the build, so the page and the CLI cannot diverge on it.
          const assets = demoAssetBytes();
          for (const [file, bytes] of audio) assets.set(file, bytes);
          const result = buildGame(program, { title: name, assets });
          setBuilt({
            consoleId: target,
            extension: named,
            rom: result.bytes,
            layout: result.layout,
          });
        } catch (error) {
          setBuilt({
            consoleId: target,
            extension: named,
            error: String((error as Error).message ?? error),
          });
        }
        setDemaking(false);
      }, 0) as unknown as number;
    });
    return () => {
      live = false;
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [program, name, audio]);

  const { rom, layout } = built;
  // The cartridge's console, not the picker's: they differ for as long as a build
  // takes, and everything below describes what is on screen. A colour build is a
  // different cartridge rather than a setting on this one, and so is an NES one.
  const consoleId = built.consoleId ?? program?.profile.id ?? "gb";
  const family = familyFor(consoleId) ?? "gb";
  const extension = built.extension ?? "gb";
  // Both consoles have a driver now, so the only thing that can withhold the
  // button is the browser.
  const canSound = audioSupported();
  // The canvas is sized by the console, not by CSS: these are two genuinely
  // different screens (160×144 against 256×240, and not the same aspect), and a
  // buffer put into a canvas of the wrong size is silently cropped.
  const screen =
    family === "nes"
      ? { width: NES_WIDTH, height: NES_HEIGHT }
      : { width: SCREEN_WIDTH, height: SCREEN_HEIGHT };

  useEffect(() => {
    if (!rom || !layout) {
      machine.current = null;
      return;
    }
    const booted = boot(rom, consoleId);
    machine.current = booted;
    player.current?.attach(booted.chip);
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
  }, [rom, layout, consoleId, held, latched, restarts]);

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
      void audio.suspend(machine.current?.chip ?? null).then(() => setPlaying(audio.active));
      return;
    }
    // The click *is* the gesture a browser wants before it will start a
    // context, which is the whole reason this is a button and not a default.
    setSound(true);
    void audio
      .resume()
      .then(() => {
        if (machine.current) audio.attach(machine.current.chip);
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
      <p class="hint">
        A real cartridge, compiled in the page and byte-identical to <code>demake build</code>
        &rsquo;s. Your game is machine code here, not a table an interpreter walks: it runs at
        hardware speed, and the frames-per-tick figure is the measured cost on{" "}
        {CPU[family] ?? "this console’s CPU"}.
        {sound
          ? " The sound is the cartridge's own chip, rendered by the same model the CLI writes WAVs with — the page synthesizes nothing."
          : ""}
      </p>
      {sound && !playing ? (
        <p class="hint" data-testid="rom-sound-blocked">
          Your browser has not started audio yet. Click the screen, or check that this tab is
          allowed to play sound.
        </p>
      ) : null}
    </div>
  );
}
