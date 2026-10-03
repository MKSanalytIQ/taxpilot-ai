import { canEnterTaxModel, conflictGroup, GROUP_TO_TAX_FIELD } from "./mapping";
import { parseAmount } from "./rupees";

export type PrefillOrigin = "IMPORTED" | "USER_EDITED" | "USER_INPUT";

export type PrefillEntry = {
  origin: PrefillOrigin;
  source: string;
  sourceDocumentId: string;
  sourcePage: number | null;
  originalValue: string;
  currentValue: string;
  factId: string;
  sourceDocumentType?: string;
  sourceFactId?: string;
  verificationStatus?: string;
  originalSource?: string;
  editedAt?: string;
};

export type PreparationState = { fields: Record<string, PrefillEntry> };

export type AuthoritativeFact = {
  id: string;
  status: string;
  verified: boolean;
  normalizedTaxField: string;
  documentType: string;
  value: string;
  numericValue: number | null;
  sourceDocumentId: string;
  sourcePage: string;
};

export type SalaryModel = {
  grossSalary: number;
  tds: number;
  employerName: string;
  employerTan: string;
  exemptions: number;
  standardDeduction: number;
};

export type OtherIncomeModel = { amount: number; source: string };

export type BusinessModel = { digitalReceipts: number; turnover: number; section?: string };

export function emptyPreparation(): PreparationState {
  return { fields: {} };
}

export function parsePreparation(raw: string | null | undefined): PreparationState {
  if (!raw) return emptyPreparation();
  try {
    const parsed = JSON.parse(raw) as PreparationState;
    if (!parsed || typeof parsed !== "object" || !parsed.fields) return emptyPreparation();
    return { fields: parsed.fields };
  } catch {
    return emptyPreparation();
  }
}

export function pickAuthoritativeFacts(facts: AuthoritativeFact[], openGroups: Set<string>) {
  return facts.filter(
    (f) =>
      canEnterTaxModel(f.status, f.verified) &&
      Boolean(f.normalizedTaxField) &&
      !openGroups.has(conflictGroup(f.normalizedTaxField)),
  );
}

export function importedEntry(fact: AuthoritativeFact, currentValue?: string): PrefillEntry {
  const value = currentValue ?? fact.value;
  return {
    origin: "IMPORTED",
    source: fact.documentType || "DOCUMENT",
    sourceDocumentId: fact.sourceDocumentId,
    sourcePage: fact.sourcePage ? Number(fact.sourcePage) : null,
    originalValue: fact.value,
    currentValue: value,
    factId: fact.id,
    sourceDocumentType: fact.documentType || "DOCUMENT",
    sourceFactId: fact.id,
    verificationStatus: "VERIFIED",
    originalSource: "VERIFIED_IMPORT",
  };
}

export function classifyEdit(prev: PrefillEntry | undefined, nextValue: string): PrefillEntry {
  if (!prev) {
    return {
      origin: "USER_INPUT",
      source: "USER_INPUT",
      sourceDocumentId: "",
      sourcePage: null,
      originalValue: nextValue,
      currentValue: nextValue,
      factId: "",
    };
  }
  if (prev.origin === "IMPORTED" || prev.origin === "USER_EDITED") {
    const same = String(prev.originalValue) === String(nextValue);
    if (same) {
      return { ...prev, currentValue: nextValue, origin: "IMPORTED" };
    }
    return {
      ...prev,
      currentValue: nextValue,
      origin: "USER_EDITED",
      source: "USER_EDITED",
      originalSource: prev.originalSource || "VERIFIED_IMPORT",
      editedAt: new Date().toISOString(),
    };
  }
  return { ...prev, currentValue: nextValue, origin: "USER_INPUT", source: "USER_INPUT" };
}

export function resetToImported(entry: PrefillEntry, latestImported?: string): PrefillEntry {
  const value = latestImported ?? entry.originalValue;
  return {
    ...entry,
    originalValue: value,
    currentValue: value,
    origin: "IMPORTED",
    source: entry.sourceDocumentType || (entry.source === "USER_EDITED" ? "DOCUMENT" : entry.source),
    verificationStatus: entry.verificationStatus || "VERIFIED",
    originalSource: entry.originalSource || "VERIFIED_IMPORT",
  };
}

