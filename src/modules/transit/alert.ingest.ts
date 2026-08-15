import {
  startTdxMqttClient,
  type TdxMqttHandle,
} from "../../adapters/tdx-mqtt.adapter";
import { mqttConfig, mqttAlertTopics } from "../../config/mqtt";
import { upsertAlertSnapshot } from "./alert.store";

/** 把 TDX MQTT topic 轉成 alert.service 使用的快照 key，無法對映時回 null。 */
export function topicToStoreKey(topic: string): string | null {
  const segments = topic.split("/").filter(Boolean);
  const [, ...rest] = segments;

  if (rest[0] === "Bus" && rest[1] === "Alert") {
    if (rest[2] === "City" && rest[3]) return `bus:city:${rest[3]}`;
    if (rest[2] === "InterCity") return "bus:intercity";
    return null;
  }

  if (rest[0] === "Rail") {
    if (rest[1] === "Metro" && rest[2] === "Alert" && rest[3])
      return `metro:${rest[3]}`;
    if (rest[1] === "TRA" && rest[2] === "Alert") return "tra";
    if (rest[1] === "THSR" && rest[2] === "AlertInfo") return "thsr";
  }

  return null;
}

/** Bus topic 推 bare array，Rail topic 推 {Alerts:[...]} envelope（THSR 可能是 bare array）。 */
export function normalizeMqttPayload(topic: string, json: unknown): unknown[] {
  const isBus = topic.split("/").filter(Boolean)[1] === "Bus";
  if (isBus) return Array.isArray(json) ? json : [];

  if (json && typeof json === "object" && !Array.isArray(json)) {
    const alerts = (json as { Alerts?: unknown }).Alerts;
    return Array.isArray(alerts) ? alerts : [];
  }
  return Array.isArray(json) ? json : [];
}

export function startAlertIngestion(): Promise<TdxMqttHandle> {
  return startTdxMqttClient(
    mqttConfig,
    [...mqttAlertTopics],
    (topic, payload) => {
      const key = topicToStoreKey(topic);
      if (!key) return;
      try {
        const alerts = normalizeMqttPayload(
          topic,
          JSON.parse(payload.toString()),
        );
        upsertAlertSnapshot(key, alerts, "mqtt");
      } catch (err) {
        console.error("[tdx-mqtt] parse failed", topic, err);
      }
    },
  );
}
