import { getServiceCoverageConfig } from "../../config/coverage";
import type {
	ServiceCoverageBbox,
	ServiceCoverageConfig,
} from "../../config/coverage";
import {
	findAccessibleBathrooms,
	findAllDisabledParking,
	findAllMetroExits,
	findDisabledParkingNear,
	findMetroElevators,
	findMetroRamps,
	findNearbyA11yRows,
	findNearbyA11yRowsLimited,
	findOsmByCategory,
	findOsmByIds,
	findOsmFeatures,
	findParkingLotsNear,
	findParkingSpacesNear,
	findQuickAssessRows,
	type NearbyA11yRows,
} from "./a11y.repository";
import type {
	IA11y,
	IOsmA11y,
	IBathroom,
	IDisabledParking,
	IParkingLot,
	IParkingSpace,
	OsmWheelchairValue,
} from "../../types";

/**
 * Returns a clone of the deployment's static service-coverage settings.
 * This endpoint deliberately performs no database or external I/O.
 */
export function getServiceCoverage(): ServiceCoverageConfig {
	const config = getServiceCoverageConfig();
	return {
		bbox: [...config.bbox] as ServiceCoverageBbox,
		maxRouteDistanceKm: config.maxRouteDistanceKm,
	};
}

export type A11yPlace = Omit<IA11y, "_id"> & {
	_id?: unknown;
	source: "metro" | "osm" | "campus";
	osmId?: string;
	wheelchair?: IOsmA11y["wheelchair"];
	category?: "elevator" | "ramp";
	campusId?: number;
	schoolName?: string;
	facUid?: string;
	facType?: string;
	facTypeLabel?: string;
};

const OSM_STRUCTURE_CATEGORIES: readonly string[] = ["elevator", "ramp"];

const OSM_CATEGORY_FALLBACK_NAME: Record<string, string> = {
	elevator: "無障礙電梯",
	ramp: "無障礙坡道",
	toilet: "無障礙廁所",
	kerb_cut: "路緣斜坡",
	wheelchair_accessible: "無障礙設施",
};

/**
 * Normalizes an OSM accessibility document into the A11y (metro) response
 * shape so both sources render through the same frontend layer.
 */
export function osmToA11yPlace(doc: IOsmA11y): A11yPlace {
	return {
		項次: doc.osmId,
		"出入口電梯/無障礙坡道名稱":
			doc.name ?? OSM_CATEGORY_FALLBACK_NAME[doc.category] ?? doc.category,
		location: doc.location,
		source: "osm",
		osmId: doc.osmId,
		wheelchair: doc.wheelchair,
		category: doc.category as "elevator" | "ramp",
	};
}

/**
 * Normalizes a flattened campus facility into the A11y (metro) response shape
 * so campus facilities render through the same frontend layer as metro/OSM.
 */
/**
 * Merges metro elevator/ramp docs with OSM elevator/ramp docs (and optional
 * pre-normalized campus facilities) into one unified list; non-structure OSM
 * categories (toilets, kerb cuts…) are filtered out.
 */
export function mergeA11yPlaces(
	metro: Omit<IA11y, "_id">[],
	osm: IOsmA11y[],
	campus: A11yPlace[] = [],
): A11yPlace[] {
	return [
		...metro.map((doc) => ({ ...doc, source: "metro" as const })),
		...osm
			.filter((doc) => OSM_STRUCTURE_CATEGORIES.includes(doc.category))
			.map(osmToA11yPlace),
		...campus,
	];
}

function makeGeoQuery(lng: number, lat: number, radiusM: number) {
	return {
		$near: {
			$geometry: { type: "Point", coordinates: [lng, lat] },
			$maxDistance: radiusM,
		},
	};
}

export type A11ySource = "metro" | "osm" | "campus" | "bathroom" | "parking";
export const A11Y_CATEGORIES = [
	"elevator",
	"ramp",
	"toilet",
	"parking",
	"other",
] as const;
export type A11yCategory = (typeof A11Y_CATEGORIES)[number];
type A11yGeoPoint = { type: "Point"; coordinates: [number, number] };

