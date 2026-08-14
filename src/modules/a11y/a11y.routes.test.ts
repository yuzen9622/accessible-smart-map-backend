import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

vi.mock("./a11y.service", async () => {
	const actual =
		await vi.importActual<typeof import("./a11y.service")>("./a11y.service");
	return {
		...actual,
		findAllFacilities: vi.fn(),
		findBathroomFacilities: vi.fn(),
		findRampFacilities: vi.fn(),
		findElevatorFacilities: vi.fn(),
		getServiceCoverage: vi.fn(),
		findNearbyParking: vi.fn(),
		assessQuickAccess: vi.fn(),
	};
});

import { buildTestApp } from "../../../tests/helpers/test-helpers";
import * as service from "./a11y.service";
import {
	DEFAULT_SERVICE_COVERAGE_BBOX,
	MAX_ROUTE_DISTANCE_KM,
} from "../../config/coverage";
import type { ServiceCoverageConfig } from "../../config/coverage";
import { ERROR_MESSAGE } from "../../constants/messages";

const app = buildTestApp();
const BASE = "/api/v1/a11y";

const GEO = {
	type: "Point" as const,
	coordinates: [121.5, 25.03] as [number, number],
};

const coverage: ServiceCoverageConfig = {
	bbox: [...DEFAULT_SERVICE_COVERAGE_BBOX] as ServiceCoverageConfig["bbox"],
	maxRouteDistanceKm: MAX_ROUTE_DISTANCE_KM,
};

const facility = (id: string, source: string): any => ({
	_id: id,
	name: `facility-${id}`,
	location: GEO,
	category: "elevator",
	source,
});

beforeEach(() => {
	vi.resetAllMocks();
});

