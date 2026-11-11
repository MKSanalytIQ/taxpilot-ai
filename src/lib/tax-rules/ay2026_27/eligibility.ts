import type { NormalizedReturn } from "@/lib/tax/model";
import { ADA_RECEIPTS_CASH_LIMIT, ADA_RECEIPTS_DIGITAL_LIMIT, AD_TURNOVER_CASH_LIMIT, AD_TURNOVER_DIGITAL_LIMIT, cashWithinDigitalThreshold } from "./presumptive";

export const ITR4_INCOME_CAP = 5_000_000;
export const ITR4_112A_CAP = 125_000;
export const ITR4_AGRI_CAP = 5_000;
export const ITR4_HOUSE_PROPERTY_CAP = 2;

export type EligibilityInput = {
  taxpayerType: "INDIVIDUAL" | "HUF" | "FIRM";
  residentialStatus: "RESIDENT" | "RNOR" | "NRI" | "";
  isLlp: boolean | null;
  isDirector: boolean | null;
  sources: string[];
  totalIncome: number;
  housePropertyCount: number;
  ltcg112A: number;
  stcg: number;
  otherLtcg: number;
  agriculturalIncome: number | null;
  lotteryOrRacehorse: boolean | null;
  foreignAssets: boolean | null;
  unlistedShares: boolean | null;
  businessTurnover: number;
  businessCash: number;
  professionReceipts: number;
  professionCash: number;
  usesPresumptive: boolean;
  detailedBooks: boolean;
  fnoTrading: boolean | null;
};

export type EligibilityResult = {
  recommended: "ITR-4" | "ITR-3" | "UNSUPPORTED";
  itr4Eligible: boolean;
  reasons: string[];
  warnings: string[];
};

const LOTTERY_RE = /lottery|racehorse|race horse|horse race/i;
const FOREIGN_RE = /foreign asset|foreign income|overseas asset/i;
const UNLISTED_RE = /unlisted/i;
const AGRI_RE = /agricultur/i;
const FNO_RE = /f&o|futures|speculative/i;

function triState(detected: boolean, confirmed: boolean | undefined): boolean | null {
  if (detected) return true;
  if (typeof confirmed === "boolean") return confirmed;
  return null;
}

function sourceHit(sources: string[], ...needles: string[]) {
  return sources.some((source) => needles.some((needle) => source.includes(needle)));
}

