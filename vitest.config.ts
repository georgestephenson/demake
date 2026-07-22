import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // Resolve the workspace package to its TypeScript source so tests run
      // without a prior build. The built `dist` is exercised separately by the
      // spawned-binary test (packages/cli/test/binary.test.ts).
      "@demake/core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
    },
  },
});
