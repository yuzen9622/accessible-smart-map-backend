import BusRouteModel from "../../model/bus-route.model";
import BusVehicleModel from "../../model/bus-vehicle.model";
import BusStopModel from "../../model/bus-stop.model";
import type { ITdxBusVehicle } from "../../types";

/** A stored bus route with the stop list the info endpoint reads. */
export interface BusRouteDoc {
	subRouteUid: string;
	direction: number;
	operators?: { name?: string }[];
	stops?: {
		seq: number;
		stopName?: { Zh_tw?: string };
		lat: number;
		lng: number;
		stopUid?: string;
	}[];
	routeName?: { Zh_tw?: string };
	subRouteName?: { Zh_tw?: string };
	city?: string;
}

/** One grouped row from the route keyword search. */
export interface BusRouteSearchRow {
	_id: { routeName: string; city: string };
	subRoutes: {
		direction: number;
		stops?: { seq: number; stopName?: { Zh_tw?: string } }[];
	}[];
}

/** A stored bus stop as the search / nearby paths read it. */
export interface BusStopDoc {
	stopUid: string;
	stopName: { Zh_tw: string };
	city: string;
	location: { type: "Point"; coordinates: [number, number] };
	subRouteIds?: string[];
	/** Populated only by the `$geoNear` path, in metres. */
	distance: number;
}

/** The sub-route to route name mapping rows. */
export interface SubRouteNameRow {
	subRouteName?: { Zh_tw?: string };
	routeName?: { Zh_tw?: string };
}

/** Escapes a user keyword for safe use inside a `$regex`. */
function escapeRegExp(keyword: string): string {
	return keyword.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
}

/**
 * Vehicle records for a set of plate numbers, for the low-floor join.
 *
 * @param plateNumbers Plate numbers to look up
 * @returns The matching vehicle records
 */
export async function findVehiclesByPlate(
	plateNumbers: string[],
): Promise<ITdxBusVehicle[]> {
	return BusVehicleModel.find({
		plateNumb: { $in: plateNumbers },
	}).lean() as unknown as Promise<ITdxBusVehicle[]>;
}

/**
 * Routes matching any of the given Chinese names, scoped to a city unless the
 * scope is inter-city.
 *
 * @param city Operating city, or "InterCity" for the unscoped lookup
 * @param routeNames Candidate route names
 * @returns The matching route documents
 */
export async function findRoutesByName(
	city: string,
	routeNames: string[],
): Promise<BusRouteDoc[]> {
	const query =
		city === "InterCity"
			? { "routeName.Zh_tw": { $in: routeNames } }
			: { city, "routeName.Zh_tw": { $in: routeNames } };
	return BusRouteModel.find(query).lean() as unknown as Promise<BusRouteDoc[]>;
}

/**
 * Routes whose Chinese name fuzzily matches a keyword, grouped by (name, city).
 *
 * @param keyword Free-text search term
 * @param limit Maximum grouped rows
 * @returns Grouped route rows
 */
export async function searchRoutesByKeyword(
	keyword: string,
	limit: number,
): Promise<BusRouteSearchRow[]> {
	return BusRouteModel.aggregate([
		{ $match: { "routeName.Zh_tw": { $regex: escapeRegExp(keyword), $options: "i" } } },
		{
			$group: {
				_id: { routeName: "$routeName.Zh_tw", city: "$city" },
				subRoutes: { $push: { direction: "$direction", stops: "$stops" } },
			},
		},
		{ $limit: limit },
	]);
}

/**
 * Stops whose Chinese name fuzzily matches a keyword.
 *
 * @param keyword Free-text search term
 * @param limit Maximum rows
 * @returns Matching stops
 */
export async function searchStopsByKeyword(
	keyword: string,
	limit: number,
): Promise<BusStopDoc[]> {
	return BusStopModel.aggregate([
		{ $match: { "stopName.Zh_tw": { $regex: escapeRegExp(keyword), $options: "i" } } },
		{ $limit: limit },
	]);
}

/**
 * Stops within a radius of a point, nearest first, carrying their distance.
 *
 * @param lat Latitude of the search centre
 * @param lng Longitude of the search centre
 * @param radiusM Search radius in metres
 * @param limit Maximum rows
 * @returns Matching stops with a `distance` field
 */
export async function findStopsNearby(
	lat: number,
	lng: number,
	radiusM: number,
	limit: number,
): Promise<BusStopDoc[]> {
	return BusStopModel.aggregate([
		{
			$geoNear: {
				near: { type: "Point", coordinates: [lng, lat] },
				distanceField: "distance",
				maxDistance: radiusM,
				spherical: true,
			},
		},
		{ $limit: limit },
	]);
}

/**
 * Maps sub-route names back to their parent route names.
 *
 * @param subRouteNames Sub-route Chinese names collected off stops
 * @returns Rows pairing sub-route name with route name
 */
export async function findRouteNamesBySubRoute(
	subRouteNames: string[],
): Promise<SubRouteNameRow[]> {
	return BusRouteModel.find({
		"subRouteName.Zh_tw": { $in: subRouteNames },
	})
		.select("subRouteName.Zh_tw routeName.Zh_tw")
		.lean() as unknown as Promise<SubRouteNameRow[]>;
}
