import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../model/user.model", () => ({
  default: {
    findOne: vi.fn(),
    findById: vi.fn(),
    findOneAndUpdate: vi.fn(),
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

import User from "../../model/user.model";
import Config from "../../model/config.model";
import AuthToken from "../../model/auth-token.model";
import {
  sendGooglePasswordResetGuidanceEmail,
  sendPasswordResetEmail,
} from "../../adapters/email.adapter";
import {
  enqueuePasswordAssistance,
  getOrSetPasswordResetExpiry,
  renewPasswordAssistanceLease,
} from "./user.password-assistance.queue";
import {
  changePassword,
  logoutSession,
  processPasswordAssistance,
  refreshSession,
  requestPasswordReset,
  resetPassword,
} from "./user.auth.service";
import {
  createSession,
  revokeAllSessionsByUserId,
  revokeSession,
  rotateSession,
} from "./user.auth-session.repository";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { createRefreshToken } from "../../config/jwt";

import type { IUser } from "../../types";

function account(authProviders: Array<"google" | "local">) {
  return {
    _id: "user-1",
    name: "Jane",
    email: "jane@example.com",
    authProviders,
  };
}

function makeUser(overrides: Partial<IUser> = {}): IUser {
  return {
    _id: "665f1a2b3c4d5e6f7a8b9c0d",
    email: "jane@example.com",
    name: "Jane",
    emailVerified: true,
    authProviders: ["local"],
    tokenVersion: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  process.env.PASSWORD_RESET_TOKEN_SECRET =
    "test-secret-that-is-at-least-32-bytes-long";
  vi.mocked(getOrSetPasswordResetExpiry).mockResolvedValue(
    new Date("2030-01-01T01:00:00Z"),
  );
  vi.mocked(renewPasswordAssistanceLease).mockResolvedValue(true);
  vi.mocked(User.findOneAndUpdate).mockResolvedValue(account(["local"]) as any);
  vi.mocked(createSession).mockResolvedValue({
    _id: "665f1a2b3c4d5e6f7a8b9c0e",
    userId: "user-1",
    currentRefreshJti: "jti-test-1",
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  });
  vi.mocked(revokeAllSessionsByUserId).mockResolvedValue(1);
});

describe("requestPasswordReset", () => {
  it("normalizes and enqueues every syntactically valid address without an account lookup", async () => {
    await requestPasswordReset(" Nobody@Example.com ");

    expect(enqueuePasswordAssistance).toHaveBeenCalledWith(
      "nobody@example.com",
    );
    expect(User.findOne).not.toHaveBeenCalled();
  });

  it("propagates queue insertion failure so the controller can return 503", async () => {
    vi.mocked(enqueuePasswordAssistance).mockRejectedValue(
      new Error("queue down"),
    );

    await expect(requestPasswordReset("jane@example.com")).rejects.toThrow(
      "queue down",
    );
  });
});

describe("processPasswordAssistance", () => {
  it("does nothing for an unknown address", async () => {
    vi.mocked(User.findOne).mockResolvedValue(null);

    await processPasswordAssistance({
      email: " Nobody@Example.com ",
      jobId: "job-unknown",
      leaseToken: "lease-unknown",
    });

    expect(User.findOne).toHaveBeenCalledWith(
      { email: "nobody@example.com" },
      null,
      { maxTimeMS: 10_000 },
    );
    expect(AuthToken.findOneAndUpdate).not.toHaveBeenCalled();
    expect(sendPasswordResetEmail).not.toHaveBeenCalled();
    expect(sendGooglePasswordResetGuidanceEmail).not.toHaveBeenCalled();
  });

  it("atomically rotates the reset token and emails a local account", async () => {
    vi.mocked(User.findOne).mockResolvedValue(account(["local"]) as any);

    await processPasswordAssistance({
      email: "Jane@Example.com",
      jobId: "job-local",
      leaseToken: "lease-local",
    });

    expect(User.findOneAndUpdate).toHaveBeenCalledWith(
      {
        _id: "user-1",
        authProviders: "local",
        passwordResetTokens: {
          $not: {
            $elemMatch: { jobId: "job-local", consumedAt: { $exists: true } },
          },
        },
      },
      [
        {
          $set: {
            passwordResetTokens: expect.objectContaining({
              $concatArrays: expect.any(Array),
            }),
          },
        },
      ],
      { returnDocument: "after", maxTimeMS: 10_000, updatePipeline: true },
    );
    expect(sendPasswordResetEmail).toHaveBeenCalledWith({
      to: "jane@example.com",
      name: "Jane",
      token: expect.any(String),
      idempotencyKey: "password-assistance/job-local",
    });
    expect(sendGooglePasswordResetGuidanceEmail).not.toHaveBeenCalled();
  });

  it("does not recreate or resend a token when the same job is already consumed", async () => {
    vi.mocked(User.findOne).mockResolvedValue(account(["local"]) as any);
    vi.mocked(User.findOneAndUpdate).mockResolvedValue(null);

    await processPasswordAssistance({
      email: "jane@example.com",
      jobId: "consumed-job",
      leaseToken: "consumed-lease",
    });

    expect(sendPasswordResetEmail).not.toHaveBeenCalled();
  });

  it("reuses the same reset token and idempotency key when a job retries", async () => {
    vi.mocked(User.findOne).mockResolvedValue(account(["local"]) as any);

    const input = {
      email: "jane@example.com",
      jobId: "stable-job",
      leaseToken: "stable-lease",
    };
    await processPasswordAssistance(input);
    await processPasswordAssistance(input);

    const calls = vi.mocked(sendPasswordResetEmail).mock.calls;
    const rotations = vi.mocked(User.findOneAndUpdate).mock.calls;
    expect(calls).toHaveLength(2);
    expect(rotations).toHaveLength(2);
    const firstEntry = (rotations[0][1] as any)[0].$set.passwordResetTokens
      .$concatArrays[1][0];
    const secondEntry = (rotations[1][1] as any)[0].$set.passwordResetTokens
      .$concatArrays[1][0];
    expect(firstEntry.expiresAt).toEqual(new Date("2030-01-01T01:00:00Z"));
    expect(secondEntry.expiresAt).toEqual(firstEntry.expiresAt);
    expect(calls[0][0].token).toBe(calls[1][0].token);
    expect(calls[0][0].idempotencyKey).toBe("password-assistance/stable-job");
    expect(calls[1][0].idempotencyKey).toBe("password-assistance/stable-job");
  });

  it("keeps independently queued reset links stable until one is consumed", async () => {
    vi.mocked(User.findOne).mockResolvedValue(account(["local"]) as any);

    await processPasswordAssistance({
      email: "jane@example.com",
      jobId: "job-new",
      leaseToken: "lease-new",
    });
    await processPasswordAssistance({
      email: "jane@example.com",
      jobId: "job-old",
      leaseToken: "lease-old",
    });

    expect(sendPasswordResetEmail).toHaveBeenCalledTimes(2);
    expect(
      vi
        .mocked(sendPasswordResetEmail)
        .mock.calls.map(([input]) => input.idempotencyKey),
    ).toEqual(["password-assistance/job-new", "password-assistance/job-old"]);
  });

  it("sends guidance without issuing a token for a Google-only account", async () => {
    vi.mocked(User.findOne).mockResolvedValue(account(["google"]) as any);

    await processPasswordAssistance({
      email: "jane@example.com",
      jobId: "job-google",
      leaseToken: "lease-google",
    });

    expect(AuthToken.findOneAndUpdate).not.toHaveBeenCalled();
    expect(sendPasswordResetEmail).not.toHaveBeenCalled();
    expect(sendGooglePasswordResetGuidanceEmail).toHaveBeenCalledWith({
      to: "jane@example.com",
      name: "Jane",
      idempotencyKey: "password-assistance/job-google",
    });
  });

  it("uses the local reset flow when Google and local providers coexist", async () => {
    vi.mocked(User.findOne).mockResolvedValue(
      account(["google", "local"]) as any,
    );

    await processPasswordAssistance({
      email: "jane@example.com",
      jobId: "job-hybrid",
      leaseToken: "lease-hybrid",
    });

    expect(User.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ _id: "user-1", authProviders: "local" }),
      expect.any(Object),
      expect.objectContaining({ returnDocument: "after" }),
    );
    expect(sendPasswordResetEmail).toHaveBeenCalledTimes(1);
    expect(sendGooglePasswordResetGuidanceEmail).not.toHaveBeenCalled();
  });
});

