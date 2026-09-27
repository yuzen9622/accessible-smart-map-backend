import crypto from "crypto";
import bcrypt from "bcryptjs";
import { OAuth2Client } from "google-auth-library";
import {
  atomicChangePassword,
  atomicGoogleTakeover,
  atomicLinkGoogle,
  consumeAuthTokenRecord,
  consumePasswordResetToken,
  emailExists,
  ensureConfigForUser,
  findConfigForUser,
  findUserByClientId,
  findUserByEmail,
  findUserByEmailBounded,
  findUserByEmailWithPassword,
  findUserByIdBounded,
  findUserByIdWithPassword,
  insertUser,
  rotatePasswordResetToken,
  updateUserById,
  upsertAuthToken,
} from "./user.auth.repository";
import {
  createSession,
  revokeSession,
  revokeAllSessionsByUserId,
  rotateSession,
} from "./user.auth-session.repository";
import {
  sendGooglePasswordResetGuidanceEmail,
  sendPasswordResetEmail,
  sendVerificationEmail,
} from "../../adapters/email.adapter";
import {
  createAccessToken,
  createRefreshToken,
  verifyRefreshToken,
  toPublicUser,
} from "../../config/jwt";
import type { AuthTokenType, IConfig, IUser } from "../../types";
import {
  enqueuePasswordAssistance,
  getOrSetPasswordResetExpiry,
  renewPasswordAssistanceLease,
} from "./user.password-assistance.queue";

const BCRYPT_COST = 12;
const EMAIL_VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;

/**
 * A hash of a value nobody can supply, compared against when the account does
 * not exist so that a failed login costs the same time as a successful one.
 */