describe("a11y facility list routes", () => {
	const cases = [
		{ path: "/all-facilities", fn: "findAllFacilities", source: "metro" },
		{
			path: "/all-bathrooms",
			fn: "findBathroomFacilities",
			source: "bathroom",
		},
		{ path: "/all-ramps", fn: "findRampFacilities", source: "osm" },
		{ path: "/all-elevators", fn: "findElevatorFacilities", source: "campus" },
	] as const;

	for (const { path, fn, source } of cases) {
		it(`GET ${path} returns 200 with the service output echoed through the envelope`, async () => {
			const data = [facility(`${fn}-1`, source)];
			vi.mocked(service[fn]).mockResolvedValue(data as any);

			const res = await request(app).get(`${BASE}${path}`);

			expect(res.status).toBe(200);
			expect(res.body).toMatchObject({
				ok: true,
				status: "success",
				code: 200,
			});
			expect(res.body.data).toEqual(data);
			expect(vi.mocked(service[fn])).toHaveBeenCalledTimes(1);
		});

		it(`GET ${path} returns a 500 envelope with the fixed internal message when the service throws`, async () => {
			const secret = "SENSITIVE_DB_CONNECTION_STRING_LEAK";
			vi.mocked(service[fn]).mockRejectedValue(new Error(secret));

			const res = await request(app).get(`${BASE}${path}`);

			expect(res.status).toBe(500);
			expect(res.body).toMatchObject({
				ok: false,
				status: "error",
				code: 500,
				message: ERROR_MESSAGE.INTERNAL,
			});
			expect(JSON.stringify(res.body)).not.toContain(secret);
		});
	}

	describe("GET /all-facilities category filter", () => {
		it("passes the parsed whitelist to the service", async () => {
			vi.mocked(service.findAllFacilities).mockResolvedValue([]);

			const res = await request(app).get(
				`${BASE}/all-facilities?category=elevator,ramp`,
			);

			expect(res.status).toBe(200);
			expect(vi.mocked(service.findAllFacilities)).toHaveBeenCalledWith([
				"elevator",
				"ramp",
			]);
		});

		it("passes undefined to the service when the param is omitted", async () => {
			vi.mocked(service.findAllFacilities).mockResolvedValue([]);

			const res = await request(app).get(`${BASE}/all-facilities`);

			expect(res.status).toBe(200);
			expect(vi.mocked(service.findAllFacilities)).toHaveBeenCalledWith(
				undefined,
			);
		});

		it("dedupes repeated categories", async () => {
			vi.mocked(service.findAllFacilities).mockResolvedValue([]);

			const res = await request(app).get(
				`${BASE}/all-facilities?category=elevator,elevator`,
			);

			expect(res.status).toBe(200);
			expect(vi.mocked(service.findAllFacilities)).toHaveBeenCalledWith([
				"elevator",
			]);
		});

		it("trims whitespace around tokens", async () => {
			vi.mocked(service.findAllFacilities).mockResolvedValue([]);

			const res = await request(app).get(
				`${BASE}/all-facilities?category=%20elevator%20,%20ramp%20`,
			);

			expect(res.status).toBe(200);
			expect(vi.mocked(service.findAllFacilities)).toHaveBeenCalledWith([
				"elevator",
				"ramp",
			]);
		});

		const invalidQueries = [
			{ name: "an unknown category value", qs: "category=foo" },
			{
				name: "a mix of valid and unknown values",
				qs: "category=elevator,foo",
			},
			{ name: "an empty param", qs: "category=" },
			{ name: "a trailing empty token", qs: "category=elevator," },
			{ name: "an unknown query key", qs: "category=elevator&foo=bar" },
		];

		for (const { name, qs } of invalidQueries) {
			it(`rejects ${name} with a 400 envelope carrying data.errors`, async () => {
				const res = await request(app).get(`${BASE}/all-facilities?${qs}`);

				expect(res.status).toBe(400);
				expect(res.body).toMatchObject({
					ok: false,
					status: "error",
					code: 400,
				});
				expect(Array.isArray(res.body.data.errors)).toBe(true);
				expect(res.body.data.errors.length).toBeGreaterThan(0);
				expect(vi.mocked(service.findAllFacilities)).not.toHaveBeenCalled();
			});
		}
	});

	it("wires each path to its own service function", async () => {
		vi.mocked(service.findAllFacilities).mockResolvedValue([
			facility("A", "metro"),
		] as any);
		vi.mocked(service.findBathroomFacilities).mockResolvedValue([
			facility("B", "bathroom"),
		] as any);
		vi.mocked(service.findRampFacilities).mockResolvedValue([
			facility("R", "osm"),
		] as any);
		vi.mocked(service.findElevatorFacilities).mockResolvedValue([
			facility("E", "campus"),
		] as any);

		const [all, bath, ramp, elev] = await Promise.all([
			request(app).get(`${BASE}/all-facilities`),
			request(app).get(`${BASE}/all-bathrooms`),
			request(app).get(`${BASE}/all-ramps`),
			request(app).get(`${BASE}/all-elevators`),
		]);

		expect(all.body.data[0]._id).toBe("A");
		expect(bath.body.data[0]._id).toBe("B");
		expect(ramp.body.data[0]._id).toBe("R");
		expect(elev.body.data[0]._id).toBe("E");
	});

	it("GET /all-places is removed and returns 404", async () => {
		const res = await request(app).get(`${BASE}/all-places`);
		expect(res.status).toBe(404);
	});
});

describe("GET /coverage", () => {
	it("returns the complete static coverage data through the public envelope", async () => {
		vi.mocked(service.getServiceCoverage).mockReturnValue(coverage);

		const res = await request(app).get(`${BASE}/coverage`);

		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({
			ok: true,
			status: "success",
			code: 200,
			data: coverage,
		});
		expect(res.body.data).toEqual(coverage);
		expect(vi.mocked(service.getServiceCoverage)).toHaveBeenCalledTimes(1);
	});

	it("rejects an unknown query key with the standard 400 validation envelope", async () => {
		const res = await request(app).get(`${BASE}/coverage?unexpected=true`);

		expect(res.status).toBe(400);
		expect(res.body).toMatchObject({ ok: false, status: "error", code: 400 });
		expect(Array.isArray(res.body.data.errors)).toBe(true);
		expect(res.body.data.errors.length).toBeGreaterThan(0);
		expect(vi.mocked(service.getServiceCoverage)).not.toHaveBeenCalled();
	});

	it("returns a fixed 500 envelope when the coverage service throws", async () => {
		const secret = "SENSITIVE_COVERAGE_CONFIGURATION";
		vi.mocked(service.getServiceCoverage).mockImplementation(() => {
			throw new Error(secret);
		});

		const res = await request(app).get(`${BASE}/coverage`);

		expect(res.status).toBe(500);
		expect(res.body).toMatchObject({
			ok: false,
			status: "error",
			code: 500,
			message: ERROR_MESSAGE.INTERNAL,
		});
		expect(JSON.stringify(res.body)).not.toContain(secret);
	});

	it("publishes the coverage path and its data schema in OpenAPI", async () => {
		const res = await request(app).get("/api/v1/openapi.json");

		expect(res.status).toBe(200);
		expect(res.body.paths["/a11y/coverage"]).toHaveProperty("get");
		const props = res.body.components.schemas.ServiceCoverageData.properties;
		expect(props).toMatchObject({
			bbox: expect.objectContaining({
				description: expect.stringContaining(
					"[minLng, minLat, maxLng, maxLat]",
				),
			}),
			maxRouteDistanceKm: expect.objectContaining({
				type: "integer",
				description: expect.stringContaining("公里"),
			}),
		});
		const maxKm = props.maxRouteDistanceKm;
		expect(maxKm.minimum ?? maxKm.exclusiveMinimum).toBeGreaterThanOrEqual(0);
		expect(props.supportedRegions).toBeUndefined();
	});
});

