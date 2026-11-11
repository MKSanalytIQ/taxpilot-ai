import { createHash, createHmac, randomBytes } from "crypto";
import { mkdir, writeFile, readFile, unlink } from "fs/promises";
import path from "path";

export interface StorageProvider {
  name: string;
  put(key: string, bytes: Buffer, contentType: string): Promise<{ key: string }>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  signedUrl(key: string, ttlSeconds: number): Promise<string>;
}

export class StorageNotConfiguredError extends Error {
  constructor() {
    super("STORAGE_NOT_CONFIGURED");
    this.name = "StorageNotConfiguredError";
  }
}

const localRoot = process.env.VERCEL
  ? path.join("/tmp", "taxpilot-storage")
  : path.join(process.cwd(), "storage", "documents");

export function assertPrivateKey(key: string) {
  if (!key || key.includes("..") || key.includes("\\") || key.startsWith("/") || path.isAbsolute(key)) {
    throw new Error("STORAGE_KEY_REJECTED");
  }
}

function localPath(key: string) {
  assertPrivateKey(key);
  const full = path.resolve(localRoot, key);
  const base = path.resolve(localRoot);
  if (full !== base && !full.startsWith(base + path.sep)) throw new Error("STORAGE_KEY_REJECTED");
  return full;
}

/** Development only. Production must not use this. */
export class LocalDiskStorage implements StorageProvider {
  name = "local-disk";
  async put(key: string, bytes: Buffer) {
    const full = localPath(key);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, bytes);
    return { key };
  }
  async get(key: string) {
    return readFile(localPath(key));
  }
  async delete(key: string) {
    await unlink(localPath(key)).catch(() => undefined);
  }
  async signedUrl() {
    return "";
  }
}

export class UnconfiguredStorage implements StorageProvider {
  name = "unconfigured";
  async put(): Promise<{ key: string }> {
    throw new StorageNotConfiguredError();
  }
  async get(): Promise<Buffer> {
    throw new StorageNotConfiguredError();
  }
  async delete() {
    throw new StorageNotConfiguredError();
  }
  async signedUrl(): Promise<string> {
    throw new StorageNotConfiguredError();
  }
}

export type S3Config = {
  bucket: string;
  endpoint: string;
  accessKey: string;
  secretKey: string;
  region: string;
};

export function readS3Config(env: NodeJS.ProcessEnv = process.env): S3Config | null {
  const bucket = String(env.S3_BUCKET || "").trim();
  const endpoint = String(env.S3_ENDPOINT || "").trim().replace(/\/+$/, "");
  const accessKey = String(env.S3_ACCESS_KEY || "").trim();
  const secretKey = String(env.S3_SECRET_KEY || "").trim();
  const region = String(env.S3_REGION || "").trim() || "auto";
  if (!bucket || !endpoint || !accessKey || !secretKey) return null;
  return { bucket, endpoint, accessKey, secretKey, region };
}

function sha256Hex(body: Buffer | string) {
  return createHash("sha256").update(body).digest("hex");
}

function hmac(key: Buffer | string, data: string) {
  return createHmac("sha256", key).update(data).digest();
}

export function signS3(input: {
  method: string;
  url: URL;
  body: Buffer;
  accessKey: string;
  secretKey: string;
  region: string;
  contentType?: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(input.body);
  const headers: Record<string, string> = {
    host: input.url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  if (input.contentType) headers["content-type"] = input.contentType;
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((name) => `${name}:${headers[name].trim()}\n`).join("");
  const canonical = [input.method, input.url.pathname, input.url.searchParams.toString(), canonicalHeaders, names.join(";"), payloadHash].join("\n");
  const scope = `${dateStamp}/${input.region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonical)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${input.secretKey}`, dateStamp), input.region), "s3"), "aws4_request");
  const signature = createHmac("sha256", key).update(stringToSign).digest("hex");
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKey}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`,
  };
}

export function presignS3Get(config: S3Config, key: string, ttlSeconds: number, now = new Date()) {
  assertPrivateKey(key);
  const ttl = Math.min(Math.max(Math.floor(ttlSeconds) || 60, 1), 3600);
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${config.region}/s3/aws4_request`;
  const url = objectUrl(config, key);
  const params = new URLSearchParams({
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${config.accessKey}/${scope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(ttl),
    "X-Amz-SignedHeaders": "host",
  });
  params.sort();
  const canonical = ["GET", url.pathname, params.toString(), `host:${url.host}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonical)].join("\n");
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${config.secretKey}`, dateStamp), config.region), "s3"), "aws4_request");
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  params.set("X-Amz-Signature", signature);
  url.search = params.toString();
  return url.toString();
}

