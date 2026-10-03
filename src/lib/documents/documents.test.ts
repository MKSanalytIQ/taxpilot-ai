import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { extractForm16, form16Reconciliation } from "./extractors/form16";
import { extractAis, extractTis } from "./extractors/ais";
import { classifyBankDescription, extractBankCsv, extractBankXlsx } from "./extractors/bank";
import { runExtraction } from "./pipeline";
import { reconcileTds } from "./tdsReconcile";
import { classifyDocument } from "./classify";
import { pagesFromText } from "./pages";
import { extractPdfPages } from "./text";
import { parseAmount } from "./rupees";
import { canEnterTaxModel, normalizedTaxField } from "./mapping";
import { applyConflictResolution, detectAmountConflicts } from "./conflicts";
import { canAccessConflict, canAccessDocument, canAccessTaxFact } from "@/lib/authz";
import type { PdfPage } from "./types";

const FORM16_PAGES: PdfPage[] = [
  {
    pageNumber: 1,
    text: "Form 16 Part A Name of the Employee: ANITA SHARMA PAN: AAAPA1234A Name of Employer: Demo Tech Pvt Ltd TAN: DELD12345E Assessment Year: 2026-27",
  },
  {
    pageNumber: 2,
    text: "Salary details Gross total salary: ₹12,50,000 Exempt allowances: 50,000 Standard Deduction: 75,000 Professional Tax: 2,500 Taxable Salary: 11,22,500",
  },
  {
    pageNumber: 3,
    text: "Deductions Deduction under Chapter VI-A: 1,50,000 Total Tax deducted at source: ₹1,10,000",
  },
];

describe("rupee parsing", () => {
  it("distinguishes Indian groupings and strips currency marks", () => {
    expect(parseAmount("12,50,000")).toBe(1_250_000);
    expect(parseAmount("₹12,50,000")).toBe(1_250_000);
    expect(parseAmount("₹1,25,000")).toBe(125_000);
    expect(parseAmount("Rs.12,50,000")).toBe(1_250_000);
    expect(parseAmount("1250000")).toBe(1_250_000);
    expect(parseAmount("75,000.00")).toBe(75_000);
    expect(parseAmount(null)).toBeNull();
    expect(parseAmount("")).toBeNull();
  });
});

describe("Form 16", () => {
  it("extracts PAN, TAN, gross salary and TDS; missing stay null", () => {
    const fields = extractForm16(pagesFromText("Form 16 Employee Name: Ravi Kumar PAN: AAAPA1234A Name of Employer: Acme Pvt Ltd TAN: MUMM12345B Assessment Year: 2026-27 Gross Salary: 12,50,000 Standard Deduction: 75,000 Tax Deducted: 1,10,000"));
    expect(fields.find((f) => f.field === "employeePan")?.value).toBe("AAAPA1234A");
    expect(fields.find((f) => f.field === "grossSalary")?.numericValue).toBe(1_250_000);
    expect(fields.find((f) => f.field === "tds")?.numericValue).toBe(110_000);
    expect(fields.find((f) => f.field === "chapterVia")?.value).toBeNull();
  });

  it("tolerates label variations", () => {
    const fields = extractForm16(
      pagesFromText("Form 16 Gross salary: ₹12,50,000 TDS: 1,10,000 Tax deducted at source: 1,10,000"),
    );
    expect(fields.find((f) => f.field === "grossSalary")?.numericValue).toBe(1_250_000);
    expect(fields.find((f) => f.field === "tds")?.numericValue).toBe(110_000);
  });

  it("keeps page-level provenance on a multi-page Form 16", () => {
    const fields = extractForm16(FORM16_PAGES);
    expect(fields.find((f) => f.field === "employeeName")?.sourcePage).toBe(1);
    expect(fields.find((f) => f.field === "grossSalary")?.sourcePage).toBe(2);
    expect(fields.find((f) => f.field === "grossSalary")?.numericValue).toBe(1_250_000);
    expect(fields.find((f) => f.field === "tds")?.sourcePage).toBe(3);
    expect(fields.find((f) => f.field === "tds")?.numericValue).toBe(110_000);
    expect(fields.every((f) => f.documentType === "FORM_16")).toBe(true);
  });

  it("warns on internal reconciliation mismatch without changing values", () => {
    const fields = extractForm16(
      pagesFromText("Gross Salary: 12,50,000 Exempt allowances: 0 Standard Deduction: 75,000 Professional Tax: 2,500 Taxable Salary: 10,00,000"),
    );
    expect(form16Reconciliation(fields)).toBe("FORM16_RECONCILIATION_WARNING");
    expect(fields.find((f) => f.field === "grossSalary")?.numericValue).toBe(1_250_000);
    expect(fields.find((f) => f.field === "taxableSalary")?.numericValue).toBe(1_000_000);
  });
});

