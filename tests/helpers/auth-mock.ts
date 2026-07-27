import jwt from "jsonwebtoken";
import type { AuthenticateResult } from "../../src/config/auth";
import type { IUser } from "../../src/types";

/**
 * Replacement for `src/config/auth` that verifies the JWT but skips the
 * tokenVersion lookup.
 *
 * Route-level tests stub the service layer and never connect to MongoDB, so the
 * real helper's `User.findById` would reject every request. Use it as an async
 * `vi.mock` factory:
 *
 * ```ts
 * vi.mock("../../config/auth", async () => {
 *   const { createAuthModuleMock } = await import("../../../tests/helpers/auth-mock");
 *   return createAuthModuleMock();
 * });
 * ```
 *
 * @returns A module shape compatible with `src/config/auth`.
 */
export function createAuthModuleMock() {
  return {
    async authenticateToken(token: string): Promise<AuthenticateResult> {
      if (!token) return { ok: false, expired: false };
      try {
        const decoded = jwt.verify(
          token,
          process.env.JWT_ACCESS_SECRET ?? "test-access-secret",
        ) as { user?: IUser };
        const user = decoded.user;
        if (!user?._id) return { ok: false, expired: false };
        return { ok: true, userId: String(user._id), user };
      } catch (error: any) {
        return { ok: false, expired: error?.name === "TokenExpiredError" };
      }
    },
  };
}
