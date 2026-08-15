import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock tdxFetch to prevent real network calls during transit route enrichment
vi.mock("../../config/fetch", () => ({
	tdxFetch: vi.fn().mockResolvedValue({ ok: true, json: async () => [] }),
}));

vi.mock("../environment/environment.service", () => ({
	getWeatherAndAirQuality: vi.fn().mockResolvedValue({}),
}));

// Mock the driving planner (dynamic-imported by the service) — override only
// planValhallaRoute; keep ValhallaRoutingError so `instanceof` checks stay valid.
vi.mock("./planners/valhalla-routing", () => ({
	planValhallaRoute: vi.fn(),
	ValhallaRoutingError: class ValhallaRoutingError extends Error {},
}));

// Spread-actual: only override the a11y hooks the driving path calls.
vi.mock("../a11y/a11y.service", async (importActual) => {
	const actual = await importActual<typeof import("../a11y/a11y.service")>();
	return { ...actual, findNearbyParking: vi.fn(), findNearby: vi.fn() };
});

// Mock route-a11y to isolate Mongo DB calls during transit route enrichment
vi.mock("./planners/route-a11y", () => ({
	nearbyA11y: vi.fn().mockResolvedValue([]),
	attachA11yToLeg: vi.fn(),
	deriveHighlights: vi.fn(),
	enrichLegIndoor: vi.fn(),
	buildAccessibilitySummary: vi.fn().mockReturnValue(""),
}));

// The transit branch dynamic-imports both from the OTP planner.
vi.mock("./planners/otp-routing", () => ({
	planOtpRoute: vi.fn().mockResolvedValue([]),
	planOtpRouteDetailed: vi.fn(),
	planOtpWalkDetailed: vi.fn(),
	isOtpCircuitOpen: () => false,
}));

vi.mock("../user/user.service", () => ({
	getA11yProfile: vi.fn(),
}));

// Confirmed-hazard lookup is an optional best-effort overlay; keep legacy route
// tests DB-free unless a B11 case explicitly supplies a verified hazard.
vi.mock("../hazard-report/hazard-report.service", () => ({
	findConfirmedHazardsWithin: vi.fn(),
}));

// DB isolation: resolveCityFromStops does findOne().select().lean().
vi.mock("../../model/bus-stop.model", () => ({
	default: {
		findOne: vi.fn(),
	},
}));

// Spread-actual google adapter; getCity is a fallback (city resolves via stops).
vi.mock("../../adapters/google.adapter", async (importActual) => {
	const actual =
		await importActual<typeof import("../../adapters/google.adapter")>();
	return { ...actual, getCity: vi.fn(), getCoordinates: vi.fn() };
});

// Alerts are an advisory overlay on planned routes; keep the planner tests off TDX.
vi.mock("../transit/metro.service", () => ({ getMetroAlerts: vi.fn() }));

import {
	attachMetroAlerts,
	planAccessibleRouteFromRequest,
} from "./accessible-route.service";
import { attachInternalSchedule } from "./route-schedule";
import {
	planValhallaRoute,
	ValhallaRoutingError,
} from "./planners/valhalla-routing";
import { findNearbyParking, findNearby } from "../a11y/a11y.service";
import {
	planOtpRouteDetailed,
	planOtpWalkDetailed,
} from "./planners/otp-routing";
import { getA11yProfile } from "../user/user.service";
import { findConfirmedHazardsWithin } from "../hazard-report/hazard-report.service";
import { enrichLegIndoor } from "./planners/route-a11y";
import { getCity } from "../../adapters/google.adapter";
import BusStopModel from "../../model/bus-stop.model";
import {
	ROUTE_MSG,
	ROUTE_REASON,
	ROUTE_WARNING,
} from "../../constants/messages";
import { ResponseCode } from "../../types/code";
import { getWeatherAndAirQuality } from "../environment/environment.service";
import { getMetroAlerts } from "../transit/metro.service";

const driveRequest = {
	travelMode: "drive" as const,
	origin: { latitude: 25.04, longitude: 121.56 },
	destination: { latitude: 25.03, longitude: 121.55 },
};

const otpTransitOk = (routes: any[]) => ({ status: "ok" as const, routes });
const otpTransitNoRoute = () => ({ status: "no_route" as const, routes: [] });

// Well-formed parking doc: the caller reads location.coordinates + placeName.
const parkingFixture = [
	{
		placeName: "身障停車格A",
		latitude: 25.031,
		longitude: 121.551,
		location: { type: "Point", coordinates: [121.551, 25.031] },
	},
];

const driveRoute = (highlights: string[]) => ({
	routeId: "drive-0",
	routeName: "開車",
	totalMinutes: 20,
	transferCount: 0,
	totalWalkDistanceM: 150,
	legs: [],
	accessibilityHighlights: highlights,
});

const hasParkingGuide = (hl: string[]) =>
	hl.some((h) => h.includes("已為您導引至最近身障停車格"));

beforeEach(() => {
	vi.resetAllMocks();
	vi.mocked(BusStopModel.findOne).mockReturnValue({
		select: () => ({ lean: () => Promise.resolve({ city: "Taipei" }) }),
	} as any);
	vi.mocked(getCity).mockResolvedValue("Taipei");
	vi.mocked(findNearby).mockResolvedValue({ nearbyOsm: [] } as any);
	vi.mocked(planOtpRouteDetailed).mockResolvedValue(otpTransitNoRoute());
	vi.mocked(planOtpWalkDetailed).mockResolvedValue({
		status: "no_route",
		routes: [],
	});
	vi.mocked(getWeatherAndAirQuality).mockResolvedValue({});
	vi.mocked(findConfirmedHazardsWithin).mockResolvedValue([]);
	vi.mocked(getMetroAlerts).mockResolvedValue([]);
});

describe("planAccessibleRouteFromRequest preflight", () => {
	it("short-circuits before city resolution and planner calls", async () => {
		const res = await planAccessibleRouteFromRequest({
			travelMode: "transit",
			origin: { latitude: 25.04, longitude: 121.56 },
			waypoints: [{ latitude: 27, longitude: 121.56 }],
			destination: { latitude: 25.03, longitude: 121.55 },
		});

		expect(res).toEqual({
			ok: false,
			status: ResponseCode.UNPROCESSABLE_ENTITY,
			error: ROUTE_MSG.OUT_OF_COVERAGE,
			data: { reason: ROUTE_REASON.OUT_OF_COVERAGE },
		});
		expect(vi.mocked(BusStopModel.findOne)).not.toHaveBeenCalled();
		expect(vi.mocked(getCity)).not.toHaveBeenCalled();
		expect(vi.mocked(planOtpRouteDetailed)).not.toHaveBeenCalled();
	});
});

describe("planAccessibleRouteFromRequest driving a11y highlights append", () => {
	it("appends the parking highlight without overwriting the walk hint", async () => {
		const walkHint = "起點需步行約 150 公尺至可上車路段";
		vi
			.mocked(planValhallaRoute)
			.mockResolvedValue([driveRoute([walkHint])] as any);
		vi.mocked(findNearbyParking).mockResolvedValue(parkingFixture as any);

		const res = await planAccessibleRouteFromRequest(driveRequest);

		expect(res.ok).toBe(true);
		expect(res.data!.travelMode).toBe("drive");
		const highlights = res.data!.routes[0].accessibilityHighlights;
		expect(highlights).toContain(walkHint);
		expect(highlights.some((h) => h.includes("身障停車格"))).toBe(true);
	});

	it("keeps a walk-failure warning alongside the appended parking highlight", async () => {
		const warning = "起點距可行車路段約 120 公尺，但無法建立可信步行路徑，請留意";
		vi
			.mocked(planValhallaRoute)
			.mockResolvedValue([driveRoute([warning])] as any);
		vi.mocked(findNearbyParking).mockResolvedValue(parkingFixture as any);

		const res = await planAccessibleRouteFromRequest(driveRequest);

		expect(res.ok).toBe(true);
		const highlights = res.data!.routes[0].accessibilityHighlights;
		expect(highlights).toContain(warning);
		expect(highlights.some((h) => h.includes("身障停車格"))).toBe(true);
	});
});

