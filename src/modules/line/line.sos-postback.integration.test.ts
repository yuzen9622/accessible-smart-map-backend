import { createHmac, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import type { messagingApi } from "@line/bot-sdk";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const { multicast, replyMessage, showLoadingAnimation } = vi.hoisted(() => {
  vi.stubEnv("LINE_CHANNEL_SECRET", "postback-test-secret");
  vi.stubEnv("PUBLIC_TRACKING_BASE_URL", "https://example.test");
  return {
    multicast: vi.fn(),
    replyMessage: vi.fn(),
    showLoadingAnimation: vi.fn(),
  };
});
// Keep the real signature middleware and adapter; replace only LINE network I/O.
vi.mock("@line/bot-sdk", async (actual) => ({
  ...(await actual<typeof import("@line/bot-sdk")>()),
  messagingApi: {
    MessagingApiClient: class {
      multicast = multicast;
      replyMessage = replyMessage;
      showLoadingAnimation = showLoadingAnimation;
    },
  },
}));
vi.mock("./line-agent.service", () => ({ runLineAgent: vi.fn() }));
vi.mock("./line-memory", () => ({
  getPendingRename: vi.fn(async () => null),
  clearPendingRename: vi.fn(async () => {}),
  setPendingRename: vi.fn(),
  getLineChatHistory: vi.fn(async () => []),
  appendLineChatTurn: vi.fn(),
}));
vi.mock("../../config/redis", () => ({ redisSetNx: vi.fn(async () => true) }));
vi.mock("../accessible-route/accessible-route.service", () => ({
  planAccessibleRouteFromRequest: vi.fn(),
}));
vi.mock("../user/user.push.service", () => ({
  sendPushToUser: vi.fn(async () => {}),
  pickLocale: vi.fn(),
}));

import User from "../../model/user.model";
import EmergencyContact from "../../model/emergency-contact.model";
import SosSession from "../../model/sos-session.model";
import { createSession } from "../sos/sos.service";
import { createLineRouter } from "./line.router";
import { runLineAgent } from "./line-agent.service";
import { LINE_MSG, SOS_MSG } from "../../constants/messages";
import {
  startMongoTest,
  stopMongoTest,
  type MongoTestContext,
} from "../../../tests/helpers/mongo-test-harness";

const app = express().use("/api/v1/line", createLineRouter());

async function notify() {
  const owner = await User.create({
    name: "求救者",
    email: "postback@example.test",
  });
  const contact = await EmergencyContact.collection.insertOne({
    userId: String(owner._id),
    name: "照顧者",
    bindStatus: "bound",
    lineUserId: "L1",
  });
  const result = await createSession({
    userId: String(owner._id),
    type: "body",
    lat: 25,
    lng: 121,
  });
  expect(result).toMatchObject({
    ok: true,
    data: { notificationStatus: "accepted" },
  });
  const session = await SosSession.findOne({
    userId: String(owner._id),
  }).lean();
  if (!session) throw new Error("Missing created SOS session");
  const message = (multicast.mock.calls[0][0] as messagingApi.MulticastRequest)
    .messages[0];
  if (message.type !== "flex" || message.contents.type !== "bubble") {
    throw new Error("Expected actual SOS notification bubble");
  }
  const controls = message.contents.footer?.contents ?? [];
  function button(action: "ack" | "claim") {
    const control = controls.find(
      (c) =>
        c.type === "button" &&
        c.action.type === "postback" &&
        c.action.data?.startsWith(`action=${action}&`),
    );
    if (
      control?.type !== "button" ||
      control.action.type !== "postback" ||
      typeof control.action.data !== "string"
    ) {
      throw new Error("Missing actual notification action");
    }
    return control.action.data;
  }
  const tracking = controls.find(
    (c) => c.type === "button" && c.action.type === "uri",
  );
  if (
    tracking?.type !== "button" ||
    tracking.action.type !== "uri" ||
    typeof tracking.action.uri !== "string"
  ) {
    throw new Error("Missing actual tracking link");
  }
  const legacyToken = new URLSearchParams(
    new URL(tracking.action.uri).hash.slice(1),
  ).get("token");
  expect(legacyToken).toBe(session.shareToken);
  expect(legacyToken).toMatch(/^[a-f0-9]{32}$/);
  return {
    session,
    contactId: String(contact.insertedId),
    legacyToken,
    button,
  };
}

async function click(data: string, lineUserId = "L1") {
  const before = replyMessage.mock.calls.length;
  const replyToken = randomUUID();
  const body = JSON.stringify({
    events: [
      {
        type: "postback",
        replyToken,
        webhookEventId: randomUUID(),
        source: { type: "user", userId: lineUserId },
        postback: { data },
      },
    ],
  });
  const signature = createHmac("sha256", "postback-test-secret")
    .update(body)
    .digest("base64");
  const response = await request(app)
    .post("/api/v1/line/webhook")
    .set("Content-Type", "application/json")
    .set("x-line-signature", signature)
    .send(body);
  expect(response.status).toBe(200);
  // HTTP acknowledges before processing: wait for the real handler's LINE reply.
  await vi.waitFor(() =>
    expect(replyMessage).toHaveBeenCalledTimes(before + 1),
  );
  return (
    replyMessage.mock.calls[before][0] as messagingApi.ReplyMessageRequest
  ).messages;
}

async function saved(id: unknown) {
  const session = await SosSession.findById(id).lean();
  if (!session) throw new Error("Missing SOS session after action");
  return session;
}

describe("real SOS notification buttons through signed LINE webhook and Mongo", () => {
  let mongo: MongoTestContext | undefined;
  beforeAll(async () => {
    mongo = await startMongoTest();
  });
  beforeEach(async () => {
    await Promise.all([
      User.deleteMany({}),
      EmergencyContact.deleteMany({}),
      SosSession.deleteMany({}),
    ]);
    vi.clearAllMocks();
    multicast.mockResolvedValue({});
    replyMessage.mockResolvedValue({});
    showLoadingAnimation.mockResolvedValue({});
  });
  afterAll(async () => {
    await stopMongoTest(mongo);
    vi.unstubAllEnvs();
  });

  it.each(["ack", "claim"] as const)(
    "handles an already-sent legacy %s button without treating its share token as authorization",
    async (action) => {
      const f = await notify();
      // Replay the old wire format: sid was taken from the public tracking URL.
      const data = `action=${action}&sid=${f.legacyToken}`;
      await click(data);
      await click(data);
      const session = await saved(f.session._id);
      const status = action === "ack" ? "acknowledged" : "claimed";
      expect(session.handlingStatus).toBe(status);
      expect(session.timeline.filter((e) => e.type === status)).toHaveLength(1);
      if (action === "ack") expect(session.acknowledgements).toHaveLength(1);
      else expect(session.claimedBy).toBe("L1");
    },
  );

  it("acknowledges using the actual emitted card, without substituting a correct id", async () => {
    const f = await notify();
    for (const action of ["ack", "claim"] as const) {
      expect(new URLSearchParams(f.button(action)).get("sid")).toBe(
        String(f.session._id),
      );
    }
    await click(f.button("ack"));
    await click(f.button("ack"));
    const session = await saved(f.session._id);
    expect(session.handlingStatus).toBe("acknowledged");
    expect(session.acknowledgements).toHaveLength(1);
    expect(
      session.timeline.filter((e) => e.type === "acknowledged"),
    ).toHaveLength(1);
    expect(runLineAgent).not.toHaveBeenCalled();
  });

  it.each(["new", "legacy"] as const)(
    "%s claim issues canonical controls that update and resolve the same event",
    async (kind) => {
      const f = await notify();
      const messages = await click(
        kind === "new"
          ? f.button("claim")
          : `action=claim&sid=${f.legacyToken}`,
      );
      expect(await saved(f.session._id)).toMatchObject({
        handlingStatus: "claimed",
        claimedBy: "L1",
      });
      const controls = messages
        .flatMap((m) => m.quickReply?.items ?? [])
        .map((item) => item.action)
        .filter(
          (a): a is messagingApi.PostbackAction & { data: string } =>
            a?.type === "postback" && typeof a.data === "string",
        );
      expect(controls).toHaveLength(3);
      for (const action of controls) {
        expect(new URLSearchParams(action.data).get("sid")).toBe(
          String(f.session._id),
        );
      }
      await click(controls[0].data);
      expect((await saved(f.session._id)).handlingStatus).toBe("en_route");
      await click(controls[1].data);
      expect((await saved(f.session._id)).handlingStatus).toBe("arrived");
      await click(controls[2].data);
      expect((await saved(f.session._id)).status).toBe("resolved");
    },
  );

  it("canonicalizes legacy status and resolve references before domain writes", async () => {
    const f = await notify();
    await click(`action=claim&sid=${f.legacyToken}`);
    await click(`action=status&sid=${f.legacyToken}&v=en_route`);
    expect((await saved(f.session._id)).handlingStatus).toBe("en_route");
    await click(`action=resolve&sid=${f.legacyToken}`);
    expect((await saved(f.session._id)).status).toBe("resolved");
  });

  it.each(["new", "legacy"] as const)(
    "%s buttons reject other owners' contacts and revoked bindings without writing",
    async (kind) => {
      const f = await notify();
      await EmergencyContact.collection.insertOne({
        userId: "000000000000000000000001",
        name: "他人照顧者",
        bindStatus: "bound",
        lineUserId: "L2",
      });
      for (const lineUserId of ["L2", "L1"]) {
        if (lineUserId === "L1")
          await EmergencyContact.deleteOne({ _id: f.contactId });
        for (const action of ["ack", "claim"] as const) {
          const data =
            kind === "new"
              ? f.button(action)
              : `action=${action}&sid=${f.legacyToken}`;
          expect(await click(data, lineUserId)).toEqual([
            { type: "text", text: SOS_MSG.NOT_AUTHORIZED_CONTACT },
          ]);
        }
      }
      expect(await saved(f.session._id)).toEqual(f.session);
    },
  );

  it.each(["new", "legacy"] as const)(
    "%s buttons report an already-resolved event without writing",
    async (kind) => {
      const f = await notify();
      await SosSession.updateOne(
        { _id: f.session._id },
        { $set: { status: "resolved", handlingStatus: "resolved" } },
      );
      const before = await saved(f.session._id);
      for (const action of ["ack", "claim"] as const) {
        expect(
          await click(
            kind === "new"
              ? f.button(action)
              : `action=${action}&sid=${f.legacyToken}`,
          ),
        ).toEqual([{ type: "text", text: LINE_MSG.SOS_ALREADY_RESOLVED }]);
      }
      expect(await saved(f.session._id)).toEqual(before);
    },
  );

  it.each(["f".repeat(24), "f".repeat(32)])(
    "rejects unknown reference %s without falling back to the active event",
    async (reference) => {
      const f = await notify();
      expect(await click(`action=ack&sid=${reference}`)).toEqual([
        { type: "text", text: SOS_MSG.NOT_AUTHORIZED_CONTACT },
      ]);
      expect(await saved(f.session._id)).toEqual(f.session);
    },
  );

  it.each([
    "",
    "not-an-id",
    "a".repeat(23),
    "g".repeat(24),
    "a".repeat(33),
    '{"$ne":null}',
  ])("rejects malformed reference %s without writing", async (reference) => {
    const f = await notify();
    expect(
      await click(`action=ack&sid=${encodeURIComponent(reference)}`),
    ).toEqual([{ type: "text", text: LINE_MSG.INVALID_ACTION }]);
    expect(await saved(f.session._id)).toEqual(f.session);
  });

  it("rejects a forged webhook signature before acknowledging the event", async () => {
    const f = await notify();
    const response = await request(app)
      .post("/api/v1/line/webhook")
      .set("x-line-signature", "forged")
      .send({
        events: [
          {
            type: "postback",
            replyToken: "reply",
            source: { type: "user", userId: "L1" },
            postback: { data: f.button("ack") },
          },
        ],
      });
    expect(response.status).toBe(401);
    expect(replyMessage).not.toHaveBeenCalled();
    expect(await saved(f.session._id)).toEqual(f.session);
  });
});
