import { describe, expect, it } from "vitest";

import { normalizeMqttPayload, topicToStoreKey } from "./alert.ingest";

describe("topicToStoreKey", () => {
  it("maps every subscribed topic family", () => {
    expect(topicToStoreKey("v2/Bus/Alert/City/Taipei")).toBe("bus:city:Taipei");
    expect(topicToStoreKey("v2/Bus/Alert/InterCity")).toBe("bus:intercity");
    expect(topicToStoreKey("v2/Rail/Metro/Alert/TRTC")).toBe("metro:TRTC");
    expect(topicToStoreKey("v3/Rail/TRA/Alert")).toBe("tra");
    expect(topicToStoreKey("v2/Rail/THSR/AlertInfo")).toBe("thsr");
  });

  it("accepts a v3 bus topic version", () => {
    expect(topicToStoreKey("v3/Bus/Alert/City/NewTaipei")).toBe(
      "bus:city:NewTaipei",
    );
  });

  it("returns null for unmapped topics", () => {
    expect(topicToStoreKey("v2/Bus/EstimatedTimeOfArrival/City/Taipei")).toBe(
      null,
    );
    expect(topicToStoreKey("v2/Bus/Alert/City")).toBeNull();
    expect(topicToStoreKey("v2/Rail/Metro/Alert")).toBeNull();
    expect(topicToStoreKey("nonsense")).toBeNull();
    expect(topicToStoreKey("")).toBeNull();
  });
});

describe("normalizeMqttPayload", () => {
  it("keeps a bus bare array", () => {
    const payload = [{ AlertID: "B1" }];
    expect(normalizeMqttPayload("v2/Bus/Alert/City/Taipei", payload)).toEqual(
      payload,
    );
  });

  it("unwraps a rail envelope", () => {
    expect(
      normalizeMqttPayload("v2/Rail/Metro/Alert/TRTC", {
        AuthorityCode: "TRTC",
        UpdateTime: "2026-08-15T00:00:00+08:00",
        Alerts: [{ AlertID: "M1" }],
      }),
    ).toEqual([{ AlertID: "M1" }]);
  });

  it("accepts a rail bare array", () => {
    expect(
      normalizeMqttPayload("v2/Rail/THSR/AlertInfo", [{ AlertID: "H1" }]),
    ).toEqual([{ AlertID: "H1" }]);
  });

  it("returns an empty array for unexpected shapes", () => {
    expect(normalizeMqttPayload("v2/Bus/Alert/InterCity", { a: 1 })).toEqual(
      [],
    );
    expect(
      normalizeMqttPayload("v3/Rail/TRA/Alert", { Alerts: "nope" }),
    ).toEqual([]);
    expect(normalizeMqttPayload("v3/Rail/TRA/Alert", null)).toEqual([]);
  });
});
