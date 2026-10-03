import { getOcrProvider, type DocumentExtractionProvider } from "@/lib/providers/ocr";
import { getDocumentAIProvider, type DocumentAIProvider } from "@/lib/providers/documentAi";
import { classifyDocument } from "./classify";
import { extractAis, extractAisTransactions, extractTis } from "./extractors/ais";
import { extractBankCsv, extractBankXlsx } from "./extractors/bank";
import { extractForm16, form16Reconciliation } from "./extractors/form16";
import { mergeFallbackFields, parseAiExtraction, shouldUseAiFallback } from "./fallback";
import { sniffMime } from "./magic";
import { extractPages } from "./text";
import {
  EXTRACTION_BUNDLE_VERSION,
  PROMPT_VERSION,
  type DocumentType,
  type ExtractionMethod,
  type ExtractionResult,
  type PdfPage,
} from "./types";

const PRIORITY: DocumentType[] = ["FORM_16", "AIS", "TIS", "BANK_STATEMENT"];

export type ExtractionHooks = {
  ocr?: DocumentExtractionProvider;
  ai?: DocumentAIProvider;
};

function emptyResult(kind: DocumentType, pages: PdfPage[], extra?: Partial<ExtractionResult>): ExtractionResult {
  return {
    kind,
    pages,
    fields: [],
    transactions: [],
    aisTransactions: [],
    warnings: [],
    extractorVersion: EXTRACTION_BUNDLE_VERSION,
    ...extra,
  };
}

function publicOcrMessage(error?: string) {
  if (!error || error.length > 160 || /key|secret|token|bearer|googleapis|authorization/i.test(error)) {
    return "OCR failed. Enter values manually.";
  }
  return error;
}

function applyMethod(result: ExtractionResult, method: ExtractionMethod) {
  return {
    ...result,
    fields: result.fields.map((f) => ({ ...f, extractionMethod: method })),
  };
}

async function deterministic(kind: DocumentType, pages: PdfPage[], method: ExtractionMethod): Promise<ExtractionResult> {
  if (kind === "FORM_16") {
    const fields = extractForm16(pages, method);
    const warning = form16Reconciliation(fields);
    return emptyResult(kind, pages, { fields, warnings: warning ? [warning] : [] });
  }
  if (kind === "AIS") {
    return emptyResult(kind, pages, { fields: extractAis(pages, method), aisTransactions: extractAisTransactions(pages) });
  }
  if (kind === "TIS") {
    return emptyResult(kind, pages, { fields: extractTis(pages, method) });
  }
  return emptyResult(kind, pages);
}

export async function runExtraction(
  input: {
    bytes: Buffer;
    fileName: string;
    mimeType: string;
    declaredKind?: string;
  },
  hooks: ExtractionHooks = {},
): Promise<ExtractionResult> {
  const ocr = hooks.ocr ?? getOcrProvider();
  const ai = hooks.ai ?? getDocumentAIProvider();
  const mime = sniffMime(input.bytes, input.fileName, input.mimeType);
  let pages = await extractPages(input.bytes, mime, input.fileName);
  let text = pages.map((p) => p.text).join(" ");
  const kind = classifyDocument(input.fileName, text, input.declaredKind);
  let usedOcr = false;
  let method: ExtractionMethod = "DETERMINISTIC";

  const needsText = mime.startsWith("image/") || (mime === "application/pdf" && pages.every((p) => !p.text));
  if (needsText && !text.trim()) {
    if (!ocr.configured) {
      return emptyResult(kind, pages, {
        errorCode: "MANUAL_REVIEW_REQUIRED",
        errorMessage: "Image/scanned OCR is not configured. Enter values manually.",
      });
    }
    let ocrText: Awaited<ReturnType<DocumentExtractionProvider["extractText"]>>;
    try {
      ocrText = await ocr.extractText({ fileName: input.fileName, mimeType: mime, bytes: input.bytes });
    } catch {
      return emptyResult(kind, pages, {
        usedOcr: true,
        errorCode: "MANUAL_REVIEW_REQUIRED",
        errorMessage: "OCR failed. Enter values manually.",
      });
    }
    if (!ocrText.pages.some((p) => p.text)) {
      return emptyResult(kind, pages, {
        usedOcr: true,
        errorCode: "MANUAL_REVIEW_REQUIRED",
        errorMessage: publicOcrMessage(ocrText.error),
      });
    }
    pages = ocrText.pages;
    text = pages.map((p) => p.text).join(" ");
    usedOcr = true;
    method = "OCR";
  }

  if (kind === "BANK_STATEMENT") {
    if (mime.includes("spreadsheet") || /\.xlsx$/i.test(input.fileName)) {
      const transactions = await extractBankXlsx(input.bytes);
      return emptyResult(kind, pages, { transactions, usedOcr });
    }
    return emptyResult(kind, pages, { transactions: extractBankCsv(text), usedOcr });
  }

  if (!PRIORITY.includes(kind) && kind !== "FORM_16" && kind !== "AIS" && kind !== "TIS") {
    return emptyResult(kind, pages, {
      usedOcr,
      errorCode: "PLACEHOLDER",
      errorMessage: `Extractor for ${kind} is not implemented. Use manual entry.`,
    });
  }

  let result = await deterministic(kind, pages, method);
  result.usedOcr = usedOcr;
  if (usedOcr) result = applyMethod(result, "OCR");

  const hasText = pages.some((p) => p.text);
  const wantAi = shouldUseAiFallback(kind, result.fields, hasText);
  if (!wantAi) {
    return { ...result, usedAi: false, promptVersion: kind === "AIS" ? PROMPT_VERSION.AIS : PROMPT_VERSION.FORM_16 };
  }

  if (!ai.configured) {
    if (!result.fields.some((f) => f.value) && !hasText) {
      return {
        ...result,
        usedAi: false,
        errorCode: result.errorCode || "MANUAL_REVIEW_REQUIRED",
        errorMessage: result.errorMessage || "Deterministic extraction was insufficient and no AI/OCR provider is configured.",
      };
    }
    return { ...result, usedAi: false };
  }

  const promptVersion = kind === "AIS" ? PROMPT_VERSION.AIS : PROMPT_VERSION.FORM_16;
  const aiOut = await ai.extractDocument({ documentType: kind, pages, promptVersion });
  if (!aiOut.ok) {
    return {
      ...result,
      usedAi: true,
      promptVersion,
      errorCode: result.fields.some((f) => f.value) ? result.errorCode : "AI_EXTRACTION_FAILED",
      errorMessage: result.fields.some((f) => f.value) ? result.errorMessage : "AI extraction failed. Enter values manually.",
    };
  }
  const parsed = parseAiExtraction(aiOut.payload, kind);
  if (!parsed.ok) {
    return {
      ...result,
      usedAi: true,
      promptVersion,
      errorCode: "AI_EXTRACTION_FAILED",
      errorMessage: "AI returned malformed output. Enter values manually.",
    };
  }
  return {
    ...result,
    fields: mergeFallbackFields(result.fields, parsed.fields),
    usedAi: true,
    promptVersion,
  };
}
