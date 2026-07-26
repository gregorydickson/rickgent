import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/reliability/protected-release.live.test.ts"],
    environment: "node",
    globalSetup: ["./test/global-setup.ts"],
    // The corpus contains long-running real Git and Docker suites. Multiple
    // file workers have repeatedly completed every assertion and then lost
    // the final onTaskUpdate RPC. One worker keeps the coordinator bounded
    // and deterministic; the canonical release gate supplies a 40m ceiling.
    maxWorkers: 1,
    // Several adversarial Git/policy cases spawn real subprocesses. Under the
    // full mutation corpus they can exceed 15 seconds despite completing in
    // under 5 seconds in isolation, so retain a bounded load-aware timeout.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      reportsDirectory: "./coverage",
      // Coverage thresholds — pinned and enforced (t36 / VAL-REL-002).
      // The trust-spine verdict core (completion, convergence, scope, prd,
      // salvage, breaker) and dispatch layer must maintain coverage.
      thresholds: {
        statements: 70,
        branches: 60,
        functions: 70,
        lines: 70,
      },
      // Exclude test files, fixtures, and build artifacts from coverage
      exclude: [
        "test/**",
        "dist/**",
        "scripts/**",
        "node_modules/**",
        "**/*.d.ts",
      ],
    },
  },
});
