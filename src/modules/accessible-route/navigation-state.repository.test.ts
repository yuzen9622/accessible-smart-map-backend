import Redis from "ioredis";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const { evalRedis, getRedis, setRedis, delRedis, redisReady } = vi.hoisted(
  () => ({
    evalRedis: vi.fn(),
    getRedis: vi.fn(),
    setRedis: vi.fn(),
    delRedis: vi.fn(),
    redisReady: vi.fn().mockResolvedValue(undefined),
  }),
);

vi.mock("../../config/redis", () => ({
  redisReady,
  redisClient: {
    status: "ready",
    eval: evalRedis,
    get: getRedis,
    set: setRedis,
    del: delRedis,
  },
}));

import {
  beginNavigationResume,
  sealNavigationEnvelope,
  verifyNavigationEnvelopeIntegrity,
  beginReroute,
  commitNavigationResume,
  deleteNavigationSnapshot,
  finalizeReroute,
  getNavigationSnapshot,
  getAdoptedCandidateReplacement,
  getNavigationStopStatus,
  markNavigationStopped,
  readNavigationTokenStrict,
  resolveCandidateDecision,
  recoverCandidateDecision,
  releaseNavigationResume,
  type CandidateDecision,
  storeInitialNavigationEnvelope,
  storeNavigationSnapshot,
  type NavigationSessionSnapshot,
} from "./navigation-state.repository";

const snapshot: NavigationSessionSnapshot = {
  navigationId: "nav",
  userId: "user-1",
  routeToken: "token",
  routeVersion: 2,
  currentStepIndex: 3,
  onVehicle: true,
  latestPosition: { latitude: 25, longitude: 121, heading: 90 },
  updatedAt: 1_700_000_000_000,
};

const envelope = sealNavigationEnvelope({
  schemaVersion: 1 as const,
  route: {
    routeId: "route",
    routeName: "walk",
    totalMinutes: 1,
    transferCount: 0,
    legs: [],
    accessibilityHighlights: [],
  },
  navigationId: "nav",
  routeVersion: 1,
  canonicalRequest: {
    origin: { latitude: 25, longitude: 121 },
    destination: { latitude: 25.1, longitude: 121.1 },
    userLocation: { latitude: 25, longitude: 121 },
    travelMode: "walk" as const,
    mode: "normal" as const,
    maxTransfers: 2,
    format: "standard" as const,
    waypoints: [],
    avoidStairs: false,
    requireElevator: false,
    needsAccessibleToilet: false,
    needsHandrail: false,
  },
});

describe("navigation envelope wire integrity", () => {
  it("is idempotent and independent of object key order and omitted wire fields", () => {
    const input = {
      ...envelope,
      route: { ...envelope.route, warnings: undefined },
    };
    Object.defineProperty(input.route, "privateState", {
      value: "not-on-wire",
    });
    const sealed = sealNavigationEnvelope(input);
    expect(sealNavigationEnvelope(sealed)).toEqual(sealed);
    const wire = JSON.parse(JSON.stringify(sealed));
    wire.route = Object.fromEntries(Object.entries(wire.route).reverse());
    expect(verifyNavigationEnvelopeIntegrity(wire)).toBe(true);
    expect(
      verifyNavigationEnvelopeIntegrity({ ...wire, integrity: undefined }),
    ).toBe(false);
  });

  it.each([
    "route",
    "navigationId",
    "routeVersion",
    "canonicalRequest",
    "schemaVersion",
  ])("detects damage to protected field %s", (key) => {
    const damaged = JSON.parse(
      JSON.stringify(sealNavigationEnvelope(envelope)),
    );
    delete damaged[key];
    expect(verifyNavigationEnvelopeIntegrity(damaged)).toBe(false);
  });
});

