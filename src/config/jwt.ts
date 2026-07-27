import jwt, {
  JsonWebTokenError,
  JwtPayload,
  TokenExpiredError,
} from "jsonwebtoken";
import { IUser } from "../types/index";

const ACCESS_TOKEN_TTL = "60m";
const REFRESH_TOKEN_TTL = "1d";

/**
 * Reduce a user document to the fields that are safe to expose in a token or an
 * API response. Anything not listed here (notably passwordHash) never leaves
 * the server.
 *
 * @param user User document or plain object.
 * @returns A plain object containing only publicly shareable user fields.
 */
const toPublicUser = (user: IUser): IUser => {
  const source = typeof (user as any)?.toObject === "function" ? (user as any).toObject() : user;
  return {
    _id: String(source._id),
    name: source.name,
    avatar: source.avatar,
    email: source.email,
    client_id: source.client_id ?? null,
    authProviders: source.authProviders ?? [],
    emailVerified: Boolean(source.emailVerified),
    tokenVersion: Number(source.tokenVersion ?? 0),
    lineUserId: source.lineUserId ?? null,
    settings: source.settings,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
  };
};

const createAccessToken = (user: IUser): string =>
  jwt.sign({ user: toPublicUser(user) }, process.env.JWT_ACCESS_SECRET ?? "", {
    expiresIn: ACCESS_TOKEN_TTL,
  });

const createRefreshToken = (user: IUser): string =>
  jwt.sign({ user: toPublicUser(user) }, process.env.JWT_REFRESH_SECRET ?? "", {
    expiresIn: REFRESH_TOKEN_TTL,
  });

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
