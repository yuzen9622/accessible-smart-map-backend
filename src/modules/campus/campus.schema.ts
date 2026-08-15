import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { registry } from "../../openapi/registry";
import { CAMPUS_FAC_TYPE_CODES } from "./campus.fac-type";
import { PUBLIC_ID_MAX } from "./campus.util";

extendZodWithOpenApi(z);

const facTypeCodeEnum = z.enum(CAMPUS_FAC_TYPE_CODES as [string, ...string[]]);

const TYPE_DESCRIPTION = `設施類型代碼（英文 code），可用值見 GET /a11y/campus/facility-types，例如 elevator / accessible_toilet / ramp`;

export const CampusNearbyQuerySchema = z
  .object({
    lat: z.coerce.number().min(-90).max(90).openapi({ example: 25.05 }),
    lng: z.coerce.number().min(-180).max(180).openapi({ example: 121.51 }),
    radius: z.coerce
      .number()
      .int()
      .min(100)
      .max(20000)
      .default(1000)
      .openapi({ example: 1000, description: "搜尋半徑（公尺），預設 1000" }),
    type: facTypeCodeEnum
      .optional()
      .openapi({ example: "elevator", description: TYPE_DESCRIPTION }),
  })
  .strict();

export const CampusListQuerySchema = z
  .object({
    city: z
      .string()
      .optional()
      .openapi({ example: "台北市", description: "縣市（臺/台 通用）" }),
    type: facTypeCodeEnum
      .optional()
      .openapi({ example: "elevator", description: TYPE_DESCRIPTION }),
    keyword: z.string().optional().openapi({
      example: "中科大",
      description:
        "校名 / 校區名模糊比對（支援臺台通用、常見簡稱如「中科大」）",
    }),
    schoolId: z.coerce
      .number()
      .int()
      .nonnegative()
      .lt(PUBLIC_ID_MAX)
      .optional()
      .openapi({
        example: 33,
        description: "只列出指定學校（公開 schoolId）的校區",
      }),
    sort: z
      .enum(["name", "-name", "facilities", "-facilities"])
      .optional()
      .openapi({
        example: "name",
        description:
          "排序：name（校名）/ facilities（設施數，多→少）；前綴 - 反向",
      }),
    page: z.coerce.number().int().min(1).default(1).openapi({ example: 1 }),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .default(20)
      .openapi({ example: 20, description: "每頁筆數，預設 20，上限 100" }),
  })
  .strict();

export const CampusSchoolsQuerySchema = z
  .object({
    city: z
      .string()
      .optional()
      .openapi({ example: "台北市", description: "縣市（臺/台 通用）" }),
    keyword: z
      .string()
      .optional()
      .openapi({ example: "科技", description: "校名模糊比對" }),
    page: z.coerce.number().int().min(1).default(1).openapi({ example: 1 }),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .default(50)
      .openapi({ example: 50, description: "每頁筆數，預設 50，上限 100" }),
  })
  .strict();

export const CampusParamsSchema = z
  .object({
    campusId: z.coerce
      .number()
      .int()
      .nonnegative()
      .lt(PUBLIC_ID_MAX)
      .openapi({ example: 29, description: "校區 campusId（正整數）" }),
  })
  .strict();

const GeoPointSchema = z.object({
  type: z.literal("Point"),
  coordinates: z.tuple([z.number(), z.number()]),
});

const FacTypeCountSchema = z.object({
  code: z.string().openapi({ example: "elevator" }),
  label: z.string().openapi({ example: "無障礙電梯" }),
  count: z.number().openapi({ example: 24 }),
});

