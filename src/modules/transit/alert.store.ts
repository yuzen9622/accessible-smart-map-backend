export type AlertSnapshotSource = "mqtt" | "rest";

export type AlertSnapshot = {
  alerts: unknown[];
  updatedAt: string;
  source: AlertSnapshotSource;
};

/** MQTT 只在異動時推播，快照由後續推播刷新，所以只有 REST 兜底來的快照會過期。 */
const REST_SNAPSHOT_TTL_MS = 60_000;

const store = new Map<string, AlertSnapshot>();
const listeners = new Set<(key: string) => void>();

export function upsertAlertSnapshot(
  key: string,
  alerts: unknown[],
  source: AlertSnapshotSource,
): void {
  store.set(key, { alerts, updatedAt: new Date().toISOString(), source });
  for (const listener of listeners) listener(key);
}

export function getFreshAlertSnapshot(key: string): AlertSnapshot | null {
  const snapshot = store.get(key);
  if (!snapshot) return null;
  if (snapshot.source === "mqtt") return snapshot;

  const age = Date.now() - new Date(snapshot.updatedAt).getTime();
  if (age >= REST_SNAPSHOT_TTL_MS) {
    store.delete(key);
    return null;
  }
  return snapshot;
}

export function onAlertSnapshotUpdate(
  listener: (key: string) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function clearAlertStore(): void {
  store.clear();
}
