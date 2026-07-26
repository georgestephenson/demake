/**
 * Playing what the demakers rendered (doc 07 §The audio sections).
 *
 * **Web Audio is a playback device here, never a synthesizer.** Every sample
 * comes out of `@demake/chip`'s models through `@demake/audio`'s `render()` — the
 * same call the CLI writes WAVs with — and reaches this file as a finished
 * buffer. Nothing here computes a sample, and nothing but an
 * `AudioBufferSourceNode` is ever constructed: no oscillator, no filter, no
 * worklet, and not even a `GainNode`, since volume is applied inside the render
 * or not at all.
 *
 * The one thing that needs care is the rate. A buffer whose sample rate differs
 * from the context's is resampled *by the browser*, differently per engine, so
 * the context is asked for 48 kHz and the render is asked for whatever the
 * context actually gave — which is why {@link sampleRate} is public and the panes
 * say which rate they are playing at.
 */

/** Whether this browser can play anything at all. */
export function audioSupported(): boolean {
  return typeof globalThis.AudioContext === "function";
}

/** The rate the page asks for; doc 07 §The audio sections says why explicitly. */
const WANTED_RATE = 48000;

/** PCM as the worker delivers it. */
export interface PlayablePcm {
  sampleRate: number;
  channels: Float32Array<ArrayBuffer>[];
}

export class AudioPlayer {
  readonly #context: AudioContext;
  #source: AudioBufferSourceNode | null = null;

  constructor() {
    // A browser is allowed to refuse the rate, and one of them refuses by
    // throwing rather than by quietly giving a different one — so both answers
    // are taken and the render is fitted to whatever came back.
    let context: AudioContext;
    try {
      context = new AudioContext({ sampleRate: WANTED_RATE });
    } catch {
      context = new AudioContext();
    }
    this.#context = context;
  }

  /** The rate to render at — 48 kHz unless the browser refused it. */
  get sampleRate(): number {
    return this.#context.sampleRate;
  }

  /** Whether the device is really running, which is the browser's decision. */
  get active(): boolean {
    return this.#context.state === "running";
  }

  /** Be told when the device starts or stops; the page asks rather than assumes. */
  watch(listener: () => void): void {
    this.#context.onstatechange = listener;
  }

  /** Start the device. A browser needs a user gesture for the first call. */
  async resume(): Promise<void> {
    await this.#context.resume();
  }

  /**
   * Play a buffer, replacing whatever was playing.
   *
   * Returns the seconds it will take, so a pane can show progress without
   * polling the graph.
   */
  play(pcm: PlayablePcm, onEnded: () => void): number {
    this.stop();
    const frames = pcm.channels[0]?.length ?? 0;
    if (frames === 0) return 0;
    const buffer = this.#context.createBuffer(pcm.channels.length, frames, pcm.sampleRate);
    for (const [index, channel] of pcm.channels.entries()) buffer.copyToChannel(channel, index);

    const source = this.#context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.#context.destination);
    source.onended = () => {
      if (this.#source === source) this.#source = null;
      onEnded();
    };
    source.start();
    this.#source = source;
    return frames / pcm.sampleRate;
  }

  stop(): void {
    if (!this.#source) return;
    const source = this.#source;
    this.#source = null;
    source.onended = null;
    source.stop();
    source.disconnect();
  }

  close(): void {
    this.stop();
    void this.#context.close();
  }
}

/** Rebuild the worker's transferred buffers as the arrays playback wants. */
export function toPlayable(pcm: { sampleRate: number; channels: ArrayBuffer[] }): PlayablePcm {
  return {
    sampleRate: pcm.sampleRate,
    channels: pcm.channels.map((buffer) => new Float32Array(buffer)),
  };
}
