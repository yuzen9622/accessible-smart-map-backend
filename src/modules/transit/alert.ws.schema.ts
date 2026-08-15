import { z } from "zod";
import type { TransitContext } from "./alert.service";

/**
 * Machine-checkable contract for the transit-alert WebSocket.
 *
 * These schemas describe what `alert.gateway.ts` accepts today, not what a
 * tightened contract would look like. Inbound messages are `safeParse`d at the
 * gateway's message entry; outbound messages are typed only.
 */

/**
 * The subscription context.
 *
 * Deliberately only asserts "a non-null object". The gateway has always
 * accepted any object here and cast it to `TransitContext` without field
 * checks, so enforcing the real discriminated union below would reject traffic
 * that is accepted today — a wire-behaviour change. {@link TransitContextShape}
 * records the intended shape so a later pass can tighten this deliberately.
 *
 * `z.custom` rather than `z.looseObject({})` because the latter rejects arrays,
 * while the predicate this replaced (`ctx && typeof ctx === "object"`) accepted
 * them. That difference is not worth a silent change in what the socket takes.
 */
export const SubscribeContextSchema = z.custom<Record<string, unknown>>(
  (value) => typeof value === "object" && value !== null,
  { message: "ctx must be an object" },
);

/**
 * The shape `TransitContext` actually shows up as, kept alongside the loose
 * inbound schema as documentation of where this contract is headed. Not
 * currently enforced — see {@link SubscribeContextSchema}.
 */
export const TransitContextShape = z.discriminatedUnion("mode", [
  z.looseObject({
    mode: z.literal("bus"),
    city: z.string(),
    routeName: z.string(),
    direction: z.number().optional(),
    stopUid: z.string().optional(),
    stopName: z.string().optional(),
  }),
  z.looseObject({
    mode: z.literal("metro"),
    railSystem: z.string(),
    lineCode: z.string().optional(),
    stationIds: z.array(z.string()).optional(),
  }),
  z.looseObject({
    mode: z.literal("tra"),
    trainNo: z.string().optional(),
    lineId: z.string().optional(),
    stationIds: z.array(z.string()).optional(),
    direction: z.number().optional(),
  }),
  z.looseObject({
    mode: z.literal("thsr"),
    lineId: z.string().optional(),
    trainNo: z.string().optional(),
    stationIds: z.array(z.string()).optional(),
  }),
]);

/** Starts (or replaces) this socket's alert subscription. */
export const SubscribeMessageSchema = z.object({
  type: z.literal("subscribe"),
  ctx: SubscribeContextSchema,
});

/** Drops this socket's subscription, leaving the socket open. */
export const UnsubscribeMessageSchema = z.object({
  type: z.literal("unsubscribe"),
});

/** Every frame the alert gateway accepts. */
export const AlertClientMessageSchema = z.discriminatedUnion("type", [
  SubscribeMessageSchema,
  UnsubscribeMessageSchema,
]);

export type AlertClientMessage =
  { type: "subscribe"; ctx: TransitContext } | { type: "unsubscribe" };

/** The single server-to-client frame this gateway emits. */
export interface AlertOutboundMessage {
  type: "alerts";
  result: unknown;
}

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
