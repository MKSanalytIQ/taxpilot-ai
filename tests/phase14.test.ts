import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  accessFromSubscription,
  canExportItr,
  isProUser,
  jsonExportUpgradePath,
  normalizePlan,
  planLabel,
  PRO_REQUIRED_CODE,
  PRO_REQUIRED_MESSAGE,
  requireProAccess,
} from "@/lib/plan";

function src(rel: string) {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

function functionBody(file: string, name: string) {
  const start = file.indexOf(`export async function ${name}`);
  expect(start).toBeGreaterThan(-1);
  const next = file.indexOf("export async function ", start + 10);
  return next === -1 ? file.slice(start) : file.slice(start, next);
}

describe("Phase 14 commercial access", () => {
  it("TEST 1: new user defaults to FREE", () => {
    expect(isProUser({ plan: "FREE", status: "ACTIVE" })).toBe(false);
    expect(planLabel({ plan: "FREE", status: "ACTIVE" })).toBe("Free");
    const signup = functionBody(src("src/app/actions.ts"), "signupAction");
    expect(signup).toContain('plan: "FREE"');
    expect(src("prisma/schema.prisma")).toContain('plan             String    @default("FREE")');
  });

  it("TEST 2: existing user without a plan behaves as FREE", () => {
    expect(isProUser(undefined)).toBe(false);
    expect(isProUser(null)).toBe(false);
    expect(isProUser({})).toBe(false);
    expect(isProUser({ plan: "", status: "ACTIVE" })).toBe(false);
    expect(isProUser({ plan: null, status: "ACTIVE" })).toBe(false);
    expect(normalizePlan(undefined)).toBe("FREE");
    expect(accessFromSubscription(null).isPro).toBe(false);
    expect(planLabel(undefined)).toBe("Free");
  });

  it("TEST 3: Free user can create an ITR-4 return", () => {
    const create = functionBody(src("src/app/actions.ts"), "createReturnAction");
    expect(create).toContain("prisma.taxReturn.create");
    expect(create).not.toContain("getUserAccess");
    expect(create).not.toContain("isProUser");
    const start = src("src/app/returns/new/page.tsx");
    expect(start).toContain("createReturnAction");
    expect(start).toContain("Start your ITR-4");
  });

  it("TEST 4: Free user can calculate and review tax", () => {
    const calculate = src("src/app/api/returns/[id]/calculate/route.ts");
    expect(calculate).toContain("recomputeReturn");
    expect(calculate).not.toContain("getUserAccess");
    expect(calculate).not.toContain("isProUser");
    const summary = src("src/app/returns/[id]/summary/page.tsx");
    expect(summary).toContain("calc.totalTax");
    expect(summary).toContain("calc.taxableIncome");
    expect(summary).not.toMatch(/access\.isPro[\s\S]{0,40}calc\.totalTax/);
    const dashboard = src("src/app/dashboard/page.tsx");
    expect(dashboard).toContain("calc.totalTax");
    expect(dashboard).toContain("Open tax summary");
  });

  it("TEST 5: Free user cannot access JSON generate or download endpoints", () => {
    const generate = functionBody(src("src/app/json-actions.ts"), "generateJsonAction");
    expect(generate.indexOf("getUserAccess")).toBeGreaterThan(-1);
    expect(generate.indexOf("getUserAccess")).toBeLessThan(generate.indexOf("canGenerateItrJson"));
    expect(generate).toContain("jsonExportUpgradePath");
    expect(generate.indexOf("if (!access.canExport)")).toBeLessThan(generate.indexOf("writeFile"));
    expect(generate.indexOf("if (!access.canExport)")).toBeLessThan(generate.indexOf("prisma.taxReturn.update"));

    const download = src("src/app/api/returns/[id]/download-json/route.ts");
    expect(download).toContain("getUserAccess");
    expect(download).toContain("proRequiredBody");
    expect(download.indexOf("if (!access.canExport)")).toBeLessThan(download.indexOf("iTRJsonFile.findFirst"));

    const apiGenerate = src("src/app/api/returns/[id]/generate-json/route.ts");
    expect(apiGenerate).toContain("getUserAccess");
    expect(apiGenerate).toContain("if (!access.canExport)");
    expect(apiGenerate.indexOf("if (!access.canExport)")).toBeLessThan(apiGenerate.indexOf("const gate = await canGenerateItrJson"));

    expect(requireProAccess({ plan: "FREE" }).allowed).toBe(false);
    expect(requireProAccess({ plan: "FREE" })).toMatchObject({ code: PRO_REQUIRED_CODE });
    expect(jsonExportUpgradePath("ret-1")).toBe("/returns/ret-1/summary?upgrade=1");
    const off = {} as unknown as NodeJS.ProcessEnv;
    expect(canExportItr({ plan: "FREE", status: "ACTIVE" }, off)).toBe(true);
    const on = { RAZORPAY_KEY_ID: "rzp_test", RAZORPAY_KEY_SECRET: "secret", PRO_PRICE_INR: "499" } as unknown as NodeJS.ProcessEnv;
    expect(canExportItr({ plan: "FREE", status: "ACTIVE" }, on)).toBe(false);
    expect(canExportItr({ plan: "PRO", status: "ACTIVE" }, on)).toBe(true);
  });

  it("TEST 6: Free user receives upgrade UI", () => {
    const cta = src("src/components/upgrade-cta.tsx");
    expect(cta).toContain("Upgrade to Pro");
    expect(cta).toContain("href={PRICING_PATH}");
    expect(cta).toContain("{UPGRADE_HEADING}");
    expect(cta).toContain("{UPGRADE_DETAIL}");
    expect(src("src/lib/plan.ts")).toContain('Your return is ready.');
    expect(src("src/lib/plan.ts")).toContain("Upgrade to Pro to generate/download your final ITR-4.");
    for (const file of [
      "src/app/dashboard/page.tsx",
      "src/app/returns/[id]/summary/page.tsx",
      "src/app/returns/[id]/json/page.tsx",
      "src/app/returns/[id]/review/page.tsx",
    ]) {
      const page = src(file);
      expect(page).toMatch(/UpgradeCta|ProUpgradeCard/);
    }
    expect(PRO_REQUIRED_MESSAGE).toContain("Upgrade to Pro");
  });

  it("TEST 7: Pro user can access the Pro-only action", () => {
    expect(isProUser({ plan: "PRO", status: "ACTIVE" })).toBe(true);
    expect(isProUser({ plan: "ITR4", status: "ACTIVE" })).toBe(true);
    expect(isProUser({ plan: "ITR3", status: "ACTIVE" })).toBe(true);
    expect(isProUser({ plan: "PROFESSIONAL", status: "ACTIVE" })).toBe(true);
    expect(isProUser({ plan: "CA_FIRM", status: "ACTIVE" })).toBe(true);
    expect(requireProAccess({ plan: "PRO", status: "ACTIVE" }).allowed).toBe(true);
    expect(planLabel({ plan: "PRO", status: "ACTIVE" })).toBe("Pro");
    const generate = functionBody(src("src/app/json-actions.ts"), "generateJsonAction");
    expect(generate).toContain("canGenerateItrJson");
    expect(generate).toContain("writeFile");
    const jsonPage = src("src/app/returns/[id]/json/page.tsx");
    expect(jsonPage).toContain("access.canExport");
    expect(jsonPage).toContain("generateJsonAction");
    expect(jsonPage).toContain("download-json");
  });

  it("TEST 8: plan/access state does not modify return data", () => {
    const plan = src("src/lib/plan.ts");
    expect(plan).not.toContain("taxReturn");
    expect(plan).not.toContain("TaxFact");
    expect(plan).not.toContain("calculationJson");
    expect(plan).toContain("select: { plan: true, status: true }");
    const generate = functionBody(src("src/app/json-actions.ts"), "generateJsonAction");
    const deny = generate.indexOf("if (!access.canExport)");
    const update = generate.indexOf("prisma.taxReturn.update");
    expect(deny).toBeGreaterThan(-1);
    expect(update).toBeGreaterThan(deny);
    expect(isProUser({ plan: "FREE" })).toBe(false);
    expect(isProUser({ plan: "PRO" })).toBe(true);
  });

  it("TEST 9: client-side manipulation cannot bypass the Pro restriction", () => {
    expect(isProUser({ plan: "FREE", status: "ACTIVE", queryPlan: "PRO" } as never)).toBe(false);
    expect(isProUser({ plan: "PRO", status: "CANCELLED" })).toBe(false);
    expect(isProUser({ plan: "PRO", status: "EXPIRED" })).toBe(false);
    const generate = functionBody(src("src/app/json-actions.ts"), "generateJsonAction");
    expect(generate).toContain("getUserAccess(session.userId)");
    expect(generate).not.toContain('formData.get("plan")');
    expect(generate).not.toContain("localStorage");
    expect(generate).not.toContain("searchParams");
    const download = src("src/app/api/returns/[id]/download-json/route.ts");
    expect(download).toContain("getUserAccess(session.userId)");
    expect(download).not.toContain("localStorage");
    const helper = src("src/lib/plan.ts");
    expect(helper).toContain("export function isProUser");
    expect(helper).not.toContain("localStorage");
    expect(helper).not.toContain("searchParams");
    expect(src("src/app/json-actions.ts").match(/isProUser\(/g) || []).toHaveLength(0);
  });

  it("pricing page is Free vs Pro with no fake price", () => {
    const pricing = src("src/app/pricing/page.tsx");
    expect(pricing).toContain("FREE");
    expect(pricing).toContain("PRO");
    expect(pricing).toContain("\u20b90");
    expect(pricing).toContain("Create ITR-4 return");
    expect(pricing).toContain("Final ITR-4 JSON");
    expect(pricing).toContain("Upgrade to Pro");
    expect(pricing).not.toMatch(/\u20b9\s*[1-9]/);
    expect(pricing).not.toContain("Stripe");
  });

  it("dashboard shows the current plan", () => {
    const dashboard = src("src/app/dashboard/page.tsx");
    expect(dashboard).toContain("Plan: {access.label}");
    expect(dashboard).toContain("getUserAccess");
    expect(dashboard).toContain("UpgradeCta");
  });
});
