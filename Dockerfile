# syntax=docker/dockerfile:1
# Multi-stage build for the Node API.
# Runtime uses dist/ + production deps; optional terrain DTM is mounted read-only.
# Accessibility data lives in MongoDB, transit in the OTP sidecar.

FROM opentripplanner/opentripplanner:2.9.0@sha256:a7eac7da397faa9ec9dee407d4204895d24df4981500662fa6793aae0e71fd8f AS otp-upstream

FROM eclipse-temurin:26.0.2_10-jdk-jammy@sha256:67a829749773eb1c5a656ee478cc25b1968f3c0a05d3ba342b4998fce6688f89 AS otp-compile
RUN apt-get update && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*
COPY --from=otp-upstream /app /opt/otp
ADD --checksum=sha256:1027c1639b2a934546f11b3d7b28aec68fe0e7dd802719d5031e6454ff61c79d \
    https://codeload.github.com/opentripplanner/OpenTripPlanner/tar.gz/9babe45ffc9327933129f705c648137ecd96cdbe /tmp/otp-source.tar.gz
WORKDIR /opt/otp-source
RUN tar -xzf /tmp/otp-source.tar.gz --strip-components=1
COPY src/otp/sidewalk-priority.patch /tmp/sidewalk-priority.patch
RUN git apply --check /tmp/sidewalk-priority.patch \
    && git apply /tmp/sidewalk-priority.patch \
    && mkdir -p /opt/overrides/classes /opt/overrides/resources \
    && git apply --numstat /tmp/sidewalk-priority.patch | awk '$3 ~ /\.java$/ { print $3 }' > /tmp/otp-sources \
    && javac -J-Xmx512m --release 25 -proc:none \
       -cp '/opt/otp/classes:/opt/otp/resources:/opt/otp/libs/*' \
       -d /opt/overrides/classes @/tmp/otp-sources \
    && git apply --numstat /tmp/sidewalk-priority.patch | awk '$3 ~ /src\/main\/resources\// { print $3 }' | \
       while read -r source; do \
         resource="${source#*/src/main/resources/}"; \
         mkdir -p "/opt/overrides/resources/$(dirname "$resource")"; \
         cp "$source" "/opt/overrides/resources/$resource"; \
       done

COPY src/otp/NativeWalkPriorityTest.java /tmp/NativeWalkPriorityTest.java
RUN javac -J-Xmx256m --release 25 -proc:none \
      -cp '/opt/overrides/classes:/opt/overrides/resources:/opt/otp/classes:/opt/otp/resources:/opt/otp/libs/*' \
      -d /tmp/otp-tests /tmp/NativeWalkPriorityTest.java \
    && java -Xmx512m -XX:ActiveProcessorCount=2 \
      -cp '/tmp/otp-tests:/opt/overrides/classes:/opt/overrides/resources:/opt/otp/classes:/opt/otp/resources:/opt/otp/libs/*' \
      NativeWalkPriorityTest

FROM otp-upstream AS otp-runtime
COPY --from=otp-compile /opt/overrides/classes /app/classes
COPY --from=otp-compile /opt/overrides/resources /app/resources

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
