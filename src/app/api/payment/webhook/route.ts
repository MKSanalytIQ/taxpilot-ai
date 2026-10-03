import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { applyRazorpayWebhook, parseRazorpayWebhook, prismaWebhookStore, verifyRazorpayWebhookSignature } from "@/lib/payment";

export async function POST(request: Request) {
  const secret = String(process.env.RAZORPAY_WEBHOOK_SECRET || "").trim();
  if (!secret) return NextResponse.json({ error: "Webhook is not configured" }, { status: 503 });
  const body = await request.text();
  const signature = request.headers.get("x-razorpay-signature") || "";
  if (!verifyRazorpayWebhookSignature(body, signature, secret)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }
  const decision = parseRazorpayWebhook(body);
  if (!decision) return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  if (decision.action !== "ignore") {
    await applyRazorpayWebhook(prismaWebhookStore(prisma), decision);
  }
  return NextResponse.json({ ok: true });
}
