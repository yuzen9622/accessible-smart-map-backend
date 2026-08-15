import { messagingApi } from "@line/bot-sdk";
import { LINE_MSG, SOS_TYPE_LABEL } from "../constants/messages";
import { taipeiHHmm, taipeiYmdDash } from "../config/taipei-time";
import type { SosType } from "../modules/sos/sos.types";
import type {
  LineBoundContact,
  LineSosHistoryData,
  LineSosHistoryEntry,
} from "../modules/line/line.types";

let client: messagingApi.MessagingApiClient | null = null;

export type LineReplyMessage = messagingApi.Message;

/**
 * Lazily constructs (and caches) the LINE Messaging API client. Reads
 * `LINE_CHANNEL_ACCESS_TOKEN` on first use so the module stays importable in
 * environments where LINE is not configured (tests fully mock this adapter).
 *
 * @returns The shared `MessagingApiClient` instance.
 */
function getClient(): messagingApi.MessagingApiClient {
  if (!client) {
    client = new messagingApi.MessagingApiClient({
      channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN ?? "",
    });
  }
  return client;
}

/**
 * Builds the official add-friend URL from the configured bot basic id.
 *
 * @returns The `https://line.me/R/ti/p/@...` deep link shown to the user.
 */
export function buildBindUrl(): string {
  const basicId = process.env.LINE_BOT_BASIC_ID ?? "@xxxxxxx";
  return `https://line.me/R/ti/p/${basicId}`;
}

interface SosNotificationPayload {
  userName?: string;
  type: SosType;
  trackingUrl: string;
  address?: string | null;
}

export interface RouteCardOption {
  label: string;
  time: string;
  detail?: string;
}

export interface RouteCardPayload {
  origin: string;
  destination: string;
  options: RouteCardOption[];
  liffUrl?: string;
}

/**
 * Extracts the SOS session id from a tracking URL. The tracking URL is built by
 * the SOS service as `${base}/zh-TW?sos=<sessionId>`, so the id is read from the
 * `sos` query parameter without coupling this adapter to the service layer.
 *
 * @param trackingUrl The public tracking URL embedded in the notification.
 * @returns The session id, or undefined when the URL cannot be parsed.
 */
