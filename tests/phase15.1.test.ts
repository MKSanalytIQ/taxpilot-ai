import { createHmac } from "node:crypto";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { isProUser } from "@/lib/plan";
import {
  completeGoogleLoginWith,
  googleAppOrigin,
  googlePublicConfig,
  googleRedirectUri,
  isGoogleConfigured,
  GOOGLE_BUTTON_LABEL,
  GOOGLE_ERROR_MESSAGE,
  type GoogleAuthStore,
  type GoogleIdentity,
} from "@/lib/google-auth";
import {
  PAYMENT_STATUS_CREATED,
  PAYMENT_STATUS_PAID,
  PAYMENT_VERIFY_FAILED,
  createProOrderWith,
  type PaymentRecord,
  type PaymentStore,
  type RazorpayOrders,
  verifyProPaymentWith,
} from "@/lib/payment";

function src(rel: string) {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

function sign(orderId: string, paymentId: string, secret = "test_razorpay_secret") {
  return createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");
}

function googleStore(seed?: { id: string; email: string }) {
  const users = new Map<string, { id: string; email: string; name: string; passwordHash: string }>();
  const plans = new Map<string, string>();
  if (seed) {
    users.set(seed.email, { id: seed.id, email: seed.email, name: "Existing", passwordHash: "hash" });
    plans.set(seed.id, "FREE");
  }
  const store: GoogleAuthStore = {
    findUserByEmail: async (email) => users.get(email) ?? null,
    createUser: async (data) => {
      const id = `user-${users.size + 1}`;
      users.set(data.email, { id, ...data });
      return { id };
    },
    ensureFreeAccess: async (userId) => {
      plans.set(userId, "FREE");
    },
    hashPassword: async (password) => `hashed:${password.length}`,
  };
  return { store, users, plans };
}

const originalEnv = { ...process.env };

describe("Phase 15.1 Google login + Razorpay atomicity", () => {
  beforeEach(() => {
    process.env.GOOGLE_CLIENT_ID = "google-client";
    process.env.GOOGLE_CLIENT_SECRET = "google-secret";
    process.env.NEXT_PUBLIC_APP_URL = "https://app.taxpilot.test";
    process.env.RAZORPAY_KEY_ID = "rzp_test_public";
    process.env.RAZORPAY_KEY_SECRET = "test_razorpay_secret";
    process.env.PRO_PRICE_INR = "499";
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  });

  it("TEST 1: Google login configuration is loaded safely", () => {
    expect(isGoogleConfigured()).toBe(true);
    const pub = googlePublicConfig();
    expect(pub.configured).toBe(true);
    expect(JSON.stringify(pub)).not.toContain("google-secret");
    expect(googleRedirectUri()).toBe("https://app.taxpilot.test/api/auth/google/callback");
    delete process.env.GOOGLE_CLIENT_SECRET;
    expect(isGoogleConfigured()).toBe(false);
    expect(src("src/app/api/auth/google/route.ts")).toContain("isGoogleConfigured");
    expect(src("src/components/pro-checkout.tsx")).not.toMatch(/GOOGLE_CLIENT_SECRET/);
    expect(src("src/app/login/page.tsx")).not.toMatch(/GOOGLE_CLIENT_SECRET/);
    expect(src(".env.example")).toContain("GOOGLE_CLIENT_ID=");
    expect(src(".env.example")).toContain("GOOGLE_CLIENT_SECRET=");
  });

  it("production Google redirects do not fall back to localhost", () => {
    expect(googleAppOrigin("https://app.taxpilot.test", { nodeEnv: "production", appUrl: "" })).toBe("https://app.taxpilot.test");
    expect(googleAppOrigin("http://127.0.0.1:3002", { nodeEnv: "production", appUrl: "http://localhost:3002" })).toBe("");
    expect(googleAppOrigin("http://127.0.0.1:3002", { nodeEnv: "development", appUrl: "" })).toBe("http://127.0.0.1:3002");
  });

  it("TEST 2: successful Google authentication creates a TaxPilot session", async () => {
    const mem = googleStore();
    const identity: GoogleIdentity = {
      email: "ada@example.com",
      emailVerified: true,
      name: "Ada",
      sub: "sub-1",
    };
    const result = await completeGoogleLoginWith(mem.store, identity);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.created).toBe(true);
    expect(result.userId).toBeTruthy();
    expect(src("src/app/api/auth/google/callback/route.ts")).toContain("createSession");
    expect(src("src/app/api/auth/google/callback/route.ts")).toContain("completeGoogleLoginWith");
    expect(src("src/app/login/page.tsx")).toContain(GOOGLE_BUTTON_LABEL);
    expect(src("src/app/login/page.tsx")).toContain("/api/auth/google");
  });

  it("TEST 3: existing verified Google email matches existing TaxPilot account", async () => {
    const mem = googleStore({ id: "user-existing", email: "ada@example.com" });
    const result = await completeGoogleLoginWith(mem.store, {
      email: "Ada@example.com",
      emailVerified: true,
      name: "Ada Lovelace",
      sub: "sub-1",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.created).toBe(false);
    expect(result.userId).toBe("user-existing");
    expect(mem.users.size).toBe(1);
  });

  it("TEST 4: new Google user creates exactly one TaxPilot account", async () => {
    const mem = googleStore();
    const result = await completeGoogleLoginWith(mem.store, {
      email: "new@example.com",
      emailVerified: true,
      name: "New User",
      sub: "sub-new",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.created).toBe(true);
    expect(mem.users.size).toBe(1);
    expect(mem.plans.get(result.userId)).toBe("FREE");
  });

  it("TEST 5: Google authentication failure does not create an account", async () => {
    const mem = googleStore();
    const failed = await completeGoogleLoginWith(mem.store, {
      email: "fail@example.com",
      emailVerified: false,
      name: "Fail",
      sub: "sub-fail",
    });
    expect(failed.ok).toBe(false);
    expect(mem.users.size).toBe(0);
    expect(src("src/app/login/page.tsx")).toContain(GOOGLE_ERROR_MESSAGE);
    expect(src("src/app/api/auth/google/callback/route.ts")).toContain("/login?error=google");
  });

  it("TEST 6: existing email/password login still works", () => {
    const login = src("src/app/actions.ts");
    const start = login.indexOf("export async function loginAction");
    const next = login.indexOf("export async function ", start + 10);
    const body = login.slice(start, next === -1 ? undefined : next);
    expect(body).toContain("verifyPassword");
    expect(body).toContain("createSession");
    expect(src("src/app/login/page.tsx")).toContain("loginAction");
    expect(src("src/app/login/page.tsx")).toContain("Sign in");
    expect(src("src/app/login/page.tsx")).not.toContain("Forgot password?");
  });

  it("TEST 7: client cannot choose another user identity", async () => {
    const mem = googleStore();
    const result = await completeGoogleLoginWith(
      mem.store,
      { email: "real@example.com", emailVerified: true, name: "Real", sub: "sub-real" },
      { email: "attacker@example.com", userId: "user-attacker" },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(mem.users.has("real@example.com")).toBe(true);
    expect(mem.users.has("attacker@example.com")).toBe(false);
    expect(result.userId).not.toBe("user-attacker");
    expect(src("src/lib/google-auth.ts")).toContain("void clientHints");
    expect(src("src/app/api/auth/google/callback/route.ts")).toContain("verifyGoogleIdToken");
  });

  it("TEST 8: valid signature + successful transaction marks PAID and PRO", async () => {
    const payments: PaymentRecord[] = [];
    const plans = new Map([["user-a", { plan: "FREE", status: "ACTIVE" }]]);
    let activateCalls = 0;
    const store: PaymentStore = {
      createPayment: async (data) => {
        const row = { id: `pay_${payments.length + 1}`, ...data };
        payments.push(row);
        return row;
      },
      findByOrderId: async (orderId) => payments.find((row) => row.providerRef === orderId) ?? null,
      markPaid: async (id) => {
        const row = payments.find((item) => item.id === id)!;
        row.status = PAYMENT_STATUS_PAID;
        return row;
      },
      activatePro: async (userId) => {
        activateCalls += 1;
        plans.set(userId, { plan: "PRO", status: "ACTIVE" });
      },
      completePaidPro: async (paymentId, userId) => {
        const row = payments.find((item) => item.id === paymentId)!;
        row.status = PAYMENT_STATUS_PAID;
        activateCalls += 1;
        plans.set(userId, { plan: "PRO", status: "ACTIVE" });
      },
    };
    const razorpay: RazorpayOrders = {
      async createOrder(input) {
        return { id: "order_1", amount: input.amount, currency: input.currency };
      },
    };
    const created = await createProOrderWith({ store, razorpay }, "user-a");
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const verified = await verifyProPaymentWith(
      { store, secret: "test_razorpay_secret" },
      {
        userId: "user-a",
        razorpay_order_id: created.checkout.orderId,
        razorpay_payment_id: "pay_ok",
        razorpay_signature: sign(created.checkout.orderId, "pay_ok"),
      },
    );
    expect(verified.ok).toBe(true);
    expect(payments[0]?.status).toBe(PAYMENT_STATUS_PAID);
    expect(isProUser(plans.get("user-a"))).toBe(true);
    expect(activateCalls).toBe(1);
    expect(src("src/lib/payment.ts")).toContain("$transaction");
    expect(src("src/lib/payment.ts")).toContain("completePaidPro");
  });

  it("TEST 9: Pro activation failure rolls back the payment update", async () => {
    const payments: PaymentRecord[] = [];
    const plans = new Map([["user-a", { plan: "FREE", status: "ACTIVE" }]]);
    const store: PaymentStore = {
      createPayment: async (data) => {
        const row = { id: "pay_1", ...data };
        payments.push(row);
        return row;
      },
      findByOrderId: async (orderId) => payments.find((row) => row.providerRef === orderId) ?? null,
      markPaid: async (id) => {
        const row = payments.find((item) => item.id === id)!;
        row.status = PAYMENT_STATUS_PAID;
        return row;
      },
      activatePro: async () => {
        throw new Error("activation failed");
      },
      completePaidPro: async (paymentId, userId) => {
        const row = payments.find((item) => item.id === paymentId)!;
        const previousStatus = row.status;
        const previousPlan = plans.get(userId);
        row.status = PAYMENT_STATUS_PAID;
        try {
          throw new Error("activation failed");
        } catch (error) {
          row.status = previousStatus;
          if (previousPlan) plans.set(userId, previousPlan);
          throw error;
        }
      },
    };
    const razorpay: RazorpayOrders = {
      async createOrder(input) {
        return { id: "order_fail", amount: input.amount, currency: input.currency };
      },
    };
    const created = await createProOrderWith({ store, razorpay }, "user-a");
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const verified = await verifyProPaymentWith(
      { store, secret: "test_razorpay_secret" },
      {
        userId: "user-a",
        razorpay_order_id: created.checkout.orderId,
        razorpay_payment_id: "pay_fail",
        razorpay_signature: sign(created.checkout.orderId, "pay_fail"),
      },
    );
    expect(verified.ok).toBe(false);
    expect(payments[0]?.status).toBe(PAYMENT_STATUS_CREATED);
    expect(isProUser(plans.get("user-a"))).toBe(false);
  });

  it("TEST 10: duplicate verification is idempotent", async () => {
    const payments: PaymentRecord[] = [];
    const plans = new Map([["user-a", { plan: "FREE", status: "ACTIVE" }]]);
    let activateCalls = 0;
    const store: PaymentStore = {
      createPayment: async (data) => {
        const row = { id: "pay_dup", ...data };
        payments.push(row);
        return row;
      },
      findByOrderId: async (orderId) => payments.find((row) => row.providerRef === orderId) ?? null,
      markPaid: async (id) => {
        const row = payments.find((item) => item.id === id)!;
        row.status = PAYMENT_STATUS_PAID;
        return row;
      },
      activatePro: async (userId) => {
        activateCalls += 1;
        plans.set(userId, { plan: "PRO", status: "ACTIVE" });
      },
      completePaidPro: async (paymentId, userId) => {
        const row = payments.find((item) => item.id === paymentId)!;
        row.status = PAYMENT_STATUS_PAID;
        activateCalls += 1;
        plans.set(userId, { plan: "PRO", status: "ACTIVE" });
      },
    };
    const razorpay: RazorpayOrders = {
      async createOrder(input) {
        return { id: "order_dup", amount: input.amount, currency: input.currency };
      },
    };
    const created = await createProOrderWith({ store, razorpay }, "user-a");
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const payload = {
      userId: "user-a",
      razorpay_order_id: created.checkout.orderId,
      razorpay_payment_id: "pay_dup",
      razorpay_signature: sign(created.checkout.orderId, "pay_dup"),
    };
    const first = await verifyProPaymentWith({ store, secret: "test_razorpay_secret" }, payload);
    const second = await verifyProPaymentWith({ store, secret: "test_razorpay_secret" }, payload);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.alreadyPaid).toBe(true);
    expect(payments).toHaveLength(1);
    expect(activateCalls).toBe(1);
  });

  it("TEST 11: invalid signature does not change payment or Pro", async () => {
    const payments: PaymentRecord[] = [];
    const plans = new Map([["user-a", { plan: "FREE", status: "ACTIVE" }]]);
    const store: PaymentStore = {
      createPayment: async (data) => {
        const row = { id: "pay_bad", ...data };
        payments.push(row);
        return row;
      },
      findByOrderId: async (orderId) => payments.find((row) => row.providerRef === orderId) ?? null,
      markPaid: async (id) => {
        const row = payments.find((item) => item.id === id)!;
        row.status = PAYMENT_STATUS_PAID;
        return row;
      },
      activatePro: async (userId) => {
        plans.set(userId, { plan: "PRO", status: "ACTIVE" });
      },
      completePaidPro: async (paymentId, userId) => {
        const row = payments.find((item) => item.id === paymentId)!;
        row.status = PAYMENT_STATUS_PAID;
        plans.set(userId, { plan: "PRO", status: "ACTIVE" });
      },
    };
    const razorpay: RazorpayOrders = {
      async createOrder(input) {
        return { id: "order_bad", amount: input.amount, currency: input.currency };
      },
    };
    const created = await createProOrderWith({ store, razorpay }, "user-a");
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const verified = await verifyProPaymentWith(
      { store, secret: "test_razorpay_secret" },
      {
        userId: "user-a",
        razorpay_order_id: created.checkout.orderId,
        razorpay_payment_id: "pay_bad",
        razorpay_signature: "not-valid",
      },
    );
    expect(verified.ok).toBe(false);
    if (!verified.ok) expect(verified.error).toBe(PAYMENT_VERIFY_FAILED);
    expect(payments[0]?.status).toBe(PAYMENT_STATUS_CREATED);
    expect(isProUser(plans.get("user-a"))).toBe(false);
  });
});
