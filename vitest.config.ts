import { defineConfig } from "vitest/config";

// Minimal unit-test setup. Scoped to src/**/*.test.ts so the pure-function
// scoring tests run in isolation; the live-server integration script under
// tests/ (axios → a running API) is intentionally excluded.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    // ranking.test.ts imports the service, which transitively constructs an
    // OpenAI client at module load (src/config/ai.ts). The client is never
    // called in tests — a dummy key just lets the constructor succeed without
    // depending on a real .env.
    env: {
      GEMINI_API_KEY: "test-dummy",
      OPENAI_API_KEY: "test-dummy",
      // Lets buildAuthorizationHeader() sign tokens the auth middleware can
      // verify (tests/helpers/test-helpers.ts) for route-level integration tests.
      // The refresh secret is needed too: the auth endpoints issue an access and
      // a refresh token together, and jwt.sign throws on an empty secret.
      JWT_ACCESS_SECRET: "test-access-secret",
      JWT_REFRESH_SECRET: "test-refresh-secret",
    },
    coverage: {
      provider: "v8",
      // Covers the whole src/ tree — Vitest 4 automatically folds in files no
      // test imports when a full run happens. Test files, setup files and the
      // vitest config are excluded automatically by Vitest itself.
      include: ["src/**/*.ts"],
      // Coordinator-approved exclusions (2026-08-15) — do not extend further:
      exclude: [
        // One-off import/migration/eval/smoke CLI scripts that require live
        // external services (TDX, GTFS feeds, DB, Redis); not runtime business
        // modules reachable from the API.
        "src/scripts/**",
        // Pure type declarations — no runtime statements.
        "src/types/**",
        // Pure barrel re-exports that only register each module's router.
        "src/modules/*/index.ts",
      ],
      reporter: ["text", "json-summary", "html"],
      // Coordinator-approved global thresholds (baseline lock, 2026-08-15):
      // ratchet up, never down. `vitest run --coverage` exits non-zero when
      // any metric drops below, which gates CI.
      thresholds: {
        statements: 68,
        branches: 58,
        functions: 70,
        lines: 70,
      },
    },
  },
});
