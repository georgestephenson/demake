/**
 * The mono WonderSwan's sound: the colour machine's whole sound path, on a
 * quarter of the memory.
 *
 * The battery is `_audio-battery.ts`; this file names the machine. What a pass
 * here settles that `audio-wsc.test.ts` cannot is not the driver — it is the
 * same driver, on the same chip, through the same binding — but **where the
 * waveforms live**. A channel plays sixty-four bytes of the console's own RAM
 * at the address port `$8F` names, and this machine's RAM is sixteen kilobytes
 * with its tile bank in the top half: the roomy gap the colour machine keeps
 * that page in is *tiles* over here. `WS_WAVE_BASE` therefore sits inside the
 * interrupt vectors, which neither cartridge uses because neither takes an
 * interrupt — and a build that put it anywhere else would produce a game whose
 * bass plays a corner of its own title screen.
 */

import { audioBattery, audioSweep, target } from "./_audio-battery.js";

const ws = target("ws");

audioBattery(ws);
audioSweep(ws);
