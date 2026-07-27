const RESEND_ENDPOINT = "https://api.resend.com/emails";
const REQUEST_TIMEOUT_MS = 10_000;

function appBaseUrl(): string {
  return (process.env.APP_WEB_BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
}

function layout(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="zh-Hant">
<body style="margin:0;padding:24px;background:#f4f5f7;font-family:'Noto Sans TC','Helvetica Neue',Arial,sans-serif;color:#1f2933;">
  <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px;">
    <h1 style="margin:0 0 16px;font-size:20px;">${title}</h1>
    ${bodyHtml}
    <p style="margin:32px 0 0;font-size:12px;color:#7b8794;">此信件由系統自動寄出，請勿直接回覆。</p>
  </div>
</body>
</html>`;
}

/**
 * Send one transactional email through Resend.
 *
 * When RESEND_API_KEY is absent the message is logged instead of sent, so local
 * development and tests can exercise the full flow without a mail provider.
 *
 * @param input Recipient, subject, HTML body and plain-text fallback.
 * @throws When Resend is configured but rejects the request.
 */
export async function sendEmail(input: {
  to: string;
  subject: string;
  html: string;
  text: string;
}): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM ?? "no-reply@2026.yuzen.dev";

  if (!apiKey) {
    console.warn(
      `[email] RESEND_API_KEY 未設定，未實際寄信。收件人=${input.to} 主旨=${input.subject}\n${input.text}`
    );
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [input.to],
        subject: input.subject,
        html: input.html,
        text: input.text,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`Resend 回應 ${response.status}: ${detail}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Send the account verification email containing a one-time link.
 *
 * @param input Recipient address, display name and the raw verification token.
 */
export async function sendVerificationEmail(input: {
  to: string;
  name: string;
  token: string;
}): Promise<void> {
  const url = `${appBaseUrl()}/verify-email?token=${encodeURIComponent(input.token)}`;
  await sendEmail({
    to: input.to,
    subject: "請驗證你的電子郵件",
    html: layout(
      "驗證你的電子郵件",
      `<p style="margin:0 0 16px;line-height:1.7;">${input.name} 你好，請點擊下方按鈕完成驗證後即可登入。連結 24 小時內有效。</p>
       <p style="margin:0 0 24px;"><a href="${url}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;">驗證電子郵件</a></p>
       <p style="margin:0;font-size:13px;color:#52606d;word-break:break-all;">若按鈕無法點擊，請複製此連結：<br>${url}</p>`
    ),
    text: `${input.name} 你好，請開啟以下連結完成電子郵件驗證後即可登入（24 小時內有效）：\n${url}`,
  });
}

/**
 * Send the password reset email containing a one-time link.
 *
 * @param input Recipient address, display name and the raw reset token.
 */
export async function sendPasswordResetEmail(input: {
  to: string;
  name: string;
  token: string;
}): Promise<void> {
  const url = `${appBaseUrl()}/reset-password?token=${encodeURIComponent(input.token)}`;
  await sendEmail({
    to: input.to,
    subject: "重設你的密碼",
    html: layout(
      "重設你的密碼",
      `<p style="margin:0 0 16px;line-height:1.7;">${input.name} 你好，請點擊下方按鈕設定新密碼。連結 1 小時內有效，且只能使用一次。</p>
       <p style="margin:0 0 24px;"><a href="${url}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;">重設密碼</a></p>
       <p style="margin:0 0 16px;font-size:13px;color:#52606d;word-break:break-all;">若按鈕無法點擊，請複製此連結：<br>${url}</p>
       <p style="margin:0;font-size:13px;color:#52606d;">若這不是你本人的操作，請忽略此信，你的密碼不會有任何變動。</p>`
    ),
    text: `${input.name} 你好，請開啟以下連結重設密碼（1 小時內有效，僅能使用一次）：\n${url}\n\n若這不是你本人的操作，請忽略此信。`,
  });
}