describe("resetPassword", () => {
  it("consumes the token and updates the password in one atomic user update", async () => {
    const updatedUser = {
      ...account(["google", "local"]),
      emailVerified: true,
      tokenVersion: 3,
    };
    vi.mocked(User.findOneAndUpdate).mockResolvedValue(updatedUser as any);
    vi.mocked(Config.findOne).mockResolvedValue({ user_id: "user-1" } as any);

    const result = await resetPassword({
      token: "valid-token",
      password: "taipei2027",
    });

    expect(User.findOneAndUpdate).toHaveBeenCalledWith(
      {
        passwordResetTokens: {
          $elemMatch: {
            tokenHash: expect.any(String),
            expiresAt: { $gt: expect.any(Date) },
            consumedAt: { $exists: false },
          },
        },
        authProviders: "local",
      },
      [
        {
          $set: {
            passwordHash: { $literal: expect.any(String) },
            emailVerified: true,
            tokenVersion: { $add: [{ $ifNull: ["$tokenVersion", 0] }, 1] },
            passwordResetTokens: {
              $map: {
                input: { $ifNull: ["$passwordResetTokens", []] },
                as: "token",
                in: {
                  $cond: [
                    { $eq: ["$$token.tokenHash", expect.any(String)] },
                    {
                      $mergeObjects: [
                        "$$token",
                        { consumedAt: expect.any(Date) },
                      ],
                    },
                    "$$token",
                  ],
                },
              },
            },
          },
        },
      ],
      { returnDocument: "after", maxTimeMS: 10_000, updatePipeline: true },
    );
    expect(AuthToken.findOneAndDelete).not.toHaveBeenCalled();
    expect(result.user.authProviders).toEqual(["google", "local"]);
    expect(result.user.tokenVersion).toBe(3);
  });

  it("allows only one of two concurrent calls to consume the same embedded token", async () => {
    const updatedUser = { ...account(["local"]), tokenVersion: 1 };
    vi.mocked(User.findOneAndUpdate)
      .mockResolvedValueOnce(updatedUser as any)
      .mockResolvedValueOnce(null);
    vi.mocked(Config.findOne).mockResolvedValue(null);

    const results = await Promise.allSettled([
      resetPassword({ token: "same-token", password: "taipei2027" }),
      resetPassword({ token: "same-token", password: "taipei2028" }),
    ]);

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    expect(User.findOneAndUpdate).toHaveBeenCalledTimes(2);
    expect(AuthToken.findOneAndDelete).not.toHaveBeenCalled();
  });

  it("rejects without separately consuming the token when the atomic update fails", async () => {
    vi.mocked(User.findOneAndUpdate).mockResolvedValue(null);

    await expect(
      resetPassword({ token: "racing-token", password: "taipei2027" }),
    ).rejects.toMatchObject({ reason: "INVALID_TOKEN" });

    expect(User.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ authProviders: "local" }),
      expect.any(Array),
      { returnDocument: "after", maxTimeMS: 10_000, updatePipeline: true },
    );
    expect(AuthToken.findOneAndDelete).not.toHaveBeenCalled();
  });

  it("rejects legacy cross-collection reset tokens after migration", async () => {
    vi.mocked(User.findOneAndUpdate).mockResolvedValue(null);

    await expect(
      resetPassword({ token: "legacy-token", password: "taipei2027" }),
    ).rejects.toMatchObject({ reason: "INVALID_TOKEN" });

    expect(AuthToken.findOneAndDelete).not.toHaveBeenCalled();
  });

  it("revokes old sessions before creating new session on successful password reset", async () => {
    const updatedUser = {
      ...account(["local"]),
      emailVerified: true,
      tokenVersion: 2,
    };
    vi.mocked(User.findOneAndUpdate).mockResolvedValue(updatedUser as any);
    vi.mocked(Config.findOne).mockResolvedValue(null);

    const result = await resetPassword({
      token: "valid-token",
      password: "taipei2027",
    });

    expect(revokeAllSessionsByUserId).toHaveBeenCalledWith(
      "user-1",
      "password_reset",
    );
    expect(createSession).toHaveBeenCalledWith({
      userId: "user-1",
      currentRefreshJti: expect.any(String),
      expiresAt: expect.any(Date),
    });
    expect(result.accessToken).toBeDefined();
    expect(result.refreshToken).toBeDefined();
  });

  it("fails and does not issue tokens when session revocation throws", async () => {
    const updatedUser = {
      ...account(["local"]),
      emailVerified: true,
      tokenVersion: 2,
    };
    vi.mocked(User.findOneAndUpdate).mockResolvedValue(updatedUser as any);
    vi.mocked(revokeAllSessionsByUserId).mockRejectedValueOnce(
      new Error("MongoDB connection timeout"),
    );

    await expect(
      resetPassword({ token: "valid-token", password: "taipei2027" }),
    ).rejects.toThrow("MongoDB connection timeout");

    expect(createSession).not.toHaveBeenCalled();
  });
});

