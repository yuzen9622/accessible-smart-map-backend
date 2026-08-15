import { Types } from "mongoose";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  addConfirmation,
  findActiveDuplicate,
  findConfirmedWithin,
  findNearbyReports,
  findReportById,
  insertReport,
} from "./hazard-report.repository";
import {
  clearMongoTestDatabase,
  startMongoTest,
  stopMongoTest,
  type MongoTestContext,
} from "../../../tests/helpers/mongo-test-harness";

describe("hazard-report repository with real MongoDB", () => {
  let mongo: MongoTestContext | undefined;

  beforeAll(async () => {
    mongo = await startMongoTest();
  });

  afterEach(async () => {
    await clearMongoTestDatabase();
  });

  afterAll(async () => {
    await stopMongoTest(mongo);
  });

  it("persists a report, enforces one confirmation and finds active nearby hazards", async () => {
    const reportId = new Types.ObjectId().toString();
    const now = new Date();
    const report = await insertReport({
      _id: reportId,
      reporterId: "reporter-1",
      reportedLocation: {
        type: "Point",
        coordinates: [121.565, 25.033],
      },
      hazardType: "obstacle",
      severity: "blocking",
      expectedUntil: null,
      description: "Temporary obstruction",
      photoUrl: "https://example.test/hazard.jpg",
      photoStoragePath: "hazards/hazard.jpg",
      exifValidation: {
        timestampFresh: true,
        gpsPresent: true,
        gpsMatchesClaimed: true,
      },
      aiVerification: {
        verdict: "verified",
        confidence: 0.99,
        reason: "clear obstruction",
      },
      status: "verified",
      expiredAt: new Date(now.getTime() + 60_000),
    });

    expect(String(report._id)).toBe(reportId);
    const duplicate = await findActiveDuplicate(
      25.033,
      121.565,
      100,
      "obstacle",
      now,
    );
    expect(String(duplicate?._id)).toBe(reportId);

    const confirmed = await addConfirmation(reportId, "independent-voter");
    expect(String(confirmed?._id)).toBe(reportId);
    expect(confirmed).toMatchObject({
      confirmCount: 1,
      confirmedBy: ["independent-voter"],
    });
    await expect(
      addConfirmation(reportId, "independent-voter"),
    ).resolves.toBeNull();

    const nearby = await findNearbyReports(
      25.033,
      121.565,
      500,
      ["verified"],
      "obstacle",
      10,
    );
    expect(nearby).toHaveLength(1);
    expect(String(nearby[0]?._id)).toBe(reportId);
    expect(nearby[0]).toMatchObject({
      description: "Temporary obstruction",
      status: "verified",
    });
    expect(nearby[0]).not.toHaveProperty("photoStoragePath");

    const confirmedWithin = await findConfirmedWithin(
      { lat: 25.033, lng: 121.565 },
      500,
      10,
      now,
    );
    expect(confirmedWithin).toHaveLength(1);
    expect(String(confirmedWithin[0]?._id)).toBe(reportId);
    expect(confirmedWithin[0]).toMatchObject({
      confirmedBy: ["independent-voter"],
    });
    await expect(findReportById(reportId)).resolves.toMatchObject({
      confirmCount: 1,
      confirmedBy: ["independent-voter"],
    });
  });
});
