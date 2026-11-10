import { PrismaClient } from "@prisma/client";

const email = String(process.argv[2] || "").trim().toLowerCase();

if (!email.includes("@") || email.endsWith("@taxpilot.local")) {
  console.error("Usage: CONFIRM_ADMIN=yes npx tsx scripts/promote-admin.ts you@example.com");
  process.exit(1);
}

if (process.env.CONFIRM_ADMIN !== "yes") {
  console.error("Refusing to change roles. Set CONFIRM_ADMIN=yes.");
  process.exit(1);
}

const prisma = new PrismaClient();

async function main() {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    console.error("No user with that email.");
    process.exit(1);
  }
  await prisma.user.update({ where: { id: user.id }, data: { role: "ADMIN" } });
  console.log(`Promoted ${email} to ADMIN.`);
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "promote failed");
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
