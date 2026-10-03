import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { notFound, redirect } from "next/navigation";
import { SiteHeader } from "@/components/site-header";
import { ReturnNav } from "@/components/return-nav";
import { Badge, Button, Card, Input } from "@/components/ui";
import { ValidationIssue } from "@/components/validation-issue";
import { json, inr, maskAccount, maskPan } from "@/lib/utils";
import type { TaxComputation } from "@/lib/tax/engine";
import Link from "next/link";
import { overviewFromRecords, parsePreparation, type PrefillEntry } from "@/lib/documents/prefill";
import { PrepareSummary } from "@/components/prepare-summary";
import { generateJsonAction } from "@/app/json-actions";
import { resolveConflictAction } from "@/app/actions";
import { canGenerateItrJson } from "@/lib/itr-json/mapper";
import { reviewReadiness } from "@/lib/review/readiness";
import { getUserAccess } from "@/lib/plan";
import { ProUpgradeCard } from "@/components/upgrade-cta";

type ConflictFact = { id: string; documentType: string; value: string; numericValue: number | null };

function prettySource(raw: string) {
  if (raw === "FORM_16") return "Form 16";
  if (raw === "BANK_STATEMENT") return "Bank statement";
  if (raw === "USER_INPUT" || raw === "USER_EDITED") return "Manual entry";
  return raw.replaceAll("_", " ");
}

function displayValue(value: string) {
  if (/^-?\d+$/.test(value.trim())) return inr(Number(value));
  return value;
}

function Provenance({ field, entry }: { field: string; entry: PrefillEntry }) {
  const label = prettySource(entry.sourceDocumentType || entry.source);
  const page = entry.sourcePage ? ` · Page ${entry.sourcePage}` : "";
  const verified = entry.verificationStatus === "VERIFIED" || entry.origin === "IMPORTED" || entry.origin === "USER_EDITED";
  if (entry.origin === "USER_EDITED") {
    return (
      <li className="sans text-sm">
        {field}: Current {displayValue(entry.currentValue)} · Imported {displayValue(entry.originalValue)} · Source {label}
        {page}
        {verified ? " · Verified" : ""}
      </li>
    );
  }
  if (entry.origin === "IMPORTED") {
    return (
      <li className="sans text-sm">
        {field}: {displayValue(entry.currentValue)} · Imported automatically from verified documents · {label}
        {page}
        {verified ? " · Verified" : ""}
      </li>
    );
  }
  return (
    <li className="sans text-sm">
      {field}: {displayValue(entry.currentValue)} · Source: Manual entry
    </li>
  );
}

