"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { getSession, canAccessReturn } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { canGenerateItrJson } from "@/lib/itr-json/mapper";
import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { getUserAccess, jsonExportUpgradePath } from "@/lib/plan";
import { limitRequest } from "@/lib/rate-limit";
import { filingInstant } from "@/lib/totp";

export async function generateJsonAction(formData: FormData) {
  const session = await getSession();
  if (!session) redirect("/login");
  const id = String(formData.get("returnId") || "");
  const ret = await prisma.taxReturn.findFirst({ where: { id, userId: session.userId } });
  if (!ret || !canAccessReturn(ret.userId, session)) redirect("/dashboard");
  const limited = await limitRequest(`json:${session.userId}`, 10, 600_000);
  if (!limited.ok) redirect(limited.shared ? `/returns/${id}/json?error=rate` : `/returns/${id}/json?error=unavailable`);
  const access = await getUserAccess(session.userId);
  if (!access.isPro) redirect(jsonExportUpgradePath(id));
  const generatedAt = filingInstant(String(formData.get("filingDate") || ""));
  if (!generatedAt) redirect(`/returns/${id}/json?error=date`);
  const gate = await canGenerateItrJson(id, {
    generatedAt,
    ownerUserId: session.role === "ADMIN" ? undefined : session.userId,
  });
  if (gate.error === "empty" || !gate.data) redirect("/dashboard");
  if (gate.error === "itr3") redirect(`/returns/${id}/summary?error=itr3`);
  if (!gate.allowed || !gate.result?.json) {
    await prisma.taxReturn.update({ where: { id }, data: { status: "VALIDATION_FAILED" } });
    redirect(`/returns/${id}/validate?blocked=1`);
  }
  const data = gate.data;
  const result = gate.result;
  const payload = JSON.stringify(result.json, null, 2);
  const dir = path.join(process.env.VERCEL ? "/tmp/taxpilot-storage/json" : path.join(process.cwd(), "storage", "json"), id);
  const file = path.join(dir, `${data.itrType}-${Date.now()}.json`);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(file, payload, "utf8");
  } catch {
    /* Vercel disk is ephemeral; inline DB payload is the source of truth. */
  }
  await prisma.iTRJsonFile.updateMany({ where: { returnId: id, status: "CURRENT" }, data: { status: "SUPERSEDED" } });
  await prisma.iTRJsonFile.create({
    data: {
      returnId: id,
      assessmentYear: data.assessmentYear,
      itrType: data.itrType,
      schemaVersion: result.schemaVersion,
      fileHash: result.digest,
      storagePath: `inline:${payload}`,
      valid: true,
      status: "CURRENT",
      versionId: result.digest.slice(0, 12),
    },
  });
  await prisma.taxReturn.update({ where: { id }, data: { status: "JSON_GENERATED", schemaVersion: result.schemaVersion } });
  await audit({ userId: session.userId, returnId: id, action: "json.generated", entity: "ITRJsonFile", metadata: { hash: result.digest } });
  revalidatePath(`/returns/${id}/json`);
  redirect(`/returns/${id}/json`);
}
