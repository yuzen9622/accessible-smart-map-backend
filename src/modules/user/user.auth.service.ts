import crypto from "crypto";
import bcrypt from "bcryptjs";
import { OAuth2Client } from "google-auth-library";
import User from "../../model/user.model";
import Config from "../../model/config.model";
import AuthToken from "../../model/auth-token.model";
import {
  sendGooglePasswordResetGuidanceEmail,
  sendPasswordResetEmail,
  sendVerificationEmail,
} from "../../adapters/email.adapter";
import { toPublicUser } from "../../config/jwt";
import type { AuthTokenType, IConfig, IUser } from "../../types";
import {
  enqueuePasswordAssistance,
  getOrSetPasswordResetExpiry,
  renewPasswordAssistanceLease,
} from "./user.password-assistance.queue";

const BCRYPT_COST = 12;
const EMAIL_VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;
const DB_OPERATION_MAX_MS = 10_000;

/**
 * A hash of a value nobody can supply, compared against when the account does
 * not exist so that a failed login costs the same time as a successful one.
 */
const DUMMY_HASH = "$2b$12$C6UzMDM.H6dfI/f/IKcEe.O1oOb7wXHrN.HGoTvcNjBjWlKr1u2Bu";

export type AuthFailure =
  | "INVALID_CREDENTIALS"
  | "EMAIL_NOT_VERIFIED"
  | "EMAIL_TAKEN"
  | "INVALID_TOKEN"
  | "PASSWORD_REQUIRED";

