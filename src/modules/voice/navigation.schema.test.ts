import { describe, expect, it } from "vitest";
import {
  NavPositionSchema,
  NavSetRouteSchema,
  ROUTE_TOKEN_MAX_LENGTH,
} from "./navigation.schema";

describe("navigation control schemas", () => {
  it("accepts a bounded route token and rejects empty or oversized tokens", () => {
    expect(
      NavSetRouteSchema.safeParse({ routeToken: "route-capability" }).success,
    ).toBe(true);
    expect(NavSetRouteSchema.safeParse({ routeToken: "" }).success).toBe(false);
    expect(
      NavSetRouteSchema.safeParse({
        routeToken: "x".repeat(ROUTE_TOKEN_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });

  it("accepts valid positions and rejects NaN or out-of-range coordinates", () => {
    expect(
      NavPositionSchema.safeParse({ latitude: 25, longitude: 121, accuracy: 8 })
        .success,
    ).toBe(true);
    expect(
      NavPositionSchema.safeParse({ latitude: Number.NaN, longitude: 121 })
        .success,
    ).toBe(false);
    expect(
      NavPositionSchema.safeParse({ latitude: 91, longitude: 121 }).success,
    ).toBe(false);
    expect(
      NavPositionSchema.safeParse({ latitude: 25, longitude: 181 }).success,
    ).toBe(false);
  });
});
