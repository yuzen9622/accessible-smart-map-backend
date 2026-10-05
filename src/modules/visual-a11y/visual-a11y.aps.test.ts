import { describe, expect, it } from "vitest";
import { parseTaipeiApsCsv } from "./visual-a11y.service";

describe("parseTaipeiApsCsv", () => {
  const header = "項次,路口,行政區,號誌編號,WGS84經度座標,WGS84緯度座標";

  it("parses the published CSV into TCE audio-signal upserts", () => {
    const [doc] = parseTaipeiApsCsv(
      `﻿${header}\n1,八德路二段　　建國北一段,中山區,SKGKP10,121.536674,25.046066\n`,
    );
    expect(doc).toMatchObject({
      source: "taipei_tce",
      sourceId: "SKGKP10",
      type: "audio_signal",
      location: { type: "Point", coordinates: [121.536674, 25.046066] },
      properties: { name: "八德路二段 建國北一段", roadName: "中山區" },
    });
  });

  it("skips duplicate ids, missing ids and coordinates outside Taiwan", () => {
    const docs = parseTaipeiApsCsv(
      [
        header,
        "1,A,中山區,ID1,121.5,25.0",
        "2,B,中山區,ID1,121.5,25.0",
        "3,C,中山區,,121.5,25.0",
        "4,D,中山區,ID4,0,0",
      ].join("\n"),
    );
    expect(docs.map((d) => d.sourceId)).toEqual(["ID1"]);
  });

  it("returns nothing for an unexpected header", () => {
    expect(parseTaipeiApsCsv("a,b\n1,2")).toEqual([]);
  });
});
