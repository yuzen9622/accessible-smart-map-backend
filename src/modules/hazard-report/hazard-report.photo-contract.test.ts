import { describe, expect, it } from "vitest";
import { generateOpenAPIDocument } from "../../openapi/document";
import { SingleReportResponseSchema } from "./hazard-report.schema";
import { toReportView } from "./hazard-report.view";

const id = "6670abc123def4567890abcd";

describe("hazard photo OpenAPI contract", () => {
  it("documents separate public and private photo security and binary responses", () => {
    const document = generateOpenAPIDocument();
    expect(document.servers).toContainEqual({
      url: "/api/v1",
      description: "目前環境",
    });
    const publicPhoto = document.paths["/a11y/reports/{id}/photo/public"]?.get;
    expect(publicPhoto?.security).toEqual([]);
    expect(Object.keys(publicPhoto!.responses).sort()).toEqual([
      "200",
      "400",
      "404",
      "429",
      "503",
    ]);
    expect(publicPhoto!.responses[200]).toMatchObject({
      content: {
        "image/jpeg": { schema: { type: "string", format: "binary" } },
      },
    });
    expect(publicPhoto!.parameters).toContainEqual(
      expect.objectContaining({ name: "id", in: "path", required: true }),
    );
    expect(document.paths["/a11y/reports/{id}/photo"]?.get?.security).toEqual([
      { bearerAuth: [] },
    ]);
    expect(document.components?.schemas?.HazardReport).toMatchObject({
      required: expect.arrayContaining(["hasPhoto", "publicPhotoUrl"]),
      properties: { publicPhotoUrl: { type: "string", nullable: true } },
    });
  });

  it("accepts serialized DTOs with the advertised URL/null field", () => {
    const row = {
      _id: id,
      hazardType: "obstacle",
      severity: "blocking",
      expectedUntil: null,
      reportedLocation: { type: "Point", coordinates: [121.565, 25.033] },
      photoStoragePath: `reports/${id}.jpg`,
      status: "verified",
      aiReview: {
        version: 2,
        state: "completed",
        decision: "supported",
        reasonCode: "PHOTO_SUPPORTS_CLAIM",
        reason: "照片支持回報",
      },
      confirmCount: 0,
      denyCount: 0,
      createdAt: new Date(),
      expiredAt: new Date(Date.now() + 60_000),
    };
    for (const expiry of [row.expiredAt, new Date(0)]) {
      const report = JSON.parse(
        JSON.stringify(toReportView({ ...row, expiredAt: expiry }, false)),
      );
      const envelope = {
        ok: true,
        status: "success",
        code: 200,
        message: "OK",
        data: { report },
      };
      expect(SingleReportResponseSchema.safeParse(envelope).success).toBe(true);
      expect(report.publicPhotoUrl).toBe(
        expiry.getTime() > Date.now()
          ? `/api/v1/a11y/reports/${id}/photo/public`
          : null,
      );
    }
  });
});
