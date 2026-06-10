import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";
import importX from "eslint-plugin-import-x";
import { createTypeScriptImportResolver } from "eslint-import-resolver-typescript";

export default [
  {
    ignores: ["dist/**", "coverage/**", "node_modules/**", "winston/**", ".tmp*/**", "vendor/**", "*.cjs", "*.mjs", "!scripts/**/*.mjs"],
  },
  {
    files: ["index.ts", "lib/**/*.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        project: "./tsconfig.json",
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
    },
    rules: {
      // TypeScript strict rules
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/no-non-null-assertion": "warn",
      
      // Promise handling (catch unhandled promises and misuse)
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/require-await": "warn",
      
      // General best practices
      // request-10: guard lib internals against stray console output that should
      // go through the structured logger (which masks tokens/emails). The genuine
      // CLI/UI output surface (commands, help, the CLI entrypoints, the injectable
      // device-auth log sink) is re-allowed in the override block below, so this
      // only fires on NEW leaks in non-CLI library code.
      "no-console": "error",
      "prefer-const": "error",
      "no-var": "error",
      "eqeqeq": ["error", "always"],
      "no-duplicate-imports": "error",
    },
  },
  {
    // audit 4.1.6: keep the lib/ module graph acyclic. The dependency direction
    // is types/constants -> storage -> accounts -> runtime -> manager/CLI;
    // shared types/helpers must live in (or move to) the lower layer instead of
    // being imported back from a higher one. Scoped to lib/** and index.ts —
    // scripts/ and test/ are intentionally out of scope for now.
    files: ["index.ts", "lib/**/*.ts"],
    plugins: {
      "import-x": importX,
    },
    settings: {
      // Without this, import-x treats .ts files as unparseable and silently
      // skips cycle detection (its default ExportMap extensions are .js-only).
      "import-x/extensions": [".ts"],
      "import-x/resolver-next": [
        createTypeScriptImportResolver({ project: "./tsconfig.json" }),
      ],
    },
    rules: {
      "import-x/no-cycle": ["error", { maxDepth: Infinity, ignoreExternal: true }],
    },
  },
  {
    // CLI / UI / human-output surface: console IS the intended output channel
    // here (the tool prints to stdout/stderr for the user), so `no-console` stays
    // off. Keep this list tight — library internals must use the logger.
    files: [
      "index.ts",
      "lib/cli.ts",
      "lib/codex-manager.ts",
      "lib/codex-manager/**/*.ts",
      "lib/auth/device-auth.ts",
    ],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        project: "./tsconfig.json",
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
    },
    rules: {
      "no-console": "off",
    },
  },
  {
    files: ["scripts/**/*.js", "scripts/**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
    },
    rules: {
      "no-console": "off",
      "prefer-const": "error",
      "no-var": "error",
      "eqeqeq": ["error", "always"],
      "no-duplicate-imports": "error",
    },
  },
  {
    files: ["test/**/*.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
    },
    rules: {
      // Relax rules for test files
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "no-duplicate-imports": "off",
    },
  },
];

