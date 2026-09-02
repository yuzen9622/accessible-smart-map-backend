import { describe, expect, it } from "vitest";
import {
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
