import BusStopModel from "../../model/bus-stop.model";

/**
 * Finds the city of the nearest bus stop to a point.
 *
 * Used as a cheap local substitute for reverse geocoding; the 50km radius is
 * wide enough that any point in a served region hits a stop.
 *
 * @param lat Latitude
 * @param lng Longitude
 * @param maxDistM Search radius in metres
 * @returns The nearest stop's city, or null when no stop is in range
 */
export async function findNearestStopCity(
	lat: number,
	lng: number,
	maxDistM: number,
): Promise<string | null> {
	const stop = await BusStopModel.findOne({
		location: {
			$near: {
				$geometry: { type: "Point", coordinates: [lng, lat] },
				$maxDistance: maxDistM,
			},
		},
	})
		.select("city")
		.lean<{ city?: string }>();
	return stop?.city ?? null;
}
