import type {
  ContentReportRecord,
  MailRole,
} from "../../model/content-report.model";

const REASONS: Record<string, [string, string]> = {
  inappropriate_image: ["不當圖片", "Inappropriate image"],
  harassment: ["騷擾", "Harassment"],
  personal_information: ["個資外洩", "Personal information exposure"],
  spam: ["垃圾訊息", "Spam"],
  misinformation: ["不實資訊", "Misinformation"],
  other: ["其他", "Other"],
};
const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ] ?? char,
  );

/** Mail bodies are frozen once, before the first dispatch, with no private media URLs. */
export function reportMailPayload(
  report: ContentReportRecord,
  role: MailRole,
  to: string,
  from: string,
) {
  const id = String(report._id);
  const en = role === "reporter" && report.language === "en";
  const reason = REASONS[report.reason]?.[en ? 1 : 0] ?? report.reason;
  const subject =
    role === "team"
      ? `[內容檢舉][${reason}] ${id}`
      : en
        ? `We received your content report | ${id}`
        : `我們已收到你的內容檢舉｜案件編號 ${id}`;
  const text =
    role === "team"
      ? `案件編號：${id}\n提交時間：${report.createdAt.toISOString()}\n內容：${report.targetType} / ${report.targetId}\n原因：${reason}\n補充說明：${report.details}\n內容快照：${report.snapshot}\n\n請由授權維運人員使用案件 API 審查及處理。`
      : en
        ? `Hello,\nWe have received your content report and our team will review it.\nCase number: ${id}\nSubmitted at: ${report.createdAt.toISOString()}\nReason: ${reason}\n\nThis confirms receipt, not a review decision. Thank you for helping keep our community safe.`
        : `您好：\n我們已收到你的內容檢舉，將由團隊進行審查，並依結果採取適當措施。\n案件編號：${id}\n提交時間：${report.createdAt.toISOString()}\n檢舉原因：${reason}\n\n此信表示案件已受理，尚不代表審查結果。感謝你協助維護友善、安全的使用環境。`;
  return {
    from,
    to,
    subject,
    text,
    html: `<div style="white-space:pre-wrap;font-family:sans-serif">${escapeHtml(text)}</div>`,
  };
}
