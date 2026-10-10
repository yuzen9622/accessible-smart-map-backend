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
import mongoose from "mongoose";
import { spawn } from "node:child_process";
import { HTTPFetchError } from "@line/bot-sdk";
const { multicast } = vi.hoisted(() => ({ multicast: vi.fn() }));
vi.mock("@line/bot-sdk", async (actual) => ({
  ...(await actual<typeof import("@line/bot-sdk")>()),
  messagingApi: {
    MessagingApiClient: class {
      multicast = multicast;
    },
  },
}));
vi.mock("../user/user.push.service", () => ({
  pickLocale: vi.fn(),
  sendPushToUser: vi.fn(),
}));
import SosSession from "../../model/sos-session.model";
import Contact from "../../model/emergency-contact.model";
import { createSession, getSessionForOwner } from "./sos.service";
import {
  acceptInitialNotice,
  claimInitialNotice,
  failInitialNotice,
} from "./sos.repository";
import { drainInitialNotices } from "./sos-notification.service";
import { sendSosNotification } from "../../adapters/line.adapter";
import { SOS_NOTICE } from "../../constants/sos";
import {
  startMongoTest,
  stopMongoTest,
  type MongoTestContext,
} from "../../../tests/helpers/mongo-test-harness";

const input = {
  userId: "000000000000000000000001",
  type: "body" as const,
  lat: 25,
  lng: 121,
};
const failed = () => new Error("injected LINE outage");
async function stored() {
  const session = await SosSession.findOne({ userId: input.userId }).lean();
  if (!session) throw new Error("Missing fixture session");
  return session;
}
async function due() {
  await SosSession.updateMany(
    {},
    {
      $set: {
        "initialNotice.nextAttemptAt": new Date(0),
        "initialNotice.leaseUntil": new Date(0),
      },
    },
  );
}

