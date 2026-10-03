"use server";

import { redirect, unstable_rethrow } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { createSession, clearSession, getSession, hashPassword, verifyPassword, canAccessReturn } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { audit } from "@/lib/audit";
import { seedInterview } from "@/lib/interview";
import { recomputeReturn } from "@/lib/tax/persist";
import { canGenerateItrJson } from "@/lib/itr-json/mapper";
import { getStorage, newStorageKey } from "@/lib/providers/storage";
import { documentSha256, persistExtraction } from "@/lib/documents/persistExtraction";
import { isAllowedUpload, sniffMime } from "@/lib/documents/magic";
import { applyVerifiedFactsToTaxModel } from "@/lib/documents/applyVerified";
import { classifyEdit, parsePreparation, resetToImported } from "@/lib/documents/prefill";
import { applyConflictResolution, rebuildDocumentConflicts } from "@/lib/documents/conflicts";
import { DOCUMENT_TYPES } from "@/lib/documents/types";
import { canAccessConflict, canAccessTaxFact } from "@/lib/authz";
import { reviewFactStatus } from "@/lib/documents/mapping";
import { parseAmount } from "@/lib/documents/rupees";
import { mkdir, writeFile } from "fs/promises";
import path from "path";

function n(v: string | undefined) {
  const x = Number(v);
  return Number.isFinite(x) ? Math.round(x) : 0;
}

function rethrowControl(error: unknown) {
  unstable_rethrow(error);
  if (error && typeof error === "object" && "digest" in error && String((error as { digest?: string }).digest).startsWith("NEXT_REDIRECT")) {
    throw error;
  }
}

export async function signupAction(formData: FormData) {
  const email = String(formData.get("email") || "").toLowerCase().trim();
  const password = String(formData.get("password") || "");
  const name = String(formData.get("name") || "").trim();
  if (!rateLimit(`signup:${email}`, 8, 600_000).ok) redirect("/signup?error=rate");
  if (!email.includes("@") || password.length < 8 || !name) redirect("/signup?error=invalid");
  try {
    if (await prisma.user.findUnique({ where: { email } })) redirect("/signup?error=exists");
    const user = await prisma.user.create({
      data: {
        email,
        name,
        passwordHash: await hashPassword(password),
      },
    });
    await Promise.allSettled([
      prisma.profile.create({ data: { userId: user.id } }),
      prisma.subscription.create({ data: { userId: user.id, plan: "FREE" } }),
      audit({ userId: user.id, action: "signup", entity: "User", entityId: user.id }),
    ]);
    await createSession(user.id);
  } catch (error) {
    rethrowControl(error);
    console.error("signup failed", error);
    redirect("/signup?error=db");
  }
  redirect("/dashboard");
}

export async function loginAction(formData: FormData) {
  const email = String(formData.get("email") || "").toLowerCase().trim();
  const password = String(formData.get("password") || "");
  if (!rateLimit(`login:${email}`, 10, 600_000).ok) redirect("/login?error=rate");
  let role = "USER";
  try {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !(await verifyPassword(password, user.passwordHash))) redirect("/login?error=invalid");
    role = user.role;
    await createSession(user.id);
    await audit({ userId: user.id, action: "login", entity: "User", entityId: user.id }).catch((error) => {
      console.error("login audit failed", error);
    });
  } catch (error) {
    rethrowControl(error);
    console.error("login failed", error);
    redirect("/login?error=db");
  }
  redirect(role === "ADMIN" ? "/admin" : "/dashboard");
}

export async function logoutAction() {
  await clearSession();
  redirect("/");
}

export async function createReturnAction(formData: FormData) {
  const session = await getSession();
  if (!session) redirect("/login");
  const assessmentYear = String(formData.get("assessmentYear") || "2026-27");
  const taxpayerType = String(formData.get("taxpayerType") || "INDIVIDUAL");
  const sources = formData.getAll("sources").map(String);
  const ret = await prisma.taxReturn.create({
    data: {
      userId: session.userId,
      assessmentYear,
      taxpayerType,
      incomeSourcesJson: JSON.stringify(sources),
      incomeSources: { create: sources.map((kind) => ({ kind, selected: true })) },
    },
  });
  try {
    await seedInterview(ret.id, sources);
    await audit({ userId: session.userId, returnId: ret.id, action: "return.created", entity: "TaxReturn", entityId: ret.id });
    await recomputeReturn(ret.id);
  } catch (error) {
    rethrowControl(error);
    console.error("create return follow-up failed", error);
  }
  redirect(`/returns/${ret.id}/interview`);
}

