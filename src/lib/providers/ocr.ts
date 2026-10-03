import type { PdfPage } from "@/lib/documents/types";

export type ExtractionCandidate = {
  fieldKey: string;
  extractedValue: string;
  numericValue?: number;
  confidence: number;
  pageRef?: string;
};

export type OcrTextResult = { pages: PdfPage[]; error?: string };

export interface DocumentExtractionProvider {
  name: string;
  configured: boolean;
  extractText(input: { fileName: string; mimeType: string; bytes: Buffer }): Promise<OcrTextResult>;
  extract(input: { fileName: string; mimeType: string; bytes: Buffer }): Promise<ExtractionCandidate[]>;
}

const OCR_FAILED = "OCR failed. Enter values manually.";
const OCR_EMPTY = "OCR returned no text. Enter values manually.";
const OCR_UNSUPPORTED = "This file cannot be read by OCR. Enter values manually.";

const VISION_IMAGES = "https://vision.googleapis.com/v1/images:annotate";
const VISION_FILES = "https://vision.googleapis.com/v1/files:annotate";

type VisionPage = { fullTextAnnotation?: { text?: string } };
type VisionPayload = { responses?: Array<VisionPage & { responses?: VisionPage[] }> };

function pageText(page: VisionPage | undefined) {
  return String(page?.fullTextAnnotation?.text || "").replace(/\s+/g, " ").trim();
}

function pagesFromImage(payload: VisionPayload): PdfPage[] {
  const text = pageText(payload.responses?.[0]);
  return text ? [{ pageNumber: 1, text }] : [];
}

function pagesFromPdf(payload: VisionPayload): PdfPage[] {
  const inner = payload.responses?.[0]?.responses || [];
  return inner.map((page, index) => ({ pageNumber: index + 1, text: pageText(page) })).filter((page) => page.text);
}

/** Isolated development adapter — does not pretend to read documents. */
export class UnconfiguredOcrProvider implements DocumentExtractionProvider {
  name = "unconfigured";
  configured = false;
  async extractText(): Promise<OcrTextResult> {
    return { pages: [], error: "OCR_PROVIDER is not configured" };
  }
  async extract(): Promise<ExtractionCandidate[]> {
    return [];
  }
}

/**
 * Google Cloud Vision via the REST API. The key stays on the server.
 * Text is returned only; field mapping stays in the existing extractors.
 */
export class GoogleVisionOcrProvider implements DocumentExtractionProvider {
  name = "google-vision";
  configured = true;
  #apiKey: string;
  #fetch: typeof fetch;

  constructor(apiKey: string, fetchImpl: typeof fetch = fetch) {
    this.#apiKey = apiKey;
    this.#fetch = fetchImpl;
  }

  async extractText(input: { fileName: string; mimeType: string; bytes: Buffer }): Promise<OcrTextResult> {
    const mime = input.mimeType === "image/jpg" ? "image/jpeg" : input.mimeType;
    const pdf = mime === "application/pdf";
    if (!pdf && mime !== "image/jpeg" && mime !== "image/png") {
      return { pages: [], error: OCR_UNSUPPORTED };
    }
    try {
      const content = input.bytes.toString("base64");
      const response = await this.#fetch(pdf ? VISION_FILES : VISION_IMAGES, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": this.#apiKey,
        },
        body: JSON.stringify(
          pdf
            ? {
                requests: [
                  {
                    inputConfig: { mimeType: "application/pdf", content },
                    features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
                    pages: [1, 2, 3, 4, 5],
                  },
                ],
              }
            : {
                requests: [
                  {
                    image: { content },
                    features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
                  },
                ],
              },
        ),
      });
      if (!response.ok) return { pages: [], error: OCR_FAILED };
      const payload = (await response.json()) as VisionPayload;
      const pages = pdf ? pagesFromPdf(payload) : pagesFromImage(payload);
      if (!pages.some((page) => page.text)) return { pages: [], error: OCR_EMPTY };
      return { pages };
    } catch {
      return { pages: [], error: OCR_FAILED };
    }
  }

  async extract(_input: { fileName: string; mimeType: string; bytes: Buffer }): Promise<ExtractionCandidate[]> {
    return [];
  }
}

const GOOGLE_VISION = new Set(["google", "google-vision", "vision"]);

export function getOcrProvider(): DocumentExtractionProvider {
  const name = (process.env.OCR_PROVIDER || "").trim().toLowerCase();
  if (!name || name === "off" || name === "none") return new UnconfiguredOcrProvider();
  if (!GOOGLE_VISION.has(name)) return new UnconfiguredOcrProvider();
  const apiKey = (process.env.GOOGLE_VISION_API_KEY || "").trim();
  if (!apiKey) return new UnconfiguredOcrProvider();
  return new GoogleVisionOcrProvider(apiKey);
}

export const MIN_AUTO_INSERT_CONFIDENCE = 0.92;

export type ExtractionStatus = "UPLOADED" | "PROCESSING" | "EXTRACTED" | "NEEDS_REVIEW" | "CONFIRMED" | "FAILED";

export type ExtractionField = {
  field: string;
  value: string;
  confidence: number;
  sourceDocument: string;
  sourceLocation: string;
  confirmed: boolean;
  confirmedAt?: string;
};
