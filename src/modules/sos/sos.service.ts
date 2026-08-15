import crypto from "crypto";
import { Types } from "mongoose";
import {
  applyHandlingUpdate,
  claimUnclaimedSession,
  findActiveSessionByUser,
  findBoundContact,
  findBoundContactsByLineUser,
  findBoundLineUserIds,
  findSessionById,
  findSessionByShareToken,
  findUserName,
  insertSession,
  promoteToAcknowledged,
  pushAcknowledgement,
  resolveActiveSession,
  updateActiveSessionLocation,
} from "./sos.repository";
import {
  sendSosNotification,
  sendSosResolved,
} from "../../adapters/line.adapter";
import { ResponseCode } from "../../types/code";
import { SOS_MSG, SOS_REASON } from "../../constants/messages";
import { buildSosSnapshot, emitSosUpdate } from "./sos-events";
import type { ISosSession } from "../../types";
import type {
  AcknowledgeSosInput,
  ClaimSosInput,
  CreateSosInput,
  GetSosForOwnerInput,
  ResolveSosInput,
  ServiceResult,
  UpdateLocationInput,
  UpdateSosStatusInput,
} from "./sos.types";

const TRACKING_EXPIRY_MS = 24 * 60 * 60 * 1000;

/**
 * Best-effort LINE push to the OTHER bound contacts of a session (excludes the
 * acting contact). Resolved via a dynamic import so this module carries no hard
 * dependency on the (LINE-agent-owned) `pushSosUpdate` export — it becomes a
 * no-op until that adapter method exists.
 *
 * @param lineUserIds Recipient LINE user ids (already excluding the actor).
 * @param message Short update text to deliver.
 */
async function notifyOthers(
  lineUserIds: string[],
  message: string,
): Promise<void> {
  if (!lineUserIds.length) return;
  try {
    const adapter =
      (await import("../../adapters/line.adapter")) as unknown as {
        pushSosUpdate?: (ids: string[], msg: string) => Promise<unknown>;
      };
    if (typeof adapter.pushSosUpdate === "function") {
      await adapter.pushSosUpdate(lineUserIds, message);
    }
  } catch (err) {
    console.error("[sos.service] notifyOthers failed", err);
  }
}

/**
 * Authorizes a LINE user for a session: they must be a bound emergency contact
 * of the session owner. Shared single source of truth for every SOS family tool.
 *
 * @param lineUserId The acting LINE user id.
 * @param sessionId The target session id.
 * @returns `{ session, ownerName }` when authorized, otherwise `null`.
 */
export async function getAuthorizedSessionForLineUser(
  lineUserId: string,
  sessionId: string,
): Promise<{
  session: {
    _id: string;
    userId: string;
    type: "body" | "trapped" | "share_location";
    status: "active" | "resolved";
    lat: number;
    lng: number;
    address?: string | null;
    shareToken: string;
    locationUpdatedAt: Date;
    resolvedAt?: Date | null;
    createdAt: Date;
    updatedAt: Date;
  } | null;
  ownerName: string;
} | null> {
  const contacts = await findBoundContactsByLineUser(lineUserId);
  if (!contacts.length) return null;
  const ownerIds = new Set(contacts.map((contact) => contact.userId));
  const session = await findSessionById(sessionId);
  if (!session || !ownerIds.has(String(session.userId))) return null;
  const ownerName = await findUserName(String(session.userId));
  return {
    session,
    ownerName: ownerName ?? "未知使用者",
  };
}

/**
 * Resolves the acting emergency contact for an (owner, LINE user) pair, used to
 * populate acknowledgement / claim attribution.
 *
 * @param ownerUserId The session owner's user id.
 * @param lineUserId The acting LINE user id.
 * @returns `{ contactId, name }` of the bound contact, or `null` if none.
 */
export async function resolveActingContact(
  ownerUserId: string,
  lineUserId: string,
): Promise<{ contactId?: string; name?: string } | null> {
  const contact = await findBoundContact(ownerUserId, lineUserId);
  if (!contact) return null;
  return { contactId: String(contact._id), name: contact.name ?? undefined };
}

