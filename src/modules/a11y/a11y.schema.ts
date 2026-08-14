import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { registry } from "../../openapi/registry";
import { A11Y_CATEGORIES } from "./a11y.service";

extendZodWithOpenApi(z);

export const ServiceCoverageQuerySchema = z.object({}).strict();

export const NearbyA11yQuerySchema = z
	.object({
		lat: z
			.string()
			.regex(/^-?\d+(\.\d+)?$/, "Must be a valid latitude")
			.openapi({ example: "25.0330" }),
		lng: z
			.string()
			.regex(/^-?\d+(\.\d+)?$/, "Must be a valid longitude")
			.openapi({ example: "121.5654" }),
	})
	.strict();

export const QuickAssessQuerySchema = z
	.object({
		lat: z
			.string()
			.regex(/^-?\d+(\.\d+)?$/, "Must be a valid latitude")
			.openapi({ example: "25.0330" }),
		lng: z
			.string()
			.regex(/^-?\d+(\.\d+)?$/, "Must be a valid longitude")
			.openapi({ example: "121.5654" }),
		mode: z
			.enum(["wheelchair", "elderly", "visual_impaired", "normal"])
			.optional()
			.openapi({
				example: "wheelchair",
				description: "通行模式，預設 wheelchair",
			}),
		radius: z
			.string()
			.regex(/^\d+$/, "Must be a positive integer (metres)")
			.optional()
			.openapi({
				example: "200",
				description: "搜尋半徑（公尺），預設 200，範圍 50–1000",
			}),
	})
	.strict();

export const A11yPlaceQuerySchema = z
	.object({
		osmId: z.string().min(1).openapi({
			example: "12342946149",
			description: "OSM 設施 id，可用逗號分隔做批次查詢（如「123,456」）",
		}),
	})
	.strict();

export const ParkingNearbyQuerySchema = z
	.object({
		lat: z
			.string()
			.regex(/^-?\d+(\.\d+)?$/, "Must be a valid latitude")
			.openapi({ example: "25.1500" }),
		lng: z
			.string()
			.regex(/^-?\d+(\.\d+)?$/, "Must be a valid longitude")
			.openapi({ example: "121.4000" }),
		radius: z
			.string()
			.regex(/^\d{1,4}$/, "Must be a positive integer (metres), at most 9999")
			.optional()
			.openapi({
				example: "300",
				description: "搜尋半徑（公尺），預設 300，上限 5000",
			}),
	})
	.strict();

const GeoPointSchema = z
	.object({
		type: z.literal("Point").openapi({ example: "Point" }),
		coordinates: z
			.tuple([z.number(), z.number()])
			.openapi({ example: [121.5654, 25.033] }),
	})
	.openapi("GeoPoint");

export const A11ySchema = z
	.object({
		_id: z.string().optional().openapi({ example: "66a1f2c3e4b5a6d7c8e9f0a1" }),
		項次: z.string().openapi({ example: "1" }),
		"出入口電梯/無障礙坡道名稱": z
			.string()
			.openapi({ example: "台北車站 M8 出口電梯" }),
		location: GeoPointSchema,
		source: z.enum(["metro", "osm"]).openapi({
			example: "metro",
			description: "資料來源：北捷官方資料或 OSM",
		}),
		osmId: z.string().optional().openapi({
			example: "12342946149",
			description: "source 為 osm 時的 OSM 節點 id，可用於 /a11y/place 查詳情",
		}),
		wheelchair: z.enum(["yes", "limited", "no"]).optional().openapi({
			example: "yes",
			description: "source 為 osm 時的輪椅可用性標記",
		}),
		category: z.enum(["elevator", "ramp"]).optional().openapi({
			example: "elevator",
			description: "source 為 osm 時的設施類別",
		}),
	})
	.openapi("A11y");

const A11yCategoryEnum = z
	.enum(A11Y_CATEGORIES)
	.openapi({ example: "elevator" });

