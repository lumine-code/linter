module.exports = {
  root: true,
  extends: "eslint:recommended",
  env: { es2022: true, browser: true, node: true },
  globals: { atom: "readonly" },
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: "commonjs",
    // linter-panel.js authors its view with etch's JSX pragma.
    ecmaFeatures: { jsx: true },
  },
  ignorePatterns: ["node_modules/", ".dev/", "spec/fixtures/"],
  rules: {
    "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    "no-empty": ["error", { allowEmptyCatch: true }],
    "no-constant-condition": ["error", { checkLoops: false }],
  },
};
