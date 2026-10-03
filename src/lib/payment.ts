import { createHmac, timingSafeEqual } from "node:crypto";
import { PLAN_PRO } from "./plan";
import {
  PAYMENT_UNAVAILABLE,
  PAYMENT_VERIFY_FAILED,
} from "./payment-messages";

export {
  PAYMENT_NOT_COMPLETED,
  PAYMENT_VERIFY_FAILED,
  PAYMENT_UNAVAILABLE,
  PAYMENT_SUCCESS_HEADING,
  PAYMENT_SUCCESS_DETAIL,
} from "./payment-messages";

export const PAYMENT_PROVIDER = "RAZORPAY";
export const PAYMENT_STATUS_CREATED = "CREATED";
export const PAYMENT_STATUS_PAID = "PAID";
export const PAYMENT_CURRENCY = "INR";
export const CHECKOUT_NAME = "Pro";
/** Development-only fallback when PRO_PRICE_INR is unset. Never used in production. */
export const DEV_FALLBACK_PRICE_INR = 1;

export type PaymentRecord = {
  id: string;
  userId: string;
  provider: string;
  providerRef: string;
  amount: number;
  currency: string;
  status: string;
};

export type PaymentStore = {
  createPayment(data: {
    userId: string;
    provider: string;
    providerRef: string;
    amount: number;
    currency: string;
    status: string;
  }): Promise<PaymentRecord>;
  findByOrderId(orderId: string): Promise<PaymentRecord | null>;
  markPaid(id: string): Promise<PaymentRecord>;
  activatePro(userId: string): Promise<void>;
  completePaidPro(paymentId: string, userId: string): Promise<void>;
};

export type RazorpayOrderInput = {
  amount: number;
  currency: string;
  receipt: string;
  notes: Record<string, string>;
};

export type RazorpayOrders = {
  createOrder(input: RazorpayOrderInput): Promise<{ id: string; amount: number; currency: string }>;
};

export type CheckoutPayload = {
  orderId: string;
  amount: number;
  currency: string;
  keyId: string;
  name: string;
  description: string;
  prefillName?: string;
  prefillEmail?: string;
};

export function isRazorpayConfigured() {
  return Boolean(process.env.RAZORPAY_KEY_ID?.trim() && process.env.RAZORPAY_KEY_SECRET?.trim());
}

export function razorpayPublicKey() {
  return String(process.env.RAZORPAY_KEY_ID || "").trim();
}

export function inrToPaise(inr: number) {
  return Math.round(inr * 100);
}

export function resolveProPriceInr(): { ok: true; amountInr: number } | { ok: false; error: string } {
  const raw = String(process.env.PRO_PRICE_INR || "").trim();
  const parsed = Number(raw);
  if (raw && Number.isFinite(parsed) && parsed > 0) {
    return { ok: true, amountInr: Math.round(parsed) };
  }
  if (process.env.NODE_ENV !== "production") {
    return { ok: true, amountInr: DEV_FALLBACK_PRICE_INR };
  }
  return { ok: false, error: PAYMENT_UNAVAILABLE };
}

export function displayProPriceLabel() {
  const price = resolveProPriceInr();
  if (!price.ok) return "";
  return `₹${price.amountInr}`;
}

export function publicCheckoutPayload(input: CheckoutPayload): CheckoutPayload {
  return {
    orderId: input.orderId,
    amount: input.amount,
    currency: input.currency,
    keyId: input.keyId,
    name: CHECKOUT_NAME,
    description: input.description || CHECKOUT_NAME,
    prefillName: input.prefillName || "",
    prefillEmail: input.prefillEmail || "",
  };
}

