/**
 * A section that is announced but not built.
 *
 * It says what the domain will be and where its design lives, rather than a bare
 * "coming soon" — the roadmap is public (doc 13) and the honest thing is to link
 * to it.
 */

import type { Section } from "../lib/route.js";

const COPY: Readonly<Record<string, { blurb: string; detail: string }>> = {
  music: {
    blurb: "Turn a modern track into chip music that plays on the hardware.",
    detail:
      "The same shape as the image and game paths: constrain, fit, emit, then prove it in an emulator — Game Boy pulse and wave channels, the NES 2A03, SPC700 BRR samples, YM2612 FM patches.",
  },
  sound: {
    blurb: "Turn a sound effect into something a 1989 sound chip can actually make.",
    detail:
      "Short, percussive, and far more sensitive to a chip's envelope and noise generator than music is — which is why it is its own demaker rather than a corner of the music one.",
  },
};

export function ComingSoon({ section }: { section: Section }) {
  const copy = COPY[section];
  return (
    <main>
      <section class="pane coming-soon">
        <h2>Coming soon</h2>
        <p class="blurb">{copy?.blurb}</p>
        <p class="hint">{copy?.detail}</p>
        <p class="hint">
          Planned in{" "}
          <a href="https://github.com/georgestephenson/demake/blob/main/docs/13-roadmap.md">
            the roadmap
          </a>
          . The image and game demakers work today.
        </p>
      </section>
    </main>
  );
}