describe("changePassword", () => {
  it("rejects without updating or revoking when current password is wrong", async () => {
    const passwordHash = await bcrypt.hash("current-pass-123", 10);
    vi.mocked(User.findById).mockReturnValue({
      select: vi.fn().mockResolvedValue({
        ...account(["local"]),
        passwordHash,
        tokenVersion: 1,
      }),
    } as any);

    await expect(
      changePassword({
        userId: "user-1",
        currentPassword: "wrong-password",
        newPassword: "taipei2028",
      }),
    ).rejects.toMatchObject({ reason: "INVALID_CREDENTIALS" });

    expect(User.findOneAndUpdate).not.toHaveBeenCalled();
    expect(revokeAllSessionsByUserId).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
  });

  it("rejects when atomic CAS loses (concurrent changePassword/reset)", async () => {
    const passwordHash = await bcrypt.hash("current-pass-123", 10);
    vi.mocked(User.findById).mockReturnValue({
      select: vi.fn().mockResolvedValue({
        ...account(["local"]),
        passwordHash,
        tokenVersion: 1,
      }),
    } as any);

    // Atomic CAS returns null (loser)
    vi.mocked(User.findOneAndUpdate).mockReturnValue({
      select: vi.fn().mockResolvedValue(null),
    } as any);

    await expect(
      changePassword({
        userId: "user-1",
        currentPassword: "current-pass-123",
        newPassword: "taipei2028",
      }),
    ).rejects.toMatchObject({ reason: "INVALID_CREDENTIALS" });

    // Loser MUST NOT revoke old sessions or create new session!
    expect(revokeAllSessionsByUserId).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
  });

  it("succeeds on CAS match: revokes old sessions, creates new session and returns tokens", async () => {
    const passwordHash = await bcrypt.hash("current-pass-123", 10);
    vi.mocked(User.findById).mockReturnValue({
      select: vi.fn().mockResolvedValue({
        ...account(["local"]),
        passwordHash,
        tokenVersion: 1,
      }),
    } as any);

    const updatedUser = {
      ...account(["local"]),
      passwordHash: "new-hash",
      tokenVersion: 2,
    };
    vi.mocked(User.findOneAndUpdate).mockReturnValue({
      select: vi.fn().mockResolvedValue(updatedUser),
    } as any);

    const result = await changePassword({
      userId: "user-1",
      currentPassword: "current-pass-123",
      newPassword: "taipei2028",
    });

    expect(revokeAllSessionsByUserId).toHaveBeenCalledWith(
      "user-1",
      "password_changed",
    );
    expect(createSession).toHaveBeenCalledWith({
      userId: "user-1",
      currentRefreshJti: expect.any(String),
      expiresAt: expect.any(Date),
    });
    expect(result.user).toBeDefined();
    expect(result.accessToken).toBeDefined();
    expect(result.refreshToken).toBeDefined();
  });
});

