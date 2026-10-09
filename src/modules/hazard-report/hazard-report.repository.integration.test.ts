import { toReportView } from "./hazard-report.view";
import { Types } from "mongoose";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import HazardReport from "../../model/hazard-report.model";
import { HAZARD_AI } from "../../config/hazard-ai";
import {
  readDoc,
  seedQueued,
} from "../../../tests/helpers/hazard-report-fixtures";
import {
  addConfirmation,
  findActiveDuplicate,
  findConfirmedWithin,
  findNearbyReports,
  findReportById,
  insertReport,
  scrubReportContent,
  markReportDeidentified,
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

  beforeEach(async () => {
    await HazardReport.createIndexes();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await clearMongoTestDatabase();
  });

  afterAll(async () => {
    await stopMongoTest(mongo);
  });

  it("bounds the real final read with driver CSOT and server maxTimeMS", async () => {
    const id = await seedQueued();
    // Spy passes through to real Mongo; it only observes query options.
    const find = vi.spyOn(HazardReport, "findOne");
    expect(await findReportById(id)).not.toBeNull();
    expect(find.mock.results[0].value.getOptions()).toMatchObject({
      maxTimeMS: HAZARD_AI.dbTimeoutMs,
      timeoutMS: HAZARD_AI.dbTimeoutMs,
    });
  });

  it("scrubs ready intake metadata while retaining the photo deletion key until phase B", async () => {
    const cutoff = new Date();
    const id = await seedQueued({ expiredAt: new Date(cutoff.getTime() - 1) });
    expect((await readDoc(id))?.photoIntake?.uploadToken).toBe("tok");
    expect(await scrubReportContent(id, cutoff, "deidentified:ready")).toBe(
      true,
    );
    const scrubbed = await readDoc(id);
    expect(scrubbed?.photoIntake).toBeUndefined();
    expect(scrubbed?.aiReviewJob).toBeUndefined();
    expect(scrubbed?.photoStoragePath).toBe(`reports/${id}.jpg`);
    await markReportDeidentified(id);
    const deleted = await readDoc(id);
    expect(deleted?.photoIntake).toBeUndefined();
    expect(deleted?.photoStoragePath).toBeUndefined();
  });

  it("preserves cleanup tombstones and their late-upload key during retention", async () => {
    const cutoff = new Date();
    const intake = {
      state: "cleanup",
      uploadToken: "late-upload-token",
      deadlineAt: new Date(0),
      storagePath: "reports/known-key.jpg",
      cleanupUntil: new Date(cutoff.getTime() + 60_000),
      nextCleanupAt: cutoff,
      cleanupAttempts: 1,
    };
    const id = await seedQueued({
      expiredAt: new Date(0),
      photoIntake: intake,
    });
    expect(await scrubReportContent(id, cutoff, "deidentified:cleanup")).toBe(
      true,
    );
    expect((await readDoc(id))?.photoIntake).toMatchObject(intake);
    await markReportDeidentified(id);
    expect((await readDoc(id))?.photoIntake).toMatchObject(intake);
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
      new Date(now.getTime() - 600_000),
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
      now,
    );
    expect(nearby).toHaveLength(1);
    expect(String(nearby[0]?._id)).toBe(reportId);
    expect(nearby[0]).toMatchObject({
      description: "Temporary obstruction",
      status: "verified",
    });
    expect(toReportView(nearby[0], false)).not.toHaveProperty(
      "photoStoragePath",
    );

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
