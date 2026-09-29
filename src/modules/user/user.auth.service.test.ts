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
  AuthError,
  authenticateWithGoogle,
  changePassword,
  getGoogleAudiences,
  loginLocalUser,
  logoutSession,
  processPasswordAssistance,
  refreshSession,
  requestPasswordReset,
  resetPassword,
  verifyEmail,
} from "./user.auth.service";
import {
  createSession,
  revokeAllSessionsByUserId,
  revokeSession,
  rotateSession,
} from "./user.auth-session.repository";
import { OAuth2Client } from "google-auth-library";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { REFRESH_TOKEN_TTL_MS, createRefreshToken } from "../../config/jwt";

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

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.resetAllMocks();
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, ORIGINAL_ENV);
  process.env.PASSWORD_RESET_TOKEN_SECRET =
    "test-secret-that-is-at-least-32-bytes-long";
  process.env.JWT_ACCESS_SECRET = "test-jwt-access-secret";
  process.env.JWT_REFRESH_SECRET = "test-jwt-refresh-secret";
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

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, ORIGINAL_ENV);
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

describe("getGoogleAudiences", () => {
  it("parses comma-separated values, trims whitespace, and deduplicates in GOOGLE_CLIENT_IDS", () => {
    process.env.GOOGLE_CLIENT_IDS =
      "  aud-web , aud-mobile , aud-web , , aud-tablet  ";
    delete process.env.GOOGLE_CLIENT_ID;

    expect(getGoogleAudiences()).toEqual([
      "aud-web",
      "aud-mobile",
      "aud-tablet",
    ]);
  });

  it("prioritizes GOOGLE_CLIENT_IDS exclusively over GOOGLE_CLIENT_ID without merging", () => {
    process.env.GOOGLE_CLIENT_IDS = "aud-new-1, aud-new-2";
    process.env.GOOGLE_CLIENT_ID = "aud-legacy";

    expect(getGoogleAudiences()).toEqual(["aud-new-1", "aud-new-2"]);
  });

  it("falls back to trimmed GOOGLE_CLIENT_ID when GOOGLE_CLIENT_IDS is undefined", () => {
    delete process.env.GOOGLE_CLIENT_IDS;
    process.env.GOOGLE_CLIENT_ID = "  aud-legacy  ";

    expect(getGoogleAudiences()).toEqual(["aud-legacy"]);
  });

  it("fails closed when GOOGLE_CLIENT_IDS is defined but empty or only whitespace/commas, and never falls back to legacy", () => {
    process.env.GOOGLE_CLIENT_IDS = "  ,  ,  ";
    process.env.GOOGLE_CLIENT_ID = "aud-legacy";

    expect(() => getGoogleAudiences()).toThrow(
      "GOOGLE_CLIENT_IDS is configured but contains no valid client ID",
    );
  });

  it("fails closed when GOOGLE_CLIENT_IDS is undefined and GOOGLE_CLIENT_ID is undefined or only whitespace", () => {
    delete process.env.GOOGLE_CLIENT_IDS;
    process.env.GOOGLE_CLIENT_ID = "    ";

    expect(() => getGoogleAudiences()).toThrow(
      "GOOGLE_CLIENT_ID is not configured",
    );

    delete process.env.GOOGLE_CLIENT_ID;
    expect(() => getGoogleAudiences()).toThrow(
      "GOOGLE_CLIENT_ID is not configured",
    );
  });
});

