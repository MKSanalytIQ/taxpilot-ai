import type { NormalizedReturn } from "@/lib/tax/model";
import { TaxEngine } from "@/lib/tax/engine";
import { determineItrType, eligibilityFromNormalized } from "@/lib/tax-rules/ay2026_27/eligibility";
import { presumptive44AD, presumptive44ADA } from "@/lib/tax-rules/ay2026_27/presumptive";
import { evaluateDeductions } from "@/lib/tax-engine/ay2026_27/deductions";

export type BusinessIssue = {
  id: string;
  code?: string;
  severity: "ERROR" | "WARNING" | "INFO";
  field: string;
  section: string;
  message: string;
  explanation: string;
  fixRoute: string;
};

function isInvalidNumeric(n: number) {
  return typeof n !== "number" || Number.isNaN(n) || !Number.isFinite(n);
}

export function businessValidate(data: NormalizedReturn, returnId = ""): BusinessIssue[] {
  const id = returnId || "new";
  const issues: BusinessIssue[] = [];
  const push = (row: Omit<BusinessIssue, "fixRoute"> & { fixRoute?: string }) => {
    issues.push({
      ...row,
      fixRoute: (row.fixRoute || `/returns/${id}/income`).replace("{id}", id),
    });
  };

  const money = (
    value: number,
    field: string,
    section: string,
    messageNeg: string,
    route: string,
    opts?: { allowNegative?: boolean; skipNegative?: boolean },
  ) => {
    if (isInvalidNumeric(value)) {
      push({
        id: `ITR4_NUM_${field.replaceAll(".", "_").toUpperCase()}`,
        code: "INVALID_NUMERIC_VALUE",
        severity: "ERROR",
        field,
        section,
        message: `${section}: ${field} is not a valid amount.`,
        explanation: "Enter a finite number. NaN and Infinity are not allowed.",
        fixRoute: `/returns/${id}/${route}`,
      });
      return;
    }
    if (!opts?.allowNegative && !opts?.skipNegative && value < 0) {
      push({
        id: `ITR4_NEG_${field.replaceAll(".", "_").toUpperCase()}`,
        code: "NEGATIVE_VALUE_NOT_ALLOWED",
        severity: "ERROR",
        field,
        section,
        message: messageNeg,
        explanation: "This field cannot be negative under the existing return model.",
        fixRoute: `/returns/${id}/${route}`,
      });
    }
  };

  money(data.salary.gross, "grossSalary", "Salary", "Gross salary cannot be negative.", "income");
  money(data.salary.exemptions, "exemptions", "Salary", "Salary exemptions cannot be negative.", "income");
  money(data.salary.tds, "salaryTds", "TDS", "Salary TDS cannot be negative.", "tds");
  money(data.business.turnover, "turnover", "Business", "Turnover and receipts cannot be negative.", "income", { skipNegative: true });
  money(data.business.digitalReceipts, "digitalReceipts", "Business", "Turnover and receipts cannot be negative.", "income", { skipNegative: true });
  money(data.business.cashReceipts, "cashReceipts", "Business", "Turnover and receipts cannot be negative.", "income", { skipNegative: true });
  money(data.business.declaredIncome, "declaredIncome", "Business", "Declared business income cannot be negative.", "income");
  money(data.profession.grossReceipts, "grossReceipts", "Profession", "Professional receipts cannot be negative.", "income", { skipNegative: true });
  money(data.profession.cashReceipts, "professionCashReceipts", "Profession", "Professional cash receipts cannot be negative.", "income");
  money(data.profession.declaredIncome, "professionDeclaredIncome", "Profession", "Declared professional income cannot be negative.", "income");
  for (const [i, p] of data.houseProperties.entries()) {
    money(p.annualLetableValue, `houseProperties.${i}.annualLetableValue`, "House property", "Annual letable value cannot be negative.", "income");
    money(p.municipalTaxes, `houseProperties.${i}.municipalTaxes`, "House property", "Municipal taxes cannot be negative.", "income");
    money(p.interestOnLoan, `houseProperties.${i}.interestOnLoan`, "House property", "Interest on housing loan cannot be negative.", "income");
  }
  for (const [i, o] of data.otherIncome.entries()) {
    money(o.amount, `otherIncome.${i}.amount`, "Other sources", "Other income amount is invalid.", "income", { allowNegative: true });
  }
  for (const [i, g] of data.capitalGains.entries()) {
    money(g.amount, `capitalGains.${i}.amount`, "Capital gains", "Capital gain amount is invalid.", "income", { allowNegative: true });
  }
  for (const [i, d] of data.deductions.entries()) {
    money(d.amount, `deductions.${i}.amount`, "Deductions", `${d.section} deduction cannot be negative.`, "deductions");
  }
  for (const [i, t] of data.tds.entries()) {
    money(t.amount, `tds.${i}.amount`, "TDS", "TDS cannot be negative.", "tds");
    if (t.grossAmount != null) money(t.grossAmount, `tds.${i}.grossAmount`, "TDS", "TDS gross amount cannot be negative.", "tds");
  }
  for (const [i, p] of data.taxPayments.entries()) {
    money(p.amount, `taxPayments.${i}.amount`, "Tax payments", "Tax payment cannot be negative.", "tds");
  }

  if (data.business.turnover < 0 || data.business.cashReceipts < 0 || data.business.digitalReceipts < 0) {
    push({
      id: "ITR4_BP_001",
      code: "NEGATIVE_VALUE_NOT_ALLOWED",
      severity: "ERROR",
      field: "turnover",
      section: "Business",
      message: "Turnover and receipts cannot be negative.",
      explanation: "Replace negative figures with zero or the correct amount.",
    });
  }
  if (data.profession.grossReceipts < 0) {
    push({
      id: "ITR4_BP_002",
      code: "NEGATIVE_VALUE_NOT_ALLOWED",
      severity: "ERROR",
      field: "grossReceipts",
      section: "Profession",
      message: "Professional receipts cannot be negative.",
      explanation: "Gross receipts must be zero or positive.",
    });
  }
  if (data.business.section !== "BOOKS" && data.business.turnover > 0) {
    const p = presumptive44AD(data.business.turnover, data.business.digitalReceipts, data.business.cashReceipts, data.business.declaredIncome);
    if (!p.withinLimit) {
      push({ id: "ITR4_BP_003", severity: "ERROR", field: "turnover", section: "Business", message: "Turnover exceeds s.44AD limits for the cash/digital mix.", explanation: "ITR-4 cannot be used. ITR-3 JSON is not available in this release." });
    }
    if (data.business.declaredIncome > 0 && data.business.declaredIncome < p.minimum) {
      push({
        id: "ITR4_BP_004",
        severity: "ERROR",
        field: "declaredIncome",
        section: "Business",
        message: `Declared 44AD income is below the prescribed ₹${p.minimum.toLocaleString("en-IN")}.`,
        explanation: "Declare at least 6% of digital plus 8% of cash receipts, or maintain books (ITR-3, not yet filing-ready).",
      });
    }
  }
  if (data.profession.section !== "BOOKS" && data.profession.grossReceipts > 0) {
    const p = presumptive44ADA(data.profession.grossReceipts, data.profession.cashReceipts, data.profession.declaredIncome);
    if (!p.withinLimit) {
      push({ id: "ITR4_PR_001", severity: "ERROR", field: "grossReceipts", section: "Profession", message: "Professional receipts exceed s.44ADA limits.", explanation: "ITR-4 cannot be used for this turnover." });
    }
    if (data.profession.declaredIncome > 0 && data.profession.declaredIncome < p.minimum) {
      push({
        id: "ITR4_PR_002",
        severity: "ERROR",
        field: "declaredIncome",
        section: "Profession",
        message: `Declared 44ADA income is below the prescribed ₹${p.minimum.toLocaleString("en-IN")}.`,
        explanation: "Declare at least 50% of receipts, or maintain books (ITR-3, not yet filing-ready).",
      });
    }
  }

  const calc = TaxEngine.calculate(data);
  const elig = determineItrType(
    eligibilityFromNormalized(data, {
      totalIncome: calc.grossTotalIncomeIncLtcg,
      ltcg112A: calc.capitalGains,
    }),
  );
  if (data.itrType === "ITR-4" && !elig.itr4Eligible) {
    for (const r of elig.reasons) {
      push({ id: "ITR4_ELIG_001", severity: "ERROR", field: "itrType", section: "Eligibility", message: r, explanation: "Selected ITR does not match eligibility.", fixRoute: `/returns/${id}/interview` });
    }
  }

  const panRe = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
  if (!panRe.test(data.pan)) {
    push({ id: "ITR4_PI_001", code: "REQUIRED_FIELD_MISSING", severity: "ERROR", field: "pan", section: "Personal information", message: "PAN is missing or invalid.", explanation: "Enter PAN as AAAAA9999A.", fixRoute: `/returns/${id}/profile` });
  }
  if (!data.name.trim()) {
    push({ id: "ITR4_PI_002", code: "REQUIRED_FIELD_MISSING", severity: "ERROR", field: "name", section: "Personal information", message: "Taxpayer name is required.", explanation: "Name as per PAN is required for Verification.", fixRoute: `/returns/${id}/profile` });
  }
  if (!data.bankAccounts.length) {
    push({ id: "ITR4_BA_001", code: "REQUIRED_FIELD_MISSING", severity: "ERROR", field: "bankAccounts", section: "Bank details", message: "At least one bank account is required.", explanation: "The official schema requires bank details for refund credit.", fixRoute: `/returns/${id}/tds` });
  }
  const ifscRe = /^[A-Z]{4}0[A-Z0-9]{6}$/;
  for (const b of data.bankAccounts) {
    if (!ifscRe.test(b.ifsc)) {
      push({ id: "ITR4_BA_002", severity: "ERROR", field: "ifsc", section: "Bank details", message: "IFSC is not valid.", explanation: "Use an 11-character IFSC.", fixRoute: `/returns/${id}/tds` });
    }
    if (!/^[a-zA-Z0-9][a-zA-Z0-9/-]{8,19}$/.test(b.accountNumber)) {
      push({ id: "ITR4_BA_003", severity: "ERROR", field: "accountNumber", section: "Bank details", message: "Bank account number format is invalid.", explanation: "Account number must be 9–20 alphanumeric characters.", fixRoute: `/returns/${id}/tds` });
    }
  }

  const deductionLines = evaluateDeductions(data.deductions, data.regime);
  for (const d of deductionLines) {
    if (d.disallowedAmount > 0) {
      push({
        id: "ITR4_DED_001",
        severity: data.regime === "NEW" ? "INFO" : "WARNING",
        field: d.section,
        section: "Deductions",
        message: `${d.section}: ₹${d.disallowedAmount.toLocaleString("en-IN")} not eligible.`,
        explanation: d.reason,
        fixRoute: `/returns/${id}/deductions`,
      });
    }
  }

  if (calc.tds > calc.totalTax + 100_000 && calc.totalTax === 0) {
    push({
      id: "ITR4_TDS_001",
      severity: "WARNING",
      field: "tds",
      section: "TDS",
      message: "TDS is high relative to computed tax.",
      explanation: "Reconcile with AIS / 26AS. AIS is not assumed to be correct.",
      fixRoute: `/returns/${id}/reconcile`,
    });
  }
  if (data.itrType === "ITR-4" && calc.flags.includes("UNSUPPORTED_CAPITAL_GAINS")) {
    push({
      id: "ITR4_CG_001",
      code: "UNSUPPORTED_SCENARIO",
      severity: "ERROR",
      field: "capitalGains",
      section: "Capital gains",
      message: "Capital gains other than s.112A (within ₹1.25 lakh) cannot be filed in ITR-4.",
      explanation: "Do not mix special-rate / STCG into slab income. ITR-3 JSON is disabled.",
      fixRoute: `/returns/${id}/income`,
    });
  }
  if (!data.fatherName && !data.name) {
    push({ id: "ITR4_VF_001", code: "REQUIRED_FIELD_MISSING", severity: "ERROR", field: "fatherName", section: "Verification", message: "Father's name is required for verification.", explanation: "Official Verification.Declaration.FatherName is required.", fixRoute: `/returns/${id}/profile` });
  }
  return issues;
}

export function canGenerateJson(issues: BusinessIssue[]) {
  return issues.every((i) => i.severity !== "ERROR");
}
