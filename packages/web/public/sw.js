/*
 * Service worker (doc 07 §Quality bar: works fully offline after first load).
 *
 * Deliberately tiny and hand-written rather than generated. The app is a static
 * bundle of hashed, immutable assets, so "serve from cache, fall back to the
 * network" is the whole strategy for them — a hashed name can never mean two
 * different files.
 *
 * **The shell is the exception, and it is the one that matters.** `index.html`
 * is the one file whose URL never changes, and it is what names every hashed
 * chunk. Serving it from the cache pins a returning visitor to the build they
 * first loaded — for ever, because the cached shell asks for the cached chunks
 * and the new ones are never requested. A deploy then reaches new visitors only.
 * So navigations go to the network first and fall back to the cache, which is
 * what keeps "works offline" and "gets the update" from being the same decision.
 *
 * Bumping CACHE drops every older cache on activate. That is how a visitor
 * carrying a poisoned shell from an older worker is rescued: the new worker
 * installs, deletes the old cache, and claims the page — one further reload and
 * they are on the current build.
 */

const CACHE = "demake-v2";

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

  // The shell: network first, and the copy kept under "./" so an offline reload
  // finds it whatever the address bar says (the app is one page and a hash).
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok && response.type === "basic") {
            const copy = response.clone();
            void caches.open(CACHE).then((cache) => cache.put("./", copy));
          }
          return response;
        })
        .catch(() =>
          caches.match("./").then((hit) => hit ?? Promise.reject(new Error("offline, no shell"))),
        ),
    );
    return;
  }

  // Everything else is content-hashed, so the cache is always right about it.
  event.respondWith(
    caches.match(request).then((hit) => {
      if (hit) return hit;
      return fetch(request).then((response) => {
        if (response.ok && response.type === "basic") {
          const copy = response.clone();
          void caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    }),
  );
});
