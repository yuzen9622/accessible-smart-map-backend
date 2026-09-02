import { describe, expect, it } from "vitest";
import {
  NavProgressSchema,
  NavRerouteFailedMessageSchema,
  NavReroutingMessageSchema,
} from "./voice.ws.schema";

describe("voice reroute outbound schemas", () => {
  const correlation = {
    navigationId: "11111111-1111-4111-8111-111111111111",
    previousRouteVersion: 3,
  };

  it("requires the client UUID on the strict nav.rerouting contract", () => {
    const payload = {
      type: "nav.rerouting",
      ...correlation,
      clientRequestId: "22222222-2222-4222-8222-222222222222",
    };
    expect(NavReroutingMessageSchema.parse(payload)).toEqual(payload);
    expect(
      NavReroutingMessageSchema.safeParse({
        ...payload,
        clientRequestId: "not-a-uuid",
      }).success,
    ).toBe(false);
    expect(
      NavReroutingMessageSchema.safeParse({
        ...payload,
        unexpectedField: true,
      }).success,
    ).toBe(false);
  });

  it("requires the complete stale-correlation and retry contract on failure", () => {
    const payload = {
      type: "nav.reroute_failed",
      ...correlation,
      code: 503,
      message: "Redis unavailable",
      retryable: true,
    };
    expect(NavRerouteFailedMessageSchema.parse(payload)).toEqual(payload);
    for (const field of [
      "navigationId",
      "previousRouteVersion",
      "code",
      "message",
      "retryable",
    ] as const) {
      const incomplete = { ...payload } as Record<string, unknown>;
      delete incomplete[field];
      expect(NavRerouteFailedMessageSchema.safeParse(incomplete).success).toBe(
        false,
      );
    }
  });
});

describe("nav.progress outbound schema", () => {
  const payload = {
    type: "nav.progress" as const,
    navigationId: "11111111-1111-4111-8111-111111111111",
    routeVersion: 2,
    currentStepIndex: 0,
    remainingDistanceM: 1200.5,
    remainingDurationSec: 940,
    estimatedArrivalAt: "2026-01-01T00:15:40.000Z",
    etaSource: "realtime" as const,
    distanceToNextM: 42,
  };

  it("accepts a complete progress frame including a null distanceToNextM", () => {
    expect(NavProgressSchema.parse(payload)).toEqual(payload);
    expect(
      NavProgressSchema.safeParse({ ...payload, distanceToNextM: null })
        .success,
    ).toBe(true);
  });

  it("rejects an uncorrelated, negative, or unknown-source frame", () => {
    for (const invalid of [
      { navigationId: "nav-1" },
      { routeVersion: 0 },
      { currentStepIndex: -1 },
      { remainingDistanceM: -1 },
      { remainingDurationSec: -1 },
      { distanceToNextM: -1 },
      { etaSource: "guessed" },
    ]) {
      expect(
        NavProgressSchema.safeParse({ ...payload, ...invalid }).success,
      ).toBe(false);
    }
    for (const field of [
      "navigationId",
      "routeVersion",
      "currentStepIndex",
      "remainingDistanceM",
      "remainingDurationSec",
      "estimatedArrivalAt",
      "etaSource",
      "distanceToNextM",
    ] as const) {
      const incomplete = { ...payload } as Record<string, unknown>;
      delete incomplete[field];
      expect(NavProgressSchema.safeParse(incomplete).success).toBe(false);
    }
  });
});
