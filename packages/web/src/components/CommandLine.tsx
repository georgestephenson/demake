/**
 * The live equivalent-command line (doc 07 §UX 2).
 *
 * The feature that lets someone graduate from the page to the CLI without
 * translating anything by hand — and the reason every section has one is that it
 * is also how the page proves it ran what it says it ran. Shared by all four
 * demakers so the affordance, the wording and the copy behaviour cannot drift
 * apart between them.
 */

import { useState } from "preact/hooks";

export function CommandLine({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <div class="command">
      <span class="command-label">Equivalent command</span>
      <code data-testid="equivalent-command">{command}</code>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard?.writeText(command).then(
            () => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            },
            () => {},
          );
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
