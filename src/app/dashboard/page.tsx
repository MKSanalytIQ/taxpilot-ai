import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { redirect } from "next/navigation";
import { SiteHeader } from "@/components/site-header";
import { Badge, Button, Card, Disclaimer } from "@/components/ui";
import { UpgradeCta } from "@/components/upgrade-cta";
import { WorkspaceProgress } from "@/components/workspace-progress";
import { inr, json } from "@/lib/utils";
import Link from "next/link";
import type { TaxComputation } from "@/lib/tax/engine";
import { canGenerateItrJson } from "@/lib/itr-json/mapper";
import { reviewReadiness } from "@/lib/review/readiness";
import { getUserAccess } from "@/lib/plan";
import {
  currentWorkspaceStep,
  documentWorkspaceSummary,
  nextWorkspaceHref,
  workspaceActions,
  workspaceStatusLabel,
} from "@/lib/review/workspace";

export default async function Dashboard() {
  const session = await getSession();
  if (!session) redirect("/login");
  const access = await getUserAccess(session.userId);
  const ret = await prisma.taxReturn.findFirst({
    where: { userId: session.userId },
    orderBy: { updatedAt: "desc" },
    include: {
      documents: { include: { taxFacts: true } },
      questions: true,
      validationErrors: true,
      documentConflicts: true,
      jsonFiles: { where: { status: "CURRENT" }, take: 1 },
      user: { include: { profile: true } },
    },
  });
  const calc = json<Partial<TaxComputation>>(ret?.calculationJson, {});
  if (!ret) {
    return (
      <div>
        <SiteHeader authed name={session.name} admin={session.role === "ADMIN"} />
        <div className="mx-auto max-w-3xl px-6 py-10">
          <p className="sans text-sm text-[#5c6773]">Welcome, {session.name}</p>
          <p className="sans mt-1 text-sm text-[#5c6773]">Plan: {access.label}</p>
          <h1 className="mt-1 text-4xl">Start your ITR-4</h1>
          <p className="sans mt-3 max-w-xl text-sm text-[#5c6773]">
            Upload your tax documents and review the information before generating your return.
          </p>
          <Card className="mt-8">
            <p className="font-medium">ITR-4 · AY 2026–27</p>
            <p className="sans mt-2 text-sm text-[#5c6773]">
              ITR-4 is the currently supported form for eligible presumptive and salary cases. Eligibility is decided by
              existing rules after you start.
            </p>
            <Link href="/returns/new" className="mt-4 inline-block">
              <Button className="min-h-11 w-full sm:w-auto" aria-label="Start your ITR-4">
                Start your ITR-4
              </Button>
            </Link>
            {!access.canExport ? <UpgradeCta className="mt-3 inline-block" /> : null}
          </Card>
          <div className="mt-10">
            <Disclaimer />
          </div>
        </div>
      </div>
    );
  }

  const openConflicts = ret.documentConflicts.filter((c) => c.status === "OPEN").length;
  const docs = documentWorkspaceSummary(ret.documents);
  const pendingQ = ret.questions.filter((q) => q.status === "PENDING").length;
  const hasPan = Boolean(ret.user.profile?.pan);
  const hasDob = Boolean(ret.user.profile?.dateOfBirth);
  const gate = await canGenerateItrJson(ret.id, { ownerUserId: session.userId });
  const readiness = reviewReadiness(gate, { returnId: ret.id, openConflicts });
  const ready = readiness.status === "READY" && gate.allowed;
  const continueHref = nextWorkspaceHref({
    returnId: ret.id,
    pendingQuestions: pendingQ,
    hasPan,
    hasDob,
    documents: docs.uploaded,
    needsReviewDocs: docs.needsReview,
    openConflicts,
    ready,
  });
  const actions = workspaceActions({
    returnId: ret.id,
    needsReviewDocs: docs.needsReview,
    openConflicts,
    missingPersonal: !hasPan || !hasDob,
    validationErrors: ret.validationErrors.filter((e) => e.severity === "ERROR"),
  });
  const status = workspaceStatusLabel({
    status: ret.status,
    processingDocs: docs.processing,
    ready,
    hasCurrentJson: ret.jsonFiles.length > 0,
  });
  const refund = calc.refundOrPayable || 0;
  return (
    <div>
      <SiteHeader authed name={session.name} admin={session.role === "ADMIN"} />
      <div className="mx-auto max-w-6xl px-6 py-10">
        <p className="sans text-sm text-[#5c6773]">Welcome, {session.name}</p>
        <p className="sans mt-1 text-sm text-[#5c6773]">Plan: {access.label}</p>
        <h1 className="mt-1 text-4xl">Your tax workspace</h1>
        <p className="mt-2 text-lg">
          ITR-4 — AY {ret.assessmentYear}
        </p>
        <p className="sans mt-1 text-sm text-[#5c6773]">
          Current status: {status}
          {ret.itrType !== "ITR-4" ? ` · Recommended form ${ret.itrType}` : ""}
        </p>
        <div className="mt-6">
          <WorkspaceProgress current={currentWorkspaceStep(continueHref)} />
        </div>
        <div className="mt-8 grid gap-4 md:grid-cols-2">
          <Card>
            <p className="font-medium">Documents</p>
            <p className="sans mt-2 text-sm text-[#5c6773]">
              {docs.uploaded} uploaded · {docs.processed} processed · {docs.verified} verified · {docs.needsReview} needs review
              {docs.conflicts ? ` · ${docs.conflicts} conflicts` : ""}
            </p>
            <Link href={`/returns/${ret.id}/documents`} className="sans mt-3 inline-flex min-h-11 items-center text-sm underline">
              Open documents
            </Link>
          </Card>
          <Card>
            <p className="font-medium">Preparation</p>
            <p className="sans mt-2 text-sm text-[#5c6773]">{status}</p>
            <Link href={`/returns/${ret.id}/income`} className="sans mt-3 inline-flex min-h-11 items-center text-sm underline">
              Open preparation
            </Link>
          </Card>
          <Card>
            <p className="font-medium">Tax summary</p>
            <ul className="sans mt-2 space-y-1 text-sm text-[#5c6773]">
              <li>Tax liability {inr(calc.totalTax || 0)}</li>
              <li>TDS {inr(calc.tds || 0)}</li>
              <li>{refund >= 0 ? "Refund" : "Balance payable"} {inr(Math.abs(refund))}</li>
            </ul>
            <Link href={`/returns/${ret.id}/summary`} className="sans mt-3 inline-flex min-h-11 items-center text-sm underline">
              Open tax summary
            </Link>
          </Card>
          <Card>
            <p className="font-medium">Final review</p>
            <p className="sans mt-2 text-sm text-[#5c6773]">{ready ? "Return ready" : "Complete review"}</p>
            <Badge tone={ready ? "ok" : "warn"}>{ready ? "Ready" : "Not ready"}</Badge>
            <Link href={`/returns/${ret.id}/review`} className="sans mt-3 flex min-h-11 items-center text-sm underline">
              Open final review
            </Link>
          </Card>
        </div>
        {actions.length ? (
          <Card className="mt-4">
            <h2 className="text-xl">{actions.length} action{actions.length === 1 ? "" : "s"} required</h2>
            <ul className="sans mt-3 space-y-2 text-sm">
              {actions.map((a) => (
                <li key={`${a.title}-${a.href}`}>
                  <Link href={a.href} className="underline">
                    {a.title}
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        ) : null}
        <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center">
          <Link href={continueHref}>
            <Button className="min-h-11 w-full sm:w-auto" aria-label="Continue return">
              Continue return
            </Button>
          </Link>
          {!access.canExport ? <UpgradeCta /> : null}
        </div>
        <div className="mt-10">
          <Disclaimer />
        </div>
      </div>
    </div>
  );
}
