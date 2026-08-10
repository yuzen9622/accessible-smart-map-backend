import http from "http";
import app from "./app";
import mongoose from "mongoose";
import { startHazardExpiryJob } from "./modules/hazard-report/hazard-report.expire";
import { attachVoiceWebSocket } from "./modules/voice";
import { startPasswordAssistanceWorker } from "./modules/user/user.password-assistance.worker";
const PORT = process.env.PORT || 3000;
let passwordAssistanceTimer: NodeJS.Timeout | undefined;

const server = http.createServer(app);
attachVoiceWebSocket(server);
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || "development"}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});
const uri = process.env.DATABASE_URL ?? "";

mongoose
  .connect(uri)
  .then(() => {
    console.log("Connected to MongoDB");
    startHazardExpiryJob();
    passwordAssistanceTimer = startPasswordAssistanceWorker();
  })
  .catch((err) => {
    console.error("Error connecting to MongoDB:", err);
  });

process.on("SIGTERM", () => {
  console.log("SIGTERM received");
  if (passwordAssistanceTimer) clearInterval(passwordAssistanceTimer);
  server.close(() => {
    console.log("Process terminated");
  });
});

process.on("SIGINT", () => {
  console.log("\nSIGINT received");
  if (passwordAssistanceTimer) clearInterval(passwordAssistanceTimer);
  server.close(() => {
    console.log("Process terminated");
  });
});

export default server;
