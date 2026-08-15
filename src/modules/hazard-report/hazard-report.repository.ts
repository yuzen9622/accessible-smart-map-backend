import { Types } from "mongoose";
import HazardReport from "../../model/hazard-report.model";
import type { HazardStatus, HazardType, IHazardReport } from "../../types";

const EARTH_RADIUS_M = 6_371_000;

const PUBLIC_SELECT = "-reporterId -photoStoragePath -confirmedBy -deniedBy";
const MINE_SELECT = "-photoStoragePath -confirmedBy -deniedBy";

const GEO_SELECT =
	"hazardType severity description reportedLocation reporterId confirmedBy status expiredAt";

/**
 * Matches reports carrying at least one confirmation from somebody other than
 * the reporter. Count-only legacy records fail closed.
 */
const INDEPENDENT_CONFIRMATION_EXPR = {
	$gt: [
		{
			$size: {
				$filter: {
					input: {
						$cond: [{ $isArray: "$confirmedBy" }, "$confirmedBy", []],
					},
					as: "voterId",
					cond: { $ne: ["$$voterId", "$reporterId"] },
				},
			},
		},
		0,
	],
};

/** A hazard report as stored, as a plain object. */
export type HazardReportRecord = IHazardReport & { _id: string };

/** The projection the route-blocking check reads. */
export type HazardGeoProjection = Pick<
	IHazardReport,
	| "_id"
	| "hazardType"
	| "severity"
	| "description"
	| "reportedLocation"
	| "reporterId"
	| "confirmedBy"
	| "status"
	| "expiredAt"
>;

/** The fields a report is created with. */
export interface HazardReportInsert {
	_id: string;
	reporterId: string;
	reportedLocation: { type: "Point"; coordinates: [number, number] };
	hazardType: HazardType;
	severity: IHazardReport["severity"];
	expectedUntil: Date | null;
	description?: string;
	photoUrl: string;
	photoStoragePath: string;
	exifValidation: IHazardReport["exifValidation"];
	aiVerification: IHazardReport["aiVerification"];
	status: HazardStatus;
	expiredAt: Date;
}

function nearQuery(lng: number, lat: number, maxDistanceM: number) {
	return {
		$near: {
			$geometry: { type: "Point", coordinates: [lng, lat] },
			$maxDistance: maxDistanceM,
		},
	};
}

/**
 * Finds a still-active report of the same type at effectively the same place.
 *
 * @param lat Reported latitude
 * @param lng Reported longitude
 * @param radiusM Dedup radius in metres
 * @param hazardType The hazard type being reported
 * @param now Current time, used to exclude already-expired reports
 * @returns The duplicate to merge into, or null
 */
export async function findActiveDuplicate(
	lat: number,
	lng: number,
	radiusM: number,
	hazardType: HazardType,
	now: Date,
): Promise<HazardReportRecord | null> {
	return HazardReport.findOne({
		reportedLocation: nearQuery(lng, lat, radiusM),
		hazardType,
		status: { $in: ["pending", "verified"] },
		expiredAt: { $gt: now },
	}).lean<HazardReportRecord | null>();
}

/**
 * Adds one confirmation vote to a report.
 *
 * @param reportId Report id
 * @param voterId Identity of the confirming party
 * @returns The report after the update, or null when it vanished
 */
export async function addConfirmation(
	reportId: string,
	voterId: string,
): Promise<HazardReportRecord | null> {
	return HazardReport.findOneAndUpdate(
		{ _id: reportId },
		{ $inc: { confirmCount: 1 }, $push: { confirmedBy: voterId } },
		{ returnDocument: "after" },
	).lean<HazardReportRecord | null>();
}

/**
 * Adds one denial vote to a report.
 *
 * @param reportId Report id
 * @param voterId Identity of the denying party
 * @returns The report after the update, or null when it vanished
 */
export async function addDenial(
	reportId: string,
	voterId: string,
): Promise<HazardReportRecord | null> {
	return HazardReport.findOneAndUpdate(
		{ _id: reportId },
		{ $inc: { denyCount: 1 }, $push: { deniedBy: voterId } },
		{ returnDocument: "after" },
	).lean<HazardReportRecord | null>();
}

