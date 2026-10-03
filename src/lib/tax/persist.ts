import { createHash } from "crypto";
import { prisma } from "@/lib/db";
import { loadNormalized } from "./load";
import { TaxEngine } from "./engine";
import { validateReturn } from "./validation";
import { determineItrType } from "@/lib/tax-rules/ay2026_27/eligibility";
import { json } from "@/lib/utils";
import { nextJsonFileStatuses } from "@/lib/json/lifecycle";
import { verifySchemaIntegrity } from "@/lib/itr-json/schemaIntegrity";
import { buildVersionSnapshot, recordReturnVersion } from "@/lib/versions";

export async function recomputeReturn(returnId: string) {
  const data = await loadNormalized(returnId);
  if (!data) return null;
  const ret = await prisma.taxReturn.findUnique({
    where: { id: returnId },
    include: { questions: true, answers: true, houseProperties: true, capitalGains: true, user: { include: { profile: true } } },
  });
  if (!ret) return null;
  const sourcesRaw = json<string[]>(ret.incomeSourcesJson, []);
  const sources = Array.isArray(sourcesRaw) ? sourcesRaw : [];
  const answerFor = (code: string) => {
    const q = ret.questions.find((qq) => qq.code === code);
    if (!q) return undefined;
    return ret.answers.find((a) => a.questionId === q.id)?.value;
  };
  const directorAnswer = answerFor("DIRECTOR");
  const presumptiveAnswer = answerFor("PRESUMPTIVE");
  const usesPresumptive =
    presumptiveAnswer !== "No" && data.business.section !== "BOOKS" && data.profession.section !== "BOOKS";
  const detailedBooks =
    data.business.section === "BOOKS" || data.profession.section === "BOOKS" || presumptiveAnswer === "No";
  const eligibility = determineItrType({
    taxpayerType: ret.taxpayerType as "INDIVIDUAL" | "HUF" | "FIRM",
    residentialStatus: (["RESIDENT", "RNOR", "NRI"].includes(ret.user.profile?.residentialStatus || "")
      ? (ret.user.profile!.residentialStatus as "RESIDENT" | "RNOR" | "NRI")
      : ""),
    isLlp: false,
    isDirector: directorAnswer === "Yes",
    sources,
    totalIncome: 0,
    housePropertyCount: ret.houseProperties.length,
    ltcg112A: ret.capitalGains.filter((g) => g.section === "112A").reduce((s, g) => s + g.amount, 0),
    stcg: ret.capitalGains.filter((g) => g.kind === "STCG").reduce((s, g) => s + g.amount, 0),
    otherLtcg: ret.capitalGains.filter((g) => g.section !== "112A").reduce((s, g) => s + g.amount, 0),
    agriculturalIncome: 0,
    lotteryOrRacehorse: sources.includes("LOTTERY"),
    foreignAssets: false,
    unlistedShares: false,
    businessTurnover: data.business.turnover,
    businessCash: data.business.cashReceipts,
    professionReceipts: data.profession.grossReceipts,
    professionCash: data.profession.cashReceipts,
    usesPresumptive,
    detailedBooks,
    fnoTrading: sources.includes("FNO"),
  });
  const calc = TaxEngine.calculate({
    ...data,
    itrType: eligibility.recommended === "UNSUPPORTED" ? "ITR-3" : eligibility.recommended,
  });
  const eligWithIncome = determineItrType({
    taxpayerType: ret.taxpayerType as "INDIVIDUAL" | "HUF" | "FIRM",
    residentialStatus: (["RESIDENT", "RNOR", "NRI"].includes(ret.user.profile?.residentialStatus || "")
      ? (ret.user.profile!.residentialStatus as "RESIDENT" | "RNOR" | "NRI")
      : ""),
    isLlp: false,
    isDirector: directorAnswer === "Yes",
    sources,
    totalIncome: calc.grossTotalIncomeIncLtcg,
    housePropertyCount: ret.houseProperties.length,
    ltcg112A: calc.capitalGains,
    stcg: ret.capitalGains.filter((g) => g.kind === "STCG").reduce((s, g) => s + g.amount, 0),
    otherLtcg: ret.capitalGains.filter((g) => g.section !== "112A").reduce((s, g) => s + g.amount, 0),
    agriculturalIncome: 0,
    lotteryOrRacehorse: false,
    foreignAssets: false,
    unlistedShares: false,
    businessTurnover: data.business.turnover,
    businessCash: data.business.cashReceipts,
    professionReceipts: data.profession.grossReceipts,
    professionCash: data.profession.cashReceipts,
    usesPresumptive,
    detailedBooks,
    fnoTrading: sources.includes("FNO"),
  });
  const issues = validateReturn(
    {
      ...data,
      itrType: eligWithIncome.recommended === "UNSUPPORTED" ? "ITR-3" : eligWithIncome.recommended,
    },
    returnId,
  ).issues;
  await prisma.validationError.deleteMany({ where: { returnId } });
  if (issues.length) {
    await prisma.validationError.createMany({
      data: issues.map((i) => ({
        returnId,
        level: String(i.level),
        severity: i.severity,
        section: i.section,
        field: i.field,
        message: i.message,
        suggestion: i.suggestion,
        code: i.code || i.id || "",
        href: i.href.includes("{id}") ? i.href.replace("{id}", returnId) : i.href,
      })),
    });
  }
  const docs = await prisma.document.count({ where: { returnId } });
  const banks = await prisma.bankAccount.count({ where: { returnId } });
  let completion = 15;
  if (ret.user.profile?.pan) completion += 15;
  if (ret.questions.filter((q) => q.status === "PENDING").length === 0 && ret.questions.length) completion += 15;
  if (calc.grossTotalIncome > 0) completion += 25;
  if (banks) completion += 15;
  if (docs) completion += 10;
  if (issues.filter((i) => i.severity === "ERROR").length === 0 && calc.grossTotalIncome > 0) completion += 5;
  completion = Math.min(100, completion);
  const itrType = eligWithIncome.recommended === "UNSUPPORTED" ? "ITR-3" : eligWithIncome.recommended;
  const facts = await prisma.taxFact.findMany({ where: { returnId } });
  const form16Tds = facts.find((f) => f.normalizedTaxField === "salary.tds" || f.field === "tds");
  const aisTds = facts.find((f) => f.normalizedTaxField === "tds.ais" || f.field === "ais.tds");
  if (
    form16Tds?.numericValue != null &&
    aisTds?.numericValue != null &&
    form16Tds.numericValue !== aisTds.numericValue &&
    (form16Tds.status === "CONFLICT" || aisTds.status === "CONFLICT")
  ) {
    issues.push({
      id: "TDS_RECONCILE",
      level: 2,
      severity: "ERROR",
      section: "TDS",
      field: "tds",
      message: "Form 16 TDS and AIS TDS do not match.",
      suggestion: "Resolve the document conflict before generating JSON.",
      href: `/returns/${returnId}/documents`,
    });
  }
  const openConflicts = await prisma.documentConflict.count({ where: { returnId, status: "OPEN" } });
  if (openConflicts > 0) {
    issues.push({
      id: "DOCUMENT_CONFLICT_OPEN",
      level: 2,
      severity: "ERROR",
      section: "Documents",
      field: "conflicts",
      message: "Unresolved document conflicts must be resolved before JSON generation.",
      suggestion: "Choose a source, enter a value, or ignore with a reason on the documents page.",
      href: `/returns/${returnId}/documents`,
    });
  }
  const hasError = issues.some((i) => i.severity === "ERROR");
  const fingerprint = createHash("sha256").update(JSON.stringify(data)).digest("hex");
  const life = nextJsonFileStatuses(ret.dataFingerprint || null, fingerprint);
  if (life.changed) {
    await prisma.iTRJsonFile.updateMany({ where: { returnId, status: "CURRENT" }, data: { status: "SUPERSEDED" } });
  }
  const integrity = verifySchemaIntegrity();
  let status = "IN_PROGRESS";
  if (!integrity.ok) status = "VALIDATION_FAILED";
  else if (hasError) status = "VALIDATION_FAILED";
  else if (completion >= 70) status = "READY_FOR_JSON";
  else if (issues.some((i) => i.severity === "WARNING")) status = "NEEDS_REVIEW";
  const updated = await prisma.taxReturn.update({
    where: { id: returnId },
    data: {
      itrType,
      completionPercentage: completion,
      estimatedTax: calc.totalTax,
      estimatedRefund: Math.max(0, calc.refundOrPayable),
      calculationJson: JSON.stringify(calc),
      eligibilityJson: JSON.stringify(eligWithIncome),
      dataFingerprint: fingerprint,
      schemaVersion: "Ver1.0",
      status,
    },
  });
  if ((ret.dataFingerprint || "") !== fingerprint) {
    await recordReturnVersion({
      returnId,
      userId: ret.userId,
      note: "Recalculated",
      snapshot: buildVersionSnapshot({
        assessmentYear: ret.assessmentYear,
        itrType,
        taxRegime: ret.taxRegime,
        status,
        estimatedTax: calc.totalTax,
        estimatedRefund: Math.max(0, calc.refundOrPayable),
        fingerprint,
        schemaVersion: "Ver1.0",
      }),
    });
  }
  return { updated, calc, eligibility: eligWithIncome, issues };
}
