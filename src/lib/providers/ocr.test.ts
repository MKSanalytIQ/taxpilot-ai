import { afterEach, describe, expect, it } from "vitest";
import { getOcrProvider, GoogleVisionOcrProvider } from "./ocr";

const ORIGINAL = {
  provider: process.env.OCR_PROVIDER,
  key: process.env.GOOGLE_VISION_API_KEY,
};

afterEach(() => {
  if (ORIGINAL.provider === undefined) delete process.env.OCR_PROVIDER;
  else process.env.OCR_PROVIDER = ORIGINAL.provider;
  if (ORIGINAL.key === undefined) delete process.env.GOOGLE_VISION_API_KEY;
  else process.env.GOOGLE_VISION_API_KEY = ORIGINAL.key;
});

describe("getOcrProvider", () => {
  it("stays unconfigured when OCR is off, unknown, or missing a key", async () => {
    process.env.OCR_PROVIDER = "off";
    process.env.GOOGLE_VISION_API_KEY = "present";
    expect(getOcrProvider().name).toBe("unconfigured");
    expect(getOcrProvider().configured).toBe(false);

    process.env.OCR_PROVIDER = "google";
    process.env.GOOGLE_VISION_API_KEY = "";
    const missing = getOcrProvider();
    expect(missing.configured).toBe(false);
    expect(await missing.extractText({ fileName: "scan.png", mimeType: "image/png", bytes: Buffer.from("x") })).toEqual({
      pages: [],
      error: "Google Vision OCR is not configured. Enter values manually.",
    });

    process.env.OCR_PROVIDER = "not-a-provider";
    process.env.GOOGLE_VISION_API_KEY = "present";
    expect(getOcrProvider().name).toBe("unconfigured");
  });

  it("selects Google Vision only when the provider and server key are set", () => {
    process.env.OCR_PROVIDER = "google";
    process.env.GOOGLE_VISION_API_KEY = "server-only-key";
    const provider = getOcrProvider();
    expect(provider.name).toBe("google-vision");
    expect(provider.configured).toBe(true);
    expect(JSON.stringify(provider)).not.toContain("server-only-key");
  });
});

describe("GoogleVisionOcrProvider", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const pdf = Buffer.from("%PDF-1.4");

  function mockFetch(payload: unknown, capture: { url?: string; key?: string; body?: string }) {
    return (async (url: RequestInfo | URL, init?: RequestInit) => {
      capture.url = String(url);
      capture.key = new Headers(init?.headers).get("X-Goog-Api-Key") || "";
      capture.body = String(init?.body || "");
      return new Response(JSON.stringify(payload), { status: 200 });
    }) as typeof fetch;
  }

  it("reads PNG and JPEG without putting the key in the result", async () => {
    const capture: { url?: string; key?: string; body?: string } = {};
    const provider = new GoogleVisionOcrProvider("super-secret-vision-key", mockFetch({
      responses: [{ fullTextAnnotation: { text: "Form 16 Gross Salary 100000" } }],
    }, capture));
    const pngResult = await provider.extractText({ fileName: "scan.png", mimeType: "image/png", bytes: png });
    expect(capture.url).toBe("https://vision.googleapis.com/v1/images:annotate");
    expect(capture.key).toBe("super-secret-vision-key");
    expect(pngResult.pages[0]?.text).toContain("Gross Salary");
    expect(JSON.stringify(pngResult)).not.toContain("super-secret-vision-key");

    const jpegResult = await provider.extractText({ fileName: "scan.jpg", mimeType: "image/jpeg", bytes: jpeg });
    expect(jpegResult.pages).toHaveLength(1);
    expect(await provider.extract({ fileName: "scan.jpg", mimeType: "image/jpeg", bytes: jpeg })).toEqual([]);
  });

  it("reads a scanned PDF as pages", async () => {
    const capture: { url?: string; body?: string } = {};
    const provider = new GoogleVisionOcrProvider("super-secret-vision-key", mockFetch({
      responses: [{ responses: [{ fullTextAnnotation: { text: "Page one salary" } }, { fullTextAnnotation: { text: "Page two TDS" } }] }],
    }, capture));
    const result = await provider.extractText({ fileName: "scan.pdf", mimeType: "application/pdf", bytes: pdf });
    expect(capture.url).toBe("https://vision.googleapis.com/v1/files:annotate");
    expect(capture.body).toContain("application/pdf");
    expect(result.pages.map((page) => page.pageNumber)).toEqual([1, 2]);
    expect(result.pages[1]?.text).toContain("TDS");
  });

  it("returns a manual-entry error when Vision fails and does not throw", async () => {
    const provider = new GoogleVisionOcrProvider("super-secret-vision-key", (async () => new Response("nope super-secret-vision-key", { status: 403 })) as typeof fetch);
    const result = await provider.extractText({ fileName: "scan.png", mimeType: "image/png", bytes: png });
    expect(result.pages).toEqual([]);
    expect(result.error).toBe("OCR failed. Enter values manually.");
    expect(result.error).not.toContain("super-secret");
  });
});
