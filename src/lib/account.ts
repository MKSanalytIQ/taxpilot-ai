export type AccountExportInput = {
  email: string;
  name: string;
  createdAt: Date | string;
  profile: unknown;
  returns: unknown[];
  payments: Array<{ amount: number; currency: string; status: string; createdAt: Date | string }>;
};

const SECRET_KEYS = new Set(["passwordHash", "totpSecret", "token", "storageKey"]);

function strip(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strip);
  if (!value || typeof value !== "object" || value instanceof Date) return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    if (SECRET_KEYS.has(key)) continue;
    out[key] = strip(inner);
  }
  return out;
}

export function buildAccountExport(input: AccountExportInput) {
  return {
    exportedAt: new Date().toISOString(),
    account: {
      email: input.email,
      name: input.name,
      createdAt: input.createdAt instanceof Date ? input.createdAt.toISOString() : input.createdAt,
    },
    profile: strip(input.profile),
    returns: strip(input.returns),
    payments: input.payments.map((payment) => ({
      amount: payment.amount,
      currency: payment.currency,
      status: payment.status,
      createdAt: payment.createdAt instanceof Date ? payment.createdAt.toISOString() : payment.createdAt,
    })),
    note: "Document files are deleted with the account and are not included in this export. Passwords and storage keys are omitted.",
  };
}
