import { z } from "zod";
import { NavPositionSchema, NavSetRouteSchema } from "./navigation.schema";

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
 * previously-accepted traffic into errors.
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
export type VoiceOutboundMessage =
  | { type: "session.ready" }
  | { type: "error"; code: "LIVE_CONNECT_FAILED" }
  | { type: "nav.error"; code: "NAV_ROUTE_INVALID"; message: string };

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
