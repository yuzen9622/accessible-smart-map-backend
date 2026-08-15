/**
 * Full-island parking data import from TDX advanced spatial APIs.
 *
 * TDX hosts all-Taiwan parking data behind the *advanced* NearBy endpoints
 * (basic-layer city endpoints return empty; see
 * docs/reports/parking-open-data-research.md §2.0). This script scans urban
 * areas with a hexagonal-ish grid (step ~1.4 km, radius 1000 m, the API's max)
 * and upserts three collections:
 *   - DisabledParking: roadside disabled spots (SpaceType 9/10) — powers the
 *     existing /a11y nearby API and the AI agent's findNearbyParking tool
 *   - ParkingSpace: all other roadside spots (kept for future use)
 *   - ParkingLot: off-street car parks (kept for future use)
 *
 * Run: npm run import:parking-tdx
 * Or a subset: npm run import:parking-tdx -- --cities=臺北市,臺中市
 */

import "dotenv/config";
import mongoose from "mongoose";
import DisabledParkingModel from "../model/disabled-parking.model";
import ParkingSpaceModel from "../model/parking-space.model";
import ParkingLotModel from "../model/parking-lot.model";
import { tdxFetch } from "../config/fetch";
import {
	carParkRowToDoc,
	spotRowToDocs,
	type TdxCarParkRow,
	type TdxParkingSpotRow,
} from "./tdx-parking-parse";

const ADV = "https://tdx.transportdata.tw/api/advanced/v1/Parking";
const GRID_STEP_KM = 1.4;
const RADIUS_M = 1000;
const TOP = 500;
const REQUEST_DELAY_MS = 120;
const RETRY_429_DELAY_MS = 2000;

interface CityBox {
	city: string;
	latMin: number;
	latMax: number;
	lonMin: number;
	lonMax: number;
}

/**
 * Urban bounding boxes covering Taiwan's populated areas (~23 boxes).
 * Parking-spot supply exists only for some cities (Taipei/NewTaipei/Taichung/
 * Tainan/Kaohsiung/Pingtung); car parks exist island-wide.
 */
const CITY_BOXES: CityBox[] = [
	{
		city: "臺北市",
		latMin: 24.99,
		latMax: 25.08,
		lonMin: 121.47,
		lonMax: 121.6,
	},
	{
		city: "新北市",
		latMin: 24.98,
		latMax: 25.07,
		lonMin: 121.44,
		lonMax: 121.53,
	}, // 板橋/三重/中永和
	{
		city: "新北市",
		latMin: 24.93,
		latMax: 24.99,
		lonMin: 121.5,
		lonMax: 121.57,
	}, // 新店
	{
		city: "新北市",
		latMin: 25.04,
		latMax: 25.08,
		lonMin: 121.62,
		lonMax: 121.66,
	}, // 汐止
	{
		city: "新北市",
		latMin: 25.13,
		latMax: 25.2,
		lonMin: 121.4,
		lonMax: 121.49,
	}, // 淡水/八里
	{
		city: "新北市",
		latMin: 25.07,
		latMax: 25.12,
		lonMin: 121.43,
		lonMax: 121.5,
	}, // 蘆洲/五股
	{
		city: "新北市",
		latMin: 25.03,
		latMax: 25.1,
		lonMin: 121.35,
		lonMax: 121.42,
	}, // 林口/泰山
	{
		city: "桃園市",
		latMin: 24.95,
		latMax: 25.03,
		lonMin: 121.25,
		lonMax: 121.33,
	}, // 桃園區
	{
		city: "桃園市",
		latMin: 24.9,
		latMax: 24.98,
		lonMin: 121.17,
		lonMax: 121.26,
	}, // 中壢/平鎮
	{
		city: "新竹市",
		latMin: 24.77,
		latMax: 24.84,
		lonMin: 120.94,
		lonMax: 121.03,
	},
	{
		city: "苗栗縣",
		latMin: 24.66,
		latMax: 24.71,
		lonMin: 120.85,
		lonMax: 120.92,
	}, // 竹南/頭份
	{
		city: "臺中市",
		latMin: 24.1,
		latMax: 24.21,
		lonMin: 120.62,
		lonMax: 120.73,
	}, // 市區
	{
		city: "臺中市",
		latMin: 24.23,
		latMax: 24.26,
		lonMin: 120.7,
		lonMax: 120.73,
	}, // 豐原
	{
		city: "彰化縣",
		latMin: 24.0,
		latMax: 24.08,
		lonMin: 120.53,
		lonMax: 120.6,
	}, // 彰化市/員林
	{
		city: "嘉義市",
		latMin: 23.43,
		latMax: 23.51,
		lonMin: 120.41,
		lonMax: 120.48,
	},
	{
		city: "臺南市",
		latMin: 22.97,
		latMax: 23.04,
		lonMin: 120.17,
		lonMax: 120.26,
	}, // 市區+永康
	{
		city: "高雄市",
		latMin: 22.6,
		latMax: 22.68,
		lonMin: 120.27,
		lonMax: 120.36,
	}, // 市區
	{
		city: "高雄市",
		latMin: 22.58,
		latMax: 22.64,
		lonMin: 120.33,
		lonMax: 120.39,
	}, // 鳳山/大寮
	{
		city: "高雄市",
		latMin: 22.77,
		latMax: 22.81,
		lonMin: 120.27,
		lonMax: 120.32,
	}, // 岡山
	{
		city: "屏東縣",
		latMin: 22.64,
		latMax: 22.7,
		lonMin: 120.47,
		lonMax: 120.53,
	},
	{
		city: "基隆市",
		latMin: 25.12,
		latMax: 25.15,
		lonMin: 121.7,
		lonMax: 121.76,
	},
	{
		city: "宜蘭縣",
		latMin: 24.66,
		latMax: 24.76,
		lonMin: 121.73,
		lonMax: 121.78,
	}, // 宜蘭市/羅東
	{
		city: "花蓮縣",
		latMin: 23.95,
		latMax: 24.02,
		lonMin: 121.58,
		lonMax: 121.63,
	},
	{
		city: "臺東縣",
		latMin: 22.73,
		latMax: 22.78,
		lonMin: 121.1,
		lonMax: 121.16,
	},
];

