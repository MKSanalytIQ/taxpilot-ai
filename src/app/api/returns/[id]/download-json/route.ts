import { authed, loadOwnedReturn } from "../../../_util";
import { prisma } from "@/lib/db";
import { readFile } from "fs/promises";
import { NextResponse } from "next/server";
import { getUserAccess, proRequiredBody } from "@/lib/plan";
import { canGenerateItrJson } from "@/lib/itr-json/mapper";
import { validateOfficialItrJson } from "@/lib/itr-json/validator/officialValidator";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { session, error } = await authed();
  if (!session) return error;
  const { id } = await params;
  const found = await loadOwnedReturn(id, session.userId, session.role);
  if (!found.ret) return found.error;
  const access = await getUserAccess(session.userId);
  if (!access.canExport) return NextResponse.json(proRequiredBody(), { status: 403 });
  const file = await prisma.iTRJsonFile.findFirst({ where: { returnId: id, status: "CURRENT", valid: true }, orderBy: { generatedAt: "desc" } });
  if (!file) return NextResponse.json({ error: "No JSON generated" }, { status: 404 });
  const stored = file.storagePath || "";
  let buf: Buffer;
  if (stored.startsWith("inline:")) {
    buf = Buffer.from(stored.slice("inline:".length), "utf8");
  } else {
    try {
      buf = await readFile(stored);
    } catch {
      const gate = await canGenerateItrJson(id, { ownerUserId: session.role === "ADMIN" ? undefined : session.userId });
      if (!gate.result?.json || !gate.allowed) return NextResponse.json({ error: "No JSON generated" }, { status: 404 });
      buf = Buffer.from(JSON.stringify(gate.result.json, null, 2), "utf8");
    }
  }
  try {
    const parsed = JSON.parse(buf.toString("utf8")) as unknown;
    const official = validateOfficialItrJson(parsed, file.assessmentYear, file.itrType);
    if (!official.valid) {
      return NextResponse.json({ error: "Schema validation failed. Download is blocked." }, { status: 400 });
    }
  } catch {
    return NextResponse.json({ error: "Schema validation failed. Download is blocked." }, { status: 400 });
  }
  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="${file.itrType}-${file.assessmentYear}.json"`,
    },
  });
}
