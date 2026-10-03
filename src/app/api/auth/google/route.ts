import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import {
  GOOGLE_STATE_COOKIE,
  buildGoogleAuthorizeUrl,
  createGoogleState,
  googleAppOrigin,
  googleClientId,
  googleRedirectUri,
  isGoogleConfigured,
} from "@/lib/google-auth";

function loginError(request: NextRequest) {
  const origin = googleAppOrigin(request.nextUrl.origin);
  if (!origin) return NextResponse.json({ error: "Google sign-in is unavailable" }, { status: 503 });
  return NextResponse.redirect(new URL("/login?error=google", origin));
}

export async function GET(request: NextRequest) {
  if (!isGoogleConfigured()) return loginError(request);
  const redirectUri = googleRedirectUri();
  const clientId = googleClientId();
  if (!redirectUri || !clientId) return loginError(request);
  const state = createGoogleState();
  const jar = await cookies();
  jar.set(GOOGLE_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 600,
  });
  return NextResponse.redirect(buildGoogleAuthorizeUrl({ clientId, redirectUri, state }));
}
