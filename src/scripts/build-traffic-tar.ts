import "dotenv/config";
import { generateValhallaTrafficTar } from "../modules/traffic/valhalla-traffic.worker";

async function main(): Promise<void> {
  const result = await generateValhallaTrafficTar({ force: true });
  console.log("[build:traffic-tar] Result:", result);
}

main().catch((err) => {
  console.error("[build:traffic-tar] Failed:", err);
  process.exit(1);
});
