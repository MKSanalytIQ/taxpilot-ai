import { SiteHeader } from "@/components/site-header";
import { Card, Button, Disclaimer } from "@/components/ui";
import { ProCheckoutButton } from "@/components/pro-checkout";
import Link from "next/link";
import { getSession } from "@/lib/auth";
import { getUserAccess } from "@/lib/plan";
import { displayProPriceLabel } from "@/lib/payment";
import { PAYMENT_SUCCESS_DETAIL, PAYMENT_SUCCESS_HEADING } from "@/lib/payment-messages";

const FREE_FEATURES = [
  "Create ITR-4 return",
  "Upload documents",
  "Review extracted information",
  "Calculate tax",
  "Review return",
];

const PRO_FEATURES = [
  "Everything in Free",
  "Complete return export",
  "Final ITR-4 JSON",
  "Advanced automation",
];

export default async function Pricing({
  searchParams,
}: {
  searchParams: Promise<{ paid?: string }>;
}) {
  const { paid } = await searchParams;
  const session = await getSession();
  const access = session ? await getUserAccess(session.userId) : null;
  const priceLabel = displayProPriceLabel();
  const success = Boolean(access?.isPro);

  return (
    <div>
      <SiteHeader authed={Boolean(session)} name={session?.name} admin={session?.role === "ADMIN"} />
      <div className="mx-auto max-w-5xl px-6 py-16">
        <h1 className="text-4xl">Pricing</h1>
        {paid === "1" && access?.isPro ? (
          <Card className="mt-6">
            <p className="font-medium">{PAYMENT_SUCCESS_HEADING}</p>
            <p className="sans mt-2 text-sm text-[#5c6773]">{PAYMENT_SUCCESS_DETAIL}</p>
            <Link href="/dashboard" className="mt-4 inline-block">
              <Button className="min-h-11 w-full sm:w-auto">Continue to your return</Button>
            </Link>
          </Card>
        ) : (
          <p className="sans mt-3 text-[#5c6773]">Start on Free. Upgrade to Pro when you are ready to export your final ITR-4.</p>
        )}
        <div className="mt-8 grid gap-4 md:grid-cols-2">
          <Card>
            <p className="sans text-xs uppercase tracking-widest text-[#c4a574]">FREE</p>
            <p className="mt-2 text-3xl">₹0</p>
            <ul className="sans mt-4 space-y-2 text-sm text-[#5c6773]">
              {FREE_FEATURES.map((item) => (
                <li key={item}>✓ {item}</li>
              ))}
            </ul>
            <Link href={session ? "/dashboard" : "/signup"} className="mt-6 inline-block w-full sm:w-auto">
              <Button className="min-h-11 w-full sm:w-auto">{session ? "Continue on Free" : "Start on Free"}</Button>
            </Link>
          </Card>
          <Card>
            <p className="sans text-xs uppercase tracking-widest text-[#c4a574]">PRO</p>
            <p className="mt-2 text-3xl">{priceLabel || "Pro"}</p>
            <ul className="sans mt-4 space-y-2 text-sm text-[#5c6773]">
              {PRO_FEATURES.map((item) => (
                <li key={item}>✓ {item}</li>
              ))}
            </ul>
            {success && access?.isPro ? (
              <p className="sans mt-6 text-sm text-[#1f4e46]">Pro is active.</p>
            ) : session ? (
              <ProCheckoutButton />
            ) : (
              <Link href="/login" className="mt-6 inline-block w-full sm:w-auto">
                <Button className="min-h-11 w-full sm:w-auto" aria-label="Upgrade to Pro">
                  Upgrade to Pro
                </Button>
              </Link>
            )}
          </Card>
        </div>
        <div className="mt-8">
          <Disclaimer />
        </div>
      </div>
    </div>
  );
}