export function verifyRazorpaySignature(input: {
  orderId: string;
  paymentId: string;
  signature: string;
  secret?: string;
}) {
  const secret = input.secret ?? String(process.env.RAZORPAY_KEY_SECRET || "");
  if (!secret || !input.orderId || !input.paymentId || !input.signature) return false;
  const expected = createHmac("sha256", secret).update(`${input.orderId}|${input.paymentId}`).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(String(input.signature));
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function createProOrderWith(
  deps: { store: PaymentStore; razorpay: RazorpayOrders },
  userId: string,
  clientBody?: unknown,
): Promise<
  | { ok: true; checkout: CheckoutPayload; payment: PaymentRecord }
  | { ok: false; status: number; error: string }
> {
  void clientBody;

  if (!userId) return { ok: false, status: 401, error: "Unauthorized" };
  const price = resolveProPriceInr();
  if (!price.ok) return { ok: false, status: 503, error: price.error };
  const amount = inrToPaise(price.amountInr);
  const order = await deps.razorpay.createOrder({
    amount,
    currency: PAYMENT_CURRENCY,
    receipt: `tp${userId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 18)}${Date.now().toString(36)}`.slice(0, 40),
    notes: { plan: PLAN_PRO },
  });
  const payment = await deps.store.createPayment({
    userId,
    provider: PAYMENT_PROVIDER,
    providerRef: order.id,
    amount,
    currency: PAYMENT_CURRENCY,
    status: PAYMENT_STATUS_CREATED,
  });
  return {
    ok: true,
    payment,
    checkout: publicCheckoutPayload({
      orderId: order.id,
      amount,
      currency: PAYMENT_CURRENCY,
      keyId: razorpayPublicKey(),
      name: CHECKOUT_NAME,
      description: CHECKOUT_NAME,
    }),
  };
}

export async function verifyProPaymentWith(
  deps: { store: PaymentStore; secret?: string },
  input: {
    userId: string;
    razorpay_order_id?: string;
    razorpay_payment_id?: string;
    razorpay_signature?: string;
  },
): Promise<{ ok: true; alreadyPaid: boolean } | { ok: false; status: number; error: string }> {
  if (!input.userId) return { ok: false, status: 401, error: "Unauthorized" };
  const orderId = String(input.razorpay_order_id || "").trim();
  const paymentId = String(input.razorpay_payment_id || "").trim();
  const signature = String(input.razorpay_signature || "").trim();
  if (!orderId || !paymentId || !signature) {
    return { ok: false, status: 400, error: PAYMENT_VERIFY_FAILED };
  }
  const payment = await deps.store.findByOrderId(orderId);
  if (!payment) return { ok: false, status: 400, error: PAYMENT_VERIFY_FAILED };
  if (payment.userId !== input.userId) {
    return { ok: false, status: 403, error: PAYMENT_VERIFY_FAILED };
  }
  if (payment.status === PAYMENT_STATUS_PAID) {
    return { ok: true, alreadyPaid: true };
  }
  const valid = verifyRazorpaySignature({
    orderId,
    paymentId,
    signature,
    secret: deps.secret ?? process.env.RAZORPAY_KEY_SECRET,
  });
  if (!valid) return { ok: false, status: 400, error: PAYMENT_VERIFY_FAILED };
  try {
    await deps.store.completePaidPro(payment.id, payment.userId);
  } catch {
    return { ok: false, status: 500, error: PAYMENT_VERIFY_FAILED };
  }
  return { ok: true, alreadyPaid: false };
}

export function liveRazorpay(): RazorpayOrders {
  return {
    async createOrder(input) {
      const keyId = String(process.env.RAZORPAY_KEY_ID || "").trim();
      const secret = String(process.env.RAZORPAY_KEY_SECRET || "").trim();
      if (!keyId || !secret) throw new Error("RAZORPAY_NOT_CONFIGURED");
      const auth = Buffer.from(`${keyId}:${secret}`).toString("base64");
      const res = await fetch("https://api.razorpay.com/v1/orders", {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          amount: input.amount,
          currency: input.currency,
          receipt: input.receipt,
          notes: input.notes,
        }),
      });
      if (!res.ok) throw new Error("RAZORPAY_ORDER_FAILED");
      const data = (await res.json()) as { id?: string; amount?: number; currency?: string };
      if (!data.id) throw new Error("RAZORPAY_ORDER_FAILED");
      return { id: String(data.id), amount: Number(data.amount), currency: String(data.currency || PAYMENT_CURRENCY) };
    },
  };
}

export function prismaPaymentStore(prisma: {
  $transaction: (ops: unknown[]) => Promise<unknown>;
  payment: {
    create: (args: { data: Omit<PaymentRecord, "id"> }) => Promise<PaymentRecord>;
    findFirst: (args: { where: { provider: string; providerRef: string } }) => Promise<PaymentRecord | null>;
    update: (args: { where: { id: string }; data: { status: string } }) => Promise<PaymentRecord>;
  };
  subscription: {
    upsert: (args: {
      where: { userId: string };
      create: { userId: string; plan: string; status: string; billingProvider: string };
      update: { plan: string; status: string; billingProvider: string };
    }) => Promise<unknown>;
  };
}): PaymentStore {
  return {
    createPayment: (data) => prisma.payment.create({ data }),
    findByOrderId: (orderId) =>
      prisma.payment.findFirst({ where: { provider: PAYMENT_PROVIDER, providerRef: orderId } }),
    markPaid: (id) => prisma.payment.update({ where: { id }, data: { status: PAYMENT_STATUS_PAID } }),
    activatePro: async (userId) => {
      await prisma.subscription.upsert({
        where: { userId },
        create: { userId, plan: PLAN_PRO, status: "ACTIVE", billingProvider: PAYMENT_PROVIDER },
        update: { plan: PLAN_PRO, status: "ACTIVE", billingProvider: PAYMENT_PROVIDER },
      });
    },
    completePaidPro: async (paymentId, userId) => {
      await prisma.$transaction([
        prisma.payment.update({ where: { id: paymentId }, data: { status: PAYMENT_STATUS_PAID } }),
        prisma.subscription.upsert({
          where: { userId },
          create: { userId, plan: PLAN_PRO, status: "ACTIVE", billingProvider: PAYMENT_PROVIDER },
          update: { plan: PLAN_PRO, status: "ACTIVE", billingProvider: PAYMENT_PROVIDER },
        }),
      ]);
    },
  };
}

export const PAYMENT_STATUS_FAILED = "FAILED";
export const PAYMENT_STATUS_REFUNDED = "REFUNDED";