export function shouldOverwriteFromVerified(entry: PrefillEntry | undefined) {
  if (!entry) return true;
  return entry.origin === "IMPORTED";
}

function factForPath(facts: AuthoritativeFact[], path: string) {
  const group = conflictGroup(path);
  if (group && GROUP_TO_TAX_FIELD[group] === path) {
    const grouped = facts.filter((fact) => conflictGroup(fact.normalizedTaxField) === group);
    const amounts = new Set(grouped.map((fact) => fact.numericValue));
    if (amounts.size > 1) return undefined;
    return grouped[0] || facts.find((fact) => fact.normalizedTaxField === path);
  }
  return facts.find((fact) => fact.normalizedTaxField === path);
}

function heldByUser(entry: PrefillEntry | undefined) {
  return entry?.origin === "USER_EDITED" || entry?.origin === "USER_INPUT";
}

function pickNum(
  prep: PreparationState,
  path: string,
  imported: number | null | undefined,
  existing: number,
  openGroups: Set<string>,
  manuals: Map<string, number>,
) {
  const group = conflictGroup(path);
  if (group && openGroups.has(group)) return heldByUser(prep.fields[path]) ? existing : 0;
  if (heldByUser(prep.fields[path])) return existing;
  if (!shouldOverwriteFromVerified(prep.fields[path])) return existing;
  if (group && manuals.has(group)) return manuals.get(group)!;
  if (imported != null) return imported;
  if (prep.fields[path]?.origin === "IMPORTED") return 0;
  return existing;
}

function pickStr(
  prep: PreparationState,
  path: string,
  imported: string | undefined,
  existing: string,
  openGroups: Set<string>,
) {
  const group = conflictGroup(path);
  if (group && openGroups.has(group)) return heldByUser(prep.fields[path]) ? existing : "";
  if (heldByUser(prep.fields[path])) return existing;
  if (!shouldOverwriteFromVerified(prep.fields[path])) return existing;
  if (imported) return imported;
  if (prep.fields[path]?.origin === "IMPORTED") return "";
  return existing;
}

function releaseStaleImport(next: PreparationState, path: string, facts: AuthoritativeFact[], openGroups: Set<string>, manuals: Map<string, number>) {
  const entry = next.fields[path];
  if (!entry || entry.origin !== "IMPORTED") return;
  const group = conflictGroup(path);
  if (group && manuals.has(group)) return;
  if ((group && openGroups.has(group)) || !factForPath(facts, path)) delete next.fields[path];
}

function stampImported(next: PreparationState, facts: AuthoritativeFact[], path: string, value: string | number | null | undefined) {
  const fact = factForPath(facts, path);
  const entry = next.fields[path];
  if (entry && !shouldOverwriteFromVerified(entry)) {
    return;
  }
  if (!fact || value == null || value === "") return;
  next.fields[path] = importedEntry(fact, String(value));
}

