import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { decode, encode } from "@googlemaps/polyline-codec";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import airport from "../adapters/__fixtures__/road-navigation/airport-native.json";
import jiachang from "../adapters/__fixtures__/road-navigation/jiachang-native.json";
import type { RoadSpeedRules } from "../types/road-guidance";
import { verifyCandidate, verifyReleaseFile } from "./verify-valhalla-release";

const { post } = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock("axios", () => ({ default: { post, isAxiosError: () => false } }));
const candidateUrl = "http://127.0.0.1:18002";
const sourceHash = "a".repeat(64);
const way = "137085105";
const sourceGeometry: [number, number][] = [
  [121.4445444, 25.0258893],
  [121.4440753, 25.0253458],
  [121.4437318, 25.0249793],
  [121.4433935, 25.0246467],
  [121.443164, 25.0244344],
];
const shape = (points: [number, number][]) =>
  encode(
    points.map(([lng, lat]) => [lat, lng]),
    6,
  );
function rules(): RoadSpeedRules {
  return {
    schemaVersion: 1,
    sourcePbfSha256: sourceHash,
    ways: {
      [way]: {
        forward: { kind: "known", limitKph: 30, rawValue: "30" },
        backward: { kind: "known", limitKph: 50, rawValue: "50" },
        unresolvedConditional: false,
        unresolvedLaneSpecific: false,
        osmGeometry: structuredClone(sourceGeometry),
      },
    },
  };
}
let mutation = "";
let directory: string | undefined;
beforeEach(() => {
  process.env.VALHALLA_BASE_URL = candidateUrl;
  mutation = "";
  post.mockReset();
  post.mockImplementation(
    async (
      url: string,
      body: {
        locations?: { lat: number; lon: number }[];
        encoded_polyline?: string;
        shape_match?: string;
        turn_lanes?: boolean;
      },
    ) => {
      expect(url.startsWith(candidateUrl + "/")).toBe(true);
      if (url.endsWith("/route")) {
        expect(body.turn_lanes).toBe(true);
        const points = body.locations!;
        if (points[0].lat < 23) {
          const raw = structuredClone(jiachang);
          if (mutation === "laneorder")
            raw.trip.legs[0].maneuvers[1].lanes!.reverse();
          return { data: raw };
        }
        if (points[0].lat < 25.02) return { data: structuredClone(airport) };
        const forward = points[0].lat > points[1].lat;
        return {
          data: {
            trip: {
              summary: { length: 1, time: 60 },
              legs: [
                {
                  summary: { length: 1, time: 60 },
                  shape: shape(
                    forward ? sourceGeometry : [...sourceGeometry].reverse(),
                  ),
                  maneuvers: [],
                },
              ],
            },
          },
        };
      }
      expect(body.shape_match).toBe("edge_walk");
      const encoded = body.encoded_polyline!;
      const count = decode(encoded, 6).length - 1;
      const isAirport = encoded === airport.trip.legs[0].shape;
      const isLane = encoded === jiachang.trip.legs[0].shape;
      const boundary = isAirport
        ? 7
        : isLane && mutation !== "laneincoming"
          ? 8
          : count;
      const edge = (from: number, to: number) => ({
        id: String(from + 1),
        way_id: !isAirport && !isLane && mutation !== "offway" ? way : "999",
        forward: false,
        begin_shape_index: from,
        end_shape_index: to,
      });
      const edges =
        boundary === count
          ? [edge(0, count)]
          : [edge(0, boundary), edge(boundary, count)];
      const values = Array.from({ length: count }, (_, index) =>
        isAirport
          ? index < (mutation === "exitboundary" ? 8 : 7)
            ? 100
            : 60
          : 99,
      );
      if (mutation === "speedcount") values.pop();
      if (mutation === "spanpartition") edges[0].begin_shape_index = 1;
      return {
        data: {
          shape: mutation === "shape" ? shape(sourceGeometry) : encoded,
          shape_attributes: { speed_limit: values },
          edges,
        },
      };
    },
  );
});
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("candidate verification through actual adapter and shared road-guidance", () => {
  it("executes the real ts-node CLI against an isolated fake HTTP upstream", async () => {
    directory = await mkdtemp(
      path.join(process.cwd(), ".pi/verifier-cli-test-"),
    );
    const input = path.join(directory, "rules.json"),
      output = path.join(directory, "verification.json");
    await writeFile(input, JSON.stringify(rules()));
    const server = createServer(async (request, response) => {
      try {
        let body = "";
        for await (const chunk of request) body += chunk;
        const result = await post(candidateUrl + request.url, JSON.parse(body));
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify(result.data));
      } catch {
        response.writeHead(500).end();
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Missing test listener");
      const child = spawn(
        process.execPath,
        [
          path.join(process.cwd(), "node_modules/ts-node/dist/bin.js"),
          "--compiler-options",
          '{"module":"CommonJS","moduleResolution":"node"}',
          "src/scripts/verify-valhalla-release.ts",
          `http://127.0.0.1:${address.port}`,
          input,
          sourceHash,
          output,
        ],
        { env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] },
      );
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      const timer = setTimeout(() => child.kill("SIGTERM"), 12000);
      const status = await new Promise<number | null>((resolve, reject) => {
        child.once("exit", resolve);
        child.once("error", reject);
      }).finally(() => clearTimeout(timer));
      expect(status, stderr).toBe(0);
      expect(
        JSON.parse(await readFile(output, "utf8")).checks.directionalLimits,
      ).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 15000);
  it("verifies both profiles, geometry, exit-boundary partition, ordered incoming lanes and both OSM directions", async () => {
    const checks = await verifyCandidate(candidateUrl, rules(), sourceHash);
    expect(Object.values(checks).every((check) => check === true)).toBe(true);
    expect(post).toHaveBeenCalledTimes(16);
    expect(
      post.mock.calls.filter(([url]) => url.endsWith("/trace_attributes")),
    ).toHaveLength(8);
  });
  it.each([
    "shape",
    "speedcount",
    "spanpartition",
    "exitboundary",
    "laneorder",
    "offway",
  ])("rejects mutated upstream %s", async (mode) => {
    mutation = mode;
    await expect(
      verifyCandidate(candidateUrl, rules(), sourceHash),
    ).rejects.toThrow("Candidate verification failed");
  });
  it.each([
    "missing",
    "bad",
    "reversed",
    "ambiguous",
    "conditional",
    "invalid",
    "wrongsource",
  ])(
    "rejects %s source rules instead of trusting numeric tags",
    async (mode) => {
      const input = rules(),
        target = input.ways[way];
      if (mode === "missing") delete target.osmGeometry;
      if (mode === "bad")
        target.osmGeometry = [
          [NaN, 0],
          [1, 1],
        ];
      if (mode === "reversed") target.osmGeometry!.reverse();
      if (mode === "ambiguous")
        target.osmGeometry = [
          ...sourceGeometry,
          ...[...sourceGeometry].reverse(),
        ];
      if (mode === "conditional") target.unresolvedConditional = true;
      if (mode === "invalid")
        target.forward = { kind: "invalid", limitKph: null, rawValue: "30|50" };
      if (mode === "wrongsource") input.sourcePbfSha256 = "b".repeat(64);
      await expect(
        verifyCandidate(candidateUrl, input, sourceHash),
      ).rejects.toThrow("Candidate verification failed");
    },
  );
  it("writes a source/rules-bound verification artifact only after success", async () => {
    directory = await mkdtemp(path.join(process.cwd(), ".pi/verifier-test-"));
    const input = path.join(directory, "rules.json"),
      output = path.join(directory, "verification.json");
    await writeFile(input, JSON.stringify(rules()));
    const result = await verifyReleaseFile(
      candidateUrl,
      input,
      sourceHash,
      output,
    );
    expect(JSON.parse(await readFile(output, "utf8"))).toEqual(result);
    expect(result.speedRulesSha256).toMatch(/^[0-9a-f]{64}$/);
    mutation = "exitboundary";
    const failedOutput = path.join(directory, "failed.json");
    await expect(
      verifyReleaseFile(candidateUrl, input, sourceHash, failedOutput),
    ).rejects.toThrow();
    await expect(readFile(failedOutput)).rejects.toThrow();
  });
  it("rejects rules changed during HTTP verification", async () => {
    directory = await mkdtemp(path.join(process.cwd(), ".pi/verifier-test-"));
    const input = path.join(directory, "rules.json"),
      output = path.join(directory, "verification.json");
    await writeFile(input, JSON.stringify(rules()));
    const original = post.getMockImplementation()!;
    post.mockImplementationOnce(async (...args) => {
      await writeFile(
        input,
        JSON.stringify({ ...rules(), sourcePbfSha256: "b".repeat(64) }),
      );
      return original(...args);
    });
    await expect(
      verifyReleaseFile(candidateUrl, input, sourceHash, output),
    ).rejects.toThrow("rules changed");
    await expect(readFile(output)).rejects.toThrow();
  });
});
