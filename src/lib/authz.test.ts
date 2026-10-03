import { describe, expect, it } from "vitest";
import { canAccessReturn } from "./authz";

const user = (over: Partial<{ userId: string; role: string }> = {}) => ({
  userId: "u1",
  role: "USER",
  ...over,
});

describe("authorization", () => {
  it("owner can access", () => {
    expect(canAccessReturn("u1", user())).toBe(true);
  });
  it("other user cannot", () => {
    expect(canAccessReturn("u2", user())).toBe(false);
  });
  it("admin can", () => {
    expect(canAccessReturn("u2", user({ role: "ADMIN" }))).toBe(true);
  });
  it("another user cannot, including a tax professional", () => {
    expect(canAccessReturn("u2", user({ userId: "u9", role: "TAX_PROFESSIONAL" }))).toBe(false);
    expect(canAccessReturn("u2", user({ userId: "u9", role: "USER" }))).toBe(false);
  });
});
