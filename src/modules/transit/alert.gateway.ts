import type http from "http";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { registerWsRoute } from "../../config/ws-upgrade";
import { getTransitAlerts, type TransitContext } from "./alert.service";
import { onAlertSnapshotUpdate } from "./alert.store";

export const ALERT_WS_PATH = "/api/v1/transit/alerts/ws";

const ALERT_MAX_PAYLOAD_BYTES = 64 * 1024;

type ClientMessage =
  | { type: "subscribe"; ctx: TransitContext }
  | { type: "unsubscribe" };

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

function parseClientMessage(raw: RawData): ClientMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString());
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const message = parsed as Record<string, unknown>;
  if (message.type === "unsubscribe") return { type: "unsubscribe" };
  if (
    message.type === "subscribe" &&
    message.ctx &&
    typeof message.ctx === "object"
  ) {
    return { type: "subscribe", ctx: message.ctx as TransitContext };
  }
  return null;
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
