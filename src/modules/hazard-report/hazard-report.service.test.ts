import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../model/hazard-report.model", () => ({
  default: {
    findOne: vi.fn(),
    findById: vi.fn(),
    findOneAndUpdate: vi.fn(),
    find: vi.fn(),
    create: vi.fn(),
  },
}));

vi.mock("../../adapters/gcs.adapter", () => ({
  uploadHazardPhoto: vi.fn(),
}));

vi.mock("./hazard-report.parse", () => ({
  parsePhotoExif: vi.fn(),
}));

vi.mock("./hazard-report.ai-verify", () => ({
  verifyHazardReport: vi.fn(),
}));

import { uploadHazardPhoto } from "../../adapters/gcs.adapter";
import { HAZARD_REASON } from "../../constants/messages";
import HazardReport from "../../model/hazard-report.model";
import { ResponseCode } from "../../types/code";
import { parsePhotoExif } from "./hazard-report.parse";
import {
  confirmReport,
  createReport,
  findConfirmedHazardsWithin,
} from "./hazard-report.service";

const hazardReportModel = HazardReport as unknown as {
  findOne: ReturnType<typeof vi.fn>;
  findById: ReturnType<typeof vi.fn>;
  findOneAndUpdate: ReturnType<typeof vi.fn>;
  find: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
};

const REPORT_ID = "66a1f2c3e4b5a6d7c8e9f0d4";

/** A `.lean()`-terminated query chain resolving to `value`. */
function leanChain(value: unknown) {
  const chain = { select: vi.fn(), lean: vi.fn() };
  chain.select.mockReturnValue(chain);
  chain.lean.mockResolvedValue(value);
  return chain;
}

function duplicateReport(reporterId: string) {
  return {
    _id: REPORT_ID,
    reporterId,
    confirmedBy: [] as string[],
    deniedBy: [] as string[],
    confirmCount: 0,
    denyCount: 0,
    status: "verified",
    photoStoragePath: "reports/test.jpg",
  };
}

function geoFindChain(items: unknown[]) {
  const chain = {
    select: vi.fn(),
    limit: vi.fn(),
    lean: vi.fn(),
  };
  chain.select.mockReturnValue(chain);
  chain.limit.mockReturnValue(chain);
  chain.lean.mockResolvedValue(items);
  return chain;
}

function createInput(reporterId: string) {
  return {
    reporterId,
    hazardType: "obstacle" as const,
    severity: "difficult" as const,
    latitude: 25.033,
    longitude: 121.5654,
    photo: {
      buffer: Buffer.from("test-photo"),
      mimeType: "image/jpeg" as const,
    },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(parsePhotoExif).mockResolvedValue({
    timestampFresh: true,
    gpsPresent: false,
    gpsMatchesClaimed: false,
  });
});

describe("hazard report confirmations", () => {
  it("does not deduplicate against an expired pending or verified report", async () => {
    hazardReportModel.findOne.mockReturnValue(leanChain(null));
    vi.mocked(uploadHazardPhoto).mockRejectedValue(
      new Error("test upload abort"),
    );

    await createReport(createInput("reporter-1"));

    expect(hazardReportModel.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        status: { $in: ["pending", "verified"] },
        expiredAt: { $gt: expect.any(Date) },
      }),
    );
  });

  it("does not turn a same-reporter duplicate submission into a confirmation", async () => {
    const report = duplicateReport("reporter-1");
    hazardReportModel.findOne.mockReturnValue(leanChain(report));

    const result = await createReport(createInput("reporter-1"));

    expect(result).toMatchObject({ ok: true, data: { merged: true } });
    expect(report.confirmCount).toBe(0);
    expect(report.confirmedBy).toEqual([]);
    expect(hazardReportModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("records a duplicate submission from another reporter as identity-bearing confirmation", async () => {
    const report = duplicateReport("reporter-1");
    hazardReportModel.findOne.mockReturnValue(leanChain(report));
    hazardReportModel.findOneAndUpdate.mockReturnValue(
      leanChain({ ...report, confirmCount: 1, confirmedBy: ["confirmer-2"] }),
    );

    await createReport(createInput("confirmer-2"));

    expect(hazardReportModel.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        expiredAt: { $gt: expect.any(Date) },
      }),
    );
    expect(hazardReportModel.findOneAndUpdate).toHaveBeenCalledWith(
      {
        _id: REPORT_ID,
        confirmedBy: { $ne: "confirmer-2" },
        deniedBy: { $ne: "confirmer-2" },
      },
      { $inc: { confirmCount: 1 }, $push: { confirmedBy: "confirmer-2" } },
      { returnDocument: "after" },
    );
  });

  it("rejects a reporter's own confirmation", async () => {
    const report = duplicateReport("reporter-1");
    hazardReportModel.findById.mockReturnValue(leanChain(report));

    const result = await confirmReport({
      reportId: REPORT_ID,
      action: "confirm",
      voterId: "reporter-1",
    });

    expect(result).toMatchObject({
      ok: false,
      httpCode: ResponseCode.INVALID_INPUT,
      data: { reason: HAZARD_REASON.SELF_CONFIRMATION },
    });
    expect(report.confirmCount).toBe(0);
    expect(report.confirmedBy).toEqual([]);
    expect(hazardReportModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("only returns verified, unexpired reports with a distinct confirmer", async () => {
    const future = new Date(Date.now() + 60_000);
    const past = new Date(Date.now() - 60_000);
    const base = {
      hazardType: "obstacle",
      severity: "blocking",
      description: "施工圍籬",
      reportedLocation: { type: "Point", coordinates: [121.5654, 25.033] },
      reporterId: "reporter-1",
      status: "verified",
      confirmCount: 1,
    };
    const chain = geoFindChain([
      {
        ...base,
        _id: "independent",
        confirmedBy: ["confirmer-2"],
        expiredAt: future,
      },
      {
        ...base,
        _id: "self-only",
        confirmedBy: ["reporter-1"],
        expiredAt: future,
      },
      { ...base, _id: "legacy-count-only", expiredAt: future },
      {
        ...base,
        _id: "expired",
        confirmedBy: ["confirmer-2"],
        expiredAt: past,
      },
    ]);
    hazardReportModel.find.mockReturnValue(chain);

    const hazards = await findConfirmedHazardsWithin(
      { lat: 25.033, lng: 121.5654 },
      250,
      10,
    );

    expect(hazards).toEqual([
      {
        id: "independent",
        hazardType: "obstacle",
        severity: "blocking",
        description: "施工圍籬",
        coordinates: [121.5654, 25.033],
      },
    ]);
    expect(hazardReportModel.find).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "verified",
        expiredAt: { $gt: expect.any(Date) },
        $expr: expect.any(Object),
      }),
    );
    const filter = hazardReportModel.find.mock.calls[0][0] as {
      confirmCount?: unknown;
      $expr: unknown;
    };
    expect(filter.confirmCount).toBeUndefined();
    expect(filter.$expr).toEqual({
      $gt: [
        {
          $size: {
            $filter: {
              input: {
                $cond: [{ $isArray: "$confirmedBy" }, "$confirmedBy", []],
              },
              as: "voterId",
              cond: { $ne: ["$$voterId", "$reporterId"] },
            },
          },
        },
        0,
      ],
    });
    expect(chain.select).toHaveBeenCalledWith(
      "hazardType severity description reportedLocation reporterId confirmedBy status expiredAt",
    );
  });
});