/** Merge VERIFIED facts into preparation + tax-model values without touching TaxFacts. */
export function applyVerifiedFactsToState(input: {
  prep: PreparationState;
  facts: AuthoritativeFact[];
  openGroups: Set<string>;
  manuals?: Array<{ field: string; resolvedValue: string }>;
  existingSalary: SalaryModel | null;
  existingInterest: OtherIncomeModel | null;
  existingDividend: OtherIncomeModel | null;
  existingBusiness: BusinessModel | null;
  receiptTotal?: number;
  receiptDocumentId?: string;
}) {
  const facts = pickAuthoritativeFacts(input.facts, input.openGroups);
  const manuals = new Map<string, number>();
  for (const row of input.manuals || []) {
    const amount = parseAmount(row.resolvedValue);
    if (amount != null) manuals.set(row.field, amount);
  }
  const next: PreparationState = { fields: { ...input.prep.fields } };
  const salaryExisting = input.existingSalary;
  const salary: SalaryModel = {
    grossSalary: pickNum(next, "salary.grossSalary", factForPath(facts, "salary.grossSalary")?.numericValue, salaryExisting?.grossSalary ?? 0, input.openGroups, manuals),
    tds: pickNum(next, "salary.tds", factForPath(facts, "salary.tds")?.numericValue, salaryExisting?.tds ?? 0, input.openGroups, manuals),
    employerName: pickStr(next, "salary.employerName", factForPath(facts, "salary.employerName")?.value, salaryExisting?.employerName ?? "", input.openGroups),
    employerTan: pickStr(next, "salary.employerTan", factForPath(facts, "salary.employerTan")?.value, salaryExisting?.employerTan ?? "", input.openGroups),
    exemptions: pickNum(next, "salary.exemptions", factForPath(facts, "salary.exemptions")?.numericValue, salaryExisting?.exemptions ?? 0, input.openGroups, manuals),
    standardDeduction: pickNum(next, "salary.standardDeduction", factForPath(facts, "salary.standardDeduction")?.numericValue, salaryExisting?.standardDeduction ?? 0, input.openGroups, manuals),
  };
  const interestAmount = pickNum(next, "income.interest", factForPath(facts, "income.interest")?.numericValue, input.existingInterest?.amount ?? 0, input.openGroups, manuals);
  const dividendAmount = pickNum(next, "income.dividend", factForPath(facts, "income.dividend")?.numericValue, input.existingDividend?.amount ?? 0, input.openGroups, manuals);
  for (const path of ["salary.grossSalary", "salary.tds", "salary.employerName", "salary.employerTan", "salary.exemptions", "salary.standardDeduction", "income.interest", "income.dividend"]) {
    releaseStaleImport(next, path, facts, input.openGroups, manuals);
  }
  stampImported(next, facts, "salary.grossSalary", salary.grossSalary || null);
  stampImported(next, facts, "salary.tds", salary.tds || null);
  stampImported(next, facts, "salary.employerName", salary.employerName || null);
  stampImported(next, facts, "salary.employerTan", salary.employerTan || null);
  stampImported(next, facts, "salary.exemptions", salary.exemptions || null);
  stampImported(next, facts, "salary.standardDeduction", salary.standardDeduction || null);

  stampImported(next, facts, "income.interest", interestAmount || null);
  stampImported(next, facts, "income.dividend", dividendAmount || null);

  const interest =
    input.existingInterest || interestAmount > 0
      ? { amount: interestAmount, source: input.existingInterest?.source || "AIS (verified)" }
      : null;
  const dividend =
    input.existingDividend || dividendAmount > 0
      ? { amount: dividendAmount, source: input.existingDividend?.source || "AIS (verified)" }
      : null;

  const receiptTotal = input.receiptTotal || 0;
  let business = input.existingBusiness;
  if (receiptTotal > 0 && shouldOverwriteFromVerified(next.fields["business.receipts"])) {
    business = {
      digitalReceipts: receiptTotal,
      turnover: input.existingBusiness?.turnover || receiptTotal,
      section: input.existingBusiness?.section || "44AD",
    };
    next.fields["business.receipts"] = {
      origin: "IMPORTED",
      source: "BANK_STATEMENT",
      sourceDocumentId: input.receiptDocumentId || "",
      sourcePage: null,
      originalValue: String(receiptTotal),
      currentValue: String(receiptTotal),
      factId: "",
      sourceDocumentType: "BANK_STATEMENT",
      verificationStatus: "VERIFIED",
      originalSource: "VERIFIED_IMPORT",
    };
  }

  return {
    prep: next,
    salary: (Boolean(salaryExisting) || salary.grossSalary || salary.tds || salary.employerName || salary.employerTan || salary.exemptions || salary.standardDeduction) ? salary : null,
    interest,
    dividend,
    business,
  };
}

export type SectionStatus = "COMPLETE" | "NEEDS REVIEW" | "MISSING" | "CONFLICT";

export function sectionStatus(opts: {
  openConflicts: number;
  needsReviewFacts: number;
  missingRequired: boolean;
}): SectionStatus {
  if (opts.openConflicts > 0) return "CONFLICT";
  if (opts.needsReviewFacts > 0) return "NEEDS REVIEW";
  if (opts.missingRequired) return "MISSING";
  return "COMPLETE";
}

export function importSummary(opts: {
  processedDocuments: number;
  verifiedFacts: number;
  needsReviewFacts: number;
  openConflicts: number;
  importedValues: number;
}) {
  return {
    documents: opts.processedDocuments,
    verifiedFacts: opts.verifiedFacts,
    needsReview: opts.needsReviewFacts,
    conflicts: opts.openConflicts,
    importedValues: opts.importedValues,
  };
}

