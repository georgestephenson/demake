/**
 * Writing a Demakefile back out (doc 15 §The equivalence contract).
 *
 * Two spaces per level, always: `demake fmt` has one answer, so a file that has
 * been through it is the canonical spelling of its own contents. Comments and
 * blank lines come back because the model carries them — which is the whole
 * reason the web app's controls can write into a hand-authored file without
 * reformatting the parts nobody touched (doc 19 §Options edit the Demakefile).
 *
 * The three properties this file exists to satisfy, all held by
 * `packages/demotic/test/demakefile.test.ts`:
 *
 *   1. `fmt(fmt(x)) === fmt(x)` — formatting is idempotent.
 *   2. `emit(parse(x)) === fmt(x)` — the model round-trips through text.
 *   3. an untouched file comes back byte-identical.
 */

import { DOMAINS, type Demakefile, type Option, type Options } from "./model.js";

const UNIT = "  ";

/** Quote a value only where it would not survive being read back. */
function quoted(value: string): string {
  return value !== value.trim() || value.includes(" #") ? `"${value}"` : value;
}

function writeLeading(out: string[], leading: readonly string[] | undefined): void {
  for (const line of leading ?? []) out.push(line);
}

function writeOptions(out: string[], options: Options, depth: number): void {
  for (const option of options) {
    writeLeading(out, option.leading);
    const value = quoted(option.value);
    out.push(`${UNIT.repeat(depth)}${option.name}${value === "" ? "" : ` ${value}`}`);
  }
}

/** Emit a Demakefile in its canonical form. */
export function emitDemakefile(file: Demakefile): string {
  const out: string[] = [];

  if (file.project) {
    writeLeading(out, file.project.leading);
    out.push(`project ${file.project.name}`);
    writeOptions(out, file.project.fields, 1);
  }

  const single = (option: Option | undefined): void => {
    if (!option) return;
    writeLeading(out, option.leading);
    out.push(`${option.name} ${quoted(option.value)}`);
  };
  single(file.source);
  for (const root of file.assets) single(root);
  single(file.out);

  const domains = [
    ...file.defaultsOrder.filter((domain) => file.defaults[domain] !== undefined),
    ...DOMAINS.filter(
      (domain) => file.defaults[domain] !== undefined && !file.defaultsOrder.includes(domain),
    ),
  ];
  if (domains.length > 0) {
    writeLeading(out, file.defaultsLeading);
    out.push("defaults");
    for (const domain of domains) {
      out.push(`${UNIT}${domain}`);
      writeOptions(out, file.defaults[domain] ?? [], 2);
    }
  }

  // The shorthand comes back as a shorthand, in one line, in declaration order —
  // expanding it would be a formatter rewriting a file that was already correct.
  const shorthand = file.targets.filter((one) => one.shorthand === true);
  if (shorthand.length > 0) {
    writeLeading(out, shorthand[0]?.leading);
    out.push(`targets ${shorthand.map((one) => one.name).join(" ")}`);
  }

  for (const target of file.targets) {
    if (target.shorthand === true) continue;
    writeLeading(out, target.leading);
    out.push(`target ${target.name}`);
    if (target.console !== undefined) out.push(`${UNIT}console ${target.console}`);
    if (target.region !== undefined) out.push(`${UNIT}region ${target.region}`);
    writeOptions(out, target.options, 1);
    for (const output of target.outputs) {
      writeLeading(out, output.leading);
      out.push(`${UNIT}output ${output.format} ${output.path}`);
    }
    if (target.header.length > 0) {
      out.push(`${UNIT}header`);
      writeOptions(out, target.header, 2);
    }
  }

  for (const block of file.assetBlocks) {
    writeLeading(out, block.leading);
    out.push(`${block.domain} ${block.name}`);
    writeOptions(out, block.options, 1);
    for (const per of block.per) {
      out.push(`${UNIT}for ${per.target}`);
      writeOptions(out, per.options, 2);
    }
  }

  writeLeading(out, file.trailing);
  // One trailing newline, and no more: a file is a sequence of lines.
  return out.length === 0 ? "" : `${out.join("\n").replace(/\n+$/, "")}\n`;
}
