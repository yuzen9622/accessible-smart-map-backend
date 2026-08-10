import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./user.auth.service", () => ({
  processPasswordAssistance: vi.fn(),
}));

vi.mock("./user.password-assistance.queue", () => ({
  claimPasswordAssistanceJob: vi.fn(),
  completePasswordAssistanceJob: vi.fn(),
  failPasswordAssistanceJob: vi.fn(),
  renewPasswordAssistanceLease: vi.fn(),
}));

import { processPasswordAssistance } from "./user.auth.service";
import {
  claimPasswordAssistanceJob,
  completePasswordAssistanceJob,
  failPasswordAssistanceJob,
  renewPasswordAssistanceLease,
} from "./user.password-assistance.queue";
import { drainPasswordAssistanceQueue } from "./user.password-assistance.worker";

beforeEach(() => {
  vi.resetAllMocks();
});

describe("drainPasswordAssistanceQueue", () => {
  it("processes and completes a claimed job", async () => {
    vi.mocked(claimPasswordAssistanceJob)
      .mockResolvedValueOnce({
        _id: "job-1",
        email: "jane@example.com",
        attempts: 1,
        createdAt: new Date("2026-08-09T00:00:00Z"),
        leaseToken: "lease-1",
      } as any)
      .mockResolvedValueOnce(null);
    vi.mocked(renewPasswordAssistanceLease).mockResolvedValue(true);
    vi.mocked(completePasswordAssistanceJob).mockResolvedValue(true);

    const processed = await drainPasswordAssistanceQueue();

    expect(renewPasswordAssistanceLease).toHaveBeenCalledWith({
      jobId: "job-1",
      leaseToken: "lease-1",
    });
    expect(processPasswordAssistance).toHaveBeenCalledWith({
      email: "jane@example.com",
      jobId: "job-1",
      leaseToken: "lease-1",
    });
    expect(completePasswordAssistanceJob).toHaveBeenCalledWith({
      jobId: "job-1",
      leaseToken: "lease-1",
    });
    expect(failPasswordAssistanceJob).not.toHaveBeenCalled();
    expect(processed).toBe(1);
  });

  it("does not dispatch when the lease was lost before the irreversible side effect", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.mocked(claimPasswordAssistanceJob)
      .mockResolvedValueOnce({
        _id: "job-1",
        email: "jane@example.com",
        attempts: 1,
        createdAt: new Date("2026-08-09T00:00:00Z"),
        leaseToken: "old-lease",
      } as any)
      .mockResolvedValueOnce(null);
    vi.mocked(renewPasswordAssistanceLease).mockResolvedValue(false);

    const processed = await drainPasswordAssistanceQueue();

    expect(processPasswordAssistance).not.toHaveBeenCalled();
    expect(completePasswordAssistanceJob).not.toHaveBeenCalled();
    expect(failPasswordAssistanceJob).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(processed).toBe(1);
  });

  it("releases failed work for retry without completing it", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(claimPasswordAssistanceJob)
      .mockResolvedValueOnce({
        _id: "job-1",
        email: "jane@example.com",
        attempts: 2,
        createdAt: new Date("2026-08-09T00:00:00Z"),
        leaseToken: "lease-1",
      } as any)
      .mockResolvedValueOnce(null);
    vi.mocked(renewPasswordAssistanceLease).mockResolvedValue(true);
    vi.mocked(processPasswordAssistance).mockRejectedValue(new Error("mail down"));
    vi.mocked(failPasswordAssistanceJob).mockResolvedValue(true);

    const processed = await drainPasswordAssistanceQueue();

    expect(failPasswordAssistanceJob).toHaveBeenCalledWith({
      jobId: "job-1",
      leaseToken: "lease-1",
      attempts: 2,
      error: expect.any(Error),
    });
    expect(completePasswordAssistanceJob).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(processed).toBe(1);
  });
});
