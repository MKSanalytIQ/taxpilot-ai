function redisConfig(env: NodeJS.ProcessEnv) {
  const url = String(env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL || "").trim().replace(/\/+$/, "");
  const token = String(env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN || "").trim();
  return url && token ? { url, token } : null;
}

async function command(env: NodeJS.ProcessEnv, fetchImpl: typeof fetch, args: string[]) {
  const config = redisConfig(env);
  if (!config) {
    if (env.NODE_ENV === "production") throw new Error("session-store");
    return null;
  }
  const response = await fetchImpl(`${config.url}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
    body: JSON.stringify([args]),
  });
  if (!response.ok) throw new Error("session-store");
  const body = (await response.json()) as Array<{ result?: string | null }>;
  return body[0]?.result ?? null;
}

export async function publishSessionStamp(
  userId: string,
  stamp: string,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
) {
  await command(env, fetchImpl, ["SET", `tp:sess:${userId}`, stamp]);
}

/** Production rejects a token whose stamp is missing or no longer current. Local dev without Redis keeps the JWT check in getSession. */
export async function sessionStampAllows(
  userId: string,
  stamp: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
) {
  if (!stamp) return false;
  if (!redisConfig(env)) return env.NODE_ENV !== "production";
  try {
    const current = await command(env, fetchImpl, ["GET", `tp:sess:${userId}`]);
    return current === stamp;
  } catch {
    return false;
  }
}
