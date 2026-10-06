import { describe, expect, it } from "vitest";
import { parseParkEntranceCsv } from "./taipei-park-entrance-parse";

const HEADER =
  "ID,行政區,公園名稱,無障礙出入口名稱,TW97座標X,TW97座標Y,人行道寬度,坡度";

describe("parseParkEntranceCsv", () => {
  it("converts TWD97 to WGS84 and keeps width (m) and slope (%)", () => {
    const { entrances } = parseParkEntranceCsv(
      `\uFEFF${HEADER}\r\n1,萬華區,青年公園,1號出入口,301105.53,2768259.85,1.8 ,8 \r\n`,
    );
    expect(entrances).toHaveLength(1);
    const [doc] = entrances;
    expect(doc).toMatchObject({
      sourceId: "1",
      district: "萬華區",
      parkName: "青年公園",
      entranceName: "1號出入口",
      minClearWidthM: 1.8,
      slopePercent: 8,
    });
    // Expected WGS84 is the government's own conversion of this entrance,
    // published by 輪行臺北 (wheelroute facility type 7, "1_青年公園_1號出入口").
    const [lng, lat] = doc.location.coordinates;
    expect(lng).toBeCloseTo(121.50638, 5);
    expect(lat).toBeCloseTo(25.021549, 5);
  });

  it("drops the published rows whose coordinates have mistyped digits", () => {
    const result = parseParkEntranceCsv(
      [
        HEADER,
        "1,中山區,花博公園新生園區,1號出入口,323503.41,2773465.66,3,0",
        "2,中正區,華山公園,1號出入口,302820.72,277120.65,3,0",
        "3,松山區,民生公園,1號出入口,3066305.29,2772362.92,3,0",
      ].join("\n"),
    );
    expect(result.entrances).toEqual([]);
    expect(result.outOfBounds).toBe(3);
  });

  it("counts malformed and duplicate rows instead of guessing", () => {
    const result = parseParkEntranceCsv(
      [
        HEADER,
        "1,萬華區,青年公園,1號出入口,301105.53,2768259.85,1.8,8",
        "1,萬華區,青年公園,2號出入口,301159.52,2768691.35,19.6,3",
        ",萬華區,青年公園,3號出入口,300742.59,2768400.40,15.2,0",
        "4,萬華區,,4號出入口,300816.70,2768152.96,12.5,3",
        "5,萬華區,和平青草園,1號出入口,abc,2769519.08,2.2,5",
      ].join("\n"),
    );
    expect(result.entrances.map((e) => e.sourceId)).toEqual(["1"]);
    expect(result.duplicateIds).toBe(1);
    expect(result.malformed).toBe(3);
  });

  it("keeps the entrance with null measurements when width/slope are unparseable", () => {
    const { entrances } = parseParkEntranceCsv(
      `${HEADER}\n1,萬華區,青年公園,1號出入口,301105.53,2768259.85,,-1`,
    );
    expect(entrances[0]).toMatchObject({
      minClearWidthM: null,
      slopePercent: null,
    });
  });

  it("locates columns by header name, not position", () => {
    const { entrances } = parseParkEntranceCsv(
      "坡度,人行道寬度,TW97座標Y,TW97座標X,無障礙出入口名稱,公園名稱,行政區,ID\n" +
        "8,1.8,2768259.85,301105.53,1號出入口,青年公園,萬華區,1",
    );
    expect(entrances[0]).toMatchObject({
      sourceId: "1",
      minClearWidthM: 1.8,
      slopePercent: 8,
    });
  });

  it("returns nothing for an unexpected header", () => {
    expect(parseParkEntranceCsv("a,b\n1,2").entrances).toEqual([]);
  });
});
