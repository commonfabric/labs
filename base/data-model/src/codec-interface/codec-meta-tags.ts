/**
 * Canonical "meta" tags for use in wire formats. It is in the form of a frozen
 * `const` to help prevent inadvertent skew.
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
