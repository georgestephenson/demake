import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

import demake from "./tools/eslint-rules/index.js";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/coverage/**", "**/*.tsbuildinfo"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Node globals live only at the edges: the CLI, all tests, tooling, and the
    // root config files. Deliberately NOT applied to `packages/core/src` — that
    // is what lets the platform-purity rule see `Buffer`/`process`/DOM as
    // unresolved references and flag them.
    files: [
      "packages/cli/**/*.ts",
      "**/*.test.ts",
      "tools/**/*.js",
      "tools/**/*.mjs",
      "packages/demotic/demo/**/*.mjs",
      "*.js",
      "*.ts",
    ],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    // The web app is a browser edge: DOM + worker globals, JSX, and Node only in
    // its Vite/Playwright config and its Playwright specs (which run in Node).
    files: ["packages/web/**/*.ts", "packages/web/**/*.tsx"],
    languageOptions: {
      globals: { ...globals.browser, ...globals.worker },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
  },
  {
    files: ["packages/web/*.ts", "packages/web/test/**/*.ts", "packages/web/public/sw.js"],
    languageOptions: {
      globals: { ...globals.node, ...globals.serviceworker },
    },
  },
  {
    // The core engine is isomorphic and deterministic — enforce it mechanically.
    // Only ES globals are in scope here; anything platform-specific is a lint error.
    // Demotic's front end and reference interpreter live under the same two
    // invariants: the simulator is the semantic spec a console runtime must
    // match bit-for-bit, so it cannot reach for a platform API or drift by an
    // ulp (doc 14 §Simulate constrained).
    // `chip` and `audio` join them for the same reason, and audio needs it
    // most: DSP reaches for transcendentals constantly, and an FFT seeded with
    // `Math.cos` returns different low bits per engine — which every metric
    // downstream then inherits (doc 16 §Determinism engineering).
    files: [
      "packages/core/src/**/*.ts",
      "packages/demotic/src/**/*.ts",
      "packages/chip/src/**/*.ts",
      "packages/audio/src/**/*.ts",
    ],
    languageOptions: {
      globals: { ...globals.es2021 },
    },
    plugins: { demake },
    rules: {
      "demake/no-platform-apis": "error",
      "demake/no-nondeterminism": "error",
    },
  },
  // Keep last: turn off stylistic rules that Prettier owns.
  prettier,
);