describe("AIS / TIS", () => {
  it("extracts AIS categories with original labels and page provenance", () => {
    const ais = extractAis([
      { pageNumber: 1, text: "Annual Information Statement Income from Salary: ₹8,00,000" },
      { pageNumber: 2, text: "Interest income: 12,000 Dividend: 5,000 TDS: 50,000" },
    ]);
    expect(ais.find((f) => f.field === "salary")?.numericValue).toBe(800_000);
    expect(ais.find((f) => f.field === "salary")?.sourcePage).toBe(1);
    expect(ais.find((f) => f.field === "salary")?.originalCategory).toBe("SALARY");
    expect(ais.find((f) => f.field === "interest")?.numericValue).toBe(12_000);
    expect(ais.find((f) => f.field === "interest")?.sourcePage).toBe(2);
    expect(ais.find((f) => f.field === "dividend")?.numericValue).toBe(5_000);
    expect(ais.find((f) => f.field === "securities")?.value).toBeNull();
    expect(ais.every((f) => f.documentType === "AIS")).toBe(true);
  });

  it("keeps TIS facts separate from AIS and does not treat missing as zero", () => {
    const ais = extractAis(pagesFromText("Annual Information Statement Salary: 800000 Interest: 12000 TDS: 50000"));
    const tis = extractTis(pagesFromText("Taxpayer Information Statement Reported Income: 810000 TDS: 50000"));
    expect(tis.find((f) => f.field === "reportedIncome")?.numericValue).toBe(810_000);
    expect(tis.find((f) => f.field === "processed")?.value).toBeNull();
    expect(tis.every((f) => f.documentType === "TIS")).toBe(true);
    expect(ais.some((f) => f.documentType === "TIS")).toBe(false);
    expect(ais.find((f) => f.field === "dividend")?.value).toBeNull();
  });
});

describe("bank CSV", () => {
  it("parses rows and keeps suggestion separate from verification", () => {
    const csv = "Date,Description,Debit,Credit,Balance\n2025-04-01,UPI to friend,500,0,10000\n2025-04-02,Salary ACME,0,80000,90000";
    const rows = extractBankCsv(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0].suggestedCategory).toBe("TRANSFER");
    expect(rows[0].rawCategory).toBe("UNKNOWN");
    expect(rows[0].verifiedCategory).toBeNull();
    expect(rows[0].sourcePage).toBeNull();
    expect(rows[1].suggestedCategory).toBe("SALARY");
    expect(classifyBankDescription("random coffee")).toBe("UNKNOWN");
  });

  it("accepts alternate CSV headers", () => {
    const csv = "Txn Date,Narration,Withdrawal,Deposit,Balance,Reference\n01-04-2025,NEFT IN,0,25000,25000,UTR1";
    const rows = extractBankCsv(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0].credit).toBe(25_000);
    expect(rows[0].debit).toBe(0);
    expect(rows[0].reference).toBe("UTR1");
  });
});

describe("bank XLSX", () => {
  it("parses common bank columns", async () => {
    const XLSX = await import("xlsx");
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([
      ["Transaction Date", "Particulars", "Withdrawal", "Deposit", "Balance"],
      ["2025-04-01", "Customer receipt INV-9", "0", "25000", "35000"],
      ["2025-04-02", "UPI coffee", "200", "0", "34800"],
    ]);
    XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
    const written = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
    const bytes = Buffer.isBuffer(written) ? written : Buffer.from(written as ArrayBuffer);
    const rows = await extractBankXlsx(bytes);
    expect(rows).toHaveLength(2);
    expect(rows[0].suggestedCategory).toBe("BUSINESS_RECEIPT");
    expect(rows[0].verifiedCategory).toBeNull();
    expect(rows[0].sourcePage).toBeNull();
    expect(rows[0].credit).toBe(25_000);
    expect(rows[1].debit).toBe(200);
  });
});

