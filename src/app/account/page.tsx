import Link from "next/link";
import { redirect } from "next/navigation";
import { deleteAccountAction } from "@/app/account-actions";
import { SiteHeader } from "@/components/site-header";
import { Button, Card, Input } from "@/components/ui";
import { getSession } from "@/lib/auth";

export default async function AccountPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const session = await getSession();
  if (!session) redirect("/login");
  const { error } = await searchParams;
  const message =
    error === "confirm"
      ? "Type your email address exactly to confirm deletion."
      : error === "storage"
        ? "A stored document could not be deleted. Nothing was removed. Try again once storage is available."
        : error === "delete"
          ? "The account could not be deleted. Try again."
          : "";
  return (
    <div>
      <SiteHeader authed name={session.name} admin={session.role === "ADMIN"} />
      <div className="mx-auto max-w-3xl px-6 py-10">
        <h1 className="text-4xl">Account</h1>
        <p className="sans mt-2 text-sm text-[#5c6773]">{session.email}</p>
        <Card className="mt-8">
          <p className="font-medium">Export your data</p>
          <p className="sans mt-2 text-sm text-[#5c6773]">
            Download a JSON copy of your profile, returns, and payments. Passwords, one-time secrets, and document files are not included.
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
          {message ? <p className="sans mt-3 text-sm text-red-800">{message}</p> : null}
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