interface A11yFacilityBase {
	_id: string;
	name: string;
	location: A11yGeoPoint;
	category: A11yCategory;
}

/**
 * A single accessibility facility in the unified, normalized public shape,
 * discriminated by `source`. Every source guarantees its own fixed fields:
 * metro carries `exitName`, OSM carries `osmId`/`wheelchair`, campus carries
 * `schoolName`; bathroom and parking add nothing beyond the base.
 */
export type A11yFacility =
	| (A11yFacilityBase & { source: "metro"; exitName: string | null })
	| (A11yFacilityBase & {
			source: "osm";
			osmId: string;
			wheelchair: OsmWheelchairValue | null;
	  })
	| (A11yFacilityBase & { source: "campus"; schoolName: string })
	| (A11yFacilityBase & { source: "bathroom" })
	| (A11yFacilityBase & { source: "parking" });

export const A11Y_MAX_RESULTS = 20000;

function idOf(doc: unknown): string {
	return String((doc as { _id?: unknown })._id);
}

/**
 * Classifies a metro facility by its combined name string. Elevator takes
 * precedence over ramp so a "電梯及坡道" entry lands in exactly one bucket and
 * never appears under both the ramp and elevator routes.
 * @param name the metro `出入口電梯/無障礙坡道名稱` value
 * @returns the resolved facility category
 */
function classifyMetroCategory(name: string): A11yCategory {
	if (name.includes("電梯")) return "elevator";
	if (name.includes("坡道")) return "ramp";
	return "other";
}

/**
 * Best-effort extraction of a metro exit identifier from the facility name.
 * @param name the metro facility name string
 * @returns the exit token (e.g. "M8", "3") or null when none can be parsed
 */
function extractMetroExitName(name: string): string | null {
	const patterns = [
		/([A-Za-z]\d+)\s*號?出/,
		/\b([A-Za-z]\d+)\b/,
		/出口\s*(\d+)/,
		/(\d+)\s*號出口/,
	];
	for (const pattern of patterns) {
		const match = name.match(pattern);
		if (match) return match[1];
	}
	return null;
}

const OSM_CATEGORIES_BY_FACILITY: Partial<
	Record<A11yCategory, IOsmA11y["category"][]>
> = {
	elevator: ["elevator"],
	ramp: ["ramp"],
	toilet: ["toilet"],
	other: ["kerb_cut", "wheelchair_accessible"],
};

function mapOsmCategory(category: IOsmA11y["category"]): A11yCategory {
	if (category === "elevator" || category === "ramp" || category === "toilet") {
		return category;
	}
	return "other";
}

/** Increments the count bucket a category maps to, ignoring "other". */
export function bumpCategory(
	counts: QuickAssessFacilityCount,
	category: A11yCategory,
): void {
	if (category === "elevator") counts.elevator++;
	else if (category === "ramp") counts.ramp++;
	else if (category === "toilet") counts.toilet++;
	else if (category === "parking") counts.parking++;
}

function metroToFacility(doc: IA11y): A11yFacility {
	const name = doc["出入口電梯/無障礙坡道名稱"];
	return {
		_id: idOf(doc),
		name,
		location: doc.location,
		category: classifyMetroCategory(name),
		source: "metro",
		exitName: extractMetroExitName(name),
	};
}

function osmToFacility(doc: IOsmA11y): A11yFacility {
	return {
		_id: idOf(doc),
		name: doc.name ?? OSM_CATEGORY_FALLBACK_NAME[doc.category] ?? doc.category,
		location: doc.location,
		category: mapOsmCategory(doc.category),
		source: "osm",
		osmId: doc.osmId,
		wheelchair: doc.wheelchair ?? null,
	};
}

