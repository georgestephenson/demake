/**
 * Typed client for the engine worker (doc 07 §Stack).
 *
 * A promise-per-request RPC — small enough to hand-roll, and hand-rolling keeps
 * the dependency budget (doc 07 §Quality bar) for the parts of the page a user
 * can see. A request supersedes its predecessor of the same kind: while the user
 * drags a slider, only the newest conversion's result is delivered.
 */

import type {
  ConsoleInfo,
  GenArtifactPayload,
  PrepOptionsUi,
  PrepPayload,
  WorkerRequest,
  WorkerResponse,
} from "./protocol.js";
import type { StrategyInfo } from "@demake/core";

/** Error carrying the engine's own code + hint, so the UI can show both. */
export class EngineError extends Error {
  readonly code: string;
  readonly hint: string | undefined;
  constructor(code: string, message: string, hint?: string) {
    super(message);
    this.name = "EngineError";
    this.code = code;
    this.hint = hint;
  }
}

/** `Omit` that distributes over a union, so each variant keeps its discriminant. */
type RequestBody = WorkerRequest extends infer T
  ? T extends { kind: string }
    ? Omit<T, "id">
    : never
  : never;

/** The successful reply for a given request kind. */
type ReplyFor<K extends WorkerRequest["kind"]> = Extract<WorkerResponse, { ok: true; kind: K }>;

interface Pending {
  resolve: (value: WorkerResponse) => void;
  reject: (err: Error) => void;
  onProgress?: (stage: string, fraction: number) => void;
}

export class EngineClient {
  readonly #worker: Worker;
  readonly #pending = new Map<number, Pending>();
  #nextId = 1;

  constructor(worker: Worker) {
    this.#worker = worker;
    this.#worker.addEventListener("message", (event: MessageEvent<WorkerResponse>) => {
      const msg = event.data;
      const pending = this.#pending.get(msg.id);
      if (!pending) return;
      if ("progress" in msg) {
        pending.onProgress?.(msg.progress.stage, msg.progress.fraction);
        return;
      }
      this.#pending.delete(msg.id);
      if (msg.ok) pending.resolve(msg);
      else pending.reject(new EngineError(msg.code, msg.message, msg.hint));
    });
  }

  #send<K extends WorkerRequest["kind"]>(
    request: Extract<RequestBody, { kind: K }>,
    transfer: Transferable[] = [],
    onProgress?: (stage: string, fraction: number) => void,
  ): Promise<ReplyFor<K>> {
    const id = this.#nextId++;
    return new Promise<ReplyFor<K>>((resolve, reject) => {
      this.#pending.set(id, {
        resolve: (value) => resolve(value as ReplyFor<K>),
        reject,
        ...(onProgress !== undefined ? { onProgress } : {}),
      });
      this.#worker.postMessage({ ...request, id } as WorkerRequest, transfer);
    });
  }

  async consoles(): Promise<ConsoleInfo[]> {
    return (await this.#send({ kind: "consoles" })).consoles;
  }

  async strategies(consoleId: string): Promise<StrategyInfo[]> {
    return (await this.#send({ kind: "strategies", console: consoleId })).strategies;
  }

  async demo(): Promise<Uint8Array> {
    return new Uint8Array((await this.#send({ kind: "demo" })).png);
  }

  async prep(
    source: Uint8Array,
    options: PrepOptionsUi,
    onProgress?: (stage: string, fraction: number) => void,
  ): Promise<PrepPayload> {
    // Copy: the source stays owned by the page (re-converted on every change).
    const buffer = source.slice().buffer;
    const res = await this.#send({ kind: "prep", source: buffer, options }, [buffer], onProgress);
    return res.result;
  }

  async gen(
    source: Uint8Array,
    options: PrepOptionsUi,
    format: "asm" | "c" | "bin",
    stem: string,
  ): Promise<GenArtifactPayload[]> {
    const buffer = source.slice().buffer;
    const res = await this.#send({ kind: "gen", source: buffer, options, format, stem }, [buffer]);
    return res.artifacts;
  }
}

/** Spin up the engine worker (module worker, bundled by Vite). */
export function createEngine(): EngineClient {
  const worker = new Worker(new URL("./core.worker.ts", import.meta.url), { type: "module" });
  return new EngineClient(worker);
}
