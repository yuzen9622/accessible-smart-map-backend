import type { webhook } from "@line/bot-sdk";
import {
  findActiveSessionByShareToken,
  findLatestLocatedContact,
  findUserName,
  releaseContactsForLineUser,
  updateBoundContactLocations,
} from "./line.repository";
import {
  buildBoundContactsMessage,
  buildClaimedControlsMessage,
  buildSosHistoryMessage,
  buildSosMenuMessage,
  buildSosActionSelectionMessage,
  buildUnbindConfirmMessage,
  buildActiveSosMessage,
  buildLocationFollowUpMessage,
  buildRoutePreviewLinkMessage,
  buildShareLocationMessage,
  buildWelcomeMessage,
  downloadMessageContent,
  replyAgentResult,
  replyMessages,
  replyText,
  showLoadingAnimation,
  type RouteCardPayload,
} from "../../adapters/line.adapter";
import { LINE_MSG, SOS_MSG, SOS_REASON } from "../../constants/messages";
import { planAccessibleRouteFromRequest } from "../accessible-route/accessible-route.service";
import {
  acknowledgeSession,
  claimSession,
  getAuthorizedSessionForLineUser,
  getActiveSosChoicesForLineUser,
  listActiveSosForLineUser,
  resolveSession,
  updateHandlingStatus,
} from "../sos/sos.service";
import type { ServiceResult } from "../sos/sos.types";
import { redisSetNx } from "../../config/redis";
import { ResponseCode } from "../../types/code";
import { stripLineMarkdown } from "../../utils/strip-line-markdown";
import type {
  LineBoundContact,
  LineEvent,
  LineRoutePreviewData,
  LineServiceResult,
} from "./line.types";
import type { AccessibilityMode, TravelMode } from "../../types/route";
import type { OAIMessage } from "../../types/openai-chat";
import {
  appendLineChatTurn,
  clearLineLastLocation,
  clearPendingRename,
  getLineChatHistory,
  getLineLastLocation,
  setLineLastLocation,
  getPendingRename,
  setPendingRename,
} from "./line-memory";
import { runLineAgent } from "./line-agent.service";
import { transcribeAudio } from "../../adapters/ai-audio.adapter";
import { routePreviewUrl, sosTrackingUrl } from "../../config/public-links";
import {
  listBoundContacts,
  listSosHistory,
  renameBoundContact,
  unbindContact,
} from "./line-menu.service";

import {
  hasUsableEmergencyContactCode,
  bindEmergencyContactCode,
} from "../emergency-contact/emergency-contact.service";
import {
  hasUsableLineAccountCode,
  bindLineAccountCode,
} from "../user/user.service";

const EVENT_DEDUP_TTL_SEC = 3600;
const SOS_MENU_TRIGGER = "SOS資訊查詢";
const RENAME_CANCEL_WORD = "取消";
/** LINE voice messages are AAC in an MP4 container. */
const LINE_AUDIO_MIME = "audio/mp4";
const MAX_AUDIO_DURATION_MS = 60_000;
const MAX_AUDIO_BYTES = 2 * 1024 * 1024;
const AUDIO_TRANSCRIBE_TIMEOUT_MS = 15_000;