function fail(
  httpCode: number,
  reason: keyof typeof SOS_REASON,
): ServiceResult {
  return {
    ok: false,
    httpCode,
    message: SOS_MSG[reason],
    data: { reason: SOS_REASON[reason] },
  };
}

/**
 * Builds the public tracking URL for a share token.
 *
 * @param shareToken The session's high-entropy share token.
 * @returns The full tracking URL for LINE notifications / browsers.
 */
function trackingUrl(shareToken: string): string {
  const base = process.env.PUBLIC_TRACKING_BASE_URL ?? "";
  return `${base}/zh-TW?sos=${shareToken}`;
}

/**
 * Returns the LINE user ids of the caller's bound emergency contacts.
 *
 * @param userId Owner's user id.
 * @returns Array of bound `lineUserId` strings.
 */
async function boundLineUserIds(userId: string): Promise<string[]> {
  return findBoundLineUserIds(userId);
}

/**
 * Creates an SOS session. Attempts a direct insert so the unique partial index
 * (`{userId} where status=active`) is the single source of truth against
 * double-tap races; on `E11000` it returns the existing active session (200,
 * no re-notification), otherwise 201 + best-effort multicast.
 *
 * @param input Requester id, SOS type and location.
 * @returns 201 (new) or 200 (existing active) with `{ sessionId, shareToken, notifiedCount }`.
 */
export async function createSession(
  input: CreateSosInput,
): Promise<ServiceResult> {
  const shareToken = crypto.randomBytes(16).toString("hex");
  const now = new Date();

  try {
    const session = await insertSession({
      userId: input.userId,
      type: input.type,
      status: "active",
      lat: input.lat,
      lng: input.lng,
      address: input.address ?? null,
      shareToken,
      locationUpdatedAt: now,
      timeline: [
        { type: "created", actorType: "victim", at: now },
        { type: "notified", actorType: "system", at: now },
      ],
    });

    const lineUserIds = await boundLineUserIds(input.userId);
    let userName: string | undefined;
    try {
      userName = await findUserName(input.userId);
    } catch {
      userName = undefined;
    }
    const notifiedCount = await sendSosNotification(lineUserIds, {
      userName,
      type: input.type,
      trackingUrl: trackingUrl(session.shareToken),
      address: session.address,
    });

    return {
      ok: true,
      httpCode: ResponseCode.CREATED,
      message: SOS_MSG.CREATED,
      data: {
        sessionId: session._id,
        shareToken: session.shareToken,
        notifiedCount,
      },
    };
  } catch (err) {
    if ((err as { code?: number })?.code === 11000) {
      const existing = await findActiveSessionByUser(input.userId);
      if (existing) {
        const notifiedCount = (await boundLineUserIds(input.userId)).length;
        return {
          ok: true,
          httpCode: ResponseCode.OK,
          message: SOS_MSG.ALREADY_ACTIVE,
          data: {
            sessionId: existing._id,
            shareToken: existing.shareToken,
            notifiedCount,
          },
        };
      }
    }
    throw err;
  }
}

/**
 * Updates the location of an active SOS session owned by the caller. Resets the
 * stale-alert flag so the background job can warn again after a fresh gap.
 *
 * @param input Owner id, session id and new location.
 * @returns 200, or 404/403/400 per ownership and state guards.
 */
export async function updateLocation(
  input: UpdateLocationInput,
): Promise<ServiceResult> {
  if (!Types.ObjectId.isValid(input.sessionId)) {
    return fail(ResponseCode.NOT_FOUND, "SESSION_NOT_FOUND");
  }
  const session = await findSessionById(input.sessionId);
  if (!session) return fail(ResponseCode.NOT_FOUND, "SESSION_NOT_FOUND");
  if (String(session.userId) !== input.userId) {
    return fail(ResponseCode.FORBIDDEN, "NOT_SESSION_OWNER");
  }
  if (session.status !== "active") {
    return fail(ResponseCode.INVALID_INPUT, "SESSION_NOT_ACTIVE");
  }

  const updated = await updateActiveSessionLocation(input.sessionId, {
    lat: input.lat,
    lng: input.lng,
    address: input.address,
  });
  if (!updated) return fail(ResponseCode.INVALID_INPUT, "SESSION_NOT_ACTIVE");

  emitSosUpdate(
    String(updated._id),
    buildSosSnapshot(updated as unknown as ISosSession),
  );

  return {
    ok: true,
    httpCode: ResponseCode.OK,
    message: SOS_MSG.PUBLIC_OK,
    data: { sessionId: updated._id },
  };
}

