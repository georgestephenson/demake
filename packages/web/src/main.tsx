/**
 * Entry point (doc 07). Mounts the app and registers the offline service worker.
 */

import { render } from "preact";

import { App } from "./app.js";
import "./styles.css";

const root = document.getElementById("app");
if (root) render(<App />, root);

// Offline support (doc 07 §Quality bar). Registration failures are non-fatal:
// the app works exactly the same, it just won't be available offline.
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {});
  });
}
