import { describe, expect, it } from "vitest";
import { filingInstant, totpCode, verifyTotp } from "./totp";

describe("totp", () => {
  const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

  it("matches RFC 6238 SHA1 vectors", () => {
    expect(totpCode(secret, 59_000)).toBe("287082");
    expect(totpCode(secret, 1_111_111_109_000)).toBe("081804");
    expect(totpCode(secret, 1_111_111_111_000)).toBe("050471");
    expect(totpCode(secret, 1_234_567_890_000)).toBe("005924");
  });

  it("accepts the current code and the adjacent step only", () => {
    const at = 1_234_567_890_000;
    expect(verifyTotp(secret, "005924", at)).toBe(true);
    expect(verifyTotp(secret, "000000", at)).toBe(false);
    expect(verifyTotp(secret, "abc", at)).toBe(false);
  });
});

describe("filing date", () => {
  const now = new Date("2026-11-11T00:00:00.000Z");

  it("uses noon UTC for a chosen filing date and rejects junk", () => {
    expect(filingInstant("2026-07-31", now)?.toISOString()).toBe("2026-07-31T12:00:00.000Z");
    expect(filingInstant("", now)).toEqual(now);
    expect(filingInstant("31-07-2026", now)).toBeNull();
    expect(filingInstant("2026-02-31", now)).toBeNull();
    expect(filingInstant("1999-01-01", now)).toBeNull();
  });
});
