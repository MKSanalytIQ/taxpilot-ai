"use client";

import Link from "next/link";
import { useState } from "react";
import { logoutAction } from "@/app/actions";
import { Button } from "./ui";

function Logo({ authed, onNavigate }: { authed?: boolean; onNavigate?: () => void }) {
  return (
    <Link
      href={authed ? "/dashboard" : "/"}
      onClick={onNavigate}
      className="flex min-w-0 shrink-0 items-center"
      aria-label="TaxPilot AI"
    >
      {/* Square source; object-cover shows the centered mark without stretching. */}
      <img
        src="/taxpilot-ai-logo.png"
        alt="TaxPilot AI"
        width={180}
        height={52}
        className="h-10 w-[132px] max-w-full object-cover object-center sm:h-[52px] sm:w-[172px] md:h-[54px] md:w-[180px]"
      />
    </Link>
  );
}

export function SiteHeader({ authed, name, admin }: { authed?: boolean; name?: string; admin?: boolean }) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);

  const publicLinks = (
    <>
      <Link href="/how-it-works" onClick={close}>
        How it works
      </Link>
      <Link href="/pricing" onClick={close}>
        Pricing
      </Link>
      <Link href="/security" onClick={close}>
        Security
      </Link>
      <Link href="/faq" onClick={close}>
        FAQ
      </Link>
      <Link href="/privacy" onClick={close}>
        Privacy
      </Link>
      <Link href="/login" onClick={close}>
        Log in
      </Link>
      <Link href="/signup" onClick={close}>
        <Button className="w-full md:w-auto">Get started</Button>
      </Link>
    </>
  );

  const authedLinks = (
    <>
      <Link href="/dashboard" onClick={close}>
        Dashboard
      </Link>
      <Link href="/account" onClick={close}>
        Account
      </Link>
      {admin ? (
        <Link href="/admin" onClick={close}>
          Admin
        </Link>
      ) : null}
      {name ? <span className="truncate">{name}</span> : null}
      <form action={logoutAction}>
        <Button variant="outline" className="w-full md:w-auto">
          Sign out
        </Button>
      </form>
    </>
  );

  return (
    <header className="border-b border-[#e4ddd0] bg-[#fffcf7]">
      <div className="mx-auto flex min-w-0 max-w-6xl items-center justify-between gap-3 px-4 py-3 sm:px-6 sm:py-4">
        <Logo authed={authed} onNavigate={close} />
        <nav className="sans hidden min-w-0 items-center gap-5 text-sm text-[#5c6773] md:flex">{authed ? authedLinks : publicLinks}</nav>
        <button
          type="button"
          className="sans inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md border border-[#d7cfc0] bg-white text-lg text-[#102033] md:hidden"
          aria-label={open ? "Close menu" : "Open menu"}
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? "×" : "☰"}
        </button>
      </div>
      {open ? (
        <nav className="sans flex flex-col gap-1 border-t border-[#e4ddd0] px-4 py-3 text-sm text-[#5c6773] md:hidden">
          {authed ? authedLinks : publicLinks}
        </nav>
      ) : null}
    </header>
  );
}
