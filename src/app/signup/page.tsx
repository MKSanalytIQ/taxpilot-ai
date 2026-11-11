import { signupAction } from "@/app/actions";
import { SiteHeader } from "@/components/site-header";
import { Button, Card, Input, Label, Disclaimer } from "@/components/ui";

export default async function Signup({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  return (
    <div>
      <SiteHeader />
      <div className="mx-auto max-w-md px-6 py-16">
        <Card>
          <h1 className="text-2xl">Create your TaxPilot account</h1>
          {error ? (
            <p className="sans mt-2 text-sm text-red-800">
              {error === "rate"
                ? "Too many attempts."
                : error === "unavailable"
                  ? "Sign-up is temporarily unavailable."
                  : error === "exists"
                    ? "An account with that email already exists."
                    : error === "db"
                      ? "Server database is unavailable. Please try again."
                      : "Check your name, email, and password (8+ characters)."}
            </p>
          ) : null}
          <form action={signupAction} className="mt-6 space-y-3">
            <div>
              <Label>Full name</Label>
              <Input name="name" required />
            </div>
            <div>
              <Label>Email</Label>
              <Input name="email" type="email" required />
            </div>
            <div>
              <Label>Password (8+)</Label>
              <Input name="password" type="password" minLength={8} required />
            </div>
            <Button className="w-full">Create account</Button>
          </form>
          <div className="mt-6">
            <Disclaimer />
          </div>
        </Card>
      </div>
    </div>
  );
}
