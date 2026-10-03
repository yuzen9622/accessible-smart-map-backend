import { describe, it, expect, afterEach, vi } from "vitest";
import {
  APPLE_DEFAULT_AUDIENCE,
  APPLE_ISSUER,
  APPLE_JWKS_URL,
  APPLE_PRIVATE_RELAY_DOMAIN,
  APPLE_FALLBACK_DISPLAY_NAME,
  getAppleAudiences,
  getAppleSigningConfig,
} from "./apple";

describe("config/apple", () => {
  const originalEnv = process.env.APPLE_CLIENT_IDS;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.APPLE_CLIENT_IDS;
    } else {
      process.env.APPLE_CLIENT_IDS = originalEnv;
    }
  });

  it("exports expected constants", () => {
    expect(APPLE_ISSUER).toBe("https://appleid.apple.com");
    expect(APPLE_JWKS_URL).toBe("https://appleid.apple.com/auth/keys");
    expect(APPLE_DEFAULT_AUDIENCE).toBe("dev.yuzen.accessiblesmartmap");
    expect(APPLE_PRIVATE_RELAY_DOMAIN).toBe("privaterelay.appleid.com");
    expect(APPLE_FALLBACK_DISPLAY_NAME).toBe("Apple 使用者");
  });

  it("returns default audience when APPLE_CLIENT_IDS is unset", () => {
    delete process.env.APPLE_CLIENT_IDS;
    expect(getAppleAudiences()).toEqual(["dev.yuzen.accessiblesmartmap"]);
  });

  it("parses comma-separated allowlist, trims whitespace, filters empty strings, and deduplicates", () => {
    process.env.APPLE_CLIENT_IDS = " a , b , , a ";
    expect(getAppleAudiences()).toEqual(["a", "b"]);
  });

  it("throws when APPLE_CLIENT_IDS is empty or whitespace/commas only", () => {
    process.env.APPLE_CLIENT_IDS = "";
    expect(() => getAppleAudiences()).toThrow(
      "APPLE_CLIENT_IDS is configured but contains no valid client ID",
    );

    process.env.APPLE_CLIENT_IDS = " , ";
    expect(() => getAppleAudiences()).toThrow(
      "APPLE_CLIENT_IDS is configured but contains no valid client ID",
    );
  });
});

describe("getAppleSigningConfig", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function stubSigningEnv(privateKey: string) {
    vi.stubEnv("APPLE_TEAM_ID", " TEAM123456 ");
    vi.stubEnv("APPLE_KEY_ID", "KEY1234567");
    vi.stubEnv("APPLE_PRIVATE_KEY", privateKey);
  }

  it("turns literal \\n into newlines and uses the first client id", () => {
    stubSigningEnv(
      "-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----",
    );
    vi.stubEnv("APPLE_CLIENT_IDS", "dev.app.bundle,dev.app.web");

    expect(getAppleSigningConfig()).toEqual({
      teamId: "TEAM123456",
      keyId: "KEY1234567",
      privateKey: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
      clientId: "dev.app.bundle",
    });
  });

  it("is null when any of the three values is missing", () => {
    stubSigningEnv("");

    expect(getAppleSigningConfig()).toBeNull();
  });
});