function bathroomToFacility(doc: IBathroom): A11yFacility {
	return {
		_id: idOf(doc),
		name: doc.name,
		location: doc.location,
		category: "toilet",
		source: "bathroom",
	};
}

function parkingToFacility(doc: IDisabledParking): A11yFacility {
	return {
		_id: idOf(doc),
		name: doc.placeName,
		location: doc.location,
		category: "parking",
		source: "parking",
	};
}

/**
 * All accessibility facilities across every source, normalized into one shape.
 * Each source query is capped at A11Y_MAX_RESULTS with a stable `_id` sort so a
 * dataset that ever exceeds the cap still returns a deterministic subset.
 * @param categories optional category whitelist; sources that cannot produce
 * any requested category are skipped entirely and the OSM query is narrowed
 * with `$in` (campus is always queried since it can produce every category)
 * @returns facilities whose category is in the whitelist, or every facility
 * when the whitelist is omitted or empty
 */
export async function findOwnFacilityGroups(
	categories?: A11yCategory[],
): Promise<{
	metro: A11yFacility[];
	osm: A11yFacility[];
	bathroom: A11yFacility[];
	parking: A11yFacility[];
}> {
	const want = categories && categories.length > 0 ? new Set(categories) : null;
	const osmCategories = want
		? [...want].flatMap((c) => OSM_CATEGORIES_BY_FACILITY[c] ?? [])
		: null;
	const [metro, osm, bathroom, parking] = await Promise.all([
		!want || want.has("elevator") || want.has("ramp") || want.has("other")
			? findAllMetroExits(A11Y_MAX_RESULTS)
			: [],
		findOsmFeatures(osmCategories, A11Y_MAX_RESULTS),
		!want || want.has("toilet") ? findAccessibleBathrooms(A11Y_MAX_RESULTS) : [],
		!want || want.has("parking") ? findAllDisabledParking(A11Y_MAX_RESULTS) : [],
	]);
	return {
		metro: metro.map(metroToFacility),
		osm: osm.map(osmToFacility),
		bathroom: bathroom.map(bathroomToFacility),
		parking: parking.map(parkingToFacility),
	};
}

/**
 * This module's own elevator facilities: metro names containing 電梯 and OSM
 * `elevator`.
 */
export async function findOwnElevatorFacilities(): Promise<A11yFacility[]> {
	const [metro, osm] = await Promise.all([
		findMetroElevators(A11Y_MAX_RESULTS),
		findOsmByCategory("elevator", A11Y_MAX_RESULTS),
	]);
	return [...metro.map(metroToFacility), ...osm.map(osmToFacility)];
}

/**
 * This module's own ramp facilities: metro names containing 坡道 but NOT 電梯
 * (mutually exclusive with the elevator route) and OSM `ramp`.
 */
export async function findOwnRampFacilities(): Promise<A11yFacility[]> {
	const [metro, osm] = await Promise.all([
		findMetroRamps(A11Y_MAX_RESULTS),
		findOsmByCategory("ramp", A11Y_MAX_RESULTS),
	]);
	return [...metro.map(metroToFacility), ...osm.map(osmToFacility)];
}

/**
 * This module's own accessible bathrooms: the bathroom collection and OSM
 * `toilet`. Metro has no bathroom data.
 */
export async function findOwnBathroomFacilities(): Promise<A11yFacility[]> {
	const [bathroom, osm] = await Promise.all([
		findAccessibleBathrooms(A11Y_MAX_RESULTS),
		findOsmByCategory("toilet", A11Y_MAX_RESULTS),
	]);
	return [...bathroom.map(bathroomToFacility), ...osm.map(osmToFacility)];
}

/**
 * Parking lookup is user-scalable (radius is client-supplied), so cap both the
 * search radius and the result set to keep a single request from pulling the
 * whole parking dataset.
 */
const PARKING_MAX_RADIUS_M = 5000;
const PARKING_MAX_RESULTS = 50;

export type ParkingKind = "disabled" | "standard";

