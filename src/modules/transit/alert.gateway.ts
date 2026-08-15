import type http from "http";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { registerWsRoute } from "../../config/ws-upgrade";
import { getTransitAlerts, type TransitContext } from "./alert.service";
import { onAlertSnapshotUpdate } from "./alert.store";
import {
  AlertClientMessageSchema,
  describeIssues,
  type AlertClientMessage,
} from "./alert.ws.schema";

export const ALERT_WS_PATH = "/api/v1/transit/alerts/ws";

const ALERT_MAX_PAYLOAD_BYTES = 64 * 1024;

type ClientMessage = AlertClientMessage;

export function keyRelevantToContext(
  key: string,
  ctx: TransitContext,
): boolean {
  switch (ctx.mode) {
    case "bus":
      return (
        key === `bus:city:${ctx.city}` ||
        (ctx.city === "InterCity" && key === "bus:intercity")
      );
    case "metro":
      return key === `metro:${ctx.railSystem}`;
    case "tra":
      return key === "tra";
    case "thsr":
      return key === "thsr";
    default:
      return false;
  }
}

/**
 * Validates one client frame against the WebSocket contract.
 *
 * A rejected frame is reported on the server log and then ignored, which is
 * what this gateway has always done: it never sends an error frame and never
 * closes the socket over a bad message.
 *
 * @param raw The received frame
 * @returns The parsed message, or null when it does not satisfy the contract
 */
function parseClientMessage(raw: RawData): ClientMessage | null {
  let payload: unknown;
  try {
    payload = JSON.parse(raw.toString());
  } catch {
    console.warn("[transit-alerts] ignoring unparseable message");
    return null;
  }
  const result = AlertClientMessageSchema.safeParse(payload);
  if (!result.success) {
    console.warn(
      `[transit-alerts] ignoring invalid message: ${describeIssues(result.error)}`,
    );
    return null;
  }
  if (result.data.type === "unsubscribe") return { type: "unsubscribe" };
  return {
    type: "subscribe",
    ctx: result.data.ctx as unknown as TransitContext,
  };
}

export function attachAlertWebSocket(server: http.Server): void {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: ALERT_MAX_PAYLOAD_BYTES,
  });
  const subscriptions = new Map<WebSocket, TransitContext>();

  const pushAlerts = (ws: WebSocket, ctx: TransitContext): void => {
    getTransitAlerts(ctx)
      .then((result) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({ type: "alerts", result }));
      })
      .catch(() => {});
  };

  registerWsRoute(server, { path: ALERT_WS_PATH, wss });

  wss.on("connection", (ws: WebSocket) => {
    ws.on("message", (raw: RawData) => {
      const message = parseClientMessage(raw);
      if (!message) return;
      if (message.type === "unsubscribe") {
        subscriptions.delete(ws);
        return;
      }
      subscriptions.set(ws, message.ctx);
      pushAlerts(ws, message.ctx);
    });
    ws.on("close", () => {
      subscriptions.delete(ws);
    });
    ws.on("error", () => {
      subscriptions.delete(ws);
    });
  });

  onAlertSnapshotUpdate((key) => {
    for (const [ws, ctx] of subscriptions) {
      if (keyRelevantToContext(key, ctx)) pushAlerts(ws, ctx);
    }
  });
}
