import { randomBytes, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";

export const GOOGLE_ERROR_MESSAGE = "Google sign-in could not be completed. Please try again.";
export const GOOGLE_STATE_COOKIE = "tp_google_state";
export const GOOGLE_BUTTON_LABEL = "Continue with Google";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";

export type GoogleIdentity = {
  email: string;
  emailVerified: boolean;
  name: string;
  sub: string;
};

export type GoogleAuthStore = {
  findUserByEmail(email: string): Promise<{ id: string; email: string } | null>;
  createUser(data: { email: string; name: string; passwordHash: string }): Promise<{ id: string }>;
  ensureFreeAccess(userId: string): Promise<void>;
  hashPassword(password: string): Promise<string>;
};

export function isGoogleConfigured() {
  return Boolean(process.env.GOOGLE_CLIENT_ID?.trim() && process.env.GOOGLE_CLIENT_SECRET?.trim());
}

export function googleClientId() {
  return String(process.env.GOOGLE_CLIENT_ID || "").trim();
}

function googleClientSecret() {
  return String(process.env.GOOGLE_CLIENT_SECRET || "").trim();
}

export function googleRedirectUri(origin = process.env.NEXT_PUBLIC_APP_URL) {
  const base = String(origin || "").trim().replace(/\/$/, "");
  if (!base) return "";
  return `${base}/api/auth/google/callback`;
}

function isLocalOrigin(value: string) {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  } catch {
    return true;
  }
}

/** Production never falls back to a localhost redirect. Development still can. */
export function googleAppOrigin(requestOrigin: string, env: { nodeEnv?: string; appUrl?: string } = {}) {
  const nodeEnv = env.nodeEnv ?? process.env.NODE_ENV;
  const configured = String(env.appUrl ?? process.env.NEXT_PUBLIC_APP_URL ?? "").trim().replace(/\/+$/, "");
  const request = String(requestOrigin || "").trim().replace(/\/+$/, "");
  if (nodeEnv === "production") {
    if (configured && !isLocalOrigin(configured)) return configured;
    if (request && !isLocalOrigin(request)) return request;
    return "";
  }
  return configured || request || "http://127.0.0.1:3002";
}

export function createGoogleState() {
  return randomBytes(16).toString("hex");
}

export function googleStateMatches(expected: string, received: string) {
  if (!expected || !received) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function buildGoogleAuthorizeUrl(input: { clientId: string; redirectUri: string; state: string }) {
  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", input.state);
  url.searchParams.set("prompt", "select_account");
  return url.toString();
}

export async function completeGoogleLoginWith(
  store: GoogleAuthStore,
  identity: GoogleIdentity,
  clientHints?: { email?: string; userId?: string },
): Promise<{ ok: true; userId: string; created: boolean } | { ok: false; error: string }> {
  void clientHints;
  const email = String(identity.email || "").toLowerCase().trim();
  if (!identity.emailVerified || !email.includes("@")) {
    return { ok: false, error: GOOGLE_ERROR_MESSAGE };
  }
  const existing = await store.findUserByEmail(email);
  if (existing) return { ok: true, userId: existing.id, created: false };
  const passwordHash = await store.hashPassword(randomBytes(32).toString("hex"));
  const user = await store.createUser({
    email,
    name: String(identity.name || "").trim() || email.split("@")[0] || "TaxPilot user",
    passwordHash,
  });
  await store.ensureFreeAccess(user.id);
  return { ok: true, userId: user.id, created: true };
}

export async function exchangeGoogleCode(code: string, redirectUri: string) {
  const clientId = googleClientId();
  const clientSecret = googleClientSecret();
  if (!clientId || !clientSecret || !code || !redirectUri) throw new Error("GOOGLE_NOT_CONFIGURED");
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error("GOOGLE_TOKEN_FAILED");
  const data = (await res.json()) as { id_token?: string };
  if (!data.id_token) throw new Error("GOOGLE_TOKEN_FAILED");
  return data.id_token;
}

export async function verifyGoogleIdToken(idToken: string): Promise<GoogleIdentity> {
  const clientId = googleClientId();
  const jwks = createRemoteJWKSet(new URL(GOOGLE_JWKS_URL));
  const { payload } = await jwtVerify(idToken, jwks, {
    issuer: ["https://accounts.google.com", "accounts.google.com"],
    audience: clientId,
  });
  return {
    email: String(payload.email || ""),
    emailVerified: payload.email_verified === true,
    name: String(payload.name || ""),
    sub: String(payload.sub || ""),
  };
}

export function prismaGoogleAuthStore(prisma: {
  user: {
    findUnique: (args: { where: { email: string } }) => Promise<{ id: string; email: string } | null>;
    create: (args: { data: { email: string; name: string; passwordHash: string } }) => Promise<{ id: string }>;
  };
  profile: { create: (args: { data: { userId: string } }) => Promise<unknown> };
  subscription: { create: (args: { data: { userId: string; plan: string } }) => Promise<unknown> };
}, hashPassword: (password: string) => Promise<string>): GoogleAuthStore {
  return {
    findUserByEmail: (email) => prisma.user.findUnique({ where: { email } }),
    createUser: (data) => prisma.user.create({ data }),
    ensureFreeAccess: async (userId) => {
      await Promise.allSettled([
        prisma.profile.create({ data: { userId } }),
        prisma.subscription.create({ data: { userId, plan: "FREE" } }),
      ]);
    },
    hashPassword,
  };
}

export function googlePublicConfig() {
  return {
    configured: isGoogleConfigured(),
    clientIdPresent: Boolean(googleClientId()),
  };
}