describe("planAccessibleRouteFromRequest parking-aware arrival", () => {
	it("routes to the parking anchor with the true dest as finalWalkTarget (drive)", async () => {
		vi.mocked(findNearbyParking).mockResolvedValue(parkingFixture as any);
		vi.mocked(planValhallaRoute).mockResolvedValue([driveRoute([])] as any);

		const res = await planAccessibleRouteFromRequest(driveRequest);

		const [, dest, opts] = vi.mocked(planValhallaRoute).mock.calls[0];
		expect(dest.lat).toBeCloseTo(25.031);
		expect(dest.lng).toBeCloseTo(121.551);
		expect(opts.finalWalkTarget!.lat).toBeCloseTo(25.03);
		expect(opts.finalWalkTarget!.lng).toBeCloseTo(121.55);

		expect(res.ok).toBe(true);
		expect(hasParkingGuide(res.data!.routes[0].accessibilityHighlights)).toBe(
			true,
		);
		expect(res.data!.destination).toEqual({ lat: 25.03, lng: 121.55 });
	});

	it("applies the same treatment to motorcycle", async () => {
		vi.mocked(findNearbyParking).mockResolvedValue(parkingFixture as any);
		vi.mocked(planValhallaRoute).mockResolvedValue([driveRoute([])] as any);

		const res = await planAccessibleRouteFromRequest({
			...driveRequest,
			travelMode: "motorcycle",
		});

		const [, dest, opts] = vi.mocked(planValhallaRoute).mock.calls[0];
		expect(dest.lat).toBeCloseTo(25.031);
		expect(dest.lng).toBeCloseTo(121.551);
		expect(opts.finalWalkTarget!.lat).toBeCloseTo(25.03);
		expect(opts.finalWalkTarget!.lng).toBeCloseTo(121.55);
		expect(res.ok).toBe(true);
		expect(hasParkingGuide(res.data!.routes[0].accessibilityHighlights)).toBe(
			true,
		);
	});

	it("routes straight to the true destination when no parking is found", async () => {
		vi.mocked(findNearbyParking).mockResolvedValue([] as any);
		vi.mocked(planValhallaRoute).mockResolvedValue([driveRoute([])] as any);

		const res = await planAccessibleRouteFromRequest(driveRequest);

		const [, dest, opts] = vi.mocked(planValhallaRoute).mock.calls[0];
		expect(dest.lat).toBeCloseTo(25.03);
		expect(dest.lng).toBeCloseTo(121.55);
		expect(opts.finalWalkTarget).toBeUndefined();
		expect(res.ok).toBe(true);
		expect(hasParkingGuide(res.data!.routes[0].accessibilityHighlights)).toBe(
			false,
		);
	});

	it("falls back to the true destination when the parking lookup rejects", async () => {
		vi.mocked(findNearbyParking).mockRejectedValue(new Error("mongo down"));
		vi.mocked(planValhallaRoute).mockResolvedValue([driveRoute([])] as any);

		const res = await planAccessibleRouteFromRequest(driveRequest);

		const [, dest, opts] = vi.mocked(planValhallaRoute).mock.calls[0];
		expect(dest.lat).toBeCloseTo(25.03);
		expect(dest.lng).toBeCloseTo(121.55);
		expect(opts.finalWalkTarget).toBeUndefined();
		expect(res.ok).toBe(true);
		expect(hasParkingGuide(res.data!.routes[0].accessibilityHighlights)).toBe(
			false,
		);
	});

	it("retries against the true destination when the parking bay is unreachable", async () => {
		vi.mocked(findNearbyParking).mockResolvedValue(parkingFixture as any);
		vi
			.mocked(planValhallaRoute)
			.mockResolvedValueOnce([] as any)
			.mockResolvedValueOnce([driveRoute([])] as any);

		const res = await planAccessibleRouteFromRequest(driveRequest);

		const calls = vi.mocked(planValhallaRoute).mock.calls;
		expect(calls).toHaveLength(2);
		expect(calls[1][1].lat).toBeCloseTo(25.03);
		expect(calls[1][1].lng).toBeCloseTo(121.55);
		expect(calls[1][2].finalWalkTarget).toBeUndefined();
		expect(res.ok).toBe(true);
		expect(hasParkingGuide(res.data!.routes[0].accessibilityHighlights)).toBe(
			false,
		);
	});

	it("returns 422 NO_ROUTE when both the parking bay and true destination are unreachable", async () => {
		vi.mocked(findNearbyParking).mockResolvedValue(parkingFixture as any);
		vi.mocked(planValhallaRoute).mockResolvedValue([] as any);

		await expect(planAccessibleRouteFromRequest(driveRequest)).resolves.toEqual({
			ok: false,
			status: ResponseCode.UNPROCESSABLE_ENTITY,
			error: ROUTE_MSG.NO_ROUTE,
			data: { reason: ROUTE_REASON.NO_ROUTE },
		});
		expect(vi.mocked(planValhallaRoute)).toHaveBeenCalledTimes(2);
	});

	it("returns 503 UPSTREAM_TIMEOUT without retrying when the first plan is unavailable", async () => {
		vi.mocked(findNearbyParking).mockResolvedValue(parkingFixture as any);
		vi
			.mocked(planValhallaRoute)
			.mockRejectedValue(new ValhallaRoutingError("upstream"));

		await expect(planAccessibleRouteFromRequest(driveRequest)).resolves.toEqual({
			ok: false,
			status: ResponseCode.SERVICE_UNAVAILABLE,
			error: ROUTE_MSG.UPSTREAM_TIMEOUT,
			data: { reason: ROUTE_REASON.UPSTREAM_TIMEOUT },
		});
		expect(vi.mocked(planValhallaRoute).mock.calls).toHaveLength(1);
	});

	it("does NOT retry (and stays 500) when the first plan errors", async () => {
		vi.mocked(findNearbyParking).mockResolvedValue(parkingFixture as any);
		vi.mocked(planValhallaRoute).mockRejectedValue(new Error("boom"));

		const res = await planAccessibleRouteFromRequest(driveRequest);

		expect(vi.mocked(planValhallaRoute).mock.calls).toHaveLength(1);
		expect(res.ok).toBe(false);
		expect(res.status).toBe(ResponseCode.INTERNAL_ERROR);
	});

	it("does not run the parking lookup for transit", async () => {
		const res = await planAccessibleRouteFromRequest({
			...driveRequest,
			travelMode: "transit",
		});

		expect(findNearbyParking).not.toHaveBeenCalled();
		expect(res.ok).toBe(false);
	});

	it("does not run the parking arrival lookup for walk mode", async () => {
		vi.mocked(planOtpWalkDetailed).mockResolvedValue({
			status: "ok",
			routes: [walkRoute()] as any,
		});

		const res = await planAccessibleRouteFromRequest({
			...driveRequest,
			travelMode: "walk",
		});

		expect(findNearbyParking).not.toHaveBeenCalled();
		expect(res.ok).toBe(true);
	});
});

const walkRequest = {
	travelMode: "walk" as const,
	origin: { latitude: 25.04, longitude: 121.56 },
	destination: { latitude: 25.03, longitude: 121.55 },
};

const walkRoute = () => ({
	routeId: "walk-0",
	routeName: "步行",
	totalMinutes: 10,
	transferCount: 0,
	totalWalkDistanceM: 800,
	legs: [
		{
			type: "WALK",
			from: "出發地",
			to: "目的地",
			distanceM: 800,
			minutesEst: 10,
			polyline: [
				[121.56, 25.04],
				[121.55, 25.03],
			],
			a11yFacilities: [],
		},
	],
	accessibilityHighlights: [],
});

