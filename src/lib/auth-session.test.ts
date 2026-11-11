import { describe, expect, it } from "vitest";
import { passwordSessionStamp } from "./session-stamp";

describe("password session stamp", () => {
  it("changes when the password hash changes, so older JWTs no longer match", () => {
    const before = passwordSessionStamp("$2b$12$old-password-hash");
    const after = passwordSessionStamp("$2b$12$new-password-hash");
    expect(before).not.toBe(after);
    expect(passwordSessionStamp("$2b$12$new-password-hash")).toBe(after);
  });
});
