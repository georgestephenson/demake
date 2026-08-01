/**
 * The service worker's one load-bearing decision: what may come from the cache.
 *
 * This is here because the failure it guards against is invisible to every other
 * test in the repo. A Playwright context starts with empty storage, so the suite
 * always sees a first visit — and the bug only exists on the *second* one. The
 * app's assets are content-hashed and so may be cached for ever, but `index.html`
 * is not: it is the file that names those hashed chunks, so a cached copy asks
 * for the chunks it already has and a deploy reaches nobody who has been before.
 * It shipped exactly once and the symptom was a new console not appearing in the
 * browser after a deploy that contained it.
 *
 * The worker is plain JavaScript with no imports, so it is run here in a fake
 * global rather than a browser: the routing decision is what is being checked,
 * and it is the same decision whoever is asking.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";

import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(join(import.meta.dirname, "..", "public", "sw.js"), "utf8");

/** Where the app is served from — a project page, so not the origin's root. */
const SCOPE = "https://example.test/demake/";

type Handler = (event: FakeEvent) => void;

interface FakeRequest {
  url: string;
  method: string;
  mode: string;
}

/** What the worker asked the network for, and how. */
interface Ask {
  url: string;
  /** The `cache` mode it passed, if any — the shell must bypass the HTTP cache. */
  cache?: string;
}

interface FakeEvent {
  request: FakeRequest;
  respondWith(response: Promise<unknown>): void;
  waitUntil(work: Promise<unknown>): void;
  responded?: Promise<unknown>;
}

/** A response, as much of one as the worker looks at. */
function response(body: string, ok = true) {
  return { body, ok, type: "basic", clone: () => ({ body, ok, type: "basic" }) };
}

/**
 * Start the worker over a cache holding `cached`, and a network serving `served`.
 *
 * Returns the fetch listener plus a log of what the network was asked for, which
 * is the whole question: a request that never reaches the network is a request
 * answered from the cache.
 */
function start(options: { cached?: Record<string, unknown>; offline?: boolean } = {}) {
  // Keys are absolute, because that is what a real Cache does: a relative one is
  // resolved against the worker's scope when it goes in *and* when it is looked
  // up, which is precisely why a shell stored as "./" answers the navigation for
  // the site root — the hit this test exists to catch.
  const absolute = (key: FakeRequest | string): string =>
    new URL(typeof key === "string" ? key : key.url, SCOPE).href;
  const store = new Map<string, unknown>(
    Object.entries(options.cached ?? {}).map(([key, value]) => [absolute(key), value]),
  );
  const asks: Ask[] = [];
  const asked: string[] = [];
  const listeners = new Map<string, Handler>();

  const caches = {
    open: () =>
      Promise.resolve({
        add: () => Promise.resolve(),
        put: (key: FakeRequest | string, value: unknown) => {
          store.set(absolute(key), value);
          return Promise.resolve();
        },
      }),
    match: (key: FakeRequest | string) => Promise.resolve(store.get(absolute(key))),
    keys: () => Promise.resolve([]),
    delete: () => Promise.resolve(true),
  };

  const sandbox = {
    self: {
      addEventListener: (name: string, handler: Handler) => listeners.set(name, handler),
      skipWaiting: () => undefined,
      clients: { claim: () => Promise.resolve() },
    },
    caches,
    location: { origin: "https://example.test" },
    fetch: (request: FakeRequest, init?: { cache?: string }) => {
      asked.push(request.url);
      asks.push({ url: request.url, ...(init?.cache === undefined ? {} : { cache: init.cache }) });
      return options.offline
        ? Promise.reject(new Error("offline"))
        : Promise.resolve(response(`network:${request.url}`));
    },
    URL,
    Promise,
    Error,
  };
  runInContext(SOURCE, createContext(sandbox));

  const fetchListener = listeners.get("fetch");
  if (!fetchListener) throw new Error("the worker registered no fetch listener");

  /** Ask the worker for a URL, and get back what it answered with (or null). */
  const request = async (url: string, mode = "no-cors", method = "GET"): Promise<unknown> => {
    let responded: Promise<unknown> | null = null;
    fetchListener({
      request: { url, method, mode },
      respondWith: (value) => {
        responded = value;
      },
      waitUntil: () => undefined,
    });
    return responded === null ? null : await responded;
  };

  return { request, asked, asks, store };
}

describe("the service worker", () => {
  it("goes to the network for the shell even when it has one cached", async () => {
    const { request, asked } = start({
      cached: { "./": response("cached:shell") },
    });
    const answer = await request(SCOPE, "navigate");
    expect((answer as { body: string }).body).toBe(`network:${SCOPE}`);
    expect(asked).toEqual([SCOPE]);
  });

  it("keeps the fresh shell, so the copy it falls back to is not the stale one", async () => {
    const { request, store } = start({ cached: { "./": response("cached:shell") } });
    await request(SCOPE, "navigate");
    expect((store.get(SCOPE) as { body: string }).body).toBe(`network:${SCOPE}`);
  });

  it("falls back to the cached shell when there is no network", async () => {
    const { request } = start({ cached: { "./": response("cached:shell") }, offline: true });
    const answer = await request(SCOPE, "navigate");
    expect((answer as { body: string }).body).toBe("cached:shell");
  });

  it("asks for the shell past the HTTP cache", async () => {
    // Network-first over a response the *browser* cached is not first at all:
    // Pages sends `max-age=600` on index.html, so without this the shell can be
    // ten minutes stale and every hashed chunk it names ten minutes behind.
    const { request, asks } = start();
    await request(SCOPE, "navigate");
    expect(asks).toEqual([{ url: SCOPE, cache: "no-store" }]);
  });

  it("serves a hashed asset from the cache without asking the network", async () => {
    const chunk = `${SCOPE}assets/GameDemaker-abc123.js`;
    const { request, asked } = start({ cached: { [chunk]: response("cached:chunk") } });
    const answer = await request(chunk);
    expect((answer as { body: string }).body).toBe("cached:chunk");
    expect(asked).toEqual([]);
  });

  it("fetches and keeps an asset it has never seen", async () => {
    const chunk = `${SCOPE}assets/Nes-def456.js`;
    const { request, asked, store } = start();
    const answer = await request(chunk);
    expect((answer as { body: string }).body).toBe(`network:${chunk}`);
    expect(asked).toEqual([chunk]);
    expect(store.has(chunk)).toBe(true);
  });

  it("goes to the network for an unhashed file even when it has one cached", async () => {
    // The icon, the manifest, anything dropped in `public/`: a stable URL with
    // mutable contents is the shell's problem in miniature, and it gets the
    // shell's answer. Only `assets/` is content-hashed, so only `assets/` is
    // safe to pin.
    const icon = `${SCOPE}icon.svg`;
    const { request, asked } = start({ cached: { [icon]: response("cached:icon") } });
    const answer = await request(icon);
    expect((answer as { body: string }).body).toBe(`network:${icon}`);
    expect(asked).toEqual([icon]);
  });

  it("falls back to the cache for an unhashed file when there is no network", async () => {
    const icon = `${SCOPE}icon.svg`;
    const { request } = start({ cached: { [icon]: response("cached:icon") }, offline: true });
    expect(((await request(icon)) as { body: string }).body).toBe("cached:icon");
  });

  it("leaves other origins and non-GET requests alone", async () => {
    const { request } = start();
    expect(await request("https://elsewhere.test/thing.js")).toBeNull();
    expect(await request(SCOPE, "navigate", "POST")).toBeNull();
  });
});
