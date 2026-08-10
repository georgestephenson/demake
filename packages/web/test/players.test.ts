/**
 * The screen table is numbers, and this is what stops them drifting.
 *
 * `players/player.ts` carries each console's framebuffer size so the ROM pane
 * can size its canvas before the core has finished loading — importing eight
 * modules to learn eighteen numbers is exactly what `players/` exists to avoid.
 * That is only safe while the numbers are the cores' own, and nothing in the type
 * system checks it. This test imports all nine, which a test may and the page
 * may not.
 */

import { describe, expect, it } from "vitest";

import { SCREEN_HEIGHT as GB_H, SCREEN_WIDTH as GB_W } from "@demake/dmg";
import { FRAME_HEIGHT as GBA_H, FRAME_WIDTH as GBA_W } from "@demake/gba";
import { FRAME_HEIGHT as NDS_H, FRAME_WIDTH as NDS_W } from "@demake/nds";
import { FRAME_HEIGHT as MD_H, FRAME_WIDTH as MD_W } from "@demake/md";
import { SCREEN_HEIGHT as NES_H, SCREEN_WIDTH as NES_W } from "@demake/nes";
import { SCREEN_HEIGHT as NGP_H, SCREEN_WIDTH as NGP_W } from "@demake/ngp";
import { SCREEN_HEIGHT as PCE_H, SCREEN_WIDTH as PCE_W } from "@demake/pce";
import { FRAME_HEIGHT as SMS_H, FRAME_WIDTH as SMS_W, GG_HEIGHT, GG_WIDTH } from "@demake/sms";
import { SCREEN_HEIGHT as SNES_H, SCREEN_WIDTH as SNES_W } from "@demake/snes";
import { SCREEN_HEIGHT as VB_H, SCREEN_WIDTH as VB_W } from "@demake/vb";
import { SCREEN_HEIGHT as WSC_H, SCREEN_WIDTH as WSC_W } from "@demake/wsc";

import { screenFor, SCREENS } from "../src/players/player.js";

describe("the ROM pane's screen table", () => {
  it("carries each core's own framebuffer size", () => {
    expect(SCREENS["gb"]).toEqual({ width: GB_W, height: GB_H });
    expect(SCREENS["nes"]).toEqual({ width: NES_W, height: NES_H });
    expect(SCREENS["sms"]).toEqual({ width: SMS_W, height: SMS_H });
    expect(SCREENS["gg"]).toEqual({ width: GG_WIDTH, height: GG_HEIGHT });
    expect(SCREENS["snes"]).toEqual({ width: SNES_W, height: SNES_H });
    expect(SCREENS["md"]).toEqual({ width: MD_W, height: MD_H });
    expect(SCREENS["gba"]).toEqual({ width: GBA_W, height: GBA_H });
    expect(SCREENS["nds"]).toEqual({ width: NDS_W, height: NDS_H });
    expect(SCREENS["pce"]).toEqual({ width: PCE_W, height: PCE_H });
    expect(SCREENS["wsc"]).toEqual({ width: WSC_W, height: WSC_H });
    expect(SCREENS["ngpc"]).toEqual({ width: NGP_W, height: NGP_H });
    // One eye's, which is what this core reports and what the pane draws.
    expect(SCREENS["vb"]).toEqual({ width: VB_W, height: VB_H });
  });

  // A Game Gear renders the frame a Master System does and shows the middle of
  // it, so it is the one console whose id has to beat its family here.
  it("prefers a console over its family where the two differ", () => {
    expect(screenFor("sms", "gg")).toEqual({ width: GG_WIDTH, height: GG_HEIGHT });
    expect(screenFor("sms", "sms")).toEqual({ width: SMS_W, height: SMS_H });
    expect(screenFor("gb", "megaduck")).toEqual({ width: GB_W, height: GB_H });
  });
});
