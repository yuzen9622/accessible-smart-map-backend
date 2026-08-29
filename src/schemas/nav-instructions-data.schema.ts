import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

extendZodWithOpenApi(z);

/**
 * Shape of the逐步指引 payload produced by the nav-instructions service.
 *
 * It is kept in the neutral schema layer so the endpoint's OpenAPI component
 * remains independent of route-planning request schemas. The only public
 * producer is `POST /a11y/route/instructions`.
 */

const RelativeDirectionEnum = z
  .enum([
    "正前方",
    "左前方",
    "右前方",
    "左側",
    "右側",
    "左後方",
    "右後方",
    "正後方",
  ])
  .openapi("RelativeDirection");

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
    relativeDirection: RelativeDirectionEnum.nullable(),
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
