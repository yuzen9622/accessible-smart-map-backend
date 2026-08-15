import A11y from "../../model/a11y.model";
import BathroomModel from "../../model/bathroom.model";
import OsmA11y from "../../model/osm-a11y.model";
import DisabledParkingModel from "../../model/disabled-parking.model";
import ParkingLotModel from "../../model/parking-lot.model";
import ParkingSpaceModel from "../../model/parking-space.model";
import type {
	IA11y,
	IBathroom,
	IDisabledParking,
	IOsmA11y,
	IParkingLot,
	IParkingSpace,
} from "../../types";

/** Parking lots that advertise at least one accessible bay. */
const DISABLED_CAPACITY_FILTER = {
	$or: [{ disabledSpaces: { $gt: 0 } }, { wheelchairAccessible: true }],
};

function makeGeoQuery(lng: number, lat: number, radiusM: number) {
	return {
		$near: {
			$geometry: { type: "Point", coordinates: [lng, lat] },
			$maxDistance: radiusM,
		},
	};
}

/**
 * Every metro accessibility exit, id-ordered.
 *
 * @param limit Hard cap on returned rows
 * @returns Metro exits
 */
export async function findAllMetroExits(limit: number): Promise<IA11y[]> {
	return A11y.find().sort({ _id: 1 }).limit(limit).lean() as unknown as Promise<
		IA11y[]
	>;
}

/**
 * OSM accessibility features, optionally narrowed to a set of categories.
 *
 * @param categories Categories to include, or null for every category
 * @param limit Hard cap on returned rows
 * @returns OSM features, id-ordered
 */
export async function findOsmFeatures(
	categories: IOsmA11y["category"][] | null,
	limit: number,
): Promise<IOsmA11y[]> {
	if (categories) {
		if (categories.length === 0) return [];
		return OsmA11y.find({ category: { $in: categories } })
			.sort({ _id: 1 })
			.limit(limit)
			.lean() as unknown as Promise<IOsmA11y[]>;
	}
	return OsmA11y.find().sort({ _id: 1 }).limit(limit).lean() as unknown as Promise<
		IOsmA11y[]
	>;
}

/**
 * OSM features of a single category, id-ordered.
 *
 * @param category The category to match
 * @param limit Hard cap on returned rows
 * @returns OSM features
 */
export async function findOsmByCategory(
	category: IOsmA11y["category"],
	limit: number,
): Promise<IOsmA11y[]> {
	return OsmA11y.find({ category })
		.sort({ _id: 1 })
		.limit(limit)
		.lean() as unknown as Promise<IOsmA11y[]>;
}

/**
 * Accessible bathrooms, id-ordered.
 *
 * @param limit Hard cap on returned rows
 * @returns Bathrooms
 */
export async function findAccessibleBathrooms(
	limit: number,
): Promise<IBathroom[]> {
	return BathroomModel.find({ type: "無障礙廁所" })
		.sort({ _id: 1 })
		.limit(limit)
		.lean() as unknown as Promise<IBathroom[]>;
}

/**
 * Every disabled parking bay, id-ordered.
 *
 * @param limit Hard cap on returned rows
 * @returns Disabled parking bays
 */
export async function findAllDisabledParking(
	limit: number,
): Promise<IDisabledParking[]> {
	return DisabledParkingModel.find()
		.sort({ _id: 1 })
		.limit(limit)
		.lean() as unknown as Promise<IDisabledParking[]>;
}

/**
 * Metro exits whose facility name mentions a lift.
 *
 * @param limit Hard cap on returned rows
 * @returns Metro exits
 */
export async function findMetroElevators(limit: number): Promise<IA11y[]> {
	return A11y.find({ "出入口電梯/無障礙坡道名稱": { $regex: "電梯" } })
		.sort({ _id: 1 })
		.limit(limit)
		.lean() as unknown as Promise<IA11y[]>;
}

/**
 * Metro exits whose facility name mentions a ramp but not a lift.
 *
 * @param limit Hard cap on returned rows
 * @returns Metro exits
 */
export async function findMetroRamps(limit: number): Promise<IA11y[]> {
	return A11y.find({
		$and: [
			{ "出入口電梯/無障礙坡道名稱": { $regex: "坡道" } },
			{ "出入口電梯/無障礙坡道名稱": { $not: /電梯/ } },
		],
	})
		.sort({ _id: 1 })
		.limit(limit)
		.lean() as unknown as Promise<IA11y[]>;
}

/**
 * Disabled parking bays near a point.
 *
 * @param lat Latitude of the search centre
 * @param lng Longitude of the search centre
 * @param radiusM Search radius in metres
 * @param limit Hard cap on returned rows
 * @returns Disabled parking bays, nearest first
 */
export async function findDisabledParkingNear(
	lat: number,
	lng: number,
	radiusM: number,
	limit: number,
): Promise<IDisabledParking[]> {
	return DisabledParkingModel.find({ location: makeGeoQuery(lng, lat, radiusM) })
		.limit(limit)
		.lean() as unknown as Promise<IDisabledParking[]>;
}

/**
 * Standard parking bays near a point.
 *
 * @param lat Latitude of the search centre
 * @param lng Longitude of the search centre
 * @param radiusM Search radius in metres
 * @param limit Hard cap on returned rows
 * @returns Parking bays, nearest first
 */