/**
 * Records a bound contact's acknowledgement of an active session (idempotent per
 * contact). Only the first matching write emits a snapshot / notifies others and
 * bumps `handlingStatus` from `notified` to `acknowledged`.
 *
 * @param input Session id and acting LINE user id.
 * @returns 200 with `{ sessionId, handlingStatus }`, or 403 when not authorized.
 */
export async function acknowledgeSession(
  input: AcknowledgeSosInput,
): Promise<ServiceResult> {
  const auth = await getAuthorizedSessionForLineUser(
    input.lineUserId,
    input.sessionId,
  );
  if (!auth?.session)
    return fail(ResponseCode.FORBIDDEN, "NOT_AUTHORIZED_CONTACT");
  const acting = await resolveActingContact(
    auth.session.userId,
    input.lineUserId,
  );
  const now = new Date();

  const recorded = await pushAcknowledgement(
    input.sessionId,
    input.lineUserId,
    {
      contactId: acting?.contactId,
      lineUserId: input.lineUserId,
      name: acting?.name,
      at: now,
    },
    {
      type: "acknowledged",
      actorType: "contact",
      actorLineUserId: input.lineUserId,
      actorName: acting?.name,
      at: now,
    },
  );

  if (!recorded) {
    const current = await findSessionById(input.sessionId);
    if (current?.status === "resolved") {
      return {
        ok: true,
        httpCode: ResponseCode.OK,
        message: SOS_MSG.ALREADY_RESOLVED,
        data: {
          sessionId: input.sessionId,
          handlingStatus: current.handlingStatus,
          reason: SOS_REASON.ALREADY_RESOLVED,
        },
      };
    }
    return {
      ok: true,
      httpCode: ResponseCode.OK,
      message: SOS_MSG.ACKNOWLEDGED,
      data: {
        sessionId: input.sessionId,
        handlingStatus: current?.handlingStatus,
      },
    };
  }

  await promoteToAcknowledged(input.sessionId);

  const updated = await findSessionById(input.sessionId);
  if (updated) {
    emitSosUpdate(
      input.sessionId,
      buildSosSnapshot(updated as unknown as ISosSession),
    );
    const others = (await boundLineUserIds(String(updated.userId))).filter(
      (id) => id !== input.lineUserId,
    );
    await notifyOthers(others, `${acting?.name ?? "家人"}已確認收到通知`);
  }

  return {
    ok: true,
    httpCode: ResponseCode.OK,
    message: SOS_MSG.ACKNOWLEDGED,
    data: {
      sessionId: input.sessionId,
      handlingStatus: updated?.handlingStatus,
    },
  };
}

/**
 * Claims sole responsibility for an active, unclaimed session. The claim is
 * atomic: only the winning contact flips `handlingStatus` to `claimed`, emits and
 * notifies; a second claimant gets a 200 `ALREADY_CLAIMED` without side effects.
 *
 * @param input Session id and acting LINE user id.
 * @returns 200 `CLAIMED`, 200 `ALREADY_CLAIMED`, 403, or 400 per state.
 */