export const AllFacilitiesQuerySchema = z
	.object({
		category: z
			.string()
			.min(1)
			.transform((s) => [...new Set(s.split(",").map((t) => t.trim()))])
			.pipe(z.array(z.enum(A11Y_CATEGORIES)).min(1))
			.optional()
			.openapi({
				example: "elevator,ramp,toilet",
				description:
					"逗號分隔的類別白名單（elevator / ramp / toilet / parking / other），省略時回傳全部類別",
			}),
	})
	.strict();

export const A11yFacilitySchema = z
	.discriminatedUnion("source", [
		z
			.object({
				_id: z.string().openapi({ example: "66a1f2c3e4b5a6d7c8e9f0a1" }),
				name: z.string().openapi({ example: "台北車站 M8 出口電梯" }),
				location: GeoPointSchema,
				category: A11yCategoryEnum,
				source: z.literal("metro"),
				exitName: z.string().nullable().openapi({
					example: "M8",
					description: "出口代號，無法解析時為 null",
				}),
			})
			.strict(),
		z
			.object({
				_id: z.string(),
				name: z.string().openapi({ example: "無障礙坡道" }),
				location: GeoPointSchema,
				category: A11yCategoryEnum,
				source: z.literal("osm"),
				osmId: z.string().openapi({
					example: "12342946149",
					description: "可用於 /a11y/place 查詳情",
				}),
				wheelchair: z
					.enum(["yes", "limited", "no"])
					.nullable()
					.openapi({ example: "yes" }),
			})
			.strict(),
		z
			.object({
				_id: z.string(),
				name: z.string().openapi({ example: "無障礙電梯" }),
				location: GeoPointSchema,
				category: A11yCategoryEnum,
				source: z.literal("campus"),
				schoolName: z.string().openapi({ example: "國立臺北科技大學" }),
			})
			.strict(),
		z
			.object({
				_id: z.string(),
				name: z.string().openapi({ example: "台北車站無障礙廁所" }),
				location: GeoPointSchema,
				category: A11yCategoryEnum,
				source: z.literal("bathroom"),
			})
			.strict(),
		z
			.object({
				_id: z.string(),
				name: z.string().openapi({ example: "商港八路身障停車格" }),
				location: GeoPointSchema,
				category: A11yCategoryEnum,
				source: z.literal("parking"),
			})
			.strict(),
	])
	.openapi("A11yFacility");

export const BathroomSchema = z
	.object({
		_id: z.string().openapi({ example: "66a1f2c3e4b5a6d7c8e9f0b2" }),
		county: z.string().openapi({ example: "臺北市" }),
		areacode: z.string().openapi({ example: "100" }),
		village: z.string().openapi({ example: "黎明里" }),
		number: z.string().openapi({ example: "A001" }),
		name: z.string().openapi({ example: "台北車站無障礙廁所" }),
		address: z.string().openapi({ example: "臺北市中正區忠孝西路一段49號" }),
		administration: z.string().openapi({ example: "臺北市政府" }),
		location: GeoPointSchema,
		grade: z.string().openapi({ example: "特優級" }),
		type2: z.string().openapi({ example: "公共場所" }),
		type: z.string().openapi({ example: "無障礙廁所" }),
		exec: z.string().openapi({ example: "臺北市政府環境保護局" }),
		diaper: z.string().openapi({ example: "有" }),
	})
	.openapi("Bathroom");

export const OsmA11ySchema = z
	.object({
		osmId: z.string().openapi({ example: "node/1234567890" }),
		name: z.string().optional().openapi({ example: "無障礙坡道" }),
		category: z
			.enum(["wheelchair_accessible", "kerb_cut", "ramp", "elevator", "toilet"])
			.openapi({ example: "ramp" }),
		wheelchair: z
			.enum(["yes", "limited", "no"])
			.optional()
			.openapi({ example: "yes" }),
		tags: z
			.record(z.string(), z.string())
			.openapi({ example: { wheelchair: "yes", highway: "elevator" } }),
		location: GeoPointSchema,
		importedAt: z.string().openapi({ example: "2026-06-01T00:00:00.000Z" }),
	})
	.openapi("OsmA11y");

