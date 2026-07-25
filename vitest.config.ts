import { defineConfig } from "vitest/config"

// Coverage settings for the whole workspace (see vitest.workspace.ts for the
// per-package test configs). Vitest reads `test.coverage` from this root
// config and applies it across every project when run with `--coverage`.
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      // Report coverage of the code the tests actually exercise. The
      // presentational Vue layer and process entrypoints are verified by the
      // build + manual checks, not unit tests, so counting them here would
      // misrepresent how well the tested logic is covered.
      all: false,
      reporter: ["text", "html", "lcov"],
      exclude: [
        "**/*.config.*",
        "**/vitest.workspace.ts",
        "**/dist/**",
        "**/__fixtures__/**",
        "**/__testhelpers__/**",
        "**/*.test.ts",
        "**/*.spec.ts",
        "**/*.d.ts",
        "apps/backend/drizzle/**",
        "website/**",
        // Type-only module — nothing to execute, so coverage on it is noise.
        "apps/backend/src/device/deviceApi.ts",
        // Local, gitignored demo harness for manual UI verification — never
        // committed, but exclude it so a stray copy doesn't skew the report.
        "apps/backend/src/_seed-demo.ts",
      ],
      thresholds: {
        statements: 70,
        branches: 65,
        functions: 70,
        lines: 70,
      },
    },
  },
})
