import { randomUUID } from "node:crypto";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

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
vi.mock("../sos/sos-events", () => ({
  emitSosUpdate: vi.fn(),
  buildSosSnapshot: vi.fn(),
}));
vi.mock("../../adapters/line.adapter", async (importActual) => ({
  ...(await importActual<typeof import("../../adapters/line.adapter")>()),
  replyText: vi.fn(async () => {}),
  replyMessages: vi.fn(async () => {}),
  replyAgentResult: vi.fn(async () => {}),
  showLoadingAnimation: vi.fn(async () => {}),
  pushSosUpdate: vi.fn(async () => {}),
}));

import User from "../../model/user.model";
import EmergencyContact from "../../model/emergency-contact.model";
import SosSession from "../../model/sos-session.model";
import LineLinkCode from "../../model/line-link-code.model";
import {
  startMongoTest,
  stopMongoTest,
  type MongoTestContext,
} from "../../../tests/helpers/mongo-test-harness";
import { handleEvents } from "./line.service";
import { getActiveSosChoicesForLineUser } from "../sos/sos.service";
import {
  replyText,
  replyMessages,
  pushSosUpdate,
} from "../../adapters/line.adapter";
import { runLineAgent } from "./line-agent.service";
import { appendLineChatTurn } from "./line-memory";
import { LINE_MSG, SOS_MSG } from "../../constants/messages";
import type { LineEvent } from "./line.types";

function text(text: string, userId = "L1"): LineEvent {
  return {
    type: "message",
    replyToken: "reply",
    source: { type: "user", userId },
    message: { type: "text", text },
  } as LineEvent;
}
function click(data: string, userId = "L1"): LineEvent {
  return {
    type: "postback",
    replyToken: "reply",
    source: { type: "user", userId },
    postback: { data },
  } as LineEvent;
}

async function fixture(index: number, lineUserId = "L1") {
  const owner = await User.create({
    name: "同名親友",
    email: `owner${index}@example.test`,
  });
  // Omit bindCode entirely: the existing sparse unique index does not omit null.
  const contact = await EmergencyContact.collection.insertOne({
    userId: String(owner._id),
    name: "照顧者",
    bindStatus: "bound",
    lineUserId,
  });
  const session = await SosSession.create({
    userId: String(owner._id),
    type: "body",
    status: "active",
    handlingStatus: "notified",
    lat: 25,
    lng: 121,
    shareToken: randomUUID(),
    locationUpdatedAt: new Date(),
    acknowledgements: [],
    timeline: [],
  });
  return { owner, contactId: String(contact.insertedId), session };
}

