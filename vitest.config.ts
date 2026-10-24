import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "hub/test/**/*.test.ts"],
    environment: "node",
  },
});