export type RazorpayWebhookDecision =
  | { action: "ignore" }
  | { action: "paid"; orderId: string; amount: number | null }
  | { action: "failed"; orderId: string }
  | { action: "refunded"; orderId: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  return value as Record<string, unknown>;
}

function webhookEntity(body: Record<string, unknown>, name: string) {
  const payload = asRecord(body.payload);
  const node = asRecord(payload?.[name]);
  return asRecord(node?.entity);
}

export function verifyRazorpayWebhookSignature(body: string, signature: string, secret?: string) {
  const key = secret ?? String(process.env.RAZORPAY_WEBHOOK_SECRET || "");
  if (!key || !body || !signature) return false;
  const expected = createHmac("sha256", key).update(body).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function parseRazorpayWebhook(body: string): RazorpayWebhookDecision | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const root = asRecord(parsed);
  if (!root) return null;
  const event = String(root.event || "");
  const payment = webhookEntity(root, "payment");
  const order = webhookEntity(root, "order");
  const orderId = String(payment?.order_id || order?.id || "").trim();
  const amount = typeof payment?.amount === "number" ? payment.amount : null;
  if (event === "payment.captured" || event === "order.paid") {
    if (!orderId) return null;
    return { action: "paid", orderId, amount };
  }
  if (event === "payment.failed") {
    if (!orderId) return null;
    return { action: "failed", orderId };
  }
  if (event === "refund.processed" || event === "payment.refunded") {
    if (!orderId) return null;
    return { action: "refunded", orderId };
  }
  return { action: "ignore" };
}

export type WebhookStore = {
  findByOrderId(orderId: string): Promise<PaymentRecord | null>;
  completePaidPro(paymentId: string, userId: string): Promise<void>;
  markStatus(id: string, status: string): Promise<void>;
  hasOtherPaid(userId: string, exceptPaymentId: string): Promise<boolean>;
  deactivatePro(userId: string): Promise<void>;
};

/** Idempotent. A repeated event does not create another payment or re-upgrade a refund. */
export async function applyRazorpayWebhook(store: WebhookStore, decision: Exclude<RazorpayWebhookDecision, { action: "ignore" }>) {
  const payment = await store.findByOrderId(decision.orderId);
  if (!payment || payment.provider !== PAYMENT_PROVIDER) return;
  if (decision.action === "paid") {
    if (payment.status === PAYMENT_STATUS_PAID || payment.status === PAYMENT_STATUS_REFUNDED) return;
    if (decision.amount == null || decision.amount !== payment.amount) return;
    await store.completePaidPro(payment.id, payment.userId);
    return;
  }
  if (decision.action === "failed") {
    if (payment.status !== PAYMENT_STATUS_CREATED) return;
    await store.markStatus(payment.id, PAYMENT_STATUS_FAILED);
    return;
  }
  if (payment.status === PAYMENT_STATUS_REFUNDED) return;
  await store.markStatus(payment.id, PAYMENT_STATUS_REFUNDED);
  if (!(await store.hasOtherPaid(payment.userId, payment.id))) await store.deactivatePro(payment.userId);
}

export function prismaWebhookStore(prisma: {
  payment: {
    findFirst: (args: { where: { provider: string; providerRef: string } }) => Promise<PaymentRecord | null>;
    findMany: (args: { where: { userId: string; status: string; id: { not: string } }; select: { id: true } }) => Promise<{ id: string }[]>;
    update: (args: { where: { id: string }; data: { status: string } }) => Promise<PaymentRecord>;
  };
  subscription: {
    upsert: (args: {
      where: { userId: string };
      create: { userId: string; plan: string; status: string; billingProvider: string };
      update: { plan: string; status: string; billingProvider: string };
    }) => Promise<unknown>;
  };
}): WebhookStore {
  return {
    findByOrderId: (orderId) => prisma.payment.findFirst({ where: { provider: PAYMENT_PROVIDER, providerRef: orderId } }),
    completePaidPro: async (paymentId, userId) => {
      await prisma.payment.update({ where: { id: paymentId }, data: { status: PAYMENT_STATUS_PAID } });
      await prisma.subscription.upsert({
        where: { userId },
        create: { userId, plan: PLAN_PRO, status: "ACTIVE", billingProvider: PAYMENT_PROVIDER },
        update: { plan: PLAN_PRO, status: "ACTIVE", billingProvider: PAYMENT_PROVIDER },
      });
    },
    markStatus: async (id, status) => {
      await prisma.payment.update({ where: { id }, data: { status } });
    },
    hasOtherPaid: async (userId, exceptPaymentId) => {
      const rows = await prisma.payment.findMany({
        where: { userId, status: PAYMENT_STATUS_PAID, id: { not: exceptPaymentId } },
        select: { id: true },
      });
      return rows.length > 0;
    },
    deactivatePro: async (userId) => {
      await prisma.subscription.upsert({
        where: { userId },
        create: { userId, plan: "FREE", status: "ACTIVE", billingProvider: "NONE" },
        update: { plan: "FREE", status: "ACTIVE", billingProvider: "NONE" },
      });
    },
  };
}
