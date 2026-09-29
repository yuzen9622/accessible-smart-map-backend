import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from "jose";

type PrivateKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
import {
  verifyAppleIdentityToken,
  hashAppleNonce,
  AppleIdentityTokenError,
} from "./apple-auth.adapter";
import { APPLE_ISSUER } from "../config/apple";

const holder = vi.hoisted(() => ({
  keySet: null as ReturnType<typeof createLocalJWKSet> | null,
  remoteError: null as unknown,
}));

vi.mock("jose", async (importOriginal) => {
  const actual = await importOriginal<typeof import("jose")>();
  return {
    ...actual,
    createRemoteJWKSet: vi.fn(() => async (h: unknown, t: unknown) => {
      if (holder.remoteError) throw holder.remoteError;
      if (!holder.keySet) throw new Error("keySet not initialized");
      return holder.keySet(h as never, t as never);
    }),
  };
});

describe("adapters/apple-auth.adapter", () => {
  let validPrivateKey: PrivateKey;
  let attackerPrivateKey: PrivateKey;

  beforeAll(async () => {
    const validPair = await generateKeyPair("RS256", { extractable: true });
    validPrivateKey = validPair.privateKey;
    const jwk = await exportJWK(validPair.publicKey);
    jwk.kid = "test-kid";
    jwk.alg = "RS256";
    jwk.use = "sig";
    holder.keySet = createLocalJWKSet({ keys: [jwk] });

    const attackerPair = await generateKeyPair("RS256", { extractable: true });
    attackerPrivateKey = attackerPair.privateKey;
  });

  beforeEach(() => {
    holder.remoteError = null;
  });

  async function signToken(
    claims: Record<string, unknown> = {},
    options: {
      key?: PrivateKey;
      alg?: string;
      kid?: string;
      iss?: string;
      aud?: string | string[];
      sub?: string;
      exp?: number | string | null;
      iat?: number;
    } = {},
  ): Promise<string> {
    const key = options.key ?? validPrivateKey;
    const alg = options.alg ?? "RS256";
    const kid = options.kid ?? "test-kid";

    let jwt = new SignJWT(claims).setProtectedHeader({ alg, kid });

    if (options.iss !== undefined) {
      jwt = jwt.setIssuer(options.iss);
    } else {
      jwt = jwt.setIssuer(APPLE_ISSUER);
    }

    if (options.aud !== undefined) {
      jwt = jwt.setAudience(options.aud);
    } else {
      jwt = jwt.setAudience("dev.yuzen.accessiblesmartmap");
    }

    if (options.sub !== undefined) {
      jwt = jwt.setSubject(options.sub);
    } else {
      jwt = jwt.setSubject("apple-sub-12345");
    }

    if (options.iat !== undefined) {
      jwt = jwt.setIssuedAt(options.iat);
    } else {
      jwt = jwt.setIssuedAt();
    }

    if (options.exp === null) {
      // Do not set expiration claim
    } else if (options.exp !== undefined) {
      jwt = jwt.setExpirationTime(options.exp);
    } else {
      jwt = jwt.setExpirationTime("1h");
    }

    return jwt.sign(key);
  }

  it("successfully verifies valid token with boolean and string flags", async () => {
    const token = await signToken({
      email: "user@example.com",
      email_verified: "true",
      is_private_email: true,
    });

    const result = await verifyAppleIdentityToken(token, {
      audience: ["dev.yuzen.accessiblesmartmap"],
    });

    expect(result).toEqual({
      sub: "apple-sub-12345",
      email: "user@example.com",
      emailVerified: true,
      isPrivateEmail: true,
    });
  });

  it("passes when any audience in the allowlist matches", async () => {
    const token = await signToken({}, { aud: "bundle.id.two" });
    const result = await verifyAppleIdentityToken(token, {
      audience: ["bundle.id.one", "bundle.id.two"],
    });

    expect(result.sub).toBe("apple-sub-12345");
  });

  it("rejects token with invalid issuer", async () => {
    const token = await signToken({}, { iss: "https://evil.issuer.com" });
    await expect(
      verifyAppleIdentityToken(token, {
        audience: ["dev.yuzen.accessiblesmartmap"],
      }),
    ).rejects.toThrow(AppleIdentityTokenError);
  });

  it("rejects token with mismatched audience", async () => {
    const token = await signToken({}, { aud: "other.aud" });
    await expect(
      verifyAppleIdentityToken(token, {
        audience: ["dev.yuzen.accessiblesmartmap"],
      }),
    ).rejects.toThrow(AppleIdentityTokenError);
  });

  it("rejects expired token", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signToken({}, { exp: now - 60, iat: now - 120 });
    await expect(
      verifyAppleIdentityToken(token, {
        audience: ["dev.yuzen.accessiblesmartmap"],
      }),
    ).rejects.toThrow(AppleIdentityTokenError);
  });

  it("rejects token missing exp claim even if signature is valid", async () => {
    const token = await signToken({}, { exp: null });
    await expect(
      verifyAppleIdentityToken(token, {
        audience: ["dev.yuzen.accessiblesmartmap"],
      }),
    ).rejects.toThrow(AppleIdentityTokenError);
  });

  it("rejects token signed by attacker key", async () => {
    const token = await signToken({}, { key: attackerPrivateKey });
    await expect(
      verifyAppleIdentityToken(token, {
        audience: ["dev.yuzen.accessiblesmartmap"],
      }),
    ).rejects.toThrow(AppleIdentityTokenError);
  });

  it("rejects HS256 token", async () => {
    const secret = new TextEncoder().encode(
      "secret-secret-secret-secret-secret-32",
    );
    const jwt = new SignJWT({ sub: "apple-sub-12345" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(APPLE_ISSUER)
      .setAudience("dev.yuzen.accessiblesmartmap")
      .setExpirationTime("1h");
    const token = await jwt.sign(secret);

    await expect(
      verifyAppleIdentityToken(token, {
        audience: ["dev.yuzen.accessiblesmartmap"],
      }),
    ).rejects.toThrow(AppleIdentityTokenError);
  });

  it("passes when rawNonce matches hashed nonce in token", async () => {
    const rawNonce = "super-secret-nonce-123";
    const hashed = hashAppleNonce(rawNonce);
    const token = await signToken({ nonce: hashed });

    const result = await verifyAppleIdentityToken(token, {
      audience: ["dev.yuzen.accessiblesmartmap"],
      rawNonce,
    });
    expect(result.sub).toBe("apple-sub-12345");
  });

  it("rejects when rawNonce does not match token nonce", async () => {
    const token = await signToken({ nonce: "mismatched-nonce-hash" });
    await expect(
      verifyAppleIdentityToken(token, {
        audience: ["dev.yuzen.accessiblesmartmap"],
        rawNonce: "correct-raw-nonce",
      }),
    ).rejects.toThrow(AppleIdentityTokenError);
  });

  it("rejects when rawNonce is provided but token has no nonce claim", async () => {
    const token = await signToken({});
    await expect(
      verifyAppleIdentityToken(token, {
        audience: ["dev.yuzen.accessiblesmartmap"],
        rawNonce: "raw-nonce",
      }),
    ).rejects.toThrow(AppleIdentityTokenError);
  });

  it("passes without rawNonce whether token has nonce claim or not", async () => {
    const tokenWithNonce = await signToken({ nonce: "some-nonce" });
    const res1 = await verifyAppleIdentityToken(tokenWithNonce, {
      audience: ["dev.yuzen.accessiblesmartmap"],
    });
    expect(res1.sub).toBe("apple-sub-12345");

    const tokenWithoutNonce = await signToken({});
    const res2 = await verifyAppleIdentityToken(tokenWithoutNonce, {
      audience: ["dev.yuzen.accessiblesmartmap"],
    });
    expect(res2.sub).toBe("apple-sub-12345");
  });

  it("re-throws infrastructure error as original error and not AppleIdentityTokenError", async () => {
    holder.remoteError = new TypeError("fetch failed");
    const token = await signToken({});

    let caughtError: unknown;
    try {
      await verifyAppleIdentityToken(token, {
        audience: ["dev.yuzen.accessiblesmartmap"],
      });
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(TypeError);
    expect(caughtError).not.toBeInstanceOf(AppleIdentityTokenError);
  });

  it("hashAppleNonce matches known SHA-256 test vector", () => {
    expect(hashAppleNonce("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
