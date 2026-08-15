// ESLint 9 flat config.
//
// Rule-set decisions (see TASK2_CODE_ENGINEERING.md, task 2/5):
// - We deliberately use `typescript-eslint`'s NON-type-aware `recommended`
//   preset. Type-aware presets (`strict-type-checked` /
//   `recommended-type-checked`) require building the full program graph; on a
//   47k-line backend that is very slow and produces a flood of violations.
//   The cost: `no-floating-promises` is NOT enabled (it needs type info).
// - `eslint-config-prettier` is applied LAST so every formatting rule
//   conflicting with Prettier is switched off; Prettier is the single source
//   of truth for formatting.
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: [
      "dist/",
      "node_modules/",
      "data/",
      "otp-data/",
      "valhalla-data/",
      "graphify-out/",
    ],
  },

  // Base: typescript-eslint `recommended` (non-type-aware) on top of ESLint's
  // own `recommended`, with the TS-specific overrides.
  ...tseslint.configs.recommended,

  {
    rules: {
      // === Rules that catch real bugs — enabled as errors ===

      // Disallow `==`/`!=` except the deliberate `== null` nullish check,
      // which this codebase uses extensively (`x == null` covers undefined).
      eqeqeq: ["error", "always", { null: "ignore" }],

      // `var` has block-scope footguns; `let`/`const` are the only styles used
      // in new code.
      "no-var": "error",

      // The repo convention is `_req` / `_res` / `_next` for unused
      // parameters at the edge of middleware chains — keep them allowed.
      // `ignoreRestSiblings` covers the deliberate `const { ok, ...data } =
      // result` pattern used across controllers to strip the envelope flag
      // out of the spread payload (the binding itself is intentionally unused).
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],

      // === Rules relaxed to warn because the codebase is full of them ===
      //
      // `any` is used intentionally at the boundary with external SDKs and in
      // mocks. Forcing every occurrence to `unknown` would require touching
      // business logic, which this task forbids. Kept as warnings so the
      // occurrences stay visible in `pnpm lint` output.
      "@typescript-eslint/no-explicit-any": "warn",

      // `!` non-null assertions are spread across the codebase. Replacing all
      // of them with narrowing would be a behavior-adjacent refactor, out of
      // scope for the linting task. Warnings keep them greppable.
      "@typescript-eslint/no-non-null-assertion": "warn",
    },
  },

  // === Per-file overrides ===
  {
    files: ["src/config/redis.ts"],
    rules: {
      // typescript-eslint prefer-const false positive: `timer` IS reassigned
      // in this same scope (`timer = setTimeout(...)` in the promise executor),
      // but the rule misses the write through the closure and would autofix it
      // to `const`, which is a TS error (verified with a minimal repro). The
      // code is correct as written; keep `let`.
      "prefer-const": "off",
    },
  },

  // Must be last: disables every core/TS formatting rule that Prettier owns.
  prettier,
);
