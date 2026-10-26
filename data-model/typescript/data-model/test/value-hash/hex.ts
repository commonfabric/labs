/** Returns the lowercase hex rendering of `hash`. */
export function hex(hash: Uint8Array): string {
  return Array.from(hash).map((b) => b.toString(16).padStart(2, "0")).join("");
}
