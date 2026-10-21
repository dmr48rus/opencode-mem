import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import globals from "globals";
import ts from "typescript-eslint";

export default ts.config(
  {
    ignores: [
      "coverage/**",
      "dist/**",
      "node_modules/**",
      "out/**",
      // The memory server ships inside this repository but is a separate tool
      // with its own gate (.preflight.json) and its own house style. Linting it
      // with the plugin's rules only produces errors about variables that were
      // never wrong, and fixing them here would edit code this repository does
      // not own.
      "aletheia_server/**",
      "web/dist/**",
      "web/node_modules/**",
    ],
  },
  js.configs.recommended,
  ...ts.configs.recommended,
  prettier,
  {
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.bun,
        ...globals.node,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    files: ["web/src/**/*.svelte.ts", "web/src/**/*.svelte.js"],
    languageOptions: {
      parserOptions: {
        extraFileExtensions: [".svelte"],
      },
    },
  }
);
