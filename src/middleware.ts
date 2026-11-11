import { jwtVerify } from "jose";
import { NextRequest, NextResponse } from "next/server";
import { authSecretBytes } from "./lib/production";
import { sessionStampAllows } from "./lib/session-revocation";

async function hasSession(token: string | undefined) {
  if (!token) return false;
  try {
    const { payload } = await jwtVerify(token, authSecretBytes());
    if (!payload.userId || payload.purpose === "totp" || payload.purpose === "totp-setup") return false;
    return sessionStampAllows(String(payload.userId), typeof payload.pwd === "string" ? payload.pwd : undefined);
  } catch {
    return false;
  }
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const session = request.cookies.get("tp_session")?.value;
  const needsAuth =
    pathname.startsWith("/dashboard") ||
    pathname.startsWith("/returns") ||
    pathname.startsWith("/admin") ||
    pathname.startsWith("/account") ||
    pathname.startsWith("/api/");
  const publicApi =
    pathname.startsWith("/api/health") ||
    pathname.startsWith("/api/auth/google") ||
    pathname === "/api/payment/webhook";
  if (needsAuth && !publicApi && !(await hasSession(session))) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const login = new URL("/login", request.url);
    login.searchParams.set("next", pathname);
    return NextResponse.redirect(login);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/dashboard/:path*", "/returns/:path*", "/admin/:path*", "/account", "/account/:path*", "/api/:path*"],
};
