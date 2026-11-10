import { RoadGuidanceSchema } from "../../schemas/road-guidance.schema";
import { z } from "zod";
import { AgentLanguageSchema } from "../../schemas/agent-language.schema";
import { NavManeuverSchema } from "../../schemas/nav-instructions-data.schema";
import {
  NavPositionSchema,
  NavSetRouteSchema,
  ROUTE_TOKEN_MAX_LENGTH,
} from "./navigation.schema";
import type { AccessibleRoute } from "../../types/route";
import {
  RouteConversationFields,
  RouteContextInputSchema,
} from "../../schemas/agent-route.schema";
import type {
  RouteContextResult,
  RouteContextUpdate,
} from "../../types/agent-route";

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
export const UserLocationSchema = z.preprocess(
  (val: unknown) => {
    if (typeof val === "object" && val !== null) {
      const obj = val as Record<string, unknown>;
      const lat = obj.latitude ?? obj.lat;
      const lng = obj.longitude ?? obj.lng ?? obj.lon;
      if (lat !== undefined && lng !== undefined) {
        return {
          latitude: typeof lat === "string" ? parseFloat(lat) : lat,
          longitude: typeof lng === "string" ? parseFloat(lng) : lng,
        };
      }
    }
    return val;
  },
  z.object({
    latitude: z.number().finite().min(-90).max(90),
    longitude: z.number().finite().min(-180).max(180),
  }),
);

export type UserLocation = z.infer<typeof UserLocationSchema>;

/** The only frame accepted before authentication succeeds. */
export const SessionStartMessageSchema = z.object({
  type: z.literal("session.start"),
  token: z.string(),
  language: AgentLanguageSchema.optional(),
  // Validated separately by UserLocationSchema: a bad location must not fail
  // the handshake, it just leaves the session without a starting position.
  userLocation: z.unknown().optional(),
  // Earlier turns of the shared text/voice conversation. Validated separately
  // by PriorHistorySchema for the same reason: bad history must not fail the
  // handshake, the session just starts without it.
  history: z.unknown().optional(),
  /**
   * 1 = the client runs navigation itself: the server sends `ui.command`
   * instead of driving steps, and reads `nav.state` / speaks `nav.cue`.
   */
  clientNavigation: z.literal(1).optional(),
  ...RouteConversationFields,
});

/** Selection changes are independent of navigation arming and progress. */
export const RouteContextSetMessageSchema = z
  .object({
    type: z.literal("route.context.set"),
    requestId: z.string().trim().min(1).max(128),
    selectionVersion: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER),
    routeContext: RouteContextInputSchema,
  })
  .strict();

export type RouteContextAckMessage = {
  type: "route.context.ack";
} & Pick<RouteContextUpdate, "requestId" | "selectionVersion"> &
  RouteContextResult;

/** The client executed (or refused) a `ui.command`. */
export const UiCommandAckMessageSchema = z
  .object({
    type: z.literal("ui.command.ack"),
    id: z.string().min(1).max(64),
    ok: z.boolean(),
    reason: z.string().max(64).optional(),
    guidance: z.enum(["preview", "live", "indoor"]).optional(),
  })
  .strict();

export type UiCommandAck = z.infer<typeof UiCommandAckMessageSchema>;

const ClientNavStepSchema = z
  .object({
    index: z.number().int().nonnegative(),
    instruction: z.string().max(500),
    legType: z.string().max(32).optional(),
    distanceM: z.number().finite().nonnegative().nullable().optional(),
    streetName: z.string().max(200).nullable().optional(),
    maneuver: z.string().max(64).nullable().optional(),
  })
  .strict();

/** What the App's waiting-for-bus card shows right now: live minutes, or the
 * selected trip's expected time (HH:mm) when there is no live data. */
const ClientBusWaitSchema = z
  .object({
    routeName: z.string().trim().min(1).max(64),
    stop: z.string().trim().min(1).max(200),
    waitMinutes: z.number().int().nonnegative().max(1440).nullable(),
    expectedAt: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .optional(),
  })
  .strict();

/** The speed limit the App's HUD shows for the road segment it places the
 * vehicle on (`DriveLeg.speedLimits` at the current leg-local progress). */
const ClientSpeedLimitSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("known"),
      limitKph: z.number().int().positive().max(200),
    })
    .strict(),
  z
    .object({
      kind: z.enum(["unlimited", "unknown"]),
      limitKph: z.null(),
    })
    .strict(),
]);

