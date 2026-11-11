import { SignJWT, jwtVerify } from "jose";
import bcrypt from "bcryptjs";
import { cookies } from "next/headers";
import { authSecretBytes } from "./production";
import { prisma } from "./db";

const COOKIE = "tp_session";
const TOTP_COOKIE = "tp_totp";
const TOTP_SETUP_COOKIE = "tp_totp_setup";

function cookieOptions(maxAge: number, path = "/") {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path,
    maxAge,
  };
}

function secret() {
  return authSecretBytes();
}

export type Session = {
  userId: string;
  email: string;
  name: string;
  role: string;
};

export async function hashPassword(password: string) {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password: string, hash: string) {
  return bcrypt.compare(password, hash);
}

export async function createSession(userId: string) {
  const token = await new SignJWT({ userId })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("12h")
    .sign(secret());
  (await cookies()).set(COOKIE, token, cookieOptions(60 * 60 * 12));
}

export async function createTotpChallenge(userId: string) {
  const token = await new SignJWT({ userId, purpose: "totp" })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("5m")
    .sign(secret());
  (await cookies()).set(TOTP_COOKIE, token, cookieOptions(60 * 5));
}

export async function readTotpChallenge() {
  const token = (await cookies()).get(TOTP_COOKIE)?.value;
  if (!token) return "";
  try {
    const { payload } = await jwtVerify(token, secret());
    if (payload.purpose !== "totp") return "";
    return String(payload.userId || "");
  } catch {
    return "";
  }
}

export async function clearTotpChallenge() {
  (await cookies()).delete(TOTP_COOKIE);
}

export async function storeTotpSetup(totpSecret: string) {
  const token = await new SignJWT({ totpSecret, purpose: "totp-setup" })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("10m")
    .sign(secret());
  (await cookies()).set(TOTP_SETUP_COOKIE, token, cookieOptions(60 * 10, "/account"));
}

export async function readTotpSetup() {
  const token = (await cookies()).get(TOTP_SETUP_COOKIE)?.value;
  if (!token) return "";
  try {
    const { payload } = await jwtVerify(token, secret());
    if (payload.purpose !== "totp-setup") return "";
    return String(payload.totpSecret || "");
  } catch {
    return "";
  }
}

export async function clearTotpSetup() {
  (await cookies()).delete(TOTP_SETUP_COOKIE);
}

export async function clearSession() {
  (await cookies()).delete(COOKIE);
}

export async function getSession(): Promise<Session | null> {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret());
    const user = await prisma.user.findUnique({ where: { id: String(payload.userId || "") } });
    if (!user || user.status !== "ACTIVE") return null;
    return { userId: user.id, email: user.email, name: user.name, role: user.role };
  } catch {
    return null;
  }
}

export async function requireUser() {
  const s = await getSession();
  if (!s) return null;
  return s;
}

export { canAccessReturn } from "./authz";
