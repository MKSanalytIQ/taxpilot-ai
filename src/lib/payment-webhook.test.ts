import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  applyRazorpayWebhook,
  parseRazorpayWebhook,
  PAYMENT_STATUS_CREATED,
  PAYMENT_STATUS_FAILED,
  PAYMENT_STATUS_PAID,
  PAYMENT_STATUS_REFUNDED,
  verifyRazorpayWebhookSignature,
  type PaymentRecord,
  type WebhookStore,
} from "./payment";

function memoryStore(seed: PaymentRecord[]) {
  const rows = seed.map((row) => ({ ...row }));
  const status = new Map(rows.map((row) => [row.id, row.status]));
  const pro = new Set<string>();
  const calls = { paid: 0 };
  const store: WebhookStore = {
    async findByOrderId(orderId) {
      const row = rows.find((item) => item.providerRef === orderId) || null;
      if (!row) return null;
      return { ...row, status: status.get(row.id) || row.status };
    },
    async completePaidPro(paymentId, userId) {
      calls.paid += 1;
      status.set(paymentId, PAYMENT_STATUS_PAID);
      pro.add(userId);
    },
    async markStatus(id, next) {
      status.set(id, next);
    },
    async hasOtherPaid(userId, exceptPaymentId) {
      return rows.some((row) => row.userId === userId && row.id !== exceptPaymentId && status.get(row.id) === PAYMENT_STATUS_PAID);
    },
    async deactivatePro(userId) {
      pro.delete(userId);
    },
  };
  return { store, status, pro, calls };
}

const payment: PaymentRecord = {
  id: "payrow",
  userId: "user-a",
  provider: "RAZORPAY",
  providerRef: "order_1",
  amount: 49900,
  currency: "INR",
  status: PAYMENT_STATUS_CREATED,
};

describe("Razorpay webhook", () => {
  it("rejects a bad signature and accepts the raw-body signature", () => {
    const body = JSON.stringify({ event: "payment.captured" });
    const signature = createHmac("sha256", "whsec").update(body).digest("hex");
    expect(verifyRazorpayWebhookSignature(body, "0".repeat(signature.length), "whsec")).toBe(false);
    expect(verifyRazorpayWebhookSignature(body, signature, "whsec")).toBe(true);
  });

  it("activates Pro once, ignores a repeat, and does not trust a mismatched amount", async () => {
    const store = memoryStore([payment]);
    const paid = parseRazorpayWebhook(JSON.stringify({
      event: "payment.captured",
      payload: { payment: { entity: { id: "pay_1", order_id: "order_1", amount: 49900 } } },
    }));
    if (!paid || paid.action !== "paid") throw new Error("expected paid event");
    await applyRazorpayWebhook(store.store, paid);
    await applyRazorpayWebhook(store.store, paid);
    expect(store.calls.paid).toBe(1);
    expect(store.pro.has("user-a")).toBe(true);

    const mismatch = memoryStore([{ ...payment, id: "other", providerRef: "order_2" }]);
    await applyRazorpayWebhook(mismatch.store, { action: "paid", orderId: "order_2", amount: 100 });
    expect(mismatch.calls.paid).toBe(0);
    expect(mismatch.pro.has("user-a")).toBe(false);
  });

  it("records a failed payment without overriding a captured one", async () => {
    const store = memoryStore([payment]);
    await applyRazorpayWebhook(store.store, { action: "failed", orderId: "order_1" });
    expect(store.status.get("payrow")).toBe(PAYMENT_STATUS_FAILED);
    store.status.set("payrow", PAYMENT_STATUS_PAID);
    await applyRazorpayWebhook(store.store, { action: "failed", orderId: "order_1" });
    expect(store.status.get("payrow")).toBe(PAYMENT_STATUS_PAID);
  });

  it("downgrades on refund once and leaves Pro if another payment is still paid", async () => {
    const store = memoryStore([
      { ...payment, status: PAYMENT_STATUS_PAID },
      { ...payment, id: "payrow-2", providerRef: "order_2", status: PAYMENT_STATUS_PAID },
    ]);
    store.pro.add("user-a");
    await applyRazorpayWebhook(store.store, { action: "refunded", orderId: "order_1" });
    await applyRazorpayWebhook(store.store, { action: "refunded", orderId: "order_1" });
    expect(store.status.get("payrow")).toBe(PAYMENT_STATUS_REFUNDED);
    expect(store.pro.has("user-a")).toBe(true);
    await applyRazorpayWebhook(store.store, { action: "refunded", orderId: "order_2" });
    expect(store.pro.has("user-a")).toBe(false);
  });
});
