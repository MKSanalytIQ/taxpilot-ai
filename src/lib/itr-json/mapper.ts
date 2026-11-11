import { createHash } from "crypto";
import type { NormalizedReturn } from "@/lib/tax/model";
import { OFFICIAL_SCHEMA_VER } from "@/lib/itr-json/ay2026_27/itr4/mapper";
import { evaluateFilingGate } from "@/lib/validation/filingGate";
import type { TaxComputation } from "@/lib/tax/engine";
import { TaxEngine } from "@/lib/tax/engine";
import { loadNormalized } from "@/lib/tax/load";
import { openConflictCount } from "@/lib/documents/conflicts";
import { INTEGRITY_FAIL_MESSAGE, ITR3_INTEGRITY_FAIL_MESSAGE } from "@/lib/itr-json/schemaIntegrity";

export const SCHEMA_VERSION = OFFICIAL_SCHEMA_VER;

export type GeneratedItr = {
  json: unknown;
  digest: string;
  calc: TaxComputation;
  schemaVersion: string;
  valid: boolean;
  errors: Array<{
    severity: string;
    message: string;
    field?: string;
    path?: string;
    explanation?: string;
    fixRoute?: string;
    code?: string;
    section?: string;
  }>;
  warnings: Array<{ severity: string; message: string; field?: string; code?: string; section?: string }>;
  official: ReturnType<typeof evaluateFilingGate>["official"];
  blocked: boolean;
  layers: ReturnType<typeof evaluateFilingGate>["layers"];
};

export function generateITRJson(
  data: NormalizedReturn,
  opts?: { generatedAt?: Date; returnId?: string; openDocumentConflicts?: number },
): GeneratedItr {
  const calc = TaxEngine.calculate(data);
  const openDocumentConflicts = opts?.openDocumentConflicts ?? 0;
  const gate = evaluateFilingGate(data, opts?.returnId, opts?.generatedAt, openDocumentConflicts);
  const errors: GeneratedItr["errors"] = [];
  if (openDocumentConflicts > 0) {
    errors.push({
      severity: "ERROR",
      code: "DOCUMENT_CONFLICT_OPEN",
      message: "Unresolved document conflicts must be resolved before JSON generation.",
      field: "DOCUMENT_CONFLICT_OPEN",
      section: "Conflicts",
    });
  }
  if (gate.itr3Blocked) {
    errors.push({
      severity: "ERROR",
      code: "ITR3_JSON_DISABLED",
      message: "ITR-3 JSON download is not enabled for this deployment. ITR-4 remains the filing path.",
      field: "ITR3_JSON_DISABLED",
      section: "Unsupported scenario",
    });
  }
  if (!gate.integrity.ok) {
    errors.push({
      severity: "ERROR",
      code: "OFFICIAL_SCHEMA_INTEGRITY_FAILURE",
      message: data.itrType === "ITR-3" ? ITR3_INTEGRITY_FAIL_MESSAGE : INTEGRITY_FAIL_MESSAGE,
      field: "OFFICIAL_SCHEMA_INTEGRITY_FAILURE",
      section: "Schema",
    });
  }
  for (const c of gate.completeness) {
    errors.push({
      severity: c.severity,
      code: c.code || c.id,
      message: c.message,
      field: c.field,
      section: c.section,
      explanation: c.explanation,
      fixRoute: c.fixRoute,
    });
  }
  for (const u of gate.unsupported) {
    errors.push({ severity: u.severity, code: u.code, message: u.message, field: u.code, fixRoute: u.fixRoute, section: "Unsupported scenario" });
  }
  for (const b of gate.business.filter((x) => x.severity === "ERROR")) {
    errors.push({
      severity: b.severity,
      code: b.code || b.id,
      message: b.message,
      field: b.field,
      section: b.section,
      explanation: b.explanation,
      fixRoute: b.fixRoute,
    });
  }
  for (const m of gate.mappingIssues) {
    errors.push({
      severity: "ERROR",
      code: "ITR3_REQUIRED_FIELD_MISSING",
      message: m.message,
      field: m.field,
      section: m.section,
    });
  }
  for (const e of gate.official.errors) {
    if (gate.mappingIssues.some((m) => m.field === e.field && m.message === e.message)) continue;
    errors.push({
      severity: "ERROR",
      code: "OFFICIAL_SCHEMA_VALIDATION_FAILURE",
      message: e.explanation,
      field: e.field,
      path: e.path,
      explanation: e.message,
      section: "Official JSON schema",
    });
  }
  const warnings = gate.business
    .filter((b) => b.severity !== "ERROR")
    .map((b) => ({ severity: b.severity, message: b.message, field: b.field, code: b.code || b.id, section: b.section }));
  const digest = gate.json ? createHash("sha256").update(JSON.stringify(gate.json)).digest("hex") : "";
  return {
    json: gate.ready ? gate.json : null,
    digest,
    calc: gate.calc || calc,
    schemaVersion: gate.official.schemaVersion || SCHEMA_VERSION,
    valid: gate.ready,
    blocked: !gate.ready,
    errors,
    warnings,
    official: gate.official,
    layers: gate.layers,
  };
}

export function mapToOfficialJson(data: NormalizedReturn) {
  const gate = evaluateFilingGate(data, undefined, undefined);
  return { json: gate.json, calc: gate.calc };
}

export type JsonGenerationGate = {
  allowed: boolean;
  data: NormalizedReturn | null;
  result: GeneratedItr | null;
  error: "empty" | "itr3" | "blocked" | null;
};

/** Authoritative server-side decision for whether ITR JSON may be generated. */
export async function canGenerateItrJson(
  returnId: string,
  opts?: { generatedAt?: Date; ownerUserId?: string },
): Promise<JsonGenerationGate> {
  const data = await loadNormalized(returnId, opts?.ownerUserId);
  if (!data) return { allowed: false, data: null, result: null, error: "empty" };
  if (data.itrType !== "ITR-4" && data.itrType !== "ITR-3") return { allowed: false, data, result: null, error: "itr3" };
  const openDocumentConflicts = await openConflictCount(returnId);
  const result = generateITRJson(data, {
    returnId,
    generatedAt: opts?.generatedAt,
    openDocumentConflicts,
  });
  if (!result.valid || !result.json) return { allowed: false, data, result, error: "blocked" };
  return { allowed: true, data, result, error: null };
}
