/**
 * The Source pane's input half, shared by both audio sections (doc 07 §UX 1).
 *
 * Drag-and-drop, a file picker, and the bundled library — the same three ways in
 * the image demaker offers, minus paste, because a clipboard does not carry a
 * MIDI file. What the pane shows *about* the source differs completely between
 * music and sound, so that half is the caller's and arrives as children.
 */

import { useCallback, useRef, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";

import { fetchDemoAudio, type DemoAudio } from "../lib/demo-audio.js";

interface Props {
  /** File types the picker accepts, e.g. `.mid,audio/midi`. */
  accept: string;
  prompt: string;
  demos: readonly DemoAudio[];
  demoLabel: string;
  sourceName: string | null;
  onSource: (name: string, bytes: Uint8Array) => void;
  children?: ComponentChildren;
}

export function AudioInputPane({
  accept,
  prompt,
  demos,
  demoLabel,
  sourceName,
  onSource,
  children,
}: Props) {
  const [dragging, setDragging] = useState(false);
  const [demo, setDemo] = useState(demos[0]?.name ?? "");
  const inputRef = useRef<HTMLInputElement>(null);

  const accepted = useCallback(
    async (file: File) => {
      onSource(file.name, new Uint8Array(await file.arrayBuffer()));
    },
    [onSource],
  );

  const loadDemo = useCallback(
    async (name: string) => {
      const entry = demos.find((candidate) => candidate.name === name);
      if (!entry) return;
      onSource(entry.name, await fetchDemoAudio(entry));
    },
    [demos, onSource],
  );

  const chosen = demos.find((candidate) => candidate.name === demo);

  return (
    <section class="pane input-pane" aria-labelledby="audio-input-heading">
      <h2 id="audio-input-heading">Source</h2>

      <div
        class={`dropzone audio-dropzone${dragging ? " dragging" : ""}`}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          const file = event.dataTransfer?.files?.[0];
          if (file) void accepted(file);
        }}
      >
        <p class="hint">{sourceName ? sourceName : prompt}</p>
      </div>

      <div class="row">
        <button type="button" onClick={() => inputRef.current?.click()}>
          Choose file…
        </button>
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          class="visually-hidden"
          aria-label="Choose a file to demake"
          onChange={(event) => {
            const file = (event.currentTarget as HTMLInputElement).files?.[0];
            if (file) void accepted(file);
          }}
        />
      </div>

      <div class="field-row">
        <label class="field">
          <span>From the example library</span>
          <select
            value={demo}
            data-testid="demo-select"
            onChange={(event) => setDemo((event.currentTarget as HTMLSelectElement).value)}
          >
            {demos.map((entry) => (
              <option key={entry.name} value={entry.name}>
                {entry.name}
              </option>
            ))}
          </select>
        </label>
        <button type="button" data-testid="load-demo" onClick={() => void loadDemo(demo)}>
          {demoLabel}
        </button>
      </div>
      {chosen ? <p class="console-summary">{chosen.note}</p> : null}

      {children}
    </section>
  );
}
