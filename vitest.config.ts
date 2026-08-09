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
      "@demake/sms": fileURLToPath(new URL("./packages/sms/src/index.ts", import.meta.url)),
      "@demake/snes": fileURLToPath(new URL("./packages/snes/src/index.ts", import.meta.url)),
      "@demake/md": fileURLToPath(new URL("./packages/md/src/index.ts", import.meta.url)),
      "@demake/gba": fileURLToPath(new URL("./packages/gba/src/index.ts", import.meta.url)),
      "@demake/nds": fileURLToPath(new URL("./packages/nds/src/index.ts", import.meta.url)),
      "@demake/pce": fileURLToPath(new URL("./packages/pce/src/index.ts", import.meta.url)),
      "@demake/wsc": fileURLToPath(new URL("./packages/wsc/src/index.ts", import.meta.url)),
      "@demake/ngp": fileURLToPath(new URL("./packages/ngp/src/index.ts", import.meta.url)),
      "@demake/vb": fileURLToPath(new URL("./packages/vb/src/index.ts", import.meta.url)),
      "@demake/chip": fileURLToPath(new URL("./packages/chip/src/index.ts", import.meta.url)),
      "@demake/audio": fileURLToPath(new URL("./packages/audio/src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    // A demade picture is shared between worker processes for the length of one
    // run (`packages/demotic/test/_art-store.ts`). A test file is the unit Vitest
    // schedules, so without this the same fixture is fitted from scratch in every
    // file that builds it — a fifth of all the conversion time the suite spends.
    // The store keys on a digest of the engine's own source, so it cannot answer
    // for code that has changed; `globalSetup` is what computes that and what
    // removes the directory afterwards.
    globalSetup: ["packages/demotic/test/_art-cache-setup.ts"],
    setupFiles: ["packages/demotic/test/_art-store.ts"],
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