export async function answerQuestionAction(formData: FormData) {
  const session = await getSession();
  if (!session) return;
  const questionId = String(formData.get("questionId") || "");
  const value = String(formData.get("value") || "");
  const q = await prisma.question.findUnique({ where: { id: questionId } });
  if (!q) return;
  const ret = await prisma.taxReturn.findFirst({ where: { id: q.returnId, userId: session.userId } });
  if (!ret) return;
  await prisma.answer.create({ data: { returnId: ret.id, questionId, value } });
  await prisma.question.update({ where: { id: questionId }, data: { status: "ANSWERED" } });
  if (q.code === "DIRECTOR" && value === "Yes") {
    await prisma.taxReturn.update({ where: { id: ret.id }, data: { itrType: "ITR-3" } });
  }
  if (q.code === "PRESUMPTIVE" && value === "No") {
    await prisma.taxReturn.update({ where: { id: ret.id }, data: { itrType: "ITR-3" } });
    const existingBiz = await prisma.businessIncome.findFirst({ where: { returnId: ret.id } });
    if (existingBiz) {
      await prisma.businessIncome.update({ where: { id: existingBiz.id }, data: { section: "BOOKS" } });
    } else {
      await prisma.businessIncome.create({ data: { returnId: ret.id, section: "BOOKS" } });
    }
  }
  await recomputeReturn(ret.id);
  revalidatePath(`/returns/${ret.id}/interview`);
}

export async function saveProfileAction(formData: FormData) {
  const session = await getSession();
  if (!session) redirect("/login");
  const id = String(formData.get("returnId") || "");
  const ret = await prisma.taxReturn.findFirst({ where: { id, userId: session.userId } });
  if (!ret) redirect("/dashboard");
  const pan = String(formData.get("pan") || "").toUpperCase().trim();
  const profileData = {
    pan,
    fatherName: String(formData.get("fatherName") || "").trim(),
    phone: String(formData.get("phone") || "").trim(),
    addressLine1: String(formData.get("address") || "").trim(),
    addressLine2: String(formData.get("locality") || "").trim(),
    city: String(formData.get("city") || "").trim(),
    state: String(formData.get("state") || "").trim(),
    pincode: String(formData.get("pincode") || "").trim(),
    residentialStatus: String(formData.get("residentialStatus") || "").trim(),
    dateOfBirth: formData.get("dateOfBirth") ? new Date(String(formData.get("dateOfBirth"))) : undefined,
  };
  await prisma.profile.upsert({
    where: { userId: session.userId },
    update: profileData,
    create: { userId: session.userId, ...profileData },
  });
  await prisma.user.update({ where: { id: session.userId }, data: { name: String(formData.get("name") || session.name) } });
  await recomputeReturn(id);
  revalidatePath(`/returns/${id}/profile`);
  redirect(`/returns/${id}/income`);
}

