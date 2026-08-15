import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../model/user.model", () => ({
  default: {
    findById: vi.fn(),
  },
}));

vi.mock("../../model/line-link-code.model", () => ({
  default: {
    exists: vi.fn(),
    findOneAndUpdate: vi.fn(),
  },
}));

vi.mock("../../adapters/line.adapter", () => ({
  buildBindUrl: vi.fn(() => "https://line.me/R/ti/p/@bot"),
}));

import User from "../../model/user.model";
import LineLinkCode from "../../model/line-link-code.model";
import { issueLineLinkCode } from "./user.service";

const userModel = User as unknown as {
  findById: ReturnType<typeof vi.fn>;
};
const codeModel = LineLinkCode as unknown as {
  exists: ReturnType<typeof vi.fn>;
  findOneAndUpdate: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  vi.resetAllMocks();
});

describe("issueLineLinkCode", () => {
  it("creates a fresh one-time LINE link code for the logged-in user", async () => {
    userModel.findById.mockResolvedValue({ _id: "u1" });
    codeModel.exists.mockResolvedValue(false);
    codeModel.findOneAndUpdate.mockResolvedValue({ _id: "c1" });

    const result = await issueLineLinkCode("u1");

    expect(result.bindCode).toHaveLength(6);
    expect(result.bindUrl).toBe("https://line.me/R/ti/p/@bot");
    expect(codeModel.findOneAndUpdate).toHaveBeenCalledWith(
      { userId: "u1" },
      expect.objectContaining({
        $set: expect.objectContaining({
          code: result.bindCode,
          expiresAt: expect.any(Date),
        }),
      }),
      { upsert: true, returnDocument: "after" },
    );
  });
});
