import { z } from "zod";
import { TransitPreferenceSchema } from "./transit-preference.schema";

export const RouteContextInputSchema = z
  .object({ routeToken: z.string().trim().min(1).max(256) })
  .strict()
  .nullable();
export const RoutingPreferencesSchema = z
  .object({
    mode: z
      .enum(["normal", "wheelchair", "elderly", "visual_impaired"])
      .optional(),
    transitPreference: TransitPreferenceSchema.optional(),
    departureTime: z.iso.datetime({ offset: true }).optional(),
    avoidStairs: z.boolean().optional(),
    requireElevator: z.boolean().optional(),
  })
  .strict();
export const RouteConversationFields = {
  routeContractVersion: z.literal(1).optional(),
  routeContext: RouteContextInputSchema.optional(),
  routingPreferences: RoutingPreferencesSchema.optional(),
};

/** Model tool arguments are another edge; runtime values still need validation. */
export const AgentNavOptionsSchema = z
  .object({
    userHeading: z.number().finite().min(0).max(359).optional(),
    language: z.enum(["zh-TW", "en"]).optional(),
  })
  .strict();
export const AgentAccessibilityOptionsSchema = RoutingPreferencesSchema.pick({
  avoidStairs: true,
  requireElevator: true,
});