export class AuthError extends Error {
  constructor(public reason: AuthFailure) {
    super(reason);
    this.name = "AuthError";
  }
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/**
 * Issue a single-use token, invalidating any earlier token of the same type for
 * this user so an old email cannot be replayed.
 *
 * @param userId Owner of the token.
 * @param type Which flow the token belongs to.
 * @returns The raw token; only its sha256 hash is persisted.
 */
async function issueAuthToken(userId: string, type: AuthTokenType): Promise<string> {
  const raw = crypto.randomBytes(32).toString("base64url");
  const ttl = type === "email_verify" ? EMAIL_VERIFY_TTL_MS : PASSWORD_RESET_TTL_MS;

  await AuthToken.findOneAndUpdate(
    { userId, type },
    {
      $set: {
        tokenHash: hashToken(raw),
        expiresAt: new Date(Date.now() + ttl),
        usedAt: null,
      },
    },
    {
      upsert: true,
      returnDocument: "after",
      runValidators: true,
      setDefaultsOnInsert: true,
      maxTimeMS: DB_OPERATION_MAX_MS,
    },
  );

  return raw;
}

/**
 * Add or refresh this job's reset token without invalidating links from other
 * queued jobs. Consumed entries remain until expiry so a crashed job cannot
 * recreate a token that was already used.
 */
async function issuePasswordResetToken(input: {
  userId: string;
  rawToken: string;
  expiresAt: Date;
  jobId: string;
}): Promise<string | null> {
  const now = new Date();
  const user = await User.findOneAndUpdate(
    {
      _id: input.userId,
      authProviders: "local",
      passwordResetTokens: {
        $not: { $elemMatch: { jobId: input.jobId, consumedAt: { $exists: true } } },
      },
    },
    [
      {
        $set: {
          passwordResetTokens: {
            $concatArrays: [
              {
                $filter: {
                  input: { $ifNull: ["$passwordResetTokens", []] },
                  as: "token",
                  cond: {
                    $and: [
                      { $gt: ["$$token.expiresAt", now] },
                      { $ne: ["$$token.jobId", input.jobId] },
                    ],
                  },
                },
              },
              [
                {
                  jobId: input.jobId,
                  tokenHash: hashToken(input.rawToken),
                  expiresAt: input.expiresAt,
                },
              ],
            ],
          },
        },
      },
    ],
    { returnDocument: "after", maxTimeMS: DB_OPERATION_MAX_MS },
  );
  return user ? input.rawToken : null;
}

/**
 * Consume a single-use token and return the user it belongs to.
 *
 * @param raw Raw token as it appeared in the email link.
 * @param type Expected token type.
 * @returns The owning user document.
 * @throws AuthError INVALID_TOKEN when the token is unknown, expired or already used.
 */
async function consumeAuthToken(raw: string, type: AuthTokenType) {
  const record = await AuthToken.findOneAndDelete(
    {
      tokenHash: hashToken(raw),
      type,
      usedAt: null,
      expiresAt: { $gt: new Date() },
    },
    { maxTimeMS: DB_OPERATION_MAX_MS },
  );
  if (!record) throw new AuthError("INVALID_TOKEN");

  const user = await User.findById(record.userId, null, { maxTimeMS: DB_OPERATION_MAX_MS });
  if (!user) throw new AuthError("INVALID_TOKEN");
  return user;
}

async function ensureConfig(userId: unknown): Promise<IConfig | null> {
  const existing = await Config.findOne({ user_id: userId });
  if (existing) return existing;
  return Config.create({ user_id: userId });
}

/**
 * Create a local (email + password) account and email a verification link.
 *
 * The account cannot log in until the address is verified, so no token is issued
 * here.
 *
 * @param input Display name, email address and plaintext password.
 * @returns Whether the verification email was actually delivered.
 * @throws AuthError EMAIL_TAKEN when the address already belongs to an account.
 */
export async function registerLocalUser(input: {
  name: string;
  email: string;
  password: string;
}): Promise<{ emailSent: boolean }> {
  const email = normalizeEmail(input.email);

  if (await User.exists({ email })) {
    throw new AuthError("EMAIL_TAKEN");
  }

  const passwordHash = await bcrypt.hash(input.password, BCRYPT_COST);

  let user;
  try {
    user = await User.create({
      name: input.name,
      email,
      passwordHash,
      authProviders: ["local"],
      emailVerified: false,
    });
  } catch (error: any) {
    if (error?.code === 11000) throw new AuthError("EMAIL_TAKEN");
    throw error;
  }

  await ensureConfig(user._id);

  const token = await issueAuthToken(String(user._id), "email_verify");
  if (!token) throw new Error("Failed to issue email verification token");
  try {
    await sendVerificationEmail({ to: email, name: user.name, token });
    return { emailSent: true };
  } catch (error) {
    console.error("[auth] 驗證信寄送失敗，使用者可自行重寄", error);
    return { emailSent: false };
  }
}

/**
 * Authenticate an email + password pair.
 *
 * @param input Email address and plaintext password.
 * @returns The authenticated user and its config.
 * @throws AuthError INVALID_CREDENTIALS on a bad pair, EMAIL_NOT_VERIFIED when the address is unverified.
 */
export async function loginLocalUser(input: {
  email: string;
  password: string;
}): Promise<{ user: IUser; config: IConfig | null }> {
  const email = normalizeEmail(input.email);
  const user = await User.findOne({ email }).select("+passwordHash");

  const hash = user?.passwordHash ?? DUMMY_HASH;
  const matches = await bcrypt.compare(input.password, hash);

  if (!user || !user.passwordHash || !matches) {
    throw new AuthError("INVALID_CREDENTIALS");
  }

  if (!user.emailVerified) {
    throw new AuthError("EMAIL_NOT_VERIFIED");
  }

  const config = await Config.findOne({ user_id: user._id });
  return { user: toPublicUser(user), config };
}

/**
 * Verify an email address using the token from the verification email and log the
 * user in.
 *
 * @param rawToken Raw token from the verification link.
 * @returns The verified user and its config.
 * @throws AuthError INVALID_TOKEN when the token is unknown, expired or used.
 */
export async function verifyEmail(
  rawToken: string
): Promise<{ user: IUser; config: IConfig | null }> {
  const user = await consumeAuthToken(rawToken, "email_verify");

  user.emailVerified = true;
  await user.save();

  const config = await ensureConfig(user._id);
  return { user: toPublicUser(user), config };
}

/**
 * Re-send the verification email for an unverified account.
 *
 * Returns silently for unknown or already-verified addresses so the endpoint
 * cannot be used to discover which addresses are registered.
 *
 * @param rawEmail Address to re-send to.
 */
export async function resendVerificationEmail(rawEmail: string): Promise<void> {
  const email = normalizeEmail(rawEmail);
  const user = await User.findOne({ email });
  if (!user || user.emailVerified) return;

  const token = await issueAuthToken(String(user._id), "email_verify");
  if (!token) throw new Error("Failed to issue email verification token");
  try {
    await sendVerificationEmail({ to: email, name: user.name, token });
  } catch (error) {
    console.error("[auth] 驗證信重寄失敗", error);
  }
}

/**
 * Start the password reset flow.
 *
 * Persist a password-assistance request before the API acknowledges it.
 * Every syntactically valid address follows this same queue-write path, so the
 * HTTP status cannot reveal account existence or provider type.
 *
 * @param rawEmail Address supplied by the requester.
 * @throws When the durable queue cannot accept the request.
 */
export async function requestPasswordReset(rawEmail: string): Promise<void> {
  await enqueuePasswordAssistance(normalizeEmail(rawEmail));
}

/**
 * Resolve one queued password-assistance request in the background.
 *
 * Unverified local accounts remain eligible because inbox control proves
 * ownership. Google-only accounts receive provider guidance without an app
 * reset token, while unknown addresses intentionally produce no email.
 */
export async function processPasswordAssistance(input: {
  email: string;
  jobId: string;
  leaseToken: string;
}): Promise<void> {
  const email = normalizeEmail(input.email);
  const idempotencyKey = `password-assistance/${input.jobId}`;
  const user = await User.findOne({ email }, null, { maxTimeMS: DB_OPERATION_MAX_MS });
  if (!user) return;

  if (!user.authProviders.includes("local")) {
    if (user.authProviders.includes("google")) {
      const ownsLease = await renewPasswordAssistanceLease({
        jobId: input.jobId,
        leaseToken: input.leaseToken,
      });
      if (!ownsLease) throw new Error("Password assistance lease lost before dispatch");
      await sendGooglePasswordResetGuidanceEmail({
        to: email,
        name: user.name,
        idempotencyKey,
      });
    }
    return;
  }

  // Persist this job's first expiry under its lease. Retries reuse the exact
  // timestamp rather than extending a previously delivered link indefinitely.
  const tokenExpiresAt = await getOrSetPasswordResetExpiry({
    jobId: input.jobId,
    leaseToken: input.leaseToken,
    ttlMs: PASSWORD_RESET_TTL_MS,
  });
  if (!tokenExpiresAt) throw new Error("Password assistance lease lost before token rotation");
  if (tokenExpiresAt.getTime() <= Date.now()) return;

  const tokenSecret = process.env.PASSWORD_RESET_TOKEN_SECRET;
  if (!tokenSecret || Buffer.byteLength(tokenSecret, "utf8") < 32) {
    throw new Error("PASSWORD_RESET_TOKEN_SECRET must contain at least 32 bytes");
  }
  const stableToken = crypto
    .createHmac("sha256", tokenSecret)
    .update(`password-assistance:${input.jobId}`)
    .digest("base64url");
  const token = await issuePasswordResetToken({
    userId: String(user._id),
    rawToken: stableToken,
    expiresAt: tokenExpiresAt,
    jobId: input.jobId,
  });
  if (!token) return;

  const ownsLease = await renewPasswordAssistanceLease({
    jobId: input.jobId,
    leaseToken: input.leaseToken,
  });
  if (!ownsLease) throw new Error("Password assistance lease lost before dispatch");

  await sendPasswordResetEmail({
    to: email,
    name: user.name,
    token,
    idempotencyKey,
  });
}

/**
 * Complete a password reset.
 *
 * Succeeding also proves inbox ownership, so the address is marked verified and
 * every previously issued token is revoked.
 *
 * @param input Raw reset token and the new plaintext password.
 * @returns The updated user and its config.
 * @throws AuthError INVALID_TOKEN when the token is unknown, expired or used.
 */
export async function resetPassword(input: {
  token: string;
  password: string;
}): Promise<{ user: IUser; config: IConfig | null }> {
  // Hash first so a local CPU failure cannot consume an otherwise valid token.
  // Token validation, provider guard, password write, revocation increment and
  // token removal then happen in one atomic update on the same User document.
  const passwordHash = await bcrypt.hash(input.password, BCRYPT_COST);
  const now = new Date();
  const user = await User.findOneAndUpdate(
    {
      passwordResetTokens: {
        $elemMatch: {
          tokenHash: hashToken(input.token),
          expiresAt: { $gt: now },
          consumedAt: { $exists: false },
        },
      },
      authProviders: "local",
    },
    [
      {
        $set: {
          passwordHash: { $literal: passwordHash },
          emailVerified: true,
          tokenVersion: { $add: [{ $ifNull: ["$tokenVersion", 0] }, 1] },
          // Each queued email owns an independent one-time token. Consume only
          // the matching entry: another link may be in flight, and consuming it
          // before dispatch would make the newest delivered email immediately
          // invalid. The consumed tombstone blocks this job from recreating it.
          passwordResetTokens: {
            $map: {
              input: { $ifNull: ["$passwordResetTokens", []] },
              as: "token",
              in: {
                $cond: [
                  { $eq: ["$$token.tokenHash", hashToken(input.token)] },
                  { $mergeObjects: ["$$token", { consumedAt: now }] },
                  "$$token",
                ],
              },
            },
          },
        },
      },
    ],
    { returnDocument: "after", maxTimeMS: DB_OPERATION_MAX_MS },
  );
  if (!user) throw new AuthError("INVALID_TOKEN");

  const config = await ensureConfig(user._id);
  return { user: toPublicUser(user), config };
}

/**
 * Change or set the password of a signed-in account.
 *
 * currentPassword may be omitted only when the account has no password yet,
 * which is how a Google-only user adds password login.
 *
 * @param input Target user id, optional current password and the new password.
 * @returns The updated user, whose earlier tokens are now revoked.
 * @throws AuthError INVALID_TOKEN when the user is gone, PASSWORD_REQUIRED or INVALID_CREDENTIALS otherwise.
 */
export async function changePassword(input: {
  userId: string;
  currentPassword?: string;
  newPassword: string;
}): Promise<{ user: IUser }> {
  const user = await User.findById(input.userId).select("+passwordHash");
  if (!user) throw new AuthError("INVALID_TOKEN");

  if (user.passwordHash) {
    if (!input.currentPassword) throw new AuthError("PASSWORD_REQUIRED");
    const matches = await bcrypt.compare(input.currentPassword, user.passwordHash);
    if (!matches) throw new AuthError("INVALID_CREDENTIALS");
  }

  user.passwordHash = await bcrypt.hash(input.newPassword, BCRYPT_COST);
  user.tokenVersion = Number(user.tokenVersion ?? 0) + 1;
  if (!user.authProviders.includes("local")) user.authProviders.push("local");
  await user.save();

  return { user: toPublicUser(user) };
}

let googleClient: OAuth2Client | null = null;

function getGoogleClient(): OAuth2Client {
  if (!googleClient) googleClient = new OAuth2Client();
  return googleClient;
}

/**
 * Verify a Google ID token server-side and resolve it to an account.
 *
 * Identity comes only from the verified token payload. An existing account with
 * the same address is linked; if that account was an unverified local one its
 * password is dropped, because a password that was never confirmed by email has
 * no claim on an address Google has confirmed.
 *
 * @param idToken The ID token issued to the frontend by Google Sign-In.
 * @returns The resolved user and its config.
 * @throws AuthError INVALID_TOKEN when the ID token or its email claim is unusable.
 */
export async function authenticateWithGoogle(
  idToken: string
): Promise<{ user: IUser; config: IConfig | null }> {
  const audience = process.env.GOOGLE_CLIENT_ID;
  if (!audience) {
    throw new Error("GOOGLE_CLIENT_ID is not configured");
  }

  let payload;
  try {
    const ticket = await getGoogleClient().verifyIdToken({ idToken, audience });
    payload = ticket.getPayload();
  } catch (error) {
    console.error("[auth] Google ID token 驗證失敗", error);
    throw new AuthError("INVALID_TOKEN");
  }

  if (!payload?.sub || !payload.email || payload.email_verified === false) {
    throw new AuthError("INVALID_TOKEN");
  }

  const email = normalizeEmail(payload.email);
  const name = payload.name?.trim() || email.split("@")[0];
  const avatar = payload.picture;

  let user = await User.findOne({ client_id: payload.sub });

  if (!user) {
    user = await User.findOne({ email }).select("+passwordHash");

    if (user) {
      if (!user.emailVerified && user.passwordHash) {
        user.passwordHash = undefined;
        user.authProviders = user.authProviders.filter((p) => p !== "local");
        user.tokenVersion = Number(user.tokenVersion ?? 0) + 1;
      }
      user.client_id = payload.sub;
      user.emailVerified = true;
      if (!user.authProviders.includes("google")) user.authProviders.push("google");
      if (avatar && !user.avatar) user.avatar = avatar;
      await user.save();
    }
  }

  if (!user) {
    try {
      user = await User.create({
        name,
        email,
        avatar,
        client_id: payload.sub,
        authProviders: ["google"],
        emailVerified: true,
      });
    } catch (error: any) {
      if (error?.code === 11000) throw new AuthError("EMAIL_TAKEN");
      throw error;
    }
  }

  const config = await ensureConfig(user._id);
  return { user: toPublicUser(user), config };
}