/**
 * Inserts a new report.
 *
 * @param doc The report to store
 * @returns The stored report
 */
export async function insertReport(
	doc: HazardReportInsert,
): Promise<HazardReportRecord> {
	const created = await HazardReport.create(doc);
	return created.toObject() as unknown as HazardReportRecord;
}

/**
 * Non-expired reports near a point, nearest first.
 *
 * @param lat Latitude of the search centre
 * @param lng Longitude of the search centre
 * @param radiusM Search radius in metres
 * @param statuses Statuses to include
 * @param hazardType Optional hazard-type filter
 * @param limit Maximum rows
 * @returns Public-projected reports
 */
export async function findNearbyReports(
	lat: number,
	lng: number,
	radiusM: number,
	statuses: HazardStatus[],
	hazardType: HazardType | undefined,
	limit: number,
): Promise<Record<string, unknown>[]> {
	return HazardReport.find({
		reportedLocation: nearQuery(lng, lat, radiusM),
		status: { $in: statuses },
		...(hazardType ? { hazardType } : {}),
	})
		.select(PUBLIC_SELECT)
		.limit(limit)
		.lean<Record<string, unknown>[]>();
}

/**
 * Confirmed, still-active hazards inside a circle.
 *
 * Uses `$geoWithin`/`$centerSphere` rather than `$near`, because callers filter
 * by their own route geometry afterwards and do not need distance ordering.
 *
 * @param center Circle centre
 * @param radiusM Circle radius in metres
 * @param limit Hard cap on returned documents
 * @param now Current time, used to exclude expired reports
 * @returns Geo-projected hazards
 */
export async function findConfirmedWithin(
	center: { lat: number; lng: number },
	radiusM: number,
	limit: number,
	now: Date,
): Promise<HazardGeoProjection[]> {
	return HazardReport.find({
		reportedLocation: {
			$geoWithin: {
				$centerSphere: [[center.lng, center.lat], radiusM / EARTH_RADIUS_M],
			},
		},
		status: "verified",
		expiredAt: { $gt: now },
		$expr: INDEPENDENT_CONFIRMATION_EXPR,
	})
		.select(GEO_SELECT)
		.limit(limit)
		.lean<HazardGeoProjection[]>();
}

/**
 * One report by id, with reporter-identifying fields stripped.
 *
 * @param id Candidate report id
 * @returns The public view, or null when the id is malformed or unknown
 */
export async function findPublicReportById(
	id: string,
): Promise<Record<string, unknown> | null> {
	if (!Types.ObjectId.isValid(id)) return null;
	return HazardReport.findById(id)
		.select(PUBLIC_SELECT)
		.lean<Record<string, unknown> | null>();
}

/**
 * One reporter's own reports, newest first, with id-based cursor paging.
 *
 * @param reporterId Owner of the reports
 * @param filter Optional status / hazardType narrowing and paging cursor
 * @param limit Page size
 * @returns The reporter's own projected reports
 */
export async function findReportsByReporter(
	reporterId: string,
	filter: {
		statuses?: string[];
		hazardType?: HazardType;
		cursor?: string;
	},
	limit: number,
): Promise<(Record<string, unknown> & { _id: unknown })[]> {
	const query: Record<string, unknown> = { reporterId };
	if (filter.statuses?.length) query.status = { $in: filter.statuses };
	if (filter.hazardType) query.hazardType = filter.hazardType;
	if (filter.cursor && Types.ObjectId.isValid(filter.cursor)) {
		query._id = { $lt: new Types.ObjectId(filter.cursor) };
	}

	return HazardReport.find(query)
		.select(MINE_SELECT)
		.sort({ createdAt: -1 })
		.limit(limit)
		.lean<(Record<string, unknown> & { _id: unknown })[]>();
}

/**
 * One report by id, with every field.
 *
 * @param id Candidate report id
 * @returns The report, or null when the id is malformed or unknown
 */
export async function findReportById(
	id: string,
): Promise<HazardReportRecord | null> {
	if (!Types.ObjectId.isValid(id)) return null;
	return HazardReport.findById(id).lean<HazardReportRecord | null>();
}
