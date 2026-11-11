"use server";

import { redirect } from "next/navigation";
import { clearSession, clearTotpSetup, getSession, readTotpSetup, storeTotpSetup } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { logSafe } from "@/lib/production";
import { getStorage } from "@/lib/providers/storage";
import { generateTotpSecret, verifyTotp } from "@/lib/totp";

export async function beginTotpAction() {
  const session = await getSession();
  if (!session) redirect("/login");
  await storeTotpSetup(generateTotpSecret());
  redirect("/account?totp=setup");
}

export async function confirmTotpAction(formData: FormData) {
  const session = await getSession();
  if (!session) redirect("/login");
  const secret = await readTotpSetup();
  const code = String(formData.get("code") || "");
  if (!secret || !verifyTotp(secret, code)) redirect("/account?totp=setup&error=totp");
  await prisma.user.update({ where: { id: session.userId }, data: { totpSecret: secret, totpEnabled: true } });
  await clearTotpSetup();
  redirect("/account?totp=on");
}

export async function disableTotpAction(formData: FormData) {
  const session = await getSession();
  if (!session) redirect("/login");
  const code = String(formData.get("code") || "");
  const user = await prisma.user.findUnique({ where: { id: session.userId } });
  if (!user || !user.totpSecret || !verifyTotp(user.totpSecret, code)) {
    redirect("/account?error=totp");
  }
  await prisma.user.update({ where: { id: user.id }, data: { totpEnabled: false, totpSecret: null } });
  redirect("/account?totp=off");
}

export async function deleteAccountAction(formData: FormData) {
  const session = await getSession();
  if (!session) redirect("/login");
  const confirm = String(formData.get("confirm") || "").trim().toLowerCase();
  if (confirm !== session.email) redirect("/account?error=confirm");
  const docs = await prisma.document.findMany({ where: { userId: session.userId }, select: { storageKey: true } });
  const storage = getStorage();
  for (const doc of docs) {
    if (!doc.storageKey) continue;
    try {
      await storage.delete(doc.storageKey);
    } catch (error) {
      logSafe("account-delete-storage", error);
      redirect("/account?error=storage");
    }
  }
  try {
    await prisma.user.delete({ where: { id: session.userId } });
  } catch (error) {
    logSafe("account-delete", error);
    redirect("/account?error=delete");
  }
  await clearSession();
  redirect("/?deleted=1");
}
