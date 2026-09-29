import crypto from "crypto";
import { createRemoteJWKSet, jwtVerify, errors } from "jose";
import { APPLE_ISSUER, APPLE_JWKS_URL } from "../config/apple";

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
