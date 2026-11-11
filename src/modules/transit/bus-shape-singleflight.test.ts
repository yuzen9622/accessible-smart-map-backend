import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../config/fetch", () => ({ tdxFetch: vi.fn() }));
vi.mock("../../model/bus-route.model", () => ({ default: { find: vi.fn() } }));
vi.mock("../../model/bus-vehicle.model", () => ({
  default: { find: vi.fn() },
}));
vi.mock("../../model/bus-stop.model", () => ({
  default: { aggregate: vi.fn() },
}));
vi.mock("../../adapters/google.adapter", () => ({ getCity: vi.fn() }));
vi.mock("../../config/redis", () => ({ redisGet: vi.fn(), redisSet: vi.fn() }));

import { tdxFetch } from "../../config/fetch";
import { redisGet, redisSet } from "../../config/redis";
import BusRouteModel from "../../model/bus-route.model";
import { getBusRouteDetail } from "./bus.service";
import { TaiwanCityEn } from "../../types/transit";

const path = [
  [121.45, 25.02],
  [121.56, 25.06],
];
const rows = [
  {
    SubRouteUID: "sub",
    Direction: 0,
    Geometry: "LINESTRING (121.45 25.02, 121.56 25.06)",
  },
];
const shapes = [{ subRouteUid: "sub", direction: 0, path }];
const response = (data: unknown) =>
  ({ ok: true, json: async () => data }) as Response;
const shapeUrls = () =>
  vi
    .mocked(tdxFetch)
    .mock.calls.map(([url]) => String(url))
    .filter((url) => url.includes("/Bus/Shape/"));
const detail = (routeName = "B5", city = TaiwanCityEn.Taipei) =>
  getBusRouteDetail({ routeName, city });
function polyline(result: Awaited<ReturnType<typeof detail>>) {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("route detail failed");
  return result.directions[0].polyline;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  const lean = async () => [
    {
      routeUid: "route",
      subRouteUid: "sub",
      subRouteName: { Zh_tw: "B5" },
      routeName: { Zh_tw: "B5" },
      direction: 0,
      stops: [
        { seq: 1, stopName: { Zh_tw: "起站" }, lat: 25.02, lng: 121.45 },
        { seq: 2, stopName: { Zh_tw: "末站" }, lat: 25.06, lng: 121.56 },
      ],
    },
  ];
  vi.mocked(BusRouteModel.find).mockReturnValue({
    lean,
    select: () => ({ lean }),
  } as never);
  vi.mocked(redisGet).mockResolvedValue(null);
  vi.mocked(redisSet).mockResolvedValue(undefined);
  vi.mocked(tdxFetch).mockImplementation(async (url) =>
    response(String(url).includes("/Bus/Shape/") ? rows : []),
  );
});
afterEach(() => vi.restoreAllMocks());

