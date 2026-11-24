/**
 * Encodes a tuple of strings as an opaque in-process Map or Set key.
 * Equal keys mean equal tuple lengths and equal strings at every position.
 * Empty strings, NULs, delimiters, and arbitrary UTF-16 contents retain their
 * identity. Callers supply strings and keep each key domain separate.
 */
export function stringTupleKey(parts: readonly string[]): string {
  let key = "";
  for (const part of parts) {
    key += part.length + ":" + part;
  }
  return key;
}
