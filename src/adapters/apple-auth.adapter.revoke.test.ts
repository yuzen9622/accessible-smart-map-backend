import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  exportPKCS8,
  generateKeyPair,
  jwtVerify,
  SignJWT,
  decodeProtectedHeader,
} from "jose";
import {
  AppleTokenRequestError,
  createAppleClientSecret,
  exchangeAppleAuthorizationCode,
  revokeAppleRefreshToken,
} from "./apple-auth.adapter";
import {
  APPLE_ISSUER,
  APPLE_REVOKE_URL,
  APPLE_TOKEN_URL,
  type AppleSigningConfig,
} from "../config/apple";

let config: AppleSigningConfig;
let publicKey: Awaited<ReturnType<typeof generateKeyPair>>["publicKey"];

async function idToken(sub: string): Promise<string> {
  const { privateKey } = await generateKeyPair("RS256");
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256" })
    .setSubject(sub)
    .sign(privateKey);
}

function mockFetch(...responses: Array<Response | Error>) {
  const fn = vi.fn();
  for (const r of responses) {
    if (r instanceof Error) fn.mockRejectedValueOnce(r);
    else fn.mockResolvedValueOnce(r);
  }
  vi.stubGlobal("fetch", fn);
  return fn;
}

function formOf(call: unknown[]): Record<string, string> {
  const init = call[1] as RequestInit;
  return Object.fromEntries(new URLSearchParams(String(init.body)));
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeAll(async () => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  publicKey = pair.publicKey;
  config = {
    teamId: "TEAM123456",
    keyId: "KEY1234567",
    privateKey: await exportPKCS8(pair.privateKey),
    clientId: "dev.yuzen.accessiblesmartmap",
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createAppleClientSecret", () => {
  it("signs an ES256 JWT with the claims Apple requires", async () => {
    const secret = await createAppleClientSecret(config);

    expect(decodeProtectedHeader(secret)).toEqual({
      alg: "ES256",
      kid: "KEY1234567",
    });
    const { payload } = await jwtVerify(secret, publicKey, {
      issuer: "TEAM123456",
      audience: APPLE_ISSUER,
      subject: "dev.yuzen.accessiblesmartmap",
    });
    expect(payload.exp! - payload.iat!).toBeLessThanOrEqual(15777000);
  });
});

describe("exchangeAppleAuthorizationCode", () => {
  it("exchanges the code and returns the refresh token and subject", async () => {
    const fetchMock = mockFetch(
      json(200, {
        access_token: "at",
        refresh_token: "rt",
        id_token: await idToken("apple-sub"),
      }),
    );

    await expect(
      exchangeAppleAuthorizationCode("the-code", config),
    ).resolves.toEqual({ refreshToken: "rt", sub: "apple-sub" });

    expect(fetchMock.mock.calls[0][0]).toBe(APPLE_TOKEN_URL);
    const form = formOf(fetchMock.mock.calls[0]);
    expect(form).toMatchObject({
      client_id: "dev.yuzen.accessiblesmartmap",
      code: "the-code",
      grant_type: "authorization_code",
    });
    await expect(
      jwtVerify(form.client_secret, publicKey),
    ).resolves.toBeTruthy();
  });

  it("reports a code Apple rejects as rejected", async () => {
    mockFetch(json(400, { error: "invalid_grant" }));

    await expect(
      exchangeAppleAuthorizationCode("used-code", config),
    ).rejects.toMatchObject({ kind: "rejected" });
  });

  it.each([
    ["a client misconfiguration", json(400, { error: "invalid_client" })],
    ["an Apple server error", new Response("oops", { status: 502 })],
    ["a network failure", new Error("ECONNRESET")],
    ["a response without tokens", json(200, { access_token: "at" })],
    ["a non-JSON success body", new Response("<html>", { status: 200 })],
    [
      "an unreadable id_token",
      json(200, { refresh_token: "rt", id_token: "not-a-jwt" }),
    ],
  ])("reports %s as unavailable", async (_label, response) => {
    mockFetch(response);

    const error = await exchangeAppleAuthorizationCode("code", config).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(AppleTokenRequestError);
    expect(error).toMatchObject({ kind: "unavailable" });
  });
});

describe("exchangeAppleAuthorizationCode with a broken key", () => {
  it("reports a private key that cannot be imported as unavailable", async () => {
    const fetchMock = mockFetch();

    await expect(
      exchangeAppleAuthorizationCode("code", {
        ...config,
        privateKey: "not a pem",
      }),
    ).rejects.toMatchObject({ kind: "unavailable" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("revokeAppleRefreshToken", () => {
  it("revokes the refresh token", async () => {
    const fetchMock = mockFetch(new Response(null, { status: 200 }));

    await revokeAppleRefreshToken("rt", config);

    expect(fetchMock.mock.calls[0][0]).toBe(APPLE_REVOKE_URL);
    expect(formOf(fetchMock.mock.calls[0])).toMatchObject({
      client_id: "dev.yuzen.accessiblesmartmap",
      token: "rt",
      token_type_hint: "refresh_token",
    });
  });

  it("fails as unavailable when Apple does not return 200", async () => {
    mockFetch(json(400, { error: "invalid_request" }));

    await expect(revokeAppleRefreshToken("rt", config)).rejects.toMatchObject({
      kind: "unavailable",
    });
  });
});
