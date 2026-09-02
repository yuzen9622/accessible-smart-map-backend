import { z } from "zod";
import { NavPositionSchema, NavSetRouteSchema } from "./navigation.schema";
import type { AccessibleRoute } from "../../types/route";

/**
 * Machine-checkable contract for the voice WebSocket.
 *
 * These schemas describe what `voice.gateway.ts` accepts today, not what the
 * prose protocol document describes. Inbound messages are `safeParse`d at the
 * gateway's message entry; outbound messages are typed only.
 *
 * Message objects are intentionally NOT `.strict()`. The gateway used to
 * validate a freshly-built object holding just the fields it read, so unknown
 * keys on the wire were always ignored — rejecting them now would turn
 * previously-accepted traffic into errors. The reroute outbound frames below
 * are strict because they are a frozen server-to-client contract.
 */

/**
 * Caller-supplied starting position on `session.start`.
 *
 * Kept separate from the message schema because an unusable location is
 * silently dropped rather than failing the handshake.
 */
export const UserLocationSchema = z.object({
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
});

export type UserLocation = z.infer<typeof UserLocationSchema>;

/** The only frame accepted before authentication succeeds. */
export const SessionStartMessageSchema = z.object({
  type: z.literal("session.start"),
  token: z.string(),
  // Validated separately by UserLocationSchema: a bad location must not fail
  // the handshake, it just leaves the session without a starting position.
  userLocation: z.unknown().optional(),
});

/** Client-initiated teardown. */
export const SessionEndMessageSchema = z.object({
  type: z.literal("session.end"),
});

/** Arms turn-by-turn navigation against a previously issued route token. */
export const NavSetRouteMessageSchema = z.object({
  type: z.literal("nav.setRoute"),
  routeToken: NavSetRouteSchema.shape.routeToken,
});

/** A GPS update while navigation is armed. */
export const NavPositionMessageSchema = z.object({
  type: z.literal("nav.position"),
  latitude: NavPositionSchema.shape.latitude,
  longitude: NavPositionSchema.shape.longitude,
  heading: NavPositionSchema.shape.heading,
  accuracy: NavPositionSchema.shape.accuracy,
});

/** Disarms navigation, leaving the voice session open. */
export const NavCancelMessageSchema = z.object({
  type: z.literal("nav.cancel"),
});

/** Every control frame accepted after authentication. */
export const VoiceControlMessageSchema = z.discriminatedUnion("type", [
  SessionEndMessageSchema,
  NavSetRouteMessageSchema,
  NavPositionMessageSchema,
  NavCancelMessageSchema,
]);

export type VoiceControlMessage = z.infer<typeof VoiceControlMessageSchema>;
export type SessionStartMessage = z.infer<typeof SessionStartMessageSchema>;

/** Server-to-client frames emitted by the gateway itself. */
const NavStepDtoSchema = z
  .object({
    index: z.number().int().nonnegative(),
    instruction: z.string(),
    legType: z.enum([
      "WALK",
      "DRIVE",
      "MOTORCYCLE",
      "BUS",
      "METRO",
      "THSR",
      "TRA",
    ]),
    distanceM: z.number().nonnegative().nullable(),
    isTransit: z.boolean(),
  })
  .strict();

export const NavReroutingMessageSchema = z
  .object({
    type: z.literal("nav.rerouting"),
    navigationId: z.string(),
    previousRouteVersion: z.number().int().positive(),
    clientRequestId: z.string().uuid(),
  })
  .strict();

export const NavRouteReplacedMessageSchema = z
  .object({
    type: z.literal("nav.route_replaced"),
    navigationId: z.string(),
    previousRouteVersion: z.number().int().positive(),
    routeVersion: z.number().int().positive(),
    routeToken: z.string().min(1),
    route: z.custom<AccessibleRoute>(
      (value) => typeof value === "object" && value !== null,
    ),
    steps: z.array(NavStepDtoSchema),
    warnings: z.array(z.string()),
    currentStepIndex: z.literal(0),
  })
  .strict();

export const NavRerouteFailedMessageSchema = z
  .object({
    type: z.literal("nav.reroute_failed"),
    navigationId: z.string(),
    previousRouteVersion: z.number().int().positive(),
    code: z.union([
      z.number().int(),
      z.literal("NAV_ROUTE_INVALID"),
      z.literal("REROUTE_FAILED"),
    ]),
    message: z.string(),
    retryable: z.boolean(),
  })
  .strict();

export const VoiceRerouteOutboundMessageSchema = z.discriminatedUnion("type", [
  NavReroutingMessageSchema,
  NavRouteReplacedMessageSchema,
  NavRerouteFailedMessageSchema,
]);

export type VoiceRerouteOutboundMessage = z.infer<
  typeof VoiceRerouteOutboundMessageSchema
>;

export type VoiceOutboundMessage =
  | { type: "session.ready" }
  | { type: "error"; code: "LIVE_CONNECT_FAILED" }
  | { type: "nav.error"; code: "NAV_ROUTE_INVALID"; message: string }
  | VoiceRerouteOutboundMessage;

/**
 * Renders a parse failure as a single-line reason for the server log.
 *
 * @param error The failed parse result's error
 * @returns A compact `path: message` list
 */
export function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}