describe("planAccessibleRouteFromRequest walk mode OTP", () => {
	it("uses the OTP walk route and does not call Valhalla", async () => {
		vi.mocked(planOtpWalkDetailed).mockResolvedValue({
			status: "ok",
			routes: [walkRoute()] as any,
		});

		const res = await planAccessibleRouteFromRequest(walkRequest);

		expect(res.ok).toBe(true);
		expect(res.data!.routes[0].routeName).toBe("步行");
		expect(res.data!.routes[0].legs[0]).toMatchObject({
			type: "WALK",
			maxSlopePercent: null,
			crossings: null,
			crossingsWithCurbRamp: null,
			minPathWidthCm: null,
			surfaceType: "unknown",
			restPoints: [],
		});
		expect(vi.mocked(planValhallaRoute).mock.calls).toHaveLength(0);
	});

	it("runs finalize enrichment on the OTP walk route", async () => {
		vi.mocked(planOtpWalkDetailed).mockResolvedValue({
			status: "ok",
			routes: [walkRoute()] as any,
		});
		vi.mocked(findNearby).mockResolvedValue({
			nearbyOsm: [{ category: "elevator" }],
		} as any);

		const res = await planAccessibleRouteFromRequest(walkRequest);

		expect(res.ok).toBe(true);
		const highlights = res.data!.routes[0].accessibilityHighlights;
		expect(highlights.some((h) => h.includes("電梯"))).toBe(true);
	});

	it("returns 422 NO_ROUTE when OTP has no route without an effective stair constraint", async () => {
		vi.mocked(planOtpWalkDetailed).mockResolvedValue({
			status: "no_route",
			routes: [],
		});

		await expect(planAccessibleRouteFromRequest(walkRequest)).resolves.toEqual({
			ok: false,
			status: ResponseCode.UNPROCESSABLE_ENTITY,
			error: ROUTE_MSG.NO_ROUTE,
			data: { reason: ROUTE_REASON.NO_ROUTE },
		});
		expect(vi.mocked(planValhallaRoute)).not.toHaveBeenCalled();
	});

	it("proves a stair constraint caused no route with one relaxed OTP retry", async () => {
		vi
			.mocked(planOtpWalkDetailed)
			.mockResolvedValueOnce({ status: "no_route", routes: [] })
			.mockResolvedValueOnce({ status: "ok", routes: [walkRoute()] as any });

		await expect(
			planAccessibleRouteFromRequest({
				...walkRequest,
				mode: "elderly",
				avoidStairs: true,
			}),
		).resolves.toEqual({
			ok: false,
			status: ResponseCode.UNPROCESSABLE_ENTITY,
			error: ROUTE_MSG.NO_ACCESSIBLE_ROUTE,
			data: { reason: ROUTE_REASON.NO_ACCESSIBLE_ROUTE },
		});
		expect(vi.mocked(planOtpWalkDetailed)).toHaveBeenCalledTimes(2);
		expect(vi.mocked(planOtpWalkDetailed).mock.calls[0][2]).toEqual({
			mode: "elderly",
			avoidStairs: true,
		});
		expect(vi.mocked(planOtpWalkDetailed).mock.calls[1][2]).toEqual({
			mode: "elderly",
			avoidStairs: false,
		});
	});

	it("returns 503 UPSTREAM_TIMEOUT when the relaxed OTP walk retry is unavailable", async () => {
		vi
			.mocked(planOtpWalkDetailed)
			.mockResolvedValueOnce({ status: "no_route", routes: [] })
			.mockResolvedValueOnce({ status: "unavailable", routes: [] });

		await expect(
			planAccessibleRouteFromRequest({
				...walkRequest,
				mode: "elderly",
				avoidStairs: true,
			}),
		).resolves.toEqual({
			ok: false,
			status: ResponseCode.SERVICE_UNAVAILABLE,
			error: ROUTE_MSG.UPSTREAM_TIMEOUT,
			data: { reason: ROUTE_REASON.UPSTREAM_TIMEOUT },
		});
	});

	it("returns structured failures when the OTP-unavailable Valhalla fallback cannot route", async () => {
		vi.mocked(planOtpWalkDetailed).mockResolvedValue({
			status: "unavailable",
			routes: [],
		});
		vi
			.mocked(planValhallaRoute)
			.mockRejectedValueOnce(new ValhallaRoutingError("upstream"))
			.mockResolvedValueOnce([] as any);

		await expect(planAccessibleRouteFromRequest(walkRequest)).resolves.toEqual({
			ok: false,
			status: ResponseCode.SERVICE_UNAVAILABLE,
			error: ROUTE_MSG.UPSTREAM_TIMEOUT,
			data: { reason: ROUTE_REASON.UPSTREAM_TIMEOUT },
		});
		await expect(planAccessibleRouteFromRequest(walkRequest)).resolves.toEqual({
			ok: false,
			status: ResponseCode.UNPROCESSABLE_ENTITY,
			error: ROUTE_MSG.NO_ROUTE,
			data: { reason: ROUTE_REASON.NO_ROUTE },
		});
	});

	it("falls back to marked Valhalla when OTP is unavailable", async () => {
		vi.mocked(planOtpWalkDetailed).mockResolvedValue({
			status: "unavailable",
			routes: [],
		});
		vi.mocked(planValhallaRoute).mockResolvedValue([driveRoute([])] as any);

		const res = await planAccessibleRouteFromRequest(walkRequest);

		expect(res.ok).toBe(true);
		expect(vi.mocked(planValhallaRoute).mock.calls.length).toBeGreaterThan(0);
		expect(res.data!.routes[0].warnings).toContain(
			"OTP 步行規劃暫時不可用，已降級使用 Valhalla 步行路線，指引品質可能不同",
		);
	});

	it("reports slopeConstraint enforced=false when a nominal walk request actually fell back to Valhalla", async () => {
		// travelMode stays "walk" on the request, but the route was actually
		// produced by Valhalla (no elevation data) via the OTP-unavailable
		// fallback above -- the slope report must reflect the real engine, not
		// the nominal travelMode.
		vi.mocked(planOtpWalkDetailed).mockResolvedValue({
			status: "unavailable",
			routes: [],
		});
		vi.mocked(planValhallaRoute).mockResolvedValue([driveRoute([])] as any);

		const res = await planAccessibleRouteFromRequest({
			...walkRequest,
			maxSlopePercent: 10,
			avoidStairs: true,
		});

		expect(res.ok).toBe(true);
		expect(res.data!.slopeConstraint).toEqual({
			requestedMaxPercent: 10,
			enforced: false,
			note: ROUTE_WARNING.SLOPE_LIMIT_NOT_ENFORCED_NO_ELEVATION,
		});
	});

	it("plans walk + waypoints as bounded OTP segments and preserves leg boundaries", async () => {
		vi.mocked(planOtpWalkDetailed).mockResolvedValue({
			status: "ok",
			routes: [walkRoute()] as any,
		});

		const res = await planAccessibleRouteFromRequest({
			...walkRequest,
			waypoints: [{ latitude: 25.035, longitude: 121.555 }],
		});

		expect(res.ok).toBe(true);
		expect(vi.mocked(planOtpWalkDetailed)).toHaveBeenCalledTimes(2);
		expect(vi.mocked(planValhallaRoute)).not.toHaveBeenCalled();
		expect(res.data!.routes[0].legs).toHaveLength(2);
		expect(res.data!.routes[0].legs.map((leg) => leg.type)).toEqual([
			"WALK",
			"WALK",
		]);
	});

	it("does not call OTP walk for drive mode", async () => {
		vi.mocked(planValhallaRoute).mockResolvedValue([driveRoute([])] as any);
		vi.mocked(findNearbyParking).mockResolvedValue([] as any);

		const res = await planAccessibleRouteFromRequest(driveRequest);

		expect(res.ok).toBe(true);
		expect(vi.mocked(planOtpWalkDetailed).mock.calls).toHaveLength(0);
	});
});

describe("planAccessibleRouteFromRequest — caller's saved a11y profile fills unset preferences", () => {
	beforeEach(() => {
		vi.mocked(planOtpWalkDetailed).mockResolvedValue({
			status: "ok",
			routes: [walkRoute()] as any,
		});
	});

	it("defaults avoidStairs=true and mode=wheelchair from a wheelchair-user profile", async () => {
		vi.mocked(getA11yProfile).mockResolvedValue({
			mobilityAid: "manual_wheelchair",
			canUseStairs: false,
			maxSlopePercent: null,
			needsAccessibleToilet: null,
			needsElevator: true,
			needsHandrail: null,
			visualAssistance: null,
			preferredFontScale: null,
		});

		await planAccessibleRouteFromRequest({ ...walkRequest, userId: "user-1" });

		expect(getA11yProfile).toHaveBeenCalledWith("user-1");
		expect(vi.mocked(planOtpWalkDetailed)).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			expect.objectContaining({ mode: "wheelchair", avoidStairs: true }),
		);
	});

	it("defaults avoidStairs=false when the profile explicitly says canUseStairs:true", async () => {
		vi.mocked(getA11yProfile).mockResolvedValue({
			mobilityAid: "manual_wheelchair",
			canUseStairs: true,
			maxSlopePercent: null,
			needsAccessibleToilet: null,
			needsElevator: null,
			needsHandrail: null,
			visualAssistance: null,
			preferredFontScale: null,
		});

		await planAccessibleRouteFromRequest({ ...walkRequest, userId: "user-1" });

		// mode still comes from mobilityAid, but avoidStairs must NOT fall through
		// to the mode-tier default (which would force it back to true).
		expect(vi.mocked(planOtpWalkDetailed)).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			expect.objectContaining({ mode: "wheelchair", avoidStairs: false }),
		);
	});

	it("does not override an explicitly-set avoidStairs/mode with the profile", async () => {
		vi.mocked(getA11yProfile).mockResolvedValue({
			mobilityAid: "manual_wheelchair",
			canUseStairs: false,
			maxSlopePercent: null,
			needsAccessibleToilet: null,
			needsElevator: null,
			needsHandrail: null,
			visualAssistance: null,
			preferredFontScale: null,
		});

		await planAccessibleRouteFromRequest({
			...walkRequest,
			userId: "user-1",
			mode: "normal",
			avoidStairs: false,
		});

		expect(vi.mocked(planOtpWalkDetailed)).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			expect.objectContaining({ mode: "normal", avoidStairs: false }),
		);
	});

	it("does not look up a profile when the request is anonymous", async () => {
		await planAccessibleRouteFromRequest(walkRequest);

		expect(getA11yProfile).not.toHaveBeenCalled();
	});

	it("ignores a failed profile lookup and still plans the route", async () => {
		vi.mocked(getA11yProfile).mockRejectedValue(new Error("db down"));

		const res = await planAccessibleRouteFromRequest({
			...walkRequest,
			userId: "user-1",
		});

		expect(res.ok).toBe(true);
	});
});

describe("planAccessibleRouteFromRequest — needsAccessibleToilet", () => {
	beforeEach(() => {
		vi.mocked(planOtpWalkDetailed).mockResolvedValue({
			status: "ok",
			routes: [walkRoute()] as any,
		});
	});

	it("adds a highlight when an accessible toilet is found near the destination", async () => {
		vi.mocked(findNearby).mockResolvedValue({
			nearbyOsm: [{ category: "toilet" }],
			nearbyBathroom: [{ name: "x" }],
		} as any);

		const res = await planAccessibleRouteFromRequest({
			...walkRequest,
			needsAccessibleToilet: true,
		});

		expect(res.ok).toBe(true);
		expect(
			res.data!.routes[0].accessibilityHighlights.some((h) => h.includes("廁所")),
		).toBe(true);
	});

	it("adds a warning instead when no accessible toilet is found nearby", async () => {
		vi.mocked(findNearby).mockResolvedValue({
			nearbyOsm: [],
			nearbyBathroom: [],
		} as any);

		const res = await planAccessibleRouteFromRequest({
			...walkRequest,
			needsAccessibleToilet: true,
		});

		expect(res.ok).toBe(true);
		expect(res.data!.routes[0].warnings).toContain(
			ROUTE_WARNING.NO_ACCESSIBLE_TOILET_NEARBY,
		);
	});

	it("does nothing when needsAccessibleToilet is not requested", async () => {
		const res = await planAccessibleRouteFromRequest(walkRequest);

		expect(res.ok).toBe(true);
		expect(res.data!.routes[0].warnings ?? []).not.toContain(
			ROUTE_WARNING.NO_ACCESSIBLE_TOILET_NEARBY,
		);
	});
});

