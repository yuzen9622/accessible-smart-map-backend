import type { messagingApi } from "@line/bot-sdk";
import {
  getRichMenuIdByAlias,
  linkRichMenuToUser,
} from "../../adapters/line.adapter";
import { redisGet, redisSet } from "../../config/redis";
import { getActiveSosChoicesForLineUser } from "../sos/sos.service";
import { onSosContactLifecycle } from "../sos/sos-events";

/**
 * Per-user LINE rich menus that follow the user's situation:
 * - unbound: no family bound yet — binding + general help
 * - bound: family bound, nothing happening — status, family, history
 * - emergency: a followed family member has an active SOS — act now
 *
 * Menus are created once by `pnpm line:richmenu` and found at runtime through
 * stable aliases, so redeploys never need new menu ids.
 */
export type LineRichMenuState = "unbound" | "bound" | "emergency";

export const RICH_MENU_ALIAS: Record<LineRichMenuState, string> = {
  unbound: "tam-unbound",
  bound: "tam-bound",
  emergency: "tam-emergency",
};

export type RichMenuTone = "primary" | "neutral" | "danger";

export interface RichMenuCell {
  title: string;
  subtitle: string;
  glyph: string;
  tone: RichMenuTone;
  action: messagingApi.Action;
}

export interface RichMenuSpec {
  state: LineRichMenuState;
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

function message(text: string): messagingApi.Action {
  return { type: "message", text };
}

function call(number: string): messagingApi.Action {
  return { type: "uri", uri: `tel:${number}` };
}

export const RICH_MENU_SPECS: RichMenuSpec[] = [
  {
    state: "unbound",
    name: "tam-unbound",
    chatBarText: "選單",
    cells: [
      {
        title: "綁定家人",
        subtitle: "輸入 6 碼綁定碼",
        glyph: "＋",
        tone: "primary",
        action: postback("action=sos_bind_start", "我有綁定碼", true),
      },
      {
        title: "無障礙廁所",
        subtitle: "找附近的",
        glyph: "廁",
        tone: "neutral",
        action: message("我附近的無障礙廁所在哪裡？"),
      },
      {
        title: "規劃路線",
        subtitle: "無障礙優先",
        glyph: "路",
        tone: "neutral",
        action: message("我想規劃無障礙路線"),
      },
      {
        title: "天氣空品",
        subtitle: "出門前看一下",
        glyph: "晴",
        tone: "neutral",
        action: message("今天天氣如何？"),
      },
      {
        title: "使用說明",
        subtitle: "這裡能做什麼",
        glyph: "？",
        tone: "neutral",
        action: postback("action=sos_help", "怎麼使用"),
      },
      {
        title: "撥打 119",
        subtitle: "消防・救護",
        glyph: "119",
        tone: "danger",
        action: call("119"),
      },
    ],
  },
  {
    state: "bound",
    name: "tam-bound",
    chatBarText: "家人與選單",
    cells: [
      {
        title: "家人狀態",
        subtitle: "有無進行中的求救",
        glyph: "家",
        tone: "primary",
        action: postback("action=sos_status", "查看家人狀態"),
      },
      {
        title: "綁定的家人",
        subtitle: "改名・解除綁定",
        glyph: "人",
        tone: "neutral",
        action: postback("action=sos_contacts", "查看綁定的家人"),
      },
      {
        title: "求救紀錄",
        subtitle: "過去的事件",
        glyph: "紀",
        tone: "neutral",
        action: postback("action=sos_history", "查看求救紀錄"),
      },
      {
        title: "無障礙廁所",
        subtitle: "找附近的",
        glyph: "廁",
        tone: "neutral",
        action: message("我附近的無障礙廁所在哪裡？"),
      },
      {
        title: "新增綁定",
        subtitle: "輸入 6 碼綁定碼",
        glyph: "＋",
        tone: "neutral",
        action: postback("action=sos_bind_start", "新增綁定", true),
      },
      {
        title: "使用說明",
        subtitle: "收到求救怎麼做",
        glyph: "？",
        tone: "neutral",
        action: postback("action=sos_help", "怎麼使用"),
      },
    ],
  },
  {
    state: "emergency",
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
  },
];

/**
 * @param spec One menu spec.
 * @returns The LINE rich menu request with six tappable areas.
 */
export function toRichMenuRequest(
  spec: RichMenuSpec,
): messagingApi.RichMenuRequest {
  return {
    size: { width: RICH_MENU_WIDTH, height: RICH_MENU_HEIGHT },
    selected: spec.state === "emergency",
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
const aliasCache = new Map<string, { id: string | null; at: number }>();

function stateKey(lineUserId: string): string {
  return `line:richmenu:${lineUserId}`;
}

async function richMenuIdFor(state: LineRichMenuState): Promise<string | null> {
  const alias = RICH_MENU_ALIAS[state];
  const cached = aliasCache.get(alias);
  if (cached && Date.now() - cached.at < ALIAS_CACHE_MS) return cached.id;
  const id = await getRichMenuIdByAlias(alias);
  aliasCache.set(alias, { id, at: Date.now() });
  return id;
}

/**
 * @param lineUserId The LINE user.
 * @returns Which menu fits the user's bindings and followed SOS events.
 */
export async function richMenuStateFor(
  lineUserId: string,
): Promise<LineRichMenuState> {
  const page = await getActiveSosChoicesForLineUser(lineUserId, 0);
  if (!page.bound) return "unbound";
  return page.sessions.length ? "emergency" : "bound";
}

/**
 * Links the menu matching the user's current state. Best-effort: menus that
 * were never published, or any LINE/DB error, leave the current menu in place.
 * The last linked state is cached so routine events cost one Redis read.
 *
 * @param lineUserId The LINE user to update.
 * @param force Relink even if the cached state already matches.
 */
export async function syncRichMenu(
  lineUserId: string,
  force = false,
): Promise<void> {
  try {
    const state = await richMenuStateFor(lineUserId);
    if (!force && (await redisGet(stateKey(lineUserId))) === state) return;
    const richMenuId = await richMenuIdFor(state);
    if (!richMenuId) return;
    await linkRichMenuToUser(lineUserId, richMenuId);
    await redisSet(stateKey(lineUserId), state, STATE_CACHE_TTL_SEC);
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
