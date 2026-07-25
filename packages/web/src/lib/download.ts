/**
 * File downloads — the web app's only "output" surface (doc 07 §UX exports).
 *
 * Everything is produced in the worker and handed here as bytes; the page never
 * sends them anywhere, it just offers them to the browser's own save dialog.
 */

/** Offer `bytes` to the user as a download named `name`. */
export function download(name: string, bytes: Uint8Array): void {
  const blob = new Blob([bytes.slice().buffer as ArrayBuffer], { type: mimeFor(name) });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Give the browser a tick to start the download before revoking the URL.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function mimeFor(name: string): string {
  if (name.endsWith(".png")) return "image/png";
  if (name.endsWith(".json")) return "application/json";
  if (name.endsWith(".c") || name.endsWith(".h") || name.endsWith(".asm")) return "text/plain";
  return "application/octet-stream";
}
