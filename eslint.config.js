const js = require("@eslint/js");
const n = require("eslint-plugin-n");
const globals = require("globals");
const prettier = require("eslint-config-prettier");
const jsx = require("./eslint-jsx");

// Modules provided by the Lumine/Electron runtime rather than this package's own
// manifest, so they aren't resolvable by eslint-plugin-n.
const runtimeModules = ["lumine", "electron"];

module.exports = [
  js.configs.recommended,
  n.configs["flat/recommended-script"],
  {
    // Flat config lints only .js/.mjs/.cjs by default, so .jsx must be named
    // or the views drop out of `eslint .` without failing it.
    files: ["**/*.js", "**/*.mjs", "**/*.cjs", "**/*.jsx"],
    settings: {
      // This runs inside the editor's bundled Node 24 runtime, so lint
      // syntax/builtins against that rather than the package's `engines`.
      // tryExtensions lets extensionless requires resolve .jsx files.
      n: {
        version: ">=24.0.0",
        tryExtensions: [".js", ".jsx", ".json", ".node", ".mjs", ".cjs"],
      },
    },
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "commonjs",
      // linter-panel.jsx authors its view in JSX.
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: {
        ...globals.browser,
        ...globals.node,
        lumine: "writable",
      },
    },
    plugins: { jsx },
    rules: {
      // Each file names its own JSX factory in a `/** @jsx ... */` pragma:
      // `require-pragma` insists on it, and `jsx-uses` reads it from there
      // rather than from a default that lives in another repository.
      "jsx/require-pragma": "error",
      "jsx/jsx-uses": "error",
      "no-constant-condition": "off",
      "no-unused-vars": ["warn", { varsIgnorePattern: "^_", argsIgnorePattern: "^_" }],
      "n/no-missing-require": ["error", { allowModules: runtimeModules }],
      "n/no-unpublished-require": ["error", { allowModules: runtimeModules }],
      "n/no-extraneous-require": ["error", { allowModules: runtimeModules }],
      // `localStorage`/`navigator` here are Chromium (renderer) globals, not
      // Node's newer experimental builtins of the same name.
      "n/no-unsupported-features/node-builtins": [
        "error",
        { ignores: ["localStorage", "navigator"] },
      ],
    },
  },
  {
    // Jasmine specs run in the editor's test runner; they load fixtures by paths
    // the resolver can't follow and use the runner's fake-clock helper.
    files: ["spec/**", "**/*-spec.js"],
    languageOptions: {
      globals: {
        ...globals.jasmine,
        advanceClock: "readonly",
        // Waiting primitives injected onto `window` by the editor's spec harness.
        conditionPromise: "readonly",
        emitterEventPromise: "readonly",
        flushMicrotasks: "readonly",
        timeoutPromise: "readonly",
        waitForFrames: "readonly",
      },
    },
    rules: {
      "n/no-missing-require": "off",
      "n/no-unpublished-require": "off",
      "n/no-extraneous-require": "off",
    },
  },
  // Must be last: turns off any lint rules that would conflict with Prettier.
  prettier,
];
