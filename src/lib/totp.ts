import { createHmac, randomBytes, timingSafeEqual } from "crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function generateTotpSecret() {
  const bytes = randomBytes(20);
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function decodeBase32(secret: string) {
  const clean = secret.replace(/=+$/g, "").toUpperCase().replace(/\s/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const idx = ALPHABET.indexOf(char);
    if (idx < 0) throw new Error("bad-secret");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function totpCode(secret: string, at = Date.now()) {
  const counter = Math.floor(at / 1000 / 30);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", decodeBase32(secret)).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const bin = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(bin % 1_000_000).padStart(6, "0");
}

export function verifyTotp(secret: string, code: string, at = Date.now()) {
  const normalized = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(normalized)) return false;
  const given = Buffer.from(normalized);
  for (const skew of [-1, 0, 1]) {
    const expected = Buffer.from(totpCode(secret, at + skew * 30_000));
    if (expected.length === given.length && timingSafeEqual(expected, given)) return true;
  }
  return false;
}

export function totpUri(secret: string, email: string) {
  const label = encodeURIComponent(`TaxPilot:${email}`);
  return `otpauth://totp/${label}?secret=${encodeURIComponent(secret)}&issuer=TaxPilot&algorithm=SHA1&digits=6&period=30`;
}

/** Noon UTC on a YYYY-MM-DD filing date. Empty means now. Invalid dates are rejected. */
export function filingInstant(value: string | undefined, now = new Date()) {
  const raw = String(value || "").trim();
  if (!raw) return now;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const instant = new Date(`${raw}T12:00:00.000Z`);
  if (Number.isNaN(instant.getTime()) || instant.toISOString().slice(0, 10) !== raw) return null;
  const year = instant.getUTCFullYear();
  if (year < 2024 || year > now.getUTCFullYear() + 1) return null;
  return instant;
}
