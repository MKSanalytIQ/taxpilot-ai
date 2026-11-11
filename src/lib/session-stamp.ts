import { createHash } from "node:crypto";

export function passwordSessionStamp(passwordHash: string) {
  return createHash("sha256").update(passwordHash).digest("hex").slice(0, 16);
}