function getUserId(event: LineEvent): string | undefined {
  const source = event.source as webhook.UserSource | undefined;
  if (source && source.type === "user") return source.userId;
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function fail<T = never>(
  httpCode: ResponseCode,
  message: string,
): LineServiceResult<T> {
  return { ok: false, httpCode, message };
}

function describeRouteLegs(legs: unknown): string | undefined {
  if (!Array.isArray(legs)) return undefined;
  const labels = legs
    .slice(0, 3)
    .map((leg) => {
      if (!isRecord(leg)) return undefined;
      const type = asString(leg.type);
      if (type === "WALK") return "步行";
      if (type === "BUS")
        return `公車${asString(leg.routeName) ? ` ${asString(leg.routeName)}` : ""}`;
      if (type === "METRO")
        return `捷運${asString(leg.lineName) ? ` ${asString(leg.lineName)}` : ""}`;
      if (type === "THSR") return "高鐵";
      if (type === "TRA") return "台鐵";
      if (type === "DRIVE") return "汽車";
      if (type === "MOTORCYCLE") return "機車";
      return type;
    })
    .filter((value): value is string => Boolean(value));
  return labels.length ? labels.join(" → ") : undefined;
}

/**
 * Build a route card from collected tool results. Handles both the SOS route
 * tool and the general accessible-route planner so the agent can surface a card.
 *
 * @param toolResults Collected tool results from the agent loop.
 * @returns A route card payload, or null when no usable route result exists.
 */
function routeCardFromToolResults(
  toolResults: Array<{ name: string; result: unknown }>,
): RouteCardPayload | null {
  const entry = [...toolResults]
    .reverse()
    .find(
      (item) =>
        (item.name === "planRouteToSosVictim" ||
          item.name === "planAccessibleRoute") &&
        isRecord(item.result) &&
        item.result.ok === true,
    );
  if (!entry || !isRecord(entry.result)) return null;

  const result = entry.result;
  const routes = Array.isArray(result.routes) ? result.routes : [];
  const options = routes
    .slice(0, 3)
    .map((route, index): RouteCardPayload["options"][number] | null => {
      if (!isRecord(route)) return null;
      const totalMinutes =
        typeof route.totalMinutes === "number" ? route.totalMinutes : undefined;
      return {
        label: asString(route.routeName) ?? `路線 ${index + 1}`,
        time:
          totalMinutes !== undefined
            ? `約 ${Math.round(totalMinutes)} 分鐘`
            : "時間待確認",
        detail: describeRouteLegs(route.legs),
      };
    })
    .filter((value): value is RouteCardPayload["options"][number] =>
      Boolean(value),
    );

  if (!options.length) return null;

  const isSos = entry.name === "planRouteToSosVictim";
  const destination = isRecord(result.destination)
    ? (asString(result.destination.address) ??
      asString(result.destination.name) ??
      asString(result.ownerName) ??
      "目的地")
    : (asString(result.ownerName) ?? "目的地");
  return {
    origin: isSos ? "你分享的位置" : "你的位置",
    destination,
    options,
    liffUrl: routePreviewUrl(asString(result.shareToken)),
  };
}

/**
 * Extracts speech text from the agent result. The family agent may answer with a
 * plain string or a JSON envelope carrying a `speech` field; both are handled.
 *
 * @param text The raw agent text output.
 * @returns The speech to reply with, falling back to the fixed info message.
 */
function parseAgentSpeech(text: string | undefined): string {
  if (!text?.trim()) return LINE_MSG.AI_UNAVAILABLE;
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (
        isRecord(parsed) &&
        typeof parsed.speech === "string" &&
        parsed.speech.trim()
      ) {
        return parsed.speech;
      }
    } catch {
      return text;
    }
  }
  return text;
}

async function handleTextMessage(
  replyToken: string,
  text: string,
  lineUserId?: string,
  voice?: { heard: string },
): Promise<void> {
  try {
    if (lineUserId) await showLoadingAnimation(lineUserId).catch(() => {});
    const [history, userLocation] = lineUserId
      ? await Promise.all([
          getLineChatHistory(lineUserId),
          getLineLastLocation(lineUserId),
        ])
      : [[], undefined];
    const messages: OAIMessage[] = [
      ...history.map((turn): OAIMessage => ({
        role: turn.role,
        content: turn.content,
      })),
      { role: "user", content: text },
    ];
    const result = await runLineAgent({
      lineUserId: lineUserId ?? "",
      messages,
      userLocation,
      ...(voice ? { readOnly: true } : {}),
    });
    const speech = stripLineMarkdown(parseAgentSpeech(result.text));
    const routeCard = routeCardFromToolResults(result.toolResults);
    await replyAgentResult(
      replyToken,
      voice ? `${voice.heard}\n${speech}` : speech,
      routeCard,
      lineUserId,
    );
    if (lineUserId) await appendLineChatTurn(lineUserId, text, speech);
  } catch (error) {
    console.error(
      "[line.service] family agent failed",
      error instanceof Error ? error.name : "UnknownError",
    );
    await replyText(replyToken, LINE_MSG.AI_UNAVAILABLE, lineUserId);
  }
}

