import js from "@eslint/js"
import tseslint from "typescript-eslint"
import vue from "eslint-plugin-vue"
import vueParser from "vue-eslint-parser"
import globals from "globals"
import prettier from "eslint-config-prettier"

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/build/**",
      "**/node_modules/**",
      "**/*.d.ts",
      "apps/backend/drizzle/**",
      "website/.vitepress/cache/**",
      "website/.vitepress/dist/**",
      "**/__fixtures__/**",
      "pnpm-lock.yaml",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...vue.configs["flat/recommended"],

  // Backend + shared + docs-site tooling + any plain script: Node globals.
  {
    files: [
      "apps/backend/**/*.{ts,mjs,cjs}",
      "packages/shared/**/*.ts",
      "website/**/*.ts",
      "*.ts",
      "*.mjs",
      "*.cjs",
      "**/*.mjs",
      "**/*.cjs",
    ],
    languageOptions: {
      globals: globals.node,
    },
  },

  // Frontend: browser globals for app code + Vue SFCs. Also covers
  // vite.config.ts/vitest.config.ts, which run under Node — union of both
  // globals is harmless (unused globals never trigger a lint error).
  {
    files: ["apps/web/**/*.ts", "apps/web/**/*.vue"],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },

  // .vue SFCs: parse <script> with the TS parser via vue-eslint-parser.
  {
    files: ["**/*.vue"],
    languageOptions: {
      parser: vueParser,
      parserOptions: {
        parser: tseslint.parser,
        extraFileExtensions: [".vue"],
      },
    },
  },

  {
    files: ["**/*.ts", "**/*.vue"],
    rules: {
      // The engine/device layers key everything on serial numbers and pass
      // structured records around — an explicit `any` is occasionally the
      // clearest way to model a boundary (e.g. raw smartctl JSON). Warn
      // instead of error so it stays visible without blocking the build.
      "@typescript-eslint/no-explicit-any": "warn",
      // Allow intentional discards via a leading underscore (fire-and-forget
      // promises, placeholder args) instead of erroring on them.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },

  {
    // Vuetify's data-table (and similar) components use dotted slot names
    // like `item.status` — eslint-plugin-vue parses the dot as a v-slot
    // modifier unless told this pattern is expected.
    files: ["apps/web/**/*.vue"],
    rules: {
      "vue/valid-v-slot": ["error", { allowModifiers: true }],
    },
  },

  // Test files commonly stub things with `any`/loose fixtures.
  {
    files: ["**/*.test.ts", "**/__testhelpers__/**"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },

  // eslint-config-prettier last: turn off stylistic rules that would fight
  // Prettier's formatting.
  prettier,
)
