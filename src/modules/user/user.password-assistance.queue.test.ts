import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../model/password-assistance-job.model", () => ({
  default: {
    create: vi.fn(),
    findOneAndUpdate: vi.fn(),
    deleteOne: vi.fn(),
    updateOne: vi.fn(),
  },
}));

import PasswordAssistanceJob from "../../model/password-assistance-job.model";
import {
  claimPasswordAssistanceJob,
  completePasswordAssistanceJob,
  enqueuePasswordAssistance,
  failPasswordAssistanceJob,
  getOrSetPasswordResetExpiry,
  renewPasswordAssistanceLease,
} from "./user.password-assistance.queue";

beforeEach(() => {
  vi.resetAllMocks();
});

describe("password assistance durable queue", () => {
  it("persists every accepted request before returning", async () => {
    await enqueuePasswordAssistance("nobody@example.com");

    expect(PasswordAssistanceJob.create).toHaveBeenCalledWith(
      [
        {
          email: "nobody@example.com",
          status: "pending",
          attempts: 0,
          availableAt: expect.any(Date),
          expiresAt: expect.any(Date),
        },
      ],
      { writeConcern: { w: "majority", j: true, wtimeout: 10_000 } },
    );
  });

  it("atomically claims due or stale work and increments attempts", async () => {
    vi.mocked(PasswordAssistanceJob.findOneAndUpdate).mockResolvedValue(null);

    await claimPasswordAssistanceJob();

    expect(PasswordAssistanceJob.findOneAndUpdate).toHaveBeenCalledWith(
      {
        $or: [
          { status: "pending", availableAt: { $lte: expect.any(Date) } },
          { status: "processing", lockedAt: { $lte: expect.any(Date) } },
        ],
      },
      {
        $set: {
          status: "processing",
          lockedAt: expect.any(Date),
          leaseToken: expect.any(String),
        },
        $inc: { attempts: 1 },
      },
      { new: true, sort: { availableAt: 1, createdAt: 1 }, maxTimeMS: 10_000 },
    );
  });

  it("renews a lease only when the same worker still owns it", async () => {
    vi.mocked(PasswordAssistanceJob.updateOne).mockResolvedValue({ matchedCount: 0 } as any);

    const renewed = await renewPasswordAssistanceLease({
      jobId: "job-1",
      leaseToken: "stale-lease",
    });

    expect(PasswordAssistanceJob.updateOne).toHaveBeenCalledWith(
      { _id: "job-1", status: "processing", leaseToken: "stale-lease" },
      { $set: { lockedAt: expect.any(Date) } },
      { maxTimeMS: 10_000 },
    );
    expect(renewed).toBe(false);
  });

  it("persists and reuses the first reset-token expiry under the active lease", async () => {
    const fixedExpiry = new Date("2030-01-01T01:00:00Z");
    vi.mocked(PasswordAssistanceJob.findOneAndUpdate).mockResolvedValue({
      tokenExpiresAt: fixedExpiry,
    } as any);

    const expiry = await getOrSetPasswordResetExpiry({
      jobId: "job-1",
      leaseToken: "lease-1",
      ttlMs: 3_600_000,
    });

    expect(PasswordAssistanceJob.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: "job-1", status: "processing", leaseToken: "lease-1" },
      [
        {
          $set: {
            lockedAt: expect.any(Date),
            tokenExpiresAt: { $ifNull: ["$tokenExpiresAt", expect.any(Date)] },
          },
        },
      ],
      // mongoose 9 requires explicit opt-in for aggregation update pipelines.
      { new: true, updatePipeline: true, maxTimeMS: 10_000 },
    );
    expect(expiry).toEqual(fixedExpiry);
  });

  it("deletes completed work only while it is still claimed", async () => {
    vi.mocked(PasswordAssistanceJob.deleteOne).mockResolvedValue({ deletedCount: 1 } as any);

    const completed = await completePasswordAssistanceJob({
      jobId: "job-1",
      leaseToken: "lease-1",
    });

    expect(PasswordAssistanceJob.deleteOne).toHaveBeenCalledWith(
      {
        _id: "job-1",
        status: "processing",
        leaseToken: "lease-1",
      },
      { maxTimeMS: 10_000 },
    );
    expect(completed).toBe(true);
  });

  it("releases a transient failure with a future retry time", async () => {
    vi.mocked(PasswordAssistanceJob.updateOne).mockResolvedValue({ matchedCount: 1 } as any);

    const released = await failPasswordAssistanceJob({
      jobId: "job-1",
      leaseToken: "lease-1",
      attempts: 2,
      error: new Error("resend unavailable"),
    });

    expect(PasswordAssistanceJob.updateOne).toHaveBeenCalledWith(
      { _id: "job-1", status: "processing", leaseToken: "lease-1" },
      {
        $set: {
          status: "pending",
          lastError: "resend unavailable",
          lockedAt: null,
          leaseToken: null,
          availableAt: expect.any(Date),
        },
      },
      { maxTimeMS: 10_000 },
    );
    expect(released).toBe(true);
  });

  it("dead-letters work after the bounded attempt count", async () => {
    vi.mocked(PasswordAssistanceJob.updateOne).mockResolvedValue({ matchedCount: 1 } as any);

    await failPasswordAssistanceJob({
      jobId: "job-1",
      leaseToken: "lease-1",
      attempts: 5,
      error: "failed",
    });

    expect(PasswordAssistanceJob.updateOne).toHaveBeenCalledWith(
      { _id: "job-1", status: "processing", leaseToken: "lease-1" },
      {
        $set: {
          status: "failed",
          lastError: "failed",
          lockedAt: null,
          leaseToken: null,
        },
      },
      { maxTimeMS: 10_000 },
    );
  });
});
