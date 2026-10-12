import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../adapters/line.adapter", () => ({
  getRichMenuIdByAlias: vi.fn(),
  linkRichMenuToUser: vi.fn(),
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
} from "../../adapters/line.adapter";
import { redisGet, redisSet } from "../../config/redis";
import { getActiveSosChoicesForLineUser } from "../sos/sos.service";
import {
  RICH_MENU_HEIGHT,
  RICH_MENU_SPECS,
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
  vi.mocked(getRichMenuIdByAlias).mockImplementation(
    async (alias) => `menu-${alias}`,
  );
});

describe("line rich menu", () => {
  it.each([
    [false, 0, "unbound"],
    [true, 0, "bound"],
    [true, 2, "emergency"],
  ] as const)("bound=%s active=%s → %s", async (bound, active, state) => {
    vi.mocked(getActiveSosChoicesForLineUser).mockResolvedValue(
      page(bound, active),
    );
    expect(await richMenuStateFor("U1")).toBe(state);
  });

  it("every menu has six tap areas inside the image", () => {
    for (const spec of RICH_MENU_SPECS) {
      const request = toRichMenuRequest(spec);
      const areas = request.areas ?? [];
      expect(areas).toHaveLength(6);
      for (const { bounds } of areas) {
        const { x = 0, y = 0, width = 0, height = 0 } = bounds ?? {};
        expect(x + width).toBeLessThanOrEqual(RICH_MENU_WIDTH);
        expect(y + height).toBeLessThanOrEqual(RICH_MENU_HEIGHT);
      }
    }
  });

  it("skips the LINE call when the cached state already matches", async () => {
    vi.mocked(getActiveSosChoicesForLineUser).mockResolvedValue(page(true, 0));
    vi.mocked(redisGet).mockResolvedValue("bound");
    await syncRichMenu("U1");
    expect(linkRichMenuToUser).not.toHaveBeenCalled();
  });

  it("links the emergency menu and caches the state", async () => {
    vi.mocked(getActiveSosChoicesForLineUser).mockResolvedValue(page(true, 1));
    vi.mocked(redisGet).mockResolvedValue("bound");
    await syncRichMenu("U1");
    expect(linkRichMenuToUser).toHaveBeenCalledWith("U1", "menu-tam-emergency");
    expect(redisSet).toHaveBeenCalledWith(
      "line:richmenu:U1",
      "emergency",
      expect.any(Number),
    );
  });

  it("never throws when LINE fails", async () => {
    vi.mocked(getActiveSosChoicesForLineUser).mockResolvedValue(page(true, 1));
    vi.mocked(linkRichMenuToUser).mockRejectedValue(new Error("LINE down"));
    await expect(syncRichMenu("U1", true)).resolves.toBeUndefined();
    expect(redisSet).not.toHaveBeenCalled();
  });
});