describe("pipeline", () => {
  it("classifies Form 16 from text and does not invent amounts", async () => {
    const bytes = Buffer.from("Form 16 PAN: BBBBB1234B Gross Salary: 100000 Tax Deducted: 5000");
    const r = await runExtraction({ bytes, fileName: "form16.txt", mimeType: "text/plain", declaredKind: "FORM_16" });
    expect(r.kind).toBe("FORM_16");
    expect(r.pages).toHaveLength(1);
    expect(r.fields.find((f) => f.field === "employeePan")?.value).toBe("BBBBB1234B");
    expect(r.fields.find((f) => f.field === "chapterVia")?.value).toBeNull();
  });

  it("images require manual review and do not fabricate text", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const r = await runExtraction({ bytes: png, fileName: "scan.png", mimeType: "image/png", declaredKind: "FORM_16" });
    expect(r.errorCode).toBe("MANUAL_REVIEW_REQUIRED");
    expect(r.fields).toEqual([]);
    expect(r.pages.every((p) => !p.text)).toBe(true);
  });

  it("routes a scanned image through OCR text into Form 16 fields", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const r = await runExtraction(
      { bytes: png, fileName: "scan.png", mimeType: "image/png", declaredKind: "FORM_16" },
      {
        ocr: {
          name: "test",
          configured: true,
          async extractText() {
            return { pages: [{ pageNumber: 1, text: "Form 16 PAN: AAAPA1234A Gross Salary: 12,50,000 Tax Deducted: 1,10,000" }] };
          },
          async extract() {
            return [];
          },
        },
      },
    );
    expect(r.usedOcr).toBe(true);
    expect(r.errorCode).toBeUndefined();
    expect(r.fields.find((f) => f.field === "grossSalary")?.numericValue).toBe(1_250_000);
    expect(r.fields.find((f) => f.field === "employeePan")?.value).toBe("AAAPA1234A");
    expect(r.fields.find((f) => f.field === "grossSalary")?.extractionMethod).toBe("OCR");
  });

  it("keeps a failed OCR call on the manual-entry path", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const thrown = await runExtraction(
      { bytes: png, fileName: "scan.png", mimeType: "image/png", declaredKind: "FORM_16" },
      {
        ocr: {
          name: "test",
          configured: true,
          async extractText() {
            throw new Error("vision key super-secret-vision-key");
          },
          async extract() {
            return [];
          },
        },
      },
    );
    expect(thrown.errorCode).toBe("MANUAL_REVIEW_REQUIRED");
    expect(thrown.errorMessage).toBe("OCR failed. Enter values manually.");
    expect(thrown.errorMessage).not.toContain("super-secret");
    expect(thrown.fields).toEqual([]);

    const leaked = await runExtraction(
      { bytes: png, fileName: "scan.png", mimeType: "image/png", declaredKind: "FORM_16" },
      {
        ocr: {
          name: "test",
          configured: true,
          async extractText() {
            return { pages: [], error: "rejected key super-secret-vision-key" };
          },
          async extract() {
            return [];
          },
        },
      },
    );
    expect(leaked.errorCode).toBe("MANUAL_REVIEW_REQUIRED");
    expect(leaked.errorMessage).not.toContain("super-secret");
  });

  it("uses OCR when a PDF has no text layer", async () => {
    const bytes = Buffer.from("%PDF-1.4 scanned form");
    const r = await runExtraction(
      { bytes, fileName: "form16.pdf", mimeType: "application/pdf", declaredKind: "FORM_16" },
      {
        ocr: {
          name: "test",
          configured: true,
          async extractText() {
            return { pages: [{ pageNumber: 1, text: "Form 16 Gross Salary: 100000 Tax Deducted: 5000" }] };
          },
          async extract() {
            return [];
          },
        },
      },
    );
    expect(r.usedOcr).toBe(true);
    expect(r.fields.find((f) => f.field === "grossSalary")?.numericValue).toBe(100_000);
  });

  it("does not treat a non-PDF buffer as a single invented page", async () => {
    const pages = await extractPdfPages(Buffer.from("not a pdf"));
    expect(pages).toEqual([]);
  });
});