/**
 * Applies a pending display-name edit. A format error keeps the pending slot so the
 * user can simply type again; the cancel word and every terminal outcome clear it.
 *
 * @param replyToken One-time reply token from the webhook event.
 * @param lineUserId The LINE user id of the sender.
 * @param contactId The emergency-contact id awaiting a new display name.
 * @param text The trimmed message text.
 */
async function handleRenameInput(
  replyToken: string,
  lineUserId: string,
  contactId: string,
  text: string,
): Promise<void> {
  if (text === RENAME_CANCEL_WORD) {
    await clearPendingRename(lineUserId);
    await replyText(replyToken, LINE_MSG.SOS_RENAME_CANCELLED);
    return;
  }

  const result = await renameBoundContact({
    lineUserId,
    contactId,
    name: text,
  });
  if (!result.ok && result.httpCode === ResponseCode.INVALID_INPUT) {
    await replyText(replyToken, result.message);
    return;
  }
  await clearPendingRename(lineUserId);
  await replyText(replyToken, result.message);
}

type ReceiptAction = "ack" | "claim";

/** Only complete affirmative statements are commands; questions/negations stay chat. */
function receiptAction(text: string): ReceiptAction | undefined {
  const normalized = text.replace(/[\s，,。.!！]/g, "");
  if (
    /^(?:(?:收到|我收到了|我收到回報))?(?:我處理|我來處理(?:這件事)?)$/.test(
      normalized,
    )
  )
    return "claim";
  if (/^(?:收到|我收到了|我收到回報)$/.test(normalized)) return "ack";
  return undefined;
}

/** Never pass a binding code to the model or save it in chat history. */
async function handleBindingCode(
  replyToken: string,
  code: string,
  lineUserId?: string,
): Promise<void> {
  if (!lineUserId) {
    await replyText(replyToken, LINE_MSG.USER_REQUIRED);
    return;
  }
  try {
    const [emergency, account] = await Promise.all([
      hasUsableEmergencyContactCode(code),
      hasUsableLineAccountCode(code),
    ]);
    if (emergency && account) {
      await replyText(replyToken, LINE_MSG.BIND_AMBIGUOUS);
      return;
    }
    if (!emergency && !account) {
      await replyText(replyToken, LINE_MSG.BIND_INVALID);
      return;
    }
    const result = emergency
      ? await bindEmergencyContactCode(code, lineUserId)
      : await bindLineAccountCode(code, lineUserId);
    await replyText(
      replyToken,
      result.ok
        ? emergency
          ? LINE_MSG.BIND_SUCCESS
          : LINE_MSG.ACCOUNT_BIND_SUCCESS
        : (result.error ?? LINE_MSG.OPERATION_UNCONFIRMED),
    );
  } catch (error) {
    console.error(
      "[line.service] binding failed",
      error instanceof Error ? error.name : "UnknownError",
    );
    await replyText(replyToken, LINE_MSG.OPERATION_UNCONFIRMED);
  }
}

/** Shared response mapping for text and notification-button receipt actions. */
async function executeReceiptAction(
  replyToken: string,
  action: ReceiptAction,
  sid: string,
  lineUserId: string,
): Promise<void> {
  const result =
    action === "claim"
      ? await claimSession({ sessionId: sid, lineUserId })
      : await acknowledgeSession({ sessionId: sid, lineUserId });
  if (observedResolved(result)) {
    await replyText(replyToken, LINE_MSG.SOS_ALREADY_RESOLVED);
  } else if (action === "claim" && result.ok) {
    await replyMessages(replyToken, [
      { type: "text", text: result.message },
      buildClaimedControlsMessage(sid),
    ]);
  } else {
    await replyText(replyToken, result.message);
  }
}