export const DisabledParkingSchema = z
	.object({
		_id: z.string().openapi({ example: "66a1f2c3e4b5a6d7c8e9f0c3" }),
		city: z.string().openapi({ example: "新北市" }),
		district: z.string().openapi({ example: "八里區" }),
		areacode: z.string().optional().openapi({ example: "65000230" }),
		quantity: z.number().openapi({ example: 1 }),
		placeName: z.string().openapi({ example: "商港八路" }),
		chargeType: z.string().optional().openapi({ example: "假日計時收費" }),
		spaceLabel: z.string().optional().openapi({ example: "身汽1" }),
		isMarked: z.boolean().openapi({ example: true }),
		source: z.string().optional().openapi({
			example: "tdx",
			description: "資料來源（tdx / ntpc / taipei）",
		}),
		externalId: z
			.string()
			.optional()
			.openapi({ example: "25053", description: "來源端唯一識別碼" }),
		location: GeoPointSchema,
		importedAt: z.string().openapi({ example: "2026-06-24T00:00:00.000Z" }),
	})
	.openapi("DisabledParking");

const ApiResponseSchema = <T extends z.ZodTypeAny>(data: T, refName: string) =>
	z
		.object({
			ok: z.boolean().openapi({ example: true }),
			status: z.enum(["success", "error"]).openapi({ example: "success" }),
			code: z.number().openapi({ example: 200 }),
			message: z.string().openapi({ example: "OK" }),
			data: data.optional(),
			accessToken: z.string().optional(),
		})
		.openapi(refName);

export const AllFacilitiesResponseSchema = ApiResponseSchema(
	z.array(A11yFacilitySchema),
	"AllFacilitiesResponse",
);

export const InvalidInputResponseSchema = ApiResponseSchema(
	z
		.object({
			errors: z.array(
				z.object({
					path: z.string().openapi({ example: "category" }),
					message: z.string().openapi({ example: "Invalid input" }),
				}),
			),
		})
		.openapi("ValidationErrorData"),
	"InvalidInputResponse",
);

export const ServiceCoverageDataSchema = z
	.object({
		bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).openapi({
			example: [117.9, 21.85, 122.6, 26.55],
			description:
				"服務涵蓋範圍的外接矩形，固定順序為 [minLng, minLat, maxLng, maxLat]，對應部署時 OTP/Valhalla 實際圖資涵蓋範圍（可經 SERVICE_COVERAGE_BBOX 裁切為單一城市）。",
		}),
		maxRouteDistanceKm: z.number().int().positive().openapi({
			example: 100,
			description: "單次路線規劃允許的最長距離（公里），必須為正整數。",
		}),
	})
	.strict()
	.openapi("ServiceCoverageData");

export const ServiceCoverageResponseSchema = ApiResponseSchema(
	ServiceCoverageDataSchema,
	"ServiceCoverageResponse",
);

registry.registerPath({
	method: "get",
	path: "/a11y/coverage",
	tags: ["Accessibility"],
	summary: "服務涵蓋範圍",
	description:
		"公開回傳部署的靜態服務涵蓋設定，不需驗證。bbox 順序固定為 [minLng, minLat, maxLng, maxLat]，反映 OTP/Valhalla 實際圖資涵蓋範圍（可能經 SERVICE_COVERAGE_BBOX 裁切為單一城市）；maxRouteDistanceKm 為單次路線最長距離（公里）。不接受任何 query 參數。",
	security: [],
	request: { query: ServiceCoverageQuerySchema },
	responses: {
		200: {
			description: "服務涵蓋設定",
			content: {
				"application/json": { schema: ServiceCoverageResponseSchema },
			},
		},
		400: {
			description: "未知 query 參數",
			content: {
				"application/json": { schema: InvalidInputResponseSchema },
			},
		},
		500: { description: "伺服器錯誤" },
	},
});

