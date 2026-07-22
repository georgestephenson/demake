#!/usr/bin/env node
import process from "node:process";

import { makeNodeEnv } from "./env.js";
import { run } from "./run.js";

const env = makeNodeEnv();
run(process.argv.slice(2), env)
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    // Last-resort guard: run() maps known errors itself, so reaching here is a bug.
    process.stderr.write(`demake: internal error: ${String(error)}\n`);
    process.exitCode = 70;
  });
