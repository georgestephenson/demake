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
 *
 * It is both WonderSwans, and which one is the *caller's* rather than the
 * cartridge's: these two machines differ in how much memory they have and how
 * deep a pixel is, neither of which a header records, so the console the visitor
 * picked is the only thing that knows (`@demake/wsc` §`WsModel`).
 */

import { SCREEN_HEIGHT, SCREEN_WIDTH, Wsc, type Button as WscButton } from "@demake/wsc";

import type { Player } from "./player.js";

export function boot(rom: Uint8Array, consoleId = "wsc"): Player {
  const machine = new Wsc(rom, consoleId === "ws" ? "ws" : "wsc");
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
