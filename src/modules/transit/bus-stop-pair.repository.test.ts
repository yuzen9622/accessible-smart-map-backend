import { describe, expect, it, vi } from "vitest";
const { aggregate, aliases } = vi.hoisted(() => ({
  aggregate: vi.fn(),
  aliases: vi.fn(),
}));
vi.mock("mongoose", () => ({
  default: {
    connection: { readyState: 1 },
    ConnectionStates: { connected: 1 },
  },
}));
vi.mock("../../model/bus-route.model", () => ({ default: { aggregate } }));
vi.mock("../../model/bus-vehicle.model", () => ({ default: {} }));
vi.mock("../../model/bus-stop.model", () => ({ default: {} }));
vi.mock("./stop-alias.repository", () => ({
  expandOriginalStopsForCanonical: aliases,
}));
import { findRoutesServingCanonicalPair } from "./bus.repository";
describe("validity-before-cap Mongo query", () => {
  it("validates unique occurrences and ordered sequence in Mongo before sorting and overflow limit", async () => {
    aliases.mockResolvedValue({
      complete: true,
      stops: new Map([
        ["A", ["A", "14-A", "105-A"]],
        ["B", ["B", "14-B", "105-B"]],
      ]),
    });
    const option = vi
      .fn()
      .mockResolvedValue(
        Array.from({ length: 25 }, (_, n) => ({ subRouteUid: `valid-${n}` })),
      );
    aggregate.mockReturnValue({ option });
    const result = await findRoutesServingCanonicalPair({
      city: "Taipei",
      canonicalBoardStopId: "A",
      canonicalAlightStopId: "B",
    });
    expect(result.routes).toHaveLength(24);
    expect(result.complete).toBe(false);
    const pipeline = aggregate.mock.calls[0][0];
    expect(pipeline[2]).toEqual({
      $match: {
        $expr: {
          $and: [
            { $eq: [{ $size: "$_boards" }, 1] },
            { $eq: [{ $size: "$_alights" }, 1] },
          ],
        },
        direction: { $in: [0, 1] },
      },
    });
    expect(pipeline[4]).toEqual({
      $match: { $expr: { $lt: ["$board.seq", "$alight.seq"] } },
    });
    expect(pipeline.findIndex((s: object) => "$limit" in s)).toBe(6);
    expect(pipeline[6]).toEqual({ $limit: 25 });
    expect(option).toHaveBeenCalledWith({ maxTimeMS: 1500 });
  });
  it("propagates an alias expansion overflow as an incomplete search", async () => {
    aliases.mockResolvedValue({
      complete: false,
      stops: new Map([
        ["A", ["A"]],
        ["B", ["B"]],
      ]),
    });
    aggregate.mockReturnValue({
      option: vi.fn().mockResolvedValue([{ subRouteUid: "105" }]),
    });
    expect(
      await findRoutesServingCanonicalPair({
        city: "Taipei",
        canonicalBoardStopId: "A",
        canonicalAlightStopId: "B",
      }),
    ).toEqual({ routes: [{ subRouteUid: "105" }], complete: false });
  });
  it("marks an exhausted valid result complete (including an empty set)", async () => {
    aliases.mockResolvedValue({
      complete: true,
      stops: new Map([
        ["A", ["A"]],
        ["B", ["B"]],
      ]),
    });
    for (const rows of [[], [{ subRouteUid: "105" }]]) {
      aggregate.mockReturnValue({ option: vi.fn().mockResolvedValue(rows) });
      expect(
        await findRoutesServingCanonicalPair({
          city: "Taipei",
          canonicalBoardStopId: "A",
          canonicalAlightStopId: "B",
        }),
      ).toEqual({ routes: rows, complete: true });
    }
  });
});