describe("authenticateWithGoogle", () => {
  let verifyIdTokenSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  const mockPayload = {
    sub: "google-sub-12345",
    email: "jane@example.com",
    email_verified: true,
    name: "Jane Doe",
    picture: "https://example.com/avatar.jpg",
  };

  const existingGoogleUser = {
    _id: "665f1a2b3c4d5e6f7a8b9c0d",
    client_id: "google-sub-12345",
    email: "jane@example.com",
    name: "Jane Doe",
    emailVerified: true,
    authProviders: ["google"],
    tokenVersion: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  beforeEach(() => {
    verifyIdTokenSpy = vi.spyOn(OAuth2Client.prototype, "verifyIdToken");
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(Config.findOne).mockResolvedValue({
      user_id: existingGoogleUser._id,
      wheelChair: false,
    } as any);
  });

  afterEach(() => {
    verifyIdTokenSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it("passes parsed and deduplicated audiences array to verifyIdToken when GOOGLE_CLIENT_IDS is set", async () => {
    process.env.GOOGLE_CLIENT_IDS =
      "web-client-id, mobile-client-id, web-client-id";
    delete process.env.GOOGLE_CLIENT_ID;

    verifyIdTokenSpy.mockResolvedValue({
      getPayload: () => mockPayload,
    } as any);
    vi.mocked(User.findOne).mockResolvedValue(existingGoogleUser as any);

    const result = await authenticateWithGoogle("valid-token-1");

    expect(verifyIdTokenSpy).toHaveBeenCalledTimes(1);
    expect(verifyIdTokenSpy).toHaveBeenCalledWith({
      idToken: "valid-token-1",
      audience: ["web-client-id", "mobile-client-id"],
    });
    expect(result.user.email).toBe("jane@example.com");
    expect(result.accessToken).toBeTruthy();
    expect(result.refreshToken).toBeTruthy();
  });

  it("trims whitespace and ignores empty entries in GOOGLE_CLIENT_IDS", async () => {
    process.env.GOOGLE_CLIENT_IDS = "  client-1 ,  client-2 , , client-1  ,  ";
    delete process.env.GOOGLE_CLIENT_ID;

    verifyIdTokenSpy.mockResolvedValue({
      getPayload: () => mockPayload,
    } as any);
    vi.mocked(User.findOne).mockResolvedValue(existingGoogleUser as any);

    await authenticateWithGoogle("token-trim-test");

    expect(verifyIdTokenSpy).toHaveBeenCalledWith({
      idToken: "token-trim-test",
      audience: ["client-1", "client-2"],
    });
  });

  it("gives GOOGLE_CLIENT_IDS exclusive precedence over GOOGLE_CLIENT_ID without merging", async () => {
    process.env.GOOGLE_CLIENT_IDS = "new-audience-a, new-audience-b";
    process.env.GOOGLE_CLIENT_ID = "legacy-audience-should-be-ignored";

    verifyIdTokenSpy.mockResolvedValue({
      getPayload: () => mockPayload,
    } as any);
    vi.mocked(User.findOne).mockResolvedValue(existingGoogleUser as any);

    await authenticateWithGoogle("token-precedence-test");

    expect(verifyIdTokenSpy).toHaveBeenCalledWith({
      idToken: "token-precedence-test",
      audience: ["new-audience-a", "new-audience-b"],
    });
  });

  it("falls back to trimmed single GOOGLE_CLIENT_ID only when GOOGLE_CLIENT_IDS is undefined", async () => {
    delete process.env.GOOGLE_CLIENT_IDS;
    process.env.GOOGLE_CLIENT_ID = "  legacy-single-client-id  ";

    verifyIdTokenSpy.mockResolvedValue({
      getPayload: () => mockPayload,
    } as any);
    vi.mocked(User.findOne).mockResolvedValue(existingGoogleUser as any);

    await authenticateWithGoogle("token-legacy-test");

    expect(verifyIdTokenSpy).toHaveBeenCalledWith({
      idToken: "token-legacy-test",
      audience: ["legacy-single-client-id"],
    });
  });

  it("fails closed when GOOGLE_CLIENT_IDS is set but empty or contains only whitespace, and does NOT fallback to legacy", async () => {
    process.env.GOOGLE_CLIENT_IDS = "   ,   ";
    process.env.GOOGLE_CLIENT_ID = "legacy-single-client-id";

    await expect(authenticateWithGoogle("token-empty-ids")).rejects.toThrow(
      "GOOGLE_CLIENT_IDS is configured but contains no valid client ID",
    );
    expect(verifyIdTokenSpy).not.toHaveBeenCalled();
    expect(User.findOne).not.toHaveBeenCalled();
    expect(Config.findOne).not.toHaveBeenCalled();
    expect(Config.create).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
  });

  it("fails closed when GOOGLE_CLIENT_IDS is unset and GOOGLE_CLIENT_ID is unset or whitespace", async () => {
    delete process.env.GOOGLE_CLIENT_IDS;
    process.env.GOOGLE_CLIENT_ID = "   ";

    await expect(
      authenticateWithGoogle("token-missing-config"),
    ).rejects.toThrow("GOOGLE_CLIENT_ID is not configured");
    expect(verifyIdTokenSpy).not.toHaveBeenCalled();
    expect(User.findOne).not.toHaveBeenCalled();
    expect(Config.findOne).not.toHaveBeenCalled();
    expect(Config.create).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
  });

  it("fails closed when both GOOGLE_CLIENT_IDS and GOOGLE_CLIENT_ID are undefined", async () => {
    delete process.env.GOOGLE_CLIENT_IDS;
    delete process.env.GOOGLE_CLIENT_ID;

    await expect(authenticateWithGoogle("token-no-env")).rejects.toThrow(
      "GOOGLE_CLIENT_ID is not configured",
    );
    expect(verifyIdTokenSpy).not.toHaveBeenCalled();
    expect(User.findOne).not.toHaveBeenCalled();
    expect(Config.findOne).not.toHaveBeenCalled();
    expect(Config.create).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
  });

  it("rejects unallowed audience at verifier stage with AuthError(INVALID_TOKEN) without calling User.findOne, config writes, or createSession", async () => {
    process.env.GOOGLE_CLIENT_IDS = "allowed-audience-1, allowed-audience-2";

    verifyIdTokenSpy.mockRejectedValue(
      new Error("Wrong recipient, payload audience != requiredAudience"),
    );

    await expect(authenticateWithGoogle("token-unallowed-aud")).rejects.toThrow(
      AuthError,
    );
    await expect(authenticateWithGoogle("token-unallowed-aud")).rejects.toThrow(
      "INVALID_TOKEN",
    );

    expect(verifyIdTokenSpy).toHaveBeenCalledWith({
      idToken: "token-unallowed-aud",
      audience: ["allowed-audience-1", "allowed-audience-2"],
    });

    // Verify zero side-effects before rejection
    expect(User.findOne).not.toHaveBeenCalled();
    expect(Config.findOne).not.toHaveBeenCalled();
    expect(Config.create).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
  });

  it("resolves the same existing user account via sub lookup regardless of which allowed audience issued the token", async () => {
    process.env.GOOGLE_CLIENT_IDS = "web-client-id, mobile-client-id";

    // Simulate tokens from different audiences, both carrying the same verified sub
    const tokenFromWeb = "token-from-web-client";
    const tokenFromMobile = "token-from-mobile-client";

    verifyIdTokenSpy.mockImplementation(
      async ({ idToken }: { idToken?: string }) => {
        if (idToken === tokenFromWeb) {
          return {
            getPayload: () => ({
              ...mockPayload,
              aud: "web-client-id",
            }),
          } as any;
        }
        if (idToken === tokenFromMobile) {
          return {
            getPayload: () => ({
              ...mockPayload,
              aud: "mobile-client-id",
            }),
          } as any;
        }
        throw new Error("Unexpected token");
      },
    );

    vi.mocked(User.findOne).mockResolvedValue(existingGoogleUser as any);

    // Call 1: from Web audience
    const result1 = await authenticateWithGoogle(tokenFromWeb);
    expect(result1.user._id).toBe(existingGoogleUser._id);
    expect(User.findOne).toHaveBeenCalledWith({
      client_id: mockPayload.sub,
    });

    // Call 2: from Mobile audience
    const result2 = await authenticateWithGoogle(tokenFromMobile);
    expect(result2.user._id).toBe(existingGoogleUser._id);
    expect(User.findOne).toHaveBeenCalledWith({
      client_id: mockPayload.sub,
    });

    // Verifier was invoked with the full allowlist for both tokens
    expect(verifyIdTokenSpy).toHaveBeenNthCalledWith(1, {
      idToken: tokenFromWeb,
      audience: ["web-client-id", "mobile-client-id"],
    });
    expect(verifyIdTokenSpy).toHaveBeenNthCalledWith(2, {
      idToken: tokenFromMobile,
      audience: ["web-client-id", "mobile-client-id"],
    });
  });
});

describe("session expiry follows REFRESH_TOKEN_TTL_MS", () => {
  function expectRefreshTtl(expiresAt: Date, before: number) {
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(
      before + REFRESH_TOKEN_TTL_MS,
    );
    expect(expiresAt.getTime()).toBeLessThanOrEqual(
      Date.now() + REFRESH_TOKEN_TTL_MS,
    );
  }

  function createdExpiry(): Date {
    return vi.mocked(createSession).mock.calls[0][0].expiresAt;
  }

  it("loginLocalUser", async () => {
    const passwordHash = await bcrypt.hash("taipei2027", 4);
    vi.mocked(User.findOne).mockReturnValue({
      select: vi.fn().mockResolvedValue({ ...makeUser(), passwordHash }),
    } as any);
    vi.mocked(Config.findOne).mockResolvedValue(null);

    const before = Date.now();
    await loginLocalUser({ email: "jane@example.com", password: "taipei2027" });

    expectRefreshTtl(createdExpiry(), before);
  });

  it("verifyEmail", async () => {
    vi.mocked(AuthToken.findOneAndDelete).mockResolvedValue({
      userId: "665f1a2b3c4d5e6f7a8b9c0d",
    } as any);
    vi.mocked(User.findById).mockResolvedValue(
      makeUser({ emailVerified: false }) as any,
    );
    vi.mocked(User.findOneAndUpdate).mockReturnValue({
      select: vi.fn().mockResolvedValue(makeUser()),
    } as any);
    vi.mocked(Config.findOne).mockResolvedValue(null);

    const before = Date.now();
    await verifyEmail("raw-token");

    expectRefreshTtl(createdExpiry(), before);
  });

  it("resetPassword", async () => {
    vi.mocked(User.findOneAndUpdate).mockResolvedValue(makeUser() as any);
    vi.mocked(Config.findOne).mockResolvedValue(null);

    const before = Date.now();
    await resetPassword({ token: "valid-token", password: "taipei2027" });

    expectRefreshTtl(createdExpiry(), before);
  });

  it("changePassword", async () => {
    const passwordHash = await bcrypt.hash("current-pass-123", 4);
    vi.mocked(User.findById).mockReturnValue({
      select: vi.fn().mockResolvedValue({ ...makeUser(), passwordHash }),
    } as any);
    vi.mocked(User.findOneAndUpdate).mockReturnValue({
      select: vi.fn().mockResolvedValue(makeUser({ tokenVersion: 1 })),
    } as any);

    const before = Date.now();
    await changePassword({
      userId: "665f1a2b3c4d5e6f7a8b9c0d",
      currentPassword: "current-pass-123",
      newPassword: "taipei2028",
    });

    expectRefreshTtl(createdExpiry(), before);
  });

  it("authenticateWithGoogle", async () => {
    process.env.GOOGLE_CLIENT_IDS = "web-client-id";
    const verifyIdTokenSpy = vi
      .spyOn(OAuth2Client.prototype, "verifyIdToken")
      .mockResolvedValue({
        getPayload: () => ({
          sub: "google-sub-12345",
          email: "jane@example.com",
          email_verified: true,
          name: "Jane",
        }),
      } as any);
    vi.mocked(User.findOne).mockResolvedValue(
      makeUser({
        client_id: "google-sub-12345",
        authProviders: ["google"],
      } as any) as any,
    );
    vi.mocked(Config.findOne).mockResolvedValue(null);

    try {
      const before = Date.now();
      await authenticateWithGoogle("google-id-token");

      expectRefreshTtl(createdExpiry(), before);
    } finally {
      verifyIdTokenSpy.mockRestore();
    }
  });

  it("refreshSession", async () => {
    vi.mocked(User.findById).mockResolvedValue(makeUser() as any);
    vi.mocked(rotateSession).mockResolvedValue({
      status: "SUCCESS",
      session: {
        _id: "665f1a2b3c4d5e6f7a8b9c0e",
        userId: "665f1a2b3c4d5e6f7a8b9c0d",
        currentRefreshJti: crypto.randomUUID(),
        expiresAt: new Date(),
      },
    } as any);
    const token = createRefreshToken(
      makeUser(),
      "665f1a2b3c4d5e6f7a8b9c0e",
      crypto.randomUUID(),
    );

    const before = Date.now();
    const result = await refreshSession(token);

    expect(result.ok).toBe(true);
    expectRefreshTtl(
      vi.mocked(rotateSession).mock.calls[0][0].newExpiresAt,
      before,
    );
  });
});