function sleep(ms: number) {
	return new Promise((r) => setTimeout(r, ms));
}

function parseArgs(): { cities?: Set<string>; dryRun: boolean } {
	const args = process.argv.slice(2);
	let cities: Set<string> | undefined;
	let dryRun = false;
	for (const a of args) {
		if (a.startsWith("--cities=")) {
			cities = new Set(
				a
					.slice(9)
					.split(",")
					.map((s) => s.trim())
					.filter(Boolean),
			);
		}
		if (a === "--dry-run") dryRun = true;
	}
	return { cities, dryRun };
}

async function fetchNearBy(
	kind: "OffStreet/CarPark" | "OnStreet/ParkingSpot",
	lat: number,
	lon: number,
): Promise<any[]> {
	const url = `${ADV}/${kind}/NearBy?$spatialFilter=nearby(${lat.toFixed(5)},${lon.toFixed(5)},${RADIUS_M})&$format=JSON&$top=${TOP}`;
	for (let attempt = 0; attempt < 4; attempt++) {
		let res: Response;
		try {
			res = await tdxFetch(url);
		} catch (_err) {
			// 網路層失敗（ECONNRESET 等）：退避後重試
			console.warn(
				`  net-retry ${attempt + 1}/4 ${kind} @ ${lat.toFixed(2)},${lon.toFixed(2)}`,
			);
			await sleep(RETRY_429_DELAY_MS);
			continue;
		}
		if (res.status === 429) {
			await sleep(RETRY_429_DELAY_MS);
			continue;
		}
		if (!res.ok) {
			const body = await res.text().catch(() => "");
			console.warn(
				`  ${res.status} ${kind} @ ${lat.toFixed(2)},${lon.toFixed(2)}: ${body.slice(0, 80)}`,
			);
			return [];
		}
		const arr = (await res.json()) as any[];
		return Array.isArray(arr) ? arr : [];
	}
	console.warn(
		`  重試失敗，略過 ${kind} @ ${lat.toFixed(2)},${lon.toFixed(2)}`,
	);
	return [];
}

async function scanBox(
	box: CityBox,
	carParks: Map<string, { city: string; row: TdxCarParkRow }>,
	spots: Map<string, { city: string; row: TdxParkingSpotRow }>,
): Promise<{ calls: number }> {
	const midLat = (box.latMin + box.latMax) / 2;
	const dLat = GRID_STEP_KM / 111.0;
	const dLon = GRID_STEP_KM / (111.0 * Math.cos((midLat * Math.PI) / 180));
	let calls = 0;
	for (let lat = box.latMin; lat <= box.latMax; lat += dLat) {
		for (let lon = box.lonMin; lon <= box.lonMax; lon += dLon) {
			const cpArr = await fetchNearBy("OffStreet/CarPark", lat, lon);
			await sleep(REQUEST_DELAY_MS);
			const spotArr = await fetchNearBy("OnStreet/ParkingSpot", lat, lon);
			calls += 2;
			for (const row of cpArr) {
				const id = row.CarParkID;
				if (id && !carParks.has(id)) carParks.set(id, { city: box.city, row });
			}
			for (const row of spotArr) {
				const id = row.ParkingSpotID;
				if (id && !spots.has(id)) spots.set(id, { city: box.city, row });
			}
			await sleep(REQUEST_DELAY_MS);
		}
	}
	return { calls };
}