/** Known evidence forces true. An explicit confirmation can be false. Anything else stays unknown. */
export function eligibilityFromNormalized(
  data: NormalizedReturn,
  extras: {
    sources?: string[];
    directorAnswer?: string | null;
    totalIncome?: number;
    ltcg112A?: number;
    housePropertyCount?: number;
    stcg?: number;
    otherLtcg?: number;
    usesPresumptive?: boolean;
    detailedBooks?: boolean;
  } = {},
): EligibilityInput {
  const listed = [...(data.incomeSources || []), ...(extras.sources || [])].map((source) => source.toUpperCase());
  const otherText = data.otherIncome.map((row) => `${row.kind} ${row.source}`).join("\n");
  const confirmed = data.eligibilityConfirmed;
  const agriRows = data.otherIncome.filter((row) => AGRI_RE.test(`${row.kind} ${row.source}`));
  const agriDetected = agriRows.length > 0 || sourceHit(listed, "AGRI");
  const agriculturalIncome = agriDetected
    ? agriRows.reduce((sum, row) => sum + row.amount, 0)
    : typeof confirmed?.agriculturalIncome === "number"
      ? confirmed.agriculturalIncome
      : null;
  const directorAnswer = extras.directorAnswer;
  const directorConfirmed =
    directorAnswer === "Yes" ? true : directorAnswer === "No" ? false : confirmed?.isDirector;
  const inferredSources = [
    data.salary.gross ? "SALARY" : "",
    data.business.turnover || data.business.digitalReceipts ? "BUSINESS" : "",
    data.profession.grossReceipts ? "PROFESSION" : "",
    ...listed,
  ].filter(Boolean);
  return {
    taxpayerType: data.taxpayerType,
    residentialStatus: data.residentialStatus,
    isLlp: data.taxpayerType === "FIRM" ? triState(false, confirmed?.isLlp) : false,
    isDirector: triState(directorAnswer === "Yes", directorConfirmed),
    sources: inferredSources,
    totalIncome: extras.totalIncome ?? 0,
    housePropertyCount: extras.housePropertyCount ?? data.houseProperties.length,
    ltcg112A: extras.ltcg112A ?? 0,
    stcg: extras.stcg ?? data.capitalGains.filter((gain) => gain.kind === "STCG").reduce((sum, gain) => sum + gain.amount, 0),
    otherLtcg:
      extras.otherLtcg ??
      data.capitalGains.filter((gain) => gain.section !== "112A" && gain.kind !== "LTCG_112A").reduce((sum, gain) => sum + gain.amount, 0),
    agriculturalIncome,
    lotteryOrRacehorse: triState(sourceHit(listed, "LOTTERY", "RACE") || LOTTERY_RE.test(otherText), confirmed?.lotteryOrRacehorse),
    foreignAssets: triState(sourceHit(listed, "FOREIGN") || FOREIGN_RE.test(otherText), confirmed?.foreignAssets),
    unlistedShares: triState(sourceHit(listed, "UNLISTED") || UNLISTED_RE.test(otherText), confirmed?.unlistedShares),
    businessTurnover: data.business.turnover,
    businessCash: data.business.cashReceipts,
    professionReceipts: data.profession.grossReceipts,
    professionCash: data.profession.cashReceipts,
    usesPresumptive: extras.usesPresumptive ?? (data.business.section !== "BOOKS" && data.profession.section !== "BOOKS"),
    detailedBooks: extras.detailedBooks ?? (data.business.section === "BOOKS" || data.profession.section === "BOOKS"),
    fnoTrading: triState(sourceHit(listed, "FNO") || FNO_RE.test(otherText), confirmed?.fnoTrading),
  };
}

