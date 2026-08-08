/**
 * Which view of a source file is on screen: the text, or the blocks.
 *
 * One declaration because two sections use it — a game and its suite — and a
 * picker whose options differed between them would be two answers to one
 * question.
 *
 * **Neither view is the authoritative one: the file is.** Blocks are a view over
 * the format, never a second format, which is why switching between them costs
 * nothing and changes nothing (`lib/blocks.ts`).
 *
 * Text is first because it is the default, and it is the default because the
 * claim the game section makes is that a whole game is sixty readable lines
 * (AGENTS.md §The example library). Blocks are the *alternative*, one dropdown
 * away, for somebody who would rather assemble a program than type one.
 *
 * **There is no side-by-side**, which the level editor does offer for its map.
 * Two views of one file earn a split screen when they show different things — a
 * grid of tiles beside the legend that names them. These two show the *same*
 * thing twice, in a pane that also holds a console, so the split bought a second
 * copy of the source at half the width, and doubled the number of controls
 * between the reader and the rest of the page.
 */

/** Which of the two the pane is showing. */
export type SourceView = "blocks" | "text";

/** The dropdown's options, in the order they read. */
export const VIEWS: readonly { id: SourceView; label: string }[] = [
  { id: "text", label: "Text" },
  { id: "blocks", label: "Blocks" },
];
