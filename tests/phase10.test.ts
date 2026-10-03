import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  applyVerifiedFactsToState,
  classifyEdit,
  documentSectionSummary,
  emptyPreparation,
  simpleDocumentStatus,
  type AuthoritativeFact,
  type PreparationState,
  type SalaryModel,
} from "@/lib/documents/prefill";
import { reviewFactStatus } from "@/lib/documents/mapping";

const form16 = (field: string, amount: number, id: string): AuthoritativeFact => ({
  id,
  status: "VERIFIED",
  verified: true,
  normalizedTaxField: field,
  documentType: "FORM_16",
  value: String(amount),
  numericValue: amount,
  sourceDocumentId: "doc-form16",
  sourcePage: "2",
});

const ais = (field: string, amount: number, id: string): AuthoritativeFact => ({
  id,
  status: "VERIFIED",
  verified: true,
  normalizedTaxField: field,
  documentType: "AIS",
  value: String(amount),
  numericValue: amount,
  sourceDocumentId: "doc-ais",
  sourcePage: "1",
});

function apply(opts: {
  prep: PreparationState;
  salary: SalaryModel | null;
  facts: AuthoritativeFact[];
  openGroups?: Set<string>;
  interest?: { amount: number; source: string } | null;
}) {
  return applyVerifiedFactsToState({
    prep: opts.prep,
    facts: opts.facts,
    openGroups: opts.openGroups || new Set(),
    existingSalary: opts.salary,
    existingInterest: opts.interest ?? null,
    existingDividend: null,
    existingBusiness: null,
  });
}