function extractSessionId(trackingUrl: string): string | undefined {
  try {
    return new URL(trackingUrl).searchParams.get("sos") ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Builds the SOS notification Flex Message (§7.5). Adds postback action buttons
 * so a bound contact can acknowledge or claim the event directly from the card.
 *
 * @param payload SOS details used to populate the card.
 * @returns A LINE Flex Message ready to push.
 */
function buildSosNotificationFlex(
  payload: SosNotificationPayload,
): messagingApi.FlexMessage {
  const bodyContents: messagingApi.FlexComponent[] = [
    {
      type: "text",
      text: LINE_MSG.SOS_NOTIFY_TITLE,
      weight: "bold",
      size: "lg",
      color: "#D0021B",
    },
    {
      type: "text",
      text: `類型：${SOS_TYPE_LABEL[payload.type]}`,
      wrap: true,
      margin: "md",
    },
  ];
  if (payload.userName) {
    bodyContents.push({
      type: "text",
      text: `求救者：${payload.userName}`,
      wrap: true,
    });
  }
  if (payload.address) {
    bodyContents.push({
      type: "text",
      text: `位置：${payload.address}`,
      wrap: true,
    });
  }

  const sessionId = extractSessionId(payload.trackingUrl);
  const footerContents: messagingApi.FlexComponent[] = [];
  if (sessionId) {
    footerContents.push(
      {
        type: "button",
        style: "primary",
        color: "#D0021B",
        action: {
          type: "postback",
          label: "我收到了",
          data: `action=ack&sid=${sessionId}`,
          displayText: "我收到通知了",
        },
      },
      {
        type: "button",
        style: "primary",
        color: "#1F4E79",
        action: {
          type: "postback",
          label: "我來處理",
          data: `action=claim&sid=${sessionId}`,
          displayText: "我來處理這件事",
        },
      },
    );
  }
  footerContents.push({
    type: "button",
    style: sessionId ? "link" : "primary",
    ...(sessionId ? {} : { color: "#D0021B" }),
    action: {
      type: "uri",
      label: LINE_MSG.VIEW_LOCATION,
      uri: payload.trackingUrl,
    },
  });

  return {
    type: "flex",
    altText: `${LINE_MSG.SOS_NOTIFY_TITLE}（${SOS_TYPE_LABEL[payload.type]}）`,
    contents: {
      type: "bubble",
      body: { type: "box", layout: "vertical", contents: bodyContents },
      footer: {
        type: "box",
        layout: "vertical",
        contents: footerContents,
      },
    },
  };
}

/**
 * Builds the control message replied to a contact right after they claim an SOS
 * event. Quick-reply postback buttons let the claimer update the handling status
 * or resolve the alert without typing.
 *
 * @param sessionId The claimed session id, embedded in each postback payload.
 * @returns A LINE text message carrying quick-reply postback actions.
 */
export function buildClaimedControlsMessage(
  sessionId: string,
): messagingApi.TextMessage {
  return {
    type: "text",
    text: "可使用下方按鈕更新處理狀態，或在抵達後解除警報。",
    quickReply: {
      items: [
        {
          type: "action",
          action: {
            type: "postback",
            label: "前往中",
            data: `action=status&sid=${sessionId}&v=en_route`,
            displayText: "我正在前往",
          },
        },
        {
          type: "action",
          action: {
            type: "postback",
            label: "已抵達",
            data: `action=status&sid=${sessionId}&v=arrived`,
            displayText: "我已抵達現場",
          },
        },
        {
          type: "action",
          action: {
            type: "postback",
            label: "解除警報",
            data: `action=resolve&sid=${sessionId}`,
            displayText: "解除警報",
          },
        },
      ],
    },
  };
}

const MAX_CAROUSEL_BUBBLES = 10;

/**
 * Builds the SOS information menu: one text message carrying the four
 * quick-reply postback entries the family user can tap instead of typing.
 *
 * @returns A LINE text message with the menu quick replies.
 */
export function buildSosMenuMessage(): messagingApi.TextMessage {
  return {
    type: "text",
    text: LINE_MSG.SOS_MENU_PROMPT,
    quickReply: {
      items: [
        {
          type: "action",
          action: {
            type: "postback",
            label: "綁定的使用者",
            data: "action=sos_contacts",
            displayText: "查看目前綁定的使用者",
          },
        },
        {
          type: "action",
          action: {
            type: "postback",
            label: "新增綁定",
            data: "action=sos_bind_start",
            displayText: "新增綁定使用者",
            inputOption: "openKeyboard",
          },
        },
        {
          type: "action",
          action: {
            type: "postback",
            label: "使用方式",
            data: "action=sos_help",
            displayText: "查看 SOS 使用方式",
          },
        },
        {
          type: "action",
          action: {
            type: "postback",
            label: "求助歷史",
            data: "action=sos_history",
            displayText: "查看求助歷史",
          },
        },
      ],
    },
  };
}

/**
 * Builds one bubble per bound emergency-contact record, each carrying rename and
 * unbind postback buttons scoped to that contact id.
 *
 * @param contact One bound contact entry.
 * @returns A Flex bubble for the carousel.
 */
function boundContactBubble(
  contact: LineBoundContact,
): messagingApi.FlexBubble {
  const details: messagingApi.FlexComponent[] = [
    {
      type: "text",
      text: contact.ownerName,
      weight: "bold",
      size: "lg",
      wrap: true,
    },
    {
      type: "text",
      text: `我的顯示名稱：${contact.contactName}`,
      size: "sm",
      color: "#666666",
      margin: "md",
      wrap: true,
    },
  ];
  if (contact.updatedAt) {
    details.push({
      type: "text",
      text: `最近更新：${taipeiYmdDash(contact.updatedAt)} ${taipeiHHmm(contact.updatedAt)}`,
      size: "xs",
      color: "#999999",
      margin: "sm",
    });
  }
  return {
    type: "bubble",
    body: { type: "box", layout: "vertical", contents: details },
    footer: {
      type: "box",
      layout: "vertical",
      spacing: "sm",
      contents: [
        {
          type: "button",
          style: "primary",
          action: {
            type: "postback",
            label: "修改顯示名稱",
            data: `action=sos_contact_rename&cid=${contact.contactId}`,
            displayText: `修改「${contact.ownerName}」的顯示名稱`,
            inputOption: "openKeyboard",
          },
        },
        {
          type: "button",
          style: "secondary",
          action: {
            type: "postback",
            label: "解除綁定",
            data: `action=sos_unbind&cid=${contact.contactId}`,
            displayText: `解除與「${contact.ownerName}」的綁定`,
          },
        },
      ],
    },
  };
}

/**
 * Builds the bound-users carousel. Callers handle the empty case with a plain
 * text message, so this builder assumes at least one contact.
 *
 * @param contacts Bound contacts, newest first.
 * @returns A LINE Flex carousel message.
 */
export function buildBoundContactsMessage(
  contacts: LineBoundContact[],
): messagingApi.FlexMessage {
  return {
    type: "flex",
    altText: LINE_MSG.SOS_CONTACTS_TITLE,
    contents: {
      type: "carousel",
      contents: contacts.slice(0, MAX_CAROUSEL_BUBBLES).map(boundContactBubble),
    },
  };
}

/**
 * Builds the confirmation step for releasing a binding, so a single mis-tap never
 * removes the notification channel.
 *
 * @param contact The binding about to be released.
 * @returns A LINE text message with confirm / cancel quick replies.
 */
export function buildUnbindConfirmMessage(
  contact: LineBoundContact,
): messagingApi.TextMessage {
  return {
    type: "text",
    text: `確定要解除與「${contact.ownerName}」的綁定嗎？解除後你不會再收到對方的求救通知。`,
    quickReply: {
      items: [
        {
          type: "action",
          action: {
            type: "postback",
            label: "確定解除",
            data: `action=sos_unbind_do&cid=${contact.contactId}`,
            displayText: "確定解除綁定",
          },
        },
        {
          type: "action",
          action: {
            type: "postback",
            label: "取消",
            data: "action=sos_menu",
            displayText: "取消",
          },
        },
      ],
    },
  };
}

/**
 * Builds one bubble per past SOS session.
 *
 * @param entry One history entry.
 * @returns A Flex bubble for the carousel.
 */
function sosHistoryBubble(entry: LineSosHistoryEntry): messagingApi.FlexBubble {
  const statusLabel = entry.status === "active" ? "進行中" : "已解除";
  const contents: messagingApi.FlexComponent[] = [
    {
      type: "text",
      text: `${entry.ownerName}・${SOS_TYPE_LABEL[entry.type]}`,
      weight: "bold",
      size: "md",
      wrap: true,
    },
    {
      type: "text",
      text: entry.createdAt
        ? `發生時間：${taipeiYmdDash(entry.createdAt)} ${taipeiHHmm(entry.createdAt)}`
        : "發生時間：未知",
      size: "sm",
      color: "#666666",
      margin: "md",
      wrap: true,
    },
    {
      type: "text",
      text: `狀態：${statusLabel}`,
      size: "sm",
      color: entry.status === "active" ? "#D32F2F" : "#2E7D32",
      margin: "sm",
    },
  ];
  if (entry.address) {
    contents.push({
      type: "text",
      text: `地點：${entry.address}`,
      size: "xs",
      color: "#999999",
      margin: "sm",
      wrap: true,
    });
  }
  if (entry.claimedByName) {
    contents.push({
      type: "text",
      text: `承接者：${entry.claimedByName}`,
      size: "xs",
      color: "#999999",
      margin: "sm",
      wrap: true,
    });
  }
  if (entry.resolvedAt) {
    contents.push({
      type: "text",
      text: `解除時間：${taipeiYmdDash(entry.resolvedAt)} ${taipeiHHmm(entry.resolvedAt)}`,
      size: "xs",
      color: "#999999",
      margin: "sm",
    });
  }
  return {
    type: "bubble",
    body: { type: "box", layout: "vertical", contents },
  };
}

/**
 * Builds the SOS history carousel plus per-owner filter quick replies. The owner
 * list is already limited by the service layer so the quick-reply cap is never hit.
 *
 * @param data History entries and the owners available as filters.
 * @returns A LINE Flex carousel message.
 */
export function buildSosHistoryMessage(
  data: LineSosHistoryData,
): messagingApi.FlexMessage {
  const items: messagingApi.QuickReplyItem[] = [];
  if (data.activeOwnerId) {
    items.push({
      type: "action",
      action: {
        type: "postback",
        label: "全部",
        data: "action=sos_history",
        displayText: "查看全部求助歷史",
      },
    });
  }
  for (const owner of data.owners) {
    if (owner.ownerId === data.activeOwnerId) continue;
    items.push({
      type: "action",
      action: {
        type: "postback",
        label: owner.ownerName.slice(0, 20),
        data: `action=sos_history&owner=${owner.ownerId}`,
        displayText: `查看 ${owner.ownerName} 的求助歷史`,
      },
    });
  }

  return {
    type: "flex",
    altText: LINE_MSG.SOS_HISTORY_TITLE,
    contents: {
      type: "carousel",
      contents: data.entries
        .slice(0, MAX_CAROUSEL_BUBBLES)
        .map(sosHistoryBubble),
    },
    ...(items.length ? { quickReply: { items } } : {}),
  };
}

/**
 * Builds the SOS resolved Flex Message (§7.7).
 *
 * @param userName Optional name of the person who was in distress.
 * @returns A LINE Flex Message ready to push.
 */
function buildSosResolvedFlex(userName?: string): messagingApi.FlexMessage {
  const contents: messagingApi.FlexComponent[] = [
    {
      type: "text",
      text: LINE_MSG.SOS_RESOLVED_TITLE,
      weight: "bold",
      size: "lg",
      color: "#2E7D32",
    },
  ];
  if (userName) {
    contents.push({
      type: "text",
      text: `${userName} 的求救已解除，目前平安。`,
      wrap: true,
      margin: "md",
    });
  }
  return {
    type: "flex",
    altText: LINE_MSG.SOS_RESOLVED_TITLE,
    contents: {
      type: "bubble",
      body: { type: "box", layout: "vertical", contents },
    },
  };
}

/**
 * Builds a route summary card for LINE chat. The route data is deliberately
 * small and already normalized by the service layer; this function only owns
 * LINE Flex presentation details.
 *
 * @param payload Normalized route card content.
 * @returns A LINE Flex Message ready to reply.
 */
export function buildRouteCardFlex(
  payload: RouteCardPayload,
): messagingApi.FlexMessage {
  const optionContents: messagingApi.FlexComponent[] = payload.options
    .slice(0, 3)
    .map((option) => ({
      type: "box",
      layout: "vertical",
      margin: "md",
      contents: [
        {
          type: "text",
          text: `${option.label}：${option.time}`,
          weight: "bold",
          size: "sm",
          wrap: true,
        },
        ...(option.detail
          ? [
              {
                type: "text" as const,
                text: option.detail,
                size: "xs" as const,
                color: "#666666",
                margin: "xs" as const,
                wrap: true,
              },
            ]
          : []),
      ],
    }));

  const footerContents: messagingApi.FlexComponent[] = payload.liffUrl
    ? [
        {
          type: "button",
          style: "primary",
          action: {
            type: "uri",
            label: "查看地圖",
            uri: payload.liffUrl,
          },
        },
      ]
    : [];

  return {
    type: "flex",
    altText: "路線規劃結果",
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        contents: [
          {
            type: "text",
            text: "路線規劃結果",
            weight: "bold",
            size: "lg",
            color: "#1F4E79",
          },
          {
            type: "text",
            text: `${payload.origin} → ${payload.destination}`,
            margin: "md",
            wrap: true,
          },
          ...optionContents,
        ],
      },
      ...(footerContents.length
        ? {
            footer: {
              type: "box" as const,
              layout: "vertical" as const,
              contents: footerContents,
            },
          }
        : {}),
    },
  };
}

