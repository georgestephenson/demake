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
  const header =
    `${pad("ID", 12)}${pad("NAME", 36)}${pad("RES", 10)}${pad("TIER", 6)}` +
    `${pad("COLOR", 14)}ALSO KNOWN AS`;
  env.out(`${header}\n${rows.join("\n")}\n`);
  return EXIT.OK;
}

/**
 * One console, one line.
 *
 * The regional names get a column of their own rather than being folded into
 * NAME: only a handful of consoles have any, and joining them there would push
 * every row of an aligned table out by the width of the longest pair for the
 * sake of six of them.
 */
function formatRow(spec: ConsoleSpec): string {
  const res = `${spec.display.width}x${spec.display.height}`;
  const color = describeColor(spec);
  const also = (spec.otherNames ?? []).join(", ");
  return (
    `${pad(spec.id, 12)}${pad(spec.name, 36)}${pad(res, 10)}${pad(String(spec.tier), 6)}` +
    `${also === "" ? color : `${pad(color, 14)}${also}`}`
  );
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
