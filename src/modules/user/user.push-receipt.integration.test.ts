import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
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
import User from "../../model/user.model";
import AuthSession from "../../model/auth-session.model";
import PushToken from "../../model/push-token.model";
import PushReceipt from "../../model/push-receipt.model";
import DeletedAccount from "../../model/deleted-account.model";
import {
  EXPO_PUSH_RECEIPTS_URL,
  EXPO_PUSH_SEND_URL,
  PUSH_RECEIPT,
} from "../../constants/push";
import { createSession } from "./user.auth-session.repository";
import { deleteOwnedRecords } from "./user.account.repository";
import { registerPushToken, sendPushToUser } from "./user.push.service";
import * as receiptRepository from "./user.push-receipt.repository";
import {
  attachReceiptTicket,
  claimDueReceipt,
  finalizeReceipt,
  reserveReceiptAttempt,
} from "./user.push-receipt.repository";
import {
  runPushReceiptPass,
  startPushReceiptWorker,
} from "./user.push-receipt.worker";
import {
  clearMongoTestDatabase,
  startMongoTest,
  stopMongoTest,
  type MongoTestContext,
} from "../../../tests/helpers/mongo-test-harness";

type Receipts = Record<string, unknown>;
let receipts: Receipts = {};
let receiptStatus = 200;
let nextTicket = 0;
const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body));
  if (url === EXPO_PUSH_SEND_URL) {
    return Response.json({
      data: (body as unknown[]).map(() => ({
        status: "ok",
        id: `ticket-${++nextTicket}`,
      })),
    });
  }
  if (url === EXPO_PUSH_RECEIPTS_URL) {
    return Response.json({ data: receipts }, { status: receiptStatus });
  }
  throw new Error("unexpected url");
});
const calls = (target: string) =>
  fetchMock.mock.calls.filter(([url]) => url === target).length;
const build = () => ({ title: "PRIVATE TITLE", body: "PRIVATE BODY" });
const later = (ms: number) => new Date(Date.now() + ms);
const FIRST = PUSH_RECEIPT.firstDelayMs + 1_000;

async function setup(devices = 1) {
  const userId = new (await import("mongoose")).Types.ObjectId().toString();
  await User.create({ _id: userId, name: "t", email: `${userId}@x.test` });
  const session = await createSession({
    userId,
    currentRefreshJti: randomUUID(),
    expiresAt: later(3_600_000),
  });
  const tokens: string[] = [];
  for (let i = 0; i < devices; i++) {
    const token = `ExponentPushToken[${userId}-${i}]`;
    tokens.push(token);
    await registerPushToken({
      userId,
      authSessionId: session._id,
      token,
      platform: "ios",
      locale: "zh-TW",
    });
  }
  return { userId, sessionId: session._id, tokens };
}
const failpoint = (failCommands: string[], mode: object) =>
  mongoose.connection.db!.admin().command({
    configureFailPoint: "failCommand",
    mode,
    data: { failCommands, errorCode: 2 },
  });
const failpointOff = () =>
  mongoose.connection
    .db!.admin()
    .command({ configureFailPoint: "failCommand", mode: "off" });
const rows = () => PushReceipt.find().sort({ createdAt: 1 }).lean();

