import type { PdfPage } from "./types";
import { pagesFromText } from "./pages";
import { DocumentLimitError, MAX_PDF_PAGES } from "./limits";

export async function extractPdfPages(bytes: Buffer): Promise<PdfPage[]> {
  if (bytes.length < 5 || bytes.subarray(0, 5).toString("ascii") !== "%PDF-") return [];
  try {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    if (pdf.numPages > MAX_PDF_PAGES) throw new DocumentLimitError("PDF_PAGE_LIMIT");
    const { text } = await extractText(pdf, { mergePages: false });
    const pages = Array.isArray(text) ? text : [String(text || "")];
    if (pages.length > MAX_PDF_PAGES) throw new DocumentLimitError("PDF_PAGE_LIMIT");
    return pages.map((t, i) => ({ pageNumber: i + 1, text: String(t || "").replace(/\s+/g, " ").trim() }));
  } catch (error) {
    if (error instanceof DocumentLimitError) throw error;
    return [];
  }
}

export async function extractPages(bytes: Buffer, mime: string, fileName: string): Promise<PdfPage[]> {
  if (mime === "application/pdf") return extractPdfPages(bytes);
  if (mime === "text/csv" || mime === "text/plain" || /\.csv$/i.test(fileName) || /\.txt$/i.test(fileName)) {
    return pagesFromText(bytes.toString("utf8"));
  }
  return [];
}
