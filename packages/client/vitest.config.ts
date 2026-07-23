import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const alias = {
  "@birga/crdt": fileURLToPath(new URL("../crdt/src/index.ts", import.meta.url)),
  "@birga/protocol": fileURLToPath(new URL("../protocol/src/index.ts", import.meta.url)),
  // Integration tests drive the real sync server.
  "@birga/server": fileURLToPath(new URL("../../apps/server/src/server.ts", import.meta.url)),
};

export default defineConfig({
  resolve: { alias },
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 20_000,
  },
});
