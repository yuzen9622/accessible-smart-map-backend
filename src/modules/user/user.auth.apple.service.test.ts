import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../model/user.model", () => ({
  default: {
    findOne: vi.fn(),
    findById: vi.fn(),
    findOneAndUpdate: vi.fn(),
    create: vi.fn(),
  },
}));

vi.mock("../../model/config.model", () => ({
  default: {
    findOne: vi.fn(),
    create: vi.fn(),
  },
}));

vi.mock("../../model/auth-token.model", () => ({
  default: {
    findOneAndDelete: vi.fn(),
    findOneAndUpdate: vi.fn(),
  },
}));

vi.mock("../../adapters/email.adapter", () => ({
  sendVerificationEmail: vi.fn(),
  sendPasswordResetEmail: vi.fn(),
  sendGooglePasswordResetGuidanceEmail: vi.fn(),
}));

vi.mock("./user.password-assistance.queue", () => ({
  enqueuePasswordAssistance: vi.fn(),
  getOrSetPasswordResetExpiry: vi.fn(),
  renewPasswordAssistanceLease: vi.fn(),
}));

vi.mock("./user.auth-session.repository", () => ({
  createSession: vi.fn().mockResolvedValue({
    _id: "665f1a2b3c4d5e6f7a8b9c0e",
    userId: "user-1",
    currentRefreshJti: "jti-test-1",
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  }),
  revokeSession: vi.fn().mockResolvedValue(true),
  revokeAllSessionsByUserId: vi.fn().mockResolvedValue(1),
  rotateSession: vi.fn().mockResolvedValue({
    status: "SUCCESS",
    session: {
      _id: "665f1a2b3c4d5e6f7a8b9c0e",
      userId: "user-1",
      currentRefreshJti: "jti-test-2",
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
  }),
}));

vi.mock("../../adapters/apple-auth.adapter", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../adapters/apple-auth.adapter")>();
  return {
    ...actual,
    verifyAppleIdentityToken: vi.fn(),
  };
});

import User from "../../model/user.model";
import Config from "../../model/config.model";
import { authenticateWithApple } from "./user.auth.service";
import {
  createSession,
  revokeAllSessionsByUserId,
} from "./user.auth-session.repository";
import {
  verifyAppleIdentityToken,
  AppleIdentityTokenError,
} from "../../adapters/apple-auth.adapter";
import { AppleAuthBodySchema } from "./user.schema";

function mockQueryReturn(val: unknown) {
  return {
    select: vi.fn().mockResolvedValue(val),
    then: (resolve: (v: unknown) => unknown, reject: (r: unknown) => unknown) =>
      Promise.resolve(val).then(resolve, reject),
  };
}

