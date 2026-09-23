import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/coverage/**",
      "**/playwright-report/**",
      "**/test-results/**",
      "**/generated/**"
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
      },
      parserOptions: {
        ecmaFeatures: { jsx: true }
      }
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": ["error", { "argsIgnorePattern": "^_" }]
    }
  },
  {
    // Plain CommonJS preload scripts (the E2E egress guard), which must run before any TypeScript
    // tooling exists in the process.
    files: ["**/*.cjs"],
    languageOptions: { sourceType: "commonjs", globals: { ...globals.node } },
    rules: { "@typescript-eslint/no-require-imports": "off" }
  },
  {
    // The data-correctness audit's reference implementations must stay independent of the
    // production logic they check: an oracle that imported the engine would agree with every bug
    // it exists to find (docs/data-correctness-audit/README.md).
    files: ["apps/api/src/data-correctness-audit/oracle/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [{
          group: ["@intrinsic/*", "../*", "@prisma/*"],
          message: "Audit oracles may import only primitives (decimal.js) and each other."
        }]
      }]
    }
  },
  {
    // Every Playwright spec runs on the shared fixtures (E2E-006): the logo stub and the provider
    // image block apply to a test only if its `test` comes from `e2e/fixtures.ts`.
    files: ["apps/web/e2e/**/*.ts"],
    ignores: ["apps/web/e2e/fixtures.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        paths: [{
          name: "@playwright/test",
          importNames: ["test"],
          message: "Import `test` from e2e/fixtures.ts so the shared hermetic-browser fixtures apply."
        }]
      }]
    }
  }
);
