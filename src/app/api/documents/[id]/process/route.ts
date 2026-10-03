import { NextResponse } from "next/server";
import { authed } from "../../../_util";
import { prisma } from "@/lib/db";
import { getStorage } from "@/lib/providers/storage";
import { persistExtraction } from "@/lib/documents/persistExtraction";
import { canAccessDocument } from "@/lib/authz";

export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { session, error } = await authed();
  if (!session) return error;
  const { id } = await params;
  const doc = await prisma.document.findUnique({ where: { id } });
  if (!doc || !canAccessDocument(doc.userId, session)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!doc.returnId) return NextResponse.json({ error: "no-return" }, { status: 400 });
  let bytes: Buffer;
  try {
    bytes = await getStorage().get(doc.storageKey);
  } catch {
    return NextResponse.json({ error: "Document storage is unavailable." }, { status: 503 });
  }
  const result = await persistExtraction({
    documentId: doc.id,
    returnId: doc.returnId,
    userId: session.userId,
    bytes,
    fileName: doc.fileName,
    mimeType: doc.mimeType,
    declaredKind: doc.kind,
    force: true,
  });
  return NextResponse.json({ kind: result.kind, fields: result.fields.length, errorCode: result.errorCode || null });
}
