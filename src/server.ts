import http from "http";
import app from "./app";
import mongoose from "mongoose";
import { startHazardExpiryJob } from "./modules/hazard-report/hazard-report.expire";
import { attachVoiceWebSocket } from "./modules/voice";
import { attachAlertWebSocket } from "./modules/transit/alert.gateway";
import { startPasswordAssistanceWorker } from "./modules/user/user.password-assistance.worker";
import { startAlertIngestion } from "./modules/transit/alert.ingest";
import { mqttConfig } from "./config/mqtt";
import type { TdxMqttHandle } from "./adapters/tdx-mqtt.adapter";
import { closePedGraphRuntime } from "./modules/accessible-route/planners/pedestrian-a11y/graph-runtime";
import {
  warmTrafficGeometryRuntime,
  startTrafficGeometryRefreshJob,
} from "./modules/traffic/traffic-geometry.runtime";
import { startTrafficLiveRefreshJob } from "./modules/traffic/traffic-live.worker";
const PORT = process.env.PORT || 3000;
let passwordAssistanceTimer: NodeJS.Timeout | undefined;
let trafficGeometryTimer: NodeJS.Timeout | undefined;
let mqttHandle: TdxMqttHandle | undefined;
let shutdownStarted = false;

const server = http.createServer(app);
attachVoiceWebSocket(server);
attachAlertWebSocket(server);
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || "development"}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});

if (mqttConfig.enabled) {
  startAlertIngestion()
    .then((handle) => {
      mqttHandle = handle;
      console.log("TDX MQTT connected");
    })
    .catch((err) => {
      console.error("TDX MQTT failed", err);
    });
}
const uri = process.env.DATABASE_URL ?? "";

// Live traffic refresher is SWR + Redis only (no Mongo dependency); start unconditionally.
const trafficLiveTimer = startTrafficLiveRefreshJob();

mongoose
  .connect(uri)
  .then(() => {
    console.log("Connected to MongoDB");
    startHazardExpiryJob();
    passwordAssistanceTimer = startPasswordAssistanceWorker();
    void warmTrafficGeometryRuntime().then(() => {
      trafficGeometryTimer = startTrafficGeometryRefreshJob();
    });
  })
  .catch((err) => {
    console.error("Error connecting to MongoDB:", err);
  });

function shutdown(signalLog: string): void {
  console.log(signalLog);
  if (shutdownStarted) return;
  shutdownStarted = true;
  if (passwordAssistanceTimer) clearInterval(passwordAssistanceTimer);
  if (trafficGeometryTimer) clearInterval(trafficGeometryTimer);
  if (trafficLiveTimer) clearInterval(trafficLiveTimer);
  void (async () => {
    await Promise.allSettled([
      mqttHandle ? mqttHandle.stop() : Promise.resolve(),
      closePedGraphRuntime(),
    ]);
    server.close(() => {
      console.log("Process terminated");
    });
  })();
}

process.on("SIGTERM", () => shutdown("SIGTERM received"));

process.on("SIGINT", () => shutdown("\nSIGINT received"));

export default server;
