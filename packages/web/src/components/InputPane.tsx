/**
 * Input pane (doc 07 §UX 1): drag-and-drop, file picker, clipboard paste, and
 * the bundled demo — plus the source's dimensions and the profile the pipeline
 * detected (art vs photo), which is the first thing that explains its choices.
 */

import { useCallback, useEffect, useRef, useState } from "preact/hooks";

import { describeSource, type SourceImage } from "../app.js";

interface Props {
  source: SourceImage | null;
  onSource: (source: SourceImage) => void;
  onDemo: () => void;
  profile: "art" | "photo" | null;
}

export function InputPane({ source, onSource, onDemo, profile }: Props) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const accept = useCallback(
    async (file: File) => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      onSource(await describeSource(file.name, bytes));
    },
    [onSource],
  );

  // Paste-from-clipboard anywhere on the page (doc 07 §UX 1).
  useEffect(() => {
    const onPaste = (event: ClipboardEvent): void => {
      const item = [...(event.clipboardData?.items ?? [])].find((i) => i.type.startsWith("image/"));
      const file = item?.getAsFile();
      if (file) void accept(file);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [accept]);

  return (
    <section class="pane input-pane" aria-labelledby="input-heading">
      <h2 id="input-heading">Source</h2>
      <div
        class={`dropzone${dragging ? " dragging" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const file = e.dataTransfer?.files?.[0];
          if (file) void accept(file);
        }}
      >
        {source ? (
          <img src={source.url} alt={`source image ${source.name}`} data-testid="source-preview" />
        ) : (
          <p class="hint">
            Drop an image here, paste from the clipboard, or pick a file. PNG, JPEG, WebP, GIF and
            BMP all work.
          </p>
        )}
      </div>

      <div class="row">
        <button type="button" onClick={() => inputRef.current?.click()}>
          Choose file…
        </button>
        <button type="button" onClick={onDemo} data-testid="load-demo">
          Load demo image
        </button>
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          class="visually-hidden"
          onChange={(e) => {
            const file = (e.currentTarget as HTMLInputElement).files?.[0];
            if (file) void accept(file);
          }}
        />
      </div>

      {source && (
        <dl class="facts" data-testid="source-facts">
          <div>
            <dt>File</dt>
            <dd title={source.name}>{source.name}</dd>
          </div>
          <div>
            <dt>Size</dt>
            <dd>
              {source.width}×{source.height}
            </dd>
          </div>
          <div>
            <dt>Profile</dt>
            <dd>{profile ?? "—"}</dd>
          </div>
        </dl>
      )}
    </section>
  );
}
