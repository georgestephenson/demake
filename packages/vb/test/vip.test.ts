/**
 * The video processor — and the depth axis, which is the thing about this
 * console no other one in this project has.
 *
 * Four of the cases here can only be written for a Virtual Boy:
 *
 *   - A world is drawn **twice**, and the two copies are pulled apart by the
 *     parallax the world itself declares.
 *   - Which way they are pulled decides whether a layer reads as *in front of*
 *     or *behind* the display plane, and {@link VB_NEARER} is that sign. This is
 *     the one property in the package that a wrong-and-consistent pair of
 *     definitions would hide, so it is asserted about the *pixels* rather than
 *     about the constant.
 *   - An object carries its own parallax, so a sprite can be nearer than the
 *     scenery it is drawn over without the scenery moving at all.
 *   - Pixel value 0 is transparent on both layers and shows `BKCOL`, which is
 *     the NES's shared backdrop reached by different hardware.
 *
 * The rest is what a picture needs to arrive at all: the character mirror, the
 * palette reversal, and the end of the display list.
 */

import { describe, expect, it } from "vitest";

import {
  getConsole,
  packPacked2Le,
  VB_BGMAP,
  VB_BKCOL,
  VB_BRTA,
  VB_CHR_MIRROR,
  VB_DPCTRL,
  VB_DPCTRL_ON,
  VB_GPLT0,
  VB_JPLT0,
  VB_OAM,
  VB_OBJ_JLON,
  VB_OBJ_JRON,
  VB_SCREEN_W,
  VB_SPT0,
  VB_SPT1,
  VB_SPT2,
  VB_SPT3,
  VB_WORLDS,
  VB_WORLD_BGM_OBJ,
  VB_WORLD_BYTES,
  VB_WORLD_END,
  VB_WORLD_LON,
  VB_WORLD_RON,
} from "@demake/core";

import { VB_NEARER, VB_SHADES, Vip, vbShade, type Eye } from "../src/vip.js";

/** A scene, built the way a cartridge builds one. */
function scene(): Vip {
  const vip = new Vip();
  // One character, every pixel value 1 — packed by the same function the
  // codegen family uses, so the two cannot disagree about pixel order.
  const grid = new Uint8Array(64).fill(1);
  const bytes = packPacked2Le(grid, 8, 8);
  for (let index = 0; index < bytes.length; index += 1) {
    vip.write(VB_CHR_MIRROR + index, bytes[index] as number);
  }
  // Character 1 is a second block, every pixel value 2 — for the objects.
  const other = packPacked2Le(new Uint8Array(64).fill(2), 8, 8);
  for (let index = 0; index < other.length; index += 1) {
    vip.write(VB_CHR_MIRROR + 16 + index, other[index] as number);
  }
  // Pixel 1 shows the brightest shade, 2 the next; pixel 0 is transparent.
  vip.setReg(VB_GPLT0, (3 << 2) | (2 << 4) | (1 << 6));
  vip.setReg(VB_JPLT0, (3 << 2) | (2 << 4) | (1 << 6));
  vip.setReg(VB_BKCOL, 0);
  vip.setReg(VB_DPCTRL, VB_DPCTRL_ON);
  vip.setReg(VB_BRTA, 32);
  return vip;
}

/** Put a world entry in, as sixteen halfwords. */
function world(vip: Vip, index: number, fields: Record<number, number>): void {
  const base = VB_WORLDS + index * VB_WORLD_BYTES;
  for (let offset = 0; offset < VB_WORLD_BYTES; offset += 2) {
    const value = fields[offset] ?? 0;
    vip.write(base + offset, value & 0xff);
    vip.write(base + offset + 1, (value >> 8) & 0xff);
  }
}

/** Put one BGMap cell in. */
function cell(vip: Vip, map: number, index: number, entry: number): void {
  const at = VB_BGMAP + map * 0x2000 + index * 2;
  vip.write(at, entry & 0xff);
  vip.write(at + 1, (entry >> 8) & 0xff);
}

/** Where a run of non-zero shades begins on a row of one eye, or −1. */
function leftEdge(vip: Vip, eye: Eye, row: number): number {
  const shades = vip.shades(eye);
  for (let x = 0; x < VB_SCREEN_W; x += 1) {
    if ((shades[row * VB_SCREEN_W + x] as number) !== 0) return x;
  }
  return -1;
}

