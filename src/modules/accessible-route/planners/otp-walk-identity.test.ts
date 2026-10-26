import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchOtpWalkIdentityResponse } from "../../../adapters/otp-walk.adapter";
import {
  fetchCurrentOtpWalkIdentity,
  parseOtpWalkIdentity,
  parseOtpWalkIdentityResponse,
  sameOtpWalkIdentity,
  type OtpWalkIdentityExpectations,
  type ReviewedOtpWalkPolicy,
} from "./otp-walk-identity";

vi.mock("../../../adapters/otp-walk.adapter", () => ({
  fetchOtpWalkIdentityResponse: vi.fn(),
}));

// Exact root_only HTTP payload from frozen otp-request-identity-eqcjub1c/http-results.json.
// Its native graph/build policy is v4 while the observed runtime is v6.
const recordedResponse = {
  data: {
    requestIdentity: {
      schemaVersion: "1",
      graphIdentityStatus: "VERIFIED_LOADED_BYTES",
      graphByteIdentity: {
        sha256:
          "217f5fab6b212258bb7b0cef148145498321c0b44acb7515cdc69e33ebd9e545",
        byteCount: 17380,
      },
      sourceManifestIdentityStatus: "VERIFIED_TRUSTED_BUILD_MANIFEST",
      buildManifestIdentity: {
        manifestSha256:
          "fe62b2982448da9dfaaf308b0f4bbd987137eea6f324755403cdeae37005f8a5",
        buildInputMode: "LOCAL_AUTO_DISCOVERY_NO_CACHE",
        graphSha256:
          "217f5fab6b212258bb7b0cef148145498321c0b44acb7515cdc69e33ebd9e545",
        graphByteCount: 17380,
        sourceVersion: "fixture",
        sourceBatch: "fixture",
        sourceArchiveSha256:
          "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        mergedPbfSha256:
          "e6ebfaa65d2bc3824d62eab94d63252a6c65721cbe3ce64ebf6f1512619bc46b",
        layerReportSha256:
          "5628dfaef12b3b46d0a377618971aa0bca05fbc00f2b06612cda70f215a8d56d",
        declaredBuildPolicyJarSha256:
          "6f30d750e7fcc488d3b38179ef4f2b2a3ef487aa0d3154bf7a89c2079cd9f379",
        inputs: [
          {
            path: "build-config.json",
            role: "CONFIG",
            sha256:
              "b09fb82a1684f01a4e374aaf102b78b5d782b64377c9bfaba8973fdacceefb21",
            byteCount: 187,
          },
          {
            path: "fixture.gtfs.zip",
            role: "GTFS",
            sha256:
              "adfea8fdd2c6d44703596d0dab4cdda7773082ca6b99302c3ec6fd35e77e1f66",
            byteCount: 1113,
          },
          {
            path: "merged.osm.pbf",
            role: "OSM",
            sha256:
              "e6ebfaa65d2bc3824d62eab94d63252a6c65721cbe3ce64ebf6f1512619bc46b",
            byteCount: 531,
          },
          {
            path: "router-config.json",
            role: "CONFIG",
            sha256:
              "c4f4eeaba54d9f6d3641064ff6260fbf59375479748d65a09e5e537b2fe742db",
            byteCount: 1593,
          },
        ],
        compilerArtifacts: [
          {
            path: "build-ped-graph.py",
            role: "DEPENDENCY",
            sha256:
              "0a3d15e6214b10b4339afbdefdfdb2a5f177c5e319ec260af42b4d26fa08777b",
            byteCount: 74699,
          },
          {
            path: "osm-area-polygon-features.json",
            role: "DEPENDENCY",
            sha256:
              "cf81018ba820557c59c2c27de7ea6b314009abed040cd11249e94ed1a3a10583",
            byteCount: 2753,
          },
          {
            path: "otp-sidewalk-layer.py",
            role: "COMPILER",
            sha256:
              "e73f8174c419eb388318c1d6b9ea5d7a4067784b031ec0787027704930a5ae03",
            byteCount: 85334,
          },
          {
            path: "otp-sidewalk-topology.py",
            role: "TOPOLOGY",
            sha256:
              "8ded213ec2056adc39a34509ae1e557485124b95830066b34aaf09e7180cc629",
            byteCount: 5987,
          },
          {
            path: "ped-osm-areas.py",
            role: "DEPENDENCY",
            sha256:
              "365fdfe73e5c48b4cea3e54dafa801517f857d1474098f1341c552f9f7dc5167",
            byteCount: 19272,
          },
          {
            path: "ped-sidewalk-network.py",
            role: "DEPENDENCY",
            sha256:
              "6958b609cc65208a2b83ff1aaf676bc632b2c3350db3a5e43bbaad45df567f23",
            byteCount: 56319,
          },
        ],
      },
      runtimePolicyIdentityStatus: "VERIFIED_OBSERVED_POLICY_CLASSES",
      runtimePolicyIdentity: {
        status: "VERIFIED_OBSERVED_POLICY_CLASSES",
        reason: "TRUSTED_LAUNCHER_BOUNDARY",
        artifactSha256:
          "c5170a9c929b39bbdd1ac4c22a89e002e0755beb692baa7d9a570b924082061d",
        manifestSha256:
          "2fe1171b0de010fa1077153ed846a72d89d6612d9cdab17624697cdc9856bca2",
        observedClassDigestSha256:
          "4a7b13246e5f167902bca07b9d28ba69f7ab808e309c9c1c7864ce1e1f4561fc",
        classCount: 29,
      },
    },
  },
};

