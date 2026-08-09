/**
 * The `.test.dmt` surface, as a registry.
 *
 * `lang/spec.ts` is to Demotic what this is to the suites written about it: one
 * typed declaration of every statement, from which the parser's own error hint
 * and anything that has to *offer* the statements — a palette, a reference page —
 * are derived. The two are separate files because they are separate languages
 * with separate grammars, and folding a `play` into the table of things a game
 * can say would put a statement in the language reference that no game may use.
 *
 * They share the expression language and nothing else, which is the whole point
 * of `.test.dmt` (doc 14 §Testing a game): an assertion gets relative units and
 * screen constants for free, so `expect ball1.y > centery` means the same thing
 * on a Game Boy and a Mega Drive.
 *
 * The list is small and it is meant to stay small. A suite describes what a
 * player does and what must then be true; anything else it grew would be a second
 * way to write a game.
 */

import type { StatementSpec } from "../lang/spec.js";

/** Statements a suite may use, in the order a case tends to use them. */
export const TEST_STATEMENTS: readonly StatementSpec[] = [
  {
    keyword: "test",
    syntax: "test <name>",
    summary: "Opens a case. Every line after it belongs to that case until the next `test`.",
    example: "test the ball serves down and to the left",
    note: "The name is prose rather than an identifier, because it is what a failure report says out loud. Every suite in the example library opens its first case with `press a`, since every game opens on a title screen — one line of ceremony in exchange for the title screen being part of what is checked.",
  },
  {
    keyword: "play",
    syntax: "play <n> seconds|ticks",
    summary: "Advances the game with no button held.",
    example: "play 4 seconds",
    note: "Write a duration in *seconds*. A tick count is portable only while every console ticks at the same rate, and the WonderSwan runs at 75.47 Hz — so `play 120 ticks` is two seconds on most of the set and 1.6 there. `ticks` stays a unit for the two- and eight-tick waits that give a rule an edge to fire on.",
  },
  {
    keyword: "press",
    syntax: "press <button>",
    summary: "One tick held and one released, so an edge rule sees a press.",
    example: "press a",
  },
  {
    keyword: "hold",
    syntax: "hold <button> for <n> seconds|ticks",
    summary: "Holds a button down for a duration.",
    example: "hold left for 5 seconds",
  },
  {
    keyword: "expect",
    syntax: "expect <expression>",
    summary: "The expression must be non-zero at this point in the case.",
    example: "expect ball1.x < centerx",
    note: "Written in the game's own relative vocabulary or it is only true on one console, which is what makes a suite a *balance* check rather than a mechanical one. `expect scene <name>` is the readable special case for which scene is running.",
  },
];

/** The keywords, in registry order — the parser's error hint is built from this. */
export const TEST_KEYWORDS = TEST_STATEMENTS.map((s) => s.keyword) as readonly string[];