function objectUrl(config: S3Config, key: string) {
  assertPrivateKey(key);
  const encoded = key.split("/").map(encodeURIComponent).join("/");
  return new URL(`${config.endpoint}/${config.bucket}/${encoded}`);
}

/** Private S3-compatible bucket. Objects are not given a public ACL. */
export class S3Storage implements StorageProvider {
  name = "s3";
  #config: S3Config;
  #fetch: typeof fetch;

  constructor(config: S3Config, fetchImpl: typeof fetch = fetch) {
    this.#config = config;
    this.#fetch = fetchImpl;
  }

  async #call(method: string, key: string, body: Buffer, contentType?: string) {
    const url = objectUrl(this.#config, key);
    const headers = signS3({
      method,
      url,
      body,
      accessKey: this.#config.accessKey,
      secretKey: this.#config.secretKey,
      region: this.#config.region,
      contentType,
    });
    const response = await this.#fetch(url, {
      method,
      headers,
      body: method === "GET" || method === "DELETE" ? undefined : new Uint8Array(body),
    });
    if (!response.ok) throw new Error("STORAGE_FAILED");
    return response;
  }

  async put(key: string, bytes: Buffer, contentType: string) {
    await this.#call("PUT", key, bytes, contentType || "application/octet-stream");
    return { key };
  }
  async get(key: string) {
    const response = await this.#call("GET", key, Buffer.alloc(0));
    return Buffer.from(await response.arrayBuffer());
  }
  async delete(key: string) {
    await this.#call("DELETE", key, Buffer.alloc(0));
  }
  async signedUrl(key: string, ttlSeconds: number) {
    return presignS3Get(this.#config, key, ttlSeconds);
  }
}

export function readBlobToken(env: NodeJS.ProcessEnv = process.env) {
  return String(env.BLOB_READ_WRITE_TOKEN || "").trim();
}

type BlobPutOptions = { access: "private"; token: string; contentType?: string; addRandomSuffix: false };
type BlobGetResult = { statusCode: number; stream: ReadableStream<Uint8Array> | null } | null;

export type BlobClient = {
  put(pathname: string, body: Buffer, options: BlobPutOptions): Promise<unknown>;
  get(pathname: string, options: { access: "private"; token: string }): Promise<BlobGetResult>;
  del(pathname: string, options: { token: string }): Promise<void>;
};

async function vercelBlobClient(): Promise<BlobClient> {
  const blob = await import("@vercel/blob");
  return {
    put: (pathname, body, options) => blob.put(pathname, body, options),
    get: (pathname, options) => blob.get(pathname, options),
    del: (pathname, options) => blob.del(pathname, options),
  };
}

/** Private Vercel Blob store. Downloads stay on the authenticated app route. */
export class BlobStorage implements StorageProvider {
  name = "vercel-blob";
  #token: string;
  #client: BlobClient | undefined;
  #load: () => Promise<BlobClient>;

  constructor(token: string, client?: BlobClient) {
    this.#token = token;
    this.#client = client;
    this.#load = client ? async () => client : vercelBlobClient;
  }

  async #api() {
    this.#client ??= await this.#load();
    return this.#client;
  }

  async put(key: string, bytes: Buffer, contentType: string) {
    assertPrivateKey(key);
    await (
      await this.#api()
    ).put(key, bytes, {
      access: "private",
      token: this.#token,
      contentType: contentType || "application/octet-stream",
      addRandomSuffix: false,
    });
    return { key };
  }

  async get(key: string) {
    assertPrivateKey(key);
    const result = await (await this.#api()).get(key, { access: "private", token: this.#token });
    if (!result || result.statusCode !== 200 || !result.stream) throw new Error("STORAGE_FAILED");
    return Buffer.from(await new Response(result.stream).arrayBuffer());
  }

  async delete(key: string) {
    assertPrivateKey(key);
    await (await this.#api()).del(key, { token: this.#token });
  }

  async signedUrl() {
    return "";
  }
}
export function selectStorage(env: NodeJS.ProcessEnv = process.env, fetchImpl?: typeof fetch, blobClient?: BlobClient): StorageProvider {
  const config = readS3Config(env);
  if (config) return new S3Storage(config, fetchImpl);
  const blobToken = readBlobToken(env);
  if (blobToken) return new BlobStorage(blobToken, blobClient);
  if (env.NODE_ENV === "production" || env.VERCEL) return new UnconfiguredStorage();
  return new LocalDiskStorage();
}

export function getStorage(): StorageProvider {
  return selectStorage(process.env);
}

export function newStorageKey(userId: string, fileName: string) {
  const safe = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `${userId}/${Date.now()}-${randomBytes(4).toString("hex")}-${safe}`;
}