async function handleReceiptText(
  replyToken: string,
  action: ReceiptAction,
  lineUserId?: string,
  offset = 0,
  selectionOnly = false,
): Promise<void> {
  if (!lineUserId) {
    await replyText(replyToken, LINE_MSG.USER_REQUIRED);
    return;
  }
  let actionStarted = false;
  try {
    const page = await getActiveSosChoicesForLineUser(lineUserId, offset);
    if (!page.bound) {
      await replyText(replyToken, LINE_MSG.SOS_NO_CONTACTS);
    } else if (!page.sessions.length && offset === 0) {
      await replyText(replyToken, LINE_MSG.SOS_NO_ACTIVE);
    } else if (!selectionOnly && page.sessions.length === 1 && !page.hasMore) {
      actionStarted = true;
      await executeReceiptAction(
        replyToken,
        action,
        page.sessions[0].sessionId,
        lineUserId,
      );
    } else {
      await replyMessages(replyToken, [
        buildSosActionSelectionMessage(action, page),
      ]);
    }
  } catch (error) {
    console.error(
      "[line.service] SOS text handling failed",
      error instanceof Error ? error.name : "UnknownError",
    );
    await replyText(
      replyToken,
      actionStarted
        ? LINE_MSG.OPERATION_UNCONFIRMED
        : LINE_MSG.SOS_QUERY_FAILED,
    );
  }
}

/**
 * Routes explicit binding / receipt commands before ordinary chat. Bare codes
 * retain name semantics only while an explicit display-name edit is pending.
 *
 * @param replyToken One-time reply token from the webhook event.
 * @param text The raw message text.
 * @param lineUserId The LINE user id of the sender, when the source is a user.
 */
async function handleTextEvent(
  replyToken: string,
  text: string,
  lineUserId?: string,
): Promise<void> {
  const trimmed = text.trim();
  if (trimmed === SOS_MENU_TRIGGER) {
    await replyMessages(replyToken, [buildSosMenuMessage()]);
    return;
  }

  const explicitBinding = trimmed.match(/^綁定\s*([A-Za-z0-9]+)$/);
  const action = receiptAction(trimmed);
  if (explicitBinding || action) {
    if (lineUserId) await clearPendingRename(lineUserId);
    if (action) await handleReceiptText(replyToken, action, lineUserId);
    else if (explicitBinding && /^[A-Za-z0-9]{6}$/.test(explicitBinding[1])) {
      await handleBindingCode(
        replyToken,
        explicitBinding[1].toUpperCase(),
        lineUserId,
      );
    } else await replyText(replyToken, LINE_MSG.BIND_FORMAT);
    return;
  }

  if (lineUserId) {
    let pendingContactId: string | null = null;
    try {
      pendingContactId = await getPendingRename(lineUserId);
    } catch (error) {
      console.error("[line.service] pending rename lookup failed", error);
    }
    if (pendingContactId) {
      try {
        await handleRenameInput(
          replyToken,
          lineUserId,
          pendingContactId,
          trimmed,
        );
      } catch (error) {
        console.error(
          "[line.service] rename handling failed",
          error instanceof Error ? error.name : "UnknownError",
        );
        await replyText(replyToken, LINE_MSG.OPERATION_UNCONFIRMED);
      }
      return;
    }
  }

  if (/^[A-Za-z0-9]{6}$/.test(trimmed)) {
    await handleBindingCode(replyToken, trimmed.toUpperCase(), lineUserId);
    return;
  }
  await handleTextMessage(replyToken, text, lineUserId);
}

/**
 * Looks up one of the caller's own bound contacts by id. Returns null when the id
 * is not among this LINE account's bindings, so a forged postback id can never
 * reach another user's record.
 *
 * @param lineUserId The LINE user id of the caller.
 * @param contactId The contact id carried by the postback.
 * @returns The matching bound contact, or null.
 */
async function findOwnBoundContact(
  lineUserId: string,
  contactId: string | null,
): Promise<LineBoundContact | null> {
  if (!contactId) return null;
  const result = await listBoundContacts(lineUserId);
  return (
    result.data?.find((contact) => contact.contactId === contactId) ?? null
  );
}

/**
 * Handles the SOS information menu postbacks (`action=sos_*`). These carry no
 * session id, but they do require an identified LINE user: every query is scoped
 * by `lineUserId`, so the caller is resolved before this function runs.
 *
 * @param replyToken One-time reply token from the webhook event.
 * @param action The parsed postback action.
 * @param params The parsed postback parameters.
 * @param lineUserId The LINE user id of the caller.
 */
