import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

extendZodWithOpenApi(z);

/**
 * Response schemas for an indoor (venue) leg and the outdoor hand-over. Owned
 * by accessible-route, which embeds them; the venue module's own route
 * endpoint reuses them (venue -> accessible-route, never the other way).
 */
export const VENUE_MODES = [
  "wheelchair",
  "elderly",
  "visual_impaired",
  "normal",
] as const;
const MODES = VENUE_MODES;

export const VenueRouteStepSchema = z
  .object({
    type: z.enum([
      "depart",
      "walk",
      "enter",
      "exit",
      "elevator",
      "escalator",
      "stairs",
      "steps",
      "ramp",
      "arrive",
    ]),
    instruction: z.string(),
    maneuver: z.enum(["left", "right", "uturn"]).optional(),
    connectionId: z.string().nullable().optional().openapi({
      description:
        "對應場域 detail.connections[].id；只由坡度推導、沒有可識別來源設施的坡道為 null",
    }),
    heightPending: z.boolean().optional().openapi({
      description:
        "此步驟任一來源邊的高度仍待核實；即使 z 相同也不能當作已確認平地，缺值表示未知",
    }),
    distanceM: z.number(),
    durationS: z.number(),
    buildingId: z.string().nullable(),
    levelRef: z.string().nullable(),
    fromLevelRef: z.string().optional(),
    toLevelRef: z.string().optional(),
    pathStart: z.number().int().openapi({
      description:
        "path 的起點索引（含）；enter/exit 可在邊界前一點觸發，step 建築不代表該點歸屬，實際歸屬以 path.buildingIds/levelRefs 為準",
    }),
    pathEnd: z.number().int().openapi({ description: "path 的終點索引（含）" }),
  })
  .openapi("VenueRouteStep");

export const VenueRouteSegmentSchema = z
  .object({
    buildingId: z.string().nullable().openapi({ description: "戶外為 null" }),
    levelRef: z.string().nullable().openapi({ description: "戶外為 null" }),
    pathStart: z.number().int(),
    pathEnd: z.number().int(),
  })
  .openapi("VenueRouteSegment");

export const VenueRouteSchema = z
  .object({
    venueId: z.string(),
    venueVersion: z.number().int(),
    mode: z.enum(MODES),
    fromPlaceId: z.string(),
    toPlaceId: z.string(),
    distanceM: z
      .number()
      .openapi({ description: "步行距離（公尺，不含電梯）" }),
    durationS: z
      .number()
      .openapi({ description: "預估時間（秒，含電梯等候）" }),
    elevatorRides: z.number().int(),
    stairFlights: z.number().int(),
    path: z.object({
      coordinates: z
        .array(z.tuple([z.number(), z.number(), z.number()]))
        .openapi({
          description:
            "[lng, lat, z]；z 為該點高度（公尺，相對場域基準）：平面上的點是樓板高度，樓梯／坡道中間點可能是內插值",
        }),
      buildingIds: z.array(z.string().nullable()),
      levelRefs: z.array(z.string().nullable()),
    }),
    segments: z.array(VenueRouteSegmentSchema).openapi({
      description:
        "依建築與樓層切開的路段，供前端逐層畫線；相鄰兩段共用交界索引",
    }),
    steps: z.array(VenueRouteStepSchema),
  })
  .openapi("VenueRoute");

export const VenueArrivalSchema = z
  .object({
    venueId: z.string(),
    placeId: z.string(),
    gateId: z.string(),
    gateLocation: z.object({ lat: z.number(), lng: z.number() }),
    mode: z.enum(MODES),
    venueVersion: z.number().int(),
  })
  .openapi("VenueArrival", {
    description:
      "戶外路線交接到場域的校門；整趟行程固定此校門，重新規劃不會換校門。venueVersion 為校內路段實際使用的場域版本。",
  });
