import crypto from "crypto";
import {
  createRemoteJWKSet,
  decodeJwt,
  errors,
  importPKCS8,
  jwtVerify,
  SignJWT,
} from "jose";
import {
  APPLE_CLIENT_SECRET_TTL_SEC,
  APPLE_ISSUER,
  APPLE_JWKS_URL,
  APPLE_REVOKE_URL,
  APPLE_TOKEN_URL,
  type AppleSigningConfig,
} from "../config/apple";

export type AppleIdentity = {
  sub: string;
  email?: string;
  emailVerified: boolean;
  isPrivateEmail: boolean;
};

export class AppleIdentityTokenError extends Error {
  cause?: unknown;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "AppleIdentityTokenError";
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

let appleKeySet: ReturnType<typeof createRemoteJWKSet> | null = null;

function getAppleKeySet(): ReturnType<typeof createRemoteJWKSet> {
  if (!appleKeySet) {
    let url: URL;
    try {
      url = new URL(APPLE_JWKS_URL);
    } catch {
      throw new Error(`Invalid APPLE_JWKS_URL: ${APPLE_JWKS_URL}`);
    }
    appleKeySet = createRemoteJWKSet(url);
  }
  return appleKeySet;
}

const TOKEN_ERRORS = [
  errors.JWTClaimValidationFailed,
  errors.JWTExpired,
  errors.JWTInvalid,
  errors.JWSInvalid,
  errors.JWSSignatureVerificationFailed,
  errors.JOSEAlgNotAllowed,
  errors.JOSENotSupported,
  errors.JWKSNoMatchingKey,
  errors.JWKSMultipleMatchingKeys,
];

/**
 * 計算 rawNonce 的 SHA-256 十六進位雜湊值。
 *
 * @param rawNonce 原始 nonce 字串
 * @returns SHA-256 hex 摘要
 */
export function hashAppleNonce(rawNonce: string): string {
  return crypto.createHash("sha256").update(rawNonce).digest("hex");
}

function toFlag(value: unknown): boolean {
  return value === true || value === "true";
}

/**
 * 驗證 Apple Sign-in 發出的 identityToken。
 * 以 Apple JWKS 驗證 RS256 簽章、發行者 (iss)、受眾 (aud) 與過期時間 (exp)；
 * 若帶入 rawNonce 則以 timingSafeEqual 驗證 hash 相符。
 *
 * @param identityToken Apple 簽發的 JWT identity token
 * @param options.audience 允許的 audience 陣列
 * @param options.rawNonce 客戶端發起登入時使用的原始 nonce（選填）
 * @returns 解析並正規化後的 AppleIdentity
 * @throws {AppleIdentityTokenError} 當 token 格式無效、簽章錯誤、claim 不符或 nonce 不符時
 * @throws {Error} 當基礎設施故障（如 JWKS 網路連線失敗或逾時）時原樣拋出
 */
export async function verifyAppleIdentityToken(
  identityToken: string,
  options: { audience: string[]; rawNonce?: string },
): Promise<AppleIdentity> {
  let payload: Record<string, unknown>;

  try {
    const verified = await jwtVerify(identityToken, getAppleKeySet(), {
      issuer: APPLE_ISSUER,
      audience: options.audience,
      algorithms: ["RS256"],
      requiredClaims: ["exp"],
    });
    payload = verified.payload as Record<string, unknown>;
  } catch (error) {
    if (TOKEN_ERRORS.some((ErrorClass) => error instanceof ErrorClass)) {
      throw new AppleIdentityTokenError("Apple identity token rejected", {
        cause: error,
      });
    }
    throw error;
  }

  if (typeof payload.sub !== "string" || payload.sub.trim().length === 0) {
    throw new AppleIdentityTokenError("Missing or invalid sub claim");
  }

  if (options.rawNonce !== undefined) {
    if (typeof payload.nonce !== "string") {
      throw new AppleIdentityTokenError("nonce mismatch");
    }
    const expected = hashAppleNonce(options.rawNonce);
    const actual = payload.nonce;
    const expectedBuf = Buffer.from(expected);
    const actualBuf = Buffer.from(actual);

    if (
      expectedBuf.length !== actualBuf.length ||
      !crypto.timingSafeEqual(expectedBuf, actualBuf)
    ) {
      throw new AppleIdentityTokenError("nonce mismatch");
    }
  }

  const email =
    typeof payload.email === "string" && payload.email.trim().length > 0
      ? payload.email.trim()
      : undefined;

  return {
    sub: payload.sub,
    email,
    emailVerified: toFlag(payload.email_verified),
    isPrivateEmail: toFlag(payload.is_private_email),
  };
}

/**
 * Apple REST API 請求失敗。kind 為 "rejected" 表示授權碼無效、過期或已使用（使用者可重試），
 * "unavailable" 表示網路、Apple 端或本機設定（client secret）問題。
 */
export class AppleTokenRequestError extends Error {
  constructor(
    public kind: "rejected" | "unavailable",
    message: string,
  ) {
    super(message);
    this.name = "AppleTokenRequestError";
  }
}

const APPLE_REQUEST_TIMEOUT_MS = 10_000;

/**
 * 以 .p8 私鑰簽出呼叫 Apple REST API 用的 client_secret（ES256 JWT）。
 *
 * @param config Apple 簽章設定
 * @returns 簽好的 client_secret
 */
export async function createAppleClientSecret(
  config: AppleSigningConfig,
): Promise<string> {
  const key = await importPKCS8(config.privateKey, "ES256");
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: config.keyId })
    .setIssuer(config.teamId)
    .setIssuedAt(now)
    .setExpirationTime(now + APPLE_CLIENT_SECRET_TTL_SEC)
    .setAudience(APPLE_ISSUER)
    .setSubject(config.clientId)
    .sign(key);
}

