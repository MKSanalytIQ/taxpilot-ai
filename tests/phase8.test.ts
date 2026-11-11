import { describe, expect, it } from "vitest";
import { TaxEngine } from "@/lib/tax/engine";
import { generateITRJson } from "@/lib/itr-json/mapper";
import { completenessValidate } from "@/lib/validation/completeness";
import { businessValidate } from "@/lib/validation/businessRules";
import { detectUnsupported } from "@/lib/itr-rules/ay2026_27/unsupported";
import { evaluateFilingGate } from "@/lib/validation/filingGate";
import { reviewReadiness } from "@/lib/review/readiness";
import { reconcileTds } from "@/lib/documents/tdsReconcile";
import { STANDARD_DEDUCTION_NEW } from "@/lib/tax-rules/ay2026_27/deductions";
import { presumptive44AD, presumptive44ADA } from "@/lib/tax-rules/ay2026_27/presumptive";
import {
  applyVerifiedFactsToState,
  classifyEdit,
  emptyPreparation,
  type AuthoritativeFact,
  type PreparationState,
  type SalaryModel,
} from "@/lib/documents/prefill";
import type { NormalizedReturn } from "@/lib/tax/model";
import type { GeneratedItr, JsonGenerationGate } from "@/lib/itr-json/mapper";

const FILED_ON = new Date("2026-08-26T00:00:00.000Z");
const STD = STANDARD_DEDUCTION_NEW;

function createSyntheticReturn(
  patch: Omit<Partial<NormalizedReturn>, "salary" | "business" | "profession"> & {
    salary?: Partial<NormalizedReturn["salary"]>;
    business?: Partial<NormalizedReturn["business"]>;
    profession?: Partial<NormalizedReturn["profession"]>;
  } = {},
): NormalizedReturn {
  const seed: NormalizedReturn = {
    assessmentYear: "2026-27",
    itrType: "ITR-4",
    taxpayerType: "INDIVIDUAL",
    residentialStatus: "RESIDENT",
    pan: "ABCDE1234F",
    name: "Synthetic Taxpayer",
    fatherName: "Ramesh Taxpayer",
    email: "synthetic@taxpilot.local",
    phone: "9876543210",
    dateOfBirth: "1990-01-15",
    addressLine1: "12 MG Road",
    locality: "Ashok Nagar",
    city: "Bengaluru",
    state: "Karnataka",
    pincode: "560001",
    verificationPlace: "Bengaluru",
    regime: "NEW",
    salary: { gross: 0, exemptions: 0, tds: 0, employerName: "", employerTan: "" },
    business: { section: "44AD", turnover: 0, digitalReceipts: 0, cashReceipts: 0, declaredIncome: 0, nature: "" },
    profession: { section: "44ADA", grossReceipts: 0, cashReceipts: 0, declaredIncome: 0, profession: "" },
    houseProperties: [],
    otherIncome: [],
    capitalGains: [],
    deductions: [],
    tds: [],
    taxPayments: [],
    bankAccounts: [{ ifsc: "HDFC0001234", accountNumber: "12345678901", isPrimary: true, bankName: "HDFC Bank", accountType: "SB" }],
    eligibilityConfirmed: {
      lotteryOrRacehorse: false,
      foreignAssets: false,
      unlistedShares: false,
      fnoTrading: false,
      isDirector: false,
      isLlp: false,
      agriculturalIncome: 0,
    },
  };
  return {
    ...seed,
    ...patch,
    salary: { ...seed.salary, ...patch.salary },
    business: { ...seed.business, ...patch.business },
    profession: { ...seed.profession, ...patch.profession },
  };
}

function calc(data: NormalizedReturn) {
  return TaxEngine.calculate(data, FILED_ON);
}

function jsonOf(data: NormalizedReturn, openDocumentConflicts = 0) {
  return generateITRJson(data, { generatedAt: FILED_ON, openDocumentConflicts, returnId: "phase8" });
}

function gateOf(result: GeneratedItr, data: NormalizedReturn): JsonGenerationGate {
  return {
    allowed: Boolean(result.valid && result.json),
    data,
    result,
    error: result.valid && result.json ? null : "blocked",
  };
}

function expectSupportedLayers(g: GeneratedItr) {
  expect(g.layers.dataCompleteness).toBe("PASS");
  expect(g.layers.eligibility).toBe("PASS");
  expect(g.layers.businessRules).toBe("PASS");
  expect(g.layers.taxCalculation).toBe("PASS");
  expect(g.layers.unsupported).toBe("PASS");
}

function expectJsonFollowsSchemaGate(g: GeneratedItr) {
  if (g.layers.schemaIntegrity === "PASS" && g.layers.schema === "PASS" && g.layers.mapping === "PASS") {
    expect(g.valid).toBe(true);
    expect(g.json).toBeTruthy();
    expect(g.official.valid).toBe(true);
    expect(g.blocked).toBe(false);
  } else {
    expect(g.valid).toBe(false);
    expect(g.json).toBeNull();
    expect(g.blocked).toBe(true);
  }
}

