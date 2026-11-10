import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { buildAccountExport } from "@/lib/account";

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    include: {
      profile: true,
      payments: { orderBy: { createdAt: "desc" } },
      returns: { orderBy: { updatedAt: "desc" } },
    },
  });
  if (!user) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const body = buildAccountExport({
    email: user.email,
    name: user.name,
    createdAt: user.createdAt,
    profile: user.profile,
    returns: user.returns,
    payments: user.payments.map((payment) => ({
      amount: payment.amount,
      currency: payment.currency,
      status: payment.status,
      createdAt: payment.createdAt,
    })),
  });
  return new NextResponse(JSON.stringify(body, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": 'attachment; filename="taxpilot-account.json"',
      "Cache-Control": "private, no-store",
    },
  });
}
