import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getReviewedOtpWalkPolicies } from "../../../config/otp-walk";
import captured from "../../../../tests/fixtures/otp-walk-endpoint-refusal-native.json";
import waypointCapture from "../../../../tests/fixtures/otp-walk-endpoint-waypoint-native.json";
import {
  fetchOtpWalkIdentityResponse,
  fetchOtpWalkPlanResponse,
} from "../../../adapters/otp-walk.adapter";
import { OtpDirectWalkSearchSchema } from "../../../types/otp-walk-search";
import { readCurrentSidewalkSourceIdentity } from "./pedestrian-a11y/sidewalk-source.repository";
import { parseOtpWalkSearch } from "./otp-walk-search";
import { planQualifiedOtpWalk } from "./otp-walk-planner";

vi.mock("../../../config/otp-walk", () => ({
  getReviewedOtpWalkPolicies: vi.fn(),
}));
vi.mock("../../../adapters/otp-walk.adapter", () => ({
  fetchOtpWalkIdentityResponse: vi.fn(),
  fetchOtpWalkPlanResponse: vi.fn(),
}));
vi.mock("./pedestrian-a11y/sidewalk-source.repository", () => ({
  readCurrentSidewalkSourceIdentity: vi.fn(),
}));

const cases = captured.cases
  .map((row) => ({
    ...row,
    proof: OtpDirectWalkSearchSchema.parse(
      row.response.data.plan.directWalkSearch,
    ),
  }))
  .filter((row) => row.proof.status === "ENDPOINT_CONSTRAINT_BLOCKED");
const link = cases.find(
  (row) =>
    row.proof.schemaVersion === "2" &&
    row.proof.endpointConstraint?.phase === "LINK",
);
const cut = cases.find(
  (row) =>
    row.proof.schemaVersion === "2" &&
    row.proof.endpointConstraint?.phase === "TERMINAL_CUT",
);
if (!link || !cut)
  throw new Error("Native LINK and TERMINAL_CUT captures are required");