const DUMMY_HASH =
  "$2b$12$C6UzMDM.H6dfI/f/IKcEe.O1oOb7wXHrN.HGoTvcNjBjWlKr1u2Bu";

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
async function issueAuthToken(
  userId: string,
  type: AuthTokenType,
): Promise<string> {
  const raw = crypto.randomBytes(32).toString("base64url");
  const ttl =
    type === "email_verify" ? EMAIL_VERIFY_TTL_MS : PASSWORD_RESET_TTL_MS;

  await upsertAuthToken(
    userId,
    type,
    hashToken(raw),
    new Date(Date.now() + ttl),
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
  const stored = await rotatePasswordResetToken(
    input.userId,
    input.jobId,
    hashToken(input.rawToken),
    input.expiresAt,
    now,
  );
  return stored ? input.rawToken : null;
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
  const record = await consumeAuthTokenRecord(hashToken(raw), type);
  if (!record) throw new AuthError("INVALID_TOKEN");

  const user = await findUserByIdBounded(record.userId);
  if (!user) throw new AuthError("INVALID_TOKEN");
  return user;
}

async function ensureConfig(userId: unknown): Promise<IConfig | null> {
  return ensureConfigForUser(userId);
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

  if (await emailExists(email)) {
    throw new AuthError("EMAIL_TAKEN");
  }

  const passwordHash = await bcrypt.hash(input.password, BCRYPT_COST);

  let user;
  try {
    user = await insertUser({
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
}): Promise<{
  user: IUser;
  config: IConfig | null;
  accessToken: string;
  refreshToken: string;
}> {
  const email = normalizeEmail(input.email);
  const user = await findUserByEmailWithPassword(email);

  const hash = user?.passwordHash ?? DUMMY_HASH;
  const matches = await bcrypt.compare(input.password, hash);

  if (!user || !user.passwordHash || !matches) {
    throw new AuthError("INVALID_CREDENTIALS");
  }

  if (!user.emailVerified) {
    throw new AuthError("EMAIL_NOT_VERIFIED");
  }

  const initialJti = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const session = await createSession({
    userId: String(user._id),
    currentRefreshJti: initialJti,
    expiresAt,
  });

  const publicUser = toPublicUser(user);
  const accessToken = createAccessToken(publicUser, session._id);
  const refreshToken = createRefreshToken(publicUser, session._id, initialJti);

  const config = await findConfigForUser(user._id);
  return { user: publicUser, config, accessToken, refreshToken };
}

/**
 * Verify an email address using the token from the verification email and log the
 * user in.
 *
 * @param rawToken Raw token from the verification link.
 * @returns The verified user and its config.
 * @throws AuthError INVALID_TOKEN when the token is unknown, expired or used.
 */
export async function verifyEmail(rawToken: string): Promise<{
  user: IUser;
  config: IConfig | null;
  accessToken: string;
  refreshToken: string;
}> {
  const claimed = await consumeAuthToken(rawToken, "email_verify");

  const user =
    (await updateUserById(claimed._id, { emailVerified: true })) ?? claimed;

  const initialJti = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const session = await createSession({
    userId: String(user._id),
    currentRefreshJti: initialJti,
    expiresAt,
  });

  const publicUser = toPublicUser(user);
  const accessToken = createAccessToken(publicUser, session._id);
  const refreshToken = createRefreshToken(publicUser, session._id, initialJti);

  const config = await ensureConfig(user._id);
  return { user: publicUser, config, accessToken, refreshToken };
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
  const user = await findUserByEmail(email);
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
  const user = await findUserByEmailBounded(email);
  if (!user) return;

  if (!user.authProviders.includes("local")) {
    if (user.authProviders.includes("google")) {
      const ownsLease = await renewPasswordAssistanceLease({
        jobId: input.jobId,
        leaseToken: input.leaseToken,
      });
      if (!ownsLease)
        throw new Error("Password assistance lease lost before dispatch");
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
  if (!tokenExpiresAt)
    throw new Error("Password assistance lease lost before token rotation");
  if (tokenExpiresAt.getTime() <= Date.now()) return;

  const tokenSecret = process.env.PASSWORD_RESET_TOKEN_SECRET;
  if (!tokenSecret || Buffer.byteLength(tokenSecret, "utf8") < 32) {
    throw new Error(
      "PASSWORD_RESET_TOKEN_SECRET must contain at least 32 bytes",
    );
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
  if (!ownsLease)
    throw new Error("Password assistance lease lost before dispatch");

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
}): Promise<{
  user: IUser;
  config: IConfig | null;
  accessToken: string;
  refreshToken: string;
}> {
  // Hash first so a local CPU failure cannot consume an otherwise valid token.
  // Token validation, provider guard, password write, revocation increment and
  // token removal then happen in one atomic update on the same User document.
  const passwordHash = await bcrypt.hash(input.password, BCRYPT_COST);
  const now = new Date();
  const user = await consumePasswordResetToken(
    hashToken(input.token),
    passwordHash,
    now,
  );
  if (!user) throw new AuthError("INVALID_TOKEN");

  // Old-session revoke before new create. Reject DB failure.
  await revokeAllSessionsByUserId(String(user._id), "password_reset");

  const initialJti = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const session = await createSession({
    userId: String(user._id),
    currentRefreshJti: initialJti,
    expiresAt,
  });

  const publicUser = toPublicUser(user);
  const accessToken = createAccessToken(publicUser, session._id);
  const refreshToken = createRefreshToken(publicUser, session._id, initialJti);

  const config = await ensureConfig(user._id);
  return { user: publicUser, config, accessToken, refreshToken };
}

/**
 * Change or set the password of a signed-in account.
 *
 * currentPassword may be omitted only when the account has no password yet,
 * which is how a Google-only user adds password login.
 *
 * @param input Target user id, optional current password and the new password.
 * @returns The updated user and newly issued tokens, whose earlier tokens/sessions are revoked.
 * @throws AuthError INVALID_TOKEN when the user is gone, PASSWORD_REQUIRED or INVALID_CREDENTIALS otherwise.
 */
export async function changePassword(input: {
  userId: string;
  currentPassword?: string;
  newPassword: string;
}): Promise<{ user: IUser; accessToken: string; refreshToken: string }> {
  const user = await findUserByIdWithPassword(input.userId);
  if (!user) throw new AuthError("INVALID_TOKEN");

  if (user.passwordHash) {
    if (!input.currentPassword) throw new AuthError("PASSWORD_REQUIRED");
    const matches = await bcrypt.compare(
      input.currentPassword,
      user.passwordHash,
    );
    if (!matches) throw new AuthError("INVALID_CREDENTIALS");
  }

  const authProviders = user.authProviders.includes("local")
    ? user.authProviders
    : [...user.authProviders, "local"];
  const newPasswordHash = await bcrypt.hash(input.newPassword, BCRYPT_COST);

  // Atomic CAS: match observed tokenVersion and verified passwordHash.
  // A loser MUST NOT revoke/create/sign.
  const updated = await atomicChangePassword({
    userId: String(user._id),
    expectedTokenVersion: Number(user.tokenVersion ?? 0),
    expectedPasswordHash: user.passwordHash ?? null,
    newPasswordHash,
    authProviders,
  });

  if (!updated) {
    throw new AuthError("INVALID_CREDENTIALS");
  }

  // Old-session revoke before new create. Reject DB failure.
  await revokeAllSessionsByUserId(String(user._id), "password_changed");

  const initialJti = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const session = await createSession({
    userId: String(user._id),
    currentRefreshJti: initialJti,
    expiresAt,
  });

  const publicUser = toPublicUser(updated);
  const accessToken = createAccessToken(publicUser, session._id);
  const refreshToken = createRefreshToken(publicUser, session._id, initialJti);

  return { user: publicUser, accessToken, refreshToken };
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
export async function authenticateWithGoogle(idToken: string): Promise<{
  user: IUser;
  config: IConfig | null;
  accessToken: string;
  refreshToken: string;
}> {
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

  let user = await findUserByClientId(payload.sub);

  if (!user) {
    const byEmail = await findUserByEmailWithPassword(email);

    if (byEmail) {
      if (!byEmail.emailVerified && byEmail.passwordHash) {
        // Unverified local account: Google sign-in takes it over.
        // Conditional CAS on observed tokenVersion, passwordHash, and emailVerified: false.
        const observedVersion = Number(byEmail.tokenVersion ?? 0);
        const observedPasswordHash = byEmail.passwordHash;
        const authProviders = byEmail.authProviders.filter(
          (p) => p !== "local",
        );
        if (!authProviders.includes("google")) {
          authProviders.push("google");
        }

        const takeover = await atomicGoogleTakeover({
          userId: String(byEmail._id),
          expectedTokenVersion: observedVersion,
          expectedPasswordHash: observedPasswordHash,
          clientId: payload.sub,
          authProviders,
          avatar: avatar && !byEmail.avatar ? avatar : undefined,
        });

        if (takeover) {
          // Success: atomic CAS updated user and incremented tokenVersion.
          // Revoke ALL old sessions BEFORE issuing new session.
          await revokeAllSessionsByUserId(
            String(takeover._id),
            "google_takeover",
          );
          user = takeover;
        } else {
          // CAS lost! Re-read user to inspect concurrent mutation.
          const recheck = await findUserByEmailWithPassword(email);
          if (!recheck) {
            throw new AuthError("INVALID_TOKEN");
          }
          if (recheck.emailVerified) {
            // Account was verified concurrently (e.g. by resetPassword or verifyEmail).
            // Do NOT drop passwordHash or overwrite reset password/tokenVersion!
            // Safely link Google as an additional provider:
            const linked = await atomicLinkGoogle({
              userId: String(recheck._id),
              expectedTokenVersion: Number(recheck.tokenVersion ?? 0),
              clientId: payload.sub,
              avatar: avatar && !recheck.avatar ? avatar : undefined,
            });
            user =
              linked ??
              (await findUserByIdBounded(String(recheck._id))) ??
              recheck;
          } else {
            // Still unverified local account (e.g. tokenVersion bumped concurrently).
            // Retry takeover once with freshly observed credentials:
            const retryTakeover = await atomicGoogleTakeover({
              userId: String(recheck._id),
              expectedTokenVersion: Number(recheck.tokenVersion ?? 0),
              expectedPasswordHash: recheck.passwordHash!,
              clientId: payload.sub,
              authProviders: recheck.authProviders
                .filter((p) => p !== "local")
                .concat(
                  recheck.authProviders.includes("google") ? [] : ["google"],
                ),
              avatar: avatar && !recheck.avatar ? avatar : undefined,
            });
            if (retryTakeover) {
              await revokeAllSessionsByUserId(
                String(retryTakeover._id),
                "google_takeover",
              );
              user = retryTakeover;
            } else {
              user =
                (await findUserByIdBounded(String(recheck._id))) ?? recheck;
            }
          }
        }
      } else {
        // Account already verified or has no local password: safe link
        const linked = await atomicLinkGoogle({
          userId: String(byEmail._id),
          expectedTokenVersion: Number(byEmail.tokenVersion ?? 0),
          clientId: payload.sub,
          avatar: avatar && !byEmail.avatar ? avatar : undefined,
        });
        user =
          linked ?? (await findUserByIdBounded(String(byEmail._id))) ?? byEmail;
      }
    }
  }

  if (!user) {
    try {
      user = await insertUser({
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

  const initialJti = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const session = await createSession({
    userId: String(user._id),
    currentRefreshJti: initialJti,
    expiresAt,
  });

  const publicUser = toPublicUser(user);
  const accessToken = createAccessToken(publicUser, session._id);
  const refreshToken = createRefreshToken(publicUser, session._id, initialJti);

  const config = await ensureConfig(user._id);
  return { user: publicUser, config, accessToken, refreshToken };
}

export type RefreshResult =
  | { ok: true; user: IUser; accessToken: string; refreshToken: string }
  | {
      ok: false;
      reason:
        | "INVALID_TOKEN"
        | "REVOKED"
        | "EXPIRED"
        | "GRACE_PERIOD"
        | "REUSE_DETECTED";
    };

const OBJECT_ID_REGEX = /^[0-9a-fA-F]{24}$/;
const UUID_REGEX =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Validates a refresh token, verifies the user and session, rotates the session
 * with a new JTI and refreshed expiry, and issues new tokens.
 */
export async function refreshSession(
  rawRefreshToken: string,
): Promise<RefreshResult> {
  const verify = verifyRefreshToken(rawRefreshToken);
  if (!verify.success || !verify.decoded) {
    return { ok: false, reason: "INVALID_TOKEN" };
  }

  const claimed = verify.decoded.user as IUser | undefined;
  const userId = claimed?._id ? String(claimed._id) : "";
  const sid = typeof verify.decoded.sid === "string" ? verify.decoded.sid : "";
  const jti = typeof verify.decoded.jti === "string" ? verify.decoded.jti : "";

  if (
    !userId ||
    !sid ||
    !jti ||
    !OBJECT_ID_REGEX.test(sid) ||
    !UUID_REGEX.test(jti)
  ) {
    return { ok: false, reason: "INVALID_TOKEN" };
  }

  let user;
  try {
    user = await findUserByIdBounded(userId);
  } catch {
    return { ok: false, reason: "REVOKED" };
  }

  if (
    !user ||
    Number(user.tokenVersion ?? 0) !== Number(claimed?.tokenVersion ?? -1)
  ) {
    return { ok: false, reason: "REVOKED" };
  }

  const newJti = crypto.randomUUID();
  const newExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

  const rotateResult = await rotateSession({
    sid,
    userId,
    oldJti: jti,
    newJti,
    newExpiresAt,
  });

  if (rotateResult.status === "SUCCESS") {
    const publicUser = toPublicUser(user);
    const accessToken = createAccessToken(publicUser, sid);
    const newRefreshToken = createRefreshToken(publicUser, sid, newJti);
    return {
      ok: true,
      user: publicUser,
      accessToken,
      refreshToken: newRefreshToken,
    };
  }

  if (rotateResult.status === "GRACE_PERIOD") {
    return { ok: false, reason: "GRACE_PERIOD" };
  }

  if (rotateResult.status === "REUSE_DETECTED") {
    return { ok: false, reason: "REUSE_DETECTED" };
  }

  if (rotateResult.status === "REVOKED") {
    return { ok: false, reason: "REVOKED" };
  }

  if (rotateResult.status === "EXPIRED") {
    return { ok: false, reason: "EXPIRED" };
  }

  return { ok: false, reason: "INVALID_TOKEN" };
}

/**
 * Revokes a session associated with a valid refresh token.
 * If the token is already invalid, returns true idempotently without DB mutation.
 * If DB revoke fails, throws to signal failure to the caller.
 */
export async function logoutSession(rawRefreshToken: string): Promise<boolean> {
  const verify = verifyRefreshToken(rawRefreshToken);
  if (!verify.success || !verify.decoded) {
    return true;
  }

  const claimed = verify.decoded.user as IUser | undefined;
  const userId = claimed?._id ? String(claimed._id) : "";
  const sid = typeof verify.decoded.sid === "string" ? verify.decoded.sid : "";

  if (!userId || !sid || !OBJECT_ID_REGEX.test(sid)) {
    return true;
  }

  return revokeSession(sid, userId, "user_logout");
}