const reviewedPolicy: ReviewedOtpWalkPolicy = {
  artifactSha256:
    "c5170a9c929b39bbdd1ac4c22a89e002e0755beb692baa7d9a570b924082061d",
  manifestSha256:
    "2fe1171b0de010fa1077153ed846a72d89d6612d9cdab17624697cdc9856bca2",
  observedClassDigestSha256:
    "4a7b13246e5f167902bca07b9d28ba69f7ab808e309c9c1c7864ce1e1f4561fc",
  classCount: 29,
};
const expected: OtpWalkIdentityExpectations = {
  sourceIdentity: {
    sourceVersionId: "fixture",
    sourceBatch: "fixture",
    archiveSha256: "f".repeat(64),
  },
  reviewedPolicies: [reviewedPolicy],
};
const rawIdentity = recordedResponse.data.requestIdentity;
const fetchResponse = vi.mocked(fetchOtpWalkIdentityResponse);

function parsedIdentity() {
  const result = parseOtpWalkIdentity(rawIdentity, expected);
  if (result.status !== "ready") throw new Error(result.reason);
  return result.identity;
}

beforeEach(() => vi.clearAllMocks());

describe("OTP request identity boundary", () => {
  it("rejects the real native response recorded without the observer or build attestation", () => {
    // observer_absent / root_only from the same frozen HTTP run.
    const unverified = {
      data: {
        requestIdentity: {
          schemaVersion: "1",
          graphIdentityStatus: "VERIFIED_LOADED_BYTES",
          graphByteIdentity: {
            sha256:
              "217f5fab6b212258bb7b0cef148145498321c0b44acb7515cdc69e33ebd9e545",
            byteCount: 17380,
          },
          sourceManifestIdentityStatus: "UNVERIFIED",
          buildManifestIdentity: null,
          runtimePolicyIdentityStatus: "UNVERIFIED",
          runtimePolicyIdentity: {
            status: "UNVERIFIED",
            reason: "STARTUP_NOT_VERIFIED",
            artifactSha256: null,
            manifestSha256: null,
            observedClassDigestSha256: null,
            classCount: 0,
          },
        },
      },
    };
    expect(parseOtpWalkIdentityResponse(unverified, expected)).toEqual({
      status: "unavailable",
      reason: "invalid_identity",
    });
  });
  it("retains the entire real native identity without equating build v4 to runtime v6", () => {
    const result = parseOtpWalkIdentityResponse(recordedResponse, expected);
    expect(result).toEqual({ status: "ready", identity: rawIdentity });
    const identity = parsedIdentity();
    expect(
      identity.buildManifestIdentity.declaredBuildPolicyJarSha256,
    ).not.toBe(identity.runtimePolicyIdentity.artifactSha256);
    expect(identity.buildManifestIdentity.inputs).toHaveLength(4);
    expect(identity.buildManifestIdentity.compilerArtifacts).toHaveLength(6);
  });

  it("does not turn a valid root identity into no-route when itinerary data is empty", () => {
    expect(
      parseOtpWalkIdentityResponse(
        {
          data: { ...recordedResponse.data, plan: { itineraries: [] } },
        },
        expected,
      ).status,
    ).toBe("ready");
  });

  it.each([
    { sourceVersionId: "2" },
    { sourceBatch: "202607" },
    { archiveSha256: "e".repeat(64) },
  ])("requires exact current source identity %j", (changed) => {
    expect(
      parseOtpWalkIdentity(rawIdentity, {
        ...expected,
        sourceIdentity: { ...expected.sourceIdentity, ...changed },
      }),
    ).toEqual({ status: "unavailable", reason: "source_mismatch" });
  });

  it.each([
    { artifactSha256: "a".repeat(64) },
    { manifestSha256: "a".repeat(64) },
    { observedClassDigestSha256: "a".repeat(64) },
    { classCount: 28 },
  ])("requires every reviewed runtime field %j", (changed) => {
    expect(
      parseOtpWalkIdentity(rawIdentity, {
        ...expected,
        reviewedPolicies: [{ ...reviewedPolicy, ...changed }],
      }),
    ).toEqual({ status: "unavailable", reason: "policy_not_reviewed" });
  });

  it("fails closed with no reviewed policy and permits an exact allowlist member", () => {
    expect(
      parseOtpWalkIdentity(rawIdentity, { ...expected, reviewedPolicies: [] }),
    ).toEqual({ status: "unavailable", reason: "policy_not_reviewed" });
    expect(
      parseOtpWalkIdentity(rawIdentity, {
        ...expected,
        reviewedPolicies: [
          { ...reviewedPolicy, classCount: 30 },
          reviewedPolicy,
        ],
      }).status,
    ).toBe("ready");
  });

  const defects: {
    label: string;
    change: (value: typeof rawIdentity) => unknown;
  }[] = [
    { label: "unknown schema", change: (v) => ({ ...v, schemaVersion: "2" }) },
    {
      label: "unverified graph",
      change: (v) => ({ ...v, graphIdentityStatus: "UNVERIFIED" }),
    },
    {
      label: "unverified source",
      change: (v) => ({ ...v, sourceManifestIdentityStatus: "UNVERIFIED" }),
    },
    {
      label: "unverified runtime",
      change: (v) => ({ ...v, runtimePolicyIdentityStatus: "UNVERIFIED" }),
    },
    {
      label: "absent graph",
      change: (v) => ({ ...v, graphByteIdentity: null }),
    },
    {
      label: "absent manifest",
      change: (v) => ({ ...v, buildManifestIdentity: null }),
    },
    {
      label: "absent runtime",
      change: (v) => ({ ...v, runtimePolicyIdentity: null }),
    },
    {
      label: "different graph hash",
      change: (v) => ({
        ...v,
        graphByteIdentity: { ...v.graphByteIdentity, sha256: "a".repeat(64) },
      }),
    },
    {
      label: "different graph count",
      change: (v) => ({
        ...v,
        graphByteIdentity: {
          ...v.graphByteIdentity,
          byteCount: v.graphByteIdentity.byteCount + 1,
        },
      }),
    },
    {
      label: "unsafe graph count",
      change: (v) => ({
        ...v,
        graphByteIdentity: {
          ...v.graphByteIdentity,
          byteCount: Number.MAX_SAFE_INTEGER + 1,
        },
      }),
    },
    {
      label: "string graph count",
      change: (v) => ({
        ...v,
        graphByteIdentity: { ...v.graphByteIdentity, byteCount: "17380" },
      }),
    },
    {
      label: "runtime status disagreement",
      change: (v) => ({
        ...v,
        runtimePolicyIdentity: {
          ...v.runtimePolicyIdentity,
          status: "UNVERIFIED",
        },
      }),
    },
    {
      label: "unsupported verification reason",
      change: (v) => ({
        ...v,
        runtimePolicyIdentity: {
          ...v.runtimePolicyIdentity,
          reason: "STARTUP_NOT_VERIFIED",
        },
      }),
    },
    {
      label: "zero classes",
      change: (v) => ({
        ...v,
        runtimePolicyIdentity: { ...v.runtimePolicyIdentity, classCount: 0 },
      }),
    },
    {
      label: "fractional classes",
      change: (v) => ({
        ...v,
        runtimePolicyIdentity: { ...v.runtimePolicyIdentity, classCount: 29.5 },
      }),
    },
    {
      label: "unobserved digest",
      change: (v) => ({
        ...v,
        runtimePolicyIdentity: {
          ...v.runtimePolicyIdentity,
          observedClassDigestSha256: null,
        },
      }),
    },
    {
      label: "blank source",
      change: (v) => ({
        ...v,
        buildManifestIdentity: {
          ...v.buildManifestIdentity,
          sourceVersion: " ",
        },
      }),
    },
    {
      label: "wrong input mode",
      change: (v) => ({
        ...v,
        buildManifestIdentity: {
          ...v.buildManifestIdentity,
          buildInputMode: "REMOTE",
        },
      }),
    },
    {
      label: "missing inputs",
      change: (v) => ({
        ...v,
        buildManifestIdentity: { ...v.buildManifestIdentity, inputs: [] },
      }),
    },
    {
      label: "missing compiler",
      change: (v) => ({
        ...v,
        buildManifestIdentity: {
          ...v.buildManifestIdentity,
          compilerArtifacts: v.buildManifestIdentity.compilerArtifacts.slice(1),
        },
      }),
    },
    {
      label: "duplicate input",
      change: (v) => ({
        ...v,
        buildManifestIdentity: {
          ...v.buildManifestIdentity,
          inputs: [
            ...v.buildManifestIdentity.inputs,
            ...v.buildManifestIdentity.inputs,
          ],
        },
      }),
    },
    {
      label: "mismatched merged PBF",
      change: (v) => ({
        ...v,
        buildManifestIdentity: {
          ...v.buildManifestIdentity,
          mergedPbfSha256: "a".repeat(64),
        },
      }),
    },
    {
      label: "bad input role",
      change: (v) => ({
        ...v,
        buildManifestIdentity: {
          ...v.buildManifestIdentity,
          inputs: v.buildManifestIdentity.inputs.map((a) => ({
            ...a,
            role: "OSM",
          })),
        },
      }),
    },
    {
      label: "path traversal",
      change: (v) => ({
        ...v,
        buildManifestIdentity: {
          ...v.buildManifestIdentity,
          inputs: v.buildManifestIdentity.inputs.map((a) => ({
            ...a,
            path: "../" + a.path,
          })),
        },
      }),
    },
    {
      label: "invalid input byte count",
      change: (v) => ({
        ...v,
        buildManifestIdentity: {
          ...v.buildManifestIdentity,
          inputs: v.buildManifestIdentity.inputs.map((a) => ({
            ...a,
            byteCount: -1,
          })),
        },
      }),
    },
    {
      label: "bad compiler role",
      change: (v) => ({
        ...v,
        buildManifestIdentity: {
          ...v.buildManifestIdentity,
          compilerArtifacts: v.buildManifestIdentity.compilerArtifacts.map(
            (a) => ({ ...a, role: "DEPENDENCY" }),
          ),
        },
      }),
    },
    {
      label: "extra invented capability",
      change: (v) => ({ ...v, completeWheelchairSafety: true }),
    },
  ];
  it.each(defects)("rejects $label", ({ change }) => {
    expect(
      parseOtpWalkIdentity(change(structuredClone(rawIdentity)), expected),
    ).toEqual({ status: "unavailable", reason: "invalid_identity" });
  });

  it.each([
    null,
    {},
    { data: null },
    { data: {} },
    { data: { requestIdentity: null } },
  ])("rejects missing response identity %j", (value) => {
    expect(parseOtpWalkIdentityResponse(value, expected)).toEqual({
      status: "unavailable",
      reason: "invalid_identity",
    });
  });
  it("rejects a GraphQL error even when a partial identity is present", () => {
    expect(
      parseOtpWalkIdentityResponse(
        { ...recordedResponse, errors: [{ message: "failed" }] },
        expected,
      ),
    ).toEqual({ status: "unavailable", reason: "graphql_error" });
  });

  it("compares all artifact identities while treating artifact list order as immaterial", () => {
    const left = parsedIdentity();
    const right = parsedIdentity();
    right.buildManifestIdentity.inputs.reverse();
    right.buildManifestIdentity.compilerArtifacts.reverse();
    expect(sameOtpWalkIdentity(left, right)).toBe(true);
    const artifact = right.buildManifestIdentity.inputs[0];
    if (!artifact) throw new Error("fixture lacks input");
    artifact.byteCount += 1;
    expect(sameOtpWalkIdentity(left, right)).toBe(false);
  });
  it.each(["graph", "source", "runtime", "manifest", "compiler"])(
    "detects changed %s identity",
    (field) => {
      const left = parsedIdentity();
      const right = parsedIdentity();
      if (field === "graph") right.graphByteIdentity.sha256 = "a".repeat(64);
      if (field === "source") right.buildManifestIdentity.sourceBatch = "new";
      if (field === "runtime")
        right.runtimePolicyIdentity.artifactSha256 = "a".repeat(64);
      if (field === "manifest")
        right.buildManifestIdentity.manifestSha256 = "a".repeat(64);
      if (field === "compiler")
        right.buildManifestIdentity.compilerArtifacts.pop();
      expect(sameOtpWalkIdentity(left, right)).toBe(false);
    },
  );
});

