import { NextResponse } from "next/server";
import { authed, loadOwnedReturn } from "../../../_util";
import { canGenerateItrJson } from "@/lib/itr-json/mapper";
import { prisma } from "@/lib/db";
import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { audit } from "@/lib/audit";
import { getUserAccess, proRequiredBody } from "@/lib/plan";

export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { session, error } = await authed();
  if (!session) return error;
  const { id } = await params;
  const found = await loadOwnedReturn(id, session.userId, session.role);
  if (!found.ret) return found.error;
  const access = await getUserAccess(session.userId);
  if (!access.canExport) return NextResponse.json(proRequiredBody(), { status: 403 });
  const gate = await canGenerateItrJson(id, { ownerUserId: session.role === "ADMIN" ? undefined : session.userId });
  if (gate.error === "empty") return NextResponse.json({ error: "Unable to generate the return." }, { status: 400 });
  if (gate.error === "itr3") {
    return NextResponse.json({ error: "Filing JSON is not available for this return type." }, { status: 400 });
  }
  if (!gate.allowed || !gate.result?.json || !gate.data) {
    return NextResponse.json({ error: "Unable to generate the return. Please correct the highlighted issues." }, { status: 400 });
  }
  const data = gate.data;
  const result = gate.result;
  const payload = JSON.stringify(result.json, null, 2);
  const dir = path.join(process.env.VERCEL ? "/tmp/taxpilot-storage/json" : path.join(process.cwd(), "storage", "json"), id);
  const file = path.join(dir, `${data.itrType}.json`);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(file, payload, "utf8");
  } catch {
    /* Vercel disk is ephemeral; inline DB payload is the source of truth. */
  }
  await prisma.iTRJsonFile.updateMany({ where: { returnId: id, status: "CURRENT" }, data: { status: "SUPERSEDED" } });
  const row = await prisma.iTRJsonFile.create({
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
  await audit({ userId: session.userId, returnId: id, action: "json.generated", entity: "ITRJsonFile", entityId: row.id, metadata: { hash: result.digest } });
  return NextResponse.json({ id: row.id, valid: true, hash: result.digest });
}
