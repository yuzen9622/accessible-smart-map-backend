import { GOOGLE_ACCOUNT_RECOVERY_URL } from "../config/email";

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const REQUEST_TIMEOUT_MS = 10_000;
/** 密碼重設頁在前端的路徑（含語言前綴）。 */
const PASSWORD_RESET_PATH = "/zh-TW/reset-password";

function appBaseUrl(): string {
  return (process.env.APP_WEB_BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
}

/**
 * Build the password-reset page URL on the web frontend.
 *
 * The base URL defaults to `APP_WEB_BASE_URL` with trailing slashes stripped
 * (falling back to localhost when unset). The one-time token is
 * percent-encoded so tokens containing `+`, `/`, `=`, `&`, … survive the
 * query string intact.
 *
 * @param token Raw reset token.
 * @param baseUrl Overridable base URL (kept injectable for tests).
 */
export function buildPasswordResetUrl(token: string, baseUrl = appBaseUrl()): string {
  const normalizedBase = baseUrl.replace(/\/+$/, "");
  return `${normalizedBase}${PASSWORD_RESET_PATH}?token=${encodeURIComponent(token)}`;
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
 * RESEND_API_KEY is required. Missing credentials fail closed so queue workers
 * retry instead of dropping mail or leaking one-time tokens into logs.
 *
 * @param input Recipient, subject, HTML body and plain-text fallback.
 * @throws When Resend is configured but rejects the request.
 */
export async function sendEmail(input: {
  to: string;
  subject: string;
  html: string;
  text: string;
  idempotencyKey?: string;
}): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM ?? "no-reply@2026.yuzen.dev";

  if (!apiKey) {
    throw new Error("RESEND_API_KEY is not configured");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...(input.idempotencyKey ? { "Idempotency-Key": input.idempotencyKey } : {}),
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
  idempotencyKey?: string;
}): Promise<void> {
  const url = buildPasswordResetUrl(input.token);
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
    idempotencyKey: input.idempotencyKey,
  });
}

/**
 * Tell a Google-only account owner that this app has no password to reset.
 * This message deliberately contains no app reset token or reset-page link.
 */
export async function sendGooglePasswordResetGuidanceEmail(input: {
  to: string;
  name: string;
  idempotencyKey?: string;
}): Promise<void> {
  await sendEmail({
    to: input.to,
    subject: "你的帳號使用 Google 登入",
    html: layout(
      "請使用 Google 登入",
      `<p style="margin:0 0 16px;line-height:1.7;">${input.name} 你好，此帳號目前使用 Google 登入，因此沒有本站密碼可供重設。</p>
       <p style="margin:0 0 24px;line-height:1.7;">請回到登入頁選擇「使用 Google 登入」。若你忘記的是 Google 帳戶密碼，請使用下方的 Google 帳戶救援服務。</p>
       <p style="margin:0 0 24px;"><a href="${GOOGLE_ACCOUNT_RECOVERY_URL}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;">前往 Google 帳戶救援</a></p>
       <p style="margin:0;font-size:13px;color:#52606d;">若想為本站新增密碼登入方式，請先使用 Google 登入，再到帳號設定中新增密碼。</p>`
    ),
    text: `${input.name} 你好，此帳號目前使用 Google 登入，因此沒有本站密碼可供重設。\n\n請回到登入頁選擇「使用 Google 登入」。若你忘記的是 Google 帳戶密碼，請前往 Google 帳戶救援：\n${GOOGLE_ACCOUNT_RECOVERY_URL}\n\n若想為本站新增密碼登入方式，請先使用 Google 登入，再到帳號設定中新增密碼。`,
    idempotencyKey: input.idempotencyKey,
  });
}
