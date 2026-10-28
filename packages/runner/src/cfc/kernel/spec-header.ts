/**
 * The header a kernel function carries, naming the pseudocode block it was
 * derived from, and the parser for it.
 *
 * A kernel function is the runtime's copy of a function the Contextual Flow
 * Control specification states as pseudocode. Its doc comment carries one
 * `@spec` tag:
 *
 * ```text
 * @spec 08-12-store-label-monotonicity.md §8.12.1 atomLe sha256:<64 hex>
 * ```
 *
 * The four fields are the chapter file within the specification's `cfc/`
 * directory, the section the block sits under, the function's name as the
 * block declares it, and the SHA-256 of the normalized block, which is the
 * hash the spec snapshot records for that function. The correspondence check
 * compares the header's hash against the snapshot's, so a change to the
 * block in the specification turns into a failure here once the snapshot is
 * regenerated, and a kernel function whose header names a block the
 * specification no longer has fails the same way.
 */

/** The fields of one `@spec` header. */
export interface SpecHeader {
  /** The chapter file, e.g. `08-12-store-label-monotonicity.md`. */
  readonly file: string;

  /** The section the block sits under, e.g. `8.12.1`. */
  readonly section: string;

  /** The function's name as the block declares it. */
  readonly name: string;

  /** SHA-256 of the normalized block, as lowercase hex. */
  readonly sha256: string;
}

/**
 * One `@spec` tag. The section is written with its `§`, the hash with its
 * `sha256:` prefix, and the fields are separated by whitespace, which lets a
 * header wrap across the continuation lines of a doc comment. The hash ends
 * at a token boundary, so a 65th hex digit or a letter run on from it makes
 * the tag malformed rather than a 64-digit match.
 */
const SPEC_TAG =
  /@spec\s+([\w.-]+\.md)\s+§(\d+(?:\.\d+)*)\s+([A-Za-z_$][\w$]*)\s+sha256:([0-9a-f]{64})(?![\w$])/g;

/** The ` * ` a doc comment opens each continuation line with. */
const CONTINUATION_PREFIX = /^[ \t]*\*(?!\/)[ \t]?/gm;

/**
 * Parses the `@spec` tags in the text of one doc comment, in order, reading
 * past the `*` each continuation line opens with so a tag wrapped across
 * lines is one tag. A comment with no tag parses to an empty list; one whose
 * tag is malformed parses as though the tag were absent, since the regular
 * expression is the whole of what this recognizes.
 */
export function parseSpecHeaders(comment: string): SpecHeader[] {
  const headers: SpecHeader[] = [];
  const text = comment.replace(CONTINUATION_PREFIX, " ");
  for (const match of text.matchAll(SPEC_TAG)) {
    const [, file, section, name, sha256] = match;
    headers.push({ file, section, name, sha256 });
  }
  return headers;
}

/** Writes `header` as the text of its tag. */
export function formatSpecHeader(header: SpecHeader): string {
  return `@spec ${header.file} §${header.section} ${header.name} ` +
    `sha256:${header.sha256}`;
}
