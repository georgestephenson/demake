/**
 * Which view of a source file is on screen.
 *
 * The level editor already offers text, map, or the two side by side (doc 19
 * §The level editor), and a `.dmt` now offers the same three with blocks in the
 * map's place. It is one declaration because two sections use it — a game and its
 * suite — and a picker whose options differed between them would be two answers
 * to one question.
 *
 * **Neither view is the authoritative one: the file is.** Blocks are a view over
 * the format, never a second format, which is why switching between them costs
 * nothing and changes nothing (`lib/blocks.ts`).
 *
 * Text is first because it is the default, and it is the default because the
 * claim the game section makes is that a whole game is sixty readable lines
 * (AGENTS.md §The example library). Blocks are the *alternative* — one dropdown
 * away, for somebody who would rather assemble a program than type one.
 */

/** Which of the two the pane is showing. */
export type SourceView = "blocks" | "text" | "both";

/** The dropdown's options, in the order they read. */
export const VIEWS: readonly { id: SourceView; label: string }[] = [
  { id: "text", label: "Text" },
  { id: "blocks", label: "Blocks" },
  { id: "both", label: "Side by side" },
];
