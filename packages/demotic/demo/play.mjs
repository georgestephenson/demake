#!/usr/bin/env node
/**
 * Terminal demo: compile a `.dmt` file for a console and play it.
 *
 * This is the cheapest possible version of the preview idea — same compiled
 * program, same reference interpreter, same tick order, just drawn as
 * characters instead of sprites. It exists to make the prototype runnable
 * without a browser, and to show the same source behaving identically at
 * 20x18 and at 40x28.
 *
 *   node packages/demotic/demo/play.mjs --console gb --ticks 900
 *   node packages/demotic/demo/play.mjs --console md --frames        # animate
 *   node packages/demotic/demo/play.mjs --console nes --trace         # emit a trace
 *
 * Requires `pnpm build` first — it imports the built `dist/`.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { argv, exit, stdout } from "node:process";

const {
  Sim,
  check,
  describeProgram,
  formatDiagnostics,
  getProfile,
  profiles,
  renderAscii,
  tape,
  traceLine,
} = await import("../dist/index.js");
const { loadLevels, projectFiles } = await import("./levels.mjs");

function parseArgs(args) {
  const options = { console: "gb", ticks: 900, frames: false, trace: false, file: null };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--console" || arg === "-c") options.console = args[(i += 1)];
    else if (arg === "--ticks" || arg === "-n") options.ticks = Number(args[(i += 1)]);
    else if (arg === "--frames") options.frames = true;
    else if (arg === "--trace") options.trace = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else options.file = arg;
  }
  return options;
}

const options = parseArgs(argv.slice(2));

if (options.help) {
  stdout.write(
    [
      "usage: play.mjs [file.dmt] [--console <id>] [--ticks <n>] [--frames] [--trace]",
      ``,
      `consoles: ${profiles.map((p) => p.id).join(", ")}`,
      "",
    ].join("\n"),
  );
  exit(0);
}

const file =
  options.file ?? fileURLToPath(new URL("../fixtures/projects/pong/src/pong.dmt", import.meta.url));
const source = readFileSync(file, "utf8");
const levels = loadLevels(file);
const files = projectFiles(file);

let profile;
try {
  profile = getProfile(options.console);
} catch (error) {
  stdout.write(`${error.message}\n`);
  exit(2);
}

const { program, diagnostics } = check(source, { profile, files, levels });
if (diagnostics.length > 0) stdout.write(`${formatDiagnostics(diagnostics)}\n`);
if (!program) exit(1);

stdout.write(`${describeProgram(program)}\n\n`);

const sim = new Sim(program);

// Press A once to leave the title screen, then play a scripted rally: the
// paddle tracks the ball well enough to keep a volley going for a while.
sim.step({ a: true });
sim.step({});

const traceLines = [];
for (let i = 0; i < options.ticks; i += 1) {
  const ball = sim.entity("ball1");
  const paddle = sim.entity("paddle1");
  const input = {};
  if (ball && paddle) {
    const ballCenter = ball.numbers.x + ball.numbers.width / 2;
    const paddleCenter = paddle.numbers.x + paddle.numbers.width / 2;
    if (paddleCenter > ballCenter) input.left = true;
    else if (paddleCenter < ballCenter) input.right = true;
  }
  sim.step(input);

  if (options.trace) traceLines.push(traceLine(sim));
  if (options.frames && i % 6 === 0) {
    stdout.write(`[H[2J${renderAscii(sim)}\n${statusLine(sim)}\n`);
  }
}

if (options.trace) {
  stdout.write(`${traceLines.join("\n")}\n`);
} else if (!options.frames) {
  stdout.write(`${renderAscii(sim)}\n`);
}
stdout.write(`\n${statusLine(sim)}\n`);

const budget = sim.runtimeBudget;
stdout.write(
  `sprites/line: peak ${budget.peakSpritesPerLine} of ${budget.limit}` +
    `${budget.exceeded ? "  ** EXCEEDED **" : ""} (line ${budget.peakLine}, tick ${budget.peakTick})\n`,
);

function statusLine(current) {
  const score1 = current.entity("score1");
  const score2 = current.entity("score2");
  const value = (entity) => (entity ? Math.trunc(entity.numbers.value / 65536) : 0);
  return `tick ${current.tick}  scene ${current.scene}  score ${value(score1)}-${value(score2)}`;
}

// The tape helper is exported for tests; referenced here so the demo documents it.
void tape;
