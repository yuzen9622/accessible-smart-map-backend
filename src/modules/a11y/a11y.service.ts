import { getServiceCoverageConfig } from "../../config/coverage";
import type {
	ServiceCoverageBbox,
	ServiceCoverageConfig,
} from "../../config/coverage";
import A11y from "../../model/a11y.model";
import BathroomModel from "../../model/bathroom.model";
import OsmA11y from "../../model/osm-a11y.model";
import DisabledParkingModel from "../../model/disabled-parking.model";
import type {
	IA11y,
	IOsmA11y,
	IBathroom,
	IDisabledParking,
	OsmWheelchairValue,
} from "../../types";
import * as campusService from "../campus/campus.service";
import type { CampusFacilityPlace } from "../campus/campus.service";
import { findNearby as findNearbyReports } from "../hazard-report/hazard-report.service";

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
export function campusToA11yPlace(f: CampusFacilityPlace): A11yPlace {
	return {
		項次: f.facUid,
		"出入口電梯/無障礙坡道名稱": f.name ?? f.facType ?? "校園無障礙設施",
		location: f.location,
		source: "campus",
		campusId: f.campusId,
		schoolName: f.schoolName,
		facUid: f.facUid,
		facType: f.type,
		facTypeLabel: f.facType,
	};
}

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

const A11Y_MAX_RESULTS = 20000;

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

