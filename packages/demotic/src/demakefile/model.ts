/**
 * The Demakefile's shape (doc 15, doc 19 §The Demakefile, still optional).
 *
 * A build file, not a game file: it says how a `.dmt` reaches hardware and never
 * what the game does. Delete it and the game plays identically — only the
 * artifacts change, and `packages/demotic/test/demakefile.test.ts` holds that as
 * a property rather than a promise.
 *
 * The model is **ordered and comment-preserving**, which is what lets the web
 * app's controls write into a hand-authored file without reformatting it (doc 19
 * §Options edit the Demakefile). Every node carries the blank lines and comments
 * that preceded it, so emitting a file nobody edited gives that file back.
 */

/** Which demaker an option block belongs to. */
export type Domain = "art" | "music" | "sound";

/** The domains, in the order `fmt` writes them. */
export const DOMAINS: readonly Domain[] = ["art", "music", "sound"];

/** An option, as written: the directive name and the rest of the line. */
export interface Option {
  name: string;
  value: string;
  /** Comment and blank lines immediately above, kept verbatim. */
  leading?: readonly string[];
  /** 1-indexed source line, for diagnostics. */
  line: number;
}

/** A bag of options in file order. */
export type Options = readonly Option[];

/** One artifact a target emits. */
export interface Output {
  format: string;
  path: string;
  leading?: readonly string[];
  line: number;
}

/** One build. */
export interface Target {
  name: string;
  /** Explicit `console` directive; absent means the target's own name (doc 15). */
  console?: string;
  region?: string;
  outputs: readonly Output[];
  header: Options;
  /** Conversion options scoped to this target. */
  options: Options;
  /**
   * True when this target came from a bare `targets a b c` line rather than its
   * own block, so `fmt` writes the shorthand back rather than expanding it.
   */
  shorthand?: boolean;
  leading?: readonly string[];
  line: number;
}

/** How one asset is demade. */
export interface AssetBlock {
  domain: Domain;
  /** The asset, named as a `.dmt` names it — the shortest identifying string. */
  name: string;
  options: Options;
  /** Per-target overrides, keyed by target name, in file order. */
  per: readonly { target: string; options: Options; line: number }[];
  leading?: readonly string[];
  line: number;
}

/** A parsed Demakefile. */
export interface Demakefile {
  /** `project <name>` and its metadata fields. */
  project?: { name: string; fields: Options; leading?: readonly string[]; line: number };
  source?: Option;
  /** `assets <dir>`, repeatable — extra roots outside the project (doc 19). */
  assets: readonly Option[];
  out?: Option;
  /** `defaults`, per domain. Options written bare belong to `art` (doc 15). */
  defaults: Readonly<Partial<Record<Domain, Options>>>;
  /** The order `defaults` sub-blocks appeared in, so `fmt` keeps it. */
  defaultsOrder: readonly Domain[];
  defaultsLeading?: readonly string[];
  targets: readonly Target[];
  assetBlocks: readonly AssetBlock[];
  /** Trailing comments and blank lines at the end of the file. */
  trailing?: readonly string[];
  /** The unit of indentation the file used, in spaces, or 0 for tabs. */
  indent: number;
}

/** An empty Demakefile — what "no file present" resolves as. */
export const EMPTY_DEMAKEFILE: Demakefile = {
  assets: [],
  defaults: {},
  defaultsOrder: [],
  targets: [],
  assetBlocks: [],
  indent: 2,
};

/** Look up an option by name, last one winning where a block repeats it. */
export function optionValue(options: Options, name: string): string | undefined {
  let found: string | undefined;
  for (const option of options) if (option.name === name) found = option.value;
  return found;
}
