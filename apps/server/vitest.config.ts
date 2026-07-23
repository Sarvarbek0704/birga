import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Resolve workspace packages to their TypeScript source so tests run without a
// build step. Any import of these specifiers (including inside @birga/protocol)
// resolves here.
const alias = {
  "@birga/protocol": fileURLToPath(new URL("../../packages/protocol/src/index.ts", import.meta.url)),
  "@birga/crdt": fileURLToPath(new URL("../../packages/crdt/src/index.ts", import.meta.url)),
};

export default defineConfig({
  resolve: { alias },
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 20_000,
  },
});