/**
 * Disabled-bay shape plus a `type` discriminator; standard bays are mapped into
 * the same shape so one response array can carry both collections.
 */
export type ParkingNearbyItem = IDisabledParking & {
	type: "disabled" | "standard";
	segmentId?: string;
	spaceType?: number;
	hasChargingPoint?: boolean;
};

/** Off-street car park (路外停車場) payload, discriminated by `type: "lot"`. */
export type ParkingLotNearbyItem = {
	type: "lot";
	_id: string;
	carParkId: string;
	name: string;
	address?: string;
	city: string;
	district?: string;
	carParkType?: number;
	chargeTypes?: number[];
	wheelchairAccessible?: boolean;
	disabledSpaces?: number;
	totalCarSpaces?: number;
	position: { type: "Point"; coordinates: [number, number] };
	importedAt: Date;
};

export type ParkingNearbyResult = ParkingNearbyItem | ParkingLotNearbyItem;

function disabledParkingToItem(doc: IDisabledParking): ParkingNearbyItem {
	return { ...doc, type: "disabled" };
}

function parkingSpaceToItem(doc: IParkingSpace): ParkingNearbyItem {
	return {
		_id: doc._id,
		city: doc.city,
		district: doc.city,
		areacode: "",
		quantity: 1,
		placeName: `一般停車格（${doc.externalId}）`,
		chargeType: "",
		spaceLabel: "",
		isMarked: false,
		source: "tdx",
		externalId: doc.externalId,
		location: doc.location,
		importedAt: doc.importedAt,
		type: "standard",
		segmentId: doc.segmentId,
		spaceType: doc.spaceType,
		hasChargingPoint: doc.hasChargingPoint,
	};
}

function parkingLotToItem(doc: IParkingLot): ParkingLotNearbyItem {
	return { ...doc, type: "lot" };
}

/**
 * Lots whose disabled capacity can be confirmed from the parsed fields
 * (`disabledSpaces > 0` or explicit `wheelchairAccessible` flag) — used to keep
 * `type=disabled` results accessibility-true instead of dumping every car park.
 */
const DISABLED_CAPACITY_FILTER = {
	$or: [{ disabledSpaces: { $gt: 0 } }, { wheelchairAccessible: true }],
};

/**
 * @param type which collection(s) to search; defaults to `all`, which queries
 * disabled bays, off-street car parks (lots) and standard bays together and
 * fills the shared cap in that priority order. `disabled` also includes lots
 * whose disabled capacity is confirmed; `standard` includes every lot.
 */
export async function findNearbyParking(
	lat: number,
	lng: number,
	radiusM = 1000,
	type: ParkingKind | "all" = "all",
): Promise<ParkingNearbyResult[]> {
	const cappedRadius = Math.min(radiusM, PARKING_MAX_RADIUS_M);
	const geoQuery = makeGeoQuery(lng, lat, cappedRadius);

	if (type === "disabled") {
		const [disabled, lots] = await Promise.all([
			findDisabledParkingNear(lat, lng, cappedRadius, PARKING_MAX_RESULTS),
			findParkingLotsNear(lat, lng, cappedRadius, PARKING_MAX_RESULTS, true),
		]);
		const items = (disabled as IDisabledParking[]).map(disabledParkingToItem);
		const remaining = PARKING_MAX_RESULTS - items.length;
		if (remaining <= 0) return items;
		return [
			...items,
			...(lots as IParkingLot[]).slice(0, remaining).map(parkingLotToItem),
		];
	}

	if (type === "standard") {
		const [standard, lots] = await Promise.all([
			findParkingSpacesNear(lat, lng, cappedRadius, PARKING_MAX_RESULTS),
			findParkingLotsNear(lat, lng, cappedRadius, PARKING_MAX_RESULTS, false),
		]);
		const items = (standard as IParkingSpace[]).map(parkingSpaceToItem);
		const remaining = PARKING_MAX_RESULTS - items.length;
		if (remaining <= 0) return items;
		return [
			...items,
			...(lots as IParkingLot[]).slice(0, remaining).map(parkingLotToItem),
		];
	}

	const [disabled, lots, standard] = await Promise.all([
		findDisabledParkingNear(lat, lng, cappedRadius, PARKING_MAX_RESULTS),
		findParkingLotsNear(lat, lng, cappedRadius, PARKING_MAX_RESULTS, false),
		findParkingSpacesNear(lat, lng, cappedRadius, PARKING_MAX_RESULTS),
	]);
	const items = (disabled as IDisabledParking[]).map(disabledParkingToItem);
	let remaining = PARKING_MAX_RESULTS - items.length;
	if (remaining <= 0) return items;
	const withLots = [
		...items,
		...(lots as IParkingLot[]).slice(0, remaining).map(parkingLotToItem),
	];
	remaining = PARKING_MAX_RESULTS - withLots.length;
	if (remaining <= 0) return withLots;
	return [
		...withLots,
		...(standard as IParkingSpace[]).slice(0, remaining).map(parkingSpaceToItem),
	];
}

