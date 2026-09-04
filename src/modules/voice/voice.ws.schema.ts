import { z } from "zod";
import {
  NavPositionSchema,
  NavSetRouteSchema,
  ROUTE_TOKEN_MAX_LENGTH,
} from "./navigation.schema";
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

/**
 * Re-arms an interrupted navigation from the server-side progress snapshot.
 *
 * `lastKnownStepIndex` is what the client believes it reached; the server
 * snapshot stays authoritative, so this is only a diagnostic hint and never
 * moves progress forward on its own.
 */
export const NavResumeMessageSchema = z.object({
  type: z.literal("nav.resume"),
  navigationId: z.string().trim().min(1).max(128),
  routeVersion: z.number().int().positive(),
  routeToken: z.string().trim().min(1).max(ROUTE_TOKEN_MAX_LENGTH),
  lastKnownStepIndex: z.number().int().nonnegative(),
  currentPosition: NavPositionSchema.optional(),
});

/** Every control frame accepted after authentication. */
export const VoiceControlMessageSchema = z.discriminatedUnion("type", [
  SessionEndMessageSchema,
  NavSetRouteMessageSchema,
  NavPositionMessageSchema,
  NavCancelMessageSchema,
  NavResumeMessageSchema,
]);

export type VoiceControlMessage = z.infer<typeof VoiceControlMessageSchema>;
export type NavResumeMessage = z.infer<typeof NavResumeMessageSchema>;
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
    type: z.string().optional(),
    relativeDirection: z.string().nullable().optional(),
    streetName: z.string().nullable().optional(),
    bearing: z.number().nullable().optional(),
  })
  .strict();

const RerouteReasonSchema = z.enum([
  "OFF_ROUTE",
  "FACILITY_OUTAGE",
  "CONFIRMED_HAZARD",
  "TRANSIT_DISRUPTION",
  "MANUAL",
]);

export const NavReroutingMessageSchema = z
  .object({
    type: z.literal("nav.rerouting"),
    navigationId: z.string(),
    previousRouteVersion: z.number().int().positive(),
    clientRequestId: z.string().uuid(),
    reason: RerouteReasonSchema.optional(),
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
    reason: RerouteReasonSchema.optional(),
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

/**
 * One graded corridor event. `rerouteReason` is mandatory whenever the backend
 * proposes or has already applied a reroute, because the client replays it as
 * the reason on its own HTTP reroute call.
 */
export const NavAdvisorySchema = z
  .object({
    advisoryId: z.string().min(1),
    category: z.enum(["facility", "transit_alert", "hazard", "traffic"]),
    severity: z.enum(["info", "warning", "critical"]),
    action: z.enum(["none", "reroute_suggested", "reroute_applied"]),
    title: z.string().min(1),
    detail: z.string().optional(),
    speech: z.string().min(1),
    rerouteReason: RerouteReasonSchema.optional(),
    location: z
      .object({
        latitude: z.number().finite().min(-90).max(90),
        longitude: z.number().finite().min(-180).max(180),
      })
      .optional(),
    distanceAheadM: z.number().nonnegative().optional(),
    issuedAt: z.string().min(1),
  })
  .strict()
  .refine((v) => v.action === "none" || v.rerouteReason !== undefined, {
    message: 'rerouteReason is required when action is not "none"',
  });

export const NavAdvisoryMessageSchema = z
  .object({
    type: z.literal("nav.advisory"),
    navigationId: z.string(),
    routeVersion: z.number().int().positive(),
    advisories: z.array(NavAdvisorySchema).min(1),
  })
  .strict();

export type NavAdvisoryMessage = z.infer<typeof NavAdvisoryMessageSchema>;

/**
 * Live progress push emitted on every processed position while navigating.
 *
 * `etaSource` states how `remainingDurationSec` was obtained so the client can
 * present a schedule- or realtime-backed arrival differently from a walking
 * estimate; it is never a confidence score.
 */
export const NavProgressSchema = z.object({
  type: z.literal("nav.progress"),
  navigationId: z.string().uuid(),
  routeVersion: z.number().int().positive(),
  currentStepIndex: z.number().int().nonnegative(),
  remainingDistanceM: z.number().nonnegative(),
  remainingDurationSec: z.number().nonnegative(),
  estimatedArrivalAt: z.string(),
  etaSource: z.enum(["schedule", "realtime", "free_flow", "estimated"]),
  distanceToNextM: z.number().nonnegative().nullable(),
});

export type NavProgressEvent = z.infer<typeof NavProgressSchema>;

export const VoiceRerouteOutboundMessageSchema = z.discriminatedUnion("type", [
  NavReroutingMessageSchema,
  NavRouteReplacedMessageSchema,
  NavRerouteFailedMessageSchema,
]);

export type VoiceRerouteOutboundMessage = z.infer<
  typeof VoiceRerouteOutboundMessageSchema
>;

/**
 * Confirms a resumed navigation. `currentStepIndex` is the snapshot's step
 * clamped to the rebuilt step list, which can differ from the client's
 * `lastKnownStepIndex`; the client must adopt this value.
 */
export const NavResumeOkMessageSchema = z
  .object({
    type: z.literal("nav.resume_ok"),
    navigationId: z.string(),
    routeVersion: z.number().int().positive(),
    routeToken: z.string().min(1),
    currentStepIndex: z.number().int().nonnegative(),
    totalSteps: z.number().int().positive(),
    onVehicle: z.boolean(),
    steps: z.array(NavStepDtoSchema),
  })
  .strict();

export const NavResumeFailedMessageSchema = z
  .object({
    type: z.literal("nav.resume_failed"),
    navigationId: z.string(),
    code: z.enum([
      "INVALID_REQUEST",
      "SNAPSHOT_NOT_FOUND",
      "USER_MISMATCH",
      "ROUTE_VERSION_MISMATCH",
      "ROUTE_EXPIRED",
    ]),
    message: z.string(),
    retryable: z.boolean(),
  })
  .strict();

export const VoiceResumeOutboundMessageSchema = z.discriminatedUnion("type", [
  NavResumeOkMessageSchema,
  NavResumeFailedMessageSchema,
]);

export type VoiceResumeOutboundMessage = z.infer<
  typeof VoiceResumeOutboundMessageSchema
>;
export type NavResumeFailedMessage = z.infer<
  typeof NavResumeFailedMessageSchema
>;
export type NavResumeOkEvent = z.infer<typeof NavResumeOkMessageSchema>;

export type VoiceOutboundMessage =
  | { type: "session.ready" }
  | { type: "error"; code: "LIVE_CONNECT_FAILED" }
  | { type: "nav.error"; code: "NAV_ROUTE_INVALID"; message: string }
  | NavProgressEvent
  | VoiceRerouteOutboundMessage
  | VoiceResumeOutboundMessage
  | NavAdvisoryMessage;

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