async function signClientSecret(config: AppleSigningConfig): Promise<string> {
  try {
    return await createAppleClientSecret(config);
  } catch {
    throw new AppleTokenRequestError(
      "unavailable",
      "Failed to sign Apple client_secret; check APPLE_PRIVATE_KEY",
    );
  }
}

async function postAppleForm(
  url: string,
  form: Record<string, string>,
): Promise<Response> {
  try {
    return await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form),
      signal: AbortSignal.timeout(APPLE_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new AppleTokenRequestError(
      "unavailable",
      `Apple request failed: ${error instanceof Error ? error.message : "unknown"}`,
    );
  }
}

async function appleErrorCode(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    return typeof body.error === "string" ? body.error : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * 以 Sign in with Apple 授權碼向 Apple 換取 token。
 *
 * @param code App 端 Sign in with Apple 回傳的 authorizationCode（單次使用、5 分鐘內有效）
 * @param config Apple 簽章設定
 * @returns refresh token 與 id_token 內的使用者 sub
 * @throws {AppleTokenRequestError} rejected：授權碼被 Apple 拒絕；unavailable：其他失敗
 */
export async function exchangeAppleAuthorizationCode(
  code: string,
  config: AppleSigningConfig,
): Promise<{ refreshToken: string; sub: string }> {
  const res = await postAppleForm(APPLE_TOKEN_URL, {
    client_id: config.clientId,
    client_secret: await signClientSecret(config),
    code,
    grant_type: "authorization_code",
  });

  if (!res.ok) {
    const error = await appleErrorCode(res);
    throw new AppleTokenRequestError(
      error === "invalid_grant" ? "rejected" : "unavailable",
      `Apple token exchange failed: ${res.status} ${error}`,
    );
  }

  let body: { refresh_token?: unknown; id_token?: unknown };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    throw new AppleTokenRequestError(
      "unavailable",
      "Apple token response is not JSON",
    );
  }
  if (
    typeof body.refresh_token !== "string" ||
    typeof body.id_token !== "string"
  ) {
    throw new AppleTokenRequestError(
      "unavailable",
      "Apple token response is missing refresh_token or id_token",
    );
  }

  // The id_token comes straight from Apple's token endpoint over TLS, so its
  // claims can be read without re-verifying the signature (OIDC Core 3.1.3.7).
  let sub: unknown;
  try {
    sub = decodeJwt(body.id_token).sub;
  } catch {
    sub = undefined;
  }
  if (typeof sub !== "string" || !sub) {
    throw new AppleTokenRequestError(
      "unavailable",
      "Apple id_token has no sub",
    );
  }
  return { refreshToken: body.refresh_token, sub };
}

/**
 * 撤銷使用者的 Apple refresh token，解除 App 與該 Apple 帳號的授權。
 *
 * @param refreshToken 要撤銷的 refresh token
 * @param config Apple 簽章設定
 * @throws {AppleTokenRequestError} unavailable：Apple 未回 200
 */
export async function revokeAppleRefreshToken(
  refreshToken: string,
  config: AppleSigningConfig,
): Promise<void> {
  const res = await postAppleForm(APPLE_REVOKE_URL, {
    client_id: config.clientId,
    client_secret: await signClientSecret(config),
    token: refreshToken,
    token_type_hint: "refresh_token",
  });
  if (!res.ok) {
    throw new AppleTokenRequestError(
      "unavailable",
      `Apple token revoke failed: ${res.status} ${await appleErrorCode(res)}`,
    );
  }
}
