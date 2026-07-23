import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Property tests generate thousands of interleavings; give them room.
    testTimeout: 30_000,
  },
});