function mapCampusCategory(code?: string): A11yCategory {
	switch (code) {
		case "ramp":
			return "ramp";
		case "elevator":
			return "elevator";
		case "accessible_toilet":
			return "toilet";
		case "accessible_parking":
		case "accessible_motorcycle_parking":
			return "parking";
		default:
			return "other";
	}
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

function campusToFacility(f: CampusFacilityPlace): A11yFacility {
	return {
		_id: f.facUid,
		name: f.name ?? f.facType ?? "校園無障礙設施",
		location: f.location,
		category: mapCampusCategory(f.type),
		source: "campus",
		schoolName: f.schoolName,
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
export async function findAllFacilities(
	categories?: A11yCategory[],
): Promise<A11yFacility[]> {
	const want = categories && categories.length > 0 ? new Set(categories) : null;
	const osmCategories = want
		? [...want].flatMap((c) => OSM_CATEGORIES_BY_FACILITY[c] ?? [])
		: null;
	const [metro, osm, campus, bathroom, parking] = await Promise.all([
		!want || want.has("elevator") || want.has("ramp") || want.has("other")
			? A11y.find().sort({ _id: 1 }).limit(A11Y_MAX_RESULTS).lean()
			: [],
		!osmCategories
			? OsmA11y.find().sort({ _id: 1 }).limit(A11Y_MAX_RESULTS).lean()
			: osmCategories.length > 0
				? OsmA11y.find({ category: { $in: osmCategories } })
						.sort({ _id: 1 })
						.limit(A11Y_MAX_RESULTS)
						.lean()
				: [],
		campusService.findAllFacilities(),
		!want || want.has("toilet")
			? BathroomModel.find({ type: "無障礙廁所" })
					.sort({ _id: 1 })
					.limit(A11Y_MAX_RESULTS)
					.lean()
			: [],
		!want || want.has("parking")
			? DisabledParkingModel.find()
					.sort({ _id: 1 })
					.limit(A11Y_MAX_RESULTS)
					.lean()
			: [],
	]);
	const facilities = [
		...metro.map(metroToFacility),
		...osm.map(osmToFacility),
		...campus.slice(0, A11Y_MAX_RESULTS).map(campusToFacility),
		...bathroom.map(bathroomToFacility),
		...parking.map(parkingToFacility),
	];
	return want ? facilities.filter((f) => want.has(f.category)) : facilities;
}

/**
 * Elevator facilities only: metro names containing 電梯, OSM `elevator`, and
 * campus facilities whose resolved type code is `elevator`.
 */
export async function findElevatorFacilities(): Promise<A11yFacility[]> {
	const [metro, osm, campus] = await Promise.all([
		A11y.find({ "出入口電梯/無障礙坡道名稱": { $regex: "電梯" } })
			.sort({ _id: 1 })
			.limit(A11Y_MAX_RESULTS)
			.lean(),
		OsmA11y.find({ category: "elevator" })
			.sort({ _id: 1 })
			.limit(A11Y_MAX_RESULTS)
			.lean(),
		campusService.findAllFacilities(),
	]);
	return [
		...metro.map(metroToFacility),
		...osm.map(osmToFacility),
		...campus
			.filter((f) => f.type === "elevator")
			.slice(0, A11Y_MAX_RESULTS)
			.map(campusToFacility),
	];
}

/**
 * Ramp facilities only: metro names containing 坡道 but NOT 電梯 (mutually
 * exclusive with the elevator route), OSM `ramp`, and campus `ramp`.
 */
export async function findRampFacilities(): Promise<A11yFacility[]> {
	const [metro, osm, campus] = await Promise.all([
		A11y.find({
			$and: [
				{ "出入口電梯/無障礙坡道名稱": { $regex: "坡道" } },
				{ "出入口電梯/無障礙坡道名稱": { $not: /電梯/ } },
			],
		})
			.sort({ _id: 1 })
			.limit(A11Y_MAX_RESULTS)
			.lean(),
		OsmA11y.find({ category: "ramp" })
			.sort({ _id: 1 })
			.limit(A11Y_MAX_RESULTS)
			.lean(),
		campusService.findAllFacilities(),
	]);
	return [
		...metro.map(metroToFacility),
		...osm.map(osmToFacility),
		...campus
			.filter((f) => f.type === "ramp")
			.slice(0, A11Y_MAX_RESULTS)
			.map(campusToFacility),
	];
}

/**
 * Accessible bathroom facilities: the bathroom collection, OSM `toilet`, and
 * campus `accessible_toilet`. Metro has no bathroom data.
 */
export async function findBathroomFacilities(): Promise<A11yFacility[]> {
	const [bathroom, osm, campus] = await Promise.all([
		BathroomModel.find({ type: "無障礙廁所" })
			.sort({ _id: 1 })
			.limit(A11Y_MAX_RESULTS)
			.lean(),
		OsmA11y.find({ category: "toilet" })
			.sort({ _id: 1 })
			.limit(A11Y_MAX_RESULTS)
			.lean(),
		campusService.findAllFacilities(),
	]);
	return [
		...bathroom.map(bathroomToFacility),
		...osm.map(osmToFacility),
		...campus
			.filter((f) => f.type === "accessible_toilet")
			.slice(0, A11Y_MAX_RESULTS)
			.map(campusToFacility),
	];
}

/**
 * Parking lookup is user-scalable (radius is client-supplied), so cap both the
 * search radius and the result set to keep a single request from pulling the
 * whole parking dataset.
 */
const PARKING_MAX_RADIUS_M = 5000;
const PARKING_MAX_RESULTS = 50;

export async function findNearbyParking(
	lat: number,
	lng: number,
	radiusM = 300,
) {
	const cappedRadius = Math.min(radiusM, PARKING_MAX_RADIUS_M);
	return DisabledParkingModel.find({
		location: makeGeoQuery(lng, lat, cappedRadius),
	})
		.limit(PARKING_MAX_RESULTS)
		.lean();
}

export async function findNearby(lat: number, lng: number, radiusM = 150) {
	const geoQuery = makeGeoQuery(lng, lat, radiusM);
	const [
		nearbyMetroA11y,
		nearbyBathroom,
		nearbyOsm,
		nearbyParking,
		nearbyCampus,
	] = await Promise.all([
		A11y.find({ location: geoQuery }).lean(),
		BathroomModel.find({ type: "無障礙廁所", location: geoQuery }),
		OsmA11y.find({ location: geoQuery }).lean(),
		DisabledParkingModel.find({ location: geoQuery }),
		campusService.findFacilitiesNearby(lat, lng, radiusM),
	]);
	return {
		nearbyMetroA11y: mergeA11yPlaces(
			nearbyMetroA11y,
			nearbyOsm as IOsmA11y[],
			nearbyCampus.map(campusToA11yPlace),
		),
		nearbyBathroom,
		nearbyOsm,
		nearbyParking,
	};
}

export async function findNearbyLimited(
	lat: number,
	lng: number,
	radiusM = 300,
) {
	const geoQuery = makeGeoQuery(lng, lat, radiusM);
	const [
		nearbyMetroA11y,
		nearbyBathroom,
		nearbyOsm,
		nearbyParking,
		nearbyCampus,
	] = await Promise.all([
		A11y.find({ location: geoQuery }).limit(10).lean(),
		BathroomModel.find({
			type: "無障礙廁所",
			location: makeGeoQuery(lng, lat, 150),
		})
			.limit(5)
			.lean(),
		OsmA11y.find({ location: geoQuery }).limit(15).lean(),
		DisabledParkingModel.find({ location: geoQuery }).limit(10).lean(),
		campusService.findFacilitiesNearby(lat, lng, radiusM),
	]);
	return {
		nearbyMetroA11y: mergeA11yPlaces(
			nearbyMetroA11y,
			nearbyOsm as IOsmA11y[],
			nearbyCampus.slice(0, 15).map(campusToA11yPlace),
		),
		nearbyBathroom,
		nearbyOsm,
		nearbyParking,
	};
}

export async function findByOsmIds(ids: string[]) {
	return OsmA11y.find({ osmId: { $in: ids } }).lean();
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

const QUICK_ASSESS_DEFAULT_RADIUS_M = 200;
const QUICK_ASSESS_MIN_RADIUS_M = 50;
const QUICK_ASSESS_MAX_RADIUS_M = 1000;

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
export async function assessQuickAccess(input: {
	lat: number;
	lng: number;
	mode?: QuickAssessMode;
	radiusM?: number;
}): Promise<QuickAssessResult> {
	const { lat, lng } = input;
	const mode = input.mode ?? "wheelchair";
	const radiusM = Math.min(
		QUICK_ASSESS_MAX_RADIUS_M,
		Math.max(
			QUICK_ASSESS_MIN_RADIUS_M,
			input.radiusM ?? QUICK_ASSESS_DEFAULT_RADIUS_M,
		),
	);

	const geoQuery = makeGeoQuery(lng, lat, radiusM);
	const [metro, osm, bathroom, parking, campus, hazard] = await Promise.all([
		A11y.find({ location: geoQuery }).lean(),
		OsmA11y.find({ location: geoQuery }).lean(),
		BathroomModel.find({ type: "無障礙廁所", location: geoQuery }).lean(),
		DisabledParkingModel.find({ location: geoQuery }).lean(),
		campusService.findFacilitiesNearby(lat, lng, radiusM),
		findNearbyReports({ lat, lng, radius: radiusM }).catch(() => null),
	]);

	const counts: QuickAssessFacilityCount = {
		elevator: 0,
		ramp: 0,
		toilet: 0,
		parking: 0,
	};
	const bump = (category: A11yCategory) => {
		if (category === "elevator") counts.elevator++;
		else if (category === "ramp") counts.ramp++;
		else if (category === "toilet") counts.toilet++;
		else if (category === "parking") counts.parking++;
	};

	for (const doc of metro as IA11y[])
		bump(classifyMetroCategory(doc["出入口電梯/無障礙坡道名稱"]));
	for (const doc of osm as IOsmA11y[]) bump(mapOsmCategory(doc.category));
	counts.toilet += (bathroom as IBathroom[]).length;
	counts.parking += (parking as IDisabledParking[]).length;
	for (const f of campus) bump(mapCampusCategory(f.type));

	const taggedOsm = (osm as IOsmA11y[]).filter((d) => d.wheelchair != null);
	const wheelchairTagRatio = taggedOsm.length
		? Math.round(
				(taggedOsm.filter(
					(d) => d.wheelchair === "yes" || d.wheelchair === "designated",
				).length /
					taggedOsm.length) *
					100,
			) / 100
		: null;

	const activeHazardReports =
		hazard && hazard.ok && hazard.data
			? ((hazard.data as { total?: number }).total ?? 0)
			: 0;

	const verdict = computeVerdict(counts, activeHazardReports, mode);
	const summary = buildQuickAssessSummary(
		counts,
		activeHazardReports,
		verdict,
		mode,
		radiusM,
	);

	return {
		verdict,
		summary,
		facilityCount: counts,
		activeHazardReports,
		wheelchairTagRatio,
		radiusM,
		mode,
	};
}
