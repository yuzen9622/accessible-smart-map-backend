/**
 * 單例 Token 管理器：負責以 client_credentials 換取、快取與續期 TDX Access Token。
 */
class TdxTokenManager {
  private static _instance: TdxTokenManager;
  private accessToken: string | null = null;
  private expiresAt = 0;
  private refreshing: Promise<string> | null = null;
  private readonly tokenEndpoint =
    process.env.TDX_TOKEN_ENDPOINT ||
    "https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token";
  private readonly safetySeconds = Number(
    process.env.TDX_TOKEN_SAFETY_SECONDS || 60,
  );

  private constructor() {}

  static get instance() {
    if (!this._instance) this._instance = new TdxTokenManager();
    return this._instance;
  }

  async getToken(): Promise<string> {
    const now = Date.now();
    if (this.accessToken && now < this.expiresAt) return this.accessToken;
    return this.refreshToken();
  }

  async refreshToken(force = false): Promise<string> {
    // A caller's 401 must not launch another unbounded shared refresh.
    if (this.refreshing) return this.refreshing;
    if (force) this.accessToken = null;

    const clientId = process.env.TDX_CLIENT_ID;
    const clientSecret = process.env.TDX_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new Error("TDX_CLIENT_ID / TDX_CLIENT_SECRET 未設定");
    }

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error("TDX token timeout")),
      5000,
    );
    this.refreshing = (async () => {
      const body = new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
      });

      const res = await fetch(this.tokenEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`TDX 取得 token 失敗: ${res.status} ${text}`);
      }

      const json = (await res.json()) as {
        access_token: string;
        token_type: string;
        expires_in: number;
      };

      const expiresInMs = Math.max(
        0,
        (json.expires_in - this.safetySeconds) * 1000,
      );
      this.accessToken = json.access_token;
      this.expiresAt = Date.now() + expiresInMs;
      return json.access_token;
    })();

    try {
      return await this.refreshing;
    } finally {
      clearTimeout(timer);
      this.refreshing = null;
    }
  }
}

export const tdxTokenManager = TdxTokenManager.instance;
