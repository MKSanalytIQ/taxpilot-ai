import { SiteHeader } from "@/components/site-header";
import { Card, Disclaimer } from "@/components/ui";

export default function Faq() {
  const items = [
    ["Does TaxPilot file my return?", "No. You download ITR JSON and upload it on the Income Tax e-filing portal. Direct filing is not implemented."],
    ["Is this government software?", "No. TaxPilot AI is independent and is not affiliated with or endorsed by the Income Tax Department."],
    ["Does the AI calculate my tax?", "No. The assistant asks questions and explains concepts. Tax, eligibility and JSON are produced by versioned rule engines."],
    ["Which year is supported?", "Assessment Year 2026–27 (FY 2025–26). ITR-4 is the filing path. ITR-3 can be reviewed, and its JSON download stays off in production unless the deployment explicitly enables it."],
    ["Will AIS overwrite my numbers?", "Never automatically. AIS/26AS is reconciliation data you review."],
  ];
  return (
    <div>
      <SiteHeader />
      <div className="mx-auto max-w-3xl px-6 py-16">
        <h1 className="text-4xl">FAQ</h1>
        <div className="mt-8 space-y-3">
          {items.map(([q, a]) => (
            <Card key={q}>
              <p className="text-lg">{q}</p>
              <p className="sans mt-2 text-sm text-[#5c6773]">{a}</p>
            </Card>
          ))}
        </div>
        <div className="mt-8">
          <Disclaimer />
        </div>
      </div>
    </div>
  );
}
