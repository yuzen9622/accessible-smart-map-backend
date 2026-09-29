import { randomUUID } from "node:crypto";
import jwt, {
  JsonWebTokenError,
  JwtPayload,
  TokenExpiredError,
} from "jsonwebtoken";
import { IUser } from "../types/index";

const ACCESS_TOKEN_TTL = "60m";
export const REFRESH_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Reduce a user document to the fields that are safe to expose in a token or an
 * API response. Anything not listed here (notably passwordHash) never leaves
 * the server.
 *
 * @param user User document or plain object.
 * @returns A plain object containing only publicly shareable user fields.
 */
const toPublicUser = (user: IUser): IUser => {
  const source =
    typeof (user as any)?.toObject === "function"
      ? (user as any).toObject()
      : user;
  return {
    _id: String(source._id),
    name: source.name,
    avatar: source.avatar,
    email: source.email,
    client_id: source.client_id ?? null,
    authProviders: source.authProviders ?? [],
    emailVerified: Boolean(source.emailVerified),
    tokenVersion: Number(source.tokenVersion ?? 0),
    role: source.role ?? "user",
    lineUserId: source.lineUserId ?? null,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
  };
};

export interface AccessTokenPayload extends JwtPayload {
  user: IUser;
  sid: string;
}

export interface RefreshTokenPayload extends JwtPayload {
  user: IUser;
  sid: string;
  jti: string;
}

const createAccessToken = (
  user: IUser,
  sidOrOptions: string | { sid: string },
): string => {
  const sid =
    typeof sidOrOptions === "string" ? sidOrOptions : sidOrOptions?.sid;
  if (!sid || typeof sid !== "string") {
    throw new Error("createAccessToken requires a valid sid");
  }
  const payload: Record<string, unknown> = {
    user: toPublicUser(user),
    sid,
  };
  return jwt.sign(payload, process.env.JWT_ACCESS_SECRET ?? "", {
    expiresIn: ACCESS_TOKEN_TTL,
  });
};

const createRefreshToken = (
  user: IUser,
  sidOrOptions: string | { sid: string; jti?: string },
  jtiParam?: string,
): string => {
  const sid =
    typeof sidOrOptions === "string" ? sidOrOptions : sidOrOptions?.sid;
  if (!sid || typeof sid !== "string") {
    throw new Error("createRefreshToken requires a valid sid");
  }
  const jti =
    typeof sidOrOptions === "object" && sidOrOptions?.jti
      ? sidOrOptions.jti
      : (jtiParam ?? randomUUID());
  if (!jti || typeof jti !== "string") {
    throw new Error("createRefreshToken requires a valid jti");
  }
  const payload: Record<string, unknown> = {
    user: toPublicUser(user),
    sid,
    jti,
  };
  return jwt.sign(payload, process.env.JWT_REFRESH_SECRET ?? "", {
    expiresIn: Math.floor(REFRESH_TOKEN_TTL_MS / 1000),
  });
};

const verifyAccessToken = (token: string) => {
  try {
    const decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET ?? "");
    return { success: true, decoded: decoded as JwtPayload };
  } catch (err) {
    if (err instanceof TokenExpiredError) {
      return { success: false, expired: true };
    } else if (err instanceof JsonWebTokenError) {
      return { success: false, expired: false };
    } else {
      return { success: false, expired: false };
    }
  }
};

const verifyRefreshToken = (token: string) => {
  try {
    const decoded = jwt.verify(token, process.env.JWT_REFRESH_SECRET ?? "");
    return { success: true, decoded: decoded as JwtPayload };
  } catch (err) {
    if (err instanceof TokenExpiredError) {
      return { success: false, expired: true };
    } else if (err instanceof JsonWebTokenError) {
      return { success: false, expired: false };
    } else {
      return { success: false, expired: false };
    }
  }
};

export {
  toPublicUser,
  createAccessToken,
  createRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
};
