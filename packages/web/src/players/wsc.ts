/**
 * The WonderSwan Color's player.
 *
 * Its sound hardware is four wavetable channels whose waveforms are in the
 * console's own RAM, so the chip this hands the pane is `@demake/chip`'s
 * `WsSound` reading the same sixty-four kilobytes the display does — and what it
 * plays is the cartridge's own generated V30MZ driver, through the same
 * `StreamSink` every other console uses.
 *
 * Its pad is a handheld's: two face buttons and a Start, and the four
 * directions are the upper of the two D-pads a landscape game uses.
 */

import { SCREEN_HEIGHT, SCREEN_WIDTH, Wsc, type Button as WscButton } from "@demake/wsc";

import type { Player } from "./player.js";

export function boot(rom: Uint8Array): Player {
  const machine = new Wsc(rom);
  return {
    width: SCREEN_WIDTH,
    height: SCREEN_HEIGHT,
    framebuffer: machine.framebuffer,
    chips: [
      {
        get audioSink() {
          return machine.audioSink;
        },
        set audioSink(sink) {
          machine.audioSink = sink;
        },
        apu: machine.sound,
      },
    ],
    setButtons: (down) => machine.setButtons(down as WscButton[]),
    runFrame: () => void machine.runFrame(),
    readMemory: (address, length) => machine.readMemory(address, length),
  };
}