async function handleMenuPostback(
  replyToken: string,
  action: string,
  params: URLSearchParams,
  lineUserId: string,
): Promise<void> {
  try {
    if (action === "sos_menu") {
      await replyMessages(replyToken, [buildSosMenuMessage()]);
      return;
    }
    if (action === "sos_action_page") {
      const intent = params.get("intent");
      const rawOffset = params.get("offset") ?? "";
      const offset = Number(rawOffset);
      if (
        (intent !== "ack" && intent !== "claim") ||
        !/^\d+$/.test(rawOffset) ||
        !Number.isSafeInteger(offset) ||
        offset > 100_000
      ) {
        await replyText(replyToken, LINE_MSG.INVALID_ACTION);
        return;
      }
      await handleReceiptText(replyToken, intent, lineUserId, offset, true);
      return;
    }
    if (action === "sos_help") {
      await replyText(replyToken, LINE_MSG.SOS_HELP);
      return;
    }
    if (action === "sos_bind_start") {
      await clearPendingRename(lineUserId);
      await replyText(replyToken, LINE_MSG.SOS_BIND_PROMPT);
      return;
    }

    await showLoadingAnimation(lineUserId).catch(() => {});

    if (action === "sos_status") {
      await replySosStatus(replyToken, lineUserId);
      return;
    }

    if (action === "sos_route") {
      await handleSosRoute(replyToken, lineUserId, params.get("sid"));
      return;
    }

    if (action === "sos_contacts") {
      const result = await listBoundContacts(lineUserId);
      if (!result.ok || !result.data?.length) {
        await replyText(replyToken, LINE_MSG.SOS_NO_CONTACTS);
        return;
      }
      await replyMessages(replyToken, [buildBoundContactsMessage(result.data)]);
      return;
    }

    if (action === "sos_history") {
      const result = await listSosHistory({
        lineUserId,
        ownerId: params.get("owner") ?? undefined,
      });
      if (!result.ok || !result.data) {
        await replyText(replyToken, result.message);
        return;
      }
      if (!result.data.entries.length) {
        await replyText(replyToken, LINE_MSG.SOS_NO_HISTORY);
        return;
      }
      await replyMessages(replyToken, [buildSosHistoryMessage(result.data)]);
      return;
    }

    if (action === "sos_contact_rename") {
      const contact = await findOwnBoundContact(lineUserId, params.get("cid"));
      if (!contact) {
        await replyText(replyToken, LINE_MSG.SOS_CONTACT_NOT_FOUND);
        return;
      }
      await setPendingRename(lineUserId, contact.contactId);
      await replyText(replyToken, LINE_MSG.SOS_RENAME_PROMPT);
      return;
    }

    if (action === "sos_unbind") {
      const contact = await findOwnBoundContact(lineUserId, params.get("cid"));
      if (!contact) {
        await replyText(replyToken, LINE_MSG.SOS_CONTACT_NOT_FOUND);
        return;
      }
      await replyMessages(replyToken, [buildUnbindConfirmMessage(contact)]);
      return;
    }

    if (action === "sos_unbind_do") {
      const contactId = params.get("cid");
      if (!contactId) {
        await replyText(replyToken, LINE_MSG.SOS_CONTACT_NOT_FOUND);
        return;
      }
      const result = await unbindContact({ lineUserId, contactId });
      await replyText(replyToken, result.message);
      return;
    }

    await replyText(replyToken, LINE_MSG.INVALID_ACTION);
  } catch (error) {
    console.error(
      "[line.service] menu postback handling failed",
      error instanceof Error ? error.name : "UnknownError",
    );
    await replyText(replyToken, LINE_MSG.OPERATION_UNCONFIRMED);
  }
}

/**
 * Detects whether an SOS action observed an already-resolved / not-active session,
 * so every postback action can be normalized to one unified "resolved" reply. Narrows
 * `ServiceResult.data` (typed `unknown`) with an object guard before reading `reason`.
 *
 * @param result The result returned by an SOS action service.
 * @returns True when the action saw a resolved / closed session.
 */
function observedResolved(result: ServiceResult): boolean {
  const data = result.data;
  if (typeof data !== "object" || data === null) return false;
  const reason = (data as { reason?: unknown }).reason;
  return (
    reason === SOS_REASON.ALREADY_RESOLVED ||
    reason === SOS_REASON.SESSION_NOT_ACTIVE
  );
}

