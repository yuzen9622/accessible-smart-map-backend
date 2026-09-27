import { describe, it, expect, vi, beforeEach } from "vitest";
import jwt from "jsonwebtoken";

const findUserById = vi.fn();
const findSessionById = vi.fn();

vi.mock("../model/user.model", () => ({
  default: { findById: (...args: unknown[]) => findUserById(...args) },
}));

vi.mock("../model/auth-session.model", () => ({
  default: { findById: (...args: unknown[]) => findSessionById(...args) },
}));

import { authenticateToken, verifyActiveSession } from "./auth";

const SECRET = "test-access-secret";
const USER_ID = "665f1a2b3c4d5e6f7a8b9c0d";
const SESSION_ID = "665f1a2b3c4d5e6f7a8b9c0e";

function sign(
  payload: Record<string, unknown>,
  options?: jwt.SignOptions,
  sid: string | null = SESSION_ID,
) {
  const tokenPayload: Record<string, unknown> = { user: payload };
  if (sid !== null) {
    tokenPayload.sid = sid;
  }
  return jwt.sign(tokenPayload, SECRET, options);
}

const storedUser = (tokenVersion: number) => ({
  _id: USER_ID,
  name: "Jane",
  email: "jane@example.com",
  authProviders: ["local"],
  emailVerified: true,
  tokenVersion,
});

const storedSession = (overrides: Record<string, unknown> = {}) => ({
  _id: SESSION_ID,
  userId: USER_ID,
  currentRefreshJti: "jti-1",
  previousRefreshJti: null,
  expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  revokedAt: null,
  revokedReason: null,
  ...overrides,
});

beforeEach(() => {
  vi.resetAllMocks();
  findSessionById.mockResolvedValue(storedSession());
});

describe("authenticateToken", () => {
  it("accepts a token whose tokenVersion and session match", async () => {
    findUserById.mockResolvedValue(storedUser(3));
    findSessionById.mockResolvedValue(storedSession());

    const result = await authenticateToken(
      sign({ _id: USER_ID, tokenVersion: 3 }),
    );

    expect(result).toMatchObject({
      ok: true,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });
  });

  it("rejects a token issued before a password change bumped tokenVersion", async () => {
    findUserById.mockResolvedValue(storedUser(4));

    const result = await authenticateToken(
      sign({ _id: USER_ID, tokenVersion: 3 }),
    );

    expect(result).toEqual({ ok: false, expired: false });
  });

  it("rejects a token that carries no tokenVersion at all", async () => {
    findUserById.mockResolvedValue(storedUser(0));

    const result = await authenticateToken(sign({ _id: USER_ID }));

    expect(result).toEqual({ ok: false, expired: false });
  });

  it("rejects a legacy token that carries no sid at all", async () => {
    findUserById.mockResolvedValue(storedUser(0));

    const result = await authenticateToken(
      sign({ _id: USER_ID, tokenVersion: 0 }, undefined, null),
    );

    expect(result).toEqual({ ok: false, expired: false });
    expect(findUserById).not.toHaveBeenCalled();
    expect(findSessionById).not.toHaveBeenCalled();
  });

  it("rejects a token whose session does not exist in DB", async () => {
    findUserById.mockResolvedValue(storedUser(0));
    findSessionById.mockResolvedValue(null);

    const result = await authenticateToken(
      sign({ _id: USER_ID, tokenVersion: 0 }),
    );

    expect(result).toEqual({ ok: false, expired: false });
  });

  it("rejects a token whose session has been revoked", async () => {
    findUserById.mockResolvedValue(storedUser(0));
    findSessionById.mockResolvedValue(
      storedSession({ revokedAt: new Date(), revokedReason: "user_logout" }),
    );

    const result = await authenticateToken(
      sign({ _id: USER_ID, tokenVersion: 0 }),
    );

    expect(result).toEqual({ ok: false, expired: false });
  });

  it("rejects a token whose session has expired", async () => {
    findUserById.mockResolvedValue(storedUser(0));
    findSessionById.mockResolvedValue(
      storedSession({
        expiresAt: new Date(Date.now() - 10_000),
      }),
    );

    const result = await authenticateToken(
      sign({ _id: USER_ID, tokenVersion: 0 }),
    );

    expect(result).toEqual({ ok: false, expired: false });
  });

  it("rejects a token whose session belongs to a different user", async () => {
    findUserById.mockResolvedValue(storedUser(0));
    findSessionById.mockResolvedValue(
      storedSession({ userId: "different-user-id" }),
    );

    const result = await authenticateToken(
      sign({ _id: USER_ID, tokenVersion: 0 }),
    );

    expect(result).toEqual({ ok: false, expired: false });
  });

  it("fails closed without throwing when session DB lookup fails", async () => {
    findUserById.mockResolvedValue(storedUser(0));
    findSessionById.mockRejectedValue(new Error("Mongo network error"));

    const result = await authenticateToken(
      sign({ _id: USER_ID, tokenVersion: 0 }),
    );

    expect(result).toEqual({ ok: false, expired: false });
  });

  it("reports expiry separately so callers can answer 401 instead of 403", async () => {
    findUserById.mockResolvedValue(storedUser(0));

    const result = await authenticateToken(
      sign({ _id: USER_ID, tokenVersion: 0 }, { expiresIn: "-1s" }),
    );

    expect(result).toEqual({ ok: false, expired: true });
    expect(findUserById).not.toHaveBeenCalled();
    expect(findSessionById).not.toHaveBeenCalled();
  });

  it("rejects a token signed with the wrong secret", async () => {
    const forged = jwt.sign(
      { user: { _id: USER_ID, tokenVersion: 0 }, sid: SESSION_ID },
      "wrong-secret",
    );

    const result = await authenticateToken(forged);

    expect(result).toEqual({ ok: false, expired: false });
    expect(findUserById).not.toHaveBeenCalled();
    expect(findSessionById).not.toHaveBeenCalled();
  });

  it("rejects a token whose user no longer exists", async () => {
    findUserById.mockResolvedValue(null);

    const result = await authenticateToken(
      sign({ _id: USER_ID, tokenVersion: 0 }),
    );

    expect(result).toEqual({ ok: false, expired: false });
  });

  it("rejects rather than throws when the id in the token is not a valid ObjectId", async () => {
    findUserById.mockRejectedValue(new Error("Cast to ObjectId failed"));

    const result = await authenticateToken(
      sign({ _id: "not-an-objectid", tokenVersion: 0 }),
    );

    expect(result).toEqual({ ok: false, expired: false });
  });

  it("rejects an empty token without touching the database", async () => {
    const result = await authenticateToken("");

    expect(result).toEqual({ ok: false, expired: false });
    expect(findUserById).not.toHaveBeenCalled();
    expect(findSessionById).not.toHaveBeenCalled();
  });

  it("never exposes passwordHash on the resolved user", async () => {
    findUserById.mockResolvedValue({
      ...storedUser(0),
      passwordHash: "$2b$12$leaked",
    });

    const result = await authenticateToken(
      sign({ _id: USER_ID, tokenVersion: 0 }),
    );

    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain("leaked");
  });
});

