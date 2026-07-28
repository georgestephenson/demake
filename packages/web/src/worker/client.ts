/**
 * Typed client for the engine worker (doc 07 §Stack).
 *
 * A promise-per-request RPC — small enough to hand-roll, and hand-rolling keeps
 * the dependency budget (doc 07 §Quality bar) for the parts of the page a user
 * can see. A request supersedes its predecessor of the same kind: while the user
 * drags a slider, only the newest conversion's result is delivered.
 */

import type {
  BuiltRomPayload,
  ConsoleInfo,
  GenArtifactPayload,
  PrepOptionsUi,
  PrepPayload,
  WorkerRequest,
  WorkerResponse,
} from "./protocol.js";
import type { StrategyInfo } from "@demake/core";
import type { Program } from "@demake/demotic";

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

  /**
   * Compile a game to a real cartridge.
   *
   * Nothing is transferred: the program and the asset bytes both stay owned by
   * the page, which rebuilds from them on the next keystroke.
   */
  async buildGame(
    program: Program,
    title: string,
    assets: Map<string, Uint8Array>,
  ): Promise<BuiltRomPayload> {
    return (await this.#send({ kind: "build-game", program, title, assets })).result;
  }
}

/**
 * How many lanes to start.
 *
 * One short of what the browser admits to, because the engine worker is doing
 * real work between fan-outs — interning tiles, laying out RAM, emitting code —
 * and a lane per core measurably loses to a lane per core minus one. Capped,
 * because past a handful they compete for memory rather than for work; browsers
 * that decline to say get none, and everything runs in the engine worker as
 * before.
 *
 * The number cannot reach the cartridge: a tournament's winner is decided in
 * portfolio order, so a four-core laptop and a sixteen-core desktop produce the
 * same bytes (doc 04 §Running the tournament).
 */
function laneCount(): number {
  const cores = navigator.hardwareConcurrency;
  if (!Number.isFinite(cores) || cores < 3) return 0;
  return Math.min(6, Math.floor(cores) - 1);
}

/**
 * Spin up the engine worker and its lanes (module workers, bundled by Vite).
 *
 * A lane is another instance of the *same* worker, which is the whole reason
 * this costs nothing to download: it already holds both engines, because it
 * builds cartridges and a cartridge's art and audio are demade through them
 * (doc 07 §Quality bar). Each lane gets one end of a `MessageChannel` and the
 * engine worker gets the other, so candidates travel directly between them —
 * the page is not in the path, and no worker has to spawn a worker.
 */
export function createEngine(): EngineClient {
  const spawn = (): Worker =>
    new Worker(new URL("./core.worker.ts", import.meta.url), { type: "module" });
  const worker = spawn();
  const ports: MessagePort[] = [];
  for (let index = 0; index < laneCount(); index += 1) {
    const channel = new MessageChannel();
    // A lane is told to *serve* its port. It is given no lanes of its own, so a
    // job it runs can never fan out again.
    spawn().postMessage({ id: 0, kind: "serve", port: channel.port2 }, [channel.port2]);
    ports.push(channel.port1);
  }
  if (ports.length > 0) worker.postMessage({ id: 0, kind: "lanes", ports }, ports);
  return new EngineClient(worker);
}