export function overviewFromRecords(id: string, input: {
  documents: Array<{ status: string; processedAt?: Date | null }>;
  facts: Array<{ status: string; verified: boolean; normalizedTaxField: string }>;
  openConflicts: Array<{ field: string }>;
  prep: PreparationState;
  hasPan: boolean;
  salarySources: boolean;
  hasSalary: boolean;
  businessSources: boolean;
  hasBusiness: boolean;
  hasBank: boolean;
  validationErrors: number;
}) {
  const processedDocuments = input.documents.filter((d) => d.processedAt || !["UPLOADED", "PROCESSING"].includes(d.status)).length;
  const verifiedFacts = input.facts.filter((f) => f.status === "VERIFIED" && f.verified).length;
  const needsReviewFacts = input.facts.filter((f) => ["AI_EXTRACTED", "PENDING", "CONFLICT"].includes(f.status)).length;
  const openConflicts = input.openConflicts.length;
  const importedValues = Object.values(input.prep.fields).filter((e) => e.origin === "IMPORTED" || e.origin === "USER_EDITED").length;
  const groupOpen = (g: string) => input.openConflicts.filter((c) => c.field === g).length;
  const pending = (prefix: string) =>
    input.facts.filter((f) => f.normalizedTaxField.startsWith(prefix) && ["AI_EXTRACTED", "PENDING", "CONFLICT"].includes(f.status)).length;
  const sections = [
    { label: "Personal", href: `/returns/${id}/profile`, status: sectionStatus({ openConflicts: 0, needsReviewFacts: 0, missingRequired: !input.hasPan }) },
    { label: "Salary", href: `/returns/${id}/income`, status: sectionStatus({ openConflicts: groupOpen("SALARY"), needsReviewFacts: pending("salary."), missingRequired: input.salarySources && !input.hasSalary }) },
    { label: "Other sources", href: `/returns/${id}/income`, status: sectionStatus({ openConflicts: groupOpen("INTEREST") + groupOpen("DIVIDEND"), needsReviewFacts: pending("income."), missingRequired: false }) },
    { label: "Deductions", href: `/returns/${id}/deductions`, status: sectionStatus({ openConflicts: 0, needsReviewFacts: pending("deductions."), missingRequired: false }) },
    { label: "Business/Profession", href: `/returns/${id}/income`, status: sectionStatus({ openConflicts: 0, needsReviewFacts: 0, missingRequired: input.businessSources && !input.hasBusiness }) },
    { label: "TDS", href: `/returns/${id}/tds`, status: sectionStatus({ openConflicts: groupOpen("TDS"), needsReviewFacts: pending("salary.tds") + pending("tds."), missingRequired: false }) },
    { label: "Review", href: `/returns/${id}/review`, status: sectionStatus({ openConflicts, needsReviewFacts: input.validationErrors, missingRequired: !input.hasBank }) },
  ];
  return { summary: importSummary({ processedDocuments, verifiedFacts, needsReviewFacts, openConflicts, importedValues }), sections, imports: documentSectionSummary(input.prep) };
}

export type SimpleDocStatus = "PROCESSING" | "VERIFIED" | "NEEDS REVIEW" | "CONFLICT" | "FAILED";

export function simpleDocumentStatus(input: {
  status: string;
  errorCode?: string | null;
  factStatuses?: string[];
}): SimpleDocStatus {
  if (input.status === "FAILED" || input.errorCode === "EXTRACTION_FAILED") return "FAILED";
  if (input.status === "PROCESSING" || input.status === "UPLOADED") return "PROCESSING";
  if (input.status === "CONFLICT" || input.factStatuses?.includes("CONFLICT")) return "CONFLICT";
  if (input.status === "VERIFIED" || input.status === "CONFIRMED") return "VERIFIED";
  return "NEEDS REVIEW";
}

export const PROCESSABLE_DOCUMENT_TYPES = ["FORM_16", "AIS", "TIS", "BANK_STATEMENT"] as const;