describe("the Virtual Boy's video processor", () => {
  it("draws one world into both eyes", () => {
    const vip = scene();
    cell(vip, 0, 0, 0);
    world(vip, 31, { 0: VB_WORLD_LON | VB_WORLD_RON, 2: 100, 6: 50, 14: 7, 16: 7 });
    world(vip, 30, { 0: VB_WORLD_END });
    vip.drawFrame();
    expect(leftEdge(vip, "left", 50)).toBe(100);
    expect(leftEdge(vip, "right", 50)).toBe(100);
    expect(vip.shades("left")[50 * VB_SCREEN_W + 100]).toBe(3);
  });

  it("pulls the two eyes apart by the parallax the world declares", () => {
    const vip = scene();
    cell(vip, 0, 0, 0);
    world(vip, 31, { 0: VB_WORLD_LON | VB_WORLD_RON, 2: 100, 4: 6, 6: 50, 14: 7, 16: 7 });
    world(vip, 30, { 0: VB_WORLD_END });
    vip.drawFrame();
    // Left at X − P, right at X + P. Twelve pixels of disparity from a parallax
    // of six, which is the hardware's arithmetic and not a convention.
    expect(leftEdge(vip, "left", 50)).toBe(94);
    expect(leftEdge(vip, "right", 50)).toBe(106);
  });

  it("puts a layer in front of the display plane when the parallax is VB_NEARER", () => {
    // The one property in this package that two wrong-but-agreeing definitions
    // would hide, so it is asserted about the pixels: for something *nearer*
    // than the screen the eyes have to converge, which means the left eye sees
    // it to the **right** of where the right eye does — crossed disparity.
    const vip = scene();
    cell(vip, 0, 0, 0);
    world(vip, 31, {
      0: VB_WORLD_LON | VB_WORLD_RON,
      2: 100,
      4: VB_NEARER * 6,
      6: 50,
      14: 7,
      16: 7,
    });
    world(vip, 30, { 0: VB_WORLD_END });
    vip.drawFrame();
    expect(leftEdge(vip, "left", 50)).toBeGreaterThan(leftEdge(vip, "right", 50));
  });

  it("shows BKCOL through a transparent pixel", () => {
    const vip = scene();
    vip.setReg(VB_BKCOL, 2);
    // Character 2 is untouched, so every one of its pixels is value 0.
    cell(vip, 0, 0, 2);
    world(vip, 31, { 0: VB_WORLD_LON | VB_WORLD_RON, 2: 0, 6: 0, 14: 7, 16: 7 });
    world(vip, 30, { 0: VB_WORLD_END });
    vip.drawFrame();
    // The backdrop is everywhere, including under the world.
    expect(vip.shades("left")[0]).toBe(2);
    expect(vip.shades("left")[100 * VB_SCREEN_W + 200]).toBe(2);
  });

  it("stops at the end of the display list", () => {
    const vip = scene();
    cell(vip, 0, 0, 0);
    // World 31 ends the list, so world 30 — which would paint the screen — is
    // never reached. A program that shipped no end marker would have the
    // hardware walk thirty-one worlds of whatever was in memory.
    world(vip, 31, { 0: VB_WORLD_END });
    world(vip, 30, { 0: VB_WORLD_LON | VB_WORLD_RON, 14: 63, 16: 63 });
    vip.drawFrame();
    expect(leftEdge(vip, "left", 4)).toBe(-1);
  });

  it("draws an object group, each object at its own depth", () => {
    const vip = scene();
    // One object world in the list, so it takes group 3 — and SPT2 wrapping to
    // 1023 is what makes that group start at object 0, which is the idiom this
    // console's own documentation uses.
    world(vip, 31, { 0: VB_WORLD_LON | VB_WORLD_RON | VB_WORLD_BGM_OBJ });
    world(vip, 30, { 0: VB_WORLD_END });
    vip.setReg(VB_SPT3, 0);
    vip.setReg(VB_SPT2, 1023);
    vip.setReg(VB_SPT1, 1023);
    vip.setReg(VB_SPT0, 1023);
    const put = (index: number, values: number[]): void => {
      for (let half = 0; half < 4; half += 1) {
        vip.write(VB_OAM + index * 8 + half * 2, (values[half] as number) & 0xff);
        vip.write(VB_OAM + index * 8 + half * 2 + 1, ((values[half] as number) >> 8) & 0xff);
      }
    };
    // At x 200, y 60, with a parallax that puts it in front of the scenery.
    put(0, [200, (VB_OBJ_JLON | VB_OBJ_JRON | ((VB_NEARER * 8) & 0x3fff)) & 0xffff, 60, 1]);
    vip.drawFrame();
    expect(leftEdge(vip, "left", 60)).toBe(208);
    expect(leftEdge(vip, "right", 60)).toBe(192);
    expect(vip.shades("left")[60 * VB_SCREEN_W + 208]).toBe(2);
  });

  it("hides an object whose eye bits are clear", () => {
    const vip = scene();
    world(vip, 31, { 0: VB_WORLD_LON | VB_WORLD_RON | VB_WORLD_BGM_OBJ });
    world(vip, 30, { 0: VB_WORLD_END });
    vip.setReg(VB_SPT3, 0);
    vip.setReg(VB_SPT2, 1023);
    for (let half = 0; half < 4; half += 1) vip.write(VB_OAM + half * 2, 0);
    vip.write(VB_OAM, 200);
    vip.write(VB_OAM + 6, 1);
    vip.drawFrame();
    expect(leftEdge(vip, "left", 0)).toBe(-1);
  });

  it("blanks the screen when the display is off or the LEDs are dark", () => {
    const vip = scene();
    cell(vip, 0, 0, 0);
    world(vip, 31, { 0: VB_WORLD_LON | VB_WORLD_RON, 14: 7, 16: 7 });
    world(vip, 30, { 0: VB_WORLD_END });
    vip.setReg(VB_BRTA, 0);
    vip.drawFrame();
    const rgba = vip.render("left");
    expect(rgba[0]).toBe(0);
    // The framebuffer still holds the picture; it is the display that is dark.
    expect(vip.shades("left")[0]).toBe(3);
  });

  it("reverses the console spec's ramp, because shade 0 is the LEDs being off", () => {
    // The spec puts the *lightest* colour at index 0, as every mono console in
    // this project does, and this display puts the darkest there. A copy of that
    // reversal anywhere else is a cartridge whose picture is a negative.
    const ramp = getConsole("vb")!.color.dac;
    expect(ramp?.kind).toBe("mono-ramp");
    const shades = ramp?.kind === "mono-ramp" ? ramp.shades : [];
    expect(shades.length).toBe(VB_SHADES.length);
    for (let index = 0; index < shades.length; index += 1) {
      expect(VB_SHADES[vbShade(index)]).toBe(shades[index]!.r);
    }
    expect(vbShade(0)).toBe(3);
    expect(vbShade(3)).toBe(0);
  });
});