export async function findOwnNearby(
	lat: number,
	lng: number,
	radiusM = 150,
): Promise<NearbyA11yRows> {
	return findNearbyA11yRows(lat, lng, radiusM);
}

/**
 * The capped variant, used by the agent tools where a full-radius sweep would
 * blow up the model's context.
 */
export async function findOwnNearbyLimited(
	lat: number,
	lng: number,
	radiusM = 300,
): Promise<NearbyA11yRows> {
	return findNearbyA11yRowsLimited(lat, lng, radiusM, 150);
}

export async function findByOsmIds(ids: string[]) {
	return findOsmByIds(ids);
}

export type QuickAssessMode =
	| "wheelchair"
	| "elderly"
	| "visual_impaired"
	| "normal";
export type QuickAssessVerdict = "good" | "caution" | "difficult";

export interface QuickAssessFacilityCount {
	elevator: number;
	ramp: number;
	toilet: number;
	parking: number;
}

export interface QuickAssessResult {
	verdict: QuickAssessVerdict;
	summary: string;
	facilityCount: QuickAssessFacilityCount;
	activeHazardReports: number;
	wheelchairTagRatio: number | null;
	radiusM: number;
	mode: QuickAssessMode;
}


/**
 * Coarse "is this place worth going to" verdict from nearby facility counts and
 * active hazard reports. Wheelchair/elderly additionally require a structural
 * asset (elevator or ramp) for a "good" verdict; a heavy hazard load forces
 * "difficult" regardless of facilities.
 *
 * @param counts Nearby facility counts by category.
 * @param haz Number of active hazard reports nearby.
 * @param mode Accessibility mode driving the structural requirement.
 * @returns The verdict label.
 */
export function computeVerdict(
	counts: QuickAssessFacilityCount,
	haz: number,
	mode: QuickAssessMode,
): QuickAssessVerdict {
	if (haz >= 3) return "difficult";
	const structural = counts.elevator + counts.ramp;
	const total = counts.elevator + counts.ramp + counts.toilet;

	if (mode === "wheelchair" || mode === "elderly") {
		if (structural >= 1 && total >= 3 && haz <= 1) return "good";
		if (total >= 1) return "caution";
		return "difficult";
	}
	if (total >= 3 && haz <= 1) return "good";
	if (total >= 1) return "caution";
	return "difficult";
}

const VERDICT_CLAUSE: Record<
	QuickAssessMode,
	Record<QuickAssessVerdict, string>
> = {
	wheelchair: {
		good: "適合輪椅前往",
		caution: "建議留意通行狀況",
		difficult: "輪椅通行可能較困難",
	},
	elderly: {
		good: "適合長者前往",
		caution: "建議留意通行狀況",
		difficult: "通行可能較困難",
	},
	visual_impaired: {
		good: "周邊設施尚可，建議前往時留意路口",
		caution: "建議留意通行狀況",
		difficult: "通行可能較困難",
	},
	normal: {
		good: "適合前往",
		caution: "建議留意通行狀況",
		difficult: "通行可能較困難",
	},
};

