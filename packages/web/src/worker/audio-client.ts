/**
 * Typed client for the audio worker.
 *
 * The same hand-rolled promise-per-request RPC `client.ts` uses, and hand-rolled
 * for the same reason: the dependency budget belongs to the parts of the page a
 * user can see (doc 07 §Quality bar). Kept separate from the image client so the
 * art demaker never constructs — or downloads — the audio worker.
 */

import { EngineError } from "./client.js";
import type {
  ArrangeOptionsUi,
  ArrangePayload,
  AudioArtifact,
  AudioConsoleInfo,
  AudioWorkerRequest,
  AudioWorkerResponse,
  PcmPayload,
  SfxOptionsUi,
  SfxPayload,
} from "./audio-protocol.js";

type RequestBody = AudioWorkerRequest extends infer T
  ? T extends { kind: string }
    ? Omit<T, "id">
    : never
  : never;

type ReplyFor<K extends AudioWorkerRequest["kind"]> = Extract<
  AudioWorkerResponse,
  { ok: true; kind: K }
>;

interface Pending {
  resolve: (value: AudioWorkerResponse) => void;
  reject: (err: Error) => void;
}

export class AudioEngineClient {
  readonly #worker: Worker;
  readonly #pending = new Map<number, Pending>();
  #nextId = 1;

  constructor(worker: Worker) {
    this.#worker = worker;
    this.#worker.addEventListener("message", (event: MessageEvent<AudioWorkerResponse>) => {
      const message = event.data;
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.ok) pending.resolve(message);
      else pending.reject(new EngineError(message.code, message.message, message.hint));
    });
  }

  #send<K extends AudioWorkerRequest["kind"]>(
    request: Extract<RequestBody, { kind: K }>,
    transfer: Transferable[] = [],
  ): Promise<ReplyFor<K>> {
    const id = this.#nextId++;
    return new Promise<ReplyFor<K>>((resolve, reject) => {
      this.#pending.set(id, { resolve: (value) => resolve(value as ReplyFor<K>), reject });
      this.#worker.postMessage({ ...request, id } as AudioWorkerRequest, transfer);
    });
  }

  async consoles(): Promise<AudioConsoleInfo[]> {
    return (await this.#send({ kind: "consoles" })).consoles;
  }

  async arrange(
    source: Uint8Array,
    options: ArrangeOptionsUi,
    previewRate: number,
  ): Promise<ArrangePayload> {
    // Copy: the source stays owned by the page, which re-converts on any change.
    const buffer = source.slice().buffer;
    return (await this.#send({ kind: "arrange", source: buffer, options, previewRate }, [buffer]))
      .result;
  }

  async sfx(source: Uint8Array, options: SfxOptionsUi, previewRate: number): Promise<SfxPayload> {
    const buffer = source.slice().buffer;
    return (await this.#send({ kind: "sfx", source: buffer, options, previewRate }, [buffer]))
      .result;
  }

  /** Re-render a held schedule at a rate the audio device chose for us. */
  async preview(token: number, sampleRate: number): Promise<PcmPayload> {
    return (await this.#send({ kind: "preview", token, sampleRate })).pcm;
  }

  async artifact(
    token: number,
    what: "wav" | "flac" | "manifest" | "rom",
    stem: string,
    title: string,
    render: { sampleRate?: number; outputStage?: "board"; loops?: number } = {},
  ): Promise<AudioArtifact> {
    return (await this.#send({ kind: "artifact", token, what, stem, title, render })).artifact;
  }
}

/** Spin up the audio worker (module worker, bundled by Vite). */
export function createAudioEngine(): AudioEngineClient {
  const worker = new Worker(new URL("./audio.worker.ts", import.meta.url), { type: "module" });
  return new AudioEngineClient(worker);
}