/**
 * Multicasts the SOS notification to bound contacts (best-effort; individual
 * push failures are swallowed so they never block SOS creation).
 *
 * @param lineUserIds Bound contacts' LINE user ids.
 * @param payload SOS notification content.
 * @returns The number of recipients the notification was attempted for.
 */
export async function sendSosNotification(
  lineUserIds: string[],
  payload: SosNotificationPayload,
): Promise<number> {
  if (lineUserIds.length === 0) return 0;
  try {
    await getClient().multicast({
      to: lineUserIds,
      messages: [buildSosNotificationFlex(payload)],
    });
  } catch (err) {
    console.error("[line.adapter] sendSosNotification failed", err);
  }
  return lineUserIds.length;
}

/**
 * Multicasts the SOS resolved notice to bound contacts (best-effort).
 *
 * @param lineUserIds Bound contacts' LINE user ids.
 * @param userName Optional name of the person who was in distress.
 * @returns The number of recipients the notification was attempted for.
 */
export async function sendSosResolved(
  lineUserIds: string[],
  userName?: string,
): Promise<number> {
  if (lineUserIds.length === 0) return 0;
  try {
    await getClient().multicast({
      to: lineUserIds,
      messages: [buildSosResolvedFlex(userName)],
    });
  } catch (err) {
    console.error("[line.adapter] sendSosResolved failed", err);
  }
  return lineUserIds.length;
}

