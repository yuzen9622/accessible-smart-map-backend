export const APPLE_ISSUER = "https://appleid.apple.com";
export const APPLE_JWKS_URL = "https://appleid.apple.com/auth/keys";
export const APPLE_DEFAULT_AUDIENCE = "dev.yuzen.accessiblesmartmap";
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