/**
 * Handles a postback event. `sos_*` actions belong to the SOS information menu and
 * are dispatched before the session checks below, since they carry no session id —
 * they still require an identified LINE user because every menu query is scoped by
 * `lineUserId`. Every other action is an SOS control postback from a notification or
 * claim-controls message, and maps to a deterministic SOS service call (never the agent). Malformed
 * postbacks are answered with the invalid-action message without any session lookup;
 * once the action is known-valid, an authorization-preserving pre-check replies with
 * the unified "resolved" message for an already-closed session (and unauthorized
 * callers get the standard permission reply), before the action runs. A resolution
 * that races the action is normalized to the same unified reply.
 *
 * @param event The LINE postback event.
 */
async function handlePostback(event: webhook.PostbackEvent): Promise<void> {
  const replyToken = event.replyToken;
  if (!replyToken) return;

  const params = new URLSearchParams(event.postback.data);
  const action = params.get("action");
  const sid = params.get("sid");
  const value = params.get("v");
  const lineUserId = getUserId(event);

  if (action?.startsWith("sos_")) {
    if (!lineUserId) {
      await replyText(replyToken, LINE_MSG.USER_REQUIRED);
      return;
    }
    await handleMenuPostback(replyToken, action, params, lineUserId);
    return;
  }

  if (!sid || !/^(?:[a-fA-F0-9]{24}|[a-f0-9]{32})$/.test(sid) || !lineUserId) {
    await replyText(
      replyToken,
      lineUserId ? LINE_MSG.INVALID_ACTION : LINE_MSG.USER_REQUIRED,
    );
    return;
  }
  if (
    action !== "ack" &&
    action !== "claim" &&
    action !== "status" &&
    action !== "resolve"
  ) {
    await replyText(replyToken, LINE_MSG.INVALID_ACTION);
    return;
  }
  if (action === "status" && value !== "en_route" && value !== "arrived") {
    await replyText(replyToken, LINE_MSG.INVALID_ACTION);
    return;
  }

  try {
    const auth = await getAuthorizedSessionForLineUser(lineUserId, sid, {
      allowLegacyShareToken: true,
    });
    if (!auth?.session) {
      await replyText(replyToken, SOS_MSG.NOT_AUTHORIZED_CONTACT);
      return;
    }
    if (auth.session.status === "resolved") {
      await replyText(replyToken, LINE_MSG.SOS_ALREADY_RESOLVED);
      return;
    }

    await showLoadingAnimation(lineUserId).catch(() => {});

    // Never pass an old card's share token into domain writes or new controls.
    const sessionId = String(auth.session._id);
    if (action === "claim" || action === "ack") {
      await executeReceiptAction(replyToken, action, sessionId, lineUserId);
      return;
    }

    let result: ServiceResult;
    if (action === "status") {
      result = await updateHandlingStatus({
        sessionId,
        lineUserId,
        handlingStatus: value as "en_route" | "arrived",
      });
    } else {
      result = await resolveSession({ sessionId, lineUserId });
    }

    if (observedResolved(result)) {
      await replyText(replyToken, LINE_MSG.SOS_ALREADY_RESOLVED);
      return;
    }
    await replyText(replyToken, result.message);
  } catch (error) {
    console.error(
      "[line.service] postback handling failed",
      error instanceof Error ? error.name : "UnknownError",
    );
    await replyText(replyToken, LINE_MSG.OPERATION_UNCONFIRMED);
  }
}

/**
 * Replies with the status carousel of every active SOS this contact follows.
 *
 * @param replyToken One-time reply token from the webhook event.
 * @param lineUserId The LINE user id of the caller.
 */
async function replySosStatus(
  replyToken: string,
  lineUserId: string,
): Promise<void> {
  const { bound, sessions } = await listActiveSosForLineUser(lineUserId);
  if (!bound) {
    await replyText(replyToken, LINE_MSG.SOS_NO_CONTACTS);
    return;
  }
  if (!sessions.length) {
    await replyText(replyToken, LINE_MSG.SOS_NO_ACTIVE);
    return;
  }
  await replyMessages(replyToken, [
    buildActiveSosMessage(
      sessions.map((entry) => ({
        ...entry,
        trackingUrl: sosTrackingUrl(entry.shareToken),
      })),
    ),
  ]);
}

