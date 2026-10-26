import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchOtpWalkIdentityResponse,
  fetchOtpWalkPlanResponse,
  OTP_WALK_IDENTITY_QUERY,
  OTP_WALK_PLAN_QUERY,
} from "./otp-walk.adapter";

let handle: (request: IncomingMessage, response: ServerResponse) => void;
const server = createServer((request, response) => handle(request, response));
let baseUrl: string;

beforeEach(async () => {
  handle = (_request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ data: { requestIdentity: null } }));
  };
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("missing test listener");
  baseUrl = `http://127.0.0.1:${address.port}`;
  vi.stubEnv("OTP_BASE_URL", baseUrl);
  vi.stubEnv("OTP_TIMEOUT_MS", "1000");
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  vi.unstubAllEnvs();
});

describe("OTP root identity transport", () => {
  it.each([false, true])(
    "sends exact direct-WALK points and stairs preference %s",
    async (avoidStairs) => {
      let requestBody = "";
      handle = (request, response) => {
        request.setEncoding("utf8");
        request.on("data", (chunk: string) => {
          requestBody += chunk;
        });
        request.on("end", () => {
          response.setHeader("Content-Type", "application/json");
          response.end('{"data":{"plan":{"itineraries":[]}}}');
        });
      };
      expect(
        await fetchOtpWalkPlanResponse({
          profile: "NORMAL",
          origin: { lat: 25.0000001, lng: 121.0034567 },
          destination: { lat: 25.0000003, lng: 121.0154321 },
          date: "2026-10-26",
          time: "23:59:55",
          avoidStairs,
          deadlineMs: Date.now() + 2000,
        }),
      ).toMatchObject({ status: "received" });
      expect(JSON.parse(requestBody)).toEqual({
        query: OTP_WALK_PLAN_QUERY,
        variables: {
          fromLat: 25.0000001,
          fromLon: 121.0034567,
          toLat: 25.0000003,
          toLon: 121.0154321,
          date: "2026-10-26",
          time: "23:59:55",
          stairs: avoidStairs ? 12 : 1,
          profile: "NORMAL",
          wheelchair: false,
          speed: 1.3,
        },
      });
    },
  );
  it("posts the complete root query to the existing OTP endpoint and returns unknown data", async () => {
    let requestBody = "";
    let requestPath: string | undefined;
    let method: string | undefined;
    handle = (request, response) => {
      requestPath = request.url;
      method = request.method;
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        requestBody += chunk;
      });
      request.on("end", () => {
        response.setHeader("Content-Type", "application/json");
        response.end('{"data":{"requestIdentity":{"schemaVersion":"1"}}}');
      });
    };
    vi.stubEnv("OTP_BASE_URL", baseUrl + "/");
    expect(
      await fetchOtpWalkIdentityResponse({ deadlineMs: Date.now() + 2000 }),
    ).toEqual({
      status: "received",
      data: { data: { requestIdentity: { schemaVersion: "1" } } },
    });
    expect(requestPath).toBe("/otp/routers/default/index/graphql");
    expect(method).toBe("POST");
    expect(JSON.parse(requestBody)).toEqual({ query: OTP_WALK_IDENTITY_QUERY });
    expect(OTP_WALK_IDENTITY_QUERY).toContain(
      "compilerArtifacts { path role sha256 byteCount }",
    );
    expect(OTP_WALK_IDENTITY_QUERY).toContain(
      "observedClassDigestSha256 classCount",
    );
  });

  it("fetches twice rather than caching an earlier observed identity", async () => {
    let count = 0;
    handle = (_request, response) => {
      count++;
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ count }));
    };
    const options = { deadlineMs: Date.now() + 2000 };
    expect(await fetchOtpWalkIdentityResponse(options)).toEqual({
      status: "received",
      data: { count: 1 },
    });
    expect(await fetchOtpWalkIdentityResponse(options)).toEqual({
      status: "received",
      data: { count: 2 },
    });
  });

  it("fails before HTTP for expired deadlines or invalid timeout configuration", async () => {
    const hit = vi.fn();
    handle = hit;
    expect(
      await fetchOtpWalkIdentityResponse({ deadlineMs: Date.now() }),
    ).toEqual({ status: "unavailable", reason: "deadline_exceeded" });
    vi.stubEnv("OTP_TIMEOUT_MS", "0");
    expect(
      await fetchOtpWalkIdentityResponse({ deadlineMs: Date.now() + 1000 }),
    ).toEqual({ status: "unavailable", reason: "invalid_budget" });
    expect(hit).not.toHaveBeenCalled();
  });

  it.each(["deadline", "timeout"])(
    "aborts the actual HTTP socket at the %s limit",
    async (limit) => {
      let observedClose: (() => void) | undefined;
      const closed = new Promise<void>((resolve) => {
        observedClose = resolve;
      });
      handle = (request, response) => {
        request.resume();
        response.on("close", () => observedClose?.());
      };
      vi.stubEnv("OTP_TIMEOUT_MS", limit === "timeout" ? "50" : "1000");
      const result = await fetchOtpWalkIdentityResponse({
        deadlineMs: Date.now() + (limit === "deadline" ? 50 : 2000),
      });
      expect(result).toEqual({
        status: "unavailable",
        reason: limit === "deadline" ? "deadline_exceeded" : "timeout",
      });
      await closed;
    },
  );

  it("returns transport failure on HTTP errors rather than a no-route answer", async () => {
    handle = (_request, response) => {
      response.statusCode = 503;
      response.end("unavailable");
    };
    expect(
      await fetchOtpWalkIdentityResponse({ deadlineMs: Date.now() + 2000 }),
    ).toEqual({ status: "unavailable", reason: "transport_error" });
  });

  it("does not follow redirects to a different identity provider", async () => {
    let calls = 0;
    handle = (_request, response) => {
      calls++;
      response.statusCode = 302;
      response.setHeader("Location", baseUrl + "/other");
      response.end();
    };
    expect(
      await fetchOtpWalkIdentityResponse({ deadlineMs: Date.now() + 2000 }),
    ).toEqual({ status: "unavailable", reason: "transport_error" });
    expect(calls).toBe(1);
  });
});
