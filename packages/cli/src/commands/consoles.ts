/**
 * `demake consoles` — self-description for humans and agents (doc 05
 * §Agent-friendliness).
 *
 * `--json` dumps every `ConsoleSpec` plus its candidate portfolio, so an agent
 * can compute valid invocations without external docs. The default is a compact
 * human table.
 */

import { consoles, strategies, type ConsoleSpec } from "@demake/core";

import type { CliEnv } from "../env.js";
import { EXIT, type ExitCode } from "../exit-codes.js";

export function runConsoles(env: CliEnv, json: boolean): ExitCode {
  const list = consoles();
  if (json) {
    const payload = {
      schemaVersion: 1,
      consoles: list.map((spec) => ({
        ...spec,
        strategies: strategies(spec.id),
      })),
    };
    env.out(JSON.stringify(payload, null, 2) + "\n");
    return EXIT.OK;
  }

  const rows = list.map((spec) => formatRow(spec));
  const header = `${pad("ID", 6)}${pad("NAME", 18)}${pad("RES", 10)}${pad("TIER", 6)}COLOR`;
  env.out(`${header}\n${rows.join("\n")}\n`);
  return EXIT.OK;
}

function formatRow(spec: ConsoleSpec): string {
  const res = `${spec.display.width}x${spec.display.height}`;
  const color = describeColor(spec);
  return `${pad(spec.id, 6)}${pad(spec.name, 18)}${pad(res, 10)}${pad(String(spec.tier), 6)}${color}`;
}

function describeColor(spec: ConsoleSpec): string {
  if (spec.color.model === "rgb" && spec.color.bitsPerChannel) {
    return `RGB${spec.color.bitsPerChannel.join("")}`;
  }
  if (spec.color.model === "mono") {
    return `${spec.color.shades ?? 4}-shade mono`;
  }
  return "fixed-master";
}

function pad(text: string, width: number): string {
  return text.length >= width ? text + " " : text + " ".repeat(width - text.length);
}