describe("refreshSession", () => {
  it("rejects an invalid refresh token string without DB operations", async () => {
    const result = await refreshSession("invalid.token.string");
    expect(result).toEqual({ ok: false, reason: "INVALID_TOKEN" });
    expect(rotateSession).not.toHaveBeenCalled();
  });

  it("rejects a legacy sid-less refresh token", async () => {
    // Refresh token with no sid claim
    const legacyToken = jwt.sign(
      {
        user: {
          _id: "665f1a2b3c4d5e6f7a8b9c0d",
          email: "jane@example.com",
          name: "Jane",
          emailVerified: true,
          authProviders: ["local"],
          tokenVersion: 0,
        },
        jti: crypto.randomUUID(),
      },
      process.env.JWT_REFRESH_SECRET ?? "test-refresh-secret",
    );

    const result = await refreshSession(legacyToken);
    expect(result).toEqual({ ok: false, reason: "INVALID_TOKEN" });
    expect(rotateSession).not.toHaveBeenCalled();
  });

  it("rejects a refresh token with malformed sid (not 24-hex ObjectId) without DB operations", async () => {
    const malformedToken = jwt.sign(
      {
        user: {
          _id: "665f1a2b3c4d5e6f7a8b9c0d",
          email: "jane@example.com",
          name: "Jane",
          emailVerified: true,
          authProviders: ["local"],
          tokenVersion: 0,
        },
        sid: "invalid-non-hex-sid",
        jti: crypto.randomUUID(),
      },
      process.env.JWT_REFRESH_SECRET ?? "test-refresh-secret",
    );

    const result = await refreshSession(malformedToken);
    expect(result).toEqual({ ok: false, reason: "INVALID_TOKEN" });
    expect(rotateSession).not.toHaveBeenCalled();
    expect(User.findById).not.toHaveBeenCalled();
  });

  it("rejects a refresh token with malformed jti (not UUID) without DB operations", async () => {
    const malformedToken = jwt.sign(
      {
        user: {
          _id: "665f1a2b3c4d5e6f7a8b9c0d",
          email: "jane@example.com",
          name: "Jane",
          emailVerified: true,
          authProviders: ["local"],
          tokenVersion: 0,
        },
        sid: "665f1a2b3c4d5e6f7a8b9c0e",
        jti: "not-a-valid-uuid",
      },
      process.env.JWT_REFRESH_SECRET ?? "test-refresh-secret",
    );

    const result = await refreshSession(malformedToken);
    expect(result).toEqual({ ok: false, reason: "INVALID_TOKEN" });
    expect(rotateSession).not.toHaveBeenCalled();
    expect(User.findById).not.toHaveBeenCalled();
  });

  it("rejects when tokenVersion is mismatched (revoked)", async () => {
    const userDoc = {
      ...account(["local"]),
      _id: "665f1a2b3c4d5e6f7a8b9c0d",
      tokenVersion: 5,
    };
    vi.mocked(User.findById).mockResolvedValue(userDoc as any);

    const token = createRefreshToken(
      makeUser({ tokenVersion: 4 }), // Stale tokenVersion
      "665f1a2b3c4d5e6f7a8b9c0e",
      crypto.randomUUID(),
    );

    const result = await refreshSession(token);
    expect(result).toEqual({ ok: false, reason: "REVOKED" });
    expect(rotateSession).not.toHaveBeenCalled();
  });

  it("rotates session and returns new tokens on CAS success", async () => {
    const userDoc = {
      ...account(["local"]),
      _id: "665f1a2b3c4d5e6f7a8b9c0d",
      tokenVersion: 0,
    };
    vi.mocked(User.findById).mockResolvedValue(userDoc as any);
    const newJti = crypto.randomUUID();
    vi.mocked(rotateSession).mockResolvedValue({
      status: "SUCCESS",
      session: {
        _id: "665f1a2b3c4d5e6f7a8b9c0e",
        userId: "665f1a2b3c4d5e6f7a8b9c0d",
        currentRefreshJti: newJti,
        expiresAt: new Date(Date.now() + 86400000),
      },
    });

    const oldJti = crypto.randomUUID();
    const token = createRefreshToken(
      makeUser(),
      "665f1a2b3c4d5e6f7a8b9c0e",
      oldJti,
    );

    const result = await refreshSession(token);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.accessToken).toBeDefined();
      expect(result.refreshToken).toBeDefined();
      expect(result.user._id).toBe("665f1a2b3c4d5e6f7a8b9c0d");
    }
  });

  it("returns GRACE_PERIOD when CAS loses during rapid concurrency", async () => {
    const userDoc = {
      ...account(["local"]),
      _id: "665f1a2b3c4d5e6f7a8b9c0d",
      tokenVersion: 0,
    };
    vi.mocked(User.findById).mockResolvedValue(userDoc as any);
    vi.mocked(rotateSession).mockResolvedValue({
      status: "GRACE_PERIOD",
      session: {
        _id: "665f1a2b3c4d5e6f7a8b9c0e",
        userId: "665f1a2b3c4d5e6f7a8b9c0d",
        currentRefreshJti: crypto.randomUUID(),
        expiresAt: new Date(Date.now() + 86400000),
      },
    });

    const token = createRefreshToken(
      makeUser(),
      "665f1a2b3c4d5e6f7a8b9c0e",
      crypto.randomUUID(),
    );

    const result = await refreshSession(token);
    expect(result).toEqual({ ok: false, reason: "GRACE_PERIOD" });
  });

  it("returns REUSE_DETECTED when stale token replay is detected", async () => {
    const userDoc = {
      ...account(["local"]),
      _id: "665f1a2b3c4d5e6f7a8b9c0d",
      tokenVersion: 0,
    };
    vi.mocked(User.findById).mockResolvedValue(userDoc as any);
    vi.mocked(rotateSession).mockResolvedValue({
      status: "REUSE_DETECTED",
      session: {
        _id: "665f1a2b3c4d5e6f7a8b9c0e",
        userId: "665f1a2b3c4d5e6f7a8b9c0d",
        currentRefreshJti: crypto.randomUUID(),
        expiresAt: new Date(Date.now() + 86400000),
        revokedAt: new Date(),
        revokedReason: "token_reuse_detected",
      },
    });

    const token = createRefreshToken(
      makeUser(),
      "665f1a2b3c4d5e6f7a8b9c0e",
      crypto.randomUUID(),
    );

    const result = await refreshSession(token);
    expect(result).toEqual({ ok: false, reason: "REUSE_DETECTED" });
  });
});

