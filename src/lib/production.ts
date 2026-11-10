const DEV_AUTH_SECRET = "dev-only-change-taxpilot-secret-32b";

export function authSecretValue(env: NodeJS.ProcessEnv = process.env) {
  const raw = String(env.AUTH_SECRET || "").trim();
  if (raw.length >= 32) return raw;
  if (env.NODE_ENV === "production") {
    throw new Error("AUTH_SECRET must be set to at least 32 characters in production.");
  }
  return DEV_AUTH_SECRET;
}

export function authSecretBytes(env: NodeJS.ProcessEnv = process.env) {
  return new TextEncoder().encode(authSecretValue(env));
}

/** ITR-3 download stays off in production unless explicitly enabled. Tests and local dev keep the mapper path. */
export function itr3JsonEnabled(env: NodeJS.ProcessEnv = process.env) {
  const flag = String(env.ITR3_JSON_ENABLED || "").trim().toLowerCase();
  if (flag === "true") return true;
  if (flag === "false") return false;
  return env.NODE_ENV !== "production";
}

export function objectStorageConfigured(env: NodeJS.ProcessEnv = process.env) {
  return Boolean(
    String(env.S3_BUCKET || "").trim() &&
      String(env.S3_ENDPOINT || "").trim() &&
      String(env.S3_ACCESS_KEY || "").trim() &&
      String(env.S3_SECRET_KEY || "").trim(),
  );
}

export function sharedRateLimitConfigured(env: NodeJS.ProcessEnv = process.env) {
  return Boolean(String(env.UPSTASH_REDIS_REST_URL || "").trim() && String(env.UPSTASH_REDIS_REST_TOKEN || "").trim());
}

export function productionReady(env: NodeJS.ProcessEnv = process.env) {
  if (env.NODE_ENV !== "production") return true;
  try {
    if (authSecretValue(env).length < 32) return false;
  } catch {
    return false;
  }
  const origin = String(env.NEXT_PUBLIC_APP_URL || "").trim();
  return objectStorageConfigured(env) && sharedRateLimitConfigured(env) && origin.startsWith("https://");
}

const PAN_RE = /\b[A-Z]{5}\d{4}[A-Z]\b/g;

export function logSafe(scope: string, error: unknown) {
  const message = error instanceof Error ? error.message : "failed";
  console.error(`[${scope}] ${message.replace(PAN_RE, "[pan]").slice(0, 200)}`);
}
