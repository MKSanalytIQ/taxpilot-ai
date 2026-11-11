import { createHash, randomBytes } from "node:crypto";

export const GENERIC_RESET_MESSAGE =
  "If an account exists for this email, a password reset link has been sent.";
export const RESET_UNAVAILABLE_MESSAGE =
  "Password reset is temporarily unavailable. Please try again later.";
export const INVALID_TOKEN_MESSAGE = "This password reset link is invalid or has expired.";
export const SUCCESS_MESSAGE = "Your password has been reset successfully.";
export const MIN_PASSWORD_LENGTH = 8;
export const TOKEN_TTL_MS = 60 * 60 * 1000;
export const RESET_EMAIL_SUBJECT = "Reset your TaxPilot password";

const RATE_LIMIT_MS = 60 * 1000;
const lastRequestAt = new Map<string, number>();
const devResetUrls = new Map<string, string>();

export type ResetTokenRow = {
  id: string;
  userId: string;
  token: string;
  expiresAt: Date;
  usedAt: Date | null;
};

export type ResetEmailPayload = { to: string; subject: string; text: string };

export type PasswordResetStore = {
  findUserByEmail: (email: string) => Promise<{ id: string } | null>;
  createToken: (data: { userId: string; tokenHash: string; expiresAt: Date }) => Promise<void>;
  findToken: (tokenHash: string) => Promise<ResetTokenRow | null>;
  consumeToken: (id: string) => Promise<boolean>;
  updatePassword: (userId: string, passwordHash: string) => Promise<void>;
  hashPassword: (password: string) => Promise<string>;
  deliverResetEmail: (payload: ResetEmailPayload) => Promise<void>;
  commitReset: (data: { tokenId: string; userId: string; passwordHash: string }) => Promise<boolean>;
};

export function hashResetToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function generateResetToken() {
  return randomBytes(32).toString("hex");
}

export function composeResetEmail(resetUrl: string) {
  return {
    subject: RESET_EMAIL_SUBJECT,
    text: [
      "We received a request to reset your TaxPilot password.",
      "Use the link below to create a new password.",
      "This link expires in 1 hour.",
      "If you did not request this, you can ignore this email.",
      "",
      resetUrl,
    ].join("\n"),
  };
}

export function hashLooksHashed(stored: string | null | undefined, plaintext: string) {
  if (!stored) return false;
  return stored !== plaintext && stored.length > 20 && !stored.includes(plaintext);
}

export function takeDevResetUrl(email: string) {
  const key = email.trim().toLowerCase();
  const url = devResetUrls.get(key);
  devResetUrls.delete(key);
  return url;
}

export function clearPasswordResetRateLimit() {
  lastRequestAt.clear();
}

function isProduction() {
  return process.env.NODE_ENV === "production";
}

export function publicOrigin(requestOrigin?: string) {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim() || process.env.APP_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  if (isProduction()) return "";
  if (requestOrigin) {
    try {
      const url = new URL(requestOrigin);
      if (url.protocol === "http:" || url.protocol === "https:") return url.origin;
    } catch {
      /* ignore */
    }
  }
  return "http://127.0.0.1:3002";
}

export function isValidPublicOrigin(origin: string | undefined | null) {
  if (!origin) return false;
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (!url.hostname) return false;
    if (isProduction()) {
      const host = url.hostname.toLowerCase();
      if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]") return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function isResetEmailConfigured() {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.RESET_EMAIL_FROM?.trim() || process.env.EMAIL_FROM?.trim();
  return Boolean(apiKey && from);
}

export function canSendProductionResetEmail(origin?: string) {
  return isResetEmailConfigured() && isValidPublicOrigin(origin ?? publicOrigin());
}

export async function sendConfiguredResetEmail(payload: ResetEmailPayload) {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.RESET_EMAIL_FROM?.trim() || process.env.EMAIL_FROM?.trim();
  if (!apiKey || !from) {
    console.info("[password-reset] email provider is not configured");
    throw new Error("email-not-configured");
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [payload.to],
      subject: payload.subject,
      text: payload.text,
    }),
  });
  if (!res.ok) {
    console.error("[password-reset] email delivery failed", res.status);
    throw new Error("email delivery failed");
  }
}

function allowRequest(email: string, ip?: string) {
  const now = Date.now();
  const keys = [`email:${email}`];
  if (ip) keys.push(`ip:${ip}`);
  for (const key of keys) {
    const previous = lastRequestAt.get(key);
    if (previous && now - previous < RATE_LIMIT_MS) return false;
  }
  for (const key of keys) lastRequestAt.set(key, now);
  return true;
}

function isExpired(expiresAt: Date | string) {
  const t = new Date(expiresAt).getTime();
  return !Number.isFinite(t) || t < Date.now();
}

