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
  processPasswordAssistance,
  requestPasswordReset,
  resetPassword,
} from "./user.auth.service";

function account(authProviders: Array<"google" | "local">) {
  return {
    _id: "user-1",
    name: "Jane",
    email: "jane@example.com",
    authProviders,
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
      { returnDocument: "after", maxTimeMS: 10_000 },
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
      { returnDocument: "after", maxTimeMS: 10_000 },
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
      { returnDocument: "after", maxTimeMS: 10_000 },
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
});
