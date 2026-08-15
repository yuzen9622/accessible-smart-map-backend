export const mqttConfig = {
  enabled: process.env.TDX_MQTT_ENABLED === "true",
  host: process.env.TDX_MQTT_HOST || "mqtt.transportdata.tw",
  port: Number(process.env.TDX_MQTT_PORT || 8883),
  clientId: process.env.TDX_MQTT_CLIENT_ID || "",
  username: process.env.TDX_MQTT_CLIENT_USERNAME || "",
  password: process.env.TDX_MQTT_CLIENT_PASSWORD || "",
};

export const mqttAlertTopics = [
  "v2/Bus/Alert/City/#",
  "v2/Bus/Alert/InterCity",
  "v2/Rail/Metro/Alert/#",
  "v3/Rail/TRA/Alert",
  "v2/Rail/THSR/AlertInfo",
] as const;
