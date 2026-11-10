const buckets = new Map<string, { n: number; reset: number }>();

export function rateLimit(key: string, limit: number, windowMs: number) {
  const now = Date.now();
  const cur = buckets.get(key);
  if (!cur || cur.reset < now) {
    buckets.set(key, { n: 1, reset: now + windowMs });
    return { ok: true };
  }
  if (cur.n >= limit) return { ok: false };
  cur.n += 1;
  return { ok: true };
}

export function resetRateLimit() {
  buckets.clear();
}

type UpstashRow = { result?: number | string } | number | string;

function countFrom(body: unknown) {
  const row = Array.isArray(body) ? (body[0] as UpstashRow) : (body as UpstashRow);
  if (typeof row === "number" || typeof row === "string") return Number(row);
  return Number(row?.result ?? 0);
}

/**
 * Shared limiter when Upstash is configured. Production without a shared store fails closed
 * so a multi-instance deploy cannot bypass login and upload limits.
 */
export async function limitRequest(
  key: string,
  limit: number,
  windowMs: number,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
) {
  const url = String(env.UPSTASH_REDIS_REST_URL || "").trim().replace(/\/+$/, "");
  const token = String(env.UPSTASH_REDIS_REST_TOKEN || "").trim();
  if (url && token) {
    try {
      const redisKey = `tp:rl:${key}`;
      const response = await fetchImpl(`${url}/pipeline`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify([
          ["INCR", redisKey],
          ["PEXPIRE", redisKey, windowMs, "NX"],
        ]),
      });
      if (!response.ok) throw new Error("rate-limit-store");
      const count = countFrom(await response.json());
      return { ok: Number.isFinite(count) && count > 0 && count <= limit, shared: true as const };
    } catch {
      if (env.NODE_ENV === "production") return { ok: false, shared: false as const };
    }
  } else if (env.NODE_ENV === "production") {
    return { ok: false, shared: false as const };
  }
  return { ...rateLimit(key, limit, windowMs), shared: false as const };
}
