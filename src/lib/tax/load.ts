import { prisma } from "@/lib/db";
import { json } from "@/lib/utils";
import { confirmationsFromAnswers } from "./confirmations";
import type { NormalizedReturn } from "./model";

export async function loadNormalized(returnId: string, userId?: string): Promise<NormalizedReturn | null> {
  const ret = await prisma.taxReturn.findFirst({
    where: { id: returnId, ...(userId ? { userId } : {}) },
    include: {
      salary: true,
      business: true,
      professional: true,
      capitalGains: true,
      houseProperties: true,
      otherIncomes: true,
      deductions: true,
      tdsEntries: true,
      taxPayments: true,
      bankAccounts: true,
      profitLoss: true,
      questions: { include: { answers: true } },
      user: { include: { profile: true } },
    },
  });
  if (!ret) return null;
  const salary = ret.salary[0];
  const biz = ret.business[0];
  const prof = ret.professional[0];
  const pl = ret.profitLoss;
  const booksFromPl = Boolean(pl && (pl.revenue || pl.netProfit));
  const answers: Record<string, string | undefined> = {};
  for (const question of ret.questions) {
    const latest = [...question.answers].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).at(-1);
    if (latest?.value) answers[question.code] = latest.value;
  }
  const incomeSources = json<string[]>(ret.incomeSourcesJson, []);
  return {
    assessmentYear: ret.assessmentYear,
    itrType: (ret.itrType as NormalizedReturn["itrType"]) || "UNDETERMINED",
    taxpayerType: ret.taxpayerType as NormalizedReturn["taxpayerType"],
    residentialStatus: (["RESIDENT", "RNOR", "NRI"].includes(ret.user.profile?.residentialStatus || "")
      ? (ret.user.profile!.residentialStatus as NormalizedReturn["residentialStatus"])
      : ""),
    pan: ret.user.profile?.pan || "",
    name: ret.user.name,
    fatherName: ret.user.profile?.fatherName || "",
    email: ret.user.email,
    phone: ret.user.profile?.phone || "",
    dateOfBirth: ret.user.profile?.dateOfBirth?.toISOString().slice(0, 10),
    addressLine1: ret.user.profile?.addressLine1 || "",
    locality: ret.user.profile?.addressLine2 || "",
    city: ret.user.profile?.city || "",
    state: ret.user.profile?.state || "",
    pincode: ret.user.profile?.pincode || "",
    verificationPlace: ret.verificationPlace || ret.user.profile?.city || "",
    regime: ret.taxRegime === "OLD" ? "OLD" : "NEW",
    salary: {
      gross: salary?.grossSalary || 0,
      exemptions: salary?.exemptions || 0,
      tds: salary?.tds || 0,
      employerName: salary?.employerName || "",
      employerTan: salary?.employerTan || "",
    },
    business: {
      section: booksFromPl ? "BOOKS" : (biz?.section as "44AD" | "44AE" | "BOOKS") || "44AD",
      turnover: booksFromPl ? pl!.revenue : biz?.turnover || 0,
      digitalReceipts: biz?.digitalReceipts || 0,
      cashReceipts: biz?.cashReceipts || 0,
      declaredIncome: booksFromPl ? pl!.netProfit : biz?.declaredIncome || 0,
      nature: biz?.nature || "",
      natureCode: biz?.natureCode || undefined,
    },
    profession: {
      section: (prof?.section as "44ADA" | "BOOKS") || "44ADA",
      grossReceipts: prof?.grossReceipts || 0,
      cashReceipts: prof?.cashReceipts || 0,
      declaredIncome: prof?.declaredIncome || 0,
      profession: prof?.profession || "",
      natureCode: prof?.natureCode || undefined,
    },
    houseProperties: ret.houseProperties.map((h) => ({
      occupancy: h.occupancy as "SELF_OCCUPIED" | "LET_OUT",
      annualLetableValue: h.annualLetableValue,
      municipalTaxes: h.municipalTaxes,
      interestOnLoan: h.interestOnLoan,
    })),
    otherIncome: ret.otherIncomes.map((o) => ({ kind: o.kind, amount: o.amount, source: o.source })),
    capitalGains: ret.capitalGains.map((g) => ({
      kind: g.kind,
      section: g.section,
      amount: g.amount,
      assetType: g.assetType,
      identifier: g.identifier,
      acquisitionDate: g.acquisitionDate?.toISOString().slice(0, 10),
      saleDate: g.saleDate?.toISOString().slice(0, 10),
      saleConsideration: g.saleConsideration,
      acquisitionCost: g.acquisitionCost,
      improvementCost: g.improvementCost,
      transferExpenses: g.transferExpenses,
      holdingPeriodDays: g.holdingPeriodDays,
      specialRate: g.specialRate ?? undefined,
    })),
    deductions: ret.deductions.map((d) => {
      let extra: { beneficiary?: "SELF_FAMILY" | "PARENTS"; kind?: "PREMIUM" | "PREVENTIVE" | "MEDICAL"; senior?: boolean } = {};
      if (d.notes) {
        try {
          extra = JSON.parse(d.notes) as typeof extra;
        } catch {
          extra = {};
        }
      }
      return { section: d.section, amount: d.amount, ...extra };
    }),
    tds: ret.tdsEntries.map((t) => ({
      sectionCode: t.sectionCode,
      tan: t.tan,
      amount: t.amount,
      deductorName: t.deductorName,
      grossAmount: t.grossAmount,
      kind: t.kind,
    })),
    taxPayments: ret.taxPayments.map((p) => ({
      kind: p.kind as "ADVANCE" | "SELF_ASSESSMENT" | "REGULAR",
      amount: p.amount,
      paidOn: p.paidOn ? p.paidOn.toISOString().slice(0, 10) : undefined,
    })),
    bankAccounts: ret.bankAccounts.map((b) => ({
      ifsc: b.ifsc,
      accountNumber: b.accountNumber,
      isPrimary: b.isPrimary,
      bankName: b.bankName,
      accountType: b.accountType,
    })),
    incomeSources,
    eligibilityConfirmed: confirmationsFromAnswers(answers),
  };
}

export function sourcesOf(ret: { incomeSourcesJson: string }) {
  return json<string[]>(ret.incomeSourcesJson, []);
}
