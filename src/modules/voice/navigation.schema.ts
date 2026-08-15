import { z } from "zod";

export const ROUTE_TOKEN_MAX_LENGTH = 256;

export const NavSetRouteSchema = z
  .object({
    routeToken: z.string().trim().min(1).max(ROUTE_TOKEN_MAX_LENGTH),
  })
  .strict();

export const NavPositionSchema = z
  .object({
    latitude: z.number().finite().min(-90).max(90),
    longitude: z.number().finite().min(-180).max(180),
    heading: z.number().finite().min(0).max(360).optional(),
    accuracy: z.number().finite().min(0).max(10_000).optional(),
  })
  .strict();

export type NavPosition = z.infer<typeof NavPositionSchema>;