export async function claimSession(
  input: ClaimSosInput,
): Promise<ServiceResult> {
  const auth = await getAuthorizedSessionForLineUser(
    input.lineUserId,
    input.sessionId,
  );
  if (!auth?.session)
    return fail(ResponseCode.FORBIDDEN, "NOT_AUTHORIZED_CONTACT");
  const acting = await resolveActingContact(
    auth.session.userId,
    input.lineUserId,
  );
  const now = new Date();

  const prev = await claimUnclaimedSession(
    input.sessionId,
    {
      claimedBy: input.lineUserId,
      claimedByName: acting?.name,
      claimedByContactId: acting?.contactId,
      claimedAt: now,
      handlingStatus: "claimed",
    },
    {
      type: "claimed",
      actorType: "contact",
      actorLineUserId: input.lineUserId,
      actorName: acting?.name,
      at: now,
    },
  );

  if (prev) {
    const updated = await findSessionById(input.sessionId);
    if (updated) {
      emitSosUpdate(
        input.sessionId,
        buildSosSnapshot(updated as unknown as ISosSession),
      );
      const others = (await boundLineUserIds(String(updated.userId))).filter(
        (id) => id !== input.lineUserId,
      );
      await notifyOthers(others, `${acting?.name ?? "家人"}已承接此事件`);
    }
    return {
      ok: true,
      httpCode: ResponseCode.OK,
      message: SOS_MSG.CLAIMED,
      data: { sessionId: input.sessionId, claimedByName: acting?.name ?? null },
    };
  }

  const current = await findSessionById(input.sessionId);
  if (current?.claimedBy === input.lineUserId) {
    return {
      ok: true,
      httpCode: ResponseCode.OK,
      message: SOS_MSG.CLAIMED,
      data: {
        sessionId: input.sessionId,
        claimedByName: current.claimedByName ?? null,
      },
    };
  }
  if (!current || current.status !== "active") {
    return fail(ResponseCode.INVALID_INPUT, "SESSION_NOT_ACTIVE");
  }
  return {
    ok: false,
    httpCode: ResponseCode.OK,
    message: SOS_MSG.ALREADY_CLAIMED,
    data: {
      reason: SOS_REASON.ALREADY_CLAIMED,
      claimedByName: current.claimedByName ?? null,
    },
  };
}

/**
 * Updates the handling status / logs a note for an active session by any bound
 * contact, then emits a snapshot and notifies the other contacts.
 *
 * @param input Session id, acting LINE user id, optional handlingStatus and note.
 * @returns 200 with `{ sessionId, handlingStatus }`, 403, or 400 when not active.
 */
export async function updateHandlingStatus(
  input: UpdateSosStatusInput,
): Promise<ServiceResult> {
  const auth = await getAuthorizedSessionForLineUser(
    input.lineUserId,
    input.sessionId,
  );
  if (!auth?.session)
    return fail(ResponseCode.FORBIDDEN, "NOT_AUTHORIZED_CONTACT");
  const acting = await resolveActingContact(
    auth.session.userId,
    input.lineUserId,
  );
  const now = new Date();

  const update: Record<string, unknown> = {
    $push: {
      timeline: {
        type: "status_update",
        actorType: "contact",
        actorLineUserId: input.lineUserId,
        actorName: acting?.name,
        note: input.note ?? null,
        at: now,
      },
    },
  };
  if (input.handlingStatus) {
    update.$set = { handlingStatus: input.handlingStatus };
  }

  const updated = await applyHandlingUpdate(input.sessionId, update);
  if (!updated) return fail(ResponseCode.INVALID_INPUT, "SESSION_NOT_ACTIVE");

  emitSosUpdate(
    input.sessionId,
    buildSosSnapshot(updated as unknown as ISosSession),
  );
  const others = (await boundLineUserIds(updated.userId)).filter(
    (id) => id !== input.lineUserId,
  );
  await notifyOthers(others, `${acting?.name ?? "家人"}更新了處理狀態`);

  return {
    ok: true,
    httpCode: ResponseCode.OK,
    message: SOS_MSG.STATUS_UPDATED,
    data: {
      sessionId: input.sessionId,
      handlingStatus: updated.handlingStatus,
    },
  };
}

/**
 * Resolves an active SOS session, atomically flipping `active → resolved` so only
 * the winning call notifies bound contacts and emits. Accepts either the web
 * owner (`userId`) or a bound LINE contact (`lineUserId`).
 *
 * @param input Session id and exactly one caller identity.
 * @returns 200 with `{ sessionId, status }`, or 404/403 per guards.
 */
