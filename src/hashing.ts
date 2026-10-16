import { createHash } from "node:crypto";
import { closeSync, openSync, readSync } from "node:fs";

/** SHA-256 of a string's UTF-8 bytes or of a buffer, as lowercase hex. */
export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data, typeof data === "string" ? "utf8" : undefined).digest("hex");
}

/**
 * SHA-256 of a file, read in chunks so that packages larger than memory can
 * still be fingerprinted.
 */
export function sha256File(filePath: string): string {
  const hash = createHash("sha256");
  const fd = openSync(filePath, "r");
  try {
    const chunk = Buffer.alloc(1 << 20);
    for (;;) {
      const read = readSync(fd, chunk, 0, chunk.length, null);
      if (read <= 0) break;
      hash.update(chunk.subarray(0, read));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}
