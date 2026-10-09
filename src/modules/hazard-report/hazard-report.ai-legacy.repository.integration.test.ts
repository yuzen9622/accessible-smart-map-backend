import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { persistLegacyAiResult } from "./hazard-report.ai-legacy.repository";
import {
  readDoc,
  seedQueued,
  seedReport,
} from "../../../tests/helpers/hazard-report-fixtures";
import {
  clearMongoTestDatabase,
  startMongoTest,
  stopMongoTest,
  type MongoTestContext,
} from "../../../tests/helpers/mongo-test-harness";
const result = {
  verdict: "verified" as const,
  confidence: 0.1,
  reason: "controlled reason",
  attemptedAt: new Date(),
};
describe("historical benchmark shim never writes a v2 or cancelled row", () => {
  let mongo: MongoTestContext | undefined;
  beforeAll(async () => {
    mongo = await startMongoTest();
  });
  afterEach(clearMongoTestDatabase);
  afterAll(async () => {
    await stopMongoTest(mongo);
  });
  it("retains the captured-update interface only for an active pending legacy report", async () => {
    const id = await seedReport({ status: "pending" });
    await persistLegacyAiResult(id, result);
    expect(await readDoc(id)).toMatchObject({
      status: "verified",
      aiVerification: { confidence: 0.1, reason: result.reason },
    });
  });
  it("cannot overwrite a queued v2 generation", async () => {
    const id = await seedQueued();
    await persistLegacyAiResult(id, result);
    expect(await readDoc(id)).toMatchObject({
      status: "pending",
      aiReview: { state: "queued" },
      aiVerification: { verdict: "skipped" },
    });
  });
  it.each(["manual", "scrub", "expiry", "closed"])(
    "drops a late legacy result after %s",
    async (cause) => {
      const over =
        cause === "manual"
          ? {
              manualReview: {
                reviewerId: "admin",
                decision: "rejected",
                reviewedAt: new Date(),
              },
            }
          : cause === "scrub"
            ? { contentScrubbedAt: new Date() }
            : cause === "expiry"
              ? { expiredAt: new Date(Date.now() - 1) }
              : { status: "expired" };
      const id = await seedReport({ status: "pending", ...over });
      await persistLegacyAiResult(id, result);
      const row = await readDoc(id);
      expect(row?.aiVerification.reason).toBe("legacy");
      expect(row?.status).not.toBe("verified");
    },
  );
});
