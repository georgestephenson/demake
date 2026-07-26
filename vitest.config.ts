import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // Resolve the workspace package to its TypeScript source so tests run
      // without a prior build. The built `dist` is exercised separately by the
      // spawned-binary test (packages/cli/test/binary.test.ts).
      "@demake/core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)),
      "@demake/cli-spec": fileURLToPath(
        new URL("./packages/cli-spec/src/index.ts", import.meta.url),
      ),
      "@demake/demotic": fileURLToPath(new URL("./packages/demotic/src/index.ts", import.meta.url)),
      "@demake/dmg": fileURLToPath(new URL("./packages/dmg/src/index.ts", import.meta.url)),
      "@demake/nes": fileURLToPath(new URL("./packages/nes/src/index.ts", import.meta.url)),
      "@demake/chip": fileURLToPath(new URL("./packages/chip/src/index.ts", import.meta.url)),
      "@demake/audio": fileURLToPath(new URL("./packages/audio/src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    // Tournament-driven tests run several full prep pipelines per assertion
    // (9 candidates since the graded portfolio); give them headroom while the
    // whole suite stays under the doc-10 two-minute target.
    testTimeout: 20000,
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
    },
  },
});