describe("initial SOS delivery with real Mongo and LINE adapter", () => {
  let mongo: MongoTestContext;
  beforeAll(async () => {
    mongo = await startMongoTest();
  });
  afterAll(async () => {
    await stopMongoTest(mongo);
  });
  beforeEach(async () => {
    multicast.mockReset().mockResolvedValue({});
    await Contact.create({
      userId: input.userId,
      name: "contact",
      bindStatus: "bound",
      lineUserId: "line-one",
      bindCode: "SOS001",
    });
  });
  afterEach(async () => {
    await SosSession.deleteMany({});
    await Contact.deleteMany({});
    vi.useRealTimers();
  });

  it("reports zero on failure, retries the same session, then never re-notifies accepted recipients", async () => {
    multicast.mockRejectedValueOnce(failed());
    const first = await createSession(input);
    expect(first).toMatchObject({
      httpCode: 201,
      data: { notifiedCount: 0, notificationStatus: "failed" },
    });
    expect(await stored()).toMatchObject({ handlingStatus: "pending" });
    expect((await stored()).timeline.map((t) => t.type)).toEqual(["created"]);
    const second = await createSession({ ...input, type: "trapped" });
    expect(second).toMatchObject({
      httpCode: 200,
      data: {
        ...(first.data as object),
        notifiedCount: 1,
        notificationStatus: "accepted",
      },
    });
    expect(multicast.mock.calls[1]).toEqual(multicast.mock.calls[0]);
    expect((await stored()).timeline.map((t) => t.type)).toEqual([
      "created",
      "notified",
    ]);
    await Contact.deleteMany({});
    expect(await createSession(input)).toMatchObject({
      data: { notifiedCount: 1, notificationStatus: "accepted" },
    });
    expect(multicast).toHaveBeenCalledTimes(2);
    expect(
      await getSessionForOwner({
        userId: input.userId,
        sessionId: String((await stored())._id),
      }),
    ).toMatchObject({
      data: { notifiedCount: 1, notificationStatus: "accepted" },
    });
  });

  it("only one concurrent create sends while the others truthfully report queued", async () => {
    let release!: () => void;
    multicast.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const first = createSession(input);
    await vi.waitFor(() => expect(multicast).toHaveBeenCalledTimes(1));
    const others = await Promise.all([
      createSession(input),
      createSession(input),
    ]);
    for (const result of others)
      expect(result).toMatchObject({
        httpCode: 200,
        data: { notifiedCount: 0, notificationStatus: "queued" },
      });
    release();
    expect(await first).toMatchObject({ data: { notifiedCount: 1 } });
    expect(await SosSession.countDocuments()).toBe(1);
    expect(multicast).toHaveBeenCalledTimes(1);
  });

  it("recovers a persisted failed attempt after disconnect/reconnect via worker", async () => {
    multicast.mockRejectedValueOnce(failed());
    await createSession(input);
    await due();
    await mongoose.disconnect();
    await mongoose.connect(mongo.server.getUri(), { dbName: mongo.dbName });
    expect(await drainInitialNotices()).toBe(1);
    expect(await stored()).toMatchObject({
      initialNotice: { status: "accepted", notifiedCount: 1 },
    });
    expect(multicast.mock.calls[1]).toEqual(multicast.mock.calls[0]);
  });

  it("recovers acceptance before DB acknowledgement with the same key and fences stale workers", async () => {
    multicast.mockRejectedValueOnce(failed());
    await createSession(input);
    const id = String((await stored())._id);
    const first = await claimInitialNotice(new Date(), "lost-worker", id);
    const notice = first?.initialNotice;
    if (!notice) throw new Error("Expected claimed notification");
    await sendSosNotification(
      notice.recipients,
      notice.payload,
      notice.retryKey,
      SOS_NOTICE.timeoutMs,
    );
    // Simulate loss after LINE accepts, before the acceptance write.
    await due();
    const second = await claimInitialNotice(new Date(), "replacement", id);
    expect(second).not.toBeNull();
    await acceptInitialNotice(id, "lost-worker", 99);
    await failInitialNotice(id, "lost-worker", 1);
    expect((await stored()).initialNotice).toMatchObject({
      status: "queued",
      claimId: "replacement",
      notifiedCount: 0,
    });
    await due();
    const conflict = Object.assign(Object.create(HTTPFetchError.prototype), {
      status: 409,
    });
    multicast.mockRejectedValueOnce(conflict);
    expect(await drainInitialNotices()).toBe(1);
    expect((await stored()).initialNotice).toMatchObject({
      status: "accepted",
      notifiedCount: 1,
    });
    expect(multicast.mock.calls[2]).toEqual(multicast.mock.calls[1]);
    expect(
      (await stored()).timeline.filter((t) => t.type === "notified"),
    ).toHaveLength(1);
  });

  it("resumes in a new OS process after the sending worker exits before acknowledgement", async () => {
    multicast.mockRejectedValueOnce(failed());
    await createSession(input);
    await due();
    const runWorker = (crash: boolean) =>
      new Promise<string>((resolve, reject) => {
        const code = `
        const Module = require("node:module");
        const original = Module._load;
        Module._load = function(id, ...args) {
          if (id === "@line/bot-sdk") return {
            HTTPFetchError: class extends Error {},
            messagingApi: { MessagingApiClient: class {
              async multicast(...request) {
                const output = JSON.stringify(request);
                if (process.env.SOS_TEST_CRASH === "yes") {
                  process.stdout.write(output, () => process.exit(0));
                  return new Promise(() => {});
                }
                process.stdout.write(output);
              }
            } }
          };
          return original.call(this, id, ...args);
        };
        const mongoose = require("mongoose");
        const { drainInitialNotices } = require("./src/modules/sos/sos-notification.service");
        (async () => {
          await mongoose.connect(process.env.SOS_TEST_URI);
          await drainInitialNotices();
          await mongoose.disconnect();
        })().catch(e => { console.error(e); process.exit(1); });
      `;
        const child = spawn(
          process.execPath,
          ["-r", "ts-node/register/transpile-only", "-e", code],
          {
            env: {
              ...process.env,
              SOS_TEST_URI: mongo.server.getUri(mongo.dbName),
              SOS_TEST_CRASH: crash ? "yes" : "no",
            },
          },
        );
        let output = "";
        let errors = "";
        child.stdout.on("data", (chunk) => {
          output += String(chunk);
        });
        child.stderr.on("data", (chunk) => {
          errors += String(chunk);
        });
        child.on("error", reject);
        child.on("close", (status) =>
          status === 0 ? resolve(output) : reject(new Error(errors)),
        );
      });
    const firstRequest = await runWorker(true);
    expect((await stored()).initialNotice).toMatchObject({
      status: "queued",
      notifiedCount: 0,
    });
    await due();
    const secondRequest = await runWorker(false);
    expect(JSON.parse(secondRequest)).toEqual(JSON.parse(firstRequest));
    expect((await stored()).initialNotice).toMatchObject({
      status: "accepted",
      notifiedCount: 1,
    });
  });

  it("racing initial inserts share one durable notice", async () => {
    const results = await Promise.all([
      createSession(input),
      createSession(input),
      createSession(input),
    ]);
    expect(
      new Set(
        results.map((result) =>
          String((result.data as { sessionId: unknown }).sessionId),
        ),
      ).size,
    ).toBe(1);
    expect(await SosSession.countDocuments()).toBe(1);
    expect(multicast).toHaveBeenCalledTimes(1);
  });

  it("legacy active sessions get a retriable notice instead of a fabricated count", async () => {
    await SosSession.create({
      ...input,
      status: "active",
      shareToken: "legacy",
      locationUpdatedAt: new Date(),
      timeline: [],
    });
    multicast.mockRejectedValueOnce(failed());
    expect(await createSession(input)).toMatchObject({
      httpCode: 200,
      data: { notifiedCount: 0, notificationStatus: "failed" },
    });
    expect(await createSession(input)).toMatchObject({
      httpCode: 200,
      data: { notifiedCount: 1, notificationStatus: "accepted" },
    });
  });

  it("does not send resolved or exhausted sessions and converges abandoned final claims", async () => {
    multicast.mockRejectedValueOnce(failed());
    await createSession(input);
    await SosSession.updateMany(
      {},
      {
        $set: {
          "initialNotice.status": "queued",
          "initialNotice.attempts": SOS_NOTICE.maxAttempts,
        },
      },
    );
    await due();
    expect(await drainInitialNotices()).toBe(0);
    expect((await stored()).initialNotice?.status).toBe("failed");
    await SosSession.updateMany(
      {},
      { $set: { status: "resolved", "initialNotice.attempts": 0 } },
    );
    expect(await drainInitialNotices()).toBe(0);
    expect(multicast).toHaveBeenCalledTimes(1);
  });

  it("does not reuse an expired retry key", async () => {
    multicast.mockRejectedValueOnce(failed());
    await createSession(input);
    await due();
    await SosSession.updateMany(
      {},
      { $set: { "initialNotice.retryUntil": new Date(0) } },
    );
    await createSession(input);
    expect(await drainInitialNotices()).toBe(0);
    expect(multicast).toHaveBeenCalledTimes(1);
  });

  it("counts unique recipients and never rolls back a contact's later handling state", async () => {
    await Contact.create({
      userId: input.userId,
      name: "duplicate contact",
      bindStatus: "bound",
      lineUserId: "line-one",
      bindCode: "SOS002",
    });
    multicast.mockRejectedValueOnce(failed());
    await createSession(input);
    await SosSession.updateMany({}, { $set: { handlingStatus: "en_route" } });
    expect(await createSession(input)).toMatchObject({
      data: { notifiedCount: 1 },
    });
    expect(multicast.mock.calls[1][0].to).toEqual(["line-one"]);
    expect((await stored()).handlingStatus).toBe("en_route");
  });

  it("no contacts is skipped and never adds a notified event", async () => {
    await Contact.deleteMany({});
    expect(await createSession(input)).toMatchObject({
      data: { notifiedCount: 0, notificationStatus: "skipped" },
    });
    expect(multicast).not.toHaveBeenCalled();
    expect((await stored()).timeline.map((t) => t.type)).toEqual(["created"]);
  });

  it("bounds a hung LINE call without counting it as accepted", async () => {
    multicast.mockImplementationOnce(() => new Promise(() => {}));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const sending = sendSosNotification(
      ["line-one"],
      { type: "body", trackingUrl: "https://example.invalid" },
      "stable-key",
      100,
    );
    const check = expect(sending).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(100);
    await check;
    expect(vi.getTimerCount()).toBe(0);
  });
});
