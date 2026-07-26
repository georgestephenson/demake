/**
 * Playing a running cartridge's APU (doc 07 §The audio sections).
 *
 * **Web Audio is a playback device here, never a synthesizer.** Every sample
 * comes out of `@demake/chip`'s model of the console's own sound hardware — the
 * Game Boy's APU or the NES's 2A03, whichever cartridge is running, and in both
 * cases the same model the audio pipeline renders WAVs with and the same one the
 * conformance suite diffs register writes against —
 * box-integrated and DC-blocked by `@demake/chip`'s `StreamSink`,
 * which `packages/chip/test/stream.test.ts` pins as bit-identical to the offline
 * renderer. Nothing in this file computes a sample. Nothing else goes in the
 * graph either: a buffer source connected straight to the destination, no gain
 * node, no filter, no worklet.
 *
 * The one thing it *does* decide is when the emulator has to run. Audio has no
 * tolerance for a late buffer, so the emulator is driven by audio demand rather
 * than by the frame clock: {@link demand} says how many samples are still needed
 * to keep a small lead scheduled, the caller runs frames until the chip has
 * produced them, and {@link flush} hands whatever exists to the device. That
 * makes the audio device's own clock the one the emulation follows, which is the
 * only arrangement in which a browser tab does not drift into a click every few
 * minutes.
 */

import { GB_CLOCK_HZ, StreamSink, type SampleSink } from "@demake/chip";

/**
 * A machine whose chip can be listened to, whichever console it is.
 *
 * The player needs exactly two things of a core — somewhere to put a sink, and
 * the rate its chip is clocked at — so that is what it asks for. Neither
 * `@demake/dmg` nor `@demake/nes` learns about the page, and the page does not
 * learn which of them it is holding.
 */
export interface Listenable {
  audioSink: SampleSink | undefined;
  /** The chip itself, for its master clock: 4.19 MHz on a Game Boy, 1.79 on an NES. */
  readonly apu: { readonly clockHz: number };
}

/** The rate the page asks for; doc 07 §The audio sections says why explicitly. */
const WANTED_RATE = 48000;

/** Audio kept scheduled ahead of the device. Enough to survive a slow frame. */
const TARGET_LEAD = 0.1;

/** Past this the emulator is running ahead of the device and should wait. */
const MAX_LEAD = 0.2;

/** A resumed or recovered stream starts this far ahead of "now". */
const RESTART_LEAD = 0.02;

/** Whether this browser can play a cartridge at all. */
export function audioSupported(): boolean {
  return typeof globalThis.AudioContext === "function";
}

/** An `AudioContext` at 48 kHz, or at whatever the browser would give instead. */
function openContext(): AudioContext {
  try {
    return new AudioContext({ sampleRate: WANTED_RATE });
  } catch {
    return new AudioContext();
  }
}

export class RomAudio {
  private readonly context: AudioContext;
  private readonly scratchLeft: Float32Array;
  private readonly scratchRight: Float32Array;
  /** Where the next buffer starts, on the context's clock. */
  private cursor = 0;

  sink: StreamSink;

  constructor() {
    // An explicit rate, because a buffer whose rate differs from the context's
    // is resampled *by the browser*, differently per engine (doc 07). A browser
    // is allowed to refuse the rate, and one of them refuses by throwing rather
    // than by giving a different one — so both answers are taken, and the chip
    // is rendered at whatever rate the context ended up with. Nothing is
    // resampled either way.
    this.context = openContext();
    // Until a cartridge is attached there is no chip and therefore no clock; the
    // Game Boy's stands in and is replaced the moment one boots.
    this.sink = this.newSink(GB_CLOCK_HZ);
    this.scratchLeft = new Float32Array(this.context.sampleRate);
    this.scratchRight = new Float32Array(this.context.sampleRate);
  }

  /** The rate the chip is being rendered at — 48 kHz unless the browser refused. */
  get sampleRate(): number {
    return this.context.sampleRate;
  }

  /**
   * Whether the device is actually playing.
   *
   * A suspended context — one the browser has not let start yet — produces no
   * demand at all, so a caller that drove the emulator from {@link demand}
   * alone would stop the game dead. It has to ask.
   */
  get active(): boolean {
    return this.context.state === "running";
  }

  private newSink(clockHz: number): StreamSink {
    return new StreamSink(clockHz, { sampleRate: this.context.sampleRate });
  }

  /**
   * Point a machine's chip at this stream. Call again when the ROM changes.
   *
   * The sink is rebuilt rather than reused because it is built *against the
   * chip's clock*, and the two consoles do not share one — a Game Boy sink
   * fed an NES's clocks would play the game at forty-three percent speed.
   */
  attach(machine: Listenable): void {
    this.sink = this.newSink(machine.apu.clockHz);
    machine.audioSink = this.sink;
    this.cursor = 0;
  }

  /**
   * Be told when the device starts or stops.
   *
   * `resume()` resolving is not the same as the context running: a browser may
   * hold it suspended and start it later, or refuse it entirely, and Firefox
   * routinely resolves the promise before the state has flipped. So the page
   * asks rather than assuming, and corrects itself when the answer changes.
   */
  watch(listener: () => void): void {
    this.context.onstatechange = listener;
  }

  /** Start (or restart) playback; a browser needs a user gesture for the first. */
  async resume(): Promise<void> {
    await this.context.resume();
    this.sink.clear();
    this.cursor = 0;
  }

  /** Seconds of audio scheduled beyond the present moment. */
  private lead(): number {
    return Math.max(0, this.cursor - this.context.currentTime);
  }

  /**
   * Samples the emulator still has to produce to keep the lead topped up.
   *
   * Zero means the device has enough and the caller should let the frame clock
   * take over — running further would be running the game faster than it plays.
   */
  demand(): number {
    if (this.context.state !== "running") return 0;
    const wanted = (TARGET_LEAD - this.lead()) * this.context.sampleRate;
    return Math.max(0, Math.ceil(wanted) - this.sink.available);
  }

  /** Whether the device is far enough ahead that the emulator should pause. */
  get satisfied(): boolean {
    return this.lead() >= MAX_LEAD;
  }

  /** Hand everything the chip has produced to the device, in one buffer. */
  flush(): void {
    if (this.context.state !== "running") return;
    const count = Math.min(this.sink.available, this.scratchLeft.length);
    if (count === 0) return;
    this.sink.read(this.scratchLeft, this.scratchRight, count);

    const buffer = this.context.createBuffer(2, count, this.context.sampleRate);
    buffer.getChannelData(0).set(this.scratchLeft.subarray(0, count));
    buffer.getChannelData(1).set(this.scratchRight.subarray(0, count));

    // A tab that was hidden, or a machine that could not keep up, leaves the
    // cursor in the past; scheduling there would play nothing at all. Starting
    // again just ahead of now is the honest recovery — a gap was heard, and
    // pretending otherwise would mean queueing audio that is already late.
    const now = this.context.currentTime;
    if (this.cursor < now) this.cursor = now + RESTART_LEAD;

    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.context.destination);
    source.start(this.cursor);
    this.cursor += count / this.context.sampleRate;
  }

  /** Stop playing and let the machine run silently again. */
  async suspend(machine: Listenable | null): Promise<void> {
    if (machine) machine.audioSink = undefined;
    this.sink.clear();
    this.cursor = 0;
    if (this.context.state === "running") await this.context.suspend();
  }

  close(): void {
    void this.context.close();
  }
}
