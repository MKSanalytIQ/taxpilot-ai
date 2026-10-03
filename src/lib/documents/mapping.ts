import type { DocumentType } from "./types";

/** Explicit source → tax-model field map. Unmapped facts never enter the tax model. */
export const TAX_FIELD_MAP: Record<string, Partial<Record<string, string>>> = {
  FORM_16: {
    employeeName: "profile.name",
    employeePan: "profile.pan",
    employerName: "salary.employerName",
    employerTan: "salary.employerTan",
    assessmentYear: "return.assessmentYear",
    financialYear: "return.financialYear",
    grossSalary: "salary.grossSalary",
    exemptAllowances: "salary.exemptions",
    salaryDeductions: "salary.deductions",
    standardDeduction: "salary.standardDeduction",
    professionalTax: "salary.professionalTax",
    taxableSalary: "salary.taxable",
    tds: "salary.tds",
    chapterVia: "deductions.chapterVia",
  },
  AIS: {
    salary: "income.salary.ais",
    interest: "income.interest",
    dividend: "income.dividend",
    securities: "income.securities",
    mutualFund: "income.mutualFund",
    tds: "tds.ais",
    tcs: "tcs.ais",
    other: "income.other.ais",
  },
  TIS: {
    reportedIncome: "income.tis.reported",
    processed: "income.tis.processed",
    tds: "tds.tis",
    tcs: "tcs.tis",
  },
  BANK_STATEMENT: {
    verifiedBusinessReceipt: "business.receipts",
  },
};

/** Semantic groups used only for conflict detection. Distinct amounts in the same group become a conflict. */
export const CONFLICT_GROUPS: Record<string, string> = {
  "salary.grossSalary": "SALARY",
  "income.salary.ais": "SALARY",
  "salary.tds": "TDS",
  "tds.ais": "TDS",
  "tds.tis": "TDS",
  "income.interest": "INTEREST",
  "income.dividend": "DIVIDEND",
};

export const GROUP_TO_TAX_FIELD: Record<string, string> = {
  SALARY: "salary.grossSalary",
  TDS: "salary.tds",
  INTEREST: "income.interest",
  DIVIDEND: "income.dividend",
};

export function normalizedTaxField(kind: DocumentType, field: string) {
  return TAX_FIELD_MAP[kind]?.[field] || "";
}

export function conflictGroup(normalized: string) {
  return CONFLICT_GROUPS[normalized] || "";
}

/** Only VERIFIED facts may enter the tax model. */
export function canEnterTaxModel(status: string, verified: boolean) {
  if (status === "AI_EXTRACTED") return false;
  if (status === "REJECTED") return false;
  if (status === "CONFLICT") return false;
  if (status === "PENDING") return false;
  return status === "VERIFIED" && verified;
}

/** An edited extraction stays unconfirmed until the user verifies it. */
export function reviewFactStatus(decision: string): { status: "VERIFIED" | "REJECTED" | "AI_EXTRACTED"; verified: boolean } {
  if (decision === "reject") return { status: "REJECTED", verified: false };
  if (decision === "confirm") return { status: "VERIFIED", verified: true };
  return { status: "AI_EXTRACTED", verified: false };
}