export async function requestPasswordResetWith(
  store: PasswordResetStore,
  email: string,
  opts?: { origin?: string; ip?: string },
): Promise<{ message: string }> {
  const normalized = email.trim().toLowerCase();
  if (!normalized || !normalized.includes("@") || !allowRequest(normalized, opts?.ip)) {
    return { message: GENERIC_RESET_MESSAGE };
  }

  const origin = publicOrigin(opts?.origin);
  if (isProduction() && !canSendProductionResetEmail(origin)) {
    return { message: RESET_UNAVAILABLE_MESSAGE };
  }

  const user = await store.findUserByEmail(normalized);
  if (!user) {
    generateResetToken();
    await store.findToken(hashResetToken("dummy-verification-token"));
    void composeResetEmail("https://invalid.local/reset-password?token=dummy");
    console.info("[password-reset] reset requested");
    return { message: GENERIC_RESET_MESSAGE };
  }

  const token = generateResetToken();
  const tokenHash = hashResetToken(token);
  await store.createToken({
    userId: user.id,
    tokenHash,
    expiresAt: new Date(Date.now() + TOKEN_TTL_MS),
  });

  if (isValidPublicOrigin(origin)) {
    const resetUrl = `${origin}/reset-password?token=${token}`;
    const composed = composeResetEmail(resetUrl);
    try {
      await store.deliverResetEmail({ to: normalized, ...composed });
    } catch {
      console.error("[password-reset] email delivery failed");
    }
    if (!isProduction()) {
      devResetUrls.set(normalized, resetUrl);
    }
  }

  console.info("[password-reset] reset requested");
  return { message: GENERIC_RESET_MESSAGE };
}

export async function completePasswordResetWith(
  store: PasswordResetStore,
  input: { token: string; newPassword: string; confirmPassword: string },
): Promise<{ ok: true; userId: string } | { ok: false; error: string }> {
  if (!input.token) return { ok: false, error: INVALID_TOKEN_MESSAGE };
  if (input.newPassword !== input.confirmPassword) {
    return { ok: false, error: "Passwords do not match." };
  }
  if (input.newPassword.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` };
  }

  const row = await store.findToken(hashResetToken(input.token));
  if (!row || row.usedAt || isExpired(row.expiresAt)) {
    return { ok: false, error: INVALID_TOKEN_MESSAGE };
  }

  try {
    const hashedPassword = await store.hashPassword(input.newPassword);
    const committed = await store.commitReset({
      tokenId: row.id,
      userId: row.userId,
      passwordHash: hashedPassword,
    });
    if (!committed) return { ok: false, error: INVALID_TOKEN_MESSAGE };
    return { ok: true, userId: row.userId };
  } catch {
    return { ok: false, error: INVALID_TOKEN_MESSAGE };
  }
}

type PrismaResetClient = {
  $transaction: <T>(fn: (tx: PrismaResetClient) => Promise<T>) => Promise<T>;
  user: {
    findUnique: (args: { where: { email: string } }) => Promise<{ id: string } | null>;
    update: (args: { where: { id: string }; data: { passwordHash: string } }) => Promise<unknown>;
  };
  passwordResetToken: {
    create: (args: { data: { userId: string; token: string; expiresAt: Date } }) => Promise<unknown>;
    findUnique: (args: { where: { token: string } }) => Promise<ResetTokenRow | null>;
    updateMany: (args: {
      where: { id: string; usedAt: Date | null };
      data: { usedAt: Date };
    }) => Promise<{ count: number }>;
  };
};

export function prismaPasswordResetStore(deps: {
  prisma: PrismaResetClient;
  hashPassword: (password: string) => Promise<string>;
  deliverResetEmail?: (payload: ResetEmailPayload) => Promise<void>;
}): PasswordResetStore {
  const { prisma, hashPassword } = deps;
  const deliverResetEmail = deps.deliverResetEmail ?? sendConfiguredResetEmail;
  const store: PasswordResetStore = {
    findUserByEmail: (email) => prisma.user.findUnique({ where: { email } }),
    createToken: async ({ userId, tokenHash, expiresAt }) => {
      await prisma.passwordResetToken.create({ data: { userId, token: tokenHash, expiresAt } });
    },
    findToken: (tokenHash) => prisma.passwordResetToken.findUnique({ where: { token: tokenHash } }),
    consumeToken: async (id) => {
      const result = await prisma.passwordResetToken.updateMany({
        where: { id, usedAt: null },
        data: { usedAt: new Date() },
      });
      return result.count === 1;
    },
    updatePassword: async (userId, passwordHash) => {
      await prisma.user.update({ where: { id: userId }, data: { passwordHash } });
    },
    hashPassword,
    deliverResetEmail,
    commitReset: async ({ tokenId, userId, passwordHash }) => {
      try {
        await prisma.$transaction(async (tx) => {
          await tx.user.update({ where: { id: userId }, data: { passwordHash } });
          const result = await tx.passwordResetToken.updateMany({
            where: { id: tokenId, usedAt: null },
            data: { usedAt: new Date() },
          });
          if (result.count !== 1) throw new Error("token-not-consumed");
        });
        return true;
      } catch {
        return false;
      }
    },
  };
  return store;
}