describe("LINE text actions with real binding, authorization and SOS persistence", () => {
  let mongo: MongoTestContext | undefined;
  beforeAll(async () => {
    mongo = await startMongoTest();
  });
  beforeEach(async () => {
    await Promise.all([
      User.deleteMany({}),
      EmergencyContact.deleteMany({}),
      SosSession.deleteMany({}),
      LineLinkCode.deleteMany({}),
    ]);
    vi.clearAllMocks();
    vi.mocked(runLineAgent).mockRejectedValue(new Error("AI unavailable"));
  });
  afterAll(async () => {
    await stopMongoTest(mongo);
  });

  it("redeems a bare emergency code even when AI is unavailable", async () => {
    const f = await fixture(1);
    await EmergencyContact.updateOne(
      { _id: f.contactId },
      {
        $set: {
          bindStatus: "pending",
          lineUserId: null,
          bindCode: "ABC123",
          bindCodeExpiresAt: new Date(Date.now() + 60_000),
        },
      },
    );
    await handleEvents([text(" abc123 ")]);
    expect(await EmergencyContact.findById(f.contactId).lean()).toMatchObject({
      bindStatus: "bound",
      lineUserId: "L1",
    });
    expect(await EmergencyContact.findOne({ bindCode: "ABC123" })).toBeNull();
    expect(replyText).toHaveBeenCalledWith("reply", LINE_MSG.BIND_SUCCESS);
    expect(runLineAgent).not.toHaveBeenCalled();
    expect(appendLineChatTurn).not.toHaveBeenCalled();
  });

  it("refuses a code valid in both namespaces without consuming either", async () => {
    const f = await fixture(1);
    await EmergencyContact.updateOne(
      { _id: f.contactId },
      {
        $set: {
          bindStatus: "pending",
          lineUserId: null,
          bindCode: "ABC123",
          bindCodeExpiresAt: new Date(Date.now() + 60_000),
        },
      },
    );
    await LineLinkCode.create({
      userId: String(f.owner._id),
      code: "ABC123",
      expiresAt: new Date(Date.now() + 60_000),
    });
    await handleEvents([text("ABC123")]);
    expect(replyText).toHaveBeenCalledWith("reply", LINE_MSG.BIND_AMBIGUOUS);
    expect(await EmergencyContact.findById(f.contactId).lean()).toMatchObject({
      bindStatus: "pending",
      bindCode: "ABC123",
    });
    expect(await LineLinkCode.countDocuments({ code: "ABC123" })).toBe(1);
    expect((await User.findById(f.owner._id))?.lineUserId).toBeNull();
  });

  it("distinguishes bound-with-no-active from unbound", async () => {
    const f = await fixture(1);
    await SosSession.updateOne(
      { _id: f.session._id },
      { $set: { status: "resolved" } },
    );
    await handleEvents([text("收到"), text("收到", "STRANGER")]);
    expect(replyText).toHaveBeenCalledWith("reply", LINE_MSG.SOS_NO_ACTIVE);
    expect(replyText).toHaveBeenCalledWith("reply", LINE_MSG.SOS_NO_CONTACTS);
    expect(runLineAgent).not.toHaveBeenCalled();
  });

  it("acknowledges once despite repeated messages", async () => {
    const f = await fixture(1);
    await handleEvents([text("收到"), text("我收到回報")]);
    const saved = await SosSession.findById(f.session._id).lean();
    expect(saved?.handlingStatus).toBe("acknowledged");
    expect(saved?.acknowledgements).toHaveLength(1);
    expect(
      saved?.timeline.filter((entry) => entry.type === "acknowledged"),
    ).toHaveLength(1);
    expect(runLineAgent).not.toHaveBeenCalled();
  });

  it("claims the sole event for the user's combined phrase, without a second ack notification", async () => {
    const f = await fixture(1);
    await EmergencyContact.collection.insertOne({
      userId: String(f.owner._id),
      name: "另一照顧者",
      bindStatus: "bound",
      lineUserId: "L2",
    });
    await handleEvents([text("我收到回報 我處理"), text("我處理")]);
    const saved = await SosSession.findById(f.session._id).lean();
    expect(saved).toMatchObject({ claimedBy: "L1", handlingStatus: "claimed" });
    expect(saved?.acknowledgements).toHaveLength(0);
    expect(
      saved?.timeline.filter((entry) => entry.type === "claimed"),
    ).toHaveLength(1);
    expect(pushSosUpdate).toHaveBeenCalledTimes(1);
  });

  it("does not select latest among multiple owners; a chosen button acts only on its id", async () => {
    const first = await fixture(1);
    const second = await fixture(2);
    await handleEvents([text("我處理")]);
    expect(await SosSession.countDocuments({ claimedBy: "L1" })).toBe(0);
    const payload = JSON.stringify(vi.mocked(replyMessages).mock.calls);
    expect(payload).toContain(String(first.session._id));
    expect(payload).toContain(String(second.session._id));
    await handleEvents([click(`action=claim&sid=${first.session._id}`)]);
    expect((await SosSession.findById(first.session._id))?.claimedBy).toBe(
      "L1",
    );
    expect((await SosSession.findById(second.session._id))?.claimedBy).not.toBe(
      "L1",
    );
  });

  it("paginates all authorized events without treating the final page as a unique target", async () => {
    for (let i = 0; i < 11; i++) await fixture(i);
    const firstPage = await getActiveSosChoicesForLineUser("L1");
    const lastPage = await getActiveSosChoicesForLineUser("L1", 10);
    expect(firstPage.sessions).toHaveLength(10);
    expect(firstPage.hasMore).toBe(true);
    expect(lastPage.sessions).toHaveLength(1);
    expect(lastPage.hasMore).toBe(false);
    expect(
      new Set(
        [...firstPage.sessions, ...lastPage.sessions].map((s) => s.sessionId),
      ).size,
    ).toBe(11);
    await handleEvents([
      click("action=sos_action_page&intent=claim&offset=10"),
    ]);
    expect(await SosSession.countDocuments({ claimedBy: "L1" })).toBe(0);
    expect(JSON.stringify(vi.mocked(replyMessages).mock.calls)).toContain(
      lastPage.sessions[0].sessionId,
    );
  });

  it("deduplicates owners and excludes unbound or another LINE user's events", async () => {
    const mine = await fixture(1);
    await fixture(2, "L2");
    await EmergencyContact.collection.insertOne({
      userId: String(mine.owner._id),
      name: "重複聯絡人",
      bindStatus: "bound",
      lineUserId: "L1",
    });
    const page = await getActiveSosChoicesForLineUser("L1");
    expect(page.sessions.map((s) => s.sessionId)).toEqual([
      String(mine.session._id),
    ]);
    await handleEvents([text("收到")]);
    expect(
      await SosSession.countDocuments({ handlingStatus: "acknowledged" }),
    ).toBe(1);
  });

  it("rechecks binding on a stale or forged button", async () => {
    const f = await fixture(1);
    await handleEvents([
      click(`action=claim&sid=${f.session._id}`, "STRANGER"),
    ]);
    await EmergencyContact.updateOne(
      { _id: f.contactId },
      { $set: { bindStatus: "pending" } },
    );
    await handleEvents([click(`action=claim&sid=${f.session._id}`)]);
    expect(replyText).toHaveBeenCalledWith(
      "reply",
      SOS_MSG.NOT_AUTHORIZED_CONTACT,
    );
    expect((await SosSession.findById(f.session._id))?.claimedBy).not.toBe(
      "L1",
    );
  });

  it("does not claim a resolved event via a stale button", async () => {
    const f = await fixture(1);
    await SosSession.updateOne(
      { _id: f.session._id },
      { $set: { status: "resolved" } },
    );
    await handleEvents([click(`action=claim&sid=${f.session._id}`)]);
    expect(replyText).toHaveBeenCalledWith(
      "reply",
      LINE_MSG.SOS_ALREADY_RESOLVED,
    );
    expect((await SosSession.findById(f.session._id))?.claimedBy).not.toBe(
      "L1",
    );
  });

  it("retains the first claimant when another bound contact claims", async () => {
    const f = await fixture(1);
    await EmergencyContact.collection.insertOne({
      userId: String(f.owner._id),
      name: "另一人",
      bindStatus: "bound",
      lineUserId: "L2",
    });
    await handleEvents([text("我處理"), text("我處理", "L2")]);
    expect((await SosSession.findById(f.session._id))?.claimedBy).toBe("L1");
    expect(replyText).toHaveBeenCalledWith("reply", SOS_MSG.ALREADY_CLAIMED);
  });
});
