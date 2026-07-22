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
    files: ["packages/cli/**/*.ts", "**/*.test.ts", "tools/**/*.js", "*.js", "*.ts"],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    // The core engine is isomorphic and deterministic — enforce it mechanically.
    // Only ES globals are in scope here; anything platform-specific is a lint error.
    files: ["packages/core/src/**/*.ts"],
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
