import { describe, expect, it } from "vitest";
import {
  NavProgressSchema,
  NavRerouteFailedMessageSchema,
  NavReroutingMessageSchema,
  NavResumeFailedMessageSchema,
  NavResumeMessageSchema,
  NavResumeOkMessageSchema,
  VoiceControlMessageSchema,
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

describe("nav.resume inbound schema", () => {
  const payload = {
    type: "nav.resume",
    navigationId: "nav-1",
    routeVersion: 2,
    routeToken: "token",
    lastKnownStepIndex: 4,
  };

  it("accepts a resume frame with and without a position", () => {
    expect(NavResumeMessageSchema.parse(payload)).toMatchObject(payload);
    expect(
      NavResumeMessageSchema.parse({
        ...payload,
        currentPosition: { latitude: 25, longitude: 121, heading: 90 },
      }).currentPosition,
    ).toEqual({ latitude: 25, longitude: 121, heading: 90 });
  });

  it("is routable through the authenticated control union", () => {
    const parsed = VoiceControlMessageSchema.parse(payload);
    expect(parsed.type).toBe("nav.resume");
  });

  it.each([
    ["an empty navigationId", { navigationId: "" }],
    ["a zero routeVersion", { routeVersion: 0 }],
    ["a fractional routeVersion", { routeVersion: 1.5 }],
    ["an empty routeToken", { routeToken: "" }],
    ["a negative lastKnownStepIndex", { lastKnownStepIndex: -1 }],
    [
      "an out-of-range position",
      { currentPosition: { latitude: 200, longitude: 121 } },
    ],
  ])("rejects %s", (_label, invalid) => {
    expect(
      NavResumeMessageSchema.safeParse({ ...payload, ...invalid }).success,
    ).toBe(false);
  });
});

describe("nav.resume outbound schemas", () => {
  const okPayload = {
    type: "nav.resume_ok",
    navigationId: "nav-1",
    routeVersion: 2,
    routeToken: "token",
    currentStepIndex: 1,
    totalSteps: 3,
    onVehicle: false,
    steps: [
      {
        index: 0,
        instruction: "向前走",
        legType: "WALK",
        distanceM: 50,
        isTransit: false,
      },
    ],
  };

  it("carries the authoritative progress the client must adopt", () => {
    expect(NavResumeOkMessageSchema.parse(okPayload)).toEqual(okPayload);
  });

  it("rejects unknown keys and an out-of-contract step", () => {
    expect(
      NavResumeOkMessageSchema.safeParse({ ...okPayload, extra: 1 }).success,
    ).toBe(false);
    expect(
      NavResumeOkMessageSchema.safeParse({
        ...okPayload,
        steps: [{ index: 0, instruction: "x", legType: "PLANE" }],
      }).success,
    ).toBe(false);
  });

  it.each([
    "INVALID_REQUEST",
    "SNAPSHOT_NOT_FOUND",
    "USER_MISMATCH",
    "ROUTE_VERSION_MISMATCH",
    "ROUTE_EXPIRED",
  ])("accepts the %s failure code", (code) => {
    expect(
      NavResumeFailedMessageSchema.parse({
        type: "nav.resume_failed",
        navigationId: "nav-1",
        code,
        message: "nope",
        retryable: false,
      }).code,
    ).toBe(code);
  });

  it("rejects an unknown failure code", () => {
    expect(
      NavResumeFailedMessageSchema.safeParse({
        type: "nav.resume_failed",
        navigationId: "nav-1",
        code: "WHATEVER",
        message: "nope",
        retryable: false,
      }).success,
    ).toBe(false);
  });
});
