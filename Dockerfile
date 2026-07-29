# syntax=docker/dockerfile:1
# Multi-stage build for the Node API.
# Runtime needs only dist/ + production deps — the app reads no files from disk
# at runtime (a11y data lives in MongoDB, transit in the OTP sidecar).

# ── builder: full deps + compile TS → dist ──────────────────────────────────
FROM node:22-bookworm-slim AS builder
# pnpm is the package manager (package.json "scripts" call `pnpm run`); corepack
# activates the exact version pinned in package.json "packageManager".
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# Set registry network resilience variables (retry on network failure e.g. ECONNRESET)
ENV NPM_CONFIG_FETCH_RETRIES=5
ENV NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=20000
ENV NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=120000
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml tsconfig.json ./
# --ignore-scripts skips the `postinstall: pnpm run build` hook here: src/ isn't
# copied yet, so an automatic build would fail. We build explicitly below.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts
COPY src ./src
RUN pnpm run build

# ── runtime: production deps + compiled output only ─────────────────────────
FROM node:22-bookworm-slim AS runtime
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# Set registry network resilience variables (retry on network failure e.g. ECONNRESET)
ENV NPM_CONFIG_FETCH_RETRIES=5
ENV NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=20000
ENV NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=120000
RUN corepack enable
WORKDIR /app
ENV NODE_ENV=production
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --prod --frozen-lockfile --ignore-scripts
COPY --from=builder /app/dist ./dist
# Drop privileges — the node image ships a non-root `node` user.
USER node
# Documentation only; the real port comes from PORT in the injected env.
EXPOSE 8000
CMD ["node", "dist/server.js"]
