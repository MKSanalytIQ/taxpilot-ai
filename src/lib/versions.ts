import { prisma } from "./db";
import { audit } from "./audit";

export type VersionSnapshot = {
  assessmentYear: string;
  itrType: string;
  taxRegime: string;
  status: string;
  estimatedTax: number;
  estimatedRefund: number;
  fingerprint: string;
  schemaVersion: string;
};

const PUBLIC_AUDIT_KEYS = ["note", "itrType", "status", "kind", "fields", "hash", "fingerprint", "resolution"] as const;

export function buildVersionSnapshot(input: VersionSnapshot): VersionSnapshot {
  return {
    assessmentYear: input.assessmentYear,
    itrType: input.itrType,
    taxRegime: input.taxRegime,
    status: input.status,
    estimatedTax: input.estimatedTax,
    estimatedRefund: input.estimatedRefund,
    fingerprint: input.fingerprint,
    schemaVersion: input.schemaVersion,
  };
}

export function shouldSaveVersion(previousSnapshot: string | null, nextSnapshot: string) {
  return previousSnapshot !== nextSnapshot;
}

export function canReadReturnHistory(ownerId: string, session: { userId: string; role: string }) {
  return session.role === "ADMIN" || ownerId === session.userId;
}

export function publicAuditMetadata(raw: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object") return {};
  const out: Record<string, string> = {};
  for (const key of PUBLIC_AUDIT_KEYS) {
    const value = (parsed as Record<string, unknown>)[key];
    if (typeof value === "string" || typeof value === "number") out[key] = String(value);
  }
  return out;
}

export function parseVersionSnapshot(raw: string): VersionSnapshot | null {
  try {
    const parsed = JSON.parse(raw) as Partial<VersionSnapshot>;
    if (!parsed || typeof parsed.fingerprint !== "string") return null;
    return buildVersionSnapshot({
      assessmentYear: String(parsed.assessmentYear || ""),
      itrType: String(parsed.itrType || ""),
      taxRegime: String(parsed.taxRegime || ""),
      status: String(parsed.status || ""),
      estimatedTax: Number(parsed.estimatedTax) || 0,
      estimatedRefund: Number(parsed.estimatedRefund) || 0,
      fingerprint: parsed.fingerprint,
      schemaVersion: String(parsed.schemaVersion || ""),
    });
  } catch {
    return null;
  }
}

/** Append-only. An unchanged snapshot does not create another version. */
export async function recordReturnVersion(input: { returnId: string; userId: string; note: string; snapshot: VersionSnapshot }) {
  const snapshot = JSON.stringify(buildVersionSnapshot(input.snapshot));
  const latest = await prisma.returnVersion.findFirst({
    where: { returnId: input.returnId },
    orderBy: { createdAt: "desc" },
  });
  if (!shouldSaveVersion(latest?.snapshot ?? null, snapshot)) return latest;
  const row = await prisma.returnVersion.create({
    data: { returnId: input.returnId, snapshot, note: input.note.slice(0, 160) },
  });
  await audit({
    userId: input.userId,
    returnId: input.returnId,
    action: "VERSION_SAVED",
    entity: "ReturnVersion",
    entityId: row.id,
    metadata: {
      note: input.note.slice(0, 160),
      itrType: input.snapshot.itrType,
      status: input.snapshot.status,
      fingerprint: input.snapshot.fingerprint.slice(0, 12),
    },
  });
  return row;
}
