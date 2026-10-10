import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import User from "../../model/user.model";
import Config from "../../model/config.model";
import AuthSession from "../../model/auth-session.model";
import { authenticateWithApple } from "./user.auth.service";
import { hashAppleNonce } from "../../adapters/apple-auth.adapter";
import { APPLE_ISSUER } from "../../config/apple";
import {
  startMongoTest,
  stopMongoTest,
  type MongoTestContext,
} from "../../../tests/helpers/mongo-test-harness";

// Replace only Apple's public-key transport. JWT verification, account linking,
// MongoDB writes, and session issuance all run through production code.
const keys = vi.hoisted(() => ({
  jwks: null as ReturnType<typeof createLocalJWKSet> | null,
}));
vi.mock("jose", async (importOriginal) => {
  const actual = await importOriginal<typeof import("jose")>();
  return {
    ...actual,
    createRemoteJWKSet:
      () =>
      (...args: Parameters<ReturnType<typeof createLocalJWKSet>>) => {
        if (!keys.jwks) throw new Error("Test JWKS not initialized");
        return keys.jwks(...args);
      },
  };
});

describe("Apple sign-in with the shipping iOS audience and real MongoDB", () => {
  let mongo: MongoTestContext | undefined;
  let privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
  const rawNonce = "apple-login-regression-nonce";
  // Intentionally independent of APPLE_DEFAULT_AUDIENCE: this is the App's
  // bundleIdentifier, and the test must catch backend/client configuration drift.
  const appBundleId = "com.accessiblemap.app";

  beforeAll(async () => {
    const pair = await generateKeyPair("RS256", { extractable: true });
    privateKey = pair.privateKey;
    const jwk = await exportJWK(pair.publicKey);
    keys.jwks = createLocalJWKSet({
      keys: [{ ...jwk, kid: "apple-test", alg: "RS256" }],
    });
    mongo = await startMongoTest();
  }, 120_000);

  beforeEach(() => {
    vi.stubEnv("APPLE_CLIENT_IDS", undefined);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all([
      User.deleteMany({}),
      Config.deleteMany({}),
      AuthSession.deleteMany({}),
    ]);
  });

  afterAll(async () => {
    await stopMongoTest(mongo);
  });

  async function token(
    options: {
      email?: string;
      audience?: string;
      verified?: boolean;
      subject?: string;
    } = {},
  ) {
    return new SignJWT({
      ...(options.email
        ? { email: options.email, email_verified: options.verified ?? true }
        : {}),
      nonce: hashAppleNonce(rawNonce),
    })
      .setProtectedHeader({ alg: "RS256", kid: "apple-test" })
      .setIssuer(APPLE_ISSUER)
      .setAudience(options.audience ?? appBundleId)
      .setSubject(options.subject ?? "apple-user-1")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
  }

  it.each(["google", "local"] as const)(
    "links the same verified email to the existing %s account and preserves its data",
    async (provider) => {
      const original = await User.create({
        name: "Existing User",
        email: "existing@example.com",
        authProviders: [provider],
        emailVerified: true,
        ...(provider === "google"
          ? { client_id: "google-user-1" }
          : { passwordHash: "existing-password-hash" }),
      });
      const config = await Config.create({
        user_id: original._id,
        language: "en",
      });

      const result = await authenticateWithApple({
        identityToken: await token({ email: "Existing@Example.com" }),
        nonce: rawNonce,
        name: "Do not replace existing name",
      });

      expect(String(result.user._id)).toBe(String(original._id));
      expect(result.user.name).toBe("Existing User");
      expect(result.user.authProviders).toEqual([provider, "apple"]);
      expect(String(result.config?._id)).toBe(String(config._id));
      expect(result.config?.language).toBe("en");
      expect(result.accessToken).toBeTruthy();
      expect(result.refreshToken).toBeTruthy();
      const stored = await User.findById(original._id).select(
        "+appleUserId +passwordHash",
      );
      expect(stored?.appleUserId).toBe("apple-user-1");
      expect(stored?.client_id).toBe(original.client_id);
      expect(stored?.passwordHash).toBe(
        provider === "local" ? "existing-password-hash" : undefined,
      );
      expect(await User.countDocuments()).toBe(1);
      expect(
        await AuthSession.countDocuments({ userId: String(original._id) }),
      ).toBe(1);

      // Subsequent Apple sign-ins resolve by subject even without an email claim.
      const again = await authenticateWithApple({
        identityToken: await token(),
        nonce: rawNonce,
      });
      expect(String(again.user._id)).toBe(String(original._id));
      expect(again.user.authProviders).toEqual([provider, "apple"]);
      expect(await User.countDocuments()).toBe(1);
    },
  );

  it("rejects an unrelated app audience before creating any account or session", async () => {
    await expect(
      authenticateWithApple({
        identityToken: await token({
          email: "existing@example.com",
          audience: "unrelated.app",
        }),
        nonce: rawNonce,
      }),
    ).rejects.toMatchObject({ reason: "INVALID_TOKEN" });
    expect(await User.countDocuments()).toBe(0);
    expect(await AuthSession.countDocuments()).toBe(0);
  });

  it("keeps an explicit audience allowlist authoritative", async () => {
    vi.stubEnv("APPLE_CLIENT_IDS", "configured.app");
    await expect(
      authenticateWithApple({
        identityToken: await token({ email: "existing@example.com" }),
        nonce: rawNonce,
      }),
    ).rejects.toMatchObject({ reason: "INVALID_TOKEN" });
    const result = await authenticateWithApple({
      identityToken: await token({
        email: "existing@example.com",
        audience: "configured.app",
      }),
      nonce: rawNonce,
    });
    expect(result.user.authProviders).toEqual(["apple"]);
  });

  it("does not link an unverified email or replace an existing Apple identity", async () => {
    const original = await User.create({
      name: "Existing User",
      email: "existing@example.com",
      client_id: "google-user-1",
      authProviders: ["google", "apple"],
      emailVerified: true,
      appleUserId: "different-apple-user",
    });
    await expect(
      authenticateWithApple({
        identityToken: await token({ email: original.email, verified: false }),
        nonce: rawNonce,
      }),
    ).rejects.toMatchObject({ reason: "INVALID_TOKEN" });
    await expect(
      authenticateWithApple({
        identityToken: await token({ email: original.email }),
        nonce: rawNonce,
      }),
    ).rejects.toMatchObject({ reason: "EMAIL_TAKEN" });
    expect(
      (await User.findById(original._id).select("+appleUserId"))?.appleUserId,
    ).toBe("different-apple-user");
    expect(await AuthSession.countDocuments()).toBe(0);
  });
});