export async function findParkingSpacesNear(
	lat: number,
	lng: number,
	radiusM: number,
	limit: number,
): Promise<IParkingSpace[]> {
	return ParkingSpaceModel.find({ location: makeGeoQuery(lng, lat, radiusM) })
		.limit(limit)
		.lean() as unknown as Promise<IParkingSpace[]>;
}

/**
 * Off-street parking lots near a point.
 *
 * @param lat Latitude of the search centre
 * @param lng Longitude of the search centre
 * @param radiusM Search radius in metres
 * @param limit Hard cap on returned rows
 * @param disabledOnly Restrict to lots advertising accessible bays
 * @returns Parking lots, nearest first
 */
export async function findParkingLotsNear(
	lat: number,
	lng: number,
	radiusM: number,
	limit: number,
	disabledOnly: boolean,
): Promise<IParkingLot[]> {
	const filter = disabledOnly
		? { position: makeGeoQuery(lng, lat, radiusM), ...DISABLED_CAPACITY_FILTER }
		: { position: makeGeoQuery(lng, lat, radiusM) };
	return ParkingLotModel.find(filter)
		.limit(limit)
		.lean() as unknown as Promise<IParkingLot[]>;
}

/** The raw result sets the unified nearby lookup returns. */
export interface NearbyA11yRows {
	metro: IA11y[];
	bathroom: IBathroom[];
	osm: IOsmA11y[];
	parking: IDisabledParking[];
}

/**
 * Metro exits, bathrooms, OSM features and disabled parking near a point.
 *
 * `bathroom` and `parking` are deliberately returned unlensed, matching what
 * the endpoint has always serialised for those two collections.
 *
 * @param lat Latitude of the search centre
 * @param lng Longitude of the search centre
 * @param radiusM Search radius in metres
 * @returns The four raw result sets
 */
export async function findNearbyA11yRows(
	lat: number,
	lng: number,
	radiusM: number,
): Promise<NearbyA11yRows> {
	const geoQuery = makeGeoQuery(lng, lat, radiusM);
	const [metro, bathroom, osm, parking] = await Promise.all([
		A11y.find({ location: geoQuery }).lean(),
		BathroomModel.find({ type: "無障礙廁所", location: geoQuery }),
		OsmA11y.find({ location: geoQuery }).lean(),
		DisabledParkingModel.find({ location: geoQuery }),
	]);
	return {
		metro: metro as unknown as IA11y[],
		bathroom: bathroom as unknown as IBathroom[],
		osm: osm as unknown as IOsmA11y[],
		parking: parking as unknown as IDisabledParking[],
	};
}

/**
 * The capped variant of the unified nearby lookup used by the agent tools.
 *
 * Bathrooms use their own tighter radius, as they always have.
 *
 * @param lat Latitude of the search centre
 * @param lng Longitude of the search centre
 * @param radiusM Search radius in metres
 * @param bathroomRadiusM Search radius for bathrooms
 * @returns The four raw result sets
 */
export async function findNearbyA11yRowsLimited(
	lat: number,
	lng: number,
	radiusM: number,
	bathroomRadiusM: number,
): Promise<NearbyA11yRows> {
	const geoQuery = makeGeoQuery(lng, lat, radiusM);
	const [metro, bathroom, osm, parking] = await Promise.all([
		A11y.find({ location: geoQuery }).limit(10).lean(),
		BathroomModel.find({
			type: "無障礙廁所",
			location: makeGeoQuery(lng, lat, bathroomRadiusM),
		})
			.limit(5)
			.lean(),
		OsmA11y.find({ location: geoQuery }).limit(15).lean(),
		DisabledParkingModel.find({ location: geoQuery }).limit(10).lean(),
	]);
	return {
		metro: metro as unknown as IA11y[],
		bathroom: bathroom as unknown as IBathroom[],
		osm: osm as unknown as IOsmA11y[],
		parking: parking as unknown as IDisabledParking[],
	};
}

/**
 * OSM features addressed by their OSM ids.
 *
 * @param osmIds Ids to fetch
 * @returns The matching features
 */
export async function findOsmByIds(osmIds: string[]): Promise<IOsmA11y[]> {
	return OsmA11y.find({ osmId: { $in: osmIds } }).lean() as unknown as Promise<
		IOsmA11y[]
	>;
}

/** The raw counts input the quick assessment folds into a verdict. */
export interface QuickAssessRows {
	metro: IA11y[];
	osm: IOsmA11y[];
	bathroom: IBathroom[];
	parking: IDisabledParking[];
}

/**
 * Every facility collection near a point, for the quick accessibility verdict.
 *
 * @param lat Latitude of the search centre
 * @param lng Longitude of the search centre
 * @param radiusM Search radius in metres
 * @returns The four raw result sets
 */
export async function findQuickAssessRows(
	lat: number,
	lng: number,
	radiusM: number,
): Promise<QuickAssessRows> {
	const geoQuery = makeGeoQuery(lng, lat, radiusM);
	const [metro, osm, bathroom, parking] = await Promise.all([
		A11y.find({ location: geoQuery }).lean(),
		OsmA11y.find({ location: geoQuery }).lean(),
		BathroomModel.find({ type: "無障礙廁所", location: geoQuery }).lean(),
		DisabledParkingModel.find({ location: geoQuery }).lean(),
	]);
	return {
		metro: metro as unknown as IA11y[],
		osm: osm as unknown as IOsmA11y[],
		bathroom: bathroom as unknown as IBathroom[],
		parking: parking as unknown as IDisabledParking[],
	};
}
