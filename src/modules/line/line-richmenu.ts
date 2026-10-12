import type { messagingApi } from "@line/bot-sdk";
import {
  getRichMenuIdByAlias,
  linkRichMenuToUser,
  unlinkRichMenuFromUser,
} from "../../adapters/line.adapter";
import { redisGet, redisSet } from "../../config/redis";
import { getActiveSosChoicesForLineUser } from "../sos/sos.service";
import { onSosContactLifecycle } from "../sos/sos-events";

/**
 * Emergency rich menu for bound contacts while a family member's SOS is active.
 *
 * Everyone normally sees the official account's own default menu, set in the
 * LINE OA Manager; this module never touches it. While an SOS a contact follows
 * is active, the emergency menu is linked to that contact (a per-user link
 * outranks every default menu). Once no followed SOS is active, the per-user
 * link is removed and the account's default menu shows again.
 *
 * The menu is created once by `pnpm line:richmenu` and found at runtime through
 * a stable alias, so redeploys never need a new menu id.
 */
export type LineRichMenuState = "default" | "emergency";

export const EMERGENCY_RICH_MENU_ALIAS = "tam-emergency";

export type RichMenuTone = "primary" | "neutral" | "danger";

export interface RichMenuCell {
  title: string;
  subtitle: string;
  glyph: string;
  tone: RichMenuTone;
  action: messagingApi.Action;
}

export interface RichMenuSpec {
  name: string;
  chatBarText: string;
  /** Six cells, row-major, 3 per row. */
  cells: RichMenuCell[];
}

export const RICH_MENU_WIDTH = 2500;
export const RICH_MENU_HEIGHT = 1686;
const COLUMN_X = [0, 833, 1667];
const COLUMN_W = [833, 834, 833];
const ROW_Y = [0, 843];
const ROW_H = 843;

function postback(
  data: string,
  displayText: string,
  openKeyboard = false,
): messagingApi.Action {
  return {
    type: "postback",
    data,
    displayText,
    ...(openKeyboard ? { inputOption: "openKeyboard" as const } : {}),
  };
}

function call(number: string): messagingApi.Action {
  return { type: "uri", uri: `tel:${number}` };
}

export const EMERGENCY_RICH_MENU: RichMenuSpec = {
  name: "tam-emergency",
  chatBarText: "⚠ 家人求救中",
  cells: [
    {
      title: "求救狀態",
      subtitle: "位置・誰在處理",
      glyph: "！",
      tone: "danger",
      action: postback("action=sos_status", "查看求救狀態"),
    },
    {
      title: "我來處理",
      subtitle: "通知其他家人",
      glyph: "手",
      tone: "danger",
      action: postback("action=sos_claim", "我來處理這件事"),
    },
    {
      title: "分享我的位置",
      subtitle: "用來規劃路線",
      glyph: "位",
      tone: "primary",
      action: postback("action=sos_share_location", "分享我的位置"),
    },
    {
      title: "前往路線",
      subtitle: "從我到家人",
      glyph: "路",
      tone: "primary",
      action: postback("action=sos_route", "規劃前往路線"),
    },
    {
      title: "撥打 119",
      subtitle: "消防・救護",
      glyph: "119",
      tone: "danger",
      action: call("119"),
    },
    {
      title: "撥打 110",
      subtitle: "警察",
      glyph: "110",
      tone: "danger",
      action: call("110"),
    },
  ],
};

/**
 * @param spec One menu spec.
 * @returns The LINE rich menu request with six tappable areas.
 */
export function toRichMenuRequest(
  spec: RichMenuSpec,
): messagingApi.RichMenuRequest {
  return {
    size: { width: RICH_MENU_WIDTH, height: RICH_MENU_HEIGHT },
    selected: true,
    name: spec.name,
    chatBarText: spec.chatBarText,
    areas: spec.cells.map((cell, index) => ({
      bounds: {
        x: COLUMN_X[index % 3],
        y: ROW_Y[Math.floor(index / 3)],
        width: COLUMN_W[index % 3],
        height: ROW_H,
      },
      action: cell.action,
    })),
  };
}

/** Cell geometry for the image renderer (same grid as the tap areas). */
export function richMenuCellBounds(index: number): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  return {
    x: COLUMN_X[index % 3],
    y: ROW_Y[Math.floor(index / 3)],
    width: COLUMN_W[index % 3],
    height: ROW_H,
  };
}

const STATE_CACHE_TTL_SEC = 24 * 60 * 60;
const ALIAS_CACHE_MS = 10 * 60 * 1000;
let aliasCache: { id: string | null; at: number } | null = null;

function stateKey(lineUserId: string): string {
  return `line:richmenu:${lineUserId}`;
}

async function emergencyRichMenuId(): Promise<string | null> {
  if (aliasCache && Date.now() - aliasCache.at < ALIAS_CACHE_MS) {
    return aliasCache.id;
  }
  const id = await getRichMenuIdByAlias(EMERGENCY_RICH_MENU_ALIAS);
  aliasCache = { id, at: Date.now() };
  return id;
}

/**
 * @param lineUserId The LINE user.
 * @returns "emergency" while any SOS this user follows is active.
 */
export async function richMenuStateFor(
  lineUserId: string,
): Promise<LineRichMenuState> {
  const page = await getActiveSosChoicesForLineUser(lineUserId, 0);
  return page.bound && page.sessions.length ? "emergency" : "default";
}

/**
 * Links the emergency menu while a followed SOS is active, otherwise removes
 * the per-user link so the account's own default menu shows. Best-effort: an
 * unpublished menu or any LINE/DB error leaves the current menu in place. The
 * last applied value is cached so routine events cost one Redis read.
 *
 * @param lineUserId The LINE user to update.
 * @param force Apply even if the cached value already matches.
 */
export async function syncRichMenu(
  lineUserId: string,
  force = false,
): Promise<void> {
  try {
    const state = await richMenuStateFor(lineUserId);
    const richMenuId =
      state === "emergency" ? await emergencyRichMenuId() : null;
    if (state === "emergency" && !richMenuId) return;
    // Keyed by menu id too, so a republished menu (alias moved) is relinked.
    const applied = richMenuId ? `emergency:${richMenuId}` : "default";
    if (!force && (await redisGet(stateKey(lineUserId))) === applied) return;
    if (richMenuId) await linkRichMenuToUser(lineUserId, richMenuId);
    else await unlinkRichMenuFromUser(lineUserId);
    await redisSet(stateKey(lineUserId), applied, STATE_CACHE_TTL_SEC);
  } catch (error) {
    console.warn(
      "[line-richmenu] sync failed",
      error instanceof Error ? error.name : "UnknownError",
    );
  }
}

/**
 * Switches contacts' menus when an SOS they follow starts or ends. Returns the
 * unsubscribe function for shutdown.
 */
export function startLineRichMenuSync(): () => void {
  return onSosContactLifecycle(({ lineUserIds }) => {
    void (async () => {
      for (const lineUserId of new Set(lineUserIds)) {
        await syncRichMenu(lineUserId, true);
      }
    })();
  });
}
