/**
 * The cartridge: the same game, running as a real Game Boy ROM in the page.
 *
 * Doc 13 §D5 says the browser must never need a toolchain, and it does not: the
 * assembler is ours and written in TypeScript, so the page *compiles* the game
 * to SM83 machine code the same way the CLI does and gets the same bytes. What
 * the Download button hands you is byte-identical to what `demake build` writes
 * on the command line, which is the doc-07 parity contract restated for games.
 *
 * The emulator is `@demake/dmg`, ours, for the reason doc 07 gives: a core
 * fetched from a CDN is forbidden, and a WASM core we cannot read would be the
 * same bargain in a different wrapper. Which machine it runs as is the
 * cartridge's own decision — a `gbc` build carries the CGB flag in its header
 * and comes up in colour, a `gb` build on the green LCD — so the console
 * selector above this pane changes the *cartridge*, never the player.
 *
 * **The frame counter under the screen is not decoration.** It is the measured
 * cost of one game tick on a 4 MHz 8-bit CPU, and reporting it is how the pane
 * stays honest about hardware speed rather than hiding behind a multiplier.
 */

import { useCallback, useEffect, useRef, useState } from "preact/hooks";

import { buildGbRom, romReady, unsupportedFeatures, type Program } from "@demake/demotic";
import { Gameboy, SCREEN_HEIGHT, SCREEN_WIDTH, type Button } from "@demake/dmg";

import { demoAssetBytes, demoAudioBytes } from "../lib/demo-game.js";
import { download } from "../lib/download.js";
import { audioSupported, RomAudio } from "../lib/rom-audio.js";

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
  const machine = useRef<Gameboy | null>(null);
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

  // The build is deferred by a frame rather than run inline, and that is not
  // cosmetic: demaking a *colour* backdrop is the whole `prep` tournament, which
  // is seconds of arithmetic the first time the page sees a picture. A tab that
  // simply stopped for those seconds would look broken, so the pane paints
  // "demaking" first and does the work after. Repeat builds — every keystroke in
  // the editor — hit the conversion cache and are instant.
  const [built, setBuilt] = useState<{
    rom?: Uint8Array;
    layout?: ReturnType<typeof buildGbRom>["layout"];
    error?: string;
  }>({});
  const [demaking, setDemaking] = useState(false);

  useEffect(() => {
    if (!program || !audio) {
      setBuilt({});
      return;
    }
    const missing = unsupportedFeatures(program);
    if (missing.length > 0) {
      setBuilt({
        error:
          `This game needs ${missing.join(" and ")}. The preview above plays it correctly; ` +
          `a ROM would play something else, so the build refuses rather than pretend.`,
      });
      return;
    }
    let live = true;
    setDemaking(true);
    const timer = setTimeout(() => {
      if (!live) return;
      try {
        // The bundled art goes in as *source bytes*: the conversion happens
        // inside the build, so the page and the CLI cannot diverge on it.
        const assets = demoAssetBytes();
        for (const [file, bytes] of audio) assets.set(file, bytes);
        const result = buildGbRom(program, { title: name, assets });
        setBuilt({ rom: result.bytes, layout: result.layout });
      } catch (error) {
        setBuilt({ error: String((error as Error).message ?? error) });
      }
      setDemaking(false);
    }, 0);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [program, name, audio]);

  const { rom, layout } = built;
  // A colour build is a different cartridge, not a setting on this one: the
  // extension follows the console the game was compiled for, exactly as
  // `demake build` names its output.
  const extension = program?.profile.id === "gbc" ? "gbc" : "gb";

  useEffect(() => {
    if (!rom || !layout) {
      machine.current = null;
      return;
    }
    machine.current = new Gameboy(rom);
    player.current?.attach(machine.current);
    const element = canvas.current;
    const context = element?.getContext("2d");
    if (!context) return;

    let raf = 0;
    let last = performance.now();
    let accumulator = 0;
    let sinceTick = 0;
    let lastTick = 0;
    const image = context.createImageData(SCREEN_WIDTH, SCREEN_HEIGHT);

    /** One Game Boy frame, with the pad and the tick bookkeeping around it. */
    const runFrame = (gameboy: Gameboy) => {
      const down: Button[] = [];
      for (const action of held.current) if (BUTTONS[action]) down.push(BUTTONS[action]);
      for (const action of latched.current) if (BUTTONS[action]) down.push(BUTTONS[action]);
      gameboy.setButtons(down);
      gameboy.runFrame();
      sinceTick += 1;
      const tick = romReady(layout, (address, length) => gameboy.readMemory(address, length));
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
      const gameboy = machine.current;
      if (!gameboy) return;
      const audio = player.current?.active === true ? player.current : null;

      if (audio) {
        // Audio has no tolerance for a late buffer, so with sound on the device
        // is the clock: run until the chip has produced what the player still
        // needs. The wall clock is reset alongside it, or turning sound off
        // would leave a backlog to sprint through.
        let budget = 8;
        while (budget-- > 0 && audio.demand() > 0) runFrame(gameboy);
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
          runFrame(gameboy);
          accumulator -= step;
        }
      }

      image.data.set(gameboy.framebuffer);
      context.putImageData(image, 0, 0);
    };

    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [rom, layout, held, latched, restarts]);

  // The context outlives every ROM built in the section, and is closed once.
  useEffect(() => () => player.current?.close(), []);

  const toggleSound = useCallback(() => {
    if (!audioSupported()) return;
    let audio = player.current;
    if (!audio) {
      audio = new RomAudio();
      player.current = audio;
      const created = audio;
      created.watch(() => setPlaying(created.active));
    }
    if (sound) {
      setSound(false);
      void audio.suspend(machine.current).then(() => setPlaying(audio.active));
      return;
    }
    // The click *is* the gesture a browser wants before it will start a
    // context, which is the whole reason this is a button and not a default.
    setSound(true);
    void audio
      .resume()
      .then(() => {
        if (machine.current) audio.attach(machine.current);
        setPlaying(audio.active);
      })
      .catch(() => setPlaying(false));
  }, [sound]);

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
          width={SCREEN_WIDTH}
          height={SCREEN_HEIGHT}
          role="img"
          aria-label={
            extension === "gbc"
              ? "The game, running as a Game Boy Color ROM"
              : "The game, running as a Game Boy ROM"
          }
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
          disabled={!audioSupported()}
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
        A real 32 KiB cartridge, compiled in the page and byte-identical to{" "}
        <code>demake build</code>
        &rsquo;s. Your game is machine code here, not a table an interpreter walks: it runs at
        hardware speed, and the frames-per-tick figure is the measured cost on an SM83.
        {sound
          ? " The sound is the cartridge's own APU, rendered by the same chip model the CLI writes WAVs with — the page synthesizes nothing."
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
