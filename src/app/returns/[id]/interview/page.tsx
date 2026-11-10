import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { notFound, redirect } from "next/navigation";
import { SiteHeader } from "@/components/site-header";
import { ReturnNav } from "@/components/return-nav";
import { Badge, Button, Card } from "@/components/ui";
import { answerQuestionAction } from "@/app/actions";
import { parseOptions, seedInterview } from "@/lib/interview";
import { getAIProvider } from "@/lib/providers/ai";
import { json } from "@/lib/utils";
import { parseEligibilityResult } from "@/lib/tax-rules/ay2026_27/eligibility";
import Link from "next/link";
import { overviewFromRecords, parsePreparation } from "@/lib/documents/prefill";
import { PrepareSummary } from "@/components/prepare-summary";
import { recomputeReturn } from "@/lib/tax/persist";

export default async function Interview({ params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) redirect("/login");
  const { id } = await params;
  const ret = await prisma.taxReturn.findFirst({
    where: { id, userId: session.userId },
    include: {
      questions: { orderBy: { sortOrder: "asc" }, include: { answers: true } },
      documents: true,
      taxFacts: true,
      documentConflicts: true,
      salary: true,
      business: true,
      professional: true,
      bankAccounts: true,
      validationErrors: true,
      user: { include: { profile: true } },
    },
  });
  if (!ret) notFound();
  const questions = ret.questions ?? [];
  if (questions.length === 0) {
    const existingSources = json<string[]>(ret.incomeSourcesJson, []);
    await seedInterview(id, existingSources.length ? existingSources : ["SALARY", "BUSINESS", "INTEREST"]);
    await recomputeReturn(id).catch((error) => {
      console.error("interview seed recompute failed", error);
    });
    redirect(`/returns/${id}/interview`);
  }
  if (!ret.eligibilityJson || ret.eligibilityJson === "{}") {
    const recomputed = await recomputeReturn(id).catch((error) => {
      console.error("interview eligibility recompute failed", error);
      return null;
    });
    if (recomputed) redirect(`/returns/${id}/interview`);
  }
  const sources = json<string[]>(ret.incomeSourcesJson, []);
  const overview = overviewFromRecords(id, {
    documents: ret.documents ?? [],
    facts: ret.taxFacts ?? [],
    openConflicts: (ret.documentConflicts ?? []).filter((c) => c.status === "OPEN"),
    prep: parsePreparation(ret.preparationJson),
    hasPan: Boolean(ret.user.profile?.pan),
    salarySources: sources.some((x) => x.includes("SALARY")),
    hasSalary: Boolean(ret.salary?.[0]?.grossSalary),
    businessSources: sources.some((x) => ["BUSINESS", "FREELANCING", "PROFESSION"].includes(x)),
    hasBusiness: Boolean(ret.business?.[0]?.turnover || ret.professional?.[0]?.grossReceipts),
    hasBank: (ret.bankAccounts ?? []).length > 0,
    validationErrors: (ret.validationErrors ?? []).filter((e) => e.severity === "ERROR").length,
  });
  const eligibility = parseEligibilityResult(ret.eligibilityJson);
  const pending = questions.find((q) => q.status === "PENDING");
  let explainer = "";
  if (pending) {
    try {
      explainer = await getAIProvider().explain(pending.helpText || pending.prompt);
    } catch (error) {
      console.error("interview explain failed", error);
      explainer = pending.helpText || "";
    }
  }
  return (
    <div>
      <SiteHeader authed name={session.name} />
      <div className="mx-auto max-w-3xl px-6 py-8">
        <ReturnNav id={id} current="interview" />
        <h1 className="text-3xl">Guided interview</h1>
        <p className="sans mt-2 text-sm text-[#5c6773]">
          Recommended form: <strong>{ret.itrType}</strong>. This decision is from published eligibility rules, not the assistant.
        </p>
        <div className="mt-4">
          <PrepareSummary {...overview.summary} sections={overview.sections} imports={overview.imports} />
        </div>
        {ret.itrType === "ITR-3" ? (
          <Card className="mt-4">
            <p className="font-medium">You are on the ITR-3 path. Enter income and review the tax computation. ITR-3 JSON download is disabled in production unless this deployment explicitly enables it.</p>
          </Card>
        ) : null}
        {!eligibility.itr4Eligible ? (
          <Card className="mt-4 border-amber-200">
            <p className="font-medium">ITR-4 does not apply</p>
            <ul className="sans mt-2 list-disc pl-5 text-sm">
              {eligibility.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
            <p className="sans mt-2 text-sm">You are on the ITR-3 path. Detailed P&L screens are available under Income.</p>
          </Card>
        ) : null}
        {pending ? (
          <Card className="mt-6">
            <p className="text-xl">{pending.prompt}</p>
            <p className="sans mt-3 text-sm text-[#5c6773]">{explainer}</p>
            <div className="mt-4 flex flex-wrap gap-2">
              {parseOptions(pending.optionsJson).map((opt) => (
                <form key={opt} action={answerQuestionAction}>
                  <input type="hidden" name="questionId" value={pending.id} />
                  <input type="hidden" name="value" value={opt} />
                  <Button type="submit" variant={opt === "Not sure" ? "outline" : "primary"}>
                    {opt}
                  </Button>
                </form>
              ))}
            </div>
          </Card>
        ) : (
          <Card className="mt-6">
            <Badge tone="ok">Interview complete</Badge>
            <div className="mt-4">
              <Link href={`/returns/${id}/profile`}>
                <Button>Continue to personal information</Button>
              </Link>
            </div>
          </Card>
        )}
        <ul className="sans mt-6 space-y-1 text-sm text-[#5c6773]">
          {questions.map((q) => (
            <li key={q.id}>
              {q.status === "ANSWERED" ? "✓" : "○"} {q.prompt} {q.answers?.[0] ? `— ${q.answers[0].value}` : ""}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
