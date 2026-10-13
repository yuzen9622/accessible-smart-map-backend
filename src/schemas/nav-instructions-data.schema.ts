import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { WALK_RELATIVE_DIRECTION_VALUES } from "../utils/nav-instructions-engine";

extendZodWithOpenApi(z);

/**
 * Shape of the逐步指引 payload produced by the nav-instructions service.
 *
 * It is kept in the neutral schema layer so the endpoint's OpenAPI component
 * remains independent of route-planning request schemas. The only public
 * producer is `POST /a11y/route/instructions`.
 */

export const RelativeDirectionSchema = z
  .enum([
    "正前方",
    "左前方",
    "右前方",
    "左側",
    "右側",
    "左後方",
    "右後方",
    "正後方",
    "ahead",
    "ahead-right",
    "right",
    "behind-right",
    "behind",
    "behind-left",
    "left",
    "ahead-left",
  ])
  .openapi("RelativeDirection");

export const NavManeuverSchema = z
  .enum(WALK_RELATIVE_DIRECTION_VALUES)
  .nullable()
  .openapi("NavManeuver", {
    description:
      "路線引擎給出的步行動作（與 route.legs[].steps[].relativeDirection 同一組 enum）。" +
      "CONTINUE／STRAIGHT 代表沿路直行，含後端把長直線切段產生的進度點，不是轉向點；" +
      "不由 bearing 推算、不受 userHeading 影響。非步行指引（道路、大眾運輸、出口設施、抵達、無 steps 的簡化指引）固定為 null。",
  });

const NavInstructionSchema = z
  .object({
    text: z.string(),
    type: z.enum([
      "turn",
      "transit_board",
      "transit_alight",
      "facility",
      "depart",
      "arrive",
    ]),
    bearing: z.number().nullable(),
    relativeDirection: RelativeDirectionSchema.nullable(),
    maneuver: NavManeuverSchema,
    distanceM: z.number().nullable().openapi({
      description: "完成本步 maneuver 後、到下一步之前要行進的距離（公尺）",
    }),
    streetName: z.string().nullable(),
    legType: z.enum([
      "WALK",
      "DRIVE",
      "MOTORCYCLE",
      "BUS",
      "METRO",
      "THSR",
      "TRA",
    ]),
    stairs: z.boolean().openapi({
      description:
        "此逐步指引對應的步行段是否含樓梯；非步行指引固定為 false。僅代表該段含樓梯，不代表整個 distanceM 都是樓梯。",
    }),
    legIndex: z.number().int().nonnegative().openapi({
      description: "此指引來源在 route.legs 中的索引",
    }),
    polylineIndex: z.number().nullable(),
    cumulativeDistanceM: z.number().nonnegative().openapi({
      description: "抵達此 maneuver 起點前已累積的可量測行進距離（公尺）",
    }),
  })
  .openapi("NavInstruction");

export const NavInstructionsDataSchema = z
  .object({
    instructions: z.array(NavInstructionSchema),
    initialBearing: z.number(),
    totalSteps: z.number(),
    warnings: z.array(
      z.enum([
        "WALK_STEPS_UNAVAILABLE",
        "ORS_STEPS_UNAVAILABLE",
        "ROAD_STEPS_UNAVAILABLE",
      ]),
    ),
  })
  .openapi("NavInstructionsData");
