import Link from "next/link";
import { redirect } from "next/navigation";
import { beginTotpAction, confirmTotpAction, deleteAccountAction, disableTotpAction } from "@/app/account-actions";
import { SiteHeader } from "@/components/site-header";
import { Button, Card, Input } from "@/components/ui";
import { getSession, readTotpSetup } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { totpUri } from "@/lib/totp";

export default async function AccountPage({ searchParams }: { searchParams: Promise<{ error?: string; totp?: string }> }) {
  const session = await getSession();
  if (!session) redirect("/login");
  const { error, totp } = await searchParams;
  const user = await prisma.user.findUnique({ where: { id: session.userId }, select: { totpEnabled: true } });
  const setupSecret = totp === "setup" ? await readTotpSetup() : "";
  const message =
    error === "confirm"
      ? "Type your email address exactly to confirm deletion."
      : error === "storage"
        ? "A stored document could not be deleted. Nothing was removed. Try again once storage is available."
        : error === "delete"
          ? "The account could not be deleted. Try again."
          : error === "totp"
            ? "That authenticator code was not accepted."
            : totp === "on"
              ? "Authenticator is on."
              : totp === "off"
                ? "Authenticator is off."
                : "";
  return (
    <div>
      <SiteHeader authed name={session.name} admin={session.role === "ADMIN"} />
      <div className="mx-auto max-w-3xl px-6 py-10">
        <h1 className="text-4xl">Account</h1>
        <p className="sans mt-2 text-sm text-[#5c6773]">{session.email}</p>
        {message ? <p className="sans mt-3 text-sm text-[#1f4e46]">{message}</p> : null}
        <Card className="mt-8">
          <p className="font-medium">Authenticator</p>
          <p className="sans mt-2 text-sm text-[#5c6773]">
            {user?.totpEnabled
              ? "A code is required each time you sign in with email or Google."
              : "Turn this on before you store tax documents. Add the secret to an authenticator app, then confirm a code."}
          </p>
          {user?.totpEnabled ? (
            <form action={disableTotpAction} className="mt-4 space-y-3">
              <Input name="code" inputMode="numeric" autoComplete="one-time-code" placeholder="6-digit code" aria-label="Authenticator code" required />
              <Button type="submit" variant="outline">
                Turn off authenticator
              </Button>
            </form>
          ) : setupSecret ? (
            <form action={confirmTotpAction} className="mt-4 space-y-3">
              <p className="sans break-all text-sm">Secret: {setupSecret}</p>
              <p className="sans break-all text-xs text-[#5c6773]">{totpUri(setupSecret, session.email)}</p>
              <Input name="code" inputMode="numeric" autoComplete="one-time-code" placeholder="6-digit code" aria-label="Authenticator code" required />
              <Button type="submit">Confirm authenticator</Button>
            </form>
          ) : (
            <form action={beginTotpAction} className="mt-4">
              <Button type="submit" variant="outline">
                Set up authenticator
              </Button>
            </form>
          )}
        </Card>
        <Card className="mt-4">
          <p className="font-medium">Export your data</p>
          <p className="sans mt-2 text-sm text-[#5c6773]">
            Download a JSON copy of your profile, returns, and payments. Passwords, authenticator secrets, and document files are not included.
          </p>
          <Link href="/api/account/export" className="mt-4 inline-block">
            <Button variant="outline">Download export</Button>
          </Link>
        </Card>
        <Card className="mt-4">
          <p className="font-medium">Delete account</p>
          <p className="sans mt-2 text-sm text-[#5c6773]">
            This deletes your user, returns, and uploaded documents. It cannot be undone. Type your email to confirm.
          </p>
          {error && error !== "totp" ? <p className="sans mt-3 text-sm text-red-800">{message}</p> : null}
          <form action={deleteAccountAction} className="mt-4 space-y-3">
            <Input name="confirm" type="email" autoComplete="off" placeholder={session.email} aria-label="Confirm email" required />
            <Button type="submit" variant="outline">
              Delete my account
            </Button>
          </form>
        </Card>
        <p className="sans mt-6 text-sm">
          <Link href="/privacy" className="text-[#1f4e46]">
            Privacy notice
          </Link>
        </p>
      </div>
    </div>
  );
}
