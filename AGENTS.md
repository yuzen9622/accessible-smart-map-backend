# AGENTS Operating Rules — accessible-smart-map-backend

Highest-priority rulebook for any agent (or human) editing this repo. Read it in
full before changing code. It encodes the architecture the codebase already
follows; new code must look like the existing code.

## 0) Environment

- OS: macOS · Shell: zsh
- Package manager: **pnpm** (do not use npm/yarn). Version pinned by `packageManager` in `package.json`; `pnpm-lock.yaml` is the only lockfile. The `build` / `prebuild` / `postinstall` scripts call `pnpm run` internally, so invoking them through npm fails.
- Commands:
  - install: `pnpm install` (CI/Docker: `pnpm install --frozen-lockfile`)
  - dev: `pnpm dev`
  - build / typecheck: `pnpm build` (runs `lint:arch` then `tsc`)
  - boundary check only: `pnpm lint:arch`
  - tests: `pnpm test` (`vitest run`) · watch: `pnpm test:watch`; specs live beside code as `*.test.ts`.

## 1) Mandatory read order before any edit

1. This file (`AGENTS.md`).
2. The `clean-backend-architecture` skill + its `references/layer-contracts.md`.
3. `docs/reports/architecture-audit.md` (the current scorecard + migration log).
4. The target feature files under `src/modules/<feature>/` before changing them.

Do not start code changes until 1–4 are done. When unsure where code goes, find
the matching layer in the contracts — never guess.

## 2) Non-negotiable conventions (the 6 invariants, in our names)

1. **One file, one responsibility — filename says which.**
   `*.router.ts` / `*.schema.ts` / `*.controller.ts` / `*.service.ts` /
   `planners/*.ts` (domain helpers) / shared types in `src/types/`.
2. **Single-direction dependency:** router → controller → service →
   planners / adapters / models. Never backward; a service never imports a
   controller/router or touches `req`/`res`; a controller never queries a model
   or calls an external API directly; a controller never imports another module.
3. **Validate at the edge** with Zod via `validateRequest({ body|query|params })`
   in the router. The middleware writes the parsed value back onto `req.*`, so
   controllers read already-validated, coerced, strict input. Schemas are
   `.strict()`. Don't re-validate request shape in inner layers.
4. **One response envelope:** every response goes through `sendResponse(...)`
   (`src/config/lib.ts`). No ad-hoc `res.json({...})` envelopes.
5. **No magic literals:** HTTP status from the `ResponseCode` enum
   (`src/types/code.ts`); repeated messages from `MSG` / `ERROR_MESSAGE`
   (`src/constants/messages.ts`); external URLs as named constants in `config/`.
6. **One registration point:** every route mounts under `/api/v1` in
   `src/app.ts`, via one `createXRouter()` exported from `modules/<feature>/index.ts`.

Project specifics:
- `modules/<feature>/` holds a feature's router/controller/service/schema + its
  own helpers. The accessible-route routing engine's internals live in
  `modules/accessible-route/planners/`.
- Cross-cutting external API clients → `src/adapters/*.adapter.ts`
  (`google.adapter`, `tdx.adapter`). Shared pure helpers → `src/utils/`.
  `config/` holds ONLY config: client init, URL constants, env, time/redis/jwt.
- Protected routes (`/api/v1/user/*`) pass through the JWT `middleware`.
- API docs are generated from the Zod schemas (Scalar UI at `/docs`,
  `/api/v1/openapi.json`); keep schemas in sync when changing a route.
- A cross-module domain function is imported from the other module's **service
  file directly** when the module barrel (`index.ts`) would create an import
  cycle (see `accessible-route.service` → `../ai/ai.service`).

## 3) Per-task execution checklist

1. Determine change type (auth/session vs plain data endpoint vs shared infra).
2. Place each piece in its layer (§2); nothing in the wrong lane.
3. Register the router at `modules/<feature>/index.ts` and mount it once in
   `src/app.ts` under `/api/v1`.
4. Update `.env.example` when adding a required env var.
5. Run `pnpm build` — must be green (this also runs `lint:arch`).
6. Run and verify any modified or added scripts (like Python tools, build pipelines) locally on actual or mock data to prove correctness before committing.

## 4) Handoff requirements

- List changed files and why each changed.
- Confirm the endpoint mount path(s).
- Confirm `pnpm build` result (pass/fail) — "done" means green, not "written".
- List risks, assumptions, and TODOs.

## 5) Enforcement (kept honest by tooling, not memory)

- **Import-boundary check:** `pnpm lint:arch`
  (`scripts/check-architecture.mjs`) — fails the build when a layer boundary is
  crossed. Grandfather a not-yet-migrated file via its `ALLOWLIST`, and delete
  the entry in the same change that migrates it.
- **Schema-as-contract:** OpenAPI docs are generated from the request schemas.
- **Green build gate:** `pnpm build` runs the boundary check before `tsc`.
- Rationale for non-obvious decisions lives under `docs/reports/`.