async function main() {
	const dbUrl = process.env.DATABASE_URL;
	if (!dbUrl) throw new Error("DATABASE_URL env var is required");
	const { cities, dryRun } = parseArgs();

	const boxes = cities
		? CITY_BOXES.filter((b) => cities.has(b.city))
		: CITY_BOXES;
	if (!boxes.length) {
		console.error(`No city boxes match: ${[...(cities ?? [])].join(", ")}`);
		process.exit(1);
	}

	const carParks = new Map<string, { city: string; row: TdxCarParkRow }>();
	const spots = new Map<string, { city: string; row: TdxParkingSpotRow }>();
	let totalCalls = 0;

	const t0 = Date.now();
	for (const box of boxes) {
		console.log(
			`\n掃描 ${box.city} (${box.latMin}-${box.latMax}, ${box.lonMin}-${box.lonMax})`,
		);
		const { calls } = await scanBox(box, carParks, spots);
		totalCalls += calls;
		console.log(
			`  done: carParks=${carParks.size} spots=${spots.size} (累計 calls=${totalCalls})`,
		);
	}

	const disabledDocs = [];
	const spaceDocs = [];
	for (const { city, row } of spots.values()) {
		const { disabled, space } = spotRowToDocs(row, city);
		if (disabled) disabledDocs.push(disabled);
		if (space) spaceDocs.push(space);
	}
	const lotDocs = [];
	for (const { city, row } of carParks.values()) {
		const doc = carParkRowToDoc(row, city);
		if (doc) lotDocs.push(doc);
	}

	console.log(`\n=== 掃描結果 ===`);
	console.log(
		`calls=${totalCalls} 耗時=${((Date.now() - t0) / 1000 / 60).toFixed(1)}min`,
	);
	console.log(`CarPark 去重: ${carParks.size} → ParkingLot ${lotDocs.length}`);
	console.log(
		`ParkingSpot 去重: ${spots.size} → 身障格 ${disabledDocs.length} / 一般格 ${spaceDocs.length}`,
	);

	if (dryRun) {
		console.log("(dry-run，未寫入 DB)");
		await mongoose.disconnect();
		return;
	}

	await mongoose.connect(dbUrl);
	console.log("\nConnected to MongoDB, upserting…");

	// DisabledParking：upsert by { source: "tdx", externalId }
	let dpInserted = 0,
		dpUpdated = 0;
	const DP_CHUNK = 500;
	for (let i = 0; i < disabledDocs.length; i += DP_CHUNK) {
		const ops = disabledDocs.slice(i, i + DP_CHUNK).map((doc) => ({
			updateOne: {
				filter: { source: "tdx", externalId: doc.externalId },
				update: { $set: doc },
				upsert: true,
			},
		}));
		const r = await DisabledParkingModel.bulkWrite(ops, { ordered: false });
		dpInserted += r.upsertedCount ?? 0;
		dpUpdated += r.modifiedCount ?? 0;
	}
	console.log(`✓ DisabledParking: 新增 ${dpInserted} / 更新 ${dpUpdated}`);

	// ParkingSpace：upsert by { city, externalId }
	let psInserted = 0,
		psUpdated = 0;
	for (let i = 0; i < spaceDocs.length; i += DP_CHUNK) {
		const ops = spaceDocs.slice(i, i + DP_CHUNK).map((doc) => ({
			updateOne: {
				filter: { city: doc.city, externalId: doc.externalId },
				update: { $set: doc },
				upsert: true,
			},
		}));
		const r = await ParkingSpaceModel.bulkWrite(ops, { ordered: false });
		psInserted += r.upsertedCount ?? 0;
		psUpdated += r.modifiedCount ?? 0;
	}
	console.log(`✓ ParkingSpace: 新增 ${psInserted} / 更新 ${psUpdated}`);

	// ParkingLot：upsert by { carParkId }
	let plInserted = 0,
		plUpdated = 0;
	for (let i = 0; i < lotDocs.length; i += DP_CHUNK) {
		const ops = lotDocs.slice(i, i + DP_CHUNK).map((doc) => ({
			updateOne: {
				filter: { carParkId: doc.carParkId },
				update: { $set: doc },
				upsert: true,
			},
		}));
		const r = await ParkingLotModel.bulkWrite(ops, { ordered: false });
		plInserted += r.upsertedCount ?? 0;
		plUpdated += r.modifiedCount ?? 0;
	}
	console.log(`✓ ParkingLot: 新增 ${plInserted} / 更新 ${plUpdated}`);

	console.log(
		`\n完成，總耗時 ${((Date.now() - t0) / 1000 / 60).toFixed(1)}min`,
	);
	await mongoose.disconnect();
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
