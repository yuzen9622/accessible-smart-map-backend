import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { otpWalkNativeResponses } from "../../tests/fixtures/otp-walk-native";
import { OtpWalkIdentitySchema } from "../types/otp-walk-identity";
import type { QualifiedOtpWalkOptions } from "../modules/accessible-route/planners/otp-walk-planner";
import {
  parseNativeVerificationArgs,
  verifyNativeRelease,
} from "./verify-otp-native";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const release = mkdtempSync(path.join(os.tmpdir(), "otp-native-verifier-"));
  directories.push(release);
  mkdirSync(path.join(release, "evidence"));
  const identity = OtpWalkIdentitySchema.parse(
    otpWalkNativeResponses.forward.data.requestIdentity,
  );
  const source = identity.buildManifestIdentity;
  const bytes = JSON.stringify({
    schemaVersion: 2,
    phase: "BUILT",
    graph: identity.graphByteIdentity,
    source: {
      version: source.sourceVersion,
      batch: source.sourceBatch,
      archiveSha256: source.sourceArchiveSha256,
    },
  });
  writeFileSync(path.join(release, "evidence/build-manifest.json"), bytes);
  identity.buildManifestIdentity.manifestSha256 = createHash("sha256")
    .update(bytes)
    .digest("hex");
  const getIdentity = vi.fn(async () => ({
    status: "ready" as const,
    identity,
  }));
  const planWalk = vi
    .fn<(options: QualifiedOtpWalkOptions) => Promise<{ status: string }>>()
    .mockResolvedValue({ status: "ready" });
  return { release, identity, getIdentity, planWalk };
}

describe("native OTP candidate verification", () => {
  it("checks both modes with and without a waypoint and rechecks identity", async () => {
    const test = fixture();
    await expect(
      verifyNativeRelease({ release: test.release, identityOnly: false }, test),
    ).resolves.toEqual({
      graphSha256: test.identity.graphByteIdentity.sha256,
      routesChecked: 4,
    });
    expect(test.getIdentity).toHaveBeenCalledTimes(2);
    expect(
      test.planWalk.mock.calls.map(([options]) => [
        options.mode,
        options.points.length,
        options.allowStairsFallback,
      ]),
    ).toEqual([
      ["normal", 2, false],
      ["normal", 3, false],
      ["wheelchair", 2, false],
      ["wheelchair", 3, false],
    ]);
  });

  it.each(["manifest", "graph", "source"])(
    "rejects a different %s even when the provider identity is otherwise ready",
    async (field) => {
      const test = fixture();
      if (field === "manifest")
        test.identity.buildManifestIdentity.manifestSha256 = "a".repeat(64);
      else if (field === "graph")
        test.identity.graphByteIdentity.sha256 = "b".repeat(64);
      else test.identity.buildManifestIdentity.sourceVersion = "different";
      await expect(
        verifyNativeRelease(
          { release: test.release, identityOnly: false },
          test,
        ),
      ).rejects.toThrow("does not match");
      expect(test.planWalk).not.toHaveBeenCalled();
    },
  );

  it("rejects a candidate if any required route fails", async () => {
    const test = fixture();
    test.planWalk.mockResolvedValueOnce({ status: "ready" });
    test.planWalk.mockResolvedValueOnce({ status: "unavailable" });
    await expect(
      verifyNativeRelease({ release: test.release, identityOnly: false }, test),
    ).rejects.toThrow("3-point route failed");
    expect(test.planWalk).toHaveBeenCalledTimes(2);
  });

  it("rejects identity changes during route checks", async () => {
    const test = fixture();
    test.getIdentity.mockResolvedValueOnce({
      status: "ready",
      identity: structuredClone(test.identity),
    });
    test.identity.buildManifestIdentity.sourceBatch = "changed";
    await expect(
      verifyNativeRelease({ release: test.release, identityOnly: false }, test),
    ).rejects.toThrow("does not match");
    expect(test.planWalk).toHaveBeenCalledTimes(4);
  });

  it("checks the loaded release without rerunning routes after publication", async () => {
    const test = fixture();
    await expect(
      verifyNativeRelease({ release: test.release, identityOnly: true }, test),
    ).resolves.toMatchObject({ routesChecked: 0 });
    expect(test.getIdentity).toHaveBeenCalledOnce();
    expect(test.planWalk).not.toHaveBeenCalled();
  });

  it("accepts an explicit candidate origin and rejects credential URLs or duplicate flags", () => {
    expect(
      parseNativeVerificationArgs([
        "--otp",
        "http://127.0.0.1:18081",
        "--release",
        "otp-data/releases/test",
        "--identity-only",
      ]),
    ).toMatchObject({ otp: "http://127.0.0.1:18081", identityOnly: true });
    for (const args of [
      ["--otp", "http://user:password@localhost", "--release", "."],
      ["--otp", "http://localhost/path", "--release", "."],
      [
        "--otp",
        "http://localhost",
        "--otp",
        "http://localhost",
        "--release",
        ".",
      ],
      ["--release", "."],
    ])
      expect(() => parseNativeVerificationArgs(args)).toThrow();
  });
});