describe("current OTP identity read", () => {
  it("never promotes a verified response after the caller's deadline", async () => {
    vi.useFakeTimers();
    try {
      fetchResponse.mockImplementationOnce(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { status: "received", data: recordedResponse };
      });
      const pending = fetchCurrentOtpWalkIdentity({
        ...expected,
        deadlineMs: Date.now() + 10,
      });
      await vi.advanceTimersByTimeAsync(20);
      expect(await pending).toEqual({
        status: "unavailable",
        reason: "deadline_exceeded",
      });
    } finally {
      vi.useRealTimers();
    }
  });
  it("parses a fresh response each time instead of caching the earlier verification", async () => {
    fetchResponse
      .mockResolvedValueOnce({ status: "received", data: recordedResponse })
      .mockResolvedValueOnce({
        status: "received",
        data: {
          data: {
            requestIdentity: {
              ...rawIdentity,
              runtimePolicyIdentityStatus: "UNVERIFIED",
            },
          },
        },
      });
    const options = { ...expected, deadlineMs: Date.now() + 1000 };
    expect((await fetchCurrentOtpWalkIdentity(options)).status).toBe("ready");
    expect(await fetchCurrentOtpWalkIdentity(options)).toEqual({
      status: "unavailable",
      reason: "invalid_identity",
    });
    expect(fetchResponse).toHaveBeenCalledTimes(2);
    expect(fetchResponse).toHaveBeenCalledWith(options);
  });
  it("keeps identity transport failure distinct from a no-route result", async () => {
    fetchResponse.mockResolvedValue({
      status: "unavailable",
      reason: "timeout",
    });
    expect(
      await fetchCurrentOtpWalkIdentity({
        ...expected,
        deadlineMs: Date.now() + 1000,
      }),
    ).toEqual({ status: "unavailable", reason: "timeout" });
  });
});