export async function saveIncomeAction(formData: FormData) {
  const session = await getSession();
  if (!session) redirect("/login");
  const id = String(formData.get("returnId") || "");
  const ret = await prisma.taxReturn.findFirst({ where: { id, userId: session.userId } });
  if (!ret) redirect("/dashboard");
  const existingSalary = await prisma.salaryIncome.findFirst({ where: { returnId: id } });
  const prep = parsePreparation(ret.preparationJson);
  const track = (formKey: string, path: string) => {
    if (!formData.has(formKey)) return;
    const raw = String(formData.get(formKey) || "");
    if (!prep.fields[path] && raw.trim() === "") return;
    prep.fields[path] = classifyEdit(prep.fields[path], raw);
  };
  track("grossSalary", "salary.grossSalary");
  track("salaryTds", "salary.tds");
  track("employerName", "salary.employerName");
  track("employerTan", "salary.employerTan");
  track("interest", "income.interest");
  track("dividend", "income.dividend");
  track("digitalReceipts", "business.receipts");

  if (formData.has("grossSalary") || formData.has("employerName")) {
    const data = {
      employerName: String(formData.get("employerName") || ""),
      employerTan: String(formData.get("employerTan") || "").toUpperCase(),
      grossSalary: n(String(formData.get("grossSalary"))),
      tds: n(String(formData.get("salaryTds"))),
      exemptions: existingSalary?.exemptions ?? 0,
      standardDeduction: existingSalary?.standardDeduction ?? 0,
    };
    if (existingSalary) {
      await prisma.salaryIncome.update({ where: { id: existingSalary.id }, data });
    } else if (data.grossSalary || data.tds || data.employerName) {
      await prisma.salaryIncome.create({ data: { returnId: id, ...data } });
    }
  }

  if (formData.has("turnover") || formData.has("digitalReceipts")) {
    const existingBiz = await prisma.businessIncome.findFirst({ where: { returnId: id } });
    const digital = n(String(formData.get("digitalReceipts")));
    const cash = n(String(formData.get("cashReceipts")));
    const turnover = n(String(formData.get("turnover"))) || digital + cash;
    const books = existingBiz?.section === "BOOKS";
    const data = {
      section: (books ? "BOOKS" : "44AD") as "BOOKS" | "44AD",
      nature: String(formData.get("nature") || "").trim(),
      natureCode: String(formData.get("natureCode") || "").trim(),
      turnover,
      digitalReceipts: digital,
      cashReceipts: cash,
      declaredIncome: n(String(formData.get("declaredBusiness"))),
    };
    if (existingBiz) {
      await prisma.businessIncome.update({ where: { id: existingBiz.id }, data });
    } else if (turnover || digital) {
      await prisma.businessIncome.create({ data: { returnId: id, ...data } });
    }
  }

  if (formData.has("plRevenue") || formData.has("plNetProfit")) {
    const revenue = n(String(formData.get("plRevenue")));
    const plOther = n(String(formData.get("plOtherIncome")));
    const purchases = n(String(formData.get("plPurchases")));
    const employeeCost = n(String(formData.get("plEmployeeCost")));
    const depreciation = n(String(formData.get("plDepreciation")));
    const otherExpenses = n(String(formData.get("plOtherExpenses")));
    const netRaw = String(formData.get("plNetProfit") || "").trim();
    const computed = revenue + plOther - purchases - employeeCost - depreciation - otherExpenses;
    const netProfit = netRaw === "" ? computed : n(netRaw);
    const hasPl = Boolean(revenue || plOther || purchases || employeeCost || depreciation || otherExpenses || netRaw);
    if (hasPl) {
      await prisma.profitLoss.upsert({
        where: { returnId: id },
        update: { revenue, otherIncome: plOther, purchases, employeeCost, depreciation, otherExpenses, netProfit },
        create: { returnId: id, revenue, otherIncome: plOther, purchases, employeeCost, depreciation, otherExpenses, netProfit },
      });
      const existingBiz = await prisma.businessIncome.findFirst({ where: { returnId: id } });
      const bizData = {
        section: "BOOKS" as const,
        turnover: revenue || existingBiz?.turnover || 0,
        declaredIncome: netProfit,
        nature: String(formData.get("nature") || existingBiz?.nature || "").trim(),
        natureCode: String(formData.get("natureCode") || existingBiz?.natureCode || "").trim(),
      };
      if (existingBiz) {
        await prisma.businessIncome.update({ where: { id: existingBiz.id }, data: bizData });
      } else if (revenue || netProfit) {
        await prisma.businessIncome.create({
          data: {
            returnId: id,
            ...bizData,
            digitalReceipts: 0,
            cashReceipts: 0,
          },
        });
      }
      await prisma.taxReturn.update({ where: { id }, data: { itrType: "ITR-3" } });
    }
  }

  if (formData.has("grossReceipts")) {
    const existingProf = await prisma.professionalIncome.findFirst({ where: { returnId: id } });
    const data = {
      section: "44ADA" as const,
      profession: String(formData.get("profession") || "").trim(),
      natureCode: String(formData.get("professionCode") || "").trim(),
      grossReceipts: n(String(formData.get("grossReceipts"))),
      cashReceipts: n(String(formData.get("profCash"))),
      declaredIncome: n(String(formData.get("declaredProfession"))),
      personalNotCompany: String(formData.get("personalNotCompany") || "Yes") === "Yes",
    };
    if (existingProf) {
      await prisma.professionalIncome.update({ where: { id: existingProf.id }, data });
    } else if (data.grossReceipts) {
      await prisma.professionalIncome.create({ data: { returnId: id, ...data } });
    }
  }

  if (formData.has("interest")) {
    const existing = await prisma.otherIncome.findFirst({ where: { returnId: id, kind: "Interest" } });
    const amount = n(String(formData.get("interest")));
    const source = String(formData.get("interestSource") || "").trim();
    if (existing) {
      await prisma.otherIncome.update({ where: { id: existing.id }, data: { amount, source } });
    } else if (amount) {
      await prisma.otherIncome.create({ data: { returnId: id, kind: "Interest", amount, source } });
    }
  }

  if (formData.has("dividend")) {
    const existing = await prisma.otherIncome.findFirst({ where: { returnId: id, kind: "Dividend" } });
    const amount = n(String(formData.get("dividend")));
    if (existing) {
      await prisma.otherIncome.update({ where: { id: existing.id }, data: { amount } });
    } else if (amount) {
      await prisma.otherIncome.create({ data: { returnId: id, kind: "Dividend", amount, source: "" } });
    }
  }

  if (formData.has("hpOccupancy") && String(formData.get("hpOccupancy"))) {
    const existingHp = await prisma.houseProperty.findFirst({ where: { returnId: id } });
    const data = {
      occupancy: String(formData.get("hpOccupancy") || "SELF_OCCUPIED"),
      annualLetableValue: n(String(formData.get("hpAlv"))),
      municipalTaxes: n(String(formData.get("hpMunicipal"))),
      interestOnLoan: n(String(formData.get("hpInterest"))),
    };
    if (existingHp) {
      await prisma.houseProperty.update({ where: { id: existingHp.id }, data });
    } else {
      await prisma.houseProperty.create({ data: { returnId: id, ...data } });
    }
  }
  const regime = String(formData.get("regime") || "");
  await prisma.taxReturn.update({
    where: { id },
    data: {
      ...(regime === "NEW" || regime === "OLD" ? { taxRegime: regime } : {}),
      preparationJson: JSON.stringify(prep),
    },
  });
  await audit({ userId: session.userId, returnId: id, action: "PREP_EDITED", entity: "TaxReturn", entityId: id, metadata: { fields: Object.keys(prep.fields).length } });
  await recomputeReturn(id);
  redirect(`/returns/${id}/deductions`);
}

