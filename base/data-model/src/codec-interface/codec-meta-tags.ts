/**
 * Canonical "meta" tags for use in wire formats. It is in the form of a frozen
 * `const` to help prevent inadvertent skew.
 *
 * Each of these is in the general syntax of an interchange tag, but has no
 * version and so is not a type tag: a key under one of them is a form of the
 * format's own, never a type a codec encodes (`3-json-encoding.md` Section 2).
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