describe("logoutSession", () => {
  it("returns true idempotently for invalid/expired token without DB write", async () => {
    const result = await logoutSession("invalid-token");
    expect(result).toBe(true);
    expect(revokeSession).not.toHaveBeenCalled();
  });

  it("returns true idempotently for malformed sid without DB write", async () => {
    const malformedToken = jwt.sign(
      {
        user: { _id: "665f1a2b3c4d5e6f7a8b9c0d" },
        sid: "malformed-sid",
      },
      process.env.JWT_REFRESH_SECRET ?? "test-refresh-secret",
    );
    const result = await logoutSession(malformedToken);
    expect(result).toBe(true);
    expect(revokeSession).not.toHaveBeenCalled();
  });

  it("revokes session for a valid refresh token", async () => {
    const token = createRefreshToken(
      makeUser(),
      "665f1a2b3c4d5e6f7a8b9c0e",
      crypto.randomUUID(),
    );

    vi.mocked(revokeSession).mockResolvedValue(true);

    const result = await logoutSession(token);
    expect(result).toBe(true);
    expect(revokeSession).toHaveBeenCalledWith(
      "665f1a2b3c4d5e6f7a8b9c0e",
      "665f1a2b3c4d5e6f7a8b9c0d",
      "user_logout",
    );
  });

  it("propagates DB failure when revokeSession throws", async () => {
    const token = createRefreshToken(
      makeUser(),
      "665f1a2b3c4d5e6f7a8b9c0e",
      crypto.randomUUID(),
    );

    vi.mocked(revokeSession).mockRejectedValueOnce(
      new Error("Mongo network error"),
    );

    await expect(logoutSession(token)).rejects.toThrow("Mongo network error");
  });
});
