export const APPLE_ISSUER = "https://appleid.apple.com";
export const APPLE_JWKS_URL = "https://appleid.apple.com/auth/keys";
export const APPLE_TOKEN_URL = "https://appleid.apple.com/auth/token";
export const APPLE_REVOKE_URL = "https://appleid.apple.com/auth/revoke";
export const APPLE_CLIENT_SECRET_TTL_SEC = 5 * 60;
export const APPLE_DEFAULT_AUDIENCE = "com.accessiblemap.app";
export const APPLE_PRIVATE_RELAY_DOMAIN = "privaterelay.appleid.com";
export const APPLE_FALLBACK_DISPLAY_NAME = "Apple 使用者";

/**
 * 解析 Apple 允許的 Audience (Client IDs)。
 * 當 process.env.APPLE_CLIENT_IDS 有設定時，以逗號分隔解析並去重；
 * 若解析後無有效 ID 則拋出 Error。
 * 若未設定，預設回傳 App Bundle ID [APPLE_DEFAULT_AUDIENCE]。
 *
 * @returns 允許的 Apple Audience 陣列
 * @throws {Error} 當 APPLE_CLIENT_IDS 設定但未包含任何有效 Client ID 時
 */
export function getAppleAudiences(): string[] {
  if (process.env.APPLE_CLIENT_IDS !== undefined) {
    const raw = process.env.APPLE_CLIENT_IDS;
    const audiences = Array.from(
      new Set(
        raw
          .split(",")
          .map((id) => id.trim())
          .filter((id) => id.length > 0),
      ),
    );
    if (audiences.length === 0) {
      throw new Error(
        "APPLE_CLIENT_IDS is configured but contains no valid client ID",
      );
    }
    return audiences;
  }

  return [APPLE_DEFAULT_AUDIENCE];
}

export interface AppleSigningConfig {
  teamId: string;
  keyId: string;
  privateKey: string;
  clientId: string;
}

/**
 * 讀取呼叫 Apple REST API（換 token、撤銷 token）所需的簽章設定。
 * APPLE_PRIVATE_KEY 為 .p8 的 PEM 內容，允許以字面 `\n` 表示換行；
 * client_id 取 APPLE_CLIENT_IDS 的第一個（原生 App 的 Bundle ID）。
 *
 * @returns 簽章設定；APPLE_TEAM_ID、APPLE_KEY_ID、APPLE_PRIVATE_KEY 任一未設定時為 null
 */
export function getAppleSigningConfig(): AppleSigningConfig | null {
  const teamId = process.env.APPLE_TEAM_ID?.trim();
  const keyId = process.env.APPLE_KEY_ID?.trim();
  const privateKey = process.env.APPLE_PRIVATE_KEY?.replace(
    /\\n/g,
    "\n",
  ).trim();
  if (!teamId || !keyId || !privateKey) return null;
  return { teamId, keyId, privateKey, clientId: getAppleAudiences()[0] };
}
