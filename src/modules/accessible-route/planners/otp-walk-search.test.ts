import { describe, expect, it } from "vitest";
import samples from "../../../../tests/fixtures/otp-walk-search-native.json";
import captured from "../../../../tests/fixtures/otp-walk-search-capture2-native.json";
import { OtpDirectWalkSearchSchema } from "../../../types/otp-walk-search";
import { parseOtpWalkSearch } from "./otp-walk-search";

const cases = samples.cases.map((row) => ({
  case: row.case,
  proof: OtpDirectWalkSearchSchema.parse(row.proof),
}));
const expectations = (proof: (typeof cases)[number]["proof"]) => ({
  profile: proof.executedPolicy.profile,
  avoidStairs: true,
  origin: { lat: proof.fromLat, lng: proof.fromLon },
  destination: { lat: proof.toLat, lng: proof.toLon },
  departureTimeMs: proof.departureTimeMs,
});

describe("actual native direct WALK search evidence", () => {
  it.each(captured.cases)(
    "qualifies actual native completion: $case",
    ({ proof: raw }) => {
      const proof = OtpDirectWalkSearchSchema.parse(raw);
      const result = parseOtpWalkSearch(proof, expectations(proof));
      if (proof.status === "FOUND") expect(result.status).toBe("found");
      else if (proof.status === "COMPLETED_NO_ROUTE")
        expect(result.status).toBe("no_route");
      else
        expect(result).toEqual({
          status: "unavailable",
          reason: "search_not_complete",
        });
    },
  );
  it.each(cases)(
    "accepts captured $case / $proof.executedPolicy.profile",
    ({ proof }) => {
      expect(parseOtpWalkSearch(proof, expectations(proof))).toEqual({
        status: proof.status === "FOUND" ? "found" : "no_route",
        proof,
      });
    },
  );

  const noRoute = cases.find(
    (row) => row.proof.status === "COMPLETED_NO_ROUTE",
  )?.proof;
  if (!noRoute) throw new Error("Missing captured exhausted native search");

  it.each([
    { nativeOutcome: "TIMEOUT" },
    { nativeOutcome: "TERMINATED" },
    { status: "NOT_EXECUTED_LIMIT", nativeOutcome: "DISTANCE_LIMIT" },
    { status: "NOT_EXECUTED", nativeOutcome: "NOT_STARTED" },
    { durationLimitPruned: true },
    { status: "FOUND", nativeOutcome: "EXHAUSTED" },
  ])("refuses mutated incomplete search: %j", (mutation) => {
    expect(
      parseOtpWalkSearch({ ...noRoute, ...mutation }, expectations(noRoute)),
    ).toEqual({
      status: "unavailable",
      reason: "search_not_complete",
    });
  });

  it.each([
    { profile: "NORMAL" },
    { wheelchairEnabled: false },
    { walkSpeedMps: 1.3 },
    { stairsReluctance: 1 },
    { minimumKnownWidthM: null },
    { maximumKnownNonStairSlopeRatio: null },
  ])("refuses mutated executed profile: %j", (mutation) => {
    const forged = {
      ...noRoute,
      executedPolicy: { ...noRoute.executedPolicy, ...mutation },
    };
    expect(parseOtpWalkSearch(forged, expectations(noRoute))).toEqual({
      status: "unavailable",
      reason: "search_profile_mismatch",
    });
  });

  it("does not authorize a different waypoint departure", () => {
    expect(
      parseOtpWalkSearch(noRoute, {
        ...expectations(noRoute),
        departureTimeMs: noRoute.departureTimeMs + 1000,
      }),
    ).toEqual({ status: "unavailable", reason: "search_request_mismatch" });
  });

  it("does not authorize another origin", () => {
    expect(
      parseOtpWalkSearch(noRoute, {
        ...expectations(noRoute),
        origin: { lat: noRoute.fromLat, lng: noRoute.fromLon + 0.000001 },
      }),
    ).toEqual({ status: "unavailable", reason: "search_request_mismatch" });
  });
});