export default async function ReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) redirect("/login");
  const { id } = await params;
  const access = await getUserAccess(session.userId);
  const ret = await prisma.taxReturn.findFirst({
    where: { id, userId: session.userId },
    include: {
      user: { include: { profile: true } },
      salary: true,
      business: true,
      professional: true,
      houseProperties: true,
      capitalGains: true,
      otherIncomes: true,
      deductions: true,
      tdsEntries: true,
      taxPayments: true,
      bankAccounts: true,
      validationErrors: true,
      documents: true,
      taxFacts: true,
      documentConflicts: true,
      jsonFiles: { where: { status: "CURRENT" }, take: 1 },
    },
  });
  if (!ret) notFound();
  const calc = json<TaxComputation>(ret.calculationJson, {} as TaxComputation);
  const prep = parsePreparation(ret.preparationJson);
  const sources = json<string[]>(ret.incomeSourcesJson, []);
  const openConflicts = ret.documentConflicts.filter((c) => c.status === "OPEN");
  const overview = overviewFromRecords(id, {
    documents: ret.documents,
    facts: ret.taxFacts,
    openConflicts,
    prep,
    hasPan: Boolean(ret.user.profile?.pan),
    salarySources: sources.some((x) => x.includes("SALARY")),
    hasSalary: Boolean(ret.salary[0]?.grossSalary),
    businessSources: sources.some((x) => ["BUSINESS", "FREELANCING", "PROFESSION"].includes(x)),
    hasBusiness: Boolean(ret.business[0]?.turnover || ret.professional[0]?.grossReceipts),
    hasBank: ret.bankAccounts.length > 0,
    validationErrors: ret.validationErrors.filter((e) => e.severity === "ERROR").length,
  });
  const gate = await canGenerateItrJson(id, { ownerUserId: session.userId });
  const readiness = reviewReadiness(gate, { returnId: id, openConflicts: openConflicts.length });
  const ready = readiness.status === "READY" && gate.allowed;
  const profile = ret.user.profile;
  const deductionLines = (calc.deductionLines || []).filter((d) => d.amount || d.eligibleAmount);
  const checklistTone = (s: string) => (s === "COMPLETE" ? "ok" : s === "BLOCKED" ? "err" : "warn") as "ok" | "err" | "warn";
  return (
    <div>
      <SiteHeader authed name={session.name} />
      <div className="mx-auto max-w-3xl px-6 py-8">
        <ReturnNav id={id} current="review" />
        <h1 className="text-3xl">Final review</h1>
        <p className="sans mt-2 text-sm text-[#5c6773]">
          This page summarises the return. JSON generation stays blocked unless the filing gate allows it.{" "}
          <Link href={`/returns/${id}/history`} className="underline">
            History
          </Link>
        </p>

        <Card className="mt-6 flex items-center justify-between gap-3">
          <div>
            <p className="font-medium">Readiness</p>
            <p className="sans mt-1 text-sm text-[#5c6773]">
              {ready ? "The existing filing gate allows ITR-4 JSON generation." : "Action required before JSON can be generated."}
            </p>
          </div>
          <Badge tone={ready ? "ok" : "err"}>{ready ? "READY" : "NOT READY"}</Badge>
        </Card>

        <Card className="mt-4">
          <p className="font-medium">Personal / return information</p>
          <ul className="sans mt-2 space-y-1 text-sm">
            <li>Name {ret.user.name}</li>
            <li>PAN {maskPan(profile?.pan || "")}</li>
            <li>Assessment year {ret.assessmentYear}</li>
            <li>ITR type {ret.itrType} · Regime {ret.taxRegime === "OLD" ? "Old" : "New"}</li>
            <li>Residential status {profile?.residentialStatus || "Not set"}</li>
          </ul>
        </Card>

        <Card className="mt-4">
          <p className="font-medium">Income</p>
          <ul className="sans mt-2 space-y-1 text-sm">
            <li>Salary {inr(calc.salaryIncome || 0)}</li>
            <li>Business {inr(calc.businessIncome || 0)}</li>
            <li>Profession {inr(calc.professionIncome || 0)}</li>
            <li>House property {inr(calc.housePropertyIncome || 0)}</li>
            <li>Capital gains {inr(calc.capitalGains || 0)}</li>
            <li>Other sources {inr(calc.otherSources || 0)}</li>
            <li>Gross income {inr(calc.grossTotalIncomeIncLtcg || calc.grossTotalIncome || 0)}</li>
            <li>Total income {inr(calc.grossTotalIncome || 0)}</li>
            <li>Taxable income {inr(calc.taxableIncome || 0)}</li>
          </ul>
        </Card>

        <Card className="mt-4">
          <p className="font-medium">Deductions</p>
          <p className="sans mt-2 text-sm">Total deductions {inr(calc.deductions || 0)}</p>
          {deductionLines.length ? (
            <ul className="sans mt-2 space-y-1 text-sm">
              {deductionLines.map((d) => (
                <li key={d.section}>
                  {d.section} {inr(d.eligibleAmount || d.amount || 0)}
                </li>
              ))}
            </ul>
          ) : null}
        </Card>

        <Card className="mt-4">
          <p className="font-medium">TDS / tax payments</p>
          <ul className="sans mt-2 space-y-1 text-sm">
            <li>TDS {inr(calc.tds || 0)}</li>
            <li>Advance tax {inr(calc.advanceTax || 0)}</li>
            <li>Self-assessment {inr(calc.selfAssessmentTax || 0)}</li>
            <li>Bank {ret.bankAccounts[0] ? maskAccount(ret.bankAccounts[0].accountNumber) : "Missing"}</li>
          </ul>
        </Card>

        <Card className="mt-4">
          <p className="font-medium">Tax calculation</p>
          <ul className="sans mt-2 space-y-1 text-sm">
            <li>Tax liability {inr(calc.totalTax || 0)}</li>
            <li>TDS {inr(calc.tds || 0)}</li>
            <li>Tax already paid {inr(calc.prepaid || 0)}</li>
            <li>
              {(calc.refundOrPayable || 0) >= 0 ? "Refund" : "Balance payable"} {inr(Math.abs(calc.refundOrPayable || 0))}
            </li>
          </ul>
        </Card>

        <div className="mt-4">
          <PrepareSummary {...overview.summary} sections={overview.sections} imports={overview.imports} />
        </div>

        <Card className="mt-4">
          <p className="font-medium">Conflicts</p>
          {openConflicts.length ? (
            <div className="mt-3 space-y-4">
              {openConflicts.map((c) => {
                let facts: ConflictFact[] = [];
                try {
                  facts = JSON.parse(c.factsJson || "[]") as ConflictFact[];
                } catch {
                  facts = [];
                }
                return (
                  <div key={c.id} className="space-y-2">
                    <p className="sans text-sm font-medium">
                      {c.field.replaceAll("_", " ")} mismatch · Status: UNRESOLVED
                    </p>
                    {facts.map((f) => (
                      <form key={f.id} action={resolveConflictAction} className="flex flex-wrap items-center justify-between gap-2">
                        <p className="sans text-sm">
                          {prettySource(f.documentType)}: {f.numericValue != null ? inr(f.numericValue) : f.value}
                        </p>
                        <input type="hidden" name="conflictId" value={c.id} />
                        <input type="hidden" name="resolution" value="USE_SOURCE" />
                        <input type="hidden" name="factId" value={f.id} />
                        <Button type="submit" variant="outline">
                          Use {prettySource(f.documentType)}
                        </Button>
                      </form>
                    ))}
                    <form action={resolveConflictAction} className="flex flex-wrap gap-2">
                      <input type="hidden" name="conflictId" value={c.id} />
                      <input type="hidden" name="resolution" value="MANUAL_VALUE" />
                      <Input name="value" placeholder="Enter value" />
                      <Button type="submit">Enter Value</Button>
                    </form>
                    <Link href={`/returns/${id}/documents`} className="sans text-xs text-[#1f4e46] underline">
                      Open documents
                    </Link>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="sans mt-2 text-sm text-[#5c6773]">No open conflicts.</p>
          )}
        </Card>

        {Object.keys(prep.fields).length ? (
          <Card className="mt-4">
            <p className="font-medium">Imported and user-edited values</p>
            <ul className="mt-2 space-y-1">
              {Object.entries(prep.fields).map(([field, entry]) => (
                <Provenance key={field} field={field} entry={entry} />
              ))}
            </ul>
          </Card>
        ) : null}

        <Card className="mt-4">
          <p className="font-medium">Review checklist</p>
          <ul className="mt-3 space-y-2">
            {readiness.checklist.map((item) => (
              <li key={item.label} className="flex items-center justify-between gap-3">
                {item.href ? (
                  <Link href={item.href} className="sans text-sm">
                    {item.label}
                  </Link>
                ) : (
                  <span className="sans text-sm">{item.label}</span>
                )}
                <Badge tone={checklistTone(item.status)}>{item.status}</Badge>
              </li>
            ))}
          </ul>
        </Card>

        {ready ? (
          <Card className="mt-4">
            <p className="font-medium">✓ Return ready for ITR-4 JSON generation</p>
            {access.isPro ? (
              <form action={generateJsonAction} className="mt-4">
                <input type="hidden" name="returnId" value={id} />
                <Button type="submit">Generate ITR JSON</Button>
              </form>
            ) : (
              <ProUpgradeCard />
            )}
            {ret.jsonFiles[0]?.valid ? (
              <p className="sans mt-3 text-sm text-emerald-800">JSON generated successfully · Schema validation passed</p>
            ) : null}
            <Link href={`/returns/${id}/json`} className="sans mt-3 inline-block text-sm text-[#1f4e46] underline">
              Open JSON page
            </Link>
          </Card>
        ) : (
          <Card className="mt-4">
            <p className="font-medium">Action required</p>
            <ul className="mt-3 space-y-2">
              {readiness.reasons.map((r) => (
                <li key={`${r.title}-${r.detail}`}>
                  <div className="flex items-start justify-between gap-3">
                    <p className="sans text-sm font-medium">{r.section || r.title}</p>
                    <Badge tone="err">{r.severity || "BLOCKING"}</Badge>
                  </div>
                  <p className="sans text-sm text-[#5c6773]">{r.detail}</p>
                  {r.section ? <p className="sans text-xs text-[#5c6773]">Section: {r.section}</p> : null}
                  {r.href ? (
                    <Link href={r.href} className="sans text-xs text-[#1f4e46] underline">
                      Fix this
                    </Link>
                  ) : null}
                </li>
              ))}
            </ul>
          </Card>
        )}

        {readiness.warnings.length ? (
          <Card className="mt-4">
            <p className="font-medium">Review recommended</p>
            <ul className="mt-3 space-y-2">
              {readiness.warnings.map((w) => (
                <li key={`${w.detail}`}>
                  <div className="flex items-start justify-between gap-3">
                    <p className="sans text-sm font-medium">{w.detail}</p>
                    <Badge tone="warn">WARNING</Badge>
                  </div>
                  {w.section ? <p className="sans text-xs text-[#5c6773]">Section: {w.section}</p> : null}
                </li>
              ))}
            </ul>
          </Card>
        ) : null}

        <div className="mt-6 space-y-3">
          {(gate.result?.errors || []).filter((e) => e.severity === "ERROR").map((e, i) => (
            <ValidationIssue
              key={`${e.field || "err"}-${i}`}
              severity="ERROR"
              title={`BLOCKING${e.section ? ` · ${e.section}` : ""}`}
              message={e.message}
              suggestion={e.explanation}
              href={e.fixRoute}
            />
          ))}
          {(gate.result?.warnings || []).map((w, i) => (
            <ValidationIssue
              key={`${w.field || "warn"}-${i}`}
              severity="WARNING"
              title={`WARNING${w.section ? ` · ${w.section}` : ""}`}
              message={w.message}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
