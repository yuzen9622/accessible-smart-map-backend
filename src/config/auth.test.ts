import { describe, it, expect, vi, beforeEach } from "vitest";
import jwt from "jsonwebtoken";

const findById = vi.fn();

vi.mock("../model/user.model", () => ({
  default: { findById: (...args: unknown[]) => findById(...args) },
}));

import { authenticateToken } from "./auth";

const SECRET = "test-access-secret";
const USER_ID = "665f1a2b3c4d5e6f7a8b9c0d";

function sign(payload: Record<string, unknown>, options?: jwt.SignOptions) {
  return jwt.sign({ user: payload }, SECRET, options);
}

const storedUser = (tokenVersion: number) => ({
  _id: USER_ID,
  name: "Jane",
  email: "jane@example.com",
  authProviders: ["local"],
  emailVerified: true,
  tokenVersion,
});

beforeEach(() => {
  vi.resetAllMocks();
});

describe("authenticateToken", () => {
  it("accepts a token whose tokenVersion matches the stored one", async () => {
    findById.mockResolvedValue(storedUser(3));

    const result = await authenticateToken(
      sign({ _id: USER_ID, tokenVersion: 3 }),
    );

    expect(result).toMatchObject({ ok: true, userId: USER_ID });
  });

  it("rejects a token issued before a password change bumped tokenVersion", async () => {
    findById.mockResolvedValue(storedUser(4));

    const result = await authenticateToken(
      sign({ _id: USER_ID, tokenVersion: 3 }),
    );

    expect(result).toEqual({ ok: false, expired: false });
  });

  it("rejects a token that carries no tokenVersion at all", async () => {
    findById.mockResolvedValue(storedUser(0));

    const result = await authenticateToken(sign({ _id: USER_ID }));

    expect(result).toEqual({ ok: false, expired: false });
  });

  it("reports expiry separately so callers can answer 401 instead of 403", async () => {
    findById.mockResolvedValue(storedUser(0));

    const result = await authenticateToken(
      sign({ _id: USER_ID, tokenVersion: 0 }, { expiresIn: "-1s" }),
    );

    expect(result).toEqual({ ok: false, expired: true });
    expect(findById).not.toHaveBeenCalled();
  });

  it("rejects a token signed with the wrong secret", async () => {
    const forged = jwt.sign(
      { user: { _id: USER_ID, tokenVersion: 0 } },
      "wrong-secret",
    );

    const result = await authenticateToken(forged);

    expect(result).toEqual({ ok: false, expired: false });
    expect(findById).not.toHaveBeenCalled();
  });

  it("rejects a token whose user no longer exists", async () => {
    findById.mockResolvedValue(null);

    const result = await authenticateToken(
      sign({ _id: USER_ID, tokenVersion: 0 }),
    );

    expect(result).toEqual({ ok: false, expired: false });
  });

  it("rejects rather than throws when the id in the token is not a valid ObjectId", async () => {
    findById.mockRejectedValue(new Error("Cast to ObjectId failed"));

    const result = await authenticateToken(
      sign({ _id: "not-an-objectid", tokenVersion: 0 }),
    );

    expect(result).toEqual({ ok: false, expired: false });
  });

  it("rejects an empty token without touching the database", async () => {
    const result = await authenticateToken("");

    expect(result).toEqual({ ok: false, expired: false });
    expect(findById).not.toHaveBeenCalled();
  });

  it("never exposes passwordHash on the resolved user", async () => {
    findById.mockResolvedValue({
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