export async function resolveSession(
  input: ResolveSosInput,
): Promise<ServiceResult> {
  if (!Types.ObjectId.isValid(input.sessionId)) {
    return fail(ResponseCode.NOT_FOUND, "SESSION_NOT_FOUND");
  }

  let ownerUserId: string;
  let actorName: string | undefined;
  if (input.userId) {
    const session = await findSessionById(input.sessionId);
    if (!session) return fail(ResponseCode.NOT_FOUND, "SESSION_NOT_FOUND");
    if (String(session.userId) !== input.userId) {
      return fail(ResponseCode.FORBIDDEN, "NOT_SESSION_OWNER");
    }
    ownerUserId = input.userId;
  } else if (input.lineUserId) {
    const auth = await getAuthorizedSessionForLineUser(
      input.lineUserId,
      input.sessionId,
    );
    if (!auth?.session)
      return fail(ResponseCode.FORBIDDEN, "NOT_AUTHORIZED_CONTACT");
    ownerUserId = auth.session.userId;
    const acting = await resolveActingContact(ownerUserId, input.lineUserId);
    actorName = acting?.name;
  } else {
    return fail(ResponseCode.FORBIDDEN, "NOT_AUTHORIZED_CONTACT");
  }

  const now = new Date();
  const prev = await resolveActiveSession(
    input.sessionId,
    { status: "resolved", resolvedAt: now, handlingStatus: "resolved" },
    {
      type: "resolved",
      actorType: input.userId ? "victim" : "contact",
      actorLineUserId: input.lineUserId ?? null,
      actorName: actorName ?? null,
      note: null,
      at: now,
    },
  );

  if (!prev) {
    return {
      ok: true,
      httpCode: ResponseCode.OK,
      message: SOS_MSG.RESOLVED,
      data: {
        sessionId: input.sessionId,
        status: "resolved",
        reason: SOS_REASON.ALREADY_RESOLVED,
      },
    };
  }

  let userName: string | undefined;
  try {
    userName = await findUserName(ownerUserId);
  } catch {
    userName = undefined;
  }
  await sendSosResolved(await boundLineUserIds(ownerUserId), userName);

  const updated = await findSessionById(input.sessionId);
  if (updated) {
    emitSosUpdate(
      input.sessionId,
      buildSosSnapshot(updated as unknown as ISosSession),
    );
  }

  return {
    ok: true,
    httpCode: ResponseCode.OK,
    message: SOS_MSG.RESOLVED,
    data: { sessionId: input.sessionId, status: "resolved" },
  };
}

/**
 * Loads a session snapshot for its web owner. Backs the initial GET load and the
 * SSE polling fallback.
 *
 * @param input Owner id and session id.
 * @returns 200 with the snapshot, 404 unknown, or 403 when not the owner.
 */
export async function getSessionForOwner(
  input: GetSosForOwnerInput,
): Promise<ServiceResult> {
  if (!Types.ObjectId.isValid(input.sessionId)) {
    return fail(ResponseCode.NOT_FOUND, "SESSION_NOT_FOUND");
  }
  const session = await findSessionById(input.sessionId);
  if (!session) return fail(ResponseCode.NOT_FOUND, "SESSION_NOT_FOUND");
  if (String(session.userId) !== input.userId) {
    return fail(ResponseCode.FORBIDDEN, "NOT_SESSION_OWNER");
  }
  return {
    ok: true,
    httpCode: ResponseCode.OK,
    message: SOS_MSG.PUBLIC_OK,
    data: buildSosSnapshot(session as unknown as ISosSession),
  };
}

/**
 * Public tracking lookup by share token (no auth). Resolved sessions older than
 * 24h are treated as expired (410).
 *
 * @param token The 32-char share token.
 * @returns 200 with a minimal location view, 404 unknown, or 410 expired.
 */
export async function getPublicByToken(
  shareToken: string,
): Promise<ServiceResult> {
  const session = await findSessionByShareToken(shareToken);
  if (!session) {
    return {
      ok: false,
      httpCode: ResponseCode.NOT_FOUND,
      message: SOS_MSG.TRACKING_NOT_FOUND,
      data: { reason: SOS_REASON.SESSION_NOT_FOUND },
    };
  }
  if (
    session.status === "resolved" &&
    session.resolvedAt &&
    Date.now() - new Date(session.resolvedAt).getTime() > TRACKING_EXPIRY_MS
  ) {
    return fail(ResponseCode.GONE, "TRACKING_EXPIRED");
  }
  return {
    ok: true,
    httpCode: ResponseCode.OK,
    message: SOS_MSG.PUBLIC_OK,
    data: {
      type: session.type,
      status: session.status,
      lat: session.lat,
      lng: session.lng,
      address: session.address ?? null,
      updatedAt: session.locationUpdatedAt,
    },
  };
}
