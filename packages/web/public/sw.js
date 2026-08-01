/*
 * Service worker (doc 07 §Quality bar: works fully offline after first load).
 *
 * Deliberately tiny and hand-written rather than generated. The app is a static
 * bundle of hashed, immutable assets, so "serve from cache, fall back to the
 * network" is the whole strategy — **for the hashed ones**.
 *
 * **What may be cached for ever is decided by the URL, not by convenience.**
 * Vite writes every content-hashed artifact under `assets/`, so a request whose
 * path is inside it can never mean two different files and cache-first is always
 * right. Everything else same-origin — `index.html`, `manifest.webmanifest`,
 * `icon.svg`, `sw.js` itself — has a stable URL and changing contents, so it is
 * network-first with the cache as the offline fallback. That one rule is the
 * whole of this file's caching policy, and it is what `test/sw.test.ts` checks.
 *
 * **The shell is the case that bites**, and it bit once. `index.html` is what
 * names the hashed chunks, so a cached copy asks for the chunks it already has
 * and a deploy reaches new visitors only — for ever. It goes to the network, and
 * it goes with `cache: "no-store"` so the *HTTP* cache cannot serve a stale copy
 * either: GitHub Pages sends `max-age=600` on it, which was a ten-minute window
 * in which "network-first" still returned yesterday's build. Network-first over
 * a cached response is not first at all.
 *
 * Bumping CACHE drops every older cache on activate. That is how a visitor
 * carrying a poisoned shell from an older worker is rescued: the new worker
 * installs, deletes the old cache, and claims the page — and `main.tsx` reloads
 * once when that happens, so the rescue costs no clicks.
 */

const CACHE = "demake-v3";

/** Where Vite writes content-hashed output; the only thing safe to pin. */
const IMMUTABLE = "/assets/";

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE).then((cache) => cache.add("./")));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

/** Keep a copy, if the response is one we are allowed to keep. */
function keep(key, response) {
  if (response.ok && response.type === "basic") {
    const copy = response.clone();
    void caches.open(CACHE).then((cache) => cache.put(key, copy));
  }
  return response;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || new URL(request.url).origin !== location.origin) return;

  // The shell: network first, never out of the HTTP cache, and the copy kept
  // under "./" so an offline reload finds it whatever the address bar says (the
  // app is one page and a hash).
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request, { cache: "no-store" })
        .then((response) => keep("./", response))
        .catch(() =>
          caches.match("./").then((hit) => hit ?? Promise.reject(new Error("offline, no shell"))),
        ),
    );
    return;
  }

  // A hashed asset: the cache is always right about it, and asking is wasted.
  if (new URL(request.url).pathname.includes(IMMUTABLE)) {
    event.respondWith(
      caches
        .match(request)
        .then((hit) => hit ?? fetch(request).then((response) => keep(request, response))),
    );
    return;
  }

  // Anything else same-origin has a stable URL and mutable contents — the icon,
  // the manifest, a file dropped in `public/`. Network first so a deploy reaches
  // it, cache second so it still works on a plane.
  event.respondWith(
    fetch(request)
      .then((response) => keep(request, response))
      .catch(() =>
        caches
          .match(request)
          .then((hit) => hit ?? Promise.reject(new Error("offline, not cached"))),
      ),
  );
});
