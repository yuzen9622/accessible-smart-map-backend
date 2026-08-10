import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildPasswordResetUrl,
  sendGooglePasswordResetGuidanceEmail,
  sendPasswordResetEmail,
} from "./email.adapter";
import { GOOGLE_ACCOUNT_RECOVERY_URL } from "../config/email";

const ORIGINAL_APP_WEB_BASE_URL = process.env.APP_WEB_BASE_URL;
const ORIGINAL_RESEND_API_KEY = process.env.RESEND_API_KEY;

beforeEach(() => {
  process.env.APP_WEB_BASE_URL = "https://app.example.com/";
  delete process.env.RESEND_API_KEY;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

afterEach(() => {
  if (ORIGINAL_APP_WEB_BASE_URL === undefined) delete process.env.APP_WEB_BASE_URL;
  else process.env.APP_WEB_BASE_URL = ORIGINAL_APP_WEB_BASE_URL;
  if (ORIGINAL_RESEND_API_KEY === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = ORIGINAL_RESEND_API_KEY;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("buildPasswordResetUrl — pure URL builder", () => {
  it("builds the /zh-TW/reset-password path on the app base URL", () => {
    const url = buildPasswordResetUrl("token-1", "https://app.example.com");
    expect(new URL(url).pathname).toBe("/zh-TW/reset-password");
    expect(url.startsWith("https://app.example.com/zh-TW/reset-password")).toBe(true);
  });

  it("strips trailing slashes from the base URL", () => {
    const url = buildPasswordResetUrl("token-1", "https://app.example.com///");
    expect(url).toBe("https://app.example.com/zh-TW/reset-password?token=token-1");
  });

  it("reads APP_WEB_BASE_URL by default and normalizes it", () => {
    process.env.APP_WEB_BASE_URL = "https://reset.example.org/";
    expect(buildPasswordResetUrl("token-1")).toBe(
      "https://reset.example.org/zh-TW/reset-password?token=token-1",
    );
  });

  it("falls back to localhost when APP_WEB_BASE_URL is unset", () => {
    delete process.env.APP_WEB_BASE_URL;
    expect(buildPasswordResetUrl("token-1")).toBe(
      "http://localhost:3000/zh-TW/reset-password?token=token-1",
    );
  });

  it("percent-encodes tokens containing /, +, = and &", () => {
    const url = buildPasswordResetUrl("a/b+c=d&e", "https://app.example.com");
    expect(url).toBe("https://app.example.com/zh-TW/reset-password?token=a%2Fb%2Bc%3Dd%26e");
    expect(new URL(url).searchParams.get("token")).toBe("a/b+c=d&e");
  });
});

describe("sendGooglePasswordResetGuidanceEmail", () => {
  it("sends Google recovery guidance without an app reset link or token", async () => {
    process.env.RESEND_API_KEY = "dummy-key";
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    await sendGooglePasswordResetGuidanceEmail({
      to: "google@example.com",
      name: "小明",
      idempotencyKey: "password-assistance/job-google",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    const payload = JSON.parse(init.body as string);
    expect(init.headers).toMatchObject({
      "Idempotency-Key": "password-assistance/job-google",
    });
    expect(payload.subject).toBe("你的帳號使用 Google 登入");
    expect(payload.html).toContain(GOOGLE_ACCOUNT_RECOVERY_URL);
    expect(payload.text).toContain(GOOGLE_ACCOUNT_RECOVERY_URL);
    expect(payload.html).not.toContain("/reset-password");
    expect(payload.text).not.toContain("/reset-password");
    expect(payload.html).not.toContain("token=");
    expect(payload.text).not.toContain("token=");
  });
});

describe("sendPasswordResetEmail — URL lands in both HTML and text", () => {
  it("sends the same reset URL in the html and text bodies of the email", async () => {
    process.env.APP_WEB_BASE_URL = "https://app.example.com/";
    process.env.RESEND_API_KEY = "dummy-key";
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    const token = "a/b+c=d&e";
    await sendPasswordResetEmail({
      to: "user@example.com",
      name: "小明",
      token,
      idempotencyKey: "password-assistance/job-local",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [endpoint, init] = fetchMock.mock.calls[0];
    expect(endpoint).toBe("https://api.resend.com/emails");
    const payload = JSON.parse(init.body as string);
    const expectedUrl = `https://app.example.com/zh-TW/reset-password?token=${encodeURIComponent(token)}`;
    expect(init.headers).toMatchObject({
      "Idempotency-Key": "password-assistance/job-local",
    });
    expect(payload.to).toEqual(["user@example.com"]);
    expect(payload.subject).toBe("重設你的密碼");
    expect(payload.html).toContain(expectedUrl);
    expect(payload.text).toContain(expectedUrl);
  });

  it("fails closed without logging the reset token when RESEND_API_KEY is absent", async () => {
    process.env.APP_WEB_BASE_URL = "https://app.example.com/";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(
      sendPasswordResetEmail({ to: "user@example.com", name: "小明", token: "secret-token" }),
    ).rejects.toThrow("RESEND_API_KEY is not configured");

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
  });
});