describe("user.auth.service — authenticateWithApple", () => {
  const originalAppleEnv = process.env.APPLE_CLIENT_IDS;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.APPLE_CLIENT_IDS;
    vi.mocked(User.findOne).mockImplementation(
      () => mockQueryReturn(null) as any,
    );
    vi.mocked(Config.findOne).mockResolvedValue({
      user_id: "user-1",
      themeColor: "default",
    } as any);
  });

  afterEach(() => {
    if (originalAppleEnv === undefined) {
      delete process.env.APPLE_CLIENT_IDS;
    } else {
      process.env.APPLE_CLIENT_IDS = originalAppleEnv;
    }
  });

  // 1. sub 命中既有 Apple 使用者
  it("authenticates existing Apple user by sub, returns session, calls createSession", async () => {
    vi.mocked(verifyAppleIdentityToken).mockResolvedValue({
      sub: "apple-sub-1",
      email: "user@example.com",
      emailVerified: true,
      isPrivateEmail: false,
    });

    const existingUser = {
      _id: "user-apple-1",
      name: "Apple User",
      email: "user@example.com",
      appleUserId: "apple-sub-1",
      authProviders: ["apple"],
      emailVerified: true,
      tokenVersion: 1,
    };
    vi.mocked(User.findOne).mockImplementation(
      () => mockQueryReturn(existingUser) as any,
    );

    const result = await authenticateWithApple({
      identityToken: "sample-token",
    });

    expect(result.user._id).toBe("user-apple-1");
    expect(User.findOne).toHaveBeenCalledWith({ appleUserId: "apple-sub-1" });
    expect(createSession).toHaveBeenCalled();
  });

  // 2. verifyAppleIdentityToken 被呼叫時帶預設 audience 與 rawNonce
  it("passes default audience and rawNonce to verifyAppleIdentityToken when APPLE_CLIENT_IDS is unset", async () => {
    vi.mocked(verifyAppleIdentityToken).mockResolvedValue({
      sub: "apple-sub-1",
      email: "user@example.com",
      emailVerified: true,
      isPrivateEmail: false,
    });

    const existingUser = {
      _id: "user-apple-1",
      name: "Apple User",
      email: "user@example.com",
      appleUserId: "apple-sub-1",
      authProviders: ["apple"],
    };
    vi.mocked(User.findOne).mockImplementation(
      () => mockQueryReturn(existingUser) as any,
    );

    await authenticateWithApple({
      identityToken: "sample-token",
      nonce: "raw-nonce",
    });

    expect(verifyAppleIdentityToken).toHaveBeenCalledWith("sample-token", {
      audience: ["com.accessiblemap.app"],
      rawNonce: "raw-nonce",
    });
  });

  // 3. adapter 拋 AppleIdentityTokenError → AuthError("INVALID_TOKEN")
  it("throws AuthError(INVALID_TOKEN) when adapter throws AppleIdentityTokenError and logs safe message", async () => {
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    vi.mocked(verifyAppleIdentityToken).mockRejectedValue(
      new AppleIdentityTokenError("Token invalid", {
        cause: { sensitive: "leak-me-sub-123" },
      }),
    );

    await expect(
      authenticateWithApple({ identityToken: "invalid-token" }),
    ).rejects.toMatchObject({ reason: "INVALID_TOKEN" });

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "[auth] Apple identity token 驗證失敗: token_rejected",
    );
    expect(consoleErrorSpy).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
    );
    consoleErrorSpy.mockRestore();
  });

  // 4. adapter 拋 TypeError → 原錯誤往上拋（不是 AuthError）
  it("rethrows unexpected error (e.g. TypeError) as original error", async () => {
    vi.mocked(verifyAppleIdentityToken).mockRejectedValue(
      new TypeError("fetch failed"),
    );

    await expect(
      authenticateWithApple({ identityToken: "any-token" }),
    ).rejects.toThrow(TypeError);
  });

  // 5. APPLE_CLIENT_IDS=" , " → 拋設定錯誤，且 adapter 未被呼叫
  it("throws configuration error when APPLE_CLIENT_IDS is empty/commas without invoking adapter", async () => {
    process.env.APPLE_CLIENT_IDS = " , ";

    await expect(
      authenticateWithApple({ identityToken: "any-token" }),
    ).rejects.toThrow(
      "APPLE_CLIENT_IDS is configured but contains no valid client ID",
    );
    expect(verifyAppleIdentityToken).not.toHaveBeenCalled();
  });

  // 6. sub 未命中、無 email → INVALID_TOKEN，且 User.create 未被呼叫
  it("throws AuthError(INVALID_TOKEN) when sub not found and no verified email is present", async () => {
    vi.mocked(verifyAppleIdentityToken).mockResolvedValue({
      sub: "apple-sub-new",
      emailVerified: false,
      isPrivateEmail: false,
    });

    await expect(
      authenticateWithApple({ identityToken: "token-without-email" }),
    ).rejects.toMatchObject({ reason: "INVALID_TOKEN" });
    expect(User.create).not.toHaveBeenCalled();
  });

  // 7. sub 未命中、emailVerified: false → INVALID_TOKEN
  it("throws AuthError(INVALID_TOKEN) when sub not found and emailVerified is false", async () => {
    vi.mocked(verifyAppleIdentityToken).mockResolvedValue({
      sub: "apple-sub-new",
      email: "unverified@example.com",
      emailVerified: false,
      isPrivateEmail: false,
    });

    await expect(
      authenticateWithApple({ identityToken: "token-unverified-email" }),
    ).rejects.toMatchObject({ reason: "INVALID_TOKEN" });
  });

  // 8. 已驗證的 Google 帳號同 email → 走 link，不覆蓋 client_id
  it("links Apple identity to existing verified Google account without overwriting client_id", async () => {
    vi.mocked(verifyAppleIdentityToken).mockResolvedValue({
      sub: "apple-sub-2",
      email: "user@example.com",
      emailVerified: true,
      isPrivateEmail: false,
    });

    const googleUser = {
      _id: "user-google-1",
      name: "Google User",
      email: "user@example.com",
      client_id: "google-sub-123",
      emailVerified: true,
      tokenVersion: 2,
      authProviders: ["google"],
    };

    vi.mocked(User.findOne).mockImplementation((query: any) => {
      if (query.appleUserId) return mockQueryReturn(null) as any;
      if (query.email) return mockQueryReturn(googleUser) as any;
      return mockQueryReturn(null) as any;
    });

    const linkedUser = {
      ...googleUser,
      appleUserId: "apple-sub-2",
      authProviders: ["google", "apple"],
    };
    vi.mocked(User.findOneAndUpdate).mockReturnValue({
      select: vi.fn().mockResolvedValue(linkedUser),
    } as any);

    const result = await authenticateWithApple({
      identityToken: "valid-token",
    });

    expect(result.user._id).toBe("user-google-1");
    expect(User.findOneAndUpdate).toHaveBeenCalledWith(
      {
        _id: "user-google-1",
        tokenVersion: 2,
        $or: [{ appleUserId: null }, { appleUserId: "apple-sub-2" }],
      },
      {
        $set: {
          appleUserId: "apple-sub-2",
          emailVerified: true,
        },
        $addToSet: { authProviders: "apple" },
      },
      expect.anything(),
    );

    const updateCalls = vi.mocked(User.findOneAndUpdate).mock.calls;
    const updateObj = updateCalls[0][1] as any;
    expect(updateObj.$set.client_id).toBeUndefined();
  });

  // 9. 未驗證 local 帳號 → takeover
  it("takes over unverified local account, unsets passwordHash, and revokes sessions", async () => {
    vi.mocked(verifyAppleIdentityToken).mockResolvedValue({
      sub: "apple-sub-3",
      email: "local@example.com",
      emailVerified: true,
      isPrivateEmail: false,
    });

    const localUser = {
      _id: "user-local-1",
      name: "Local User",
      email: "local@example.com",
      emailVerified: false,
      passwordHash: "some-password-hash",
      tokenVersion: 0,
      authProviders: ["local"],
    };

    vi.mocked(User.findOne).mockImplementation((query: any) => {
      if (query.appleUserId) return mockQueryReturn(null) as any;
      if (query.email) return mockQueryReturn(localUser) as any;
      return mockQueryReturn(null) as any;
    });

    const takenOverUser = {
      _id: "user-local-1",
      name: "Local User",
      email: "local@example.com",
      emailVerified: true,
      appleUserId: "apple-sub-3",
      tokenVersion: 1,
      authProviders: ["apple"],
    };
    vi.mocked(User.findOneAndUpdate).mockReturnValue({
      select: vi.fn().mockResolvedValue(takenOverUser),
    } as any);

    const result = await authenticateWithApple({
      identityToken: "valid-token",
    });

    expect(result.user._id).toBe("user-local-1");
    expect(User.findOneAndUpdate).toHaveBeenCalledWith(
      {
        _id: "user-local-1",
        tokenVersion: 0,
        emailVerified: false,
        passwordHash: "some-password-hash",
        appleUserId: null,
      },
      {
        $set: {
          appleUserId: "apple-sub-3",
          emailVerified: true,
          authProviders: ["apple"],
        },
        $unset: { passwordHash: "" },
        $inc: { tokenVersion: 1 },
      },
      expect.anything(),
    );
    expect(revokeAllSessionsByUserId).toHaveBeenCalledWith(
      "user-local-1",
      "apple_takeover",
    );
  });

  // 10. takeover CAS 落敗、重讀為已驗證 → 走 link、不撤銷 session
  it("falls back to link without revoking sessions when CAS loses and account verified concurrently", async () => {
    vi.mocked(verifyAppleIdentityToken).mockResolvedValue({
      sub: "apple-sub-4",
      email: "race@example.com",
      emailVerified: true,
      isPrivateEmail: false,
    });

    const unverifiedUser = {
      _id: "user-race-1",
      name: "Race User",
      email: "race@example.com",
      emailVerified: false,
      passwordHash: "old-hash",
      tokenVersion: 0,
      authProviders: ["local"],
    };

    const verifiedUser = {
      _id: "user-race-1",
      name: "Race User",
      email: "race@example.com",
      emailVerified: true,
      tokenVersion: 1,
      authProviders: ["local"],
    };

    let findCount = 0;
    vi.mocked(User.findOne).mockImplementation((query: any) => {
      if (query.appleUserId) return mockQueryReturn(null) as any;
      if (query.email) {
        findCount++;
        if (findCount === 1) return mockQueryReturn(unverifiedUser) as any;
        return mockQueryReturn(verifiedUser) as any;
      }
      return mockQueryReturn(null) as any;
    });

    // CAS loses first time (returns null), link succeeds second time
    const linkedUser = {
      ...verifiedUser,
      appleUserId: "apple-sub-4",
      authProviders: ["local", "apple"],
    };
    vi.mocked(User.findOneAndUpdate)
      .mockReturnValueOnce({ select: vi.fn().mockResolvedValue(null) } as any)
      .mockReturnValueOnce({
        select: vi.fn().mockResolvedValue(linkedUser),
      } as any);

    const result = await authenticateWithApple({
      identityToken: "valid-token",
    });

    expect(result.user._id).toBe("user-race-1");
    expect(revokeAllSessionsByUserId).not.toHaveBeenCalled();
  });

  // 11. byEmail.appleUserId 為其他 sub → AuthError("EMAIL_TAKEN")
  it("rejects with AuthError(EMAIL_TAKEN) when email account is already bound to another Apple ID", async () => {
    vi.mocked(verifyAppleIdentityToken).mockResolvedValue({
      sub: "apple-sub-new",
      email: "bound@example.com",
      emailVerified: true,
      isPrivateEmail: false,
    });

    const boundUser = {
      _id: "user-bound-1",
      name: "Bound User",
      email: "bound@example.com",
      appleUserId: "other-apple-sub",
      authProviders: ["apple"],
      emailVerified: true,
      tokenVersion: 1,
    };

    vi.mocked(User.findOne).mockImplementation((query: any) => {
      if (query.appleUserId) return mockQueryReturn(null) as any;
      if (query.email) return mockQueryReturn(boundUser) as any;
      return mockQueryReturn(null) as any;
    });

    await expect(
      authenticateWithApple({ identityToken: "valid-token" }),
    ).rejects.toMatchObject({ reason: "EMAIL_TAKEN" });

    expect(User.findOneAndUpdate).not.toHaveBeenCalled();
    expect(revokeAllSessionsByUserId).not.toHaveBeenCalled();
  });

  // 12. 新使用者、前端有 name: "  Jane  "
  it("creates new user with trimmed frontend name, appleUserId, and without client_id", async () => {
    vi.mocked(verifyAppleIdentityToken).mockResolvedValue({
      sub: "apple-sub-new-1",
      email: "jane@example.com",
      emailVerified: true,
      isPrivateEmail: false,
    });

    let insertedDoc: any;
    vi.mocked(User.create).mockImplementation(async (doc: any) => {
      insertedDoc = doc;
      return {
        ...doc,
        _id: "user-new-jane",
        toObject: () => ({ ...doc, _id: "user-new-jane" }),
      } as any;
    });

    const result = await authenticateWithApple({
      identityToken: "valid-token",
      name: "  Jane  ",
    });

    expect(result.user._id).toBe("user-new-jane");
    expect(insertedDoc.name).toBe("Jane");
    expect(insertedDoc.appleUserId).toBe("apple-sub-new-1");
    expect(insertedDoc.authProviders).toEqual(["apple"]);
    expect(insertedDoc.emailVerified).toBe(true);
    expect(insertedDoc.client_id).toBeUndefined();
  });

  // 13. 新使用者、name 為 ""／null、非 relay email jane@example.com → name 為 "jane"
  it("derives name from email prefix when name is empty or null and not a private relay address", async () => {
    vi.mocked(verifyAppleIdentityToken).mockResolvedValue({
      sub: "apple-sub-new-2",
      email: "jane.doe@example.com",
      emailVerified: true,
      isPrivateEmail: false,
    });

    let insertedDoc: any;
    vi.mocked(User.create).mockImplementation(async (doc: any) => {
      insertedDoc = doc;
      return {
        ...doc,
        _id: "user-new-jane-doe",
        toObject: () => ({ ...doc, _id: "user-new-jane-doe" }),
      } as any;
    });

    await authenticateWithApple({
      identityToken: "valid-token",
      name: "   ",
    });

    expect(insertedDoc.name).toBe("jane.doe");
  });

  // 14. 新使用者、relay email（is_private_email 為 true，或網域為 privaterelay.appleid.com）→ name 為 "Apple 使用者"
  it("uses fallback display name 'Apple 使用者' for private relay email", async () => {
    vi.mocked(verifyAppleIdentityToken).mockResolvedValue({
      sub: "apple-sub-new-3",
      email: "xyz@privaterelay.appleid.com",
      emailVerified: true,
      isPrivateEmail: true,
    });

    let insertedDoc: any;
    vi.mocked(User.create).mockImplementation(async (doc: any) => {
      insertedDoc = doc;
      return {
        ...doc,
        _id: "user-new-relay",
        toObject: () => ({ ...doc, _id: "user-new-relay" }),
      } as any;
    });

    await authenticateWithApple({
      identityToken: "valid-token",
      name: null,
    });

    expect(insertedDoc.name).toBe("Apple 使用者");
  });

  // 15. User.create 拋 { code: 11000 } → EMAIL_TAKEN
  it("translates MongoDB duplicate key error (11000) during insert to AuthError(EMAIL_TAKEN)", async () => {
    vi.mocked(verifyAppleIdentityToken).mockResolvedValue({
      sub: "apple-sub-dup",
      email: "dup@example.com",
      emailVerified: true,
      isPrivateEmail: false,
    });
    vi.mocked(User.create).mockRejectedValue({ code: 11000 });

    await expect(
      authenticateWithApple({ identityToken: "valid-token" }),
    ).rejects.toMatchObject({ reason: "EMAIL_TAKEN" });
  });

  describe("AppleAuthBodySchema validation", () => {
    it("accepts valid payload within 10240 character limit", () => {
      const res = AppleAuthBodySchema.safeParse({
        identityToken: "A".repeat(10240),
      });
      expect(res.success).toBe(true);
    });

    it("rejects identityToken exceeding 10240 characters", () => {
      const res = AppleAuthBodySchema.safeParse({
        identityToken: "A".repeat(10241),
      });
      expect(res.success).toBe(false);
    });
  });
});
