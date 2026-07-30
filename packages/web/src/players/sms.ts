/** The Sega 8-bits' player: a Master System and a Game Gear. */

import { Sms, type Button as SmsButton } from "@demake/sms";

import type { Player } from "./player.js";

export function boot(rom: Uint8Array): Player {
  // Which of the two machines it is comes out of the cartridge's own region
  // nibble, not from a console id — the same rule the Game Boy family runs
  // under, and the reason the selector changes the build rather than a setting.
  const machine = new Sms(rom);
  const view = machine.vdp.view();
  return {
    width: view.width,
    height: view.height,
    framebuffer: view.pixels,
    // The Sega's sound chip is a PSG, not an APU, so it is adapted rather than
    // renamed — the core keeps calling it what it is. What it plays is the
    // cartridge's own generated Z80 driver, through the same `StreamSink` the
    // other consoles use.
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
