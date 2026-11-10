import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { redirect } from "next/navigation";
import { SiteHeader } from "@/components/site-header";
import { Button, Card } from "@/components/ui";
import { createReturnAction } from "@/app/actions";
import Link from "next/link";

const SOURCES = [
  ["SALARY", "Salary"],
  ["BUSINESS", "Business"],
  ["PROFESSION", "Profession"],
  ["FREELANCING", "Freelancing"],
  ["INTEREST", "Interest"],
  ["DIVIDEND", "Dividend"],
  ["HOUSE_PROPERTY", "House property"],
];

export default async function NewReturn() {
  const session = await getSession();
  if (!session) redirect("/login");
  const existing = await prisma.taxReturn.findFirst({
    where: { userId: session.userId },
    orderBy: { updatedAt: "desc" },
    select: { id: true, itrType: true, assessmentYear: true },
  });
  return (
    <div>
      <SiteHeader authed name={session.name} admin={session.role === "ADMIN"} />
      <div className="mx-auto max-w-2xl px-6 py-12">
        <h1 className="text-3xl">Start your ITR-4</h1>
        <p className="sans mt-2 text-sm text-[#5c6773]">
          Upload your tax documents and review the information before generating your return.
        </p>
        <Card className="mt-6">
          <p className="font-medium">ITR-4</p>
          <p className="sans mt-2 text-sm text-[#5c6773]">
            ITR-4 is for currently supported presumptive and salary scenarios. Existing eligibility rules decide if ITR-4
            applies after you start. ITR-3 JSON download stays off in production unless this deployment explicitly enables it.
          </p>
        </Card>
        {existing ? (
          <Card className="mt-4">
            <p className="font-medium">You already have a return</p>
            <p className="sans mt-1 text-sm text-[#5c6773]">
              {existing.itrType} · AY {existing.assessmentYear}
            </p>
            <Link href="/dashboard" className="mt-3 inline-block">
              <Button variant="outline" className="min-h-11" aria-label="Continue existing return">
                Continue existing return
              </Button>
            </Link>
          </Card>
        ) : null}
        <form action={createReturnAction} className="mt-6 space-y-4">
          <Card>
            <p className="font-medium">Assessment year</p>
            <label className="sans mt-3 flex min-h-11 items-center gap-3 text-sm">
              <input type="radio" name="assessmentYear" value="2026-27" defaultChecked />
              AY 2026–27 (FY 2025–26)
            </label>
          </Card>
          <Card>
            <p className="font-medium">Taxpayer type</p>
            <label className="sans mt-3 flex min-h-11 items-center gap-3 text-sm">
              <input type="radio" name="taxpayerType" value="INDIVIDUAL" defaultChecked />
              Individual
            </label>
          </Card>
          <Card>
            <p className="font-medium">Income sources</p>
            <p className="sans mt-1 text-xs text-[#5c6773]">Select what applies. You can refine this after documents are verified.</p>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {SOURCES.map(([value, label]) => (
                <label key={value} className="sans flex min-h-11 items-center gap-2 rounded-xl border border-[#e4ddd0] bg-white px-3 text-sm">
                  <input type="checkbox" name="sources" value={value} defaultChecked={value === "SALARY"} />
                  {label}
                </label>
              ))}
            </div>
          </Card>
          <Button type="submit" className="min-h-11 w-full sm:w-auto" aria-label="Start your ITR-4">
            Start your ITR-4
          </Button>
        </form>
      </div>
    </div>
  );
}
