/**
 * Canonical "meta" tags for use in wire formats. It is in the form of a frozen
 * `const` to help prevent inadvertent skew.
 *
 * Each of these is syntactically a tag, and the JSON format reserves it in tag
 * position for a form of its own (`3-json-encoding.md` Section 2): its decoder
 * reads a `/`-prefixed key with one of these names as that form, so its
 * encoder refuses a value whose type tag is one of them. The reservation is
 * that format's alone; elsewhere these are tags like any other.
 */
export const CODEC_META_TAGS = Object.freeze(
  {
    /** Tag representing a literal "quoted" value. */
    quote: "quote",

    /** Tag representing an array hole or series of same. */
    hole: "hole",

    /** Tag representing a partially-quoted plain object. */
    object: "object",
  } as const,
);
