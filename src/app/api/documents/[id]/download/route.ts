import { NextResponse } from "next/server";
import { authed } from "../../../_util";
import { prisma } from "@/lib/db";
import { getStorage } from "@/lib/providers/storage";
import { canAccessDocument } from "@/lib/authz";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { session, error } = await authed();
  if (!session) return error;
  const { id } = await params;
  const doc = await prisma.document.findUnique({ where: { id } });
  if (!doc || doc.deletedAt) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!canAccessDocument(doc.userId, session)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  let bytes: Buffer;
  try {
    bytes = await getStorage().get(doc.storageKey);
  } catch {
    return NextResponse.json({ error: "Document storage is unavailable." }, { status: 503 });
  }
  const filename = doc.fileName.replace(/[^\w.\- ]+/g, "_").slice(0, 120) || "document";
  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "Content-Type": doc.mimeType,
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
