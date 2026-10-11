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

// A simple letter: no decorative cards, status badges or boxed sections.
// Keep essential styles inline: the mobile media query is only an enhancement.
function mailLayout(en: boolean, title: string, preview: string, body: string) {
  const brand = en ? "Accessible Smart Map" : "無障礙智慧地圖";
  const footer = en
    ? "This is an automated email. Please do not reply directly."
    : "此信件由系統自動寄出，請勿直接回覆。";
  return `<!doctype html>
<html lang="${en ? "en" : "zh-Hant"}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>@media screen and (max-width:600px){.mail-outer{padding:0!important}.mail-content{padding:28px 20px!important}.mail-summary th,.mail-summary td{display:block!important;width:auto!important}.mail-summary th{padding-bottom:0!important}.mail-summary td{padding-top:0!important;padding-bottom:12px!important}}</style>
</head>
<body style="margin:0;padding:0;background:#ffffff;color:#1f2933;font-family:'Noto Sans TC','Helvetica Neue',Arial,sans-serif;font-size:16px;line-height:1.75;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${escapeHtml(preview)}</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
    <tr><td class="mail-outer" align="center" style="padding:24px 16px;">
      <!--[if mso]><table role="presentation" width="560" align="center"><tr><td><![endif]-->
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:560px;table-layout:fixed;">
        <tr><td class="mail-content" style="padding:32px 24px;">
          <p style="margin:0 0 24px;color:#52606d;font-size:14px;">${brand}</p>
          <h1 style="margin:0 0 24px;font-size:24px;line-height:1.4;color:#0f172a;">${escapeHtml(title)}</h1>
          ${body}
          <p style="margin:28px 0 0;padding-top:20px;border-top:1px solid #e2e8f0;font-size:13px;color:#52606d;">${footer}</p>
        </td></tr>
      </table>
      <!--[if mso]></td></tr></table><![endif]-->
    </td></tr>
  </table>
</body>
</html>`;
}

function summaryRow(label: string, value: string) {
  return `<tr><th scope="row" style="width:100px;padding:4px 16px 4px 0;text-align:left;vertical-align:top;font-size:16px;font-weight:400;color:#52606d;">${escapeHtml(label)}</th><td style="padding:4px 0;font-size:16px;color:#1f2933;vertical-align:top;word-break:break-all;overflow-wrap:anywhere;">${escapeHtml(value)}</td></tr>`;
}

function contentSection(title: string, value: string) {
  return `<h2 style="margin:24px 0 8px;font-size:16px;color:#1f2933;">${escapeHtml(title)}</h2><p style="margin:0;white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;">${escapeHtml(value || "未提供")}</p>`;
}

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
  const team = role === "team";
  const title = team
    ? "新的內容檢舉"
    : en
      ? "We received your report"
      : "我們已收到你的內容檢舉";
  const preview = team
    ? `待審查案件 ${id}・${reason}`
    : en
      ? `Case ${id}. This confirms receipt, not a review decision.`
      : `案件 ${id} 已收到，此信為收件確認，尚非審查結果。`;
  const submittedAt = en
    ? report.createdAt.toISOString()
    : `${new Intl.DateTimeFormat("zh-TW", {
        timeZone: "Asia/Taipei",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      })
        .format(report.createdAt)
        .replace(/\s+/g, " ")}（UTC+8）`;
  const intro = team
    ? "已收到一筆內容檢舉。請先確認以下案件摘要，再由授權維運人員進行審查。"
    : en
      ? "Hello, we received your content report. Our team will review it and take appropriate action based on the findings."
      : "您好，我們已收到你的內容檢舉。團隊將進行審查，並依結果採取適當措施。";
  const notice = team
    ? "請由授權維運人員使用案件 API 審查及處理。此信包含案件資料，請勿轉寄給未授權人員。"
    : en
      ? "This email confirms receipt only. It does not mean the content has been found in violation or removed. Please keep your case number for reference."
      : "這封信僅確認我們已收到檢舉，不代表已認定內容違規或完成移除。請保留案件編號，以便日後辨識此筆回報。";
  const fields: [string, string][] = [
    [en ? "Case number" : "案件編號", id],
    [en ? "Submitted at" : "提交時間", submittedAt],
    [en ? "Reason" : "檢舉原因", reason],
  ];
  if (team) {
    fields.push(
      ["內容類型", report.targetType === "review" ? "地點評論" : "路況回報"],
      ["內容編號", report.targetId],
    );
  }
  const rows = fields
    .map(([label, value]) => summaryRow(label, value))
    .join("");
  const thanks = en
    ? "Thank you for helping keep our community safe and welcoming."
    : "感謝你協助維護友善、安全的使用環境。";
  const body = `
    <p style="margin:0 0 24px;">${intro}</p>
    <table class="mail-summary" width="100%" cellspacing="0" cellpadding="0" border="0" style="table-layout:fixed;">${rows}</table>
    ${team ? contentSection("補充說明", report.details) + contentSection("內容快照", report.snapshot) : ""}
    <p style="margin:24px 0 0;color:#475569;">${notice}</p>
    ${team ? "" : `<p style="margin:20px 0 0;">${thanks}</p>`}`;
  const footer = en
    ? "This is an automated email. Please do not reply directly."
    : "此信件由系統自動寄出，請勿直接回覆。";
  return {
    from,
    to,
    subject,
    text: [
      en ? "Accessible Smart Map" : "無障礙智慧地圖",
      title,
      intro,
      fields.map(([label, value]) => `${label}: ${value}`).join("\n"),
      ...(team
        ? [
            `補充說明：${report.details || "未提供"}`,
            `內容快照：${report.snapshot || "未提供"}`,
          ]
        : []),
      notice,
      ...(team ? [] : [thanks]),
      footer,
    ].join("\n\n"),
    html: mailLayout(en, title, preview, body),
  };
}
