/**
 * Playing a running cartridge's APU (doc 07 §The audio sections).
 *
 * **Web Audio is a playback device here, never a synthesizer.** Every sample
 * comes out of `@demake/chip`'s model of the console's own sound hardware —
 * whichever cartridge is running, and in every case the same model the audio
 * pipeline renders WAVs with and the same one the conformance suite diffs
 * register writes against —
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
 * One sound chip, as the player needs it.
 *
 * Two things of a core — somewhere to put a sink, and the rate the chip is
 * clocked at — so that is what is asked for. No core learns about the page, and
 * the page does not learn which core it is holding.
 */
export interface Listenable {
  audioSink: SampleSink | undefined;
  /** The chip itself, for its master clock: 4.19 MHz on a Game Boy, 1.79 on an NES. */
  readonly apu: { readonly clockHz: number };
  /**
   * How loud this chip is against the others, where a console has more than one.
   *
   * A fact about the *board* rather than about the chip, which is why it arrives
   * with the machine rather than being asked of the model — the same reason
   * `render()` takes its per-chip gains from the binding (doc 16 §Packages).
   */
  readonly gain?: number;
}

/**
 * A machine whose sound can be listened to, whichever console it is.
 *
 * An array because one console has *two* chips: a Mega Drive's YM2612 and
 * SN76489 run in different clock domains — the master clock over seven and over
 * fifteen — so each needs its own sink, and mixing them is this file's job on
 * exactly the terms `render()` mixes the two halves of a schedule. Every other
 * console hands over a list of one.
 */
export type ListenableMachine = readonly Listenable[];

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
  /** One chip's samples, read out and then added into the mix. */
  private readonly scratchLeft: Float32Array;
  private readonly scratchRight: Float32Array;
  /** The sum handed to the device, which for a one-chip console is a copy. */
  private readonly mixLeft: Float32Array;
  private readonly mixRight: Float32Array;
  /** Where the next buffer starts, on the context's clock. */
  private cursor = 0;
  /**
   * Buffers handed to the device that have not finished playing.
   *
   * Scheduling runs a tenth of a second ahead, so at any moment there is audio
   * queued that the listener has not heard yet. When the stream is re-pointed —
   * a rebuilt cartridge, a different console, a Restart — that queue is the *old*
   * machine's, and nothing else can stop it: the sink is replaced and the cursor
   * reset, but a started `AudioBufferSourceNode` plays regardless of what
   * produced it. The result is the last cartridge's music over the new one's for
   * a fraction of a second, at whatever moment the page happened to rebuild —
   * which is what a stray tone at an unaccountable time sounds like.
   */
  private queued = new Set<AudioBufferSourceNode>();

  /**
   * One sink per chip, in the order the machine handed them over.
   *
   * Plural because a console may have two chips on different clocks, and a sink
   * is built *against* a clock. What the device receives is their sum.
   */
  sinks: { sink: StreamSink; gain: number }[] = [];

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
    this.sinks = [{ sink: this.newSink(GB_CLOCK_HZ), gain: 1 }];
    this.scratchLeft = new Float32Array(this.context.sampleRate);
    this.scratchRight = new Float32Array(this.context.sampleRate);
    this.mixLeft = new Float32Array(this.context.sampleRate);
    this.mixRight = new Float32Array(this.context.sampleRate);
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
   * Point a machine's chips at this stream. Call again when the ROM changes.
   *
   * Sinks are rebuilt rather than reused because each is built *against a
   * chip's clock*, and no two consoles share one — a Game Boy sink fed an NES's
   * clocks would play the game at forty-three percent speed. A console with two
   * chips gets two, for the same reason one console cannot use one: its own two
   * clocks differ.
   */
  attach(machine: ListenableMachine): void {
    this.silence();
    this.sinks = machine.map((chip) => {
      const sink = this.newSink(chip.apu.clockHz);
      chip.audioSink = sink;
      return { sink, gain: chip.gain ?? 1 };
    });
    this.cursor = 0;
  }

  /**
   * Drop whatever is still queued for the device.
   *
   * `stop()` on a source that has already finished is legal and does nothing, so
   * the set is simply emptied — the nodes remove themselves from it as they end,
   * and this is the path for the ones that have not.
   */
  private silence(): void {
    for (const source of this.queued) source.stop();
    this.queued.clear();
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
    this.silence();
    for (const { sink } of this.sinks) sink.clear();
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
    // The *least* ready chip decides: handing the device a buffer as long as the
    // fastest one has produced would mean padding the other with silence, which
    // is a click at the seam of every flush.
    return Math.max(0, Math.ceil(wanted) - this.available());
  }

  /** Whether the device is far enough ahead that the emulator should pause. */
  get satisfied(): boolean {
    return this.lead() >= MAX_LEAD;
  }

  /** Samples every chip has ready, which is what the slowest of them has. */
  private available(): number {
    let least = Number.POSITIVE_INFINITY;
    for (const { sink } of this.sinks) least = Math.min(least, sink.available);
    return least === Number.POSITIVE_INFINITY ? 0 : least;
  }

  /**
   * Hand everything the chips have produced to the device, in one buffer.
   *
   * Summing rather than mixing in the graph: a `GainNode` per chip would be a
   * second implementation of the output stage arriving through the back door,
   * and doc 07 is explicit that nothing but an `AudioBufferSourceNode` is ever
   * constructed. One console reaches the loop below twice; every other reaches
   * it once and the sum is a copy.
   */
  flush(): void {
    if (this.context.state !== "running") return;
    const count = Math.min(this.available(), this.mixLeft.length);
    if (count === 0) return;
    this.mixLeft.fill(0, 0, count);
    this.mixRight.fill(0, 0, count);
    for (const { sink, gain } of this.sinks) {
      sink.read(this.scratchLeft, this.scratchRight, count);
      for (let i = 0; i < count; i += 1) {
        this.mixLeft[i] = (this.mixLeft[i] as number) + (this.scratchLeft[i] as number) * gain;
        this.mixRight[i] = (this.mixRight[i] as number) + (this.scratchRight[i] as number) * gain;
      }
    }

    const buffer = this.context.createBuffer(2, count, this.context.sampleRate);
    buffer.getChannelData(0).set(this.mixLeft.subarray(0, count));
    buffer.getChannelData(1).set(this.mixRight.subarray(0, count));

    // A tab that was hidden, or a machine that could not keep up, leaves the
    // cursor in the past; scheduling there would play nothing at all. Starting
    // again just ahead of now is the honest recovery — a gap was heard, and
    // pretending otherwise would mean queueing audio that is already late.
    const now = this.context.currentTime;
    if (this.cursor < now) this.cursor = now + RESTART_LEAD;

    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.context.destination);
    source.onended = () => this.queued.delete(source);
    this.queued.add(source);
    source.start(this.cursor);
    this.cursor += count / this.context.sampleRate;
  }

  /** Stop playing and let the machine run silently again. */
  async suspend(machine: ListenableMachine | null): Promise<void> {
    for (const chip of machine ?? []) chip.audioSink = undefined;
    this.silence();
    for (const { sink } of this.sinks) sink.clear();
    this.cursor = 0;
    if (this.context.state === "running") await this.context.suspend();
  }

  close(): void {
    void this.context.close();
  }
}
