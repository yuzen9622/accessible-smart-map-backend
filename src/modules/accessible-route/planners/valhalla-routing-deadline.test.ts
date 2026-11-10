import axios from "axios";
import { decode } from "@googlemaps/polyline-codec";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import airport from "../../../adapters/__fixtures__/road-navigation/airport-native.json";
import { planValhallaRoute } from "./valhalla-routing";

vi.mock("axios", () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    isAxiosError: vi.fn(() => false),
    create: vi.fn(() => ({ post: vi.fn(), get: vi.fn() })),
  },
}));
let root: string;
beforeEach(async () => {
  vi.clearAllMocks();
  root = await mkdtemp(
    path.resolve(
      ".pi/notes/driving-navigation-backend-20261108/deadline-test-",
    ),
  );
  vi.stubEnv("VALHALLA_DATA_DIR", root);
  await mkdir(path.join(root, "releases/release1"), { recursive: true });
  await symlink("releases/release1", path.join(root, "active"));
  await writeFile(
    path.join(root, "serving-release.json"),
    JSON.stringify({
      buildId: "release1",
      manifestSha256: null,
      valhallaImageDigest: "sha256:" + "b".repeat(64),
      startedAt: new Date().toISOString(),
      instanceId: "runtime1",
    }),
  );
  vi.mocked(axios.get).mockReturnValue(new Promise(() => {}));
  vi.mocked(axios.post).mockResolvedValue({ data: airport });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});
it.each([400, 900])(
  "real adapter/planner preserves base route when /status stalls for the %ims caller deadline",
  async (budget) => {
    const points = decode(airport.trip.legs[0].shape, 6);
    const origin = { lat: points[0][0], lng: points[0][1] };
    const last = points.at(-1)!;
    const routes = await planValhallaRoute(
      origin,
      { lat: last[0], lng: last[1] },
      { travelMode: "drive", deadline: Date.now() + budget },
    );
    expect(routes).toHaveLength(1);
    expect(routes[0].legs[0]).toMatchObject({
      type: "DRIVE",
      speedLimits: { status: "unavailable" },
    });
    expect(axios.get).toHaveBeenCalledWith(
      expect.stringMatching(/\/status$/),
      expect.any(Object),
    );
    expect(axios.post).toHaveBeenCalled();
    expect(
      vi
        .mocked(axios.post)
        .mock.calls.every(([url]) => String(url).endsWith("/route")),
    ).toBe(true);
  },
);
