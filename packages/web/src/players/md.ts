/** The Mega Drive's player — the one console here with two sound chips. */

import { FRAME_HEIGHT, FRAME_WIDTH, Md, PSG_MIX_GAIN, type Button as MdButton } from "@demake/md";

import type { Player } from "./player.js";

export function boot(rom: Uint8Array): Player {
  const machine = new Md(rom);
  return {
    width: FRAME_WIDTH,
    height: FRAME_HEIGHT,
    framebuffer: machine.framebuffer,
    // Six four-operator FM voices and four tone generators, handed over
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
        gain: PSG_MIX_GAIN,
      },
    ],
    setButtons: (down) => machine.setButtons(down as readonly MdButton[]),
    // This VDP draws when it is *asked* to, not as the beam passes: `view()`
    // renders the whole picture out of video RAM and into the buffer handed over
    // above. So a frame has to end with one, exactly as the Game Gear's crop
    // does — without it the canvas keeps showing the blank frame boot rendered,
    // which is a console that plays perfectly and displays nothing.
    runFrame: () => {
      machine.runFrame();
      machine.vdp.view();
    },
    readMemory: (address, length) => machine.readMemory(address, length),
  };
}