export const AllBathroomsResponseSchema = ApiResponseSchema(
	z.array(A11yFacilitySchema),
	"AllBathroomsResponse",
);

export const AllRampsResponseSchema = ApiResponseSchema(
	z.array(A11yFacilitySchema),
	"AllRampsResponse",
);

export const AllElevatorsResponseSchema = ApiResponseSchema(
	z.array(A11yFacilitySchema),
	"AllElevatorsResponse",
);

export const NearbyA11yDataSchema = z
	.object({
		nearbyMetroA11y: z.array(A11ySchema),
		nearbyBathroom: z.array(BathroomSchema),
		nearbyOsm: z.array(OsmA11ySchema),
		nearbyParking: z.array(DisabledParkingSchema),
	})
	.openapi("NearbyA11yData");

export const NearbyA11yResponseSchema = ApiResponseSchema(
	NearbyA11yDataSchema,
	"NearbyA11yResponse",
);

registry.registerPath({
	method: "get",
	path: "/a11y/all-facilities",
	tags: ["Accessibility"],
	summary: "所有無障礙設施",
	description:
		"回傳所有無障礙設施（捷運、OSM、校園、廁所、身障停車格聯集），統一正規化形狀，每筆以 source 區分來源、category 區分類別，不分頁。可用 category 參數（逗號分隔白名單）只取需要的類別；參數含非法值或未知 query key 時回傳 400。",
	request: { query: AllFacilitiesQuerySchema },
	responses: {
		200: {
			description: "無障礙設施清單",
			content: { "application/json": { schema: AllFacilitiesResponseSchema } },
		},
		400: {
			description: "查詢參數不合法（data.errors 帶欄位錯誤明細）",
			content: { "application/json": { schema: InvalidInputResponseSchema } },
		},
		500: { description: "伺服器錯誤" },
	},
});

registry.registerPath({
	method: "get",
	path: "/a11y/all-bathrooms",
	tags: ["Accessibility"],
	summary: "所有無障礙廁所",
	description:
		"回傳所有無障礙廁所（廁所資料庫＋OSM toilet＋校園無障礙廁所），統一正規化形狀，不分頁。",
	responses: {
		200: {
			description: "無障礙廁所清單",
			content: { "application/json": { schema: AllBathroomsResponseSchema } },
		},
		500: { description: "伺服器錯誤" },
	},
});

registry.registerPath({
	method: "get",
	path: "/a11y/all-ramps",
	tags: ["Accessibility"],
	summary: "所有無障礙坡道",
	description:
		"回傳所有無障礙坡道（捷運坡道＋OSM ramp＋校園坡道），統一正規化形狀，不分頁。",
	responses: {
		200: {
			description: "無障礙坡道清單",
			content: { "application/json": { schema: AllRampsResponseSchema } },
		},
		500: { description: "伺服器錯誤" },
	},
});

registry.registerPath({
	method: "get",
	path: "/a11y/all-elevators",
	tags: ["Accessibility"],
	summary: "所有無障礙電梯",
	description:
		"回傳所有無障礙電梯（捷運電梯＋OSM elevator＋校園電梯），統一正規化形狀，不分頁。",
	responses: {
		200: {
			description: "無障礙電梯清單",
			content: { "application/json": { schema: AllElevatorsResponseSchema } },
		},
		500: { description: "伺服器錯誤" },
	},
});

registry.registerPath({
	method: "get",
	path: "/a11y/nearby-a11y",
	tags: ["Accessibility"],
	summary: "鄰近無障礙設施",
	description:
		"回傳指定座標 150 公尺內的無障礙電梯/坡道（nearbyMetroA11y，北捷官方＋OSM 合併）、廁所、OSM 節點與身障停車格。",
	request: {
		query: NearbyA11yQuerySchema,
	},
	responses: {
		200: {
			description: "鄰近無障礙、廁所、OSM 與停車格資料",
			content: { "application/json": { schema: NearbyA11yResponseSchema } },
		},
		400: { description: "缺少或無效的經緯度" },
		500: { description: "伺服器錯誤" },
	},
});

