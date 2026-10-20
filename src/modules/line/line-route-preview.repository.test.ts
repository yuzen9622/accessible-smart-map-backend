import { beforeEach, expect, it, vi } from "vitest";
import { lineRoutePlanFixture } from "../../../tests/helpers/line-route";
import { lineRoadPlanFixture } from "../../../tests/helpers/line-road-route";
const { get, set } = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn() }));
vi.mock("../../config/redis", () => ({ redisGet: get, redisSetChecked: set }));
import {
  getLinePlanPreview,
  storeLinePlanPreview,
} from "./line-route-preview.repository";

beforeEach(() => {
  vi.resetAllMocks();
  set.mockResolvedValue(true);
});
it("only stores the public route contract under a fresh expiring capability", async () => {
  const plan = lineRoutePlanFixture();
  const first = await storeLinePlanPreview({
    ...plan,
    lineUserId: "private-line-id",
    _canonicalRequest: { userId: "private-account-id" },
  });
  const second = await storeLinePlanPreview(plan);
  expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(second).not.toBe(first);
  expect(set.mock.calls[0]).toEqual([
    `line:plan-preview:${first}`,
    expect.any(String),
    1800,
  ]);
  expect(JSON.parse(set.mock.calls[0][1])).toEqual(plan);
  get.mockResolvedValue(set.mock.calls[0][1]);
  expect(await getLinePlanPreview(first!)).toEqual(plan);
  expect(set).toHaveBeenCalledTimes(2);
});
it.each(["drive", "motorcycle"] as const)(
  "retains canonical %s coordinates, instructions and maneuvers in the snapshot",
  async (mode) => {
    const plan = lineRoadPlanFixture(mode);
    const token = await storeLinePlanPreview(plan);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.parse(set.mock.calls[0][1])).toEqual(plan);
    get.mockResolvedValue(set.mock.calls[0][1]);
    expect(await getLinePlanPreview(token!)).toEqual(plan);
  },
);

it.each([
  { ...lineRoutePlanFixture(), ok: false },
  { ...lineRoutePlanFixture(), routes: [] },
  { ...lineRoutePlanFixture(), selectedRouteId: "missing" },
  { ...lineRoutePlanFixture(), origin: { name: "wrong" } },
])(
  "does not mint a map capability for unusable planning results",
  async (plan) => {
    expect(await storeLinePlanPreview(plan)).toBeNull();
    expect(set).not.toHaveBeenCalled();
  },
);
it("does not return a token without a confirmed cache write", async () => {
  set.mockResolvedValue(false);
  expect(await storeLinePlanPreview(lineRoutePlanFixture())).toBeNull();
});
it("rejects malformed, missing, corrupted and invalid stored plans", async () => {
  expect(await getLinePlanPreview("enumerable-id")).toBeNull();
  expect(get).not.toHaveBeenCalled();
  get
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce("{")
    .mockResolvedValueOnce('{"ok":true}');
  for (let i = 0; i < 3; i++)
    expect(await getLinePlanPreview("a".repeat(43))).toBeNull();
});
