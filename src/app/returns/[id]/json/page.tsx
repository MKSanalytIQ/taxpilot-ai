import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { notFound, redirect } from "next/navigation";
import { SiteHeader } from "@/components/site-header";
import { ReturnNav } from "@/components/return-nav";
import { Button, Card, Disclaimer } from "@/components/ui";
import { generateJsonAction } from "@/app/json-actions";
import { canGenerateItrJson } from "@/lib/itr-json/mapper";
import Link from "next/link";
import { getUserAccess } from "@/lib/plan";
import { ProUpgradeCard } from "@/components/upgrade-cta";

export default async function JsonPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) redirect("/login");
  const { id } = await params;
  const access = await getUserAccess(session.userId);
  const ret = await prisma.taxReturn.findFirst({
    where: { id, userId: session.userId },
    include: { jsonFiles: { orderBy: { generatedAt: "desc" }, take: 3 }, validationErrors: true },
  });
  if (!ret) notFound();
  const gate = await canGenerateItrJson(id, { ownerUserId: session.userId });
  const preview = gate.result;
  const current = ret.jsonFiles.find((f) => f.status === "CURRENT");
  const integrityFail = preview?.layers.schemaIntegrity === "FAIL";
  const canGen = gate.allowed;
  return (
    <div>
      <SiteHeader authed name={session.name} />
      <div className="mx-auto max-w-3xl px-6 py-8">
        <ReturnNav id={id} current="json" />
        <h1 className="text-3xl">ITR JSON</h1>
        {ret.itrType !== "ITR-4" && ret.itrType !== "ITR-3" ? (
          <Card className="mt-6">Filing JSON is not available for this return type.</Card>
        ) : (
          <>
            <Card className="mt-6 sans text-sm space-y-1">
              <p>ITR type: {ret.itrType}</p>
              <p>Assessment year: {ret.assessmentYear}</p>
              <p>Schema version: {preview?.schemaVersion || ret.schemaVersion || "Ver1.0"}</p>
              <p>Generated at: {current?.generatedAt.toISOString() || "Not generated"}</p>
              <p>JSON hash: {current?.fileHash || "—"}</p>
              <p>Status: {current ? "JSON Generated" : ret.status}</p>
            </Card>
            <div className="mt-4 space-y-2">
              <p>
                {integrityFail
                  ? "❌ Official schema verification failed"
                  : preview?.official.valid
                    ? "✓ Official schema validation passed"
                    : "✕ Official schema validation failed"}
              </p>
              <p>{preview?.layers.businessRules === "PASS" ? "✓ Business validation passed" : "✕ Business validation failed"}</p>
              <p>{preview?.calc ? "✓ Tax calculation validation passed" : "✕ Tax calculation missing"}</p>
            </div>
            {!canGen ? (
              <Card className="mt-4">
                <p>Unable to generate the return. Please correct the highlighted issues.</p>
                {integrityFail ? <p className="sans mt-2 text-sm">❌ Official schema verification failed</p> : null}
                {preview?.errors.some((e) => e.field === "UNSUPPORTED_INTEREST_CALCULATION") ? (
                  <p className="sans mt-2 text-sm">Interest calculation requires additional information.</p>
                ) : null}
                <Link href={`/returns/${id}/review`} className="sans mt-2 inline-block text-sm text-[#1f4e46]">
                  Review
                </Link>
              </Card>
            ) : access.isPro ? (
              <form action={generateJsonAction} className="mt-6">
                <input type="hidden" name="returnId" value={id} />
                <Button type="submit">Generate ITR JSON</Button>
              </form>
            ) : (
              <ProUpgradeCard />
            )}
            {current?.valid ? (
              <p className="sans mt-4 text-sm text-emerald-800">JSON generated successfully · Schema validation passed</p>
            ) : null}
            {access.isPro && current?.valid ? (
              <Link href={`/api/returns/${id}/download-json`} className="mt-4 inline-block">
                <Button variant="outline">Download ITR JSON</Button>
              </Link>
            ) : null}
            {ret.jsonFiles.some((f) => f.status === "SUPERSEDED") ? (
              <p className="sans mt-3 text-xs text-[#5c6773]">Earlier JSON files are marked SUPERSEDED after the return changed.</p>
            ) : null}
            <p className="sans mt-6 text-sm text-[#5c6773]">
              This file is prepared for upload through the Income Tax Department’s applicable filing workflow. TaxPilot AI does not itself file the return.
              Section 234A uses the JSON generation date as the intended filing date, so regenerate the file on the day you upload.
              {ret.itrType === "ITR-3" ? " ITR-3 JSON is not enabled for this deployment unless the operator turns it on. 44AE, non-112A capital gains, and loss carry-forward stay blocked." : ""}
            </p>
            <div className="mt-6">
              <Disclaimer />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
