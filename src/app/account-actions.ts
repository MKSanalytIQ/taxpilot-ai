"use server";

import { redirect } from "next/navigation";
import { clearSession, getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { logSafe } from "@/lib/production";
import { getStorage } from "@/lib/providers/storage";

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