describe("Expo push receipt tracking (real Mongo, mocked Expo HTTP)", () => {
  let mongo: MongoTestContext | undefined;
  beforeAll(async () => {
    mongo = await startMongoTest({ enableTestCommands: true });
  });
  beforeEach(() => {
    receipts = {};
    receiptStatus = 200;
    nextTicket = 0;
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await clearMongoTestDatabase();
  });
  afterAll(async () => {
    await stopMongoTest(mongo);
  });

  it.each([false, true])(
    "tracks each device's ticket, polls only when due, and never resends (reverse reservation time: %s)",
    async (reverseReservationTime) => {
      const { userId } = await setup(2);
      if (reverseReservationTime) {
        const reserve = receiptRepository.reserveReceiptAttempt;
        const now = Date.now();
        let index = 0;
        // Promise.all preserves send order, not the creation time of concurrent rows.
        vi.spyOn(receiptRepository, "reserveReceiptAttempt").mockImplementation(
          (token) => reserve(token, new Date(now + (index++ === 0 ? 1 : 0))),
        );
      }
      const res = await sendPushToUser(userId, build, { k: 1 });
      expect(res).toEqual({ sent: 2, removed: 0 });
      const stored = await rows();
      expect(stored).toHaveLength(2);
      const send = fetchMock.mock.calls.find(
        ([url]) => url === EXPO_PUSH_SEND_URL,
      );
      expect(send).toBeDefined();
      const messages: Array<{ to: string }> = JSON.parse(
        String(send![1]?.body),
      );
      const registrations = await PushToken.find({ userId }).lean();
      expect(messages.map((message) => message.to).sort()).toEqual(
        registrations.map((registration) => registration.token).sort(),
      );
      // Expo tickets correspond to HTTP payload order. Mongo insertion timestamps
      // are not a delivery-order contract; verify the actual device association.
      messages.forEach((message, index) => {
        const registration = registrations.find(
          (row) => row.token === message.to,
        );
        expect(registration).toBeDefined();
        expect(
          stored.find((row) => row.tokenId === String(registration!._id)),
        ).toMatchObject({
          state: "pending",
          ticketId: `ticket-${index + 1}`,
          registrationVersion: registration!.registrationVersion,
        });
      });
      // Nothing sensitive is persisted.
      expect(JSON.stringify(stored)).not.toMatch(/PRIVATE|ExponentPushToken/);

      expect(await runPushReceiptPass()).toBe(0);
      expect(calls(EXPO_PUSH_RECEIPTS_URL)).toBe(0);

      receipts = { "ticket-1": { status: "ok" }, "ticket-2": { status: "ok" } };
      expect(await runPushReceiptPass(later(FIRST))).toBe(2);
      expect((await rows()).map((r) => r.state)).toEqual([
        "provider_accepted",
        "provider_accepted",
      ]);
      expect(calls(EXPO_PUSH_SEND_URL)).toBe(1);
    },
  );

  it("durable sends keep their accepted checkpoint when ticket persistence fails, without resending", async () => {
    const { userId } = await setup(2);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // Real Mongo fault: the first update command (the ticket attach) fails.
    await failpoint(["update"], { times: 1 });
    const accepted: string[] = [];
    let res;
    try {
      res = await sendPushToUser(
        userId,
        build,
        {},
        {
          delivered: [],
          expiresAt: later(3_600_000),
          beforeSend: async () => true,
          onAccepted: async (digest) => {
            accepted.push(digest);
            return true;
          },
        },
      );
    } finally {
      await failpointOff();
    }
    expect(res).toMatchObject({ sent: 2, retryable: false, cancelled: false });
    expect(accepted).toHaveLength(2);
    expect(calls(EXPO_PUSH_SEND_URL)).toBe(2);
    const states = (await rows()).map((r) => r.state).sort();
    expect(states).toEqual(["awaiting_ticket", "pending"]);

    // The untracked placeholder converges to unknown; no receipt/resend path.
    await runPushReceiptPass(later(PUSH_RECEIPT.awaitingTicketGraceMs + 1_000));
    expect((await rows()).find((r) => r.state === "unknown")?.errorCode).toBe(
      "ticket_not_recorded",
    );
    expect(calls(EXPO_PUSH_SEND_URL)).toBe(2);
  });

  it("does not send when the tracking reservation fails (best-effort and durable)", async () => {
    const { userId } = await setup(1);
    vi.spyOn(PushReceipt, "insertMany").mockRejectedValue(
      new Error("db down") as never,
    );
    expect(await sendPushToUser(userId, build, {})).toEqual({
      sent: 0,
      removed: 0,
    });
    await expect(
      sendPushToUser(
        userId,
        build,
        {},
        {
          delivered: [],
          expiresAt: later(3_600_000),
          beforeSend: async () => true,
          onAccepted: async () => true,
        },
      ),
    ).rejects.toThrow("db down");
    expect(calls(EXPO_PUSH_SEND_URL)).toBe(0);
  });

  it("DeviceNotRegistered deletes exactly the original registration generation", async () => {
    const a = await setup(1);
    const b = await setup(1);
    await sendPushToUser(a.userId, build, {});
    await sendPushToUser(b.userId, build, {});
    // Same user, same session, same device re-registers: new generation.
    await registerPushToken({
      userId: a.userId,
      authSessionId: a.sessionId,
      token: a.tokens[0],
      platform: "ios",
      locale: "en",
    });
    receipts = {
      "ticket-1": {
        status: "error",
        details: { error: "DeviceNotRegistered" },
      },
      "ticket-2": {
        status: "error",
        details: { error: "DeviceNotRegistered" },
      },
    };
    await runPushReceiptPass(later(FIRST));
    expect(await PushToken.countDocuments({ userId: a.userId })).toBe(1);
    expect(await PushToken.countDocuments({ userId: b.userId })).toBe(0);
    expect((await rows()).map((r) => [r.state, r.errorCode])).toEqual([
      ["failed", "DeviceNotRegistered"],
      ["failed", "DeviceNotRegistered"],
    ]);
  });

  it("preserves a registration transferred to another owner or session", async () => {
    const a = await setup(1);
    const b = await setup(0);
    await sendPushToUser(a.userId, build, {});
    await registerPushToken({
      userId: b.userId,
      authSessionId: b.sessionId,
      token: a.tokens[0],
      platform: "ios",
      locale: "zh-TW",
    });
    receipts = {
      "ticket-1": {
        status: "error",
        details: { error: "DeviceNotRegistered" },
      },
    };
    await runPushReceiptPass(later(FIRST));
    expect(await PushToken.countDocuments({ userId: b.userId })).toBe(1);
  });

  it("assigns a version to legacy registrations before tracking", async () => {
    const { userId, sessionId, tokens } = await setup(1);
    await PushToken.collection.updateOne(
      { token: tokens[0] },
      { $unset: { registrationVersion: "" } },
    );
    await sendPushToUser(userId, build, {});
    const token = await PushToken.findOne({ token: tokens[0] }).lean();
    expect(token?.registrationVersion).toBeTruthy();
    expect((await rows())[0]).toMatchObject({
      registrationVersion: token?.registrationVersion,
      authSessionId: sessionId,
    });
  });

  it.each([
    ["MessageRateExceeded", "MessageRateExceeded"],
    ["InvalidCredentials", "InvalidCredentials"],
    ["SomethingPrivate: user@example.com", "UnknownError"],
  ])("keeps token and sanitizes receipt error %s", async (raw, stored) => {
    const { userId } = await setup(1);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await sendPushToUser(userId, build, {});
    receipts = {
      "ticket-1": { status: "error", message: raw, details: { error: raw } },
    };
    await runPushReceiptPass(later(FIRST));
    expect((await rows())[0]).toMatchObject({
      state: "failed",
      errorCode: stored,
    });
    expect(await PushToken.countDocuments({ userId })).toBe(1);
    expect(calls(EXPO_PUSH_SEND_URL)).toBe(1);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(
      /user@example|ticket-1|ExponentPushToken/,
    );
  });

  it.each([
    ["missing id", () => ({ receipts: {}, status: 200 })],
    [
      "malformed entry",
      () => ({ receipts: { "ticket-1": { status: "x" } }, status: 200 }),
    ],
    ["HTTP 429", () => ({ receipts: {}, status: 429 })],
    ["HTTP 503", () => ({ receipts: {}, status: 503 })],
  ])(
    "%s retries with backoff, then converges to unknown",
    async (_n, setupCase) => {
      const { userId } = await setup(1);
      await sendPushToUser(userId, build, {});
      const c = setupCase();
      receipts = c.receipts;
      receiptStatus = c.status;
      let at = FIRST;
      for (let i = 0; i < PUSH_RECEIPT.maxAttempts + 1; i++) {
        await runPushReceiptPass(later(at));
        at += PUSH_RECEIPT.backoffMaxMs + 1_000;
      }
      const [row] = await rows();
      expect(row.state).toBe("unknown");
      expect(row.attempts).toBeLessThanOrEqual(PUSH_RECEIPT.maxAttempts);
      expect(await PushToken.countDocuments({ userId })).toBe(1);
      expect(calls(EXPO_PUSH_SEND_URL)).toBe(1);
    },
  );

  it("converges to unknown at the deadline and prunes after retention", async () => {
    const { userId } = await setup(1);
    await sendPushToUser(userId, build, {});
    await runPushReceiptPass(later(PUSH_RECEIPT.deadlineMs + 1_000));
    expect((await rows())[0].state).toBe("unknown");
    expect(calls(EXPO_PUSH_RECEIPTS_URL)).toBe(0);
    await runPushReceiptPass(later(PUSH_RECEIPT.retentionMs + 1_000));
    expect(await PushReceipt.countDocuments()).toBe(0);
  });

  it("retains DeviceNotRegistered cleanup for retry when deletion fails", async () => {
    const { userId } = await setup(1);
    await sendPushToUser(userId, build, {});
    receipts = {
      "ticket-1": {
        status: "error",
        details: { error: "DeviceNotRegistered" },
      },
    };
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // Skip the expiry prune's delete; fail the registration deleteOne (real Mongo fault).
    await failpoint(["delete"], { skip: 1 });
    try {
      await runPushReceiptPass(later(FIRST));
    } finally {
      await failpointOff();
    }
    expect((await rows())[0].state).toBe("cleanup_pending");
    expect(await PushToken.countDocuments({ userId })).toBe(1);
    const calledBefore = calls(EXPO_PUSH_RECEIPTS_URL);
    await runPushReceiptPass(later(FIRST + PUSH_RECEIPT.backoffMaxMs));
    expect(await PushToken.countDocuments({ userId })).toBe(0);
    expect((await rows())[0]).toMatchObject({
      state: "failed",
      errorCode: "DeviceNotRegistered",
    });
    expect(calls(EXPO_PUSH_RECEIPTS_URL)).toBe(calledBefore);
  });

  it("claims are exclusive and a stale lease holder cannot finalize", async () => {
    const { userId } = await setup(1);
    await sendPushToUser(userId, build, {});
    const now = later(FIRST);
    const [x, y] = await Promise.all([
      claimDueReceipt(now),
      claimDueReceipt(now),
    ]);
    expect([x, y].filter(Boolean)).toHaveLength(1);
    const stale = (x ?? y)!;
    const reclaimed = await claimDueReceipt(
      new Date(now.getTime() + PUSH_RECEIPT.leaseMs + 1),
    );
    expect(reclaimed?.leaseToken).not.toBe(stale.leaseToken);
    expect(await finalizeReceipt(stale, "failed", "X")).toBe(false);
    expect(await finalizeReceipt(reclaimed!, "provider_accepted", null)).toBe(
      true,
    );
    expect(await finalizeReceipt(stale, "failed", "X")).toBe(false);
    expect((await rows())[0].state).toBe("provider_accepted");
  });

  it("resumes from persisted state with a new worker after restart", async () => {
    const { userId } = await setup(1);
    await sendPushToUser(userId, build, {});
    receipts = { "ticket-1": { status: "ok" } };
    // A "restarted" process simply runs a new pass over the same collection.
    expect(await runPushReceiptPass(later(FIRST))).toBe(1);
    expect((await rows())[0].state).toBe("provider_accepted");
  });

  it("account deletion purges tracking and late callbacks cannot resurrect it", async () => {
    const { userId } = await setup(1);
    const [token] = await PushToken.find({ userId }).lean();
    const attemptId = (await reserveReceiptAttempt({
      _id: token._id,
      userId,
      authSessionId: token.authSessionId,
      registrationVersion: token.registrationVersion!,
    }))!;
    await deleteOwnedRecords(userId);
    expect(await PushReceipt.countDocuments({ userId })).toBe(0);
    expect(await attachReceiptTicket(attemptId, "late")).toBe(false);
    expect(await PushReceipt.countDocuments()).toBe(0);
    // A reservation after the tombstone is refused and cleaned.
    await DeletedAccount.create({ userId, state: "pending" });
    expect(
      await reserveReceiptAttempt({
        _id: token._id,
        userId,
        authSessionId: token.authSessionId,
        registrationVersion: "v",
      }),
    ).toBeNull();
    expect(await PushReceipt.countDocuments()).toBe(0);
  });

  it("records an ambiguous send failure as unknown, not failed", async () => {
    const { userId } = await setup(1);
    fetchMock.mockResolvedValueOnce(new Response("x", { status: 502 }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await sendPushToUser(userId, build, {});
    expect((await rows())[0]).toMatchObject({
      state: "unknown",
      errorCode: "send_ambiguous",
    });
  });

  it("sends only successfully reserved devices when one reservation fails", async () => {
    const { userId } = await setup(2);
    vi.spyOn(PushReceipt, "insertMany").mockRejectedValueOnce(
      new Error("db") as never,
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await sendPushToUser(userId, build, {})).toEqual({
      sent: 1,
      removed: 0,
    });
    expect(await PushReceipt.countDocuments({ state: "pending" })).toBe(1);
    expect(calls(EXPO_PUSH_SEND_URL)).toBe(1);
  });

  it.each([false, true])(
    "persists immediate DNR cleanup for retry without blocking later batches (durable=%s)",
    async (durable) => {
      const { userId } = await setup(durable ? 1 : 101);
      vi.spyOn(console, "warn").mockImplementation(() => {});
      fetchMock.mockImplementationOnce(async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as unknown[];
        await failpoint(["delete"], { times: 1 });
        return Response.json({
          data: body.map((_value, i) =>
            i === 0
              ? {
                  status: "error",
                  message: "gone",
                  details: { error: "DeviceNotRegistered" },
                }
              : { status: "ok", id: `first-ticket-${i}` },
          ),
        });
      });
      try {
        const result = durable
          ? await sendPushToUser(
              userId,
              build,
              {},
              {
                delivered: [],
                expiresAt: later(3_600_000),
                beforeSend: async () => true,
                onAccepted: async () => true,
              },
            )
          : await sendPushToUser(userId, build, {});
        expect(result.sent).toBe(durable ? 0 : 100);
        if (durable) expect(result).toMatchObject({ retryable: false });
      } finally {
        await failpointOff();
      }
      expect(
        await PushReceipt.countDocuments({ state: "cleanup_pending" }),
      ).toBe(1);
      const sentCalls = calls(EXPO_PUSH_SEND_URL);
      expect(sentCalls).toBe(durable ? 1 : 2);
      await runPushReceiptPass(later(PUSH_RECEIPT.backoffBaseMs + 1_000));
      expect(
        await PushReceipt.countDocuments({
          state: "failed",
          errorCode: "DeviceNotRegistered",
        }),
      ).toBe(1);
      expect(await PushToken.countDocuments({ userId })).toBe(
        durable ? 0 : 100,
      );
      expect(calls(EXPO_PUSH_RECEIPTS_URL)).toBe(0);
      expect(calls(EXPO_PUSH_SEND_URL)).toBe(sentCalls);
    },
  );

  it("sends in bounded chunks of 100 with a reservation per chunk", async () => {
    const { userId } = await setup(101);
    expect(await sendPushToUser(userId, build, {})).toMatchObject({
      sent: 101,
    });
    expect(calls(EXPO_PUSH_SEND_URL)).toBe(2);
    expect(await PushReceipt.countDocuments({ state: "pending" })).toBe(101);
  });

  it.each(["revoked session", "re-registered device"])(
    "does not send when the %s changes during reservation (best-effort and durable)",
    async (kind) => {
      const { userId, sessionId, tokens } = await setup(1);
      const original = PushReceipt.insertMany.bind(PushReceipt);
      vi.spyOn(PushReceipt, "insertMany").mockImplementation((async (
        ...args: Parameters<typeof original>
      ) => {
        const out = await (original as (...a: unknown[]) => Promise<unknown>)(
          ...args,
        );
        if (kind === "revoked session") {
          await AuthSession.updateOne(
            { _id: sessionId },
            { $set: { revokedAt: new Date() } },
          );
        } else {
          await registerPushToken({
            userId,
            authSessionId: sessionId,
            token: tokens[0],
            platform: "ios",
            locale: "en",
          });
        }
        return out;
      }) as never);
      expect(await sendPushToUser(userId, build, {})).toEqual({
        sent: 0,
        removed: 0,
      });
      expect(calls(EXPO_PUSH_SEND_URL)).toBe(0);
      expect(await PushReceipt.countDocuments()).toBe(0);

      if (kind === "revoked session") {
        await AuthSession.updateOne(
          { _id: sessionId },
          { $set: { revokedAt: null } },
        );
      }
      // The same revocation or re-registration occurs during durable preparation.
      const onAccepted = vi.fn(async () => true);
      const res = await sendPushToUser(
        userId,
        build,
        {},
        {
          delivered: [],
          expiresAt: later(3_600_000),
          beforeSend: async () => true,
          onAccepted,
        },
      );
      expect(res.sent).toBe(0);
      expect(onAccepted).not.toHaveBeenCalled();
      expect(calls(EXPO_PUSH_SEND_URL)).toBe(0);
      expect(await PushReceipt.countDocuments()).toBe(0);
    },
  );

  it("an expired lease cannot finalize even without a newer claim", async () => {
    const { userId } = await setup(1);
    await sendPushToUser(userId, build, {});
    await PushReceipt.updateMany({}, { $set: { nextAttemptAt: new Date(0) } });
    const claim = (await claimDueReceipt())!;
    const afterLease = new Date(Date.now() + PUSH_RECEIPT.leaseMs + 1_000);
    expect(
      await finalizeReceipt(claim, "provider_accepted", null, afterLease),
    ).toBe(false);
    expect((await rows())[0].state).toBe("pending");
  });

  it("a deadline reached during the HTTP call blocks finalization", async () => {
    const { userId } = await setup(1);
    await sendPushToUser(userId, build, {});
    await PushReceipt.updateMany({}, { $set: { nextAttemptAt: new Date(0) } });
    fetchMock.mockImplementation(async (url: unknown) => {
      if (url !== EXPO_PUSH_RECEIPTS_URL) throw new Error("unexpected url");
      await PushReceipt.updateMany(
        {},
        { $set: { deadlineAt: new Date(Date.now() - 1) } },
      );
      return Response.json({ data: { "ticket-1": { status: "ok" } } });
    });
    await runPushReceiptPass();
    expect((await rows())[0].state).toBe("pending");
  });

  it("an expired lease during the HTTP call prevents registration cleanup", async () => {
    const { userId } = await setup(1);
    await sendPushToUser(userId, build, {});
    await PushReceipt.updateMany({}, { $set: { nextAttemptAt: new Date(0) } });
    fetchMock.mockImplementation(async (url: unknown) => {
      if (url !== EXPO_PUSH_RECEIPTS_URL) throw new Error("unexpected url");
      await PushReceipt.updateMany(
        {},
        { $set: { leaseExpiresAt: new Date(Date.now() - 1) } },
      );
      return Response.json({
        data: {
          "ticket-1": {
            status: "error",
            details: { error: "DeviceNotRegistered" },
          },
        },
      });
    });
    await runPushReceiptPass();
    expect(await PushToken.countDocuments({ userId })).toBe(1);
    expect((await rows())[0].state).toBe("pending");
  });

  it("worker is single-flight while a receipt request is in flight, and stop waits for it", async () => {
    const { userId } = await setup(1);
    await sendPushToUser(userId, build, {});
    await PushReceipt.updateMany({}, { $set: { nextAttemptAt: new Date(0) } });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    fetchMock.mockImplementation(async (url: unknown) => {
      if (url !== EXPO_PUSH_RECEIPTS_URL) throw new Error("unexpected url");
      await gate;
      return Response.json({ data: { "ticket-1": { status: "ok" } } });
    });
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const worker = startPushReceiptWorker();
    try {
      for (let i = 0; i < 100 && calls(EXPO_PUSH_RECEIPTS_URL) < 1; i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(calls(EXPO_PUSH_RECEIPTS_URL)).toBe(1);
      vi.advanceTimersByTime(PUSH_RECEIPT.pollMs * 2);
      await new Promise((r) => setTimeout(r, 50));
      expect(calls(EXPO_PUSH_RECEIPTS_URL)).toBe(1);
      let stopped = false;
      const stopping = worker.stop().then(() => (stopped = true));
      await new Promise((r) => setTimeout(r, 50));
      expect(stopped).toBe(false);
      release();
      await stopping;
      // Shutdown releases the unprocessed claim, rather than stranding it
      // behind its lease. A subsequent worker can finish without a resend.
      expect((await rows())[0]).toMatchObject({ state: "pending" });
      expect((await rows())[0].leaseToken).toBeUndefined();
      vi.advanceTimersByTime(PUSH_RECEIPT.pollMs * 2);
      expect(calls(EXPO_PUSH_RECEIPTS_URL)).toBe(1);
      await runPushReceiptPass();
      expect((await rows())[0].state).toBe("provider_accepted");
      expect(calls(EXPO_PUSH_SEND_URL)).toBe(1);
    } finally {
      release();
      await worker.stop();
      vi.useRealTimers();
    }
  });
});