describe("verifyActiveSession", () => {
  it("returns true for a valid raw token and matching user", async () => {
    findUserById.mockResolvedValue(storedUser(0));
    findSessionById.mockResolvedValue(storedSession());

    const token = sign({ _id: USER_ID, tokenVersion: 0 });
    const result = await verifyActiveSession(token, USER_ID);

    expect(result).toBe(true);
  });

  it("returns true for a valid Bearer header string", async () => {
    findUserById.mockResolvedValue(storedUser(0));
    findSessionById.mockResolvedValue(storedSession());

    const token = sign({ _id: USER_ID, tokenVersion: 0 });
    const result = await verifyActiveSession(`Bearer ${token}`);

    expect(result).toBe(true);
  });

  it("returns false when expectedUserId does not match", async () => {
    findUserById.mockResolvedValue(storedUser(0));
    findSessionById.mockResolvedValue(storedSession());

    const token = sign({ _id: USER_ID, tokenVersion: 0 });
    const result = await verifyActiveSession(token, "different-user-id");

    expect(result).toBe(false);
  });

  it("returns false when session is revoked in DB", async () => {
    findUserById.mockResolvedValue(storedUser(0));
    findSessionById.mockResolvedValue(
      storedSession({ revokedAt: new Date(), revokedReason: "user_logout" }),
    );

    const token = sign({ _id: USER_ID, tokenVersion: 0 });
    const result = await verifyActiveSession(token, USER_ID);

    expect(result).toBe(false);
  });

  it("returns false when tokenVersion is bumped (password reset)", async () => {
    findUserById.mockResolvedValue(storedUser(5));
    findSessionById.mockResolvedValue(storedSession());

    const token = sign({ _id: USER_ID, tokenVersion: 0 });
    const result = await verifyActiveSession(token, USER_ID);

    expect(result).toBe(false);
  });

  it("fails closed and returns false on DB error", async () => {
    findUserById.mockRejectedValue(new Error("Database disconnected"));

    const token = sign({ _id: USER_ID, tokenVersion: 0 });
    const result = await verifyActiveSession(token, USER_ID);

    expect(result).toBe(false);
  });

  it("returns false for an empty token without touching DB", async () => {
    const result = await verifyActiveSession("");

    expect(result).toBe(false);
    expect(findUserById).not.toHaveBeenCalled();
    expect(findSessionById).not.toHaveBeenCalled();
  });
});
