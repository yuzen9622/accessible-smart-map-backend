import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { registry } from "../openapi/registry";

extendZodWithOpenApi(z);

/**
 * Structured travel intent parsed out of a free-form query.
 *
 * Lives in the neutral schema layer rather than inside either feature module:
 * the `ai` module produces it and the `accessible-route` module consumes it, so
 * owning it in one of them forces the other to import upward and closes a
 * dependency cycle. The runtime type counterpart is `RouteIntent` in
 * `src/types/ai.ts`.
 */
export const RouteIntentSchema = z
  .object({
    from: z.string().openapi({ example: "台中車站" }),
    to: z.string().openapi({ example: "高鐵新竹站" }),
    mode: z
      .enum(["wheelchair", "elderly", "visual_impaired", "normal"])
      .openapi({ example: "wheelchair" }),
    departureTime: z.string().openapi({
      example: "now",
      description: "'now' 或 HH:mm／ISO8601",
    }),
    preferences: z.object({
      minimizeTransfers: z.boolean().openapi({ example: false }),
      preferElevator: z.boolean().openapi({ example: true }),
    }),
  })
  .openapi("RouteIntent");

// Registered here, from the module both consumers import, so the component is
// defined by this canonical shape. Without it the definition would come from
// whichever consumer the OpenAPI document happens to load first, and a caller
// that decorates the reference (accessible-route.schema.ts attaches its own
// `description`) would leak that decoration into the shared component.
registry.register("RouteIntent", RouteIntentSchema);
