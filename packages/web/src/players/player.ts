/**
 * What the ROM pane needs of a console, and nothing about which console it is.
 *
 * Eight cores live behind this — a Game Boy, an NES, a Sega 8-bit, a Super
 * Nintendo, a Mega Drive, a Game Boy Advance, a PC Engine and a WonderSwan
 * Color — and each is tens of kilobytes of processor and video hardware. The pane plays *one* of them, so they are reached through
 * `bootPlayer` and loaded on demand (see `index.ts`); this module is the part
 * that is safe to import eagerly, because it holds a type and a table of
 * numbers.
 */

import type { ListenableMachine } from "../lib/rom-audio.js";

/** The portable button set, as every core here spells it. */
export type PadButton = string;

/**
 * A booted cartridge, whatever it is running on.
 *
 * `chips` is a *list* because the sound hardware is not one thing across these
 * machines: a Game Boy has one APU, a Super Nintendo's is a second computer's
 * and is reached through the sound processor rather than the CPU, and a Mega
 * Drive has two chips on different clocks whose relative level is a fact about
 * the board. An empty list would say a cartridge has nothing to play rather
 * than offering a control that does nothing.
 */
export interface Player {
  readonly width: number;
  readonly height: number;
  readonly framebuffer: Uint8ClampedArray;
  readonly chips: ListenableMachine;
  setButtons(down: PadButton[]): void;
  runFrame(): void;
  readMemory(address: number, length: number): Uint8Array;
}

/**
 * Each console's framebuffer, in pixels.
 *
 * Here rather than read off the cores, because the pane has to size its canvas
 * *before* it knows whether the core has finished loading — and importing eight
 * modules to learn twenty numbers is the thing this directory exists to stop.
 * `players.test.ts` pins every entry against the core's own constant, so a
 * number that drifted would fail rather than crop a picture.
 *
 * Keyed by family, with the two consoles that differ from their family's default
 * spelled out: a Game Gear renders the same 256×192 frame a Master System does
 * and shows the middle 160×144 of it, and a Nintendo DS draws its family's
 * picture on a screen a third bigger.
 */
export const SCREENS: Readonly<Record<string, { width: number; height: number }>> = {
  gb: { width: 160, height: 144 },
  nes: { width: 256, height: 240 },
  sms: { width: 256, height: 192 },
  gg: { width: 160, height: 144 },
  snes: { width: 256, height: 224 },
  md: { width: 320, height: 224 },
  gba: { width: 240, height: 160 },
  nds: { width: 256, height: 192 },
  pce: { width: 256, height: 224 },
  wsc: { width: 224, height: 144 },
  ws: { width: 224, height: 144 },
};

/** The framebuffer a console draws into, by family and — where it differs — id. */
export function screenFor(family: string, consoleId: string): { width: number; height: number } {
  return (
    SCREENS[consoleId] ?? SCREENS[family] ?? (SCREENS["gb"] as { width: number; height: number })
  );
}
