import { EventEmitter } from "events";
import type { ISosSession } from "../../types";

/**
 * Per-session in-process fan-out for SOS lifecycle updates to SSE subscribers.
 *
 * Single-instance only: subscribers living on a different server process will
 * NOT receive these events (mirrors the per-process assumption of the voice
 * gateway). A multi-instance deployment would need Redis pub/sub here, which is
 * not yet used anywhere in this codebase.
 */
const emitter = new EventEmitter();
emitter.setMaxListeners(0);

export interface SosSnapshot {
  sessionId: string;
  status: "active" | "resolved";
  handlingStatus: string;
  claimedBy?: string | null;
  claimedByName?: string | null;
  claimedAt?: Date | null;
  acknowledgements: { lineUserId: string; name?: string | null; at: Date }[];
  timeline: {
    type: string;
    actorType: string;
    actorName?: string | null;
    note?: string | null;
    at: Date;
  }[];
  location: {
    lat: number;
    lng: number;
    address?: string | null;
    updatedAt: Date;
  };
  resolvedAt?: Date | null;
  updatedAt: Date;
}

function channel(sessionId: string): string {
  return `sos:${sessionId}`;
}

/**
 * Projects a session document into the public snapshot shape shared by the SSE
 * stream, its initial payload, and the owner GET endpoint.
 *
 * @param session A SosSession document or lean object.
 * @returns The normalized snapshot.
 */
export function buildSosSnapshot(session: ISosSession): SosSnapshot {
  return {
    sessionId: String(session._id),
    status: session.status,
    handlingStatus: session.handlingStatus,
    claimedBy: session.claimedBy ?? null,
    claimedByName: session.claimedByName ?? null,
    claimedAt: session.claimedAt ?? null,
    acknowledgements: (session.acknowledgements ?? []).map((a) => ({
      lineUserId: a.lineUserId,
      name: a.name ?? null,
      at: a.at,
    })),
    timeline: (session.timeline ?? []).map((t) => ({
      type: t.type,
      actorType: t.actorType,
      actorName: t.actorName ?? null,
      note: t.note ?? null,
      at: t.at,
    })),
    location: {
      lat: session.lat,
      lng: session.lng,
      address: session.address ?? null,
      updatedAt: session.locationUpdatedAt,
    },
    resolvedAt: session.resolvedAt ?? null,
    updatedAt: session.updatedAt,
  };
}

/**
 * Publishes a lifecycle snapshot to every subscriber of one session.
 *
 * @param sessionId The session id.
 * @param snapshot The snapshot to deliver.
 */
export function emitSosUpdate(sessionId: string, snapshot: SosSnapshot): void {
  emitter.emit(channel(sessionId), snapshot);
}

/**
 * Subscribes to lifecycle updates for one session.
 *
 * @param sessionId The session id.
 * @param cb Callback invoked with each snapshot.
 * @returns An unsubscribe function.
 */
export function onSosUpdate(
  sessionId: string,
  cb: (snapshot: SosSnapshot) => void,
): () => void {
  const ch = channel(sessionId);
  emitter.on(ch, cb);
  return () => {
    emitter.off(ch, cb);
  };
}
