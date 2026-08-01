/**
 * Entry point (doc 07). Mounts the app and registers the offline service worker.
 */

import { render } from "preact";

import { Site } from "./site.js";
import "./styles.css";

const root = document.getElementById("app");
if (root) render(<Site />, root);

/*
 * Offline support (doc 07 §Quality bar). Registration failures are non-fatal:
 * the app works exactly the same, it just won't be available offline.
 *
 * Three things beyond `register()`, each of which is a way a visitor gets stuck
 * on an old build — the worker's own caching policy (`public/sw.js`) is only
 * half the answer:
 *
 * - **`updateViaCache: "none"`** so the browser fetches `sw.js` itself past the
 *   HTTP cache. A worker that cannot be re-read is a worker that cannot be
 *   replaced, whatever it says inside.
 * - **An update check on load and on coming back to the tab.** A browser checks
 *   for a new worker on navigation, and this app is one page: someone who leaves
 *   it open for a week navigates once.
 * - **A reload when a new worker takes over** — but only when one was already in
 *   control, because the *first* registration claims the page too and reloading
 *   on that is a reload on every first visit.
 */
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  const container = navigator.serviceWorker;
  const hadController = container.controller !== null;
  let reloading = false;
  container.addEventListener("controllerchange", () => {
    if (!hadController || reloading) return;
    reloading = true;
    location.reload();
  });

  window.addEventListener("load", () => {
    void container
      .register(`${import.meta.env.BASE_URL}sw.js`, { updateViaCache: "none" })
      .then((registration) => {
        document.addEventListener("visibilitychange", () => {
          if (document.visibilityState === "visible") void registration.update().catch(() => {});
        });
      })
      .catch(() => {});
  });
}