/**
 * Build the Chinese one-line summary for a quick-assess result from facility
 * counts, hazard count, verdict and mode.
 *
 * @param counts Nearby facility counts by category.
 * @param haz Number of active hazard reports nearby.
 * @param verdict The computed verdict.
 * @param mode Accessibility mode driving the closing clause.
 * @param radiusM Search radius in metres (shown in the sentence).
 * @returns A one-sentence Chinese summary.
 */
export function buildQuickAssessSummary(
	counts: QuickAssessFacilityCount,
	haz: number,
	verdict: QuickAssessVerdict,
	mode: QuickAssessMode,
	radiusM: number,
): string {
	const items: string[] = [];
	if (counts.elevator > 0) items.push(`${counts.elevator} 座電梯`);
	if (counts.ramp > 0) items.push(`${counts.ramp} 座無障礙坡道`);
	if (counts.toilet > 0) items.push(`${counts.toilet} 間無障礙廁所`);
	if (counts.parking > 0) items.push(`${counts.parking} 格身障停車格`);

	const facilityText =
		items.length > 0
			? `附近 ${radiusM} 公尺內有${items.join("、")}`
			: `附近 ${radiusM} 公尺內無障礙設施資訊有限`;

	const hazardText = haz > 0 ? `，另有 ${haz} 則通行障礙回報` : "";
	const verdictText = `，${VERDICT_CLAUSE[mode][verdict]}`;

	return `${facilityText}${hazardText}${verdictText}`;
}

/**
 * Aggregate existing nearby facilities, active hazard reports and OSM wheelchair
 * tags around a coordinate into a coarse accessibility verdict — no new data
 * source. Hazard-report failures degrade to a count of 0 rather than failing the
 * whole assessment.
 *
 * @param input.lat Latitude.
 * @param input.lng Longitude.
 * @param input.mode Accessibility mode (default "wheelchair").
 * @param input.radiusM Search radius in metres; clamped to [50, 1000], default 200.
 * @returns The quick-assess result.
 */
/** The a11y-only half of a quick assessment, before campus and hazard data. */
export interface OwnQuickAssessCounts {
	counts: QuickAssessFacilityCount;
	wheelchairTagRatio: number | null;
}

/**
 * Counts this module's own facilities near a point and measures how well the
 * surrounding OSM data is wheelchair-tagged.
 *
 * @param lat Latitude of the search centre
 * @param lng Longitude of the search centre
 * @param radiusM Search radius in metres
 * @returns Per-category counts and the wheelchair tag ratio
 */
export async function countOwnQuickAssess(
	lat: number,
	lng: number,
	radiusM: number,
): Promise<OwnQuickAssessCounts> {
	const { metro, osm, bathroom, parking } = await findQuickAssessRows(
		lat,
		lng,
		radiusM,
	);

	const counts: QuickAssessFacilityCount = {
		elevator: 0,
		ramp: 0,
		toilet: 0,
		parking: 0,
	};
	for (const doc of metro)
		bumpCategory(counts, classifyMetroCategory(doc["出入口電梯/無障礙坡道名稱"]));
	for (const doc of osm) bumpCategory(counts, mapOsmCategory(doc.category));
	counts.toilet += bathroom.length;
	counts.parking += parking.length;

	const taggedOsm = osm.filter((d) => d.wheelchair != null);
	const wheelchairTagRatio = taggedOsm.length
		? Math.round(
				(taggedOsm.filter(
					(d) => d.wheelchair === "yes" || d.wheelchair === "designated",
				).length /
					taggedOsm.length) *
					100,
			) / 100
		: null;

	return { counts, wheelchairTagRatio };
}
