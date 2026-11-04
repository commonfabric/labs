/**
 * Parses a JSON Pointer (RFC 6901) string into its segment array, decoding
 * `~1` → `/` and `~0` → `~`. Inverse of `encodePointer()`.
 */
export const parsePointer = (path: string): string[] => {
  if (path === "") {
    return [];
  }
  if (!path.startsWith("/")) {
    throw new Error(`invalid JSON pointer: ${path}`);
  }
  return path.slice(1).split("/").map((segment) =>
    segment.replaceAll("~1", "/").replaceAll("~0", "~")
  );
};

/**
 * Encodes a path-segment array as a JSON Pointer (RFC 6901): empty path
 * becomes `""`, otherwise each segment is escaped (`~` → `~0`, `/` → `~1`)
 * and segments are joined with leading and inter-segment `/`. Inverse of
 * `parsePointer()`.
 *
 * Used both as a wire format (the `path` field of RFC 6902 JSON Patch
 * operations is a JSON Pointer) and as a canonical "logical-path → string"
 * Map-key form within this codebase.
 */
export const encodePointer = (path: readonly string[]): string => {
  let pointer = "";
  for (let segment of path) {
    if (segment.includes("~")) segment = segment.replaceAll("~", "~0");
    if (segment.includes("/")) segment = segment.replaceAll("/", "~1");
    pointer += "/" + segment;
  }
  return pointer;
};

/**
 * The JSON Pointer of each prefix of `path`, indexed by the prefix's length:
 * `prefixPointers(path)[i]` is `encodePointer(path.slice(0, i))`, from the
 * root's (`""`) to `path`'s own. Each is built from the one before, so the list
 * costs about one encoding of `path`.
 *
 * With a set of paths keyed by `encodePointer()`, which of them prefix `path`
 * is then one lookup per entry of this list, a cost that grows with the depth
 * of `path` rather than with the size of the set.
 */
export const prefixPointers = (path: readonly string[]): string[] => {
  const pointers = [""];
  let pointer = "";
  for (const segment of path) {
    pointer += encodePointer([segment]);
    pointers.push(pointer);
  }
  return pointers;
};

export const isPrefixPath = (
  prefix: readonly string[],
  path: readonly string[],
): boolean => {
  if (prefix.length > path.length) {
    return false;
  }
  return prefix.every((segment, index) => path[index] === segment);
};

export const pathsOverlap = (
  left: readonly string[],
  right: readonly string[],
): boolean => isPrefixPath(left, right) || isPrefixPath(right, left);

export const parentPath = (path: readonly string[]): string[] => {
  return path.length === 0 ? [] : [...path.slice(0, -1)];
};