/** The App's navigation engine state; the source of truth for route questions. */
export const NavStateMessageSchema = z
  .object({
    type: z.literal("nav.state"),
    active: z.boolean(),
    guidance: z.enum(["preview", "live", "indoor"]).optional(),
    travelMode: z.string().max(32).optional(),
    destination: z.string().max(200).nullable().optional(),
    currentStepIndex: z.number().int().nonnegative().optional(),
    distanceToNextM: z.number().finite().nonnegative().nullable().optional(),
    remainingDistanceM: z.number().finite().nonnegative().nullable().optional(),
    remainingDurationSec: z
      .number()
      .finite()
      .nonnegative()
      .nullable()
      .optional(),
    arrived: z.boolean().optional(),
    steps: z.array(ClientNavStepSchema).max(400).optional(),
    /** Present while the rider is heading to or waiting at a bus stop. */
    busWait: ClientBusWaitSchema.optional(),
    /** Present while a DRIVE/MOTORCYCLE leg is being guided. */
    speedLimit: ClientSpeedLimitSchema.optional(),
  })
  .strict();

export type ClientNavState = Omit<
  z.infer<typeof NavStateMessageSchema>,
  "type"
>;

/** A guidance line whose timing the App's navigation engine decided. */
export const NavCueMessageSchema = z
  .object({
    type: z.literal("nav.cue"),
    text: z.string().trim().min(1).max(500),
  })
  .strict();

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
 * Starts navigation on the already-armed route. Named to mirror the outbound
 * `nav.start` event it results in, the same way `nav.resume` mirrors
 * `nav.resume_ok`.
 */
export const NavStartMessageSchema = z.object({
  type: z.literal("nav.start"),
});

/**
 * Asks the assistant to read one step while previewing a route the user is
 * far from. Ignored once GPS is driving the steps.
 */
export const NavPreviewStepMessageSchema = z.object({
  type: z.literal("nav.previewStep"),
  index: z.number().int().nonnegative().max(10_000),
});

/**
 * The user completed the indoor step `fromStepIndex` (e.g. tapped 下一步).
 * Ignored unless that is still the current indoor step, so a late or
 * repeated tap never skips a step.
 */
export const NavAdvanceMessageSchema = z.object({
  type: z.literal("nav.advance"),
  fromStepIndex: z.number().int().nonnegative().max(10_000),
  navigationId: z.string().trim().min(1).max(128).optional(),
  routeVersion: z.number().int().positive().optional(),
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
  NavStartMessageSchema,
  NavPreviewStepMessageSchema,
  NavAdvanceMessageSchema,
  NavCancelMessageSchema,
  NavResumeMessageSchema,
  RouteContextSetMessageSchema,
]);

export type VoiceControlMessage = z.infer<typeof VoiceControlMessageSchema>;
export type NavResumeMessage = z.infer<typeof NavResumeMessageSchema>;
export type SessionStartMessage = z.infer<typeof SessionStartMessageSchema>;

/** Server-to-client frames emitted by the gateway itself. */
const NavStepDtoSchema = z
  .object({
    polylineIndex: z.number().int().nonnegative().nullable().optional(),
    roadGuidance: RoadGuidanceSchema.optional(),
    index: z.number().int().nonnegative(),
    instruction: z.string(),
    legIndex: z.number().int().nonnegative(),
    legType: z.enum([
      "WALK",
      "DRIVE",
      "MOTORCYCLE",
      "BUS",
      "METRO",
      "THSR",
      "TRA",
      "VENUE",
    ]),
    distanceM: z.number().nonnegative().nullable(),
    isTransit: z.boolean(),
    type: z.string().optional(),
    relativeDirection: z.string().nullable().optional(),
    maneuver: NavManeuverSchema.optional(),
    streetName: z.string().nullable().optional(),
    bearing: z.number().nullable().optional(),
    driver: z.literal("manual").optional(),
    venueStepType: z
      .enum([
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
      ])
      .optional(),
    buildingId: z.string().nullable().optional(),
    levelRef: z.string().nullable().optional(),
    fromLevelRef: z.string().optional(),
    toLevelRef: z.string().optional(),
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

/** Assistant accepted an explicit request to end voice, not navigation. */
export const SessionEndingMessageSchema = z
  .object({
    type: z.literal("session.ending"),
    reason: z.literal("assistant-end"),
  })
  .strict();

type SessionEndingMessage = z.infer<typeof SessionEndingMessageSchema>;

export type VoiceOutboundMessage =
  | {
      type: "session.ready";
      capabilities: {
        aiRouteContractVersion: 1;
        routeContextSync: true;
        clientNavigation: 1;
      };
    }
  | RouteContextAckMessage
  | {
      type: "ui.command";
      id: string;
      action: "start" | "stop" | "advance" | "repeat";
      routeToken?: string;
    }
  | { type: "error"; code: "LIVE_CONNECT_FAILED" }
  | SessionEndingMessage
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
