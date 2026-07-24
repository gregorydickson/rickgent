import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: resolve(import.meta.dirname, "../../.."),
  test: {
    environment: "node",
    globalSetup: [],
    cache: false,
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
