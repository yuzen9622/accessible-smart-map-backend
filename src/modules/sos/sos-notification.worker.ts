import { SOS_NOTICE } from "../../constants/sos";
import { drainInitialNotices } from "./sos-notification.service";

/** Starts after Mongo connects; pending attempts survive worker/process loss. */
export function startSosNotificationWorker(): NodeJS.Timeout {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await drainInitialNotices();
    } catch (error) {
      console.error("[sos] notification worker failed", error);
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), SOS_NOTICE.pollMs);
  timer.unref();
  return timer;
}