describe("navigation-state repository Lua tri-state", () => {
  beforeEach(() => vi.clearAllMocks());

  it("fails closed when adopted resume proof is unavailable or malformed", async () => {
    evalRedis.mockRejectedValueOnce(new Error("offline"));
    expect(await getAdoptedCandidateReplacement(snapshot, "old", 1)).toBeNull();
    evalRedis.mockResolvedValueOnce("not-json");
    expect(await getAdoptedCandidateReplacement(snapshot, "old", 1)).toBeNull();
  });
  it("atomically stores the initial envelope and v1 head", async () => {
    evalRedis.mockResolvedValue(1);
    await expect(
      storeInitialNavigationEnvelope("token", envelope),
    ).resolves.toBe(true);
    expect(evalRedis).toHaveBeenCalledWith(
      expect.stringContaining('redis.call("SET", KEYS[1]'),
      2,
      "voice-nav:route:token",
      "voice-nav:head:nav",
      JSON.stringify(sealNavigationEnvelope(envelope)),
      "1800",
    );
  });

  it.each([
    [["acquired", ""], { status: "acquired" }],
    [["reconciling", ""], { status: "reconciling" }],
    [["stale", "2"], { status: "stale" }],
    [["conflict", "other"], { status: "conflict" }],
  ])("maps begin Lua result %j without fail-open", async (raw, expected) => {
    evalRedis.mockResolvedValue(raw);
    await expect(beginReroute("nav", 1, "request")).resolves.toEqual(expected);
  });

  it("replays the completed result with replayed=true", async () => {
    evalRedis.mockResolvedValue([
      "replay",
      JSON.stringify({ routeToken: "same", routeVersion: 2, replayed: false }),
    ]);
    await expect(beginReroute("nav", 1, "request")).resolves.toMatchObject({
      status: "replay",
      data: { routeToken: "same", routeVersion: 2, replayed: true },
    });
  });

  it("fails closed when strict reads cannot reach Redis", async () => {
    redisReady.mockRejectedValueOnce(new Error("down"));
    await expect(readNavigationTokenStrict("token")).resolves.toEqual({
      status: "unavailable",
    });
  });

  it("finalizes token, head and idempotency result in one Lua call", async () => {
    evalRedis.mockResolvedValue(["ok", ""]);
    const nextEnvelope = { ...envelope, routeVersion: 2 };
    const data = {
      navigationId: "nav",
      previousRouteVersion: 1,
      routeVersion: 2,
      routeToken: "next",
      route: envelope.route,
      instructions: [],
      steps: [],
      warnings: [],
      currentStepIndex: 0 as const,
      replayed: false,
    };
    await expect(
      finalizeReroute(1, "request", "next", nextEnvelope, data),
    ).resolves.toBe("ok");
    expect(evalRedis).toHaveBeenCalledWith(
      expect.stringContaining('redis.call("SET", KEYS[3]'),
      6,
      "voice-nav:reroute-lock:nav:1",
      "voice-nav:head:nav",
      "voice-nav:route:next",
      "voice-nav:reroute-completed:nav:request",
      "voice-nav:candidate-decision:nav",
      "voice-nav:resume-lock:nav",
      "request",
      "1",
      JSON.stringify(sealNavigationEnvelope(nextEnvelope)),
      "1800",
      "2",
      JSON.stringify(data),
    );
  });
});