describe("planAccessibleRouteFromRequest — needsHandrail", () => {
	const stairsLeg = () => ({
		type: "WALK",
		from: "A",
		to: "B",
		distanceM: 50,
		minutesEst: 1,
		polyline: [],
		steps: [{ stairs: true }],
		a11yFacilities: [{ tags: { highway: "steps" } }],
	});

	beforeEach(() => {
		vi.mocked(planOtpWalkDetailed).mockResolvedValue({
			status: "ok",
			routes: [{ ...walkRoute(), legs: [stairsLeg()] }] as any,
		});
	});

	it("warns when a stairs leg has no OSM-confirmed handrail", async () => {
		const res = await planAccessibleRouteFromRequest({
			...walkRequest,
			needsHandrail: true,
		});

		expect(res.ok).toBe(true);
		expect(res.data!.routes[0].warnings).toContain(
			ROUTE_WARNING.STAIRS_HANDRAIL_UNKNOWN,
		);
	});

	it("does not warn when the stairs are OSM-tagged with a handrail", async () => {
		vi.mocked(planOtpWalkDetailed).mockResolvedValue({
			status: "ok",
			routes: [
				{
					...walkRoute(),
					legs: [
						{
							...stairsLeg(),
							a11yFacilities: [{ tags: { highway: "steps", handrail: "yes" } }],
						},
					],
				},
			] as any,
		});

		const res = await planAccessibleRouteFromRequest({
			...walkRequest,
			needsHandrail: true,
		});

		expect(res.ok).toBe(true);
		expect(res.data!.routes[0].warnings ?? []).not.toContain(
			ROUTE_WARNING.STAIRS_HANDRAIL_UNKNOWN,
		);
	});

	it("still finds a confirmed handrail after compactRoutes moves it into route.facilities", async () => {
		// Mirrors what compactRoutes() does: leg.a11yFacilities emptied, the
		// document moved into route-level `facilities` keyed by osmId, and the
		// leg left with an `a11yRefs` pointer. The handrail check must resolve
		// through that indirection instead of only looking at leg.a11yFacilities.
		// Uses drive mode because its finalize pipeline (dedupe + highlight
		// attach) keeps the same route object reference, unlike walk mode's
		// combineWalkSegments which rebuilds a route from a fixed field list and
		// would silently drop a hand-rolled `facilities` field in a fixture.
		vi.mocked(planValhallaRoute).mockResolvedValue([
			{
				...driveRoute([]),
				legs: [
					{
						...stairsLeg(),
						a11yFacilities: [],
						a11yRefs: ["way/1"],
					},
				],
				facilities: {
					"way/1": {
						osmId: "way/1",
						tags: { highway: "steps", handrail: "yes" },
					},
				},
			},
		] as any);
		vi.mocked(findNearbyParking).mockResolvedValue([] as any);

		const res = await planAccessibleRouteFromRequest({
			...driveRequest,
			needsHandrail: true,
		});

		expect(res.ok).toBe(true);
		expect(res.data!.routes[0].warnings ?? []).not.toContain(
			ROUTE_WARNING.STAIRS_HANDRAIL_UNKNOWN,
		);
	});

	it("honors a compacted ramp exemption too, not just a11yFacilities", async () => {
		// Same indirection as above, but for the ramp-wheelchair exemption that
		// zeroes out the stairs count entirely -- it must also resolve through
		// route.facilities/a11yRefs after compacting, or a ramp-accessible
		// "stairs" leg would be wrongly treated as an unconfirmed-handrail barrier.
		vi.mocked(planValhallaRoute).mockResolvedValue([
			{
				...driveRoute([]),
				legs: [
					{
						...stairsLeg(),
						a11yFacilities: [],
						a11yRefs: ["way/1"],
					},
				],
				facilities: {
					"way/1": {
						osmId: "way/1",
						tags: { highway: "steps", "ramp:wheelchair": "yes" },
					},
				},
			},
		] as any);
		vi.mocked(findNearbyParking).mockResolvedValue([] as any);

		const res = await planAccessibleRouteFromRequest({
			...driveRequest,
			needsHandrail: true,
		});

		expect(res.ok).toBe(true);
		expect(res.data!.routes[0].warnings ?? []).not.toContain(
			ROUTE_WARNING.STAIRS_HANDRAIL_UNKNOWN,
		);
	});
});

describe("planAccessibleRouteFromRequest — maxSlopePercent honesty check", () => {
	beforeEach(() => {
		vi.mocked(planOtpWalkDetailed).mockResolvedValue({
			status: "ok",
			routes: [walkRoute()] as any,
		});
		vi.mocked(planValhallaRoute).mockResolvedValue([driveRoute([])] as any);
		vi.mocked(findNearbyParking).mockResolvedValue([] as any);
	});

	it("reports enforced=false for drive mode (no elevation data)", async () => {
		const res = await planAccessibleRouteFromRequest({
			...driveRequest,
			maxSlopePercent: 5,
		});

		expect(res.ok).toBe(true);
		expect(res.data!.slopeConstraint).toEqual({
			requestedMaxPercent: 5,
			enforced: false,
			note: ROUTE_WARNING.SLOPE_LIMIT_NOT_ENFORCED_NO_ELEVATION,
		});
	});

	it("reports enforced=false for walk mode when avoidStairs/wheelchair isn't engaged", async () => {
		const res = await planAccessibleRouteFromRequest({
			...walkRequest,
			maxSlopePercent: 5,
			avoidStairs: false,
		});

		expect(res.ok).toBe(true);
		expect(res.data!.slopeConstraint!.enforced).toBe(false);
	});

	it("reports enforced=true when the request is looser than the server's 8.3% ADA default", async () => {
		const res = await planAccessibleRouteFromRequest({
			...walkRequest,
			maxSlopePercent: 10,
			avoidStairs: true,
		});

		expect(res.ok).toBe(true);
		expect(res.data!.slopeConstraint!.enforced).toBe(true);
	});

	it("reports enforced=false when the request is stricter than the server's fixed default", async () => {
		const res = await planAccessibleRouteFromRequest({
			...walkRequest,
			maxSlopePercent: 3,
			avoidStairs: true,
		});

		expect(res.ok).toBe(true);
		expect(res.data!.slopeConstraint).toEqual({
			requestedMaxPercent: 3,
			enforced: false,
			note: ROUTE_WARNING.SLOPE_LIMIT_STRICTER_THAN_SERVER_DEFAULT,
		});
	});

	it("omits slopeConstraint entirely when maxSlopePercent isn't requested", async () => {
		const res = await planAccessibleRouteFromRequest(walkRequest);

		expect(res.ok).toBe(true);
		expect(res.data!.slopeConstraint).toBeUndefined();
	});
});

