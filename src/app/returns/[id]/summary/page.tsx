import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { notFound, redirect } from "next/navigation";
import { SiteHeader } from "@/components/site-header";
import { ReturnNav } from "@/components/return-nav";
import { Badge, Button, Card, Disclaimer } from "@/components/ui";
import { json, inr } from "@/lib/utils";
import { generateJsonAction } from "@/app/json-actions";
import type { TaxComputation } from "@/lib/tax/engine";
import Link from "next/link";
import { getUserAccess } from "@/lib/plan";
import { ProUpgradeCard } from "@/components/upgrade-cta";

export default async function SummaryPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ generated?: string; upgrade?: string }> }) {
  const session = await getSession();
  if (!session) redirect("/login");
  const { id } = await params;
  const { generated } = await searchParams;
  const access = await getUserAccess(session.userId);
  const ret = await prisma.taxReturn.findFirst({
    where: { id, userId: session.userId },
    include: {
      documents: true,
      validationErrors: true,
      jsonFiles: { orderBy: { generatedAt: "desc" }, take: 1 },
      user: { include: { profile: true } },
      taxFacts: true,
      documentConflicts: true,
      salary: true,
      business: true,
      professional: true,
      bankAccounts: true,
    },
  });
  if (!ret) notFound();
  const calc = json<TaxComputation>(ret.calculationJson, {} as TaxComputation);
  const errors = ret.validationErrors.filter((e) => e.severity === "ERROR");
  const openConflicts = ret.documentConflicts.filter((c) => c.status === "OPEN");
  return (
    <div>
      <SiteHeader authed name={session.name} />
      <div className="mx-auto max-w-3xl px-6 py-8">
        <ReturnNav id={id} current="summary" />
        <h1 className="text-3xl">Return summary</h1>
        {generated ? <p className="sans mt-2 text-sm text-emerald-800">JSON generated. Download below — the file is not altered after validation.</p> : null}
        <Card className="mt-6 space-y-1 text-sm">
          <p>Taxpayer: {ret.user.name} · PAN {ret.user.profile?.pan || "—"}</p>
          <p>Assessment year: {ret.assessmentYear}</p>
          <p>ITR type: {ret.itrType} · Regime: {ret.taxRegime}</p>
        </Card>
        <Card className="mt-4">
          <h2 className="text-xl">Income</h2>
          <ul className="sans mt-3 space-y-1 text-sm">
            <li>Salary {inr(calc.salaryIncome || 0)}</li>
            <li>Business {inr(calc.businessIncome || 0)}</li>
            <li>Profession {inr(calc.professionIncome || 0)}</li>
            <li>Capital gains {inr(calc.capitalGains || 0)}</li>
            <li>House property {inr(calc.housePropertyIncome || 0)}</li>
            <li>Other sources {inr(calc.otherSources || 0)}</li>
            <li>Deductions {inr(calc.deductions || 0)}</li>
            <li>Taxable income {inr(calc.taxableIncome || 0)}</li>
          </ul>
        </Card>
        <Card className="mt-4">
          <h2 className="text-xl">Tax</h2>
          <ul className="sans mt-3 space-y-1 text-sm">
            <li>Tax before rebate {inr(calc.taxBeforeRebate || 0)}</li>
            <li>Rebate 87A {inr(calc.rebate || 0)}</li>
            <li>Surcharge {inr(calc.surcharge || 0)}</li>
            <li>Cess {inr(calc.cess || 0)}</li>
            <li>Total tax {inr(calc.totalTax || 0)}</li>
            <li>TDS {inr(calc.tds || 0)}</li>
            <li>{(calc.refundOrPayable || 0) >= 0 ? "Refund" : "Payable"} {inr(Math.abs(calc.refundOrPayable || 0))}</li>
          </ul>
        </Card>
        <div className="mt-4 flex gap-3">
          <Badge tone={errors.length ? "err" : "ok"}>{errors.length ? `${errors.length} validation errors` : "No blocking errors"}</Badge>
          <Badge>{ret.documents.length} documents</Badge>
          <Badge tone={openConflicts.length ? "err" : "ok"}>{openConflicts.length ? `${openConflicts.length} open conflicts` : "No open conflicts"}</Badge>
        </div>
        <Card className="mt-4 sans text-sm space-y-1">
          <p>Income {inr(calc.grossTotalIncome || calc.salaryIncome || 0)}</p>
          <p>Deductions {inr(calc.deductions || 0)}</p>
          <p>Tax {inr(calc.totalTax || 0)}</p>
          <p>TDS {inr(calc.tds || 0)}</p>
          <p>{(calc.refundOrPayable || 0) >= 0 ? "Refund" : "Payable"} {inr(Math.abs(calc.refundOrPayable || 0))}</p>
          <p>Open conflicts {openConflicts.length}</p>
          <p>Missing required information {errors.length ? "Yes" : "No blocking errors"}</p>
        </Card>
        {ret.itrType !== "ITR-4" && ret.itrType !== "ITR-3" ? (
          <p className="sans mt-6 text-sm text-red-800">
            Filing JSON is not available for this return type.
          </p>
        ) : errors.length ? (
          <p className="sans mt-6 text-sm text-red-800">
            Unable to generate the return. Please correct the highlighted issues.
          </p>
        ) : access.canExport ? (
          <form action={generateJsonAction} className="mt-6">
            <input type="hidden" name="returnId" value={id} />
            <Button type="submit">Generate ITR JSON</Button>
          </form>
        ) : (
          <ProUpgradeCard />
        )}
        {access.canExport && ret.jsonFiles[0] ? (
          <Link href={`/api/returns/${id}/download-json`} className="sans mt-4 inline-block text-sm text-[#1f4e46]">
            Download ITR JSON
          </Link>
        ) : null}
        <Card className="mt-8">
          <h2 className="text-xl">Official filing instructions</h2>
          <ol className="sans mt-3 list-decimal space-y-2 pl-5 text-sm text-[#5c6773]">
            <li>Review every figure. TaxPilot does not file the return for you.</li>
            <li>Download the JSON. Do not edit it after generation.</li>
            <li>Log in to the Income Tax e-filing portal yourself. TaxPilot never stores those credentials.</li>
            <li>Use “Upload JSON” / offline utility for AY {ret.assessmentYear} and complete e-verification.</li>
            <li>Due date for ITR-4 AY 2026–27 is 31 August 2026 (ITD FAQ).</li>
          </ol>
        </Card>
        <div className="mt-6">
          <Disclaimer />
        </div>
      </div>
    </div>
  );
}