/**
 * Route from the contact to a family member in distress. Needs a location the
 * contact shared within the last 30 minutes; otherwise asks for one with LINE's
 * native location picker. With several active events and no `sid`, the status
 * carousel lets the user pick (each card has its own route button).
 *
 * @param replyToken One-time reply token from the webhook event.
 * @param lineUserId The LINE user id of the caller.
 * @param sid Optional session id from a card button.
 */
async function handleSosRoute(
  replyToken: string,
  lineUserId: string,
  sid: string | null,
): Promise<void> {
  const { bound, sessions } = await listActiveSosForLineUser(lineUserId);
  if (!bound) {
    await replyText(replyToken, LINE_MSG.SOS_NO_CONTACTS);
    return;
  }
  const target = sid
    ? sessions.find((entry) => entry.sessionId === sid)
    : sessions.length === 1
      ? sessions[0]
      : undefined;
  if (!target) {
    if (sid || !sessions.length) {
      await replyText(replyToken, LINE_MSG.SOS_NO_ACTIVE);
      return;
    }
    await replySosStatus(replyToken, lineUserId);
    return;
  }
  if (!(await getLineLastLocation(lineUserId))) {
    await replyMessages(replyToken, [
      buildShareLocationMessage(LINE_MSG.SOS_ROUTE_NEED_LOCATION),
    ]);
    return;
  }
  const url = routePreviewUrl(target.shareToken);
  if (!url) {
    await replyText(replyToken, LINE_MSG.SOS_ROUTE_UNAVAILABLE);
    return;
  }
  await replyMessages(replyToken, [buildRoutePreviewLinkMessage(url)]);
}

/**
 * A shared location is remembered for follow-up questions and, for bound
 * contacts, becomes the origin of the route to the family member. The reply
 * offers the next step: the SOS route when an event is active, otherwise the
 * common place-based queries.
 */
async function handleLocationMessage(
  replyToken: string,
  message: Extract<LineEvent, { type: "message" }>["message"] & {
    type: "location";
  },
  lineUserId?: string,
): Promise<void> {
  if (!lineUserId) return;

  await Promise.all([
    updateBoundContactLocations(
      lineUserId,
      message.latitude,
      message.longitude,
    ),
    setLineLastLocation(lineUserId, {
      latitude: message.latitude,
      longitude: message.longitude,
    }),
  ]);

  if (!replyToken) return;

  let sessions: Array<{ sessionId: string }> = [];
  try {
    sessions = (await listActiveSosForLineUser(lineUserId)).sessions;
  } catch (error) {
    console.error(
      "[line.service] active SOS lookup failed",
      error instanceof Error ? error.name : "UnknownError",
    );
  }
  await replyMessages(replyToken, [
    buildLocationFollowUpMessage(
      sessions.length === 1 ? sessions[0].sessionId : undefined,
      sessions.length > 0,
    ),
  ]);
}

/**
 * Voice messages are transcribed and answered by the assistant, echoing what
 * was heard so a mis-hearing is visible. Transcripts only go to the chat agent
 * — never to binding or SOS receipt commands, which must not run on a guess.
 */
async function handleAudioMessage(
  replyToken: string,
  message: { id: string; duration?: number },
  lineUserId?: string,
): Promise<void> {
  if (!lineUserId) {
    await replyText(replyToken, LINE_MSG.USER_REQUIRED);
    return;
  }
  if ((message.duration ?? 0) > MAX_AUDIO_DURATION_MS) {
    await replyText(replyToken, LINE_MSG.AUDIO_TOO_LONG);
    return;
  }
  await showLoadingAnimation(lineUserId).catch(() => {});
  let transcript = "";
  try {
    const audio = await downloadMessageContent(message.id, MAX_AUDIO_BYTES);
    transcript = await transcribeAudio(
      audio,
      LINE_AUDIO_MIME,
      AUDIO_TRANSCRIBE_TIMEOUT_MS,
    );
  } catch (error) {
    console.error(
      "[line.service] audio transcription failed",
      error instanceof Error ? error.name : "UnknownError",
    );
  }
  if (!transcript) {
    await replyText(replyToken, LINE_MSG.AUDIO_FAILED, lineUserId);
    return;
  }
  await handleTextMessage(replyToken, transcript, lineUserId, {
    heard: LINE_MSG.AUDIO_HEARD.replace("{text}", transcript),
  });
}

