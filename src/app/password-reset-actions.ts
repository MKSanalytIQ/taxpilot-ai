"use server";

import { redirect, unstable_rethrow } from "next/navigation";
import { headers } from "next/headers";
import { prisma } from "@/lib/db";
import { clearSession, hashPassword } from "@/lib/auth";
import { passwordSessionStamp } from "@/lib/session-stamp";
import { publishSessionStamp } from "@/lib/session-revocation";
import { requestPasswordResetWith, completePasswordResetWith, prismaPasswordResetStore, RESET_UNAVAILABLE_MESSAGE } from "@/lib/password-reset";
import { limitRequest } from "@/lib/rate-limit";
import { logSafe } from "@/lib/production";

function rethrowControl(error: unknown) {
  unstable_rethrow(error);
  if (error && typeof error === "object" && "digest" in error && String((error as { digest?: string }).digest).startsWith("NEXT_REDIRECT")) {
    throw error;
  }
}

async function clientIp() {
  const h = await headers();
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || "";
}

export async function requestPasswordResetAction(formData: FormData) {
  const email = String(formData.get("email") || "").toLowerCase().trim();
  const ip = await clientIp();
  if (!(await limitRequest(`reset:${email}`, 1, 60_000)).ok || (ip && !(await limitRequest(`reset-ip:${ip}`, 8, 60_000)).ok)) {
    redirect("/forgot-password?sent=1");
  }
  try {
    const store = prismaPasswordResetStore({ prisma: prisma as never, hashPassword });
    const result = await requestPasswordResetWith(store, email, { origin: process.env.NEXT_PUBLIC_APP_URL, ip });
    if (result.message === RESET_UNAVAILABLE_MESSAGE) redirect("/forgot-password?error=unavailable");
  } catch (error) {
    rethrowControl(error);
    console.error("password reset request failed");
    logSafe("password-reset", error);
    redirect("/forgot-password?error=unavailable");
  }
  redirect("/forgot-password?sent=1");
}

export async function completePasswordResetAction(formData: FormData) {
  const token = String(formData.get("token") || "").trim();
  const newPassword = String(formData.get("newPassword") || "");
  const confirmPassword = String(formData.get("confirmPassword") || "");
  try {
    const store = prismaPasswordResetStore({ prisma: prisma as never, hashPassword });
    const result = await completePasswordResetWith(store, { token, newPassword, confirmPassword });
    if (!result.ok) {
      const code = result.error === "Passwords do not match." ? "mismatch" : result.error.includes("at least") ? "short" : "invalid";
      if (code === "invalid" || !token) redirect("/reset-password?error=invalid");
      redirect(`/reset-password?token=${encodeURIComponent(token)}&error=${code}`);
    }
    const user = await prisma.user.findUnique({ where: { id: result.userId }, select: { passwordHash: true } });
    if (user) await publishSessionStamp(result.userId, passwordSessionStamp(user.passwordHash));
    await clearSession();
  } catch (error) {
    rethrowControl(error);
    console.error("password reset failed");
    logSafe("password-reset-complete", error);
    redirect("/reset-password?error=invalid");
  }
  redirect("/login?reset=1");
}