describe("navigation session snapshot", () => {
  beforeEach(() => vi.clearAllMocks());

  it("writes the snapshot under its own key with the sliding 30 minute TTL", async () => {
    setRedis.mockResolvedValue("OK");
    await storeNavigationSnapshot(snapshot);
    expect(evalRedis).toHaveBeenCalledWith(
      expect.stringContaining("old.routeVersion > snapshot.routeVersion"),
      4,
      "voice-nav:snapshot:nav",
      "voice-nav:head:nav",
      "voice-nav:stopped:nav",
      "voice-nav:candidate-decision:nav",
      JSON.stringify(snapshot),
      "1800",
    );
  });

  it("honours an explicit ttl override", async () => {
    setRedis.mockResolvedValue("OK");
    await storeNavigationSnapshot(snapshot, 60);
    expect(evalRedis).toHaveBeenCalledWith(
      expect.any(String),
      4,
      expect.any(String),
      expect.any(String),
      expect.any(String),
      expect.any(String),
      JSON.stringify(snapshot),
      "60",
    );
  });

  it("round-trips a stored snapshot", async () => {
    getRedis.mockResolvedValue(JSON.stringify(snapshot));
    await expect(getNavigationSnapshot("nav")).resolves.toEqual(snapshot);
    expect(getRedis).toHaveBeenCalledWith("voice-nav:snapshot:nav");
  });

  it("returns null for a missing key", async () => {
    getRedis.mockResolvedValue(null);
    await expect(getNavigationSnapshot("nav")).resolves.toBeNull();
  });

  it.each([
    ["unparseable json", "{not json"],
    ["a non-object payload", '"nav"'],
    [
      "a snapshot missing userId",
      JSON.stringify({ ...snapshot, userId: undefined }),
    ],
    [
      "a fractional routeVersion",
      JSON.stringify({ ...snapshot, routeVersion: 1.5 }),
    ],
    [
      "a non-boolean onVehicle",
      JSON.stringify({ ...snapshot, onVehicle: "yes" }),
    ],
    [
      "a malformed position",
      JSON.stringify({ ...snapshot, latestPosition: { latitude: 25 } }),
    ],
  ])("rejects %s", async (_label, raw) => {
    getRedis.mockResolvedValue(raw);
    await expect(getNavigationSnapshot("nav")).resolves.toBeNull();
  });

  it("accepts a snapshot without a position", async () => {
    getRedis.mockResolvedValue(
      JSON.stringify({ ...snapshot, latestPosition: null }),
    );
    await expect(getNavigationSnapshot("nav")).resolves.toMatchObject({
      latestPosition: null,
    });
  });

  it("deletes the snapshot key with user ownership verification", async () => {
    evalRedis.mockResolvedValue(1);
    await deleteNavigationSnapshot("nav", "u");
    expect(evalRedis).toHaveBeenCalledWith(
      expect.any(String),
      3,
      "voice-nav:snapshot:nav",
      "voice-nav:stopped:nav",
      "voice-nav:resume-lock:nav",
      "u",
      "1800",
    );
  });

  it("acquires and releases the atomic resume fence", async () => {
    evalRedis
      .mockResolvedValueOnce("acquired")
      .mockResolvedValueOnce("committed")
      .mockResolvedValueOnce(1);
    await expect(beginNavigationResume(snapshot, "attempt")).resolves.toBe(
      "acquired",
    );
    expect(evalRedis).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('return "acquired"'),
      5,
      "voice-nav:snapshot:nav",
      "voice-nav:stopped:nav",
      "voice-nav:resume-lock:nav",
      "voice-nav:head:nav",
      "voice-nav:candidate-decision:nav",
      "user-1",
      "token",
      "2",
      "attempt",
      "10",
    );
    await expect(commitNavigationResume(snapshot, "attempt")).resolves.toBe(
      "committed",
    );
    expect(evalRedis).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('return "committed"'),
      5,
      "voice-nav:resume-lock:nav",
      "voice-nav:stopped:nav",
      "voice-nav:snapshot:nav",
      "voice-nav:head:nav",
      "voice-nav:candidate-decision:nav",
      "user-1",
      "attempt",
      "10",
      "token",
      "2",
    );
    await releaseNavigationResume("nav", "attempt");
    expect(evalRedis).toHaveBeenNthCalledWith(
      3,
      expect.any(String),
      1,
      "voice-nav:resume-lock:nav",
      "attempt",
    );
  });

  it("returns strict stop persistence and tombstone status", async () => {
    evalRedis.mockResolvedValue("stopped");
    await expect(markNavigationStopped("nav", "u")).resolves.toBe("stopped");
    getRedis.mockResolvedValueOnce("u");
    await expect(getNavigationStopStatus("nav", "u")).resolves.toBe("stopped");
    getRedis.mockResolvedValueOnce(null);
    await expect(getNavigationStopStatus("nav", "u")).resolves.toBe("active");
  });

  it("fails soft when Redis is unavailable", async () => {
    redisReady.mockRejectedValue(new Error("down"));
    await expect(storeNavigationSnapshot(snapshot)).resolves.toBeUndefined();
    await expect(getNavigationSnapshot("nav")).resolves.toBeNull();
    await expect(deleteNavigationSnapshot("nav", "u")).resolves.toBeUndefined();
    await expect(markNavigationStopped("nav", "u")).resolves.toBe(
      "unavailable",
    );
    await expect(getNavigationStopStatus("nav", "u")).resolves.toBe(
      "unavailable",
    );
    expect(setRedis).not.toHaveBeenCalled();
    expect(evalRedis).not.toHaveBeenCalled();
  });
});