async function handleEvent(event: LineEvent): Promise<void> {
  switch (event.type) {
    case "follow":
      if (event.replyToken) {
        await replyMessages(event.replyToken, [buildWelcomeMessage()]);
      }
      return;
    case "postback":
      await handlePostback(event);
      return;
    case "message": {
      const message = event.message;
      if (!event.replyToken) return;
      const lineUserId = getUserId(event);
      if (message.type === "text") {
        await handleTextEvent(event.replyToken, message.text, lineUserId);
        return;
      }
      if (message.type === "location") {
        await handleLocationMessage(event.replyToken, message, lineUserId);
        return;
      }
      if (message.type === "audio") {
        await handleAudioMessage(event.replyToken, message, lineUserId);
        return;
      }
      await replyText(
        event.replyToken,
        message.type === "image"
          ? LINE_MSG.MEDIA_IMAGE_UNSUPPORTED
          : LINE_MSG.MEDIA_UNSUPPORTED,
      );
      return;
    }
    case "unfollow": {
      const userId = getUserId(event);
      if (userId) {
        await releaseContactsForLineUser(userId);
        await clearLineLastLocation(userId);
      }
      return;
    }
    default:
      return;
  }
}

export async function handleEvents(events: LineEvent[]): Promise<void> {
  for (const event of events) {
    try {
      const eventId = (event as { webhookEventId?: string }).webhookEventId;
      if (eventId) {
        const fresh = await redisSetNx(
          `line:evt:${eventId}`,
          EVENT_DEDUP_TTL_SEC,
        );
        if (!fresh) continue;
      }
      await handleEvent(event);
    } catch (err) {
      console.error("[line.service] event handling failed", err);
    }
  }
}

/**
 * Resolves the route preview for a LINE route-preview URL.
 *
 * The URL carries the SOS session's high-entropy shareToken (32 hex chars,
 * generated at session creation) — never the low-entropy Mongo ObjectId, which
 * is guessable/enumerable and would leak the victim's and contact's locations.
 *
 * @param previewToken The shareToken from the route-preview query.
 * @returns Route preview data or a failure envelope.
 */
export async function getRoutePreview(
  previewToken: string,
  travelMode?: TravelMode,
  mode?: AccessibilityMode,
  departureTime?: string,
): Promise<LineServiceResult<LineRoutePreviewData>> {
  if (!/^[0-9a-f]{32}$/.test(previewToken)) {
    return fail(ResponseCode.NOT_FOUND, "找不到進行中的求救紀錄");
  }

  const session = await findActiveSessionByShareToken(previewToken);
  if (!session) {
    return fail(ResponseCode.NOT_FOUND, "找不到進行中的求救紀錄");
  }

  const contact = await findLatestLocatedContact(String(session.userId));

  if (
    typeof contact?.lastLineLat !== "number" ||
    typeof contact?.lastLineLng !== "number"
  ) {
    return fail(ResponseCode.INVALID_INPUT, "尚未取得家人目前位置");
  }

  const routeResult = await planAccessibleRouteFromRequest({
    origin: {
      latitude: contact.lastLineLat,
      longitude: contact.lastLineLng,
    },
    destination: {
      latitude: session.lat,
      longitude: session.lng,
    },
    keepExactDestination: true,
    mode: mode ?? "normal",
    travelMode: travelMode ?? "drive",
    maxTransfers: 2,
    departureTime,
  });

  if (!routeResult.ok) {
    return fail(routeResult.status, routeResult.error);
  }

  const ownerName = await findUserName(String(session.userId));
  return {
    ok: true,
    httpCode: ResponseCode.OK,
    message: "OK",
    data: {
      ...routeResult.data,
      sessionId: String(session._id),
      ownerName: ownerName ?? "未知使用者",
      originLabel: "你分享的位置",
      destinationLabel: session.address ?? "求救者位置",
      travelMode: routeResult.data.travelMode ?? travelMode ?? "drive",
    },
  };
}