describe("planAccessibleRouteFromRequest — 台北市公車與大眾運輸路徑規劃 (Taipei Transit Route Planning)", () => {
	const nccuOrigin = { latitude: 24.9868, longitude: 121.5762 }; // 政大
	const mainStationDest = { latitude: 25.0478, longitude: 121.517 }; // 台北車站
	const cckMemMem = { latitude: 25.0347, longitude: 121.5217 }; // 中正紀念堂

	const rooseveltBusRoute = {
		routeId: "otp-roosevelt-0",
		routeName: "羅斯福路幹線",
		totalMinutes: 28,
		transferCount: 0,
		totalWalkDistanceM: 400,
		legs: [
			{
				type: "WALK",
				from: "國立政治大學",
				to: "政大公車站",
				distanceM: 150,
				minutesEst: 3,
				polyline: [
					[121.5762, 24.9868],
					[121.576, 24.9865],
				],
				a11yFacilities: [],
			},
			{
				type: "BUS",
				routeName: "羅斯福路幹線",
				departureStop: "政大",
				arrivalStop: "台北車站(忠孝)",
				cityCode: "Taipei",
				waitInfo: { time: 180, source: "realtime" },
				estimatedWaitMinutes: 3,
				direction: 0,
				polyline: [
					[121.576, 24.9865],
					[121.517, 25.0478],
				],
				departureStopA11y: [],
				arrivalStopA11y: [],
				tdxCity: "Taipei",
			},
			{
				type: "WALK",
				from: "台北車站(忠孝)",
				to: "台北車站捷運站出口",
				distanceM: 250,
				minutesEst: 4,
				polyline: [
					[121.517, 25.0478],
					[121.5175, 25.048],
				],
				a11yFacilities: [],
			},
		],
		accessibilityHighlights: ["低底盤公車直達"],
	};

	it("測試 Case A: 政大 ➔ 台北車站 (輪椅模式公車路徑規劃)", async () => {
		vi
			.mocked(planOtpRouteDetailed)
			.mockResolvedValue(otpTransitOk([rooseveltBusRoute] as any));

		const req = {
			travelMode: "transit" as const,
			origin: nccuOrigin,
			destination: mainStationDest,
			mode: "wheelchair" as const,
		};

		const res = await planAccessibleRouteFromRequest(req);

		expect(res.ok).toBe(true);
		if (!res.ok) return;

		expect(res.data.travelMode).toBe("transit");
		expect(res.data.routes).toHaveLength(1);
		const primaryRoute = res.data.routes[0];
		expect(primaryRoute.routeName).toBe("羅斯福路幹線");
		expect(primaryRoute.transferCount).toBe(0);
		expect(primaryRoute.legs.some((l) => l.type === "BUS")).toBe(true);

		expect(vi.mocked(planOtpRouteDetailed)).toHaveBeenCalledWith(
			{ lat: nccuOrigin.latitude, lng: nccuOrigin.longitude },
			{ lat: mainStationDest.latitude, lng: mainStationDest.longitude },
			expect.objectContaining({ mode: "wheelchair" }),
		);
	});

	it("測試 Case B: 板橋車站 ➔ 撫遠街 (307 幹線公車無障礙路線規劃)", async () => {
		const bus307Route = {
			routeId: "otp-307",
			routeName: "307",
			totalMinutes: 35,
			transferCount: 0,
			totalWalkDistanceM: 200,
			legs: [
				{
					type: "BUS",
					routeName: "307",
					departureStop: "板橋公車站",
					arrivalStop: "撫遠街口",
					cityCode: "Taipei",
					waitInfo: { time: 120, source: "realtime" },
					estimatedWaitMinutes: 2,
					direction: 0,
					polyline: [],
					departureStopA11y: [],
					arrivalStopA11y: [],
					tdxCity: "Taipei",
				},
			],
			accessibilityHighlights: ["全線低底盤公車"],
		};

		vi
			.mocked(planOtpRouteDetailed)
			.mockResolvedValue(otpTransitOk([bus307Route] as any));

		const req = {
			travelMode: "transit" as const,
			origin: { latitude: 25.0143, longitude: 121.4638 }, // 板橋車站
			destination: { latitude: 25.0602, longitude: 121.5684 }, // 撫遠街口
			mode: "elderly" as const,
		};

		const res = await planAccessibleRouteFromRequest(req);

		expect(res.ok).toBe(true);
		if (!res.ok) return;

		expect(res.data.routes[0].routeName).toBe("307");
		expect(res.data.routes[0].accessibilityHighlights).toContain(
			"全線低底盤公車",
		);
	});

	it("測試 Case C: 帶途經點公車路線規劃 (政大 ➔ 中正紀念堂 ➔ 台北車站)", async () => {
		const segmentStart = Date.now();
		const seg1Route = {
			routeId: "seg1",
			routeName: "羅斯福路幹線 (段1)",
			totalMinutes: 15,
			transferCount: 0,
			legs: [
				{
					type: "WALK",
					from: "政大",
					to: "公車站",
					distanceM: 50,
					minutesEst: 1,
					polyline: [],
					a11yFacilities: [],
				},
				{
					type: "BUS",
					routeName: "羅斯福路幹線",
					departureStop: "政大",
					arrivalStop: "中正紀念堂",
					waitInfo: { time: 0, source: "realtime" },
					estimatedWaitMinutes: 0,
					direction: 0,
					polyline: [],
					departureStopA11y: [],
					arrivalStopA11y: [],
				},
				{
					type: "WALK",
					from: "公車站",
					to: "中正紀念堂",
					distanceM: 50,
					minutesEst: 1,
					polyline: [],
					a11yFacilities: [],
				},
			],
			accessibilityHighlights: [],
			_scheduledDepartureTime: segmentStart,
			_scheduledEndTime: segmentStart + 15 * 60_000,
			_isFutureScheduled: false,
		};

		const seg2Route = {
			routeId: "seg2",
			routeName: "信義幹線 (段2)",
			totalMinutes: 10,
			transferCount: 0,
			legs: [
				{
					type: "WALK",
					from: "中正紀念堂",
					to: "公車站",
					distanceM: 50,
					minutesEst: 1,
					polyline: [],
					a11yFacilities: [],
				},
				{
					type: "BUS",
					routeName: "信義幹線",
					departureStop: "中正紀念堂",
					arrivalStop: "台北車站",
					waitInfo: { time: 0, source: "realtime" },
					estimatedWaitMinutes: 0,
					direction: 0,
					polyline: [],
					departureStopA11y: [],
					arrivalStopA11y: [],
				},
				{
					type: "WALK",
					from: "公車站",
					to: "台北車站",
					distanceM: 50,
					minutesEst: 1,
					polyline: [],
					a11yFacilities: [],
				},
			],
			accessibilityHighlights: [],
			_scheduledDepartureTime: segmentStart + 15 * 60_000,
			_scheduledEndTime: segmentStart + 25 * 60_000,
			_isFutureScheduled: false,
		};

		vi
			.mocked(planOtpRouteDetailed)
			.mockResolvedValueOnce(otpTransitOk([seg1Route] as any))
			.mockResolvedValueOnce(otpTransitOk([seg2Route] as any));

		const req = {
			travelMode: "transit" as const,
			origin: nccuOrigin,
			destination: mainStationDest,
			waypoints: [cckMemMem],
			mode: "wheelchair" as const,
		};

		const res = await planAccessibleRouteFromRequest(req);

		expect(res.ok).toBe(true);
		if (!res.ok) return;

		expect(res.data.waypoints).toBeDefined();
		expect(res.data.routes[0].totalMinutes).toBe(25);
		expect(res.data.routes[0].routeName).toContain("羅斯福路幹線");
		expect(res.data.routes[0].routeName).toContain("信義幹線");
	});

	it("returns 422 NO_ROUTE when transit has no usable route without effective constraints", async () => {
		vi.mocked(planOtpRouteDetailed).mockResolvedValue(otpTransitNoRoute());

		const res = await planAccessibleRouteFromRequest({
			travelMode: "transit",
			origin: { latitude: 24.0, longitude: 120.0 },
			destination: { latitude: 24.01, longitude: 120.01 },
		});

		expect(res).toEqual({
			ok: false,
			status: ResponseCode.UNPROCESSABLE_ENTITY,
			error: ROUTE_MSG.NO_ROUTE,
			data: { reason: ROUTE_REASON.NO_ROUTE },
		});
	});

	it("returns 503 UPSTREAM_TIMEOUT when transit detailed planning is unavailable", async () => {
		vi.mocked(planOtpRouteDetailed).mockResolvedValue({
			status: "unavailable",
			routes: [],
		});

		await expect(
			planAccessibleRouteFromRequest({
				travelMode: "transit",
				origin: nccuOrigin,
				destination: mainStationDest,
			}),
		).resolves.toEqual({
			ok: false,
			status: ResponseCode.SERVICE_UNAVAILABLE,
			error: ROUTE_MSG.UPSTREAM_TIMEOUT,
			data: { reason: ROUTE_REASON.UPSTREAM_TIMEOUT },
		});
	});

	it("proves avoidStairs caused no route when requireElevator is also set", async () => {
		vi
			.mocked(planOtpRouteDetailed)
			.mockResolvedValueOnce(otpTransitNoRoute())
			.mockResolvedValueOnce(otpTransitOk([rooseveltBusRoute] as any));

		await expect(
			planAccessibleRouteFromRequest({
				travelMode: "transit",
				origin: nccuOrigin,
				destination: mainStationDest,
				mode: "elderly",
				avoidStairs: true,
				requireElevator: true,
			}),
		).resolves.toEqual({
			ok: false,
			status: ResponseCode.UNPROCESSABLE_ENTITY,
			error: ROUTE_MSG.NO_ACCESSIBLE_ROUTE,
			data: { reason: ROUTE_REASON.NO_ACCESSIBLE_ROUTE },
		});
		expect(vi.mocked(planOtpRouteDetailed)).toHaveBeenCalledTimes(2);
		expect(vi.mocked(planOtpRouteDetailed).mock.calls[0][2]).toMatchObject({
			avoidStairs: true,
		});
		expect(vi.mocked(planOtpRouteDetailed).mock.calls[1][2]).toMatchObject({
			avoidStairs: false,
		});
	});

	it("returns 422 NO_ROUTE without retry for requireElevator-only no route", async () => {
		vi.mocked(planOtpRouteDetailed).mockResolvedValue(otpTransitNoRoute());

		await expect(
			planAccessibleRouteFromRequest({
				travelMode: "transit",
				origin: nccuOrigin,
				destination: mainStationDest,
				mode: "elderly",
				requireElevator: true,
			}),
		).resolves.toEqual({
			ok: false,
			status: ResponseCode.UNPROCESSABLE_ENTITY,
			error: ROUTE_MSG.NO_ROUTE,
			data: { reason: ROUTE_REASON.NO_ROUTE },
		});
		expect(vi.mocked(planOtpRouteDetailed)).toHaveBeenCalledTimes(1);
		expect(vi.mocked(planOtpRouteDetailed).mock.calls[0][2]).toMatchObject({
			avoidStairs: false,
		});
		expect(vi.mocked(planOtpRouteDetailed).mock.calls[0][2]).not.toHaveProperty(
			"requireElevator",
		);
	});

	it("returns 422 NO_ROUTE when the relaxed avoidStairs retry also has no route", async () => {
		vi
			.mocked(planOtpRouteDetailed)
			.mockResolvedValueOnce(otpTransitNoRoute())
			.mockResolvedValueOnce(otpTransitNoRoute());

		await expect(
			planAccessibleRouteFromRequest({
				travelMode: "transit",
				origin: nccuOrigin,
				destination: mainStationDest,
				mode: "elderly",
				avoidStairs: true,
			}),
		).resolves.toEqual({
			ok: false,
			status: ResponseCode.UNPROCESSABLE_ENTITY,
			error: ROUTE_MSG.NO_ROUTE,
			data: { reason: ROUTE_REASON.NO_ROUTE },
		});
		expect(vi.mocked(planOtpRouteDetailed)).toHaveBeenCalledTimes(2);
	});

	it("returns 503 UPSTREAM_TIMEOUT when the relaxed avoidStairs retry is unavailable", async () => {
		vi
			.mocked(planOtpRouteDetailed)
			.mockResolvedValueOnce(otpTransitNoRoute())
			.mockResolvedValueOnce({ status: "unavailable", routes: [] });

		await expect(
			planAccessibleRouteFromRequest({
				travelMode: "transit",
				origin: nccuOrigin,
				destination: mainStationDest,
				mode: "elderly",
				avoidStairs: true,
			}),
		).resolves.toEqual({
			ok: false,
			status: ResponseCode.SERVICE_UNAVAILABLE,
			error: ROUTE_MSG.UPSTREAM_TIMEOUT,
			data: { reason: ROUTE_REASON.UPSTREAM_TIMEOUT },
		});
		expect(vi.mocked(planOtpRouteDetailed)).toHaveBeenCalledTimes(2);
	});

	it("keeps the earliest continued departure through findAccessibleRoutes and finalizeRoutes", async () => {
		const firstDeparture = new Date("2030-01-01T22:20:00.000Z").getTime();
		const route = (
			index: number,
			scheduledDepartureTime: number,
			totalMinutes: number,
			walkDistanceM: number,
		) => ({
			routeId: `future-${index}`,
			routeName: `F${index}`,
			totalMinutes,
			transferCount: 0,
			legs: [
				...(walkDistanceM > 0
					? [
							{
								type: "WALK" as const,
								from: "出發地",
								to: "起站",
								distanceM: walkDistanceM,
								minutesEst: 120,
								polyline: [],
								a11yFacilities: [],
							},
						]
					: []),
				{
					type: "BUS" as const,
					routeName: `F${index}`,
					departureStop: `起站${index}`,
					arrivalStop: `終站${index}`,
					departureStopId: `TPE-A${index}`,
					arrivalStopId: `TPE-B${index}`,
					departureTime: index === 0 ? "06:20" : `06:${20 + index}`,
					arrivalTime: "07:00",
					waitInfo: {
						time: index === 0 ? "06:20" : `06:${20 + index}`,
						source: "schedule" as const,
					},
					direction: 0 as const,
					polyline: [],
					departureStopA11y: [],
					arrivalStopA11y: [],
				},
			],
			accessibilityHighlights: [],
			departureDate: "2030-01-02",
			_scheduledDepartureTime: scheduledDepartureTime,
			_scheduledEndTime: scheduledDepartureTime + totalMinutes * 60_000,
			_isFutureScheduled: true,
		});
		const earliestRoute = route(0, firstDeparture, 300, 10_000);
		const logicalDuplicate = route(99, firstDeparture + 30 * 60_000, 5, 0);
		logicalDuplicate.routeName = "F0";
		const duplicateBusLeg = logicalDuplicate.legs.find(
			(leg) => leg.type === "BUS",
		);
		if (duplicateBusLeg?.type === "BUS") duplicateBusLeg.routeName = "F0";
		const candidates = [
			earliestRoute,
			logicalDuplicate,
			...Array.from({ length: 8 }, (_, index) =>
				route(index + 1, firstDeparture + (index + 1) * 60_000, 10 + index, 0),
			),
		];
		vi.mocked(planOtpRouteDetailed).mockResolvedValue(otpTransitOk(candidates));

		const res = await planAccessibleRouteFromRequest({
			travelMode: "transit",
			origin: nccuOrigin,
			destination: mainStationDest,
			departureTime: "2030-01-01T13:51:00.000Z",
		});

		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.data.routes).toHaveLength(3);
		expect(res.data.routes[0].routeId).toBe("future-0");
		expect(res.data.routes.map((candidate) => candidate.routeId)).not.toContain(
			"future-99",
		);
		expect(
			new Set(res.data.routes.map((candidate) => candidate.routeName)).size,
		).toBe(3);
		const earliest = res.data.routes.find(
			(candidate) => candidate.routeId === "future-0",
		);
		expect(earliest).toBeDefined();
		expect(earliest?.departureDate).toBe("2030-01-02");
		expect(earliest?.legs.find((leg) => leg.type === "BUS")).toMatchObject({
			departureTime: "06:20",
			waitInfo: { time: "06:20", source: "schedule" },
		});
	});
});

