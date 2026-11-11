import { describe, expect, it } from "vitest";
import { generateITRJson } from "@/lib/itr-json/mapper";
import { fixtures } from "@/lib/tax/fixtures";
import { applyConflictResolution } from "@/lib/documents/conflicts";
import { isAllowedUpload, isXlsxContainer, sniffMime } from "@/lib/documents/magic";
import { writeXlsxSheet } from "@/lib/documents/xlsx-sheet";

const frozen = new Date("2026-08-26T00:00:00.000Z");

describe("JSON generation gate — document conflicts", () => {
  it("blocks JSON when an unresolved material conflict exists, and allows the existing gate after resolution", () => {
    const blocked = generateITRJson(fixtures.simpleBusiness, {
      generatedAt: frozen,
      returnId: "r1",
      openDocumentConflicts: 1,
    });
    expect(blocked.valid).toBe(false);
    expect(blocked.json).toBeNull();
    expect(blocked.errors.some((e) => e.field === "DOCUMENT_CONFLICT_OPEN")).toBe(true);

    const resolved = applyConflictResolution({
      resolution: "USE_SOURCE",
      facts: [
        {
          id: "f16",
          documentType: "FORM_16",
          field: "grossSalary",
          normalizedTaxField: "salary.grossSalary",
          value: "1250000",
          numericValue: 1_250_000,
          sourceDocumentId: "d1",
        },
        {
          id: "ais",
          documentType: "AIS",
          field: "salary",
          normalizedTaxField: "income.salary.ais",
          value: "1280000",
          numericValue: 1_280_000,
          sourceDocumentId: "d2",
        },
      ],
      chosenFactId: "f16",
    });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.status).toBe("RESOLVED");

    const allowed = generateITRJson(fixtures.simpleBusiness, {
      generatedAt: frozen,
      returnId: "r1",
      openDocumentConflicts: 0,
    });
    expect(allowed.valid).toBe(true);
    expect(allowed.json).not.toBeNull();
    expect(allowed.errors.some((e) => e.field === "DOCUMENT_CONFLICT_OPEN")).toBe(false);
  });
});

describe("XLSX upload validation", () => {
  it("accepts a real XLSX container and rejects a renamed non-XLSX file", async () => {
    const valid = writeXlsxSheet([
      ["Date", "Narration"],
      ["2025-04-01", "ok"],
    ]);
    expect(isXlsxContainer(valid)).toBe(true);
    expect(sniffMime(valid, "stmt.xlsx", "application/octet-stream")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(isAllowedUpload(sniffMime(valid, "stmt.xlsx", ""), valid.length).ok).toBe(true);

    const fake = Buffer.from("this is not a spreadsheet");
    expect(isXlsxContainer(fake)).toBe(false);
    const fakeMime = sniffMime(fake, "stmt.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(fakeMime).not.toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(isAllowedUpload(fakeMime, fake.length).ok).toBe(false);
  });
});
