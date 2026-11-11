import { completeTotpLoginAction } from "@/app/actions";
import { SiteHeader } from "@/components/site-header";
import { Button, Card, Input, Label } from "@/components/ui";

export default async function TotpLogin({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  return (
    <div className="min-w-0">
      <SiteHeader />
      <div className="mx-auto w-full min-w-0 max-w-md px-4 py-10 sm:px-6 sm:py-16">
        <Card>
          <h1 className="text-2xl">Authenticator code</h1>
          <p className="sans mt-2 text-sm text-[#5c6773]">Enter the 6-digit code from your authenticator app.</p>
          {error === "code" ? <p className="sans mt-2 text-sm text-red-800">That code was not accepted.</p> : null}
          <form action={completeTotpLoginAction} className="mt-5 space-y-3">
            <div>
              <Label>Code</Label>
              <Input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" required />
            </div>
            <Button className="w-full">Continue</Button>
          </form>
        </Card>
      </div>
    </div>
  );
}
