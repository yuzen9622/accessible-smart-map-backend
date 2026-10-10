import { startSosNotificationWorker } from "./modules/sos/sos-notification.worker";
import http from "http";
import app from "./app";
import mongoose from "mongoose";
import { startHazardExpiryJob } from "./modules/hazard-report/hazard-report.expire";
import {
  startHazardAiWorker,
  type HazardAiWorkerHandle,
} from "./modules/hazard-report/hazard-report.ai-worker";
import { startHazardAiMonitor } from "./modules/hazard-report/hazard-report.monitor.service";
import { startHazardReviewNotificationWorker } from "./modules/hazard-report/hazard-report.notification.service";
import { startBusFleetSyncJob } from "./modules/transit/bus-fleet-sync.worker";
import { attachVoiceWebSocket } from "./modules/voice";
import { attachAlertWebSocket } from "./modules/transit/alert.gateway";
import { startPasswordAssistanceWorker } from "./modules/user/user.password-assistance.worker";
import { startAlertIngestion } from "./modules/transit/alert.ingest";
import type { TdxMqttHandle } from "./adapters/tdx-mqtt.adapter";
import {
  closePedGraphRuntime,
  getPedGraphRuntime,
} from "./modules/accessible-route/planners/pedestrian-a11y/graph-runtime";
import { startTransitFreshnessJob } from "./modules/accessible-route/planners/otp-freshness";
import {
  warmTrafficGeometryRuntime,
  startTrafficGeometryRefreshJob,
} from "./modules/traffic/traffic-geometry.runtime";
import { startTrafficLiveRefreshJob } from "./modules/traffic/traffic-live.worker";
import { startValhallaTrafficTarWorker } from "./modules/traffic/valhalla-traffic.worker";
import { getRetentionConfig } from "./config/retention";
import { startRetentionJob } from "./modules/retention/retention.job";
const PORT = process.env.PORT || 3000;

// Validated before listening: a bad retention value must stop the deploy, not
// leave the server up with the privacy retention job silently off.
const retentionConfig = getRetentionConfig();
let sosNotificationTimer: NodeJS.Timeout | undefined;
let passwordAssistanceTimer: NodeJS.Timeout | undefined;
let trafficGeometryTimer: NodeJS.Timeout | undefined;
let busFleetSyncTimer: NodeJS.Timeout | undefined;
let mqttHandle: TdxMqttHandle | undefined;
let shutdownStarted = false;
let stopRetentionJob: (() => void) | undefined;
let hazardAiWorker: HazardAiWorkerHandle | undefined;
let stopHazardAiMonitor: (() => void) | undefined;
let hazardReviewNotificationWorker:
  ReturnType<typeof startHazardReviewNotificationWorker> | undefined;

const server = http.createServer(app);
attachVoiceWebSocket(server);
attachAlertWebSocket(server);
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || "development"}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});

startAlertIngestion()
  .then((handle) => {
    mqttHandle = handle;
    console.log("TDX MQTT connected");
  })
  .catch((err) => {
    console.error("TDX MQTT failed", err);
  });
const uri = process.env.DATABASE_URL ?? "";

const pedGraphWarmStart = Date.now();
void getPedGraphRuntime().then((runtime) => {
  console.log(
    "[ped-graph] warm-up",
    JSON.stringify({
      status: runtime.status,
      ms: Date.now() - pedGraphWarmStart,
      ...(runtime.status === "ready" ? {} : { reason: runtime.reason }),
    }),
  );
});

const stopTransitFreshnessJob = startTransitFreshnessJob();

// Live traffic refresher is SWR + Redis only (no Mongo dependency); start unconditionally.
const trafficLiveTimer = startTrafficLiveRefreshJob();
const valhallaTrafficTarTimer = startValhallaTrafficTarWorker();

mongoose
  .connect(uri)
  .then(() => {
    console.log("Connected to MongoDB");
    startHazardExpiryJob();
    hazardReviewNotificationWorker = startHazardReviewNotificationWorker();
    // HAZARD_AI_WORKER_ENABLED=false only stops AI claims; intake cleanup and
    // deadline convergence of queued reviews keep running.
    hazardAiWorker = startHazardAiWorker(undefined, {
      enabled: process.env.HAZARD_AI_WORKER_ENABLED !== "false",
    });
    stopHazardAiMonitor = startHazardAiMonitor(hazardAiWorker);
    console.log(
      "[hazard-ai] worker started",
      JSON.stringify({ paused: hazardAiWorker.getHealth().paused }),
    );
    stopRetentionJob = startRetentionJob(retentionConfig);
    sosNotificationTimer = startSosNotificationWorker();
    passwordAssistanceTimer = startPasswordAssistanceWorker();
    busFleetSyncTimer = startBusFleetSyncJob();
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
  if (sosNotificationTimer) clearInterval(sosNotificationTimer);
  if (passwordAssistanceTimer) clearInterval(passwordAssistanceTimer);
  if (trafficGeometryTimer) clearInterval(trafficGeometryTimer);
  if (busFleetSyncTimer) clearInterval(busFleetSyncTimer);
  if (trafficLiveTimer) clearInterval(trafficLiveTimer);
  if (valhallaTrafficTarTimer) clearInterval(valhallaTrafficTarTimer);
  stopTransitFreshnessJob();
  stopRetentionJob?.();
  stopHazardAiMonitor?.();
  void (async () => {
    await Promise.allSettled([
      hazardReviewNotificationWorker?.stop() ?? Promise.resolve(),
      hazardAiWorker
        ? hazardAiWorker
            .stop()
            .then(() =>
              console.log(
                "[hazard-ai] worker stopped",
                JSON.stringify(hazardAiWorker?.getHealth().counters),
              ),
            )
        : Promise.resolve(),
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
