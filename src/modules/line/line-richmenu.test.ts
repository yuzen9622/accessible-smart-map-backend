import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../adapters/line.adapter", () => ({
  getRichMenuIdByAlias: vi.fn(),
  linkRichMenuToUser: vi.fn(),
  unlinkRichMenuFromUser: vi.fn(),
}));
vi.mock("../../config/redis", () => ({
  redisGet: vi.fn(),
  redisSet: vi.fn(),
}));
vi.mock("../sos/sos.service", () => ({
  getActiveSosChoicesForLineUser: vi.fn(),
}));

import {
  getRichMenuIdByAlias,
  linkRichMenuToUser,
  unlinkRichMenuFromUser,
} from "../../adapters/line.adapter";
import { redisGet, redisSet } from "../../config/redis";
import { getActiveSosChoicesForLineUser } from "../sos/sos.service";
import {
  EMERGENCY_RICH_MENU,
  RICH_MENU_HEIGHT,
  RICH_MENU_WIDTH,
  richMenuStateFor,
  syncRichMenu,
  toRichMenuRequest,
} from "./line-richmenu";

function page(bound: boolean, sessions: number) {
  return {
    bound,
    sessions: Array.from({ length: sessions }, (_, i) => ({
      sessionId: `s${i}`,
      ownerName: "媽媽",
      type: "body" as const,
      createdAt: new Date(),
    })),
    hasMore: false,
    offset: 0,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getRichMenuIdByAlias).mockResolvedValue("menu-emergency");
});

describe("LINE emergency rich menu", () => {
  it.each([
    [false, 0, "default"],
    [true, 0, "default"],
    [true, 2, "emergency"],
  ] as const)("bound=%s active=%s → %s", async (bound, active, state) => {
    vi.mocked(getActiveSosChoicesForLineUser).mockResolvedValue(
      page(bound, active),
    );
    expect(await richMenuStateFor("U1")).toBe(state);
  });

  it("has six tap areas inside the image", () => {
    const areas = toRichMenuRequest(EMERGENCY_RICH_MENU).areas ?? [];
    expect(areas).toHaveLength(6);
    for (const { bounds } of areas) {
      const { x = 0, y = 0, width = 0, height = 0 } = bounds ?? {};
      expect(x + width).toBeLessThanOrEqual(RICH_MENU_WIDTH);
      expect(y + height).toBeLessThanOrEqual(RICH_MENU_HEIGHT);
    }
  });

  it("links the emergency menu while a followed SOS is active", async () => {
    vi.mocked(getActiveSosChoicesForLineUser).mockResolvedValue(page(true, 1));
    await syncRichMenu("U1", true);
    expect(linkRichMenuToUser).toHaveBeenCalledWith("U1", "menu-emergency");
    expect(unlinkRichMenuFromUser).not.toHaveBeenCalled();
    expect(redisSet).toHaveBeenCalledWith(
      "line:richmenu:U1",
      "emergency:menu-emergency",
      expect.any(Number),
    );
  });

  it("removes the per-user link so the account's own default menu shows", async () => {
    vi.mocked(getActiveSosChoicesForLineUser).mockResolvedValue(page(true, 0));
    await syncRichMenu("U1", true);
    expect(unlinkRichMenuFromUser).toHaveBeenCalledWith("U1");
    expect(linkRichMenuToUser).not.toHaveBeenCalled();
    expect(redisSet).toHaveBeenCalledWith(
      "line:richmenu:U1",
      "default",
      expect.any(Number),
    );
  });

  it("skips LINE calls when the cached value already matches", async () => {
    vi.mocked(getActiveSosChoicesForLineUser).mockResolvedValue(page(true, 0));
    vi.mocked(redisGet).mockResolvedValue("default");
    await syncRichMenu("U1");
    expect(unlinkRichMenuFromUser).not.toHaveBeenCalled();
    expect(linkRichMenuToUser).not.toHaveBeenCalled();
  });

  it("relinks after the emergency menu was republished", async () => {
    vi.mocked(getActiveSosChoicesForLineUser).mockResolvedValue(page(true, 1));
    vi.mocked(redisGet).mockResolvedValue("emergency:old-menu-id");
    await syncRichMenu("U1");
    expect(linkRichMenuToUser).toHaveBeenCalledWith("U1", "menu-emergency");
  });

  it("never throws when LINE fails", async () => {
    vi.mocked(getActiveSosChoicesForLineUser).mockResolvedValue(page(true, 1));
    vi.mocked(linkRichMenuToUser).mockRejectedValue(new Error("LINE down"));
    await expect(syncRichMenu("U1", true)).resolves.toBeUndefined();
    expect(redisSet).not.toHaveBeenCalled();
  });
});