const CampusFacilitySchema = z.object({
  facUid: z.string().openapi({ example: "F123456" }),
  facTypeId: z.number().optional().openapi({ example: 8 }),
  type: z
    .string()
    .optional()
    .openapi({ example: "elevator", description: "設施類型代碼" }),
  facType: z
    .string()
    .optional()
    .openapi({ example: "無障礙電梯", description: "設施類型中文" }),
  name: z.string().optional().openapi({ example: "行政大樓電梯" }),
  building: z.string().optional().openapi({ example: "行政大樓" }),
  buildingUid: z.string().optional().openapi({ example: "B01" }),
  floors: z.array(z.string()).openapi({ example: ["1", "2", "3"] }),
  floorIds: z.array(z.string()).openapi({ example: ["L1", "L2", "L3"] }),
  location: GeoPointSchema.optional().openapi({
    description: "設施自身座標（GeoJSON Point，coordinates 為 [lng, lat]）",
  }),
  specs: z
    .array(z.object({ label: z.string(), value: z.string() }))
    .optional()
    .openapi({
      example: [
        { label: "機門寬度", value: "90公分" },
        { label: "按鈕旁點字", value: "是" },
      ],
      description: "無障礙規格明細（label/value，依設施類型而異）",
    }),
});

export const CampusSummarySchema = z
  .object({
    campusId: z.number().openapi({ example: 29 }),
    schoolId: z.number().openapi({ example: 33 }),
    schoolName: z.string().openapi({ example: "國立臺中科技大學" }),
    branchName: z.string().openapi({ example: "三民校區" }),
    city: z.string().optional().openapi({ example: "臺中市" }),
    address: z
      .string()
      .optional()
      .openapi({ example: "臺中市北區三民路三段129號" }),
    phone: z.string().optional().openapi({ example: "04-22195000" }),
    location: GeoPointSchema.optional(),
    buildingCount: z.number().openapi({ example: 120 }),
    facilityCount: z.number().openapi({ example: 680 }),
    facTypeSummary: z.array(FacTypeCountSchema).openapi({
      example: [
        { code: "elevator", label: "無障礙電梯", count: 24 },
        { code: "accessible_toilet", label: "無障礙廁所", count: 130 },
      ],
      description: "該校區各設施類型的筆數統計（依類型順序）",
    }),
  })
  .openapi("CampusSummary");

export const CampusDetailSchema = z
  .object({
    _id: z.string().openapi({ example: "66a1f2c3e4b5a6d7c8e9f0d4" }),
    campusId: z.number().openapi({ example: 29 }),
    schoolId: z.number().openapi({ example: 33 }),
    schoolName: z.string().openapi({ example: "國立臺中科技大學" }),
    branchName: z.string().openapi({ example: "三民校區" }),
    city: z.string().optional().openapi({ example: "臺中市" }),
    address: z
      .string()
      .optional()
      .openapi({ example: "臺中市北區三民路三段129號" }),
    phone: z.string().optional().openapi({ example: "04-22195000" }),
    buildingCount: z.number().openapi({ example: 120 }),
    facilityCount: z.number().openapi({ example: 680 }),
    facilities: z.array(CampusFacilitySchema),
    facTypeSummary: z.array(FacTypeCountSchema),
    location: GeoPointSchema.optional(),
    importedAt: z.string().openapi({ example: "2026-06-24T00:00:00.000Z" }),
  })
  .openapi("CampusDetail");

export const CampusFacTypeSchema = z
  .object({
    id: z.number().openapi({ example: 8 }),
    code: z.string().openapi({ example: "elevator" }),
    label: z.string().openapi({ example: "無障礙電梯" }),
    common: z.boolean().openapi({ example: true }),
    seq: z.number().openapi({ example: 7 }),
  })
  .openapi("CampusFacType");

const CampusSchoolSchema = z
  .object({
    schoolId: z.number().openapi({ example: 33 }),
    schoolName: z.string().openapi({ example: "國立臺中科技大學" }),
    city: z.string().optional().openapi({ example: "臺中市" }),
    branchCount: z.number().openapi({ example: 2 }),
    facilityCount: z.number().openapi({ example: 900 }),
  })
  .openapi("CampusSchool");

const CampusListDataSchema = z
  .object({
    items: z.array(CampusSummarySchema),
    totalCount: z.number().openapi({ example: 42 }),
    page: z.number().openapi({ example: 1 }),
    totalPages: z.number().openapi({ example: 3 }),
  })
  .openapi("CampusListData");