describe("planAccessibleRouteFromRequest — avoidStairs / requireElevator constraints", () => {
	const origin = { latitude: 25.04, longitude: 121.56 };
	const destination = { latitude: 25.03, longitude: 121.55 };
	const transitRequest = {
		travelMode: "transit" as const,
		origin,
		destination,
	};

	// Two rail candidates that differ ONLY in whether the station facility data
	// mentions an elevator — the exact case requireElevator must discriminate.
	const metroRoute = (routeName: string, facilityHighlights: string[]) => ({
		routeId: `otp-${routeName}`,
		routeName,
		totalMinutes: 20,
		transferCount: 0,
		totalWalkDistanceM: 200,
		legs: [
			{
				type: "METRO",
				railSystem: "TRTC",
				lineName: routeName,
				departureStation: "A 站",
				arrivalStation: "B 站",
				departureStationUid: `TRTC-${routeName}-A`,
				arrivalStationUid: `TRTC-${routeName}-B`,
				polyline: [
					[121.56, 25.04],
					[121.55, 25.03],
				],
				facilityHighlights,
				departureStationA11y: [],
				arrivalStationA11y: [],
			},
		],
		accessibilityHighlights: [],
	});

	const withElevator = metroRoute("有電梯線", ["A 站有電梯可達月台"]);
	const withoutElevator = metroRoute("無電梯線", ["A 站僅有樓梯與扶手"]);

	// A walk leg over confirmed stairs with no wheelchair ramp — what avoidStairs drops.
	const stairsWalkRoute = {
		routeId: "otp-stairs",
		routeName: "樓梯線",
		totalMinutes: 10,
		transferCount: 0,
		totalWalkDistanceM: 300,
		legs: [
			{
				type: "WALK",
				from: "起點",
				to: "終點",
				distanceM: 300,
				minutesEst: 6,
				polyline: [
					[121.56, 25.04],
					[121.55, 25.03],
				],
				a11yFacilities: [
					{ osmId: "way/1", category: "steps", tags: { highway: "steps" } },
				],
				steps: [
					{
						relativeDirection: "CONTINUE",
						absoluteDirection: "NORTH",
						streetName: "圓山市景步道",
						bogusName: false,
						area: false,
						stairs: true,
						distanceM: 300,
						location: [121.56, 25.04],
					},
				],
			},
		],
		accessibilityHighlights: [],
	};
	const otpStepsWalkRoute = {
		...stairsWalkRoute,
		routeId: "otp-steps-output",
		routeName: "OTP steps 樓梯線",
		legs: [
			{
				...stairsWalkRoute.legs[0],
				a11yFacilities: [],
				steps: [
					{
						relativeDirection: "CONTINUE",
						absoluteDirection: "NORTH",
						streetName: "steps",
						bogusName: true,
						area: false,
						stairs: true,
						distanceM: 300,
						location: [121.56, 25.04],
					},
				],
			},
		],
	};

	const routeNames = async (
		body: Parameters<typeof planAccessibleRouteFromRequest>[0],
	) => {
		const res = await planAccessibleRouteFromRequest(body);
		expect(res.ok).toBe(true);
		if (!res.ok) return [];
		return res.data.routes.map((r) => r.routeName);
	};

	it("keeps the elevator-less rail route for elderly mode when no flag is sent", async () => {
		vi
			.mocked(planOtpRouteDetailed)
			.mockResolvedValue(otpTransitOk([withElevator, withoutElevator] as any));

		const names = await routeNames({ ...transitRequest, mode: "elderly" });

		expect(names).toContain("無電梯線");
	});

	it("drops the elevator-less rail route when requireElevator is true", async () => {
		vi
			.mocked(planOtpRouteDetailed)
			.mockResolvedValue(otpTransitOk([withElevator, withoutElevator] as any));

		const names = await routeNames({
			...transitRequest,
			mode: "elderly",
			requireElevator: true,
		});

		expect(names).toEqual(["有電梯線"]);
	});

	it("a wheelchair-mode profile with needsElevator:false does NOT force requireElevator to true", async () => {
		vi
			.mocked(planOtpRouteDetailed)
			.mockResolvedValue(otpTransitOk([withElevator, withoutElevator] as any));
		vi.mocked(getA11yProfile).mockResolvedValue({
			mobilityAid: "manual_wheelchair",
			canUseStairs: null,
			maxSlopePercent: null,
			needsAccessibleToilet: null,
			needsElevator: false,
			needsHandrail: null,
			visualAssistance: null,
			preferredFontScale: null,
		});

		// mode is unset -> mobilityAid derives mode='wheelchair', whose tier default
		// would force requireElevator=true; the profile's explicit false must win.
		const names = await routeNames({ ...transitRequest, userId: "user-1" });

		expect(names).toEqual(["有電梯線", "無電梯線"]);
	});

	it("returns the elevator-less route anyway when it is the only candidate", async () => {
		vi
			.mocked(planOtpRouteDetailed)
			.mockResolvedValue(otpTransitOk([withoutElevator] as any));

		const names = await routeNames({
			...transitRequest,
			mode: "elderly",
			requireElevator: true,
		});

		expect(names).toEqual(["無電梯線"]);
	});

	it("drops a stairs-only walk leg when avoidStairs is true", async () => {
		vi
			.mocked(planOtpRouteDetailed)
			.mockResolvedValue(otpTransitOk([withElevator, stairsWalkRoute] as any));

		const names = await routeNames({
			...transitRequest,
			mode: "elderly",
			avoidStairs: true,
		});

		expect(names).toEqual(["有電梯線"]);
	});

	it("drops an OTP walk leg whose feature exposes a stairs barrier", async () => {
		vi
			.mocked(planOtpRouteDetailed)
			.mockResolvedValue(otpTransitOk([withElevator, otpStepsWalkRoute] as any));

		const names = await routeNames({
			...transitRequest,
			mode: "elderly",
			avoidStairs: true,
		});

		expect(names).toEqual(["有電梯線"]);
	});

	it("does not treat a 1201m step mislabeled as steps as a stairs barrier", async () => {
		const mislabeledSidewalk = {
			...otpStepsWalkRoute,
			routeId: "otp-mislabeled-sidewalk",
			routeName: "1201m 人行道",
			legs: [
				{
					...otpStepsWalkRoute.legs[0],
					distanceM: 1201,
					steps: [
						{
							...otpStepsWalkRoute.legs[0].steps[0],
							streetName: "steps",
							stairs: false,
							distanceM: 1201,
						},
					],
				},
			],
		};
		vi
			.mocked(planOtpRouteDetailed)
			.mockResolvedValue(otpTransitOk([withElevator, mislabeledSidewalk] as any));

		const names = await routeNames({
			...transitRequest,
			mode: "elderly",
			avoidStairs: true,
		});

		expect(names).toContain("1201m 人行道");
	});

	it("returns the fewest-stairs route with degraded metadata when every candidate has stairs", async () => {
		const twoStairs = {
			...otpStepsWalkRoute,
			routeId: "otp-two-stairs",
			routeName: "兩段樓梯",
			legs: [
				{
					...otpStepsWalkRoute.legs[0],
					steps: [
						otpStepsWalkRoute.legs[0].steps[0],
						{
							...otpStepsWalkRoute.legs[0].steps[0],
							location: [121.55, 25.03],
						},
					],
				},
			],
		};
		vi
			.mocked(planOtpRouteDetailed)
			.mockResolvedValue(otpTransitOk([twoStairs, otpStepsWalkRoute] as any));

		const result = await planAccessibleRouteFromRequest({
			...transitRequest,
			mode: "elderly",
			avoidStairs: true,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.routes).toHaveLength(1);
		expect(result.data.routes[0].routeName).toBe("OTP steps 樓梯線");
		expect(result.data.routes[0].degraded).toBe(true);
		expect(result.data.routes[0].warnings).toContain(
			"目前候選路線仍包含無坡道樓梯，無法完全滿足避開樓梯條件",
		);
	});

	it.each(["ramp:wheelchair", "wheelchair"] as const)(
		"preserves the %s=yes exception for a confirmed stairs feature",
		async (tag) => {
			const accessibleSteps = {
				...otpStepsWalkRoute,
				routeId: "otp-ramped-steps",
				routeName: "有輪椅坡道階梯",
				legs: [
					{
						...otpStepsWalkRoute.legs[0],
						a11yFacilities: [
							{
								osmId: "way/ramp",
								category: "ramp",
								tags: { highway: "steps", [tag]: "yes" },
							},
						],
					},
				],
			};
			vi
				.mocked(planOtpRouteDetailed)
				.mockResolvedValue(otpTransitOk([accessibleSteps] as any));

			const names = await routeNames({
				...transitRequest,
				mode: "elderly",
				avoidStairs: true,
			});

			expect(names).toEqual(["有輪椅坡道階梯"]);
		},
	);

	it("requireElevator alone does not drop the stairs walk leg", async () => {
		vi
			.mocked(planOtpRouteDetailed)
			.mockResolvedValue(otpTransitOk([withElevator, stairsWalkRoute] as any));

		const names = await routeNames({
			...transitRequest,
			mode: "elderly",
			requireElevator: true,
		});

		expect(names).toContain("樓梯線");
	});

	it("requests step-free routing from OTP when avoidStairs is true for a non-wheelchair mode", async () => {
		vi
			.mocked(planOtpRouteDetailed)
			.mockResolvedValue(otpTransitOk([withElevator] as any));

		await planAccessibleRouteFromRequest({
			...transitRequest,
			mode: "elderly",
			avoidStairs: true,
		});

		expect(vi.mocked(planOtpRouteDetailed)).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			expect.objectContaining({ avoidStairs: true }),
		);
	});

	it("lets avoidStairs=false relax the wheelchair default at the OTP query", async () => {
		vi
			.mocked(planOtpRouteDetailed)
			.mockResolvedValue(otpTransitOk([withElevator] as any));

		await planAccessibleRouteFromRequest({
			...transitRequest,
			mode: "wheelchair",
			avoidStairs: false,
		});

		expect(vi.mocked(planOtpRouteDetailed)).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			expect.objectContaining({ avoidStairs: false }),
		);
	});

	it("keeps the wheelchair default (both constraints on) when no flag is sent", async () => {
		vi
			.mocked(planOtpRouteDetailed)
			.mockResolvedValue(otpTransitOk([withElevator, withoutElevator] as any));

		const names = await routeNames({ ...transitRequest, mode: "wheelchair" });

		expect(names).toEqual(["有電梯線"]);
		expect(vi.mocked(planOtpRouteDetailed)).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			expect.objectContaining({ avoidStairs: true }),
		);
	});

	it("forwards avoidStairs to the OTP walk planner for travelMode=walk", async () => {
		vi.mocked(planOtpWalkDetailed).mockResolvedValue({
			status: "no_route",
			routes: [],
		});

		await planAccessibleRouteFromRequest({
			travelMode: "walk",
			origin,
			destination,
			mode: "elderly",
			avoidStairs: true,
		});

		expect(vi.mocked(planOtpWalkDetailed)).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			expect.objectContaining({ mode: "elderly", avoidStairs: true }),
		);
	});
});

