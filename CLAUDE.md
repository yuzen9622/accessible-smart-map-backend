# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm install       # Install deps from pnpm-lock.yaml (postinstall runs build)
pnpm dev           # Dev server with hot reload (nodemon + ts-node via dotenvx)
pnpm build         # Compile TypeScript → dist/ (prebuild runs clean first)
pnpm start         # Run compiled dist/server.js
pnpm clean         # Delete dist/
pnpm test          # Run tests once (vitest)
pnpm test:watch    # Vitest in watch mode
```

Tests use **vitest**; specs live next to the code as `*.test.ts` (e.g. `src/modules/accessible-route/scoring.test.ts`).
We support unit tests and route-level integration tests. The integration test harness uses **supertest** to drive the Express application:

- `buildTestApp()` (from `tests/helpers/test-helpers.ts`) returns the real Express app instance (from `src/app.ts`) without starting the HTTP server or connecting to MongoDB.
- `buildAuthorizationHeader(user?)` (from `tests/helpers/test-helpers.ts`) signs a JWT token and returns a Bearer header string for authenticated routes.
- Mock the service layer with `vi.mock` in test files so that the request exercises router + middleware + validation + controller + envelope without touching the network or DB.

The package manager is **pnpm** (pinned by `packageManager` in `package.json`; `pnpm-lock.yaml` is the only lockfile — there is no `package-lock.json`). Use `pnpm`, not npm/yarn: the `build` / `prebuild` / `postinstall` / `build:otp` scripts call `pnpm run` internally, so running them through npm fails.

Data-import scripts run via dotenvx + ts-node and populate MongoDB from TDX / GTFS / OSM sources — e.g. `pnpm import:gtfs-all`, `pnpm import:tdx-tra`, `pnpm import:osm`. See `package.json` for the full list (`src/scripts/*`).

## Environment Variables

Copy `.env.example` to `.env`. Required variables:

| Variable                                   | Purpose                                                                                 |
| ------------------------------------------ | --------------------------------------------------------------------------------------- |
| `PORT`                                     | Server port (default 5000)                                                              |
| `CORS_ORIGINS`                             | Comma-separated allowed origins                                                         |
| `GOOGLE_MAPS_API_KEY`                      | Google Maps reverse geocoding + Places Text Search                                      |
| `VALHALLA_BASE_URL`                        | Self-hosted Valhalla — drive / motorcycle / walk route planning                         |
| `VALHALLA_DATA_DIR`                        | Host directory containing versioned Valhalla tile releases                              |
| `VALHALLA_PBF_PATH`                        | Host path to the Taiwan OSM PBF used for tile builds                                    |
| `GEMINI_API_KEY`                           | Google Gemini AI (auto-read by `@google/genai` SDK)                                     |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | JWT signing                                                                             |
| `DATABASE_URL`                             | MongoDB connection URI                                                                  |
| `TDX_CLIENT_ID` / `TDX_CLIENT_SECRET`      | Taiwan transport data API credentials                                                   |
| `USE_OTP_ROUTER`                           | OTP2 planner rollout: `false` \| `shadow` (log diff only) \| `true` (merge)             |
| `OTP_BASE_URL`                             | OTP2 sidecar GraphQL server (default `http://localhost:8080`, internal only)            |
| `GEMINI_API_URL`                           | OpenAI-compatible base URL for the AI API (default: Gemini's `/v1beta/openai` endpoint) |
| `GEMINI_MODEL`                             | Model name used by all AI features (default: `gemini-3-flash-preview`)                  |
| `CWA_API_KEY`                              | 中央氣象署 CWA open-data key — weather block of `/a11y/environment`                     |
| `MOENV_API_KEY`                            | 環境部環境資料開放平臺 AQI key（免費註冊會員後取得）                                    |

## Architecture

This is a **layered, single-direction** backend (clean-architecture). A request flows one way and each file's suffix declares its job. Dependencies only point inward/forward — a router never calls a service directly, and a service never touches `req`/`res`.

### Request flow

```
client → src/app.ts (Express, single /api/v1 prefix)
       → modules/<feature>/<feature>.router.ts   transport: path + middleware chain, delegate to one controller
       → [middleware] auth (protected routes) → validateRequest(schema)
       → <feature>.controller.ts                 handler: read req.validated / identity, call ONE service method
       → <feature>.service.ts                    domain: business logic + orchestration, no req/res
       → adapters/*.adapter.ts | model/*.model.ts | config/*
       → sendResponse() → envelope
```

Each module exposes a `createXRouter()` factory via its `index.ts` (the single registration point) and is mounted with one line in `src/app.ts`.

### Layer conventions (where code goes)

| Path                                    | Role                                                                                                                                    |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `src/modules/<feature>/*.router.ts`     | Route + middleware chain; delegates to one controller method                                                                            |
| `src/modules/<feature>/*.schema.ts`     | Zod request schemas (edge validation); registered to OpenAPI                                                                            |
| `src/modules/<feature>/*.controller.ts` | Thin handler: read `req.validated` / identity, call one service, `sendResponse`                                                         |
| `src/modules/<feature>/*.service.ts`    | Business logic + orchestration; no framework objects                                                                                    |
| `src/adapters/*.adapter.ts`             | External I/O clients (`google.adapter.ts` geocoding/Places, `valhalla.adapter.ts` road routing, `tdx.adapter.ts`) — one source per file |
| `src/model/*.model.ts`                  | Mongoose models                                                                                                                         |
| `src/constants/messages.ts`             | Shared message strings (no magic literals)                                                                                              |
| `src/config/*`                          | Shared infra: `lib.ts` (envelope), `jwt.ts`, `redis.ts`, `fetch.ts`, `taipei-time.ts`, `transit.ts`, `ai.ts`, `ai/`                     |
| `src/middleware/`                       | `middleware.ts` (JWT auth gate), `validate-request.middleware.ts`                                                                       |
| `src/openapi/`                          | Schema-driven docs — served at `/docs`, spec at `/api/v1/openapi.json`                                                                  |
| `src/utils/`                            | Pure helpers (e.g. `transit-text.ts`)                                                                                                   |
| `src/types/`                            | Shared types — `code.ts` = `ResponseCode` enum, `express.d.ts` augments `req.validated` / `req.auth`                                    |

> The legacy flat `routes/` / `controller/` / `service/` directories **no longer exist** — everything is under `modules/` + `adapters/`. Place new external I/O in `adapters/`, not a `service/` dir.

### Route groups (all under `/api/v1`)

| Prefix            | Router factory                | Domain                                                   |
| ----------------- | ----------------------------- | -------------------------------------------------------- |
| `/api/v1/user`    | `createUserRouter`            | Auth — **mounted behind `middleware` (JWT)** in `app.ts` |
| `/api/v1/transit` | `createTransitRouter`         | Bus/train real-time data                                 |
| `/api/v1/a11y`    | `createA11yRouter`            | Accessibility places + bathrooms                         |
| `/api/v1/a11y`    | `createAccessibleRouteRouter` | `POST /accessible-route` planner                         |
| `/api/v1/a11y`    | `createNavInstructionsRouter` | Turn-by-turn navigation instructions                     |
| `/api/v1/a11y`    | `createHazardReportRouter`    | Hazard reporting & confirmation                          |
| `/api/v1/a11y`    | `createEnvironmentRouter`     | `GET /environment` pre-trip weather/air/CCTV aggregation |
| `/api/v1/air`     | `createAirRouter`             | Air quality                                              |
| `/api/v1/ai`      | `createAiRouter`              | `/intent`, `/explain`, `/chat`                           |

Several routers share the `/api/v1/a11y` prefix. Only `/api/v1/user` is wrapped in the auth middleware; all other routes are public (or use route-level auth hooks).

The auth middleware (`src/middleware/middleware.ts`) **gates** (token expired → 401, missing/invalid → 403) and bypasses `/login`, `/token`, `/refresh`, `/logout`. On success it now **injects** `req.auth = { userId, user }` (typed in `express.d.ts`), so controllers behind it (e.g. hazard-report's `POST /reports`, `GET /reports/mine`) read identity from `req.auth.userId` instead of re-decoding. Public routes that optionally use a token (e.g. hazard-report's `/confirm`) still call `verifyAccessToken` themselves since the middleware never ran. The JWT payload is `{ user }`. It is mounted whole on `/api/v1/user`, and applied **per-route** elsewhere (the hazard-report router chains it onto just its protected routes).

### Validation

`validateRequest({ body?, query?, params? })` (`src/middleware/validate-request.middleware.ts`) runs Zod schemas at the edge, writes the parsed values to `req.validated` (and overwrites `req.body` / `req.query` / `req.params`). On failure it returns `ResponseCode.INVALID_INPUT` (400) with `{ errors }`.

### Response shape

All controllers use `sendResponse()` from `src/config/lib.ts`:

```ts
{ ok, status, code, message, data?, accessToken? }
```

`code` is the HTTP status from the `ResponseCode` enum (`src/types/code.ts` — currently 200/201/204/205/400/401/403/404/410/429/500/503). Domain-specific error categories go in `data` (e.g. `data.reason`), not in `code`. The refresh token is set as an `httpOnly` cookie, not in the JSON body.

### Agent Chat flow (`POST /api/v1/ai/chat`)

`aiChat` in `src/modules/ai/ai.chat.controller.ts` implements an **OpenAI-compatible streaming agent**:

1. **Request** — `{ model?, messages, stream?, temperature?, userLocation? }` (OpenAI Chat Completions format).
2. **Tool loop (non-streaming)** — the backend calls the LLM with the local tools declared in `src/config/ai/tool.ts`. If the model returns `finish_reason: "tool_calls"`, the matching function in `src/modules/ai/agent-tools.ts` runs and the result feeds back. Repeats up to 5 times.
3. **Streaming response** — the final answer streams as SSE (`event: tool_call`, `event: tool_result`, then OpenAI delta chunks, ending with `data: [DONE]`).

Agent tools include `findGooglePlaces`, `findA11yPlaces`, `planAccessibleRoute`, `getBusArrivalEstimate`, `getBusPosition`, `getAirQuality`, `getA11yFacilityDetails`. The `ai` module also exposes `POST /api/v1/ai/intent` (`aiIntent`) and `POST /api/v1/ai/explain` (`aiExplain`). AI configs (temperature, response schema, tool declarations) live in `src/config/ai/` (`config.ts`, `contents.ts`, `tool.ts`) and `src/config/ai.ts`; default model `gemini-3-flash-preview`.

### TDX transit API

`TdxTokenManager` (exported as the `tdxTokenManager` singleton) in `src/adapters/tdx.adapter.ts` handles OAuth2 `client_credentials` token acquisition + caching for the Taiwan transport data platform. All TDX HTTP calls go through `tdxFetch()` in `src/config/fetch.ts`, which attaches the Bearer token and retries once on 401. Bus route type (city vs. inter-city) is **never inferred from the route name** — TDX has 4-digit routes on both sides with zero overlap (`0557` is a HsinchuCounty city bus, `0968` is inter-city). Instead `busRouteQueryCandidates()` (`src/utils/transit-text.ts`) emits ordered candidate scopes from the caller-supplied `city`, and `fetchRouteScoped()` (`src/modules/transit/bus.service.ts`) probes them in order, taking the first that returns usable rows and memoizing the winning scope for 6 hours.

### MongoDB models (`src/model/*.model.ts`)

- `a11y.model.ts` — MRT elevator/ramp accessibility exits, `2dsphere` index for `$near` geospatial queries.
- `bathroom.model.ts` — accessible bathrooms, also geospatial.
- `user.model.ts` — user accounts.
- Transit/routing data consumed by the accessible-route planner: `bus-stop`, `metro-station`, `train-station`, `osm-a11y`, and the GTFS models (`gtfs-stop`, `gtfs-trip`, `gtfs-pathway`, `gtfs-level`).

### Circuit Breakers

External calls to the OTP planner (for routing and rail geometry) are wrapped in isolated circuit breakers (`createBreaker` in `src/modules/accessible-route/planners/otp-routing.ts`).

- **Breakers**: `planBreaker` and `railGeomBreaker`.
- **Threshold**: Trips after 3 (`BREAKER_THRESHOLD`) consecutive failures, staying open for 60,000ms (`BREAKER_COOLDOWN_MS`).
- **Behavior**: When the main planner circuit is open (`isOtpCircuitOpen()`), the routing service returns `ResponseCode.SERVICE_UNAVAILABLE` (503) with a localized error message (`路線規劃服務暫時忙線，請稍後再試`) so callers can distinguish temporary service outages from a genuine `404 Not Found` (no route exists).

## Agent Gating & Tool Usage Guidelines

This project enforces a dual-agent review process (Cross-Model Review). During the **planning phase** (before the task implementation plan is approved by Codex and approved by the user), the review gate is locked. Follow these tool calling guidelines:

1. **File Reading & Searching (Planning Phase)**:
   - ❌ **Do not** use shell commands via `Bash` (such as `sed`, `grep`, or `cat` combined with pipes `|` or chaining `&&`) to inspect files, unless using the whitelisted read-only combinations below.
   - **Always prefer** native tools for cleaner context and token efficiency:
   - Use `view_file` to read specific file contents (always specify `StartLine` and `EndLine` for section reads).
   - Use `grep_search` for full-text symbol and string searches.

2. **Whitelisted Read-Only Commands**:
   - The following commands are explicitly whitelisted and can be run via `Bash` (even in pipelines with `|`, `&&`, `;`, `\n`) during the planning phase:
     - **Knowledge Graph**: `graphify query "<question>"`, `graphify explain "<concept>"`, `graphify path "<node1>" "<node2>"`
     - **Git Queries**: `git status` (with `-s` / `--short`), `git diff` (with `--name-only` / `--cached` / `--staged`), `git log`, `git show`, `git ls-files`
     - **Sed & Grep**: `sed -n '<range>p' <file>` (must include `-n`), `grep` with search-only flags (`-i`, `-n`, `-w`, `-v`, `-F`, `-E`), and pagers like `head` or `tail`.
     - **Diagnostics**: `locate`, `du`, `df`, `echo` (allowing env vars, rejecting `$()`), `env` / `printenv`, `date`, `whereis`, `which`.

3. **Implementation Restrictions**:
   - All modifying tools (e.g. `Write`, `Edit`, `apply_patch`) and mutating commands (e.g. `git commit`, `pnpm dev`) remain gated and will be blocked until the task plan is fully approved.
