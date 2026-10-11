import { describe, expect, it } from "vitest";
import type { ContentReportRecord } from "../../model/content-report.model";
import { reportMailPayload } from "./content-safety.mail";

const createdAt = new Date("2026-10-11T06:30:00.000Z");
function report(
  overrides: Partial<ContentReportRecord> = {},
): ContentReportRecord {
  return {
    _id: "case-123",
    reporterId: "private-reporter-id",
    reporterEmail: "private-reporter@example.test",
    targetType: "review",
    targetId: "private-target-id",
    targetVersion: "private-version",
    authorId: "private-author-id",
    reason: "harassment",
    details: "private-details\nSecond line",
    language: "zh-TW",
    snapshot: "private-snapshot",
    status: "open",
    createdAt,
    purgeAt: new Date("2027-01-01T00:00:00.000Z"),
    mails: {
      team: { state: "pending", attempts: 0, nextAttemptAt: createdAt },
      reporter: { state: "pending", attempts: 0, nextAttemptAt: createdAt },
    },
    decisions: [],
    ...overrides,
  };
}
const payload = (value = report(), role: "team" | "reporter" = "reporter") =>
  reportMailPayload(value, role, "to@example.test", "from@example.test");

const reasons = [
  ["inappropriate_image", "不當圖片", "Inappropriate image"],
  ["harassment", "騷擾", "Harassment"],
  ["personal_information", "個資外洩", "Personal information exposure"],
  ["spam", "垃圾訊息", "Spam"],
  ["misinformation", "不實資訊", "Misinformation"],
  ["other", "其他", "Other"],
];

describe("content report email templates", () => {
  it("uses the current brand and a responsive letter without decorative cards", () => {
    const mail = payload();
    expect(mail.from).toBe("from@example.test");
    expect(mail.to).toBe("to@example.test");
    expect(mail.subject).toBe("我們已收到你的內容檢舉｜案件編號 case-123");
    expect(mail.html).toContain('<html lang="zh-Hant">');
    expect(mail.html).toContain("無障礙智慧地圖");
    expect(mail.text).toContain("無障礙智慧地圖");
    expect(mail.html).not.toMatch(
      /border-radius|box-shadow|#f4f5f7|#f8fafc|#eff6ff/,
    );
    expect(mail.html).not.toContain("已收到檢舉</span>");
    expect(mail.html).toContain('role="presentation"');
    expect(mail.html).toContain('scope="row"');
    expect(mail.html).toContain("@media screen and (max-width:600px)");
    expect(mail.html).toContain("overflow-wrap:anywhere");
    expect(mail.html).toContain("mso-hide:all");
    expect(mail.html).not.toMatch(/<script|<img|<svg|<link|<a\b/i);
  });

  it.each(reasons)(
    "localizes %s in the HTML and plain-text receipt",
    (reason, zh, en) => {
      for (const [language, label] of [
        ["zh-TW", zh],
        ["en", en],
      ] as const) {
        const mail = payload(report({ reason, language }));
        expect(mail.html).toContain(label);
        expect(mail.text).toContain(label);
        expect(mail.subject).toContain("case-123");
      }
    },
  );

  it.each(["zh-TW", "en"] as const)(
    "keeps %s receipts private and does not imply a decision",
    (language) => {
      const value = report({ language });
      const mail = payload(value);
      for (const secret of [
        value.reporterId,
        value.reporterEmail ?? "",
        value.targetId,
        value.targetVersion,
        value.authorId,
        value.details.split("\n")[0],
        value.snapshot,
      ]) {
        expect(mail.html).not.toContain(secret);
        expect(mail.text).not.toContain(secret);
      }
      for (const body of [mail.html, mail.text]) {
        expect(body).toContain(value._id);
        expect(body).toContain(language === "en" ? "does not mean" : "不代表");
        expect(body).toContain(
          language === "en" ? "Please do not reply" : "請勿直接回覆",
        );
      }
      expect(mail.html).not.toContain("查看進度");
      expect(mail.html).not.toContain("Track your report");
    },
  );

  it("fully localizes the English receipt and preserves its subject and UTC timestamp", () => {
    const mail = payload(report({ language: "en" }));
    expect(mail.subject).toBe("We received your content report | case-123");
    expect(mail.html).toContain('<html lang="en">');
    expect(mail.html).toContain("Accessible Smart Map");
    expect(mail.text).toContain("Accessible Smart Map");
    expect(mail.html).toContain("We received your report");
    expect(mail.html).not.toMatch(/[\u3400-\u9fff]/);
    expect(mail.html).toContain(createdAt.toISOString());
    expect(mail.text).toContain(createdAt.toISOString());
  });

  it("labels the Chinese receipt time in Taipei's time zone", () => {
    const mail = payload();
    expect(mail.html).toContain("2026/10/11 14:30（UTC+8）");
    expect(mail.text).toContain("2026/10/11 14:30（UTC+8）");
  });

  it.each(["review", "hazard_report"] as const)(
    "renders %s team mail with the full review context, always in Chinese",
    (targetType) => {
      const value = report({ language: "en", targetType });
      const mail = payload(value, "team");
      expect(mail.subject).toBe("[內容檢舉][騷擾] case-123");
      expect(mail.html).toContain('<html lang="zh-Hant">');
      for (const body of [mail.html, mail.text]) {
        expect(body).toContain(value.targetId);
        expect(body).toContain(value.details);
        expect(body).toContain(value.snapshot);
        expect(body).toContain("案件 API");
        expect(body).toContain("請勿轉寄");
      }
      expect(mail.html).toContain(
        targetType === "review" ? "地點評論" : "路況回報",
      );
      expect(mail.html).toContain("新的內容檢舉");
      expect(mail.html).not.toMatch(/border-radius|box-shadow|#f8fafc|<span\b/);
    },
  );

  it("escapes every dynamic HTML field, leaving raw content only in plain text", () => {
    const attack = `<img src="https://private.example/photo" onerror='alert(1)'>&`;
    const mail = payload(
      report({
        _id: attack,
        reason: attack,
        targetId: attack,
        details: attack,
        snapshot: attack,
      }),
      "team",
    );
    expect(mail.html).not.toContain("<img");
    expect(mail.html).not.toContain(attack);
    expect(mail.html).toContain("&lt;img src=&quot;");
    expect(mail.html).toContain("&#39;alert(1)&#39;&gt;&amp;");
    expect(mail.text).toContain(attack);
  });

  it("provides clear placeholders for absent team-only text and contains no media request", () => {
    const mail = payload(report({ details: "", snapshot: "" }), "team");
    expect(mail.html.match(/未提供/g)).toHaveLength(2);
    expect(mail.html).not.toMatch(/(?:src|href)=/i);
  });
});
