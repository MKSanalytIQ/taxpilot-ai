export const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;
export const MAX_PDF_PAGES = 30;
export const MAX_SPREADSHEET_ROWS = 2_000;
export const MAX_PROCESSING_MS = 20_000;

export class DocumentLimitError extends Error {
  constructor(readonly code: "PDF_PAGE_LIMIT" | "SPREADSHEET_ROW_LIMIT" | "PROCESS_TIMEOUT") {
    super(code);
  }
}

export function withDeadline<T>(work: Promise<T>, ms = MAX_PROCESSING_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DocumentLimitError("PROCESS_TIMEOUT")), ms);
  });
  return Promise.race([work, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
