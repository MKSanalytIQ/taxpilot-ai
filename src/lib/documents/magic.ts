import { MAX_UPLOAD_BYTES } from "./limits";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function isZipSignature(bytes: Buffer) {
  if (bytes.length < 4) return false;
  return bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07);
}

export function isXlsxContainer(bytes: Buffer) {
  if (!isZipSignature(bytes)) return false;
  const probe = bytes.subarray(0, Math.min(bytes.length, 16384)).toString("latin1");
  return probe.includes("[Content_Types].xml") && (probe.includes("xl/") || probe.includes("workbook.xml"));
}

export function sniffMime(bytes: Buffer, fileName: string, claimed: string) {
  const name = fileName.toLowerCase();
  if (bytes.length >= 5 && bytes.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (isXlsxContainer(bytes)) return XLSX_MIME;
  if (name.endsWith(".csv") || claimed === "text/csv") return "text/csv";
  if (claimed === XLSX_MIME || claimed.includes("spreadsheet") || name.endsWith(".xlsx")) {
    return "application/octet-stream";
  }
  if (claimed.startsWith("text/")) return claimed;
  return claimed || "application/octet-stream";
}

export function isAllowedUpload(mime: string, size: number) {
  const ok = [
    "application/pdf",
    "image/jpeg",
    "image/png",
    "text/csv",
    "text/plain",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ].includes(mime);
  if (!ok) return { ok: false, code: "INVALID_TYPE" };
  if (size <= 0) return { ok: false, code: "EMPTY" };
  if (size > MAX_UPLOAD_BYTES) return { ok: false, code: "OVERSIZE" };
  return { ok: true, code: "" };
}
