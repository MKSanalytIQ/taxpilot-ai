import { createHmac } from "node:crypto";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { isProUser, requireProAccess } from "@/lib/plan";
import {
  CHECKOUT_NAME,
  DEV_FALLBACK_PRICE_INR,
  PAYMENT_CURRENCY,
  PAYMENT_PROVIDER,
  PAYMENT_STATUS_CREATED,
  PAYMENT_STATUS_PAID,
  PAYMENT_SUCCESS_DETAIL,
  PAYMENT_SUCCESS_HEADING,
  PAYMENT_VERIFY_FAILED,
  createProOrderWith,
  inrToPaise,
  publicCheckoutPayload,
  type PaymentRecord,
  type PaymentStore,
  type RazorpayOrders,
  verifyProPaymentWith,
  verifyRazorpaySignature,
} from "@/lib/payment";

const SECRET = "test_razorpay_secret";
const KEY_ID = "rzp_test_public";
const PRICE_INR = 499;

function src(rel: string) {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

function sign(orderId: string, paymentId: string, secret = SECRET) {
  return createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");
}

function createMemory(seedUsers: string[] = ["user-a"]) {
  const payments: PaymentRecord[] = [];
  const plans = new Map<string, { plan: string; status: string }>();
  const returns = new Map<string, { id: string; calculationJson: string }>();
  let activateCalls = 0;
  for (const userId of seedUsers) {
    plans.set(userId, { plan: "FREE", status: "ACTIVE" });
    returns.set(userId, { id: `ret-${userId}`, calculationJson: '{"totalTax":12000}' });
  }
  const orders: Array<{ amount: number; currency: string }> = [];
  const razorpay: RazorpayOrders = {
    async createOrder(input) {
      orders.push({ amount: input.amount, currency: input.currency });
      return { id: `order_${orders.length}`, amount: input.amount, currency: input.currency };
    },
  };
  const store: PaymentStore = {
    async createPayment(data) {
      const row: PaymentRecord = { id: `pay_${payments.length + 1}`, ...data };
      payments.push(row);
      return row;
    },
    async findByOrderId(orderId) {
      return payments.find((row) => row.providerRef === orderId) ?? null;
    },
    async markPaid(id) {
      const row = payments.find((item) => item.id === id);
      if (!row) throw new Error("missing payment");
      row.status = PAYMENT_STATUS_PAID;
      return row;
    },
    async activatePro(userId) {
      activateCalls += 1;
      plans.set(userId, { plan: "PRO", status: "ACTIVE" });
    },
    async completePaidPro(paymentId, userId) {
      const row = payments.find((item) => item.id === paymentId);
      if (!row) throw new Error("missing payment");
      const previousStatus = row.status;
      const previousPlan = plans.get(userId);
      try {
        row.status = PAYMENT_STATUS_PAID;
        activateCalls += 1;
        plans.set(userId, { plan: "PRO", status: "ACTIVE" });
      } catch (error) {
        row.status = previousStatus;
        if (previousPlan) plans.set(userId, previousPlan);
        throw error;
      }
    },
  };
  return {
    store,
    razorpay,
    payments,
    plans,
    returns,
    orders,
    activateCount: () => activateCalls,
  };
}

const originalEnv = { ...process.env };

describe("Phase 15 one-time Razorpay Pro upgrade", () => {
  beforeEach(() => {
    process.env.RAZORPAY_KEY_ID = KEY_ID;
    process.env.RAZORPAY_KEY_SECRET = SECRET;
    process.env.PRO_PRICE_INR = String(PRICE_INR);
    Reflect.set(process.env, "NODE_ENV", "test");
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  });

  it("TEST 1: unauthenticated user cannot create a payment order", async () => {
    const mem = createMemory();
    const result = await createProOrderWith({ store: mem.store, razorpay: mem.razorpay }, "");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
    }
    expect(mem.payments).toHaveLength(0);
    expect(src("src/app/api/payment/create-order/route.ts")).toContain("authed()");
    expect(src("src/app/api/payment/create-order/route.ts")).toContain("if (!session) return error");
  });

  it("TEST 2: authenticated Free user can create an order", async () => {
    const mem = createMemory();
    const result = await createProOrderWith({ store: mem.store, razorpay: mem.razorpay }, "user-a");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.checkout.orderId).toMatch(/^order_/);
    expect(result.checkout.currency).toBe(PAYMENT_CURRENCY);
    expect(result.checkout.name).toBe(CHECKOUT_NAME);
    expect(result.payment.userId).toBe("user-a");
    expect(result.payment.status).toBe(PAYMENT_STATUS_CREATED);
    expect(isProUser(mem.plans.get("user-a"))).toBe(false);
  });

  it("TEST 3: client cannot choose a different payment amount", async () => {
    const mem = createMemory();
    const result = await createProOrderWith({ store: mem.store, razorpay: mem.razorpay }, "user-a", {
      amount: 1,
      currency: "USD",
      plan: "ITR3",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const expected = inrToPaise(PRICE_INR);
    expect(result.checkout.amount).toBe(expected);
    expect(result.payment.amount).toBe(expected);
    expect(mem.orders[0]?.amount).toBe(expected);
    expect(mem.orders[0]?.currency).toBe("INR");
    expect(src("src/app/api/payment/create-order/route.ts")).toContain("createProOrderWith");
    expect(src("src/lib/payment.ts")).toContain("void clientBody");
  });

  it("TEST 4: order is associated with the authenticated user", async () => {
    const mem = createMemory(["user-a", "user-b"]);
    const result = await createProOrderWith({ store: mem.store, razorpay: mem.razorpay }, "user-a");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payment.userId).toBe("user-a");
    expect(result.payment.provider).toBe(PAYMENT_PROVIDER);
    const found = await mem.store.findByOrderId(result.checkout.orderId);
    expect(found?.userId).toBe("user-a");
  });

  it("TEST 5: valid Razorpay signature is accepted", async () => {
    const mem = createMemory();
    const created = await createProOrderWith({ store: mem.store, razorpay: mem.razorpay }, "user-a");
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const paymentId = "pay_valid";
    const signature = sign(created.checkout.orderId, paymentId);
    expect(verifyRazorpaySignature({ orderId: created.checkout.orderId, paymentId, signature, secret: SECRET })).toBe(true);
    const verified = await verifyProPaymentWith(
      { store: mem.store, secret: SECRET },
      {
        userId: "user-a",
        razorpay_order_id: created.checkout.orderId,
        razorpay_payment_id: paymentId,
        razorpay_signature: signature,
      },
    );
    expect(verified.ok).toBe(true);
  });

  it("TEST 6: invalid signature is rejected", async () => {
    const mem = createMemory();
    const created = await createProOrderWith({ store: mem.store, razorpay: mem.razorpay }, "user-a");
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const verified = await verifyProPaymentWith(
      { store: mem.store, secret: SECRET },
      {
        userId: "user-a",
        razorpay_order_id: created.checkout.orderId,
        razorpay_payment_id: "pay_bad",
        razorpay_signature: "not-a-valid-signature",
      },
    );
    expect(verified.ok).toBe(false);
    if (!verified.ok) {
      expect(verified.status).toBe(400);
      expect(verified.error).toBe(PAYMENT_VERIFY_FAILED);
    }
  });

  it("TEST 7: invalid signature does not activate Pro", async () => {
    const mem = createMemory();
    const created = await createProOrderWith({ store: mem.store, razorpay: mem.razorpay }, "user-a");
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    await verifyProPaymentWith(
      { store: mem.store, secret: SECRET },
      {
        userId: "user-a",
        razorpay_order_id: created.checkout.orderId,
        razorpay_payment_id: "pay_bad",
        razorpay_signature: "ffff",
      },
    );
    expect(isProUser(mem.plans.get("user-a"))).toBe(false);
    expect(mem.payments[0]?.status).toBe(PAYMENT_STATUS_CREATED);
    expect(mem.activateCount()).toBe(0);
  });

  it("TEST 8: successful verified payment activates Pro", async () => {
    const mem = createMemory();
    const created = await createProOrderWith({ store: mem.store, razorpay: mem.razorpay }, "user-a");
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const paymentId = "pay_ok";
    const verified = await verifyProPaymentWith(
      { store: mem.store, secret: SECRET },
      {
        userId: "user-a",
        razorpay_order_id: created.checkout.orderId,
        razorpay_payment_id: paymentId,
        razorpay_signature: sign(created.checkout.orderId, paymentId),
      },
    );
    expect(verified.ok).toBe(true);
    expect(isProUser(mem.plans.get("user-a"))).toBe(true);
    expect(mem.payments[0]?.status).toBe(PAYMENT_STATUS_PAID);
    expect(requireProAccess(mem.plans.get("user-a")).allowed).toBe(true);
  });

  it("TEST 9: duplicate payment verification is idempotent", async () => {
    const mem = createMemory();
    const created = await createProOrderWith({ store: mem.store, razorpay: mem.razorpay }, "user-a");
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const paymentId = "pay_dup";
    const payload = {
      userId: "user-a",
      razorpay_order_id: created.checkout.orderId,
      razorpay_payment_id: paymentId,
      razorpay_signature: sign(created.checkout.orderId, paymentId),
    };
    const first = await verifyProPaymentWith({ store: mem.store, secret: SECRET }, payload);
    const second = await verifyProPaymentWith({ store: mem.store, secret: SECRET }, payload);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.alreadyPaid).toBe(true);
    expect(mem.payments).toHaveLength(1);
    expect(mem.activateCount()).toBe(1);
    expect(isProUser(mem.plans.get("user-a"))).toBe(true);
  });

  it("TEST 10: failed or cancelled payment does not activate Pro", async () => {
    const mem = createMemory();
    const created = await createProOrderWith({ store: mem.store, razorpay: mem.razorpay }, "user-a");
    expect(created.ok).toBe(true);
    expect(isProUser(mem.plans.get("user-a"))).toBe(false);
    const skipped = await verifyProPaymentWith(
      { store: mem.store, secret: SECRET },
      { userId: "user-a" },
    );
    expect(skipped.ok).toBe(false);
    expect(isProUser(mem.plans.get("user-a"))).toBe(false);
    expect(src("src/components/pro-checkout.tsx")).toContain("PAYMENT_NOT_COMPLETED");
    expect(src("src/components/pro-checkout.tsx")).toContain("ondismiss");
    expect(src("src/lib/payment-messages.ts")).toContain("Payment was not completed.");
  });

  it("TEST 11: User B cannot use User A's order to obtain Pro", async () => {
    const mem = createMemory(["user-a", "user-b"]);
    const created = await createProOrderWith({ store: mem.store, razorpay: mem.razorpay }, "user-a");
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const paymentId = "pay_stolen";
    const stolen = await verifyProPaymentWith(
      { store: mem.store, secret: SECRET },
      {
        userId: "user-b",
        razorpay_order_id: created.checkout.orderId,
        razorpay_payment_id: paymentId,
        razorpay_signature: sign(created.checkout.orderId, paymentId),
      },
    );
    expect(stolen.ok).toBe(false);
    if (!stolen.ok) expect(stolen.status).toBe(403);
    expect(isProUser(mem.plans.get("user-b"))).toBe(false);
    expect(isProUser(mem.plans.get("user-a"))).toBe(false);
    expect(mem.payments[0]?.status).toBe(PAYMENT_STATUS_CREATED);
  });

  it("TEST 12: payment secrets are never exposed to the client", async () => {
    const mem = createMemory();
    const result = await createProOrderWith({ store: mem.store, razorpay: mem.razorpay }, "user-a");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const payload = publicCheckoutPayload({
      ...result.checkout,
      prefillName: "Ada",
      prefillEmail: "ada@example.com",
    });
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain("RAZORPAY_KEY_SECRET");
    expect(payload).not.toHaveProperty("keySecret");
    expect(payload).not.toHaveProperty("secret");
    expect(payload.keyId).toBe(KEY_ID);
    const createRoute = src("src/app/api/payment/create-order/route.ts");
    expect(createRoute).toContain("publicCheckoutPayload");
    expect(createRoute).not.toMatch(/RAZORPAY_KEY_SECRET/);
    expect(src("src/components/pro-checkout.tsx")).not.toMatch(/RAZORPAY_KEY_SECRET/);
    expect(src("src/components/pro-checkout.tsx")).not.toMatch(/key_secret/);
  });

  it("TEST 13: existing Pro-only JSON access works after activation", async () => {
    const mem = createMemory();
    const created = await createProOrderWith({ store: mem.store, razorpay: mem.razorpay }, "user-a");
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    await verifyProPaymentWith(
      { store: mem.store, secret: SECRET },
      {
        userId: "user-a",
        razorpay_order_id: created.checkout.orderId,
        razorpay_payment_id: "pay_json",
        razorpay_signature: sign(created.checkout.orderId, "pay_json"),
      },
    );
    expect(requireProAccess(mem.plans.get("user-a")).allowed).toBe(true);
    const generate = src("src/app/json-actions.ts");
    expect(generate).toContain("getUserAccess");
    expect(generate).toContain("if (!access.canExport)");
    expect(src("src/app/api/returns/[id]/download-json/route.ts")).toContain("getUserAccess");
  });

  it("TEST 14: return data remains unchanged after payment", async () => {
    const mem = createMemory();
    const before = structuredClone(mem.returns.get("user-a"));
    const created = await createProOrderWith({ store: mem.store, razorpay: mem.razorpay }, "user-a");
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    await verifyProPaymentWith(
      { store: mem.store, secret: SECRET },
      {
        userId: "user-a",
        razorpay_order_id: created.checkout.orderId,
        razorpay_payment_id: "pay_return",
        razorpay_signature: sign(created.checkout.orderId, "pay_return"),
      },
    );
    expect(mem.returns.get("user-a")).toEqual(before);
    expect(src("src/lib/payment.ts")).not.toMatch(/taxReturn|TaxFacts|calculationJson/);
    expect(src("src/app/pricing/page.tsx")).toContain("PAYMENT_SUCCESS_HEADING");
    expect(src("src/app/pricing/page.tsx")).toContain("PAYMENT_SUCCESS_DETAIL");
    expect(src("src/lib/payment-messages.ts")).toContain(PAYMENT_SUCCESS_HEADING);
    expect(src("src/lib/payment-messages.ts")).toContain(PAYMENT_SUCCESS_DETAIL);
    expect(src("src/app/pricing/page.tsx")).toContain("Continue to your return");
    expect(src("src/app/pricing/page.tsx")).toContain("Upgrade to Pro");
    expect(src(".env.example")).toContain("RAZORPAY_KEY_ID=");
    expect(src(".env.example")).toContain("RAZORPAY_KEY_SECRET=");
    expect(src(".env.example")).toContain("PRO_PRICE_INR=");
    expect(DEV_FALLBACK_PRICE_INR).toBe(1);
  });
});
