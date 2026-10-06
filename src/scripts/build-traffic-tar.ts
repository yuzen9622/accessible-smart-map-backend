import "dotenv/config";
import { generateValhallaTrafficTar } from "../modules/traffic/valhalla-traffic.worker";

async function main(): Promise<void> {
  const result = await generateValhallaTrafficTar({ force: true });
  console.log("[build:traffic-tar] Result:", result);
}

// Exit explicitly: config/redis connects at import time when REDIS_URL is set,
// and that open socket would otherwise keep the process alive forever.
main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[build:traffic-tar] Failed:", err);
    process.exit(1);
  });