describe("TaxFact source scoping", () => {
  it("maps Form 16, AIS, and bank fields explicitly", () => {
    expect(normalizedTaxField("FORM_16", "grossSalary")).toBe("salary.grossSalary");
    expect(normalizedTaxField("AIS", "interest")).toBe("income.interest");
    expect(normalizedTaxField("TIS", "reportedIncome")).toBe("income.tis.reported");
    expect(normalizedTaxField("BANK_STATEMENT", "verifiedBusinessReceipt")).toBe("business.receipts");
    expect(normalizedTaxField("FORM_16", "unknown")).toBe("");
  });

  it("only VERIFIED facts may enter the tax model", () => {
    expect(canEnterTaxModel("AI_EXTRACTED", false)).toBe(false);
    expect(canEnterTaxModel("VERIFIED", true)).toBe(true);
    expect(canEnterTaxModel("REJECTED", false)).toBe(false);
    expect(canEnterTaxModel("CONFLICT", false)).toBe(false);
    expect(canEnterTaxModel("VERIFIED", false)).toBe(false);
  });
});

describe("conflicts", () => {
  it("detects Form 16 vs AIS salary mismatch", () => {
    const drafts = detectAmountConflicts([
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
    ]);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].field).toBe("SALARY");
    expect(drafts[0].facts).toHaveLength(2);
  });

  it("does not merge matching amounts", () => {
    expect(
      detectAmountConflicts([
        {
          id: "a",
          documentType: "FORM_16",
          field: "grossSalary",
          normalizedTaxField: "salary.grossSalary",
          value: "1250000",
          numericValue: 1_250_000,
          sourceDocumentId: "d1",
        },
        {
          id: "b",
          documentType: "AIS",
          field: "salary",
          normalizedTaxField: "income.salary.ais",
          value: "1250000",
          numericValue: 1_250_000,
          sourceDocumentId: "d2",
        },
      ]),
    ).toHaveLength(0);
  });

  it("resolves with USE_SOURCE, MANUAL_VALUE, and IGNORE_WITH_REASON", () => {
    const facts = [
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
    ];
    const use = applyConflictResolution({ resolution: "USE_SOURCE", facts, chosenFactId: "f16" });
    expect(use.ok).toBe(true);
    if (use.ok) {
      expect(use.status).toBe("RESOLVED");
      expect(use.resolution).toBe("USE_SOURCE");
      expect(use.verifyId).toBe("f16");
      expect(use.rejectIds).toEqual(["ais"]);
    }
    const manual = applyConflictResolution({ resolution: "MANUAL_VALUE", facts, manualValue: "12,60,000" });
    expect(manual.ok).toBe(true);
    if (manual.ok) {
      expect(manual.resolution).toBe("MANUAL_VALUE");
      expect(manual.resolvedValue).toBe("12,60,000");
      expect(manual.verifyId).toBe("");
      expect(manual.rejectIds).toEqual(["f16", "ais"]);
    }
    const ignored = applyConflictResolution({ resolution: "IGNORE_WITH_REASON", facts, reason: "will confirm later" });
    expect(ignored.ok).toBe(true);
    if (ignored.ok) expect(ignored.status).toBe("IGNORED");
  });
});

describe("TDS reconcile", () => {
  it("flags mismatch", () => {
    expect(reconcileTds(100, 100)).toBe("MATCHED");
    expect(reconcileTds(100, 120)).toBe("MISMATCH");
    expect(reconcileTds(100, null)).toBe("MISSING");
  });
});

describe("authz documents", () => {
  it("blocks unauthorized document, tax fact, and conflict access", () => {
    const owner = { userId: "u1", role: "USER" };
    const other = { userId: "u2", role: "USER" };
    const admin = { userId: "u2", role: "ADMIN" };
    expect(canAccessDocument("u1", owner)).toBe(true);
    expect(canAccessDocument("u1", other)).toBe(false);
    expect(canAccessTaxFact("u1", other)).toBe(false);
    expect(canAccessConflict("u1", other)).toBe(false);
    expect(canAccessTaxFact("u1", admin)).toBe(true);
    expect(canAccessConflict("u1", admin)).toBe(true);
  });
});

describe("architectural safety", () => {
  it("document modules never import ITR JSON generation", () => {
    const dir = join(process.cwd(), "src/lib/documents");
    const files = ["pipeline.ts", "applyVerified.ts", "persistExtraction.ts", "extractors/form16.ts", "conflicts.ts", "fallback.ts", "prefill.ts"];
    for (const f of files) {
      const src = readFileSync(join(dir, f), "utf8");
      expect(src).not.toContain("generateITRJson");
      expect(src).not.toContain("mapItr4Official");
    }
  });
});

describe("classify", () => {
  it("filename ais", () => {
    expect(classifyDocument("AIS-2026.pdf", "")).toBe("AIS");
    expect(classifyDocument("tis.json", "")).toBe("TIS");
  });
});
