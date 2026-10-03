import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { notFound, redirect } from "next/navigation";
import { SiteHeader } from "@/components/site-header";
import { ReturnNav } from "@/components/return-nav";
import { Badge, Button, Card, Input } from "@/components/ui";
import { classifyBankTxAction, reprocessDocumentAction, reviewExtractionAction } from "@/app/actions";
import { confidenceLevel, displayExtractionMethod } from "@/lib/documents/types";
import {
  documentStatusView,
  extractedFactLabels,
  parsePreparation,
  processableDocumentLabel,
} from "@/lib/documents/prefill";
import Link from "next/link";

export default async function DocumentDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; docId: string }>;
  searchParams: Promise<{ duplicate?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/login");
  const { id, docId } = await params;
  const { duplicate } = await searchParams;
  const doc = await prisma.document.findFirst({
    where: { id: docId, userId: session.userId, returnId: id },
    include: { extractions: true, taxFacts: true, bankTx: true },
  });
  if (!doc) notFound();
  const ret = await prisma.taxReturn.findFirst({ where: { id, userId: session.userId }, select: { preparationJson: true } });
  const prep = parsePreparation(ret?.preparationJson);
  const appliedHere = Object.values(prep.fields).filter(
    (e) => e.sourceDocumentId === doc.id && (e.origin === "IMPORTED" || e.origin === "USER_EDITED"),
  ).length;
  const view = documentStatusView({
    status: doc.status,
    errorCode: doc.errorCode,
    factStatuses: doc.taxFacts.map((f) => f.status),
  });
  const facts = extractedFactLabels(doc.taxFacts);
  const needsVerify = doc.taxFacts.some((f) => ["AI_EXTRACTED", "PENDING"].includes(f.status) || (!f.verified && f.status !== "REJECTED"));
  return (
    <div>
      <SiteHeader authed name={session.name} />
      <div className="mx-auto max-w-3xl px-6 py-8">
        <ReturnNav id={id} current="documents" />
        <p className="sans text-sm">
          <Link href={`/returns/${id}/documents`}>← Documents</Link>
        </p>
        <h1 className="mt-2 text-3xl break-all">{processableDocumentLabel(doc.kind)}</h1>
        <p className="sans mt-1 text-sm text-[#5c6773]">
          {doc.fileName} · {view.prefix ? `${view.prefix} ` : ""}
          {view.label}
        </p>
        {view.label === "PROCESSING" ? <p className="sans mt-2 text-sm text-[#5c6773]">Processing document…</p> : null}
        {duplicate ? (
          <Card className="mt-4">
            <p className="font-medium">This document has already been processed.</p>
            <p className="sans text-sm text-[#5c6773]">
              It was not reprocessed and the original was not deleted. Tick “Upload even if this file is a duplicate” on the
              documents page if you need a second copy.
            </p>
          </Card>
        ) : null}
        {view.label === "FAILED" ? (
          <Card className="mt-4">
            <p className="font-medium">Document could not be processed.</p>
            <p className="sans text-sm text-[#5c6773]">You can retry processing or enter values manually.</p>
          </Card>
        ) : null}
        {view.label === "CONFLICT" ? (
          <Card className="mt-4">
            <p className="font-medium">Some information conflicts with another document.</p>
            <Link href={`/returns/${id}/documents#conflicts`} className="sans mt-2 inline-flex min-h-11 items-center text-sm underline">
              Review conflict
            </Link>
          </Card>
        ) : null}
        {facts.length ? (
          <Card className="mt-4">
            <p className="font-medium">
              {processableDocumentLabel(doc.kind)}
              {view.label === "EXTRACTED" || view.label === "VERIFIED" ? " · Processed" : ""}
            </p>
            <p className="sans mt-1 text-sm text-[#5c6773]">Facts found: {facts.join(", ")}</p>
          </Card>
        ) : null}
        {appliedHere > 0 ? (
          <Card className="mt-4">
            <p className="font-medium">Verified information added to your ITR-4.</p>
            <p className="sans text-sm text-[#5c6773]">{appliedHere} fields updated</p>
          </Card>
        ) : null}
        {needsVerify ? <h2 className="mt-6 text-xl">Review & Verify</h2> : null}
        <form action={reprocessDocumentAction} className="mt-4">
          <input type="hidden" name="documentId" value={doc.id} />
          <Button type="submit" variant="outline" className="min-h-11" aria-label="Reprocess this document">
            Reprocess
          </Button>
        </form>
        <div className="mt-6 space-y-3">
          {doc.extractions.map((e) => {
            const fact = doc.taxFacts.find((f) => f.field === e.fieldKey);
            const level = confidenceLevel(e.confidence);
            const low = level === "LOW";
            return (
              <Card key={e.id} className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-medium break-all">{e.fieldKey.startsWith("txn.") ? `AIS transaction ${e.fieldKey.slice(4)}` : e.fieldKey}</p>
                  <Badge tone={fact?.status === "CONFLICT" ? "err" : low ? "err" : e.confidence >= 0.9 ? "ok" : "warn"}>
                    {level} {(e.confidence * 100).toFixed(0)}%
                  </Badge>
                </div>
                <p className="sans text-sm">
                  {fact?.status === "CONFLICT" || e.status === "CONFLICT"
                    ? "Conflict — not used"
                    : fact?.status === "VERIFIED" || e.status === "CONFIRMED"
                      ? "Confirmed"
                      : fact?.status === "REJECTED" || e.status === "REJECTED"
                        ? "Rejected"
                        : "Needs review"}
                  {" · "}
                  {processableDocumentLabel(doc.kind)}
                </p>
                {low ? <p className="text-sm text-amber-800">LOW CONFIDENCE — review before verifying.</p> : null}
                <p>Value: {e.extractedValue}</p>
                {e.originalValue ? <p className="sans text-xs">Original extracted value: {e.originalValue}</p> : null}
                {e.editedValue ? <p className="sans text-xs">User-edited value: {e.editedValue}</p> : null}
                <p className="sans text-xs text-[#5c6773]">
                  Source page {e.pageRef || "—"} · Extraction method {displayExtractionMethod(e.extractionMethod)}
                </p>
                <p className="sans text-xs text-[#5c6773]">Source text: {e.sourceText || "—"}</p>
                {fact?.normalizedTaxField ? (
                  <p className="sans text-xs text-[#5c6773]">Maps to {fact.normalizedTaxField}</p>
                ) : null}
                {fact?.status === "CONFLICT" ? (
                  <p className="text-sm text-red-800">
                    Some information conflicts with another document. This value is not used until the conflict is resolved.{" "}
                    <Link href={`/returns/${id}/documents#conflicts`} className="underline">
                      Review conflict
                    </Link>
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    <form action={reviewExtractionAction}>
                      <input type="hidden" name="extractionId" value={e.id} />
                      <input type="hidden" name="decision" value="confirm" />
                      <Button type="submit" className="min-h-11" aria-label={`Verify ${e.fieldKey}`}>
                        Verify
                      </Button>
                    </form>
                    <form action={reviewExtractionAction} className="flex min-w-0 flex-1 flex-wrap gap-2">
                      <input type="hidden" name="extractionId" value={e.id} />
                      <input type="hidden" name="decision" value="edit" />
                      <Input name="edited" defaultValue={e.extractedValue} aria-label={`Edit ${e.fieldKey}`} className="min-h-11" />
                      <Button variant="outline" className="min-h-11" aria-label={`Save edited ${e.fieldKey}`}>
                        Save edit
                      </Button>
                    </form>
                    <form action={reviewExtractionAction}>
                      <input type="hidden" name="extractionId" value={e.id} />
                      <input type="hidden" name="decision" value="reject" />
                      <Button variant="ghost" className="min-h-11" aria-label={`Reject ${e.fieldKey}`}>
                        Reject
                      </Button>
                    </form>
                  </div>
                )}
              </Card>
            );
          })}
        </div>
        {doc.bankTx.length ? (
          <div className="mt-8">
            <h2 className="text-xl">Transactions</h2>
            <p className="sans text-xs text-[#5c6773]">
              Suggested categories are not tax facts. Only a saved verified category can affect the return.
            </p>
            {doc.bankTx.map((tx) => (
              <Card key={tx.id} className="mt-2 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="text-sm break-all">
                    {tx.date} · {tx.description}
                  </p>
                  <p className="sans text-xs">
                    Dr {tx.debit} / Cr {tx.credit} · page {tx.sourcePage || "—"}
                  </p>
                  <p className="sans text-xs text-[#5c6773]">
                    raw {tx.rawCategory} · suggested {tx.suggestedCategory} · verified {tx.verifiedCategory || "null"}
                  </p>
                </div>
                <form action={classifyBankTxAction} className="flex flex-wrap gap-2">
                  <input type="hidden" name="txId" value={tx.id} />
                  <select
                    name="category"
                    defaultValue={tx.verifiedCategory || tx.suggestedCategory || "UNKNOWN"}
                    aria-label={`Category for ${tx.description}`}
                    className="sans min-h-11 rounded-md border px-2 py-1 text-xs"
                  >
                    {["UNKNOWN", "SALARY", "BUSINESS_RECEIPT", "INTEREST", "DIVIDEND", "TRANSFER", "REFUND", "LOAN", "INVESTMENT", "CAPITAL_RECEIPT"].map(
                      (c) => (
                        <option key={c}>{c}</option>
                      ),
                    )}
                  </select>
                  <Button type="submit" variant="outline" className="min-h-11" aria-label={`Verify category for ${tx.description}`}>
                    Verify category
                  </Button>
                </form>
              </Card>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
