module.exports = {
  semi: true,
  singleQuote: false,
  trailingComma: "all",
  tabWidth: 2,
  printWidth: 100,
  bracketSpacing: true,
  arrowParens: "always",
  endOfLine: "auto",
  overrides: [
    {
      // A .jsonc menu file exists for its comments, not for trailing commas.
      // Prettier's jsonc parser honours `trailingComma` where its json parser
      // forces "none", so without this it puts back what the house rule — and
      // lumine's check:menus — says must not be there.
      files: "*.jsonc",
      options: { trailingComma: "none" },
    },
  ],
};
