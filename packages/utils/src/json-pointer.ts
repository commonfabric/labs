/**
 * The RFC 6901 JSON Pointer codec: a path of tokens to the pointer string
 * that names it, and back. Escaping alone — `~` and `/` inside a token —
 * with no view on what the tokens address; a caller that resolves a pointer
 * against a document, or that gives the empty first token the root meaning
 * the RFC assigns it, does that on the decoded path.
 */

/**
 * Encodes a path of tokens as a JSON Pointer: each token has `~` replaced
 * with `~0` and `/` with `~1`, and the tokens are joined with `/`.
 */
export function encodeJsonPointer(path: readonly string[]): string {
  return path
    .map((token) => token.replace(/~/g, "~0").replace(/\//g, "~1"))
    .join("/");
}

/**
 * Decodes a JSON Pointer into its tokens: the string is split on `/`, then
 * `~1` becomes `/` and `~0` becomes `~` in each token, in that order.
 */
export function decodeJsonPointer(pointer: string): string[] {
  return pointer
    .split("/")
    .map((token) => token.replace(/~1/g, "/").replace(/~0/g, "~"));
}