export const QuickAssessDataSchema = z
	.object({
		verdict: z
			.enum(["good", "caution", "difficult"])
			.openapi({ example: "good", description: "整體通行評估" }),
		summary: z.string().openapi({
			example: "附近 200 公尺內有 3 座電梯、2 間無障礙廁所，適合輪椅前往",
		}),
		facilityCount: z
			.object({
				elevator: z.number().openapi({ example: 3 }),
				ramp: z.number().openapi({ example: 1 }),
				toilet: z.number().openapi({ example: 2 }),
				parking: z.number().openapi({ example: 0 }),
			})
			.openapi("QuickAssessFacilityCount"),
		activeHazardReports: z
			.number()
			.openapi({ example: 1, description: "半徑內未過期的通行障礙回報數" }),
		wheelchairTagRatio: z.number().nullable().openapi({
			example: 0.72,
			description:
				"帶 wheelchair 標記的 OSM 設施中標記為 yes 的比例；無帶標記設施時為 null",
		}),
		radiusM: z.number().openapi({ example: 200 }),
		mode: z
			.enum(["wheelchair", "elderly", "visual_impaired", "normal"])
			.openapi({ example: "wheelchair" }),
	})
	.openapi("QuickAssessData");

export const QuickAssessResponseSchema = ApiResponseSchema(
	QuickAssessDataSchema,
	"QuickAssessResponse",
);

registry.registerPath({
	method: "get",
	path: "/a11y/quick-assess",
	tags: ["Accessibility"],
	summary: "目的地快速通行評估",
	description:
		"不需規劃路線，聚合指定座標半徑內（預設 200 公尺）的無障礙設施密度、未過期障礙回報數與 OSM 輪椅標記，回傳依 mode 客製的通行評估（good / caution / difficult）與中文摘要。純聚合既有資料，無新資料源。",
	request: { query: QuickAssessQuerySchema },
	responses: {
		200: {
			description: "快速通行評估結果",
			content: { "application/json": { schema: QuickAssessResponseSchema } },
		},
		400: { description: "缺少或無效的經緯度" },
		500: { description: "伺服器錯誤" },
	},
});

export const ParkingNearbyResponseSchema = ApiResponseSchema(
	z.array(DisabledParkingSchema),
	"ParkingNearbyResponse",
);

registry.registerPath({
	method: "get",
	path: "/a11y/parking/nearby",
	tags: ["Accessibility"],
	summary: "鄰近身障停車格",
	description:
		"回傳指定座標附近的身障汽車停車格（預設半徑 300 公尺，可用 radius 覆寫）。",
	request: {
		query: ParkingNearbyQuerySchema,
	},
	responses: {
		200: {
			description: "鄰近身障停車格清單",
			content: { "application/json": { schema: ParkingNearbyResponseSchema } },
		},
		400: { description: "缺少或無效的經緯度" },
		500: { description: "伺服器錯誤" },
	},
});

export const A11yPlaceResponseSchema = ApiResponseSchema(
	z.array(OsmA11ySchema),
	"A11yPlaceResponse",
);

registry.registerPath({
	method: "get",
	path: "/a11y/place",
	tags: ["Accessibility"],
	summary: "OSM 設施完整詳情",
	description:
		"依 osmId 回傳完整 OsmA11y 文件（含所有標籤），支援逗號分隔批次查詢。",
	request: {
		query: A11yPlaceQuerySchema,
	},
	responses: {
		200: {
			description: "完整設施文件",
			content: { "application/json": { schema: A11yPlaceResponseSchema } },
		},
		400: { description: "缺少 osmId" },
		404: { description: "查無對應設施" },
		500: { description: "伺服器錯誤" },
	},
});