const CampusSchoolsDataSchema = z
  .object({
    items: z.array(CampusSchoolSchema),
    totalCount: z.number().openapi({ example: 148 }),
    page: z.number().openapi({ example: 1 }),
    totalPages: z.number().openapi({ example: 3 }),
  })
  .openapi("CampusSchoolsData");

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

export const CampusNearbyResponseSchema = ApiResponseSchema(
  z.array(CampusSummarySchema),
  "CampusNearbyResponse",
);

export const CampusListResponseSchema = ApiResponseSchema(
  CampusListDataSchema,
  "CampusListResponse",
);

export const CampusDetailResponseSchema = ApiResponseSchema(
  CampusDetailSchema,
  "CampusDetailResponse",
);

export const CampusFacTypesResponseSchema = ApiResponseSchema(
  z.array(CampusFacTypeSchema),
  "CampusFacTypesResponse",
);

export const CampusSchoolsResponseSchema = ApiResponseSchema(
  CampusSchoolsDataSchema,
  "CampusSchoolsResponse",
);

registry.registerPath({
  method: "get",
  path: "/a11y/campus/facility-types",
  tags: ["Campus"],
  summary: "校園無障礙設施類型清單",
  description:
    "回傳所有設施類型（id / code / 中文 label / 是否常用 common / 排序 seq），供前端渲染篩選選項。API 的 type 篩選一律使用此處的 code。",
  responses: {
    200: {
      description: "設施類型清單",
      content: { "application/json": { schema: CampusFacTypesResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/a11y/campus/nearby",
  tags: ["Campus"],
  summary: "鄰近校園無障礙設施校區",
  description:
    "回傳指定座標附近的校區摘要（含各設施類型筆數統計 facTypeSummary），不含完整 facilities 陣列。可用 type 篩選具備特定設施的校區。",
  request: { query: CampusNearbyQuerySchema },
  responses: {
    200: {
      description: "鄰近校區摘要清單",
      content: { "application/json": { schema: CampusNearbyResponseSchema } },
    },
    400: { description: "缺少或無效的經緯度" },
    500: { description: "伺服器錯誤" },
  },
});

registry.registerPath({
  method: "get",
  path: "/a11y/campus/schools",
  tags: ["Campus"],
  summary: "校園無障礙設施學校目錄（可篩選、分頁）",
  description:
    "回傳學校層級的目錄（每校一列，含校區數 branchCount 與設施總數 facilityCount），可用 city / keyword 篩選並分頁。",
  request: { query: CampusSchoolsQuerySchema },
  responses: {
    200: {
      description: "學校目錄（含分頁資訊）",
      content: { "application/json": { schema: CampusSchoolsResponseSchema } },
    },
    500: { description: "伺服器錯誤" },
  },
});

registry.registerPath({
  method: "get",
  path: "/a11y/campus",
  tags: ["Campus"],
  summary: "校園無障礙設施校區目錄（可篩選、分頁）",
  description:
    "回傳校區摘要清單，可用 city / type / schoolId 篩選、keyword 對校名與校區名模糊比對，並排序（sort）、分頁（page / limit）。",
  request: { query: CampusListQuerySchema },
  responses: {
    200: {
      description: "校區摘要清單（含分頁資訊）",
      content: { "application/json": { schema: CampusListResponseSchema } },
    },
    500: { description: "伺服器錯誤" },
  },
});

registry.registerPath({
  method: "get",
  path: "/a11y/campus/{campusId}",
  tags: ["Campus"],
  summary: "校區無障礙設施詳情",
  description:
    "依 campusId 回傳單一校區的完整資訊，含 facilities 設施陣列（每筆帶 type 代碼）。",
  request: { params: CampusParamsSchema },
  responses: {
    200: {
      description: "校區詳情",
      content: { "application/json": { schema: CampusDetailResponseSchema } },
    },
    404: { description: "查無此校區" },
    500: { description: "伺服器錯誤" },
  },
});
