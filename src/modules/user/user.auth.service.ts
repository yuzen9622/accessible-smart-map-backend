import crypto from "crypto";
import bcrypt from "bcryptjs";
import { OAuth2Client } from "google-auth-library";
import User from "../../model/user.model";
import Config from "../../model/config.model";
import AuthToken from "../../model/auth-token.model";
import { sendPasswordResetEmail, sendVerificationEmail } from "../../adapters/email.adapter";
import { toPublicUser } from "../../config/jwt";
import type { AuthTokenType, IConfig, IUser } from "../../types";

const BCRYPT_COST = 12;
const EMAIL_VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;

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

  await AuthToken.deleteMany({ userId, type });
  await AuthToken.create({
    userId,
    type,
    tokenHash: hashToken(raw),
    expiresAt: new Date(Date.now() + ttl),
  });

  return raw;
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
  const record = await AuthToken.findOne({ tokenHash: hashToken(raw), type });
  if (!record || record.usedAt || record.expiresAt.getTime() <= Date.now()) {
    throw new AuthError("INVALID_TOKEN");
  }

  const user = await User.findById(record.userId);
  if (!user) throw new AuthError("INVALID_TOKEN");

  await AuthToken.deleteOne({ _id: record._id });
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
  try {
    await sendVerificationEmail({ to: email, name: user.name, token });
  } catch (error) {
    console.error("[auth] 驗證信重寄失敗", error);
  }
}

/**
 * Start the password reset flow.
 *
 * Unverified accounts are eligible on purpose: whoever controls the inbox owns
 * the account, which is how a legitimate owner reclaims an address that someone
 * else registered first.
 *
 * @param rawEmail Address to send the reset link to.
 * @throws When the account exists but the reset email could not be delivered.
 */
export async function requestPasswordReset(rawEmail: string): Promise<void> {
  const email = normalizeEmail(rawEmail);
  const user = await User.findOne({ email });
  if (!user) return;

  const token = await issueAuthToken(String(user._id), "password_reset");
  await sendPasswordResetEmail({ to: email, name: user.name, token });
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
  const user = await consumeAuthToken(input.token, "password_reset");

  user.passwordHash = await bcrypt.hash(input.password, BCRYPT_COST);
  user.emailVerified = true;
  user.tokenVersion = Number(user.tokenVersion ?? 0) + 1;
  if (!user.authProviders.includes("local")) user.authProviders.push("local");
  await user.save();

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