// Regression guard for the stage-ordering bug: the planners emit rail legs with
// facilityHighlights: [] and enrichLegIndoor is what fills them in, so an
// exclusion that runs before enrichment can never see elevator data. These
// fixtures deliberately mirror REAL planner output (empty highlights) instead of
// pre-populating them, which is what let the bug hide.
describe("requireElevator sees enrichment output, not raw planner output", () => {
	const origin = { latitude: 25.04, longitude: 121.56 };
	const destination = { latitude: 25.03, longitude: 121.55 };

	const rawMetroRoute = (routeName: string) => ({
		routeId: `otp-${routeName}`,
		routeName,
		totalMinutes: 20,
		transferCount: 0,
		totalWalkDistanceM: 200,
		legs: [
			{
				type: "METRO",
				railSystem: "TRTC",
				lineName: routeName,
				departureStation: "A 站",
				arrivalStation: "B 站",
				departureStationUid: `TRTC-${routeName}-A`,
				arrivalStationUid: `TRTC-${routeName}-B`,
				polyline: [
					[121.56, 25.04],
					[121.55, 25.03],
				],
				facilityHighlights: [],
				departureStationA11y: [],
				arrivalStationA11y: [],
			},
		],
		accessibilityHighlights: [],
	});

	it("excludes the elevator-less route using highlights written during enrichment", async () => {
		vi
			.mocked(planOtpRouteDetailed)
			.mockResolvedValue(
				otpTransitOk([rawMetroRoute("有電梯線"), rawMetroRoute("無電梯線")] as any),
			);

		// Stand in for enrichLegIndoor: fills facilityHighlights per station, exactly
		// as the real enrichment does — AFTER the planner returned empty arrays.
		vi.mocked(enrichLegIndoor).mockImplementation(async (leg: any) => {
			leg.facilityHighlights.push(
				leg.lineName === "有電梯線"
					? "乘車站「A 站」設有電梯"
					: "乘車站「A 站」僅有樓梯",
			);
		});

		const res = await planAccessibleRouteFromRequest({
			travelMode: "transit",
			origin,
			destination,
			mode: "elderly",
			requireElevator: true,
		});

		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.data.routes.map((r) => r.routeName)).toEqual(["有電梯線"]);
	});

	it("keeps both routes when requireElevator is off", async () => {
		vi
			.mocked(planOtpRouteDetailed)
			.mockResolvedValue(
				otpTransitOk([rawMetroRoute("有電梯線"), rawMetroRoute("無電梯線")] as any),
			);
		vi.mocked(enrichLegIndoor).mockImplementation(async (leg: any) => {
			leg.facilityHighlights.push(
				leg.lineName === "有電梯線"
					? "乘車站「A 站」設有電梯"
					: "乘車站「A 站」僅有樓梯",
			);
		});

		const res = await planAccessibleRouteFromRequest({
			travelMode: "transit",
			origin,
			destination,
			mode: "elderly",
		});

		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.data.routes.map((r) => r.routeName).sort()).toEqual(
			["有電梯線", "無電梯線"].sort(),
		);
	});
});

