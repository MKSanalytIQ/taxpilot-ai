import { SiteHeader } from "@/components/site-header";
import { Card, Disclaimer } from "@/components/ui";

export default function Security() {
  return (
    <div>
      <SiteHeader />
      <div className="mx-auto max-w-3xl px-6 py-16">
        <h1 className="text-4xl">Security</h1>
        <div className="mt-8 space-y-3">
          {[
            "Passwords are hashed. Sessions are signed httpOnly cookies that last 12 hours. A cookie that is not a valid session is rejected. Production refuses to start without a 32-character AUTH_SECRET.",
            "Authenticator codes can be required on the Account page. The secret is stored only after you confirm a code.",
            "Documents are stored in a private bucket. A signed-in owner gets a short-lived download link. Files are not public and are not written to logs.",
            "PAN and Aadhaar are excluded from error logs.",
            "Income Tax portal credentials are never collected.",
            "Access is per account. ADMIN can be granted only with the promote-admin script. There is no second-user access for a tax-professional role.",
            "You can export or delete your account and documents from the Account page.",
          ].map((t) => (
            <Card key={t}>{t}</Card>
          ))}
        </div>
        <div className="mt-8">
          <Disclaimer />
        </div>
      </div>
    </div>
  );
}
