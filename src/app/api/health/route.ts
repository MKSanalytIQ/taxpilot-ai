import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { productionReady } from "@/lib/production";

export async function GET() {
  try {
    await prisma.user.findFirst({ select: { id: true } });
    return NextResponse.json({ ok: true, db: "up", ready: productionReady() });
  } catch {
    return NextResponse.json({ ok: false, db: "down", ready: false }, { status: 503 });
  }
}