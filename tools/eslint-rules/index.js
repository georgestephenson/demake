import { builtinModules } from "node:module";

/**
 * @fileoverview Custom ESLint rules that enforce the two load-bearing
 * invariants of `@demake/core` (doc 02 §Dependency rules, §Determinism):
 *
 *  - `no-platform-apis`  — core must be pure: no Node built-ins, no `Buffer`/
 *    `process`, no DOM. All I/O happens at the edges (CLI/web/desktop).
 *  - `no-nondeterminism` — core output must be byte-identical everywhere: no
 *    wall clock, no `Math.random`, and none of the `Math.*` transcendentals
 *    whose implementations differ across JS engines (the in-house math kernels
 *    replace them).
 *
 * These are the machine enforcement of rules the docs state in prose; keep the
 * two in sync.
 */

const NODE_BUILTINS = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);

/** Globals that only exist because of a platform (Node or the DOM). */
const PLATFORM_GLOBALS = new Set([
  "Buffer",
  "process",
  "__dirname",
  "__filename",
  "require",
  "module",
  "global",
  "document",
  "window",
  "navigator",
  "localStorage",
  "sessionStorage",
  "XMLHttpRequest",
  "fetch",
]);

/**
 * `Math.*` methods that are non-deterministic (`random`) or implemented with
 * engine-specific transcendental code (differs at the 1-ulp level across
 * browsers). Basic IEEE-754 ops — `sqrt`, `abs`, `floor`, `min`, … — are
 * bit-exact and stay allowed.
 */
const NON_DETERMINISTIC_MATH = new Set([
  "random",
  "pow",
  "exp",
  "expm1",
  "log",
  "log1p",
  "log2",
  "log10",
  "cbrt",
  "sin",
  "cos",
  "tan",
  "asin",
  "acos",
  "atan",
  "atan2",
  "sinh",
  "cosh",
  "tanh",
  "asinh",
  "acosh",
  "atanh",
  "hypot",
]);

/** @type {import("eslint").Rule.RuleModule} */
const noPlatformApis = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow platform-specific APIs in the isomorphic core (doc 02 §Dependency rules).",
    },
    schema: [],
    messages: {
      builtin:
        "core is platform-pure: do not import the Node built-in '{{name}}'. Move I/O to the CLI/web/desktop edge.",
      global:
        "core is platform-pure: do not use the platform global '{{name}}'. Move I/O to the CLI/web/desktop edge.",
    },
  },
  create(context) {
    const sourceCode = context.sourceCode;

    function checkSource(node) {
      const source = node.source;
      if (source && typeof source.value === "string" && NODE_BUILTINS.has(source.value)) {
        context.report({ node: source, messageId: "builtin", data: { name: source.value } });
      }
    }

    return {
      ImportDeclaration: checkSource,
      ExportNamedDeclaration: checkSource,
      ExportAllDeclaration: checkSource,
      ImportExpression(node) {
        const arg = node.source;
        if (arg && arg.type === "Literal" && NODE_BUILTINS.has(arg.value)) {
          context.report({ node: arg, messageId: "builtin", data: { name: arg.value } });
        }
      },
      Program(node) {
        const scope = sourceCode.getScope(node);
        for (const ref of scope.through) {
          const name = ref.identifier.name;
          if (PLATFORM_GLOBALS.has(name)) {
            context.report({ node: ref.identifier, messageId: "global", data: { name } });
          }
        }
      },
    };
  },
};

/** @type {import("eslint").Rule.RuleModule} */
const noNondeterminism = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow non-deterministic APIs in core: wall clock, RNG, and engine-specific Math transcendentals (doc 02 §Determinism).",
    },
    schema: [],
    messages: {
      math: "'Math.{{name}}' is not byte-deterministic across JS engines. Use the in-house math kernels instead.",
      dateNow: "'Date.now' is non-deterministic. core takes no wall-clock input.",
      newDate: "'new Date()' reads the wall clock. core takes no wall-clock input.",
    },
  },
  create(context) {
    return {
      MemberExpression(node) {
        if (node.computed || node.property.type !== "Identifier") {
          return;
        }
        if (node.object.type !== "Identifier") {
          return;
        }
        if (node.object.name === "Math" && NON_DETERMINISTIC_MATH.has(node.property.name)) {
          context.report({ node, messageId: "math", data: { name: node.property.name } });
        }
        if (node.object.name === "Date" && node.property.name === "now") {
          context.report({ node, messageId: "dateNow" });
        }
      },
      NewExpression(node) {
        if (node.callee.type === "Identifier" && node.callee.name === "Date") {
          context.report({ node, messageId: "newDate" });
        }
      },
    };
  },
};

/** @type {import("eslint").ESLint.Plugin} */
const plugin = {
  meta: {
    name: "@demake/eslint-rules",
    version: "0.0.0",
  },
  rules: {
    "no-platform-apis": noPlatformApis,
    "no-nondeterminism": noNondeterminism,
  },
};

export default plugin;
