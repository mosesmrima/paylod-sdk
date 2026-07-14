import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // types.ts is types-only — it compiles away, so line coverage of it is meaningless.
      exclude: ["src/types.ts"],
      thresholds: { statements: 80, branches: 70, functions: 80, lines: 80 },
    },
  },
});