// Run only against a disposable local Redis: CANDIDATE_REDIS_TEST_URL=redis://127.0.0.1:<port>.
describe.runIf(Boolean(process.env.CANDIDATE_REDIS_TEST_URL))(
  "candidate decision real Redis Lua",
  () => {
    let client: Redis;
    const nextEnvelope = sealNavigationEnvelope({
      ...envelope,
      routeVersion: 2,
      route: { ...envelope.route, navigationId: "nav", routeVersion: 2 },
    });
    const data = {
      navigationId: "nav",
      previousRouteVersion: 1,
      routeVersion: 2,
      routeToken: "next",
      route: nextEnvelope.route,
      instructions: [],
      steps: [],
      warnings: [],
      currentStepIndex: 0 as const,
      replayed: false,
    };
    const decision: CandidateDecision = {
      createdAt: Date.now(),
      state: "PENDING_DECISION",
      navigationId: "nav",
      previousVersion: 1,
      nextVersion: 2,
      oldToken: "old",
      newToken: "next",
      proposalId: "p",
    };
    beforeAll(() => {
      client = new Redis(process.env.CANDIDATE_REDIS_TEST_URL!);
    });
    afterAll(async () => {
      await client?.quit();
    });
    beforeEach(async () => {
      await client.flushdb();
      redisReady.mockResolvedValue(undefined);
      evalRedis.mockImplementation((...args: any[]) =>
        client.eval(...(args as [string, number, ...string[]])),
      );
      getRedis.mockImplementation((key: string) => client.get(key));
      await storeInitialNavigationEnvelope("old", envelope);
    });
    const finalize = async () => {
      expect(await beginReroute("nav", 1, "p")).toEqual({ status: "acquired" });
      expect(
        await finalizeReroute(1, "p", "next", nextEnvelope, data, decision),
      ).toBe("ok");
    };
    it("finalize atomically writes head/token/completed/PENDING and releases lock", async () => {
      await finalize();
      expect(
        await client.mget(
          "voice-nav:head:nav",
          "voice-nav:route:next",
          "voice-nav:reroute-completed:nav:p",
          "voice-nav:reroute-lock:nav:1",
        ),
      ).toEqual([
        "2",
        JSON.stringify(nextEnvelope),
        JSON.stringify(data),
        null,
      ]);
      expect(
        JSON.parse((await client.get("voice-nav:candidate-decision:nav"))!)
          .state,
      ).toBe("PENDING_DECISION");
      expect(await beginReroute("nav", 2, "other")).toEqual({
        status: "reconciling",
      });
    });
    it("lost finalize reply probes exact commit then persists ADOPTED+snapshot atomically", async () => {
      await finalize();
      expect(
        await resolveCandidateDecision(decision, nextEnvelope, data, "probe"),
      ).toBe("PENDING_DECISION");
      expect(
        await resolveCandidateDecision(decision, nextEnvelope, data, "adopt", {
          ...snapshot,
          routeToken: "next",
        }),
      ).toBe("ADOPTED");
      expect(await getNavigationSnapshot("nav")).toMatchObject({
        routeToken: "next",
        routeVersion: 2,
      });
      // Restart/retry cannot roll back a published navigation.
      expect(await recoverCandidateDecision("nav")).toBe("ADOPTED");
      expect(
        await resolveCandidateDecision(
          decision,
          nextEnvelope,
          data,
          "rollback",
        ),
      ).toBe("ADOPTED");
      expect((await beginReroute("nav", 2, "other")).status).toBe("acquired");
    });
    it("resume proof requires ADOPTED and exactly the matching old/new token and versions", async () => {
      await finalize();
      const nextSnapshot = { ...snapshot, routeToken: "next" };
      expect(
        await getAdoptedCandidateReplacement(nextSnapshot, "old", 1),
      ).toBeNull();
      await resolveCandidateDecision(
        decision,
        nextEnvelope,
        data,
        "adopt",
        nextSnapshot,
      );
      expect(
        await getAdoptedCandidateReplacement(nextSnapshot, "old", 1),
      ).toEqual(data);
      expect(
        await getAdoptedCandidateReplacement(nextSnapshot, "wrong", 1),
      ).toBeNull();
      expect(
        await getAdoptedCandidateReplacement(nextSnapshot, "old", 0),
      ).toBeNull();
      await client.set("voice-nav:head:nav", "3");
      expect(
        await getAdoptedCandidateReplacement(nextSnapshot, "old", 1),
      ).toBeNull();
    });
    it("unpublished PENDING recovers by rollback and old token can reroute", async () => {
      await finalize();
      expect(await recoverCandidateDecision("nav")).toBe("ROLLED_BACK");
      expect(
        await client.mget(
          "voice-nav:head:nav",
          "voice-nav:route:next",
          "voice-nav:reroute-completed:nav:p",
          "voice-nav:reroute-lock:nav:1",
        ),
      ).toEqual(["1", null, null, null]);
      expect(await readNavigationTokenStrict("old")).toEqual({
        status: "ok",
        value: envelope,
      });
      expect((await beginReroute("nav", 1, "retry")).status).toBe("acquired");
    });
    it("ROLLBACK_REQUIRED resumes; repeated lost rollback reply is harmless", async () => {
      await finalize();
      await client.set(
        "voice-nav:candidate-decision:nav",
        JSON.stringify({ ...decision, state: "ROLLBACK_REQUIRED" }),
      );
      expect(await recoverCandidateDecision("nav")).toBe("ROLLED_BACK");
      expect(await recoverCandidateDecision("nav")).toBe("missing");
      expect(await client.get("voice-nav:head:nav")).toBe("1");
    });
    it("conditional rollback never regresses a newer head", async () => {
      await finalize();
      await client.set("voice-nav:head:nav", "3");
      expect(await recoverCandidateDecision("nav")).toBe("mismatch");
      expect(await client.get("voice-nav:head:nav")).toBe("3");
    });
    it("old snapshot cannot overwrite adopted version and stop cannot resurrect snapshot", async () => {
      await finalize();
      await resolveCandidateDecision(decision, nextEnvelope, data, "adopt", {
        ...snapshot,
        routeToken: "next",
      });
      await storeNavigationSnapshot({
        ...snapshot,
        routeVersion: 1,
        routeToken: "old",
        updatedAt: Date.now(),
      });
      expect(await getNavigationSnapshot("nav")).toMatchObject({
        routeVersion: 2,
        routeToken: "next",
      });
      await deleteNavigationSnapshot("nav", "user-1");
      await storeNavigationSnapshot({
        ...snapshot,
        routeToken: "next",
        updatedAt: Date.now(),
      });
      expect(await getNavigationSnapshot("nav")).toBeNull();
    });
    it("lets stop cancel a pending resume before publication", async () => {
      await storeNavigationSnapshot({
        ...snapshot,
        routeVersion: 1,
        routeToken: "old",
        updatedAt: Date.now(),
      });
      const saved = await getNavigationSnapshot("nav");
      if (!saved) throw new Error("expected stored snapshot");
      expect(await beginNavigationResume(saved, "resume-attempt")).toBe(
        "acquired",
      );

      await expect(markNavigationStopped("nav", "user-1")).resolves.toBe(
        "stopped",
      );
      await expect(
        commitNavigationResume(saved, "resume-attempt"),
      ).resolves.toBe("stopped");
      await releaseNavigationResume("nav", "resume-attempt");
      expect(await getNavigationSnapshot("nav")).toBeNull();
    });

    it("orders stop after a committed resume publication fence", async () => {
      await storeNavigationSnapshot({
        ...snapshot,
        routeVersion: 1,
        routeToken: "old",
        updatedAt: Date.now(),
      });
      const saved = await getNavigationSnapshot("nav");
      if (!saved) throw new Error("expected stored snapshot");
      expect(await beginNavigationResume(saved, "resume-attempt")).toBe(
        "acquired",
      );
      expect(await commitNavigationResume(saved, "resume-attempt")).toBe(
        "committed",
      );

      let stopped = false;
      const stopping = markNavigationStopped("nav", "user-1").then((status) => {
        stopped = true;
        return status;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(stopped).toBe(false);
      await releaseNavigationResume("nav", "resume-attempt");
      await expect(stopping).resolves.toBe("stopped");
    });

    it("durably records stop when a committed resume owner disappears", async () => {
      await storeNavigationSnapshot({
        ...snapshot,
        routeVersion: 1,
        routeToken: "old",
        updatedAt: Date.now(),
      });
      const saved = await getNavigationSnapshot("nav");
      if (!saved) throw new Error("expected stored snapshot");
      expect(await beginNavigationResume(saved, "orphaned-resume")).toBe(
        "acquired",
      );
      expect(await commitNavigationResume(saved, "orphaned-resume")).toBe(
        "committed",
      );
      await client.expire("voice-nav:resume-lock:nav", 1);

      await expect(markNavigationStopped("nav", "user-1")).resolves.toBe(
        "stopped",
      );
      expect(await client.get("voice-nav:stopped:nav")).toBe("user-1");
      expect(await getNavigationSnapshot("nav")).toBeNull();
    });

    it("prevents reroute finalization while resume publication is fenced", async () => {
      await storeNavigationSnapshot({
        ...snapshot,
        routeVersion: 1,
        routeToken: "old",
        updatedAt: Date.now(),
      });
      const saved = await getNavigationSnapshot("nav");
      if (!saved) throw new Error("expected stored snapshot");
      expect(await beginReroute("nav", 1, "p")).toEqual({
        status: "acquired",
      });
      expect(await beginNavigationResume(saved, "resume-attempt")).toBe(
        "acquired",
      );
      expect(
        await finalizeReroute(1, "p", "next", nextEnvelope, data, decision),
      ).toBe("conflict");
      expect(await commitNavigationResume(saved, "resume-attempt")).toBe(
        "committed",
      );
      await releaseNavigationResume("nav", "resume-attempt");
    });

    it("rejects resume commit if the durable route version advanced", async () => {
      await storeNavigationSnapshot({
        ...snapshot,
        routeVersion: 1,
        routeToken: "old",
        updatedAt: Date.now(),
      });
      const saved = await getNavigationSnapshot("nav");
      if (!saved) throw new Error("expected stored snapshot");
      expect(await beginNavigationResume(saved, "resume-attempt")).toBe(
        "acquired",
      );
      await client.set("voice-nav:head:nav", "2", "EX", 1800);
      expect(await commitNavigationResume(saved, "resume-attempt")).toBe(
        "stale",
      );
      await releaseNavigationResume("nav", "resume-attempt");
    });

    it("stop before adoption blocks publication", async () => {
      await finalize();
      await deleteNavigationSnapshot("nav", "user-1");
      expect(
        await resolveCandidateDecision(
          decision,
          nextEnvelope,
          data,
          "adopt",
          snapshot,
        ),
      ).toBe("ROLLBACK_REQUIRED");
      expect(await recoverCandidateDecision("nav")).toBe("ROLLED_BACK");
      expect(await getNavigationSnapshot("nav")).toBeNull();
    });
    it("expired lock cannot finalize or leave a candidate marker", async () => {
      await beginReroute("nav", 1, "p");
      await client.del("voice-nav:reroute-lock:nav:1");
      expect(
        await finalizeReroute(1, "p", "next", nextEnvelope, data, decision),
      ).toBe("conflict");
      expect(await client.get("voice-nav:head:nav")).toBe("1");
      expect(await client.get("voice-nav:candidate-decision:nav")).toBeNull();
    });
  },
);
