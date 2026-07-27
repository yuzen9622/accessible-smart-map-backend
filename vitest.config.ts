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
  },
});
