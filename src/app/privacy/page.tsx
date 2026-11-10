import { SiteHeader } from "@/components/site-header";
import { Card, Disclaimer } from "@/components/ui";

export default function Privacy() {
  return (
    <div>
      <SiteHeader />
      <div className="mx-auto max-w-3xl px-6 py-16">
        <h1 className="text-4xl">Privacy</h1>
        <div className="mt-8 space-y-3">
          {[
            "TaxPilot AI stores the account, return, and documents you submit so it can prepare ITR JSON. It does not collect Income Tax portal passwords.",
            "PAN, address, bank details, and uploaded files are used only to prepare your return and to operate the service. They are not sold.",
            "You can download a copy of your account data, or delete the account and its documents, from the Account page after you sign in.",
            "Production document files stay in a private bucket. Downloads require a signed-in owner and use a short-lived link.",
            "Password reset email is sent only when an email provider is configured. Sessions last 12 hours.",
            "This notice is not a filing or a legal opinion. Review the prepared JSON before you upload it.",
          ].map((text) => (
            <Card key={text}>{text}</Card>
          ))}
        </div>
        <div className="mt-8">
          <Disclaimer />
        </div>
      </div>
    </div>
  );
}
