import { describe, expect, it } from "vitest";
import { BlobStorage, S3Storage, selectStorage, StorageNotConfiguredError, type BlobClient } from "./storage";

describe("document storage", () => {
  it("does not use local disk in production when object storage is missing", async () => {
    const storage = selectStorage({ NODE_ENV: "production" });
    expect(storage.name).toBe("unconfigured");
    await expect(storage.put("user/file.pdf", Buffer.from("pdf"), "application/pdf")).rejects.toBeInstanceOf(StorageNotConfiguredError);
  });

  it("stores privately in S3 and does not leak the secret", async () => {
    let captured: { url?: string; auth?: string; acl?: string; body?: Buffer } = {};
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      captured = {
        url: String(url),
        auth: headers.get("authorization") || "",
        acl: headers.get("x-amz-acl") || "",
        body: Buffer.from(init?.body as ArrayBuffer),
      };
      return new Response(Buffer.from("saved-bytes"), { status: 200 });
    }) as typeof fetch;
    const storage = selectStorage(
      {
        NODE_ENV: "production",
        S3_BUCKET: "taxpilot-private",
        S3_ENDPOINT: "https://storage.example.test",
        S3_ACCESS_KEY: "access-key",
        S3_SECRET_KEY: "super-secret-storage",
        S3_REGION: "auto",
      },
      fetchImpl,
    );
    expect(storage).toBeInstanceOf(S3Storage);
    await storage.put("user-a/form.pdf", Buffer.from("pdf-bytes"), "application/pdf");
    expect(captured.url).toBe("https://storage.example.test/taxpilot-private/user-a/form.pdf");
    expect(captured.auth).toContain("AWS4-HMAC-SHA256");
    expect(captured.acl).toBe("");
    expect(captured.body?.toString()).toBe("pdf-bytes");
    expect(JSON.stringify(captured)).not.toContain("super-secret-storage");
    await expect(storage.put("../etc/passwd", Buffer.from("x"), "text/plain")).rejects.toThrow("STORAGE_KEY_REJECTED");
    const signed = await storage.signedUrl("user-a/form.pdf", 60);
    expect(signed.startsWith("https://storage.example.test/taxpilot-private/user-a/form.pdf?")).toBe(true);
    expect(signed).toContain("X-Amz-Algorithm=AWS4-HMAC-SHA256");
    expect(signed).toContain("X-Amz-Expires=60");
    expect(signed).toContain("X-Amz-Signature=");
    expect(signed).not.toContain("super-secret-storage");
  });

  it("stores private documents in Vercel Blob and keeps downloads on the app", async () => {
    const calls: string[] = [];
    const client: BlobClient = {
      async put(pathname, body) {
        calls.push(`put:${pathname}:${body.toString()}`);
      },
      async get(pathname) {
        calls.push(`get:${pathname}`);
        return { statusCode: 200, stream: new Response("saved").body };
      },
      async del(pathname) {
        calls.push(`del:${pathname}`);
      },
    };
    const storage = selectStorage({ NODE_ENV: "production", BLOB_READ_WRITE_TOKEN: "blob-token" }, undefined, client);
    expect(storage).toBeInstanceOf(BlobStorage);
    await storage.put("user-a/form.pdf", Buffer.from("pdf-bytes"), "application/pdf");
    expect(Buffer.from(await storage.get("user-a/form.pdf")).toString()).toBe("saved");
    await storage.delete("user-a/form.pdf");
    expect(await storage.signedUrl("user-a/form.pdf", 60)).toBe("");
    expect(calls).toEqual(["put:user-a/form.pdf:pdf-bytes", "get:user-a/form.pdf", "del:user-a/form.pdf"]);
    await expect(storage.put("../secret", Buffer.from("x"), "text/plain")).rejects.toThrow("STORAGE_KEY_REJECTED");
  });
});