function expectNoBlockingModelIssues(data: NormalizedReturn) {
  expect(completenessValidate(data)).toEqual([]);
  expect(businessValidate(data).filter((i) => i.severity === "ERROR")).toEqual([]);
  expect(detectUnsupported(data)).toEqual([]);
}

describe("Phase 8 realistic ITR-4 scenarios", () => {
  it("scenario 1 — salary + Form 16 TDS", () => {
    const data = createSyntheticReturn({
      name: "Salary Form16",
      salary: { gross: 1_200_000, exemptions: 0, tds: 40_000, employerName: "Acme Pvt Ltd", employerTan: "DELA12345A" },
    });
    expectNoBlockingModelIssues(data);
    const c = calc(data);
    expect(c.standardDeduction).toBe(STD);
    expect(c.salaryIncome).toBe(1_200_000 - STD);
    expect(c.businessIncome).toBe(0);
    expect(c.professionIncome).toBe(0);
    expect(c.capitalGains).toBe(0);
    expect(c.grossTotalIncome).toBe(1_200_000 - STD);
    expect(c.taxableIncome).toBe(1_125_000);
    expect(c.taxableIncome).toBeLessThanOrEqual(1_200_000);
    expect(c.totalTax).toBe(0);
    expect(c.tds).toBe(40_000);
    expect(c.refundOrPayable).toBe(40_000);
    expect(c.isRefund).toBe(true);
    const g = jsonOf(data);
    expectSupportedLayers(g);
    expect(g.calc.salaryIncome).toBe(c.salaryIncome);
    expect(g.calc.tds).toBe(40_000);
    expectJsonFollowsSchemaGate(g);
    expect(reviewReadiness(gateOf(g, data)).status === "READY").toBe(g.valid);
  });

  it("scenario 2 — salary + AIS interest", () => {
    const data = createSyntheticReturn({
      name: "Salary Interest",
      salary: { gross: 1_000_000, exemptions: 0, tds: 50_000, employerName: "Acme Pvt Ltd", employerTan: "DELA12345A" },
      otherIncome: [{ kind: "Interest", amount: 50_000, source: "AIS" }],
    });
    expectNoBlockingModelIssues(data);
    const c = calc(data);
    expect(c.salaryIncome).toBe(1_000_000 - STD);
    expect(c.otherSources).toBe(50_000);
    expect(c.grossTotalIncome).toBe(1_000_000 - STD + 50_000);
    expect(c.taxableIncome).toBe(975_000);
    expect(c.totalTax).toBe(0);
    expect(c.tds).toBe(50_000);
    expect(c.refundOrPayable).toBe(50_000);
    const g = jsonOf(data);
    expectSupportedLayers(g);
    expect(g.calc.otherSources).toBe(50_000);
    expect(g.calc.salaryIncome).toBe(c.salaryIncome);
    expectJsonFollowsSchemaGate(g);
  });

  it("scenario 3 — 44AD presumptive business", () => {
    const data = createSyntheticReturn({
      name: "Presumptive Trader",
      business: {
        section: "44AD",
        turnover: 4_000_000,
        digitalReceipts: 4_000_000,
        cashReceipts: 0,
        declaredIncome: 0,
        nature: "Trading",
        natureCode: "09027",
      },
    });
    expectNoBlockingModelIssues(data);
    const presumptive = presumptive44AD(4_000_000, 4_000_000, 0, 0);
    const c = calc(data);
    expect(presumptive.withinLimit).toBe(true);
    expect(c.businessIncome).toBe(presumptive.income);
    expect(c.businessIncome).toBe(240_000);
    expect(c.taxableIncome).toBe(240_000);
    expect(c.totalTax).toBe(0);
    const g = jsonOf(data);
    expectSupportedLayers(g);
    expect(g.calc.businessIncome).toBe(240_000);
    expectJsonFollowsSchemaGate(g);
  });

  it("scenario 4 — 44ADA presumptive profession", () => {
    const data = createSyntheticReturn({
      name: "Presumptive Designer",
      profession: {
        section: "44ADA",
        grossReceipts: 2_000_000,
        cashReceipts: 0,
        declaredIncome: 0,
        profession: "Design",
        natureCode: "16005",
      },
    });
    expectNoBlockingModelIssues(data);
    const presumptive = presumptive44ADA(2_000_000, 0, 0);
    const c = calc(data);
    expect(c.professionIncome).toBe(presumptive.income);
    expect(c.professionIncome).toBe(1_000_000);
    expect(c.taxableIncome).toBe(1_000_000);
    expect(c.totalTax).toBe(0);
    const g = jsonOf(data);
    expectSupportedLayers(g);
    expect(g.calc.professionIncome).toBe(1_000_000);
    expectJsonFollowsSchemaGate(g);
  });

  it("scenario 5 — TDS reconciliation match vs mismatch", () => {
    expect(reconcileTds(50_000, 50_000)).toBe("MATCHED");
    const matched = createSyntheticReturn({
      salary: { gross: 1_000_000, tds: 50_000, employerName: "Acme Pvt Ltd", employerTan: "DELA12345A" },
    });
    const matchedJson = jsonOf(matched, 0);
    expect(matchedJson.errors.some((e) => e.field === "DOCUMENT_CONFLICT_OPEN")).toBe(false);
    expectSupportedLayers(matchedJson);

    expect(reconcileTds(50_000, 60_000)).toBe("MISMATCH");
    const mismatched = jsonOf(matched, 1);
    expect(mismatched.valid).toBe(false);
    expect(mismatched.json).toBeNull();
    expect(mismatched.errors.some((e) => e.code === "DOCUMENT_CONFLICT_OPEN" || e.field === "DOCUMENT_CONFLICT_OPEN")).toBe(true);
    const ui = reviewReadiness(gateOf(mismatched, matched), { openConflicts: 1 });
    expect(ui.status).toBe("NOT_READY");
    expect(evaluateFilingGate(matched, "phase8", FILED_ON, 1).ready).toBe(false);
  });

  it("scenario 6 — user edit precedence over verified Form 16", () => {
    const fact: AuthoritativeFact = {
      id: "fact-gross",
      status: "VERIFIED",
      verified: true,
      normalizedTaxField: "salary.grossSalary",
      documentType: "FORM_16",
      value: "1250000",
      numericValue: 1_250_000,
      sourceDocumentId: "doc-form16",
      sourcePage: "2",
    };
    const imported = applyVerifiedFactsToState({
      prep: emptyPreparation(),
      facts: [fact],
      openGroups: new Set(),
      existingSalary: null,
      existingInterest: null,
      existingDividend: null,
      existingBusiness: null,
    });
    expect(imported.salary?.grossSalary).toBe(1_250_000);
    const editedPrep: PreparationState = {
      fields: {
        ...imported.prep.fields,
        "salary.grossSalary": classifyEdit(imported.prep.fields["salary.grossSalary"], "1270000"),
      },
    };
    const editedSalary: SalaryModel = { ...imported.salary!, grossSalary: 1_270_000 };
    const again = applyVerifiedFactsToState({
      prep: editedPrep,
      facts: [fact],
      openGroups: new Set(),
      existingSalary: editedSalary,
      existingInterest: null,
      existingDividend: null,
      existingBusiness: null,
    });
    expect(again.salary?.grossSalary).toBe(1_270_000);
    expect(again.prep.fields["salary.grossSalary"].currentValue).toBe("1270000");
    expect(again.prep.fields["salary.grossSalary"].originalValue).toBe("1250000");
    expect(again.prep.fields["salary.grossSalary"].origin).toBe("USER_EDITED");
  });

  it("scenario 7 — unsupported capital gains is blocked", () => {
    const data = createSyntheticReturn({
      capitalGains: [{ kind: "STCG", section: "111A", amount: 80_000 }],
    });
    const unsupported = detectUnsupported(data);
    expect(unsupported.some((u) => u.code === "UNSUPPORTED_CAPITAL_GAIN_TYPE" && u.blocksJson)).toBe(true);
    const g = jsonOf(data);
    expect(g.valid).toBe(false);
    expect(g.json).toBeNull();
    expect(g.layers.unsupported).toBe("FAIL");
    expect(reviewReadiness(gateOf(g, data)).status).toBe("NOT_READY");
  });

  it("scenario 8 — full supported ITR-4 return", () => {
    const data = createSyntheticReturn({
      name: "Full Valid",
      salary: { gross: 800_000, exemptions: 0, tds: 25_000, employerName: "Acme Pvt Ltd", employerTan: "DELA12345A" },
      business: {
        section: "44AD",
        turnover: 1_500_000,
        digitalReceipts: 1_500_000,
        cashReceipts: 0,
        declaredIncome: 0,
        nature: "Retail",
        natureCode: "09027",
      },
      otherIncome: [{ kind: "Interest", amount: 12_000, source: "Bank" }],
    });
    expectNoBlockingModelIssues(data);
    const c = calc(data);
    expect(c.salaryIncome).toBe(800_000 - STD);
    expect(c.businessIncome).toBe(presumptive44AD(1_500_000, 1_500_000, 0, 0).income);
    expect(c.otherSources).toBe(12_000);
    expect(c.grossTotalIncome).toBe(c.salaryIncome + c.businessIncome + c.otherSources);
    expect(c.taxableIncome).toBe(c.grossTotalIncome);
    expect(c.totalTax).toBe(0);
    expect(c.tds).toBe(25_000);
    expect(c.refundOrPayable).toBe(25_000);
    const gate = evaluateFilingGate(data, "phase8", FILED_ON, 0);
    expect(gate.layers.dataCompleteness).toBe("PASS");
    expect(gate.layers.businessRules).toBe("PASS");
    expect(gate.layers.unsupported).toBe("PASS");
    expect(gate.layers.taxCalculation).toBe("PASS");
    expect(gate.layers.eligibility).toBe("PASS");
    const g = jsonOf(data);
    expectSupportedLayers(g);
    expectJsonFollowsSchemaGate(g);
    expect(reviewReadiness(gateOf(g, data)).status === "READY").toBe(Boolean(g.valid && g.json));
  });
});
