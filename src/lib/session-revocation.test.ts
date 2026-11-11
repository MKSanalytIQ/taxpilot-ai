import { describe, expect, it } from "vitest";
import { publishSessionStamp, sessionStampAllows } from "./session-revocation";

const env = {
  NODE_ENV: "production",
  KV_REST_API_URL: "https://example.upstash.io",
  KV_REST_API_TOKEN: "token",
} as NodeJS.ProcessEnv;

describe("session stamp revocation", () => {
  it("rejects a missing or stale stamp and accepts the current one", async () => {
    let stored = "";
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      const command = (JSON.parse(String(init?.body)) as string[][])[0];
      if (command[0] === "SET") stored = command[2];
      return new Response(JSON.stringify([{ result: command[0] === "GET" ? stored : "OK" }]));
    }) as typeof fetch;

    await publishSessionStamp("user", "current", env, fetchImpl);
    expect(await sessionStampAllows("user", "current", env, fetchImpl)).toBe(true);
    expect(await sessionStampAllows("user", "old", env, fetchImpl)).toBe(false);
    expect(await sessionStampAllows("user", undefined, env, fetchImpl)).toBe(false);
    expect(await sessionStampAllows("user", "current", { NODE_ENV: "production" } as NodeJS.ProcessEnv, fetchImpl)).toBe(false);
  });
});
