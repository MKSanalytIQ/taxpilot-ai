import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { canReadReturnHistory, parseVersionSnapshot, publicAuditMetadata } from "@/lib/versions";
import { SiteHeader } from "@/components/site-header";
import { ReturnNav } from "@/components/return-nav";
import { Card } from "@/components/ui";
import { inr } from "@/lib/utils";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";

export default async function ReturnHistoryPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) redirect("/login");
  const { id } = await params;
  const ret = await prisma.taxReturn.findUnique({ where: { id }, select: { id: true, userId: true, assessmentYear: true } });
  if (!ret || !canReadReturnHistory(ret.userId, session)) notFound();
  const [versions, logs] = await Promise.all([
    prisma.returnVersion.findMany({ where: { returnId: id }, orderBy: { createdAt: "desc" }, take: 30 }),
    prisma.auditLog.findMany({ where: { returnId: id }, orderBy: { createdAt: "desc" }, take: 40 }),
  ]);
  return (
    <div>
      <SiteHeader authed name={session.name} />
      <div className="mx-auto max-w-3xl px-6 py-8">
        <ReturnNav id={id} current="review" />
        <p className="sans text-sm">
          <Link href={`/returns/${id}/review`}>← Review</Link>
        </p>
        <h1 className="mt-2 text-3xl">History</h1>
        <p className="sans mt-2 text-sm text-[#5c6773]">
          Versions are saved when the {ret.assessmentYear} calculation changes. Older versions are not overwritten.
        </p>
        <h2 className="mt-8 text-xl">Versions</h2>
        {versions.length === 0 ? <p className="sans mt-2 text-sm text-[#5c6773]">No saved version yet.</p> : null}
        <div className="mt-3 space-y-3">
          {versions.map((version) => {
            const snap = parseVersionSnapshot(version.snapshot);
            return (
              <Card key={version.id}>
                <p className="font-medium">{version.note || "Saved"}</p>
                <p className="sans mt-1 text-sm text-[#5c6773]">{version.createdAt.toISOString().slice(0, 16).replace("T", " ")} UTC</p>
                {snap ? (
                  <p className="sans mt-2 text-sm">
                    {snap.itrType} · {snap.status} · Tax {inr(snap.estimatedTax)} · {snap.fingerprint.slice(0, 12)}
                  </p>
                ) : null}
              </Card>
            );
          })}
        </div>
        <h2 className="mt-8 text-xl">Activity</h2>
        {logs.length === 0 ? <p className="sans mt-2 text-sm text-[#5c6773]">No activity recorded.</p> : null}
        <ul className="sans mt-3 space-y-2 text-sm">
          {logs.map((log) => {
            const meta = publicAuditMetadata(log.metadata);
            const extra = Object.entries(meta).map(([key, value]) => `${key} ${value}`).join(" · ");
            return (
              <li key={log.id}>
                {log.createdAt.toISOString().slice(0, 16).replace("T", " ")} UTC · {log.action} · {log.entity}
                {extra ? ` · ${extra}` : ""}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