describe("bus shape in-flight ownership through route detail", () => {
  it("shares overlapping misses, clones leader and waiter, then refetches after settlement", async () => {
    const upstream = deferred<Response>();
    const bothRead = deferred<void>();
    let reads = 0;
    vi.mocked(redisGet).mockImplementation(async () => {
      if (++reads === 2) bothRead.resolve();
      return null;
    });
    vi.mocked(tdxFetch).mockImplementation(async (url) =>
      String(url).includes("/Bus/Shape/") ? upstream.promise : response([]),
    );
    const first = detail("B5-overlap");
    const second = detail("B5-overlap");
    await bothRead.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    const concurrentCalls = shapeUrls().length;
    upstream.resolve(response(rows));
    const [a, b] = await Promise.all([first, second]);
    expect(concurrentCalls).toBe(1);
    expect(polyline(a)).toEqual(path);
    expect(polyline(b)).toEqual(polyline(a));
    expect(polyline(a)).not.toBe(polyline(b));
    polyline(a)![0][0] = 0;
    expect(polyline(b)).toEqual(path);
    expect(JSON.parse(vi.mocked(redisSet).mock.calls[0][1] as string)).toEqual(
      shapes,
    );
    expect(redisSet).toHaveBeenCalledTimes(1);
    await detail("B5-overlap");
    expect(shapeUrls()).toHaveLength(2);
    expect(redisSet).toHaveBeenLastCalledWith(
      "bus:shape:v3:Taipei:B5-overlap",
      JSON.stringify(shapes),
      86400,
    );
  });

  it("does not merge cities or full trunk route names", async () => {
    const upstream = deferred<Response>();
    vi.mocked(tdxFetch).mockImplementation(async (url) =>
      String(url).includes("/Bus/Shape/") ? upstream.promise : response([]),
    );
    const pending = [
      detail("忠孝幹線"),
      detail("信義幹線"),
      detail("忠孝幹線", TaiwanCityEn.Taichung),
    ];
    await vi.waitFor(() => expect(shapeUrls()).toHaveLength(3));
    upstream.resolve(response(rows));
    const results = await Promise.all(pending);
    results.forEach((result) => expect(polyline(result)).toEqual(path));
    expect(
      vi
        .mocked(redisSet)
        .mock.calls.map(([key]) => key)
        .sort(),
    ).toEqual(
      [
        "bus:shape:v3:Taipei:忠孝幹線",
        "bus:shape:v3:Taipei:信義幹線",
        "bus:shape:v3:Taichung:忠孝幹線",
      ].sort(),
    );
  });

  it("keeps trimmed cache hits without upstream fetch or writes", async () => {
    vi.mocked(redisGet).mockResolvedValue(JSON.stringify(shapes));
    expect(polyline(await detail(" B5-hit "))).toEqual(path);
    expect(redisGet).toHaveBeenCalledWith("bus:shape:v3:Taipei:B5-hit");
    expect(shapeUrls()).toEqual([]);
    expect(redisSet).not.toHaveBeenCalled();
  });

  it("refills malformed Redis data with the original 24-hour TTL", async () => {
    vi.mocked(redisGet).mockResolvedValue("{");
    expect(polyline(await detail("B5-malformed"))).toEqual(path);
    expect(shapeUrls()).toHaveLength(1);
    expect(redisSet).toHaveBeenCalledWith(
      "bus:shape:v3:Taipei:B5-malformed",
      JSON.stringify(shapes),
      86400,
    );
  });

  it.each(["empty", "error"])(
    "does not cache %s shapes and retries after settlement",
    async (failure) => {
      vi.mocked(tdxFetch).mockImplementation(async (url) => {
        if (String(url).includes("/Bus/Shape/") && failure === "error")
          throw new Error("TDX 429");
        return response([]);
      });
      expect(polyline(await detail(`B5-${failure}`))).toBeNull();
      const attempts = shapeUrls().length;
      expect(attempts).toBeGreaterThan(0);
      expect(redisSet).not.toHaveBeenCalled();
      vi.mocked(tdxFetch).mockImplementation(async (url) =>
        response(String(url).includes("/Bus/Shape/") ? rows : []),
      );
      expect(polyline(await detail(`B5-${failure}`))).toEqual(path);
      expect(shapeUrls()).toHaveLength(attempts + 1);
      expect(redisSet).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps name-scope probing city before InterCity and remembers the successful scope", async () => {
    vi.mocked(tdxFetch).mockImplementation(async (url) =>
      response(String(url).includes("/Bus/Shape/InterCity") ? rows : []),
    );
    expect(polyline(await detail("B5-probe"))).toEqual(path);
    expect(shapeUrls()).toEqual([
      "https://tdx.transportdata.tw/api/basic/v2/Bus/Shape/City/Taipei?$format=JSON&$filter=RouteName/Zh_tw eq 'B5probe'",
      "https://tdx.transportdata.tw/api/basic/v2/Bus/Shape/City/Taipei?$format=JSON&$filter=RouteName/Zh_tw eq 'B5-probe'",
      "https://tdx.transportdata.tw/api/basic/v2/Bus/Shape/InterCity?$format=JSON&$filter=RouteName/Zh_tw eq 'B5probe'",
    ]);
    await detail("B5-probe");
    expect(shapeUrls()[3]).toBe(shapeUrls()[2]);
    expect(redisSet).toHaveBeenLastCalledWith(
      "bus:shape:v3:Taipei:B5-probe",
      JSON.stringify(shapes),
      86400,
    );
  });
});