const expectations = (row: (typeof cases)[number]) => ({
  profile: row.proof.executedPolicy.profile,
  avoidStairs: true,
  origin: { lat: row.proof.fromLat, lng: row.proof.fromLon },
  destination: { lat: row.proof.toLat, lng: row.proof.toLon },
  departureTimeMs: row.proof.departureTimeMs,
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("captured native endpoint constraint refusal", () => {
  it.each(cases)("keeps $case distinct from completed no-route", (row) => {
    expect(parseOtpWalkSearch(row.proof, expectations(row))).toMatchObject({
      status: "endpoint_blocked",
    });
  });

  it.each([
    { schemaVersion: "1" },
    { endpointConstraint: null },
    { nativeOutcome: "EXHAUSTED" },
    { durationLimitPruned: true },
    { status: "COMPLETED_NO_ROUTE", nativeOutcome: "EXHAUSTED" },
    { status: "FOUND", nativeOutcome: "TARGET_REACHED" },
  ])("rejects contradictory completion: %j", (mutation) => {
    expect(
      parseOtpWalkSearch({ ...cut.proof, ...mutation }, expectations(cut))
        .status,
    ).toBe("unavailable");
  });

  it.each([
    { scope: "ALL_POSSIBLE_ATTACHMENTS" },
    { endpoint: "VIA" },
    { phase: "UNKNOWN" },
    { blockedCandidateCount: 0 },
    { blockedCandidateCount: 1.5 },
    { reasons: [] },
    { reasons: ["UNKNOWN_SLOPE"] },
    { reasons: ["KNOWN_WIDTH", "KNOWN_WIDTH"] },
    { phase: "LINK", reasons: ["KNOWN_NON_STAIR_SLOPE"] },
    { phase: "TERMINAL_CUT", endpoint: "FROM" },
  ])("rejects incomplete or unsupported refusal: %j", (mutation) => {
    if (cut.proof.schemaVersion !== "2") throw new Error("Expected v2 capture");
    const proof = {
      ...cut.proof,
      endpointConstraint: { ...cut.proof.endpointConstraint, ...mutation },
    };
    expect(parseOtpWalkSearch(proof, expectations(cut)).status).toBe(
      "unavailable",
    );
  });

  it("does not authorize a different request or profile", () => {
    const expected = expectations(cut);
    expect(
      parseOtpWalkSearch(cut.proof, {
        ...expected,
        departureTimeMs: expected.departureTimeMs + 1000,
      }).status,
    ).toBe("unavailable");
    expect(
      parseOtpWalkSearch(cut.proof, {
        ...expected,
        origin: expected.destination,
      }).status,
    ).toBe("unavailable");
    expect(
      parseOtpWalkSearch(cut.proof, { ...expected, profile: "NORMAL" }).status,
    ).toBe("unavailable");
  });
});

function setup(row: (typeof cases)[number]) {
  const identity = row.response.data.requestIdentity;
  const manifest = identity.buildManifestIdentity;
  const runtime = identity.runtimePolicyIdentity;
  vi.setSystemTime(row.proof.departureTimeMs);
  vi.mocked(getReviewedOtpWalkPolicies).mockReturnValue([
    {
      artifactSha256: runtime.artifactSha256,
      manifestSha256: runtime.manifestSha256,
      observedClassDigestSha256: runtime.observedClassDigestSha256,
      classCount: runtime.classCount,
    },
  ]);
  const currentSource = {
    status: "ready" as const,
    identity: {
      sourceVersionId: manifest.sourceVersion,
      sourceBatch: manifest.sourceBatch,
      archiveSha256: manifest.sourceArchiveSha256,
    },
  };
  vi.mocked(readCurrentSidewalkSourceIdentity).mockResolvedValue(currentSource);
  vi.mocked(fetchOtpWalkIdentityResponse).mockResolvedValue({
    status: "received",
    data: { data: { requestIdentity: identity } },
  });
  vi.mocked(fetchOtpWalkPlanResponse).mockResolvedValue({
    status: "received",
    data: row.response,
  });
  return {
    currentSource,
    options: {
      points: [expectations(row).origin, expectations(row).destination],
      mode: "wheelchair" as const,
      avoidStairs: true,
      departureTimeMs: row.proof.departureTimeMs,
      deadlineMs: Date.now() + 10000,
    },
  };
}

describe("endpoint refusal currentness and fallback boundary", () => {
  const strictCases = cases.filter(
    (row) => row.proof.executedPolicy.profile === "WHEELCHAIR_STRICT",
  );
  it("preserves the actual first-segment arrival and reports the final point without a partial route", async () => {
    const first = waypointCapture.cases[0];
    const second = waypointCapture.cases[1];
    const row = {
      ...first,
      proof: OtpDirectWalkSearchSchema.parse(
        first.response.data.plan.directWalkSearch,
      ),
    };
    const { options } = setup(row);
    options.points = waypointCapture.chain.coordinates.map((point) => ({
      lat: point.lat,
      lng: point.lon,
    }));
    vi.mocked(fetchOtpWalkPlanResponse)
      .mockResolvedValueOnce({ status: "received", data: first.response })
      .mockResolvedValueOnce({ status: "received", data: second.response });
    expect(await planQualifiedOtpWalk(options)).toEqual({
      status: "endpoint_blocked",
      endpointConstraint: { pointIndex: 2, reasons: ["KNOWN_WIDTH"] },
    });
    expect(fetchOtpWalkPlanResponse).toHaveBeenCalledTimes(2);
    expect(
      vi
        .mocked(fetchOtpWalkPlanResponse)
        .mock.calls.map(([request]) => request.time),
    ).toEqual(["18:00:07", "18:00:20"]);
    expect(second.response.data.plan.directWalkSearch.departureTimeMs).toBe(
      first.response.data.plan.itineraries[0].legs[0].endTime,
    );
    expect(fetchOtpWalkIdentityResponse).toHaveBeenCalledTimes(2);
    expect(readCurrentSidewalkSourceIdentity).toHaveBeenCalledTimes(4);
  });

  it.each([false, true])(
    "rechecks currentness for a defensive assisted refusal (source changed: %s)",
    async (changed) => {
      const row = cases.find(
        (item) =>
          item.proof.executedPolicy.profile === "WHEELCHAIR_STAIRS_ASSISTED",
      );
      if (
        !row ||
        row.proof.schemaVersion !== "2" ||
        !row.proof.endpointConstraint
      )
        throw new Error("Missing assisted capture");
      const { options, currentSource } = setup(row);
      // Synthetic protocol sequencing only: a stable native graph cannot defer this
      // profile-invariant width/slope refusal until after a strict exhausted search.
      const syntheticStrict = {
        data: {
          ...row.response.data,
          plan: {
            itineraries: [],
            routingErrors: [],
            directWalkSearch: {
              ...row.proof,
              status: "COMPLETED_NO_ROUTE",
              nativeOutcome: "EXHAUSTED",
              endpointConstraint: null,
              executedPolicy: {
                ...row.proof.executedPolicy,
                profile: "WHEELCHAIR_STRICT",
              },
            },
          },
        },
      };
      vi.mocked(fetchOtpWalkPlanResponse)
        .mockResolvedValueOnce({ status: "received", data: syntheticStrict })
        .mockResolvedValueOnce({ status: "received", data: row.response });
      if (changed)
        vi.mocked(readCurrentSidewalkSourceIdentity)
          .mockResolvedValueOnce(currentSource)
          .mockResolvedValueOnce(currentSource)
          .mockResolvedValueOnce({
            status: "unavailable",
            reason: "no_active_source",
          });
      expect(await planQualifiedOtpWalk(options)).toEqual(
        changed
          ? { status: "unavailable", reason: "source_mismatch" }
          : {
              status: "endpoint_blocked",
              endpointConstraint: {
                pointIndex:
                  row.proof.endpointConstraint.endpoint === "FROM" ? 0 : 1,
                reasons: row.proof.endpointConstraint.reasons,
              },
            },
      );
      expect(
        vi
          .mocked(fetchOtpWalkPlanResponse)
          .mock.calls.map(([request]) => request.profile),
      ).toEqual(["WHEELCHAIR_STRICT", "WHEELCHAIR_STAIRS_ASSISTED"]);
      expect(readCurrentSidewalkSourceIdentity).toHaveBeenCalledTimes(
        changed ? 3 : 4,
      );
    },
  );

  it.each(strictCases)(
    "returns the correct endpoint for $case after currentness recheck",
    async (row) => {
      const { options } = setup(row);
      if (row.proof.schemaVersion !== "2" || !row.proof.endpointConstraint)
        throw new Error("Missing refusal");
      expect(await planQualifiedOtpWalk(options)).toEqual({
        status: "endpoint_blocked",
        endpointConstraint: {
          pointIndex: row.proof.endpointConstraint.endpoint === "FROM" ? 0 : 1,
          reasons: row.proof.endpointConstraint.reasons,
        },
      });
      expect(fetchOtpWalkIdentityResponse).toHaveBeenCalledTimes(2);
      expect(readCurrentSidewalkSourceIdentity).toHaveBeenCalledTimes(4);
      expect(fetchOtpWalkPlanResponse).toHaveBeenCalledTimes(1);
      expect(vi.mocked(fetchOtpWalkPlanResponse).mock.calls[0][0].profile).toBe(
        "WHEELCHAIR_STRICT",
      );
    },
  );

  it("does not return a refusal after the ACTIVE source changes", async () => {
    const row = strictCases[0];
    if (!row) throw new Error("Missing strict capture");
    const { options, currentSource } = setup(row);
    vi.mocked(readCurrentSidewalkSourceIdentity)
      .mockResolvedValueOnce(currentSource)
      .mockResolvedValueOnce(currentSource)
      .mockResolvedValueOnce({
        status: "unavailable",
        reason: "no_active_source",
      });
    expect(await planQualifiedOtpWalk(options)).toEqual({
      status: "unavailable",
      reason: "source_mismatch",
    });
    expect(fetchOtpWalkPlanResponse).toHaveBeenCalledTimes(1);
  });

  it("does not return a refusal when the final provider identity is unavailable", async () => {
    const row = strictCases[0];
    if (!row) throw new Error("Missing strict capture");
    const { options } = setup(row);
    vi.mocked(fetchOtpWalkIdentityResponse)
      .mockResolvedValueOnce({
        status: "received",
        data: { data: { requestIdentity: row.response.data.requestIdentity } },
      })
      .mockResolvedValueOnce({
        status: "unavailable",
        reason: "transport_error",
      });
    expect((await planQualifiedOtpWalk(options)).status).toBe("unavailable");
    expect(fetchOtpWalkPlanResponse).toHaveBeenCalledTimes(1);
  });

  it("does not return a refusal when the loaded graph changes before the final check", async () => {
    const row = strictCases[0];
    if (!row) throw new Error("Missing strict capture");
    const { options } = setup(row);
    const changed = structuredClone(row.response.data.requestIdentity);
    changed.graphByteIdentity.sha256 = "a".repeat(64);
    changed.buildManifestIdentity.graphSha256 = "a".repeat(64);
    vi.mocked(fetchOtpWalkIdentityResponse)
      .mockResolvedValueOnce({
        status: "received",
        data: { data: { requestIdentity: row.response.data.requestIdentity } },
      })
      .mockResolvedValueOnce({
        status: "received",
        data: { data: { requestIdentity: changed } },
      });
    expect(await planQualifiedOtpWalk(options)).toEqual({
      status: "unavailable",
      reason: "identity_changed",
    });
    expect(fetchOtpWalkPlanResponse).toHaveBeenCalledTimes(1);
  });

  it("keeps the original deadline through the final currentness check", async () => {
    const row = strictCases[0];
    if (!row) throw new Error("Missing strict capture");
    const { options, currentSource } = setup(row);
    vi.mocked(readCurrentSidewalkSourceIdentity)
      .mockResolvedValueOnce(currentSource)
      .mockResolvedValueOnce(currentSource)
      .mockImplementationOnce(async () => {
        vi.setSystemTime(options.deadlineMs);
        return currentSource;
      });
    expect(await planQualifiedOtpWalk(options)).toEqual({
      status: "unavailable",
      reason: "deadline_exceeded",
    });
    expect(fetchOtpWalkPlanResponse).toHaveBeenCalledTimes(1);
  });

  it.each(["unexpected error", "missing link error", "unexpected itinerary"])(
    "rejects a refusal with %s",
    async (mutation) => {
      const row = strictCases.find(
        (item) =>
          item.proof.schemaVersion === "2" &&
          item.proof.endpointConstraint?.phase === "LINK",
      );
      if (!row) throw new Error("Missing strict LINK capture");
      const { options } = setup(row);
      const raw = structuredClone(row.response);
      const plan = {
        ...raw.data.plan,
        routingErrors:
          mutation === "missing link error"
            ? []
            : mutation === "unexpected error"
              ? [{ code: "SYSTEM_ERROR" }]
              : raw.data.plan.routingErrors,
        itineraries: mutation === "unexpected itinerary" ? [{ legs: [] }] : [],
      };
      vi.mocked(fetchOtpWalkPlanResponse).mockResolvedValue({
        status: "received",
        data: { data: { ...raw.data, plan } },
      });
      expect((await planQualifiedOtpWalk(options)).status).toBe("unavailable");
      expect(fetchOtpWalkPlanResponse).toHaveBeenCalledTimes(1);
    },
  );
});