export function processableDocumentLabel(kind: string) {
  if (kind === "FORM_16") return "Form 16";
  if (kind === "BANK_STATEMENT") return "Bank statement";
  return kind.replaceAll("_", " ");
}

export function documentStatusView(input: {
  status: string;
  errorCode?: string | null;
  factStatuses?: string[];
}): { label: string; prefix: string; tone: "ok" | "warn" | "err" } {
  const simple = simpleDocumentStatus(input);
  if (simple === "FAILED") return { label: "FAILED", prefix: "✕", tone: "err" };
  if (simple === "PROCESSING") return { label: "PROCESSING", prefix: "", tone: "warn" };
  if (simple === "CONFLICT") return { label: "CONFLICT", prefix: "⚠", tone: "err" };
  if (simple === "VERIFIED") return { label: "VERIFIED", prefix: "✓", tone: "ok" };
  if (input.status === "EXTRACTED") return { label: "EXTRACTED", prefix: "✓", tone: "ok" };
  return { label: "NEEDS REVIEW", prefix: "⚠", tone: "warn" };
}

export function uploadErrorMessage(code?: string | null) {
  const key = String(code || "").toLowerCase();
  if (!key) return "";
  if (key === "file") return "Please choose a file to upload.";
  if (key === "invalid_type") return "This file type is not supported. Use PDF, JPEG, PNG, CSV, TXT, or XLSX.";
  if (key === "empty") return "This file is empty and cannot be processed.";
  if (key === "oversize") return "This file is too large. Maximum size is 12 MB.";
  return "Upload was rejected. Check the file and try again.";
}

const FACT_LABELS: Record<string, string> = {
  grossSalary: "Salary",
  "salary.grossSalary": "Salary",
  "income.salary.ais": "Salary",
  tds: "TDS",
  "salary.tds": "TDS",
  "tds.ais": "TDS",
  "tds.tis": "TDS",
  employerName: "Employer information",
  employerTan: "Employer information",
  "salary.employerName": "Employer information",
  "salary.employerTan": "Employer information",
  interest: "Interest",
  "income.interest": "Interest",
  dividend: "Dividend",
  "income.dividend": "Dividend",
  exemptAllowances: "Salary",
};

export function extractedFactLabels(fields: Array<{ field?: string; normalizedTaxField?: string; value?: string | null }>) {
  const labels: string[] = [];
  for (const f of fields) {
    if (!f.value) continue;
    const key = f.normalizedTaxField || f.field || "";
    const label = FACT_LABELS[key] || FACT_LABELS[key.split(".").pop() || ""];
    if (label && !labels.includes(label)) labels.push(label);
  }
  return labels;
}

function prettyDocSource(raw: string) {
  if (raw === "FORM_16") return "Form 16";
  if (raw === "BANK_STATEMENT") return "Bank statement";
  if (raw === "USER_INPUT" || raw === "USER_EDITED") return "Manual entry";
  return raw.replaceAll("_", " ");
}

export function documentSectionSummary(prep: PreparationState): Array<{ source: string; items: string[] }> {
  const groups = new Map<string, string[]>();
  const add = (raw: string | undefined, item: string) => {
    if (!raw || raw === "USER_INPUT" || raw === "USER_EDITED") return;
    const source = prettyDocSource(raw);
    const items = groups.get(source) || [];
    if (!items.includes(item)) items.push(item);
    groups.set(source, items);
  };
  const imported = (entry?: PrefillEntry) => entry && (entry.origin === "IMPORTED" || entry.origin === "USER_EDITED");
  const src = (entry?: PrefillEntry) => entry?.sourceDocumentType || entry?.source;
  if (imported(prep.fields["salary.grossSalary"])) add(src(prep.fields["salary.grossSalary"]), "Salary imported");
  if (imported(prep.fields["income.interest"])) add(src(prep.fields["income.interest"]), "Interest imported");
  if (imported(prep.fields["income.dividend"])) add(src(prep.fields["income.dividend"]), "Dividend imported");
  if (imported(prep.fields["salary.tds"])) add(src(prep.fields["salary.tds"]), "TDS imported");
  if (imported(prep.fields["business.receipts"])) add(src(prep.fields["business.receipts"]), "Business imported");
  return [...groups.entries()].map(([source, items]) => ({ source, items }));
}