export async function resetImportedFieldAction(formData: FormData) {
  const session = await getSession();
  if (!session) redirect("/login");
  const id = String(formData.get("returnId") || "");
  const field = String(formData.get("field") || "");
  const ret = await prisma.taxReturn.findFirst({ where: { id, userId: session.userId } });
  if (!ret || !canAccessReturn(ret.userId, session)) redirect("/dashboard");
  const prep = parsePreparation(ret.preparationJson);
  const entry = prep.fields[field];
  if (!entry) redirect(`/returns/${id}/income`);
  prep.fields[field] = resetToImported(entry);
  const restored = prep.fields[field].currentValue;
  const restoredNum = parseAmount(restored) ?? n(restored);
  if (field.startsWith("salary.")) {
    const salary = await prisma.salaryIncome.findFirst({ where: { returnId: id } });
    if (salary) {
      const data =
        field === "salary.grossSalary" ? { grossSalary: restoredNum }
        : field === "salary.tds" ? { tds: restoredNum }
        : field === "salary.employerName" ? { employerName: restored }
        : field === "salary.employerTan" ? { employerTan: restored }
        : field === "salary.exemptions" ? { exemptions: restoredNum }
        : field === "salary.standardDeduction" ? { standardDeduction: restoredNum }
        : null;
      if (data) await prisma.salaryIncome.update({ where: { id: salary.id }, data });
    }
  }
  if (field === "income.interest" || field === "income.dividend") {
    const kind = field === "income.interest" ? "Interest" : "Dividend";
    const existing = await prisma.otherIncome.findFirst({ where: { returnId: id, kind } });
    if (existing) {
      await prisma.otherIncome.update({ where: { id: existing.id }, data: { amount: restoredNum } });
    } else if (restoredNum) {
      await prisma.otherIncome.create({ data: { returnId: id, kind, amount: restoredNum, source: entry.source } });
    }
  }
  if (field === "business.receipts") {
    const biz = await prisma.businessIncome.findFirst({ where: { returnId: id } });
    if (biz) await prisma.businessIncome.update({ where: { id: biz.id }, data: { digitalReceipts: restoredNum } });
  }
  await prisma.taxReturn.update({ where: { id }, data: { preparationJson: JSON.stringify(prep) } });
  await audit({ userId: session.userId, returnId: id, action: "PREP_RESET_IMPORTED", entity: "TaxReturn", entityId: id, metadata: { field } });
  await recomputeReturn(id);
  revalidatePath(`/returns/${id}/income`);
  redirect(`/returns/${id}/income`);
}

