import { describe, expect, it } from "vitest";
import { buildVersionSnapshot, canReadReturnHistory, publicAuditMetadata, shouldSaveVersion } from "./versions";

describe("return versions", () => {
  it("saves a new snapshot only when the return changed", () => {
    const snap = JSON.stringify(buildVersionSnapshot({
      assessmentYear: "2026-27",
      itrType: "ITR-4",
      taxRegime: "NEW",
      status: "READY_FOR_JSON",
      estimatedTax: 150800,
      estimatedRefund: 0,
      fingerprint: "abc123",
      schemaVersion: "Ver1.0",
    }));
    expect(shouldSaveVersion(null, snap)).toBe(true);
    expect(shouldSaveVersion(snap, snap)).toBe(false);
    expect(snap).not.toContain("pan");
    expect(snap).not.toContain("accountNumber");
  });

  it("shows history only to the owner or an admin", () => {
    expect(canReadReturnHistory("u1", { userId: "u1", role: "USER" })).toBe(true);
    expect(canReadReturnHistory("u1", { userId: "u2", role: "USER" })).toBe(false);
    expect(canReadReturnHistory("u1", { userId: "u2", role: "TAX_PROFESSIONAL" })).toBe(false);
    expect(canReadReturnHistory("u1", { userId: "u2", role: "ADMIN" })).toBe(true);
  });

  it("does not publish secrets from an audit payload", () => {
    const shown = publicAuditMetadata(JSON.stringify({
      note: "Recalculated",
      itrType: "ITR-4",
      pan: "ABCDE1234F",
      password: "secret",
      accountNumber: "123456789",
      fingerprint: "abc123456789",
    }));
    expect(shown).toEqual({ note: "Recalculated", itrType: "ITR-4", fingerprint: "abc123456789" });
  });
});
