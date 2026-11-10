import { describe, expect, it } from "vitest";
import { buildAccountExport } from "./account";
import { authSecretValue, itr3JsonEnabled, productionReady } from "./production";
import { limitRequest, resetRateLimit } from "./rate-limit";

describe("production gates", () => {
  it("refuses a short AUTH_SECRET in production and keeps a dev fallback", () => {
    expect(() => authSecretValue({ NODE_ENV: "production", AUTH_SECRET: "short" } as NodeJS.ProcessEnv)).toThrow(/AUTH_SECRET/);
    expect(authSecretValue({ NODE_ENV: "test" } as NodeJS.ProcessEnv).length).toBeGreaterThanOrEqual(32);
    expect(authSecretValue({ NODE_ENV: "production", AUTH_SECRET: "x".repeat(32) } as NodeJS.ProcessEnv)).toHaveLength(32);
  });

  it("keeps ITR-3 JSON off in production unless explicitly enabled", () => {
    expect(itr3JsonEnabled({ NODE_ENV: "production" } as NodeJS.ProcessEnv)).toBe(false);
    expect(itr3JsonEnabled({ NODE_ENV: "production", ITR3_JSON_ENABLED: "true" } as NodeJS.ProcessEnv)).toBe(true);
    expect(itr3JsonEnabled({ NODE_ENV: "test", ITR3_JSON_ENABLED: "false" } as NodeJS.ProcessEnv)).toBe(false);
    expect(itr3JsonEnabled({ NODE_ENV: "test" } as NodeJS.ProcessEnv)).toBe(true);
  });

  it("reports production readiness without echoing secrets", () => {
    const env = {
      NODE_ENV: "production",
      AUTH_SECRET: "y".repeat(32),
      S3_BUCKET: "b",
      S3_ENDPOINT: "https://s3.example",
      S3_ACCESS_KEY: "access",
      S3_SECRET_KEY: "secret-value",
      UPSTASH_REDIS_REST_URL: "https://example.upstash.io",
      UPSTASH_REDIS_REST_TOKEN: "token-value",
      NEXT_PUBLIC_APP_URL: "https://app.example",
    } as NodeJS.ProcessEnv;
    expect(productionReady(env)).toBe(true);
    expect(JSON.stringify(productionReady(env))).not.toContain("secret-value");
    expect(productionReady({ ...env, NEXT_PUBLIC_APP_URL: "http://app.example" })).toBe(false);
  });

  it("fails closed in production when the shared limiter is missing", async () => {
    resetRateLimit();
    const denied = await limitRequest("login:a@b.c", 10, 60_000, { NODE_ENV: "production" } as NodeJS.ProcessEnv);
    expect(denied.ok).toBe(false);
    const fetchImpl = (async () =>
      new Response(JSON.stringify([{ result: 1 }, { result: 1 }]), { status: 200 })) as typeof fetch;
    const allowed = await limitRequest(
      "login:a@b.c",
      10,
      60_000,
      {
        NODE_ENV: "production",
        UPSTASH_REDIS_REST_URL: "https://example.upstash.io",
        UPSTASH_REDIS_REST_TOKEN: "token",
      } as NodeJS.ProcessEnv,
      fetchImpl,
    );
    expect(allowed).toEqual({ ok: true, shared: true });
  });

  it("omits secrets from an account export", () => {
    const exported = buildAccountExport({
      email: "a@b.c",
      name: "A",
      createdAt: "2026-10-03T00:00:00.000Z",
      profile: { pan: "ABCDE1234F", passwordHash: "nope" },
      returns: [{ id: "r1", storageKey: "secret-key", status: "DRAFT" }],
      payments: [{ amount: 100, currency: "INR", status: "PAID", createdAt: "2026-10-03T00:00:00.000Z" }],
    });
    const text = JSON.stringify(exported);
    expect(text).toContain("ABCDE1234F");
    expect(text).not.toContain("nope");
    expect(text).not.toContain("secret-key");
  });
});