export async function saveDeductionsAction(formData: FormData) {
  const session = await getSession();
  if (!session) redirect("/login");
  const id = String(formData.get("returnId") || "");
  const ret = await prisma.taxReturn.findFirst({ where: { id, userId: session.userId } });
  if (!ret) redirect("/dashboard");
  await prisma.deduction.deleteMany({ where: { returnId: id } });
  const parentsSenior = String(formData.get("parentsSenior") || "") === "Y";
  const rows: Array<{ section: string; amount: number; notes?: string }> = [
    { section: "80C", amount: n(String(formData.get("80C"))) },
    { section: "80CCC", amount: n(String(formData.get("80CCC"))) },
    { section: "80CCD(1)", amount: n(String(formData.get("80CCD(1)"))) },
    { section: "80CCD(1B)", amount: n(String(formData.get("80CCD(1B)"))) },
    { section: "80D_SELF", amount: n(String(formData.get("80D_SELF"))) },
    { section: "80D_SELF_PREVENTIVE", amount: n(String(formData.get("80D_SELF_PREVENTIVE"))) },
    { section: "80D_SELF_MEDICAL", amount: n(String(formData.get("80D_SELF_MEDICAL"))) },
    { section: "80D_PARENTS", amount: n(String(formData.get("80D_PARENTS"))), notes: JSON.stringify({ senior: parentsSenior, beneficiary: "PARENTS", kind: "PREMIUM" }) },
    { section: "80D_PARENTS_PREVENTIVE", amount: n(String(formData.get("80D_PARENTS_PREVENTIVE"))), notes: JSON.stringify({ senior: parentsSenior, beneficiary: "PARENTS", kind: "PREVENTIVE" }) },
    { section: "80D_PARENTS_MEDICAL", amount: n(String(formData.get("80D_PARENTS_MEDICAL"))), notes: JSON.stringify({ senior: parentsSenior, beneficiary: "PARENTS", kind: "MEDICAL" }) },
    { section: "80TTA", amount: n(String(formData.get("80TTA"))) },
    { section: "80TTB", amount: n(String(formData.get("80TTB"))) },
  ];
  for (const row of rows) {
    if (!row.amount) continue;
    await prisma.deduction.create({ data: { returnId: id, section: row.section, amount: row.amount, notes: row.notes || "" } });
  }
  await recomputeReturn(id);
  redirect(`/returns/${id}/tds`);
}

export async function saveTdsBankAction(formData: FormData) {
  const session = await getSession();
  if (!session) redirect("/login");
  const id = String(formData.get("returnId") || "");
  const ret = await prisma.taxReturn.findFirst({ where: { id, userId: session.userId } });
  if (!ret) redirect("/dashboard");
  await prisma.tDSEntry.deleteMany({ where: { returnId: id } });
  await prisma.taxPayment.deleteMany({ where: { returnId: id } });
  await prisma.bankAccount.deleteMany({ where: { returnId: id } });
  if (n(String(formData.get("tdsAmount")))) {
    await prisma.tDSEntry.create({
      data: {
        returnId: id,
        sectionCode: String(formData.get("tdsSection") || "194A"),
        tan: String(formData.get("tdsTan") || "").toUpperCase(),
        deductorName: String(formData.get("tdsName") || ""),
        amount: n(String(formData.get("tdsAmount"))),
      },
    });
  }
  if (n(String(formData.get("advanceTax")))) {
    const paidOn = String(formData.get("advanceTaxDate") || "");
    await prisma.taxPayment.create({
      data: {
        returnId: id,
        kind: "ADVANCE",
        amount: n(String(formData.get("advanceTax"))),
        paidOn: paidOn ? new Date(paidOn) : undefined,
      },
    });
  }
  if (n(String(formData.get("selfAsst")))) {
    const paidOn = String(formData.get("selfAsstDate") || "");
    await prisma.taxPayment.create({
      data: {
        returnId: id,
        kind: "SELF_ASSESSMENT",
        amount: n(String(formData.get("selfAsst"))),
        paidOn: paidOn ? new Date(paidOn) : undefined,
      },
    });
  }
  const ifsc = String(formData.get("ifsc") || "").toUpperCase().trim();
  const accountNumber = String(formData.get("accountNumber") || "").trim();
  const bankName = String(formData.get("bankName") || "").trim();
  if (ifsc || accountNumber) {
    await prisma.bankAccount.create({
      data: {
        returnId: id,
        ifsc,
        accountNumber,
        bankName,
        accountType: String(formData.get("accountType") || "SB"),
        isPrimary: true,
      },
    });
  }
  await recomputeReturn(id);
  redirect(`/returns/${id}/validate`);
}