export function determineItrType(input: EligibilityInput): EligibilityResult {
  const reasons: string[] = [];
  const warnings: string[] = [];

  if (input.taxpayerType === "FIRM" && input.isLlp == null) {
    reasons.push("LLP status has not been confirmed.");
  } else if (input.taxpayerType === "FIRM" && input.isLlp) {
    reasons.push("LLPs cannot file ITR-4. Use ITR-3 or ITR-5 as applicable.");
  }
  if (!input.residentialStatus) {
    reasons.push("Residential status is required. TaxPilot will not assume Resident.");
  } else if (input.residentialStatus !== "RESIDENT") {
    reasons.push("ITR-4 is only for resident taxpayers. RNOR/NRI filers are routed to ITR-3.");
  }
  if (input.isDirector == null) {
    reasons.push("Director status has not been confirmed.");
  } else if (input.isDirector) {
    reasons.push("A company director cannot file ITR-4.");
  }
  if (input.totalIncome > ITR4_INCOME_CAP) {
    reasons.push("Total income exceeds ₹50 lakh, the ITR-4 ceiling.");
  }
  if (input.housePropertyCount > ITR4_HOUSE_PROPERTY_CAP) {
    reasons.push("ITR-4 allows income from at most two house properties for AY 2026-27.");
  }
  if (input.stcg > 0) {
    reasons.push("Short-term capital gains are not permitted in ITR-4.");
  }
  if (input.otherLtcg > 0) {
    reasons.push("Capital gains other than s.112A LTCG (within the ITR-4 cap) require ITR-3.");
  }
  if (input.ltcg112A > ITR4_112A_CAP) {
    reasons.push("Long-term capital gain u/s 112A exceeds ₹1.25 lakh.");
  }
  if (input.agriculturalIncome == null) {
    reasons.push("Agricultural income has not been confirmed.");
  } else if (input.agriculturalIncome > ITR4_AGRI_CAP) {
    reasons.push("Agricultural income above ₹5,000 is not permitted in ITR-4.");
  }
  if (input.lotteryOrRacehorse == null) {
    reasons.push("Lottery / racehorse income has not been confirmed.");
  } else if (input.lotteryOrRacehorse) {
    reasons.push("Lottery / racehorse income is not permitted in ITR-4.");
  }
  if (input.foreignAssets == null) {
    reasons.push("Foreign assets/income have not been confirmed.");
  } else if (input.foreignAssets) {
    reasons.push("Foreign assets/income cannot be reported in ITR-4.");
  }
  if (input.unlistedShares == null) {
    reasons.push("Unlisted equity shareholding has not been confirmed.");
  } else if (input.unlistedShares) {
    reasons.push("Holding unlisted equity shares is not permitted in ITR-4.");
  }
  if (input.fnoTrading == null) {
    reasons.push("F&O / speculative trading has not been confirmed.");
  } else if (input.fnoTrading) {
    reasons.push("F&O / speculative trading is reported in ITR-3, not ITR-4.");
  }
  if (input.detailedBooks) {
    reasons.push("Detailed books / P&L (non-presumptive) require ITR-3.");
  }
  if (input.sources.includes("BUSINESS") || input.sources.includes("FREELANCING")) {
    const digitalOk = cashWithinDigitalThreshold(input.businessCash, input.businessTurnover);
    const limit = digitalOk ? AD_TURNOVER_DIGITAL_LIMIT : AD_TURNOVER_CASH_LIMIT;
    if (input.businessTurnover > limit) {
      reasons.push(`Business turnover exceeds the s.44AD limit of ₹${(limit / 100_000).toFixed(0)} lakh.`);
    }
  }
  if (input.sources.includes("PROFESSION")) {
    const digitalOk = cashWithinDigitalThreshold(input.professionCash, input.professionReceipts);
    const limit = digitalOk ? ADA_RECEIPTS_DIGITAL_LIMIT : ADA_RECEIPTS_CASH_LIMIT;
    if (input.professionReceipts > limit) {
      reasons.push(`Professional receipts exceed the s.44ADA limit of ₹${(limit / 100_000).toFixed(0)} lakh.`);
    }
  }

  const hasBusinessLike =
    input.sources.includes("BUSINESS") ||
    input.sources.includes("PROFESSION") ||
    input.sources.includes("FREELANCING");
  if (!hasBusinessLike && !input.usesPresumptive) {
    warnings.push("ITR-4 is for presumptive business/profession. Salary-only filers typically use ITR-1, which is not in this product yet.");
  }

  const itr4Eligible = reasons.length === 0 && (input.taxpayerType === "INDIVIDUAL" || input.taxpayerType === "HUF" || (input.taxpayerType === "FIRM" && input.isLlp === false));
  if (itr4Eligible && hasBusinessLike) {
    return { recommended: "ITR-4", itr4Eligible: true, reasons, warnings };
  }
  if (itr4Eligible && !hasBusinessLike) {
    warnings.push("No presumptive business/profession selected. ITR-4 may still be used only if you have 44AD/44ADA/44AE income.");
    return { recommended: "ITR-4", itr4Eligible: true, reasons, warnings };
  }
  return { recommended: "ITR-3", itr4Eligible: false, reasons, warnings };
}

const DEFAULT_ELIGIBILITY: EligibilityResult = {
  recommended: "ITR-4",
  itr4Eligible: true,
  reasons: [],
  warnings: [],
};

export function parseEligibilityResult(raw: string | null | undefined): EligibilityResult {
  if (!raw) return { ...DEFAULT_ELIGIBILITY, reasons: [], warnings: [] };
  try {
    const parsed = JSON.parse(raw) as Partial<EligibilityResult> | null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ...DEFAULT_ELIGIBILITY, reasons: [], warnings: [] };
    }
    const recommended = parsed.recommended;
    return {
      recommended: recommended === "ITR-3" || recommended === "ITR-4" || recommended === "UNSUPPORTED" ? recommended : DEFAULT_ELIGIBILITY.recommended,
      itr4Eligible: typeof parsed.itr4Eligible === "boolean" ? parsed.itr4Eligible : DEFAULT_ELIGIBILITY.itr4Eligible,
      reasons: Array.isArray(parsed.reasons) ? parsed.reasons.filter((r) => typeof r === "string") : [],
      warnings: Array.isArray(parsed.warnings) ? parsed.warnings.filter((w) => typeof w === "string") : [],
    };
  } catch {
    return { ...DEFAULT_ELIGIBILITY, reasons: [], warnings: [] };
  }
}

