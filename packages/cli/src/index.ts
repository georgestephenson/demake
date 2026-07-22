#!/usr/bin/env node
import process from "node:process";

import { run } from "./run.js";

const code = run(process.argv.slice(2), {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
});

process.exitCode = code;