describe("GET /parking/nearby", () => {
	it("accepts the 5000-metre upper bound and passes it to the service", async () => {
		vi.mocked(service.findNearbyParking).mockResolvedValue([] as any);

		const res = await request(app).get(
			`${BASE}/parking/nearby?lat=25.033&lng=121.565&radius=5000`,
		);

		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({
			ok: true,
			status: "success",
			code: 200,
			data: [],
		});
		expect(vi.mocked(service.findNearbyParking)).toHaveBeenCalledWith(
			25.033,
			121.565,
			5000,
			undefined,
		);
	});

	it("passes type=standard through to the service", async () => {
		vi.mocked(service.findNearbyParking).mockResolvedValue([] as any);

		const res = await request(app).get(
			`${BASE}/parking/nearby?lat=25.033&lng=121.565&type=standard`,
		);

		expect(res.status).toBe(200);
		expect(vi.mocked(service.findNearbyParking)).toHaveBeenCalledWith(
			25.033,
			121.565,
			undefined,
			"standard",
		);
	});

	it("rejects an unknown type before calling the service", async () => {
		const res = await request(app).get(
			`${BASE}/parking/nearby?lat=25.033&lng=121.565&type=foo`,
		);

		expect(res.status).toBe(400);
		expect(res.body).toMatchObject({
			ok: false,
			status: "error",
			code: 400,
			message: "Invalid request.",
		});
		expect(vi.mocked(service.findNearbyParking)).not.toHaveBeenCalled();
	});

	it("rejects a radius above 5000 before calling the service", async () => {
		const res = await request(app).get(
			`${BASE}/parking/nearby?lat=25.033&lng=121.565&radius=6000`,
		);

		expect(res.status).toBe(400);
		expect(res.body).toMatchObject({
			ok: false,
			status: "error",
			code: 400,
			message: "Invalid request.",
		});
		expect(Array.isArray(res.body.data.errors)).toBe(true);
		expect(res.body.data.errors.length).toBeGreaterThan(0);
		expect(vi.mocked(service.findNearbyParking)).not.toHaveBeenCalled();
	});
});

describe("GET /quick-assess", () => {
	it("returns 200 with the service result echoed through the envelope", async () => {
		const result = {
			verdict: "good",
			summary: "附近 200 公尺內有 3 座電梯，適合輪椅前往",
			facilityCount: { elevator: 3, ramp: 1, toilet: 2, parking: 0 },
			activeHazardReports: 1,
			wheelchairTagRatio: 0.72,
			radiusM: 200,
			mode: "wheelchair",
		};
		vi.mocked(service.assessQuickAccess).mockResolvedValue(result as any);

		const res = await request(app).get(
			`${BASE}/quick-assess?lat=25.033&lng=121.565&mode=wheelchair`,
		);

		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ ok: true, status: "success", code: 200 });
		expect(res.body.data).toEqual(result);
		expect(vi.mocked(service.assessQuickAccess)).toHaveBeenCalledTimes(1);
	});

	it("returns 400 when lat/lng are missing", async () => {
		const res = await request(app).get(`${BASE}/quick-assess`);
		expect(res.status).toBe(400);
		expect(vi.mocked(service.assessQuickAccess)).not.toHaveBeenCalled();
	});
});
