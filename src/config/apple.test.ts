import { describe, it, expect, afterEach } from "vitest";
import {
  APPLE_DEFAULT_AUDIENCE,
  APPLE_ISSUER,
  APPLE_JWKS_URL,
  APPLE_PRIVATE_RELAY_DOMAIN,
  APPLE_FALLBACK_DISPLAY_NAME,
  getAppleAudiences,
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
