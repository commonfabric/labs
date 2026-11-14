import { crypto } from "@std/crypto";
import { encodeHex } from "@std/encoding/hex";

export async function sha256(content: string) {
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return encodeHex(new Uint8Array(hashBuffer));
}
