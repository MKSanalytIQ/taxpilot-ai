import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

function xmlEscape(value: string) {
  return value
    .replace(/&/g, "\u0026amp;")
    .replace(/</g, "\u0026lt;")
    .replace(/>/g, "\u0026gt;")
    .replace(/"/g, "\u0026quot;");
}

function xmlDecode(value: string) {
  return value
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/\u0026lt;/g, "<")
    .replace(/\u0026gt;/g, ">")
    .replace(/\u0026quot;/g, '"')
    .replace(/\u0026apos;/g, "'")
    .replace(/\u0026amp;/g, "&");
}

function columnIndex(ref: string) {
  let index = 0;
  for (const char of ref) {
    if (char < "A" || char > "Z") break;
    index = index * 26 + (char.charCodeAt(0) - 64);
  }
  return index - 1;
}

function cellText(inner: string, type: string, shared: string[]) {
  if (type === "inlineStr") {
    return [...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((match) => xmlDecode(match[1])).join("");
  }
  const value = inner.match(/<v>([\s\S]*?)<\/v>/)?.[1];
  if (value == null) return "";
  if (type === "s") return shared[Number(value)] || "";
  return xmlDecode(value);
}

function sharedStrings(xml: string) {
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((item) =>
    [...item[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((match) => xmlDecode(match[1])).join(""),
  );
}

export function writeXlsxSheet(rows: string[][]): Buffer {
  const sheetRows = rows
    .map((row, rowIndex) => {
      const cells = row
        .map((value, column) => {
          const ref = `${String.fromCharCode(65 + column)}${rowIndex + 1}`;
          return `<c r="${ref}" t="inlineStr"><is><t>${xmlEscape(value)}</t></is></c>`;
        })
        .join("");
      return `<row r="${rowIndex + 1}">${cells}</row>`;
    })
    .join("");
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
    ),
    "_rels/.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ),
    "xl/workbook.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    ),
    "xl/_rels/workbook.xml.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    ),
    "xl/worksheets/sheet1.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`,
    ),
  };
  return Buffer.from(zipSync(files));
}

export function readXlsxSheet(bytes: Uint8Array, maxRows = Number.POSITIVE_INFINITY): string[][] {
  const files = unzipSync(bytes);
  const byName = new Map(Object.keys(files).map((name) => [name.replace(/^\/+/, ""), files[name]]));
  const sheetName = [...byName.keys()].find((name) => /xl\/worksheets\/sheet\d+\.xml$/.test(name));
  if (!sheetName) return [];
  const sharedFile = byName.get("xl/sharedStrings.xml");
  const shared = sharedFile ? sharedStrings(strFromU8(sharedFile)) : [];
  const xml = strFromU8(byName.get(sheetName)!);
  const rows: string[][] = [];
  for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    if (rows.length >= maxRows) break;
    const cells: string[] = [];
    for (const cell of row[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const ref = cell[1].match(/\br="([A-Z]+)\d+"/)?.[1] || "";
      const type = cell[1].match(/\bt="([^"]+)"/)?.[1] || "";
      const index = ref ? columnIndex(ref) : cells.length;
      cells[index] = cellText(cell[2], type, shared);
    }
    rows.push(cells.map((value) => value || ""));
  }
  return rows;
}