/**
 * Multicasts a plain-text SOS status update to bound contacts (best-effort;
 * push failures are swallowed so they never block the originating action).
 *
 * @param lineUserIds Recipient LINE user ids.
 * @param message The status update text.
 * @returns The number of recipients the update was attempted for.
 */
export async function pushSosUpdate(
  lineUserIds: string[],
  message: string,
): Promise<number> {
  if (lineUserIds.length === 0) return 0;
  try {
    await getClient().multicast({
      to: lineUserIds,
      messages: [{ type: "text", text: message }],
    });
  } catch (err) {
    console.error("[line.adapter] pushSosUpdate failed", err);
  }
  return lineUserIds.length;
}

const LOADING_ANIMATION_SECONDS = 60;
const LOADING_ANIMATION_TIMEOUT_MS = 2000;

/**
 * Shows LINE's native loading ("typing") animation in a 1-on-1 chat while the bot
 * prepares a reply. Best-effort and time-boxed: the SDK call is raced against a
 * {@link LOADING_ANIMATION_TIMEOUT_MS} timeout so a hung request can never consume the
 * reply-token window, and any (late) rejection is swallowed. The animation is
 * dismissed automatically as soon as the user receives the reply, so we request the
 * maximum supported duration.
 *
 * @param chatId The target user's LINE id (only valid for 1-on-1 chats).
 */
