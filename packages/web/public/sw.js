/*
 * Service worker (doc 07 §Quality bar: works fully offline after first load).
 *
 * Deliberately tiny and hand-written rather than generated: the app is a static
 * bundle of immutable, hashed assets, so "cache what we fetch, serve from cache
 * first, fall back to the network" is the whole strategy. Navigation requests
 * fall back to the cached shell so a reload works with no connection at all.
 *
 * Bumping CACHE drops every older cache on activate — that is the update path.
 */

const CACHE = "demake-v1";

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

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || new URL(request.url).origin !== location.origin) return;

  event.respondWith(
    caches.match(request).then((hit) => {
      if (hit) return hit;
      return fetch(request)
        .then((response) => {
          if (response.ok && response.type === "basic") {
            const copy = response.clone();
            void caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => (request.mode === "navigate" ? caches.match("./") : Promise.reject()));
    }),
  );
});