describe("Phase 10 document → preparation automation", () => {
  it("test 1 — verified Form 16 salary reaches preparation", () => {
    const result = apply({
      prep: emptyPreparation(),
      salary: null,
      facts: [form16("salary.grossSalary", 1_250_000, "f-salary")],
    });
    expect(result.salary?.grossSalary).toBe(1_250_000);
    expect(result.prep.fields["salary.grossSalary"].origin).toBe("IMPORTED");
    expect(result.prep.fields["salary.grossSalary"].source).toBe("FORM_16");
    expect(result.prep.fields["salary.grossSalary"].sourcePage).toBe(2);
    expect(documentSectionSummary(result.prep)).toEqual([{ source: "Form 16", items: ["Salary imported"] }]);
  });

  it("test 2 — verified AIS interest and TDS reach preparation", () => {
    const result = apply({
      prep: emptyPreparation(),
      salary: null,
      facts: [ais("income.interest", 40_000, "a-int"), ais("tds.ais", 12_000, "a-tds")],
    });
    expect(result.interest?.amount).toBe(40_000);
    expect(result.prep.fields["income.interest"].origin).toBe("IMPORTED");
    expect(result.salary?.tds).toBe(12_000);
    expect(result.prep.fields["salary.tds"].origin).toBe("IMPORTED");
    expect(result.prep.fields["salary.tds"].source).toBe("AIS");
    expect(documentSectionSummary(result.prep)).toEqual([
      { source: "AIS", items: ["Interest imported", "TDS imported"] },
    ]);
  });

  it("test 3 — conflicting facts are not automatically applied", () => {
    const result = apply({
      prep: emptyPreparation(),
      salary: null,
      facts: [form16("salary.grossSalary", 1_250_000, "f-salary"), ais("income.salary.ais", 1_280_000, "a-salary")],
      openGroups: new Set(["SALARY"]),
    });
    expect(result.salary?.grossSalary || 0).toBe(0);
    expect(result.prep.fields["salary.grossSalary"]).toBeUndefined();
  });

  it("test 4 — user edit survives document reprocessing", () => {
    const fact = form16("salary.grossSalary", 1_250_000, "f-salary");
    const imported = apply({ prep: emptyPreparation(), salary: null, facts: [fact] });
    const editedPrep: PreparationState = {
      fields: {
        ...imported.prep.fields,
        "salary.grossSalary": classifyEdit(imported.prep.fields["salary.grossSalary"], "1270000"),
      },
    };
    const again = apply({
      prep: editedPrep,
      salary: { ...imported.salary!, grossSalary: 1_270_000 },
      facts: [fact],
    });
    expect(again.salary?.grossSalary).toBe(1_270_000);
    expect(again.prep.fields["salary.grossSalary"].currentValue).toBe("1270000");
    expect(again.prep.fields["salary.grossSalary"].originalValue).toBe("1250000");
    expect(again.prep.fields["salary.grossSalary"].origin).toBe("USER_EDITED");
  });

  it("test 5 — same document reprocessed does not duplicate preparation fields", () => {
    const fact = form16("salary.grossSalary", 1_250_000, "f-salary");
    const first = apply({ prep: emptyPreparation(), salary: null, facts: [fact] });
    const second = apply({ prep: first.prep, salary: first.salary, facts: [fact] });
    expect(Object.keys(second.prep.fields).filter((k) => k === "salary.grossSalary")).toHaveLength(1);
    expect(second.salary?.grossSalary).toBe(1_250_000);
  });

  it("test 6 — new verified document adds interest without replacing salary", () => {
    const salaryFact = form16("salary.grossSalary", 1_250_000, "f-salary");
    const first = apply({ prep: emptyPreparation(), salary: null, facts: [salaryFact] });
    const second = apply({
      prep: first.prep,
      salary: first.salary,
      facts: [salaryFact, ais("income.interest", 40_000, "a-int")],
    });
    expect(second.salary?.grossSalary).toBe(1_250_000);
    expect(second.interest?.amount).toBe(40_000);
    expect(second.prep.fields["salary.grossSalary"].currentValue).toBe("1250000");
    expect(second.prep.fields["income.interest"].origin).toBe("IMPORTED");
  });

  it("test 7 — unverified fact does not enter the tax model", () => {
    const result = apply({
      prep: emptyPreparation(),
      salary: null,
      facts: [
        {
          ...form16("salary.grossSalary", 1_250_000, "u-salary"),
          status: "AI_EXTRACTED",
          verified: false,
        },
      ],
    });
    expect(result.salary).toBeNull();
    expect(result.prep.fields["salary.grossSalary"]).toBeUndefined();
  });

  it("maps existing document statuses into the five simple labels", () => {
    expect(simpleDocumentStatus({ status: "PROCESSING" })).toBe("PROCESSING");
    expect(simpleDocumentStatus({ status: "VERIFIED" })).toBe("VERIFIED");
    expect(simpleDocumentStatus({ status: "EXTRACTED" })).toBe("NEEDS REVIEW");
    expect(simpleDocumentStatus({ status: "NEEDS_REVIEW", factStatuses: ["CONFLICT"] })).toBe("CONFLICT");
    expect(simpleDocumentStatus({ status: "FAILED" })).toBe("FAILED");
  });

  it("verification and conflict resolution auto-apply verified facts", () => {
    const src = readFileSync(join(process.cwd(), "src/app/actions.ts"), "utf8");
    expect(src).toContain("applyVerifiedFactsToTaxModel");
    expect(src.indexOf("applyVerifiedFactsToTaxModel(rid)")).toBeGreaterThan(src.indexOf("reviewExtractionAction"));
    expect(src.indexOf("applyVerifiedFactsToTaxModel(row.returnId)")).toBeGreaterThan(src.indexOf("resolveConflictAction"));
    const applySrc = readFileSync(join(process.cwd(), "src/lib/documents/applyVerified.ts"), "utf8");
    expect(applySrc).toContain("recomputeReturn");
    expect(applySrc).not.toContain("generateITRJson");
  });

  it("does not double salary when two documents agree", () => {
    const result = apply({
      prep: emptyPreparation(),
      salary: null,
      facts: [form16("salary.grossSalary", 1_250_000, "f-salary"), ais("income.salary.ais", 1_250_000, "a-salary")],
    });
    expect(result.salary?.grossSalary).toBe(1_250_000);
  });

  it("drops an imported salary after the fact is rejected", () => {
    const imported = apply({ prep: emptyPreparation(), salary: null, facts: [form16("salary.grossSalary", 1_250_000, "f-salary")] });
    const rejected = apply({
      prep: imported.prep,
      salary: imported.salary,
      facts: [{ ...form16("salary.grossSalary", 1_250_000, "f-salary"), status: "REJECTED", verified: false }],
    });
    expect(rejected.salary?.grossSalary).toBe(0);
    expect(rejected.prep.fields["salary.grossSalary"]).toBeUndefined();
  });

  it("does not keep the earlier document once a salary conflict is open", () => {
    const imported = apply({ prep: emptyPreparation(), salary: null, facts: [form16("salary.grossSalary", 1_250_000, "f-salary")] });
    const conflicted = apply({
      prep: imported.prep,
      salary: imported.salary,
      facts: [form16("salary.grossSalary", 1_250_000, "f-salary"), ais("income.salary.ais", 1_280_000, "a-salary")],
      openGroups: new Set(["SALARY"]),
    });
    expect(conflicted.salary?.grossSalary).toBe(0);
    expect(conflicted.prep.fields["salary.grossSalary"]).toBeUndefined();
  });

  it("keeps an edited extraction unconfirmed", () => {
    expect(reviewFactStatus("edit")).toEqual({ status: "AI_EXTRACTED", verified: false });
    expect(reviewFactStatus("confirm")).toEqual({ status: "VERIFIED", verified: true });
    expect(reviewFactStatus("reject")).toEqual({ status: "REJECTED", verified: false });
  });
});