describe("confirmed hazard finalization", () => {
	const confirmedHazard = {
		id: "confirmed-blocking-1",
		hazardType: "construction" as const,
		severity: "blocking" as const,
		description: "人行道施工中",
		coordinates: [121.5605, 25.04005] as [number, number],
	};

	const groundWalkRoute = (
		routeId: string,
		totalMinutes: number,
		polyline: [number, number][],
	) => ({
		routeId,
		routeName: routeId,
		totalMinutes,
		transferCount: 0,
		legs: [
			{
				type: "WALK" as const,
				from: "起點",
				to: "終點",
				distanceM: 120,
				minutesEst: 2,
				polyline,
				a11yFacilities: [],
			},
		],
		accessibilityHighlights: [],
	});

	const groundDriveRoute = (
		routeId: string,
		totalMinutes: number,
		polyline: [number, number][],
	) => ({
		routeId,
		routeName: routeId,
		totalMinutes,
		transferCount: 0,
		legs: [
			{
				type: "DRIVE" as const,
				from: { lat: polyline[0][1], lng: polyline[0][0] },
				to: {
					lat: polyline[polyline.length - 1][1],
					lng: polyline[polyline.length - 1][0],
				},
				distanceM: 120,
				durationMin: totalMinutes,
				polyline,
			},
		],
		accessibilityHighlights: [],
	});

	it("ranks hazards before transit compact projection and keeps an evidence-backed avoided advisory", async () => {
		vi.mocked(planOtpRouteDetailed).mockResolvedValue(
			otpTransitOk([
				groundWalkRoute("fast-but-blocked", 8, [
					[121.56, 25.04],
					[121.561, 25.04],
				]),
				groundWalkRoute("slower-clear", 18, [
					[121.56, 25.042],
					[121.561, 25.042],
				]),
			] as any),
		);
		vi.mocked(findConfirmedHazardsWithin).mockResolvedValue([confirmedHazard]);

		const result = await planAccessibleRouteFromRequest({
			travelMode: "transit",
			origin: { latitude: 25.04, longitude: 121.56 },
			destination: { latitude: 25.03, longitude: 121.55 },
			format: "compact",
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.routes[0]).toMatchObject({
			routeId: "slower-clear",
			hazardAdvisory: {
				onRoute: [],
				avoided: [{ id: "confirmed-blocking-1" }],
			},
			facilities: {},
		});
		expect(result.data.routes[1]).toMatchObject({
			routeId: "fast-but-blocked",
			hazardAdvisory: { onRoute: [{ id: "confirmed-blocking-1" }] },
		});
	});

	it("considers an unaffected ninth transit candidate before proxy truncation", async () => {
		const blocked = Array.from({ length: 8 }, (_, index) =>
			groundWalkRoute(`blocked-${index + 1}`, index + 1, [
				[121.56, 25.04],
				[121.561, 25.04],
			]),
		);
		const clearNinth = groundWalkRoute("clear-ninth", 9, [
			[121.56, 25.042],
			[121.561, 25.042],
		]);
		vi
			.mocked(planOtpRouteDetailed)
			.mockResolvedValue(otpTransitOk([...blocked, clearNinth] as any));
		vi.mocked(findConfirmedHazardsWithin).mockResolvedValue([confirmedHazard]);

		const result = await planAccessibleRouteFromRequest({
			travelMode: "transit",
			origin: { latitude: 25.04, longitude: 121.56 },
			destination: { latitude: 25.03, longitude: 121.55 },
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.routes[0]).toMatchObject({
			routeId: "clear-ninth",
			hazardAdvisory: {
				onRoute: [],
				avoided: [{ id: "confirmed-blocking-1" }],
			},
		});
	});

	it("keeps one decorated future route when a single candidate has a hazard", async () => {
		const departureTime = new Date("2030-01-02T06:20:00.000Z").getTime();
		const scheduledRoute = attachInternalSchedule(
			groundWalkRoute("future-blocked", 10, [
				[121.56, 25.04],
				[121.561, 25.04],
			]) as any,
			departureTime,
			departureTime + 10 * 60_000,
			true,
		);
		vi
			.mocked(planOtpRouteDetailed)
			.mockResolvedValue(otpTransitOk([scheduledRoute]));
		vi.mocked(findConfirmedHazardsWithin).mockResolvedValue([confirmedHazard]);

		const result = await planAccessibleRouteFromRequest({
			travelMode: "transit",
			origin: { latitude: 25.04, longitude: 121.56 },
			destination: { latitude: 25.03, longitude: 121.55 },
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.routes).toHaveLength(1);
		expect(result.data.routes[0]).toMatchObject({
			routeId: "future-blocked",
			hazardAdvisory: { onRoute: [{ id: "confirmed-blocking-1" }] },
		});
		expect(
			Object.getOwnPropertyDescriptor(
				result.data.routes[0],
				"_scheduledDepartureTime",
			),
		).toMatchObject({ value: departureTime, enumerable: false });
	});

	it("applies the same pre-top-three hazard ranking to non-transit drive routes", async () => {
		vi.mocked(findNearbyParking).mockResolvedValue([] as any);
		vi.mocked(planValhallaRoute).mockResolvedValue([
			groundDriveRoute("fast-but-blocked", 8, [
				[121.56, 25.04],
				[121.561, 25.04],
			]),
			groundDriveRoute("slower-clear", 18, [
				[121.56, 25.042],
				[121.561, 25.042],
			]),
		] as any);
		vi.mocked(findConfirmedHazardsWithin).mockResolvedValue([confirmedHazard]);

		const result = await planAccessibleRouteFromRequest(driveRequest);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.routes[0]).toMatchObject({
			routeId: "slower-clear",
			hazardAdvisory: {
				onRoute: [],
				avoided: [{ id: "confirmed-blocking-1" }],
			},
		});
		expect(result.data.routes[1]).toMatchObject({
			routeId: "fast-but-blocked",
			hazardAdvisory: { onRoute: [{ id: "confirmed-blocking-1" }] },
		});
	});
});

describe("attachMetroAlerts", () => {
	const metroLeg = (over: Record<string, unknown> = {}) => ({
		type: "METRO",
		railSystem: "TRTC",
		lineId: "R",
		lineUid: "TRTC-R",
		departureStationUid: "TRTC-R10",
		arrivalStationUid: "TRTC-R11",
		...over,
	});
	const routeOf = (...legs: unknown[]) => ({ routeId: "r", legs }) as any;
	const alert = (over: Record<string, unknown> = {}) => ({
		alertId: "fault-1",
		title: "電梯故障",
		description: "維修中",
		status: 2,
		stations: [{ id: "R10", name: "中山站" }],
		lines: [],
		publishTime: "2026-08-15T09:30:00+08:00",
		updateTime: "2026-08-15T09:45:00+08:00",
		...over,
	});
	const systemResult = (railSystem: string, alerts: unknown[]) => ({
		railSystem,
		updatedAt: "2026-08-15T10:00:00+08:00",
		alerts,
	});

	it("skips the TDX lookup entirely when no route rides the metro", async () => {
		const result = await attachMetroAlerts([
			routeOf({ type: "WALK" }, { type: "BUS" }),
		]);

		expect(result).toEqual([]);
		expect(getMetroAlerts).not.toHaveBeenCalled();
	});

	it("queries each ridden rail system once", async () => {
		vi
			.mocked(getMetroAlerts)
			.mockImplementation(
				async (system?: string) => [systemResult(system!, [])] as any,
			);

		await attachMetroAlerts([
			routeOf(metroLeg()),
			routeOf(metroLeg(), metroLeg({ railSystem: "KRTC" })),
		]);

		expect(getMetroAlerts).toHaveBeenCalledTimes(2);
		expect(getMetroAlerts).toHaveBeenCalledWith("TRTC");
		expect(getMetroAlerts).toHaveBeenCalledWith("KRTC");
	});

	it("matches alert stations against prefixed leg station uids", async () => {
		vi
			.mocked(getMetroAlerts)
			.mockResolvedValue([systemResult("TRTC", [alert()])] as any);
		const departureMatch = metroLeg();
		const intermediateMatch = metroLeg({
			departureStationUid: "TRTC-R20",
			arrivalStationUid: "TRTC-R21",
			intermediateStops: [{ name: "中山站", stationUid: "TRTC-R10" }],
		});

		const result = await attachMetroAlerts([
			routeOf(departureMatch, intermediateMatch),
		]);

		expect((departureMatch as any).alerts).toEqual([
			expect.objectContaining({ alertId: "fault-1" }),
		]);
		expect((intermediateMatch as any).alerts).toHaveLength(1);
		expect(result).toEqual([
			systemResult("TRTC", [expect.objectContaining({ alertId: "fault-1" })]),
		]);
	});

	it("matches GTFS-built underscore uids (TRTC_R10) too", async () => {
		vi
			.mocked(getMetroAlerts)
			.mockResolvedValue([systemResult("TRTC", [alert()])] as any);
		const leg = metroLeg({
			departureStationUid: "TRTC_R10",
			arrivalStationUid: "TRTC_R11",
			lineUid: "TRTC_R",
		});

		await attachMetroAlerts([routeOf(leg)]);

		expect((leg as any).alerts).toEqual([
			expect.objectContaining({ alertId: "fault-1" }),
		]);
	});

	it("matches on the line when no station overlaps", async () => {
		vi
			.mocked(getMetroAlerts)
			.mockResolvedValue([
				systemResult("TRTC", [alert({ stations: [], lines: ["R"] })]),
			] as any);
		const leg = metroLeg();

		await attachMetroAlerts([routeOf(leg)]);

		expect((leg as any).alerts).toHaveLength(1);
	});

	it("leaves untouched legs without alerts, but still reports the system", async () => {
		vi
			.mocked(getMetroAlerts)
			.mockResolvedValue([
				systemResult("TRTC", [
					alert({ stations: [{ id: "BL5", name: null }], lines: ["BL"] }),
				]),
			] as any);
		const leg = metroLeg();

		const result = await attachMetroAlerts([routeOf(leg)]);

		expect((leg as any).alerts).toBeUndefined();
		expect(result).toHaveLength(1);
	});

	it("degrades a failing rail system without losing the others", async () => {
		vi.mocked(getMetroAlerts).mockImplementation(async (system?: string) => {
			if (system === "TRTC") throw new Error("TDX 500");
			return [
				systemResult("KRTC", [alert({ stations: [{ id: "R10", name: null }] })]),
			] as any;
		});
		const krtcLeg = metroLeg({ railSystem: "KRTC" });

		const result = await attachMetroAlerts([routeOf(metroLeg(), krtcLeg)]);

		expect(result).toEqual([
			systemResult("KRTC", [expect.objectContaining({ alertId: "fault-1" })]),
		]);
		expect((krtcLeg as any).alerts).toHaveLength(1);
	});

	it("drops rail systems that currently have no alerts", async () => {
		vi
			.mocked(getMetroAlerts)
			.mockResolvedValue([systemResult("TRTC", [])] as any);

		expect(await attachMetroAlerts([routeOf(metroLeg())])).toEqual([]);
	});
});