export async function generateJsonAction(formData: FormData) {
  const session = await getSession();
  if (!session) redirect("/login");
  const id = String(formData.get("returnId") || "");
  const ret = await prisma.taxReturn.findFirst({ where: { id, userId: session.userId } });
  if (!ret || !canAccessReturn(ret.userId, session)) redirect("/dashboard");
  const gate = await canGenerateItrJson(id, {
    generatedAt: new Date(),
    ownerUserId: session.role === "ADMIN" ? undefined : session.userId,
  });
  if (gate.error === "empty" || !gate.data) redirect("/dashboard");
  if (gate.error === "itr3") redirect(`/returns/${id}/summary?error=itr3`);
  if (!gate.allowed || !gate.result?.json) {
    await prisma.taxReturn.update({ where: { id }, data: { status: "VALIDATION_FAILED" } });
    redirect(`/returns/${id}/validate?blocked=1`);
  }
  const data = gate.data;
  const result = gate.result;
  const payload = JSON.stringify(result.json, null, 2);
  const dir = path.join(process.cwd(), "storage", "json", id);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${data.itrType}-${Date.now()}.json`);
  await writeFile(file, payload, "utf8");
  await prisma.iTRJsonFile.updateMany({ where: { returnId: id, status: "CURRENT" }, data: { status: "SUPERSEDED" } });
  await prisma.iTRJsonFile.create({
    data: {
      returnId: id,
      assessmentYear: data.assessmentYear,
      itrType: data.itrType,
      schemaVersion: result.schemaVersion,
      fileHash: result.digest,
      storagePath: file,
      valid: true,
      status: "CURRENT",
      versionId: result.digest.slice(0, 12),
    },
  });
  await prisma.taxReturn.update({ where: { id }, data: { status: "JSON_GENERATED", schemaVersion: result.schemaVersion } });
  await audit({ userId: session.userId, returnId: id, action: "json.generated", entity: "ITRJsonFile", metadata: { hash: result.digest } });
  revalidatePath(`/returns/${id}/json`);
  redirect(`/returns/${id}/json`);
}

export async function uploadDocumentAction(formData: FormData) {
  const session = await getSession();
  if (!session) redirect("/login");
  const id = String(formData.get("returnId") || "");
  const ret = await prisma.taxReturn.findFirst({ where: { id, userId: session.userId } });
  if (!ret) redirect("/dashboard");
  const file = formData.get("file");
  if (!(file instanceof File) || !file.size) redirect(`/returns/${id}/documents?error=file`);
  const bytes = Buffer.from(await file.arrayBuffer());
  const mime = sniffMime(bytes, file.name, file.type);
  const gate = isAllowedUpload(mime, file.size);
  if (!gate.ok) redirect(`/returns/${id}/documents?error=${gate.code.toLowerCase()}`);
  const hash = documentSha256(bytes);
  const force = String(formData.get("force") || "") === "1";
  const dup = await prisma.document.findFirst({
    where: { userId: session.userId, returnId: id, sha256: hash, deletedAt: null },
  });
  if (dup && !force) redirect(`/returns/${id}/documents/${dup.id}?duplicate=1`);
  const key = newStorageKey(session.userId, file.name);
  try {
    await getStorage().put(key, bytes, mime);
  } catch {
    redirect(`/returns/${id}/documents?error=storage`);
  }
  const declared = String(formData.get("kind") || "OTHER");
  const kind = (DOCUMENT_TYPES as readonly string[]).includes(declared) ? declared : "OTHER";
  const doc = await prisma.document.create({
    data: {
      userId: session.userId,
      returnId: id,
      kind,
      fileName: file.name,
      mimeType: mime,
      sizeBytes: file.size,
      storageKey: key,
      sha256: hash,
      status: "PROCESSING",
    },
  });
  await audit({ userId: session.userId, returnId: id, action: "UPLOAD", entity: "Document", entityId: doc.id, metadata: { kind, size: file.size } });
  await persistExtraction({
    documentId: doc.id,
    returnId: id,
    userId: session.userId,
    bytes,
    fileName: file.name,
    mimeType: mime,
    declaredKind: kind,
  });
  revalidatePath(`/returns/${id}/documents`);
  redirect(`/returns/${id}/documents/${doc.id}`);
}

export async function reviewExtractionAction(formData: FormData) {
  const session = await getSession();
  if (!session) return;
  const extractionId = String(formData.get("extractionId") || "");
  const decision = String(formData.get("decision") || "");
  if (decision !== "confirm" && decision !== "reject" && decision !== "edit") return;
  const row = await prisma.documentExtraction.findUnique({ where: { id: extractionId }, include: { document: true } });
  if (!row || !canAccessTaxFact(row.document.userId, session)) return;
  const fact = await prisma.taxFact.findFirst({
    where: { sourceDocumentId: row.documentId, field: row.fieldKey },
  });
  if (fact?.status === "CONFLICT" && decision !== "reject") {
    const rid = row.document.returnId;
    if (rid) redirect(`/returns/${rid}/documents?conflict=1`);
    return;
  }
  const edited = String(formData.get("edited") || "").trim();
  const nextValue = edited || row.extractedValue;
  const numeric = parseAmount(nextValue);
  const reviewed = reviewFactStatus(decision);
  await prisma.documentExtraction.update({
    where: { id: extractionId },
    data: {
      status: decision === "reject" ? "REJECTED" : decision === "confirm" ? "CONFIRMED" : "EXTRACTED",
      confirmed: decision === "confirm",
      confirmedAt: decision === "confirm" ? new Date() : decision === "reject" ? null : row.confirmedAt,
      originalValue: row.originalValue || row.extractedValue,
      editedValue: edited && edited !== row.extractedValue ? edited : row.editedValue,
      editedBy: edited && edited !== row.extractedValue ? session.userId : row.editedBy,
      editedAt: edited && edited !== row.extractedValue ? new Date() : row.editedAt,
      extractedValue: nextValue,
      numericValue: numeric ?? row.numericValue,
    },
  });
  if (fact) {
    await prisma.taxFact.update({
      where: { id: fact.id },
      data: {
        verified: reviewed.verified,
        verifiedBy: reviewed.verified ? session.userId : "",
        verifiedAt: reviewed.verified ? new Date() : null,
        status: reviewed.status,
        value: nextValue,
        numericValue: numeric ?? fact.numericValue,
        originalValue: fact.originalValue || fact.value,
        editedValue: edited && edited !== fact.value ? edited : fact.editedValue,
      },
    });
  }
  await audit({
    userId: session.userId,
    returnId: row.document.returnId,
    action: decision === "reject" ? "REJECTED" : edited ? "EDITED" : "VERIFIED",
    entity: "DocumentExtraction",
    entityId: row.id,
  });
  const rid = row.document.returnId;
  if (rid) await rebuildDocumentConflicts(rid);
  const remaining = await prisma.taxFact.count({
    where: { sourceDocumentId: row.documentId, status: { in: ["AI_EXTRACTED", "PENDING", "CONFLICT"] } },
  });
  if (remaining === 0 && row.documentId) {
    await prisma.document.update({ where: { id: row.documentId }, data: { status: decision === "reject" ? "NEEDS_REVIEW" : "VERIFIED" } });
  }
  if (rid) {
    await applyVerifiedFactsToTaxModel(rid);
    revalidatePath(`/returns/${rid}/documents`);
    revalidatePath(`/returns/${rid}/documents/${row.documentId}`);
    revalidatePath(`/returns/${rid}/income`);
    revalidatePath(`/returns/${rid}/review`);
  }
}

export async function resolveConflictAction(formData: FormData) {
  const session = await getSession();
  if (!session) return;
  const conflictId = String(formData.get("conflictId") || "");
  const row = await prisma.documentConflict.findUnique({
    where: { id: conflictId },
    include: { taxReturn: true },
  });
  if (!row || !canAccessConflict(row.taxReturn.userId, session)) return;
  if (row.status !== "OPEN") {
    revalidatePath(`/returns/${row.returnId}/documents`);
    return;
  }
  const facts = JSON.parse(row.factsJson || "[]") as Array<{
    id: string;
    documentType: string;
    field: string;
    normalizedTaxField: string;
    value: string;
    numericValue: number | null;
    sourceDocumentId: string;
  }>;
  const applied = applyConflictResolution({
    resolution: String(formData.get("resolution") || ""),
    facts,
    chosenFactId: String(formData.get("factId") || ""),
    manualValue: String(formData.get("value") || ""),
    reason: String(formData.get("reason") || ""),
  });
  if (!applied.ok) return;
  await prisma.documentConflict.update({
    where: { id: row.id },
    data: {
      status: applied.status,
      resolution: applied.resolution,
      resolvedValue: applied.resolvedValue,
      chosenFactId: applied.chosenFactId,
      resolvedBy: session.userId,
      resolvedAt: new Date(),
      reason: String(formData.get("reason") || ""),
    },
  });
  if (applied.verifyId) {
    await prisma.taxFact.update({
      where: { id: applied.verifyId },
      data: {
        status: "VERIFIED",
        verified: true,
        verifiedBy: session.userId,
        verifiedAt: new Date(),
        conflictWithId: row.id,
      },
    });
  }
  for (const id of applied.rejectIds) {
    await prisma.taxFact.update({
      where: { id },
      data: { status: "REJECTED", verified: false, verifiedBy: "", verifiedAt: null, conflictWithId: row.id },
    });
  }
  await audit({
    userId: session.userId,
    returnId: row.returnId,
    action: "CONFLICT_RESOLVED",
    entity: "DocumentConflict",
    entityId: row.id,
    metadata: { resolution: applied.resolution, field: row.field },
  });
  await applyVerifiedFactsToTaxModel(row.returnId);
  revalidatePath(`/returns/${row.returnId}/documents`);
  revalidatePath(`/returns/${row.returnId}/income`);
  revalidatePath(`/returns/${row.returnId}/review`);
}

export async function applyVerifiedDocumentsAction(formData: FormData) {
  const session = await getSession();
  if (!session) redirect("/login");
  const id = String(formData.get("returnId") || "");
  const ret = await prisma.taxReturn.findFirst({ where: { id, userId: session.userId } });
  if (!ret) redirect("/dashboard");
  await applyVerifiedFactsToTaxModel(id);
  await audit({ userId: session.userId, returnId: id, action: "APPLIED_TAXFACTS", entity: "TaxReturn", entityId: id });
  revalidatePath(`/returns/${id}/income`);
  redirect(`/returns/${id}/income`);
}

export async function classifyBankTxAction(formData: FormData) {
  const session = await getSession();
  if (!session) return;
  const txId = String(formData.get("txId") || "");
  const category = String(formData.get("category") || "UNKNOWN");
  const row = await prisma.bankTransaction.findUnique({ where: { id: txId }, include: { document: true } });
  if (!row || !canAccessTaxFact(row.document.userId, session)) return;
  await prisma.bankTransaction.update({
    where: { id: txId },
    data: {
      verifiedCategory: category,
      category,
      verified: true,
    },
  });
  revalidatePath(`/returns/${row.returnId}/documents/${row.documentId}`);
}

export async function reprocessDocumentAction(formData: FormData) {
  const session = await getSession();
  if (!session) redirect("/login");
  const docId = String(formData.get("documentId") || "");
  const doc = await prisma.document.findUnique({ where: { id: docId } });
  if (!doc || !canAccessTaxFact(doc.userId, session) || !doc.returnId) redirect("/dashboard");
  const bytes = await getStorage().get(doc.storageKey);
  await persistExtraction({
    documentId: doc.id,
    returnId: doc.returnId,
    userId: session.userId,
    bytes,
    fileName: doc.fileName,
    mimeType: doc.mimeType,
    declaredKind: doc.kind,
    force: true,
  });
  revalidatePath(`/returns/${doc.returnId}/documents`);
  revalidatePath(`/returns/${doc.returnId}/documents/${doc.id}`);
}
