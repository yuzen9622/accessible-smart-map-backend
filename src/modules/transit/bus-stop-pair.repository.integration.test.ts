import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  startMongoTest,
  stopMongoTest,
  clearMongoTestDatabase,
  type MongoTestContext,
} from "../../../tests/helpers/mongo-test-harness";
import BusRouteModel from "../../model/bus-route.model";
import GtfsStopAliasModel from "../../model/gtfs-stop-alias.model";
import { findRoutesServingCanonicalPair } from "./bus.repository";
import {
  findOriginalStopsForCanonical,
  findUniqueCanonicalStop,
} from "./stop-alias.repository";
let mongo: MongoTestContext | undefined;
beforeAll(async () => {
  mongo = await startMongoTest();
});
afterAll(async () => stopMongoTest(mongo));
beforeEach(async () => clearMongoTestDatabase());
const stop = (stopUID: string, seq: number) => ({
  stopUID,
  seq,
  stopName: { Zh_tw: stopUID },
  lat: 25,
  lng: 121,
});
const doc = (id: string, stops: ReturnType<typeof stop>[], direction = 0) => ({
  subRouteUid: id,
  routeUid: id,
  city: "Taipei",
  routeName: { Zh_tw: id },
  direction,
  stops,
});
const query = () =>
  findRoutesServingCanonicalPair({
    city: "Taipei",
    canonicalBoardStopId: "A",
    canonicalAlightStopId: "B",
  });
describe("real Mongo ordered pair discovery and alias evidence", () => {
  it("flags a boarding stop that a sibling sub-route of the same route and direction also serves", async () => {
    const branch = (
      id: string,
      stops: ReturnType<typeof stop>[],
      direction = 0,
    ) => ({
      ...doc(id, stops, direction),
      routeUid: "R",
    });
    await BusRouteModel.insertMany([
      branch("main", [stop("A", 1), stop("B", 2)]),
      branch("short", [stop("A", 1), stop("X", 2)]),
      branch("reverse", [stop("A", 1), stop("Y", 2)], 1),
      doc("solo", [stop("A", 1), stop("B", 2)]),
    ]);
    const result = await query();
    expect(
      Object.fromEntries(
        result.routes.map((r) => [r.subRouteUid, r.boardSharedBySibling]),
      ),
    ).toEqual({ main: true, solo: false });
  });
  it("excludes 24 earlier invalid routes before the cap, including reverse/loop/one-stop, and admits route-relative direction 1", async () => {
    await BusRouteModel.insertMany([
      ...Array.from({ length: 24 }, (_, n) =>
        doc(
          `invalid-${n}`,
          n % 3 === 0
            ? [stop("B", 1), stop("A", 2)]
            : n % 3 === 1
              ? [stop("A", 1), stop("A", 2), stop("B", 3)]
              : [stop("A", 1)],
        ),
      ),
      doc("14", [stop("14A", 1), stop("14B", 2)]),
      doc("105", [stop("105A", 2), stop("105B", 5)], 1),
    ]);
    await GtfsStopAliasModel.insertMany([
      ...["14", "105"].flatMap((id) => [
        {
          routeId: id,
          stopId: "A",
          originalStopId: id + "A",
          builtAt: new Date(),
        },
        {
          routeId: id,
          stopId: "B",
          originalStopId: id + "B",
          builtAt: new Date(),
        },
      ]),
    ]);
    const result = await query();
    expect(result.complete).toBe(true);
    expect(result.routes.map((r) => r.subRouteUid)).toEqual(["105", "14"]);
    expect(result.routes.every((r) => r.board.seq < r.alight.seq)).toBe(true);
  });
  it("uses a 25th valid route solely as the incomplete sentinel", async () => {
    await BusRouteModel.insertMany(
      Array.from({ length: 25 }, (_, n) =>
        doc(`route-${String(n).padStart(2, "0")}`, [
          stop("A", 1),
          stop("B", 2),
        ]),
      ),
    );
    const result = await query();
    expect(result.routes).toHaveLength(24);
    expect(result.complete).toBe(false);
    expect(result.routes.at(-1)?.subRouteUid).toBe("route-23");
  });
  it("does not reverse an ambiguous historical alias or expand it across canonical groups", async () => {
    await GtfsStopAliasModel.insertMany([
      {
        routeId: "14_0",
        stopId: "A",
        originalStopId: "14A",
        builtAt: new Date(),
      },
      {
        routeId: "14_0",
        stopId: "old-A",
        originalStopId: "14A",
        builtAt: new Date(),
      },
      {
        routeId: "105_1",
        stopId: "old-A",
        originalStopId: "105A",
        builtAt: new Date(),
      },
    ]);
    expect(await findUniqueCanonicalStop("14_0", "14A")).toBeNull();
    expect((await findOriginalStopsForCanonical(["A"])).get("A")).toEqual([
      "A",
      "14A",
    ]);
  });
});