export async function showLoadingAnimation(chatId: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const call = getClient().showLoadingAnimation({
      chatId,
      loadingSeconds: LOADING_ANIMATION_SECONDS,
    });
    call.catch(() => {});
    await Promise.race([
      call,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, LOADING_ANIMATION_TIMEOUT_MS);
      }),
    ]);
  } catch (err) {
    console.error("[line.adapter] showLoadingAnimation failed", err);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Replies to a webhook event with plain text via the (free) reply token.
 *
 * @param replyToken One-time reply token from the webhook event.
 * @param text Message text.
 */
export async function replyText(
  replyToken: string,
  text: string,
): Promise<void> {
  await replyMessages(replyToken, [{ type: "text", text }]);
}

/**
 * Replies with speech text and, when available, a route preview Flex card.
 *
 * @param replyToken One-time reply token from the webhook event.
 * @param text Plain speech text shown before the card.
 * @param routeCard Optional normalized route card content.
 */
export async function replyAgentResult(
  replyToken: string,
  text: string,
  routeCard?: RouteCardPayload | null,
): Promise<void> {
  const messages: LineReplyMessage[] = [{ type: "text", text }];
  if (routeCard) messages.push(buildRouteCardFlex(routeCard));
  await replyMessages(replyToken, messages);
}

/**
 * Replies to a webhook event with one or more LINE messages via the reply token.
 *
 * @param replyToken One-time reply token from the webhook event.
 * @param messages LINE messages to send in order.
 */
export async function replyMessages(
  replyToken: string,
  messages: LineReplyMessage[],
): Promise<void> {
  try {
    await getClient().replyMessage({
      replyToken,
      messages,
    });
  } catch (err) {
    console.error("[line.adapter] replyMessages failed", err);
  }
}
