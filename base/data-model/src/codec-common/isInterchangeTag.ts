/**
 * Syntax of a tag carried in an interchange format: zero or more namespace
 * prefixes, each followed by a `.`, then a name and an optional `@` and
 * version, as in `sys.beep.Boop@1`, `Bytes@1` and `fid1`. Each prefix and the
 * name is an ASCII letter followed by ASCII letters and digits, in any case,
 * at most 100 characters in all; there are at most ten of them, the name
 * included; and the version is a decimal integer with no leading zero, of at
 * most ten digits. The version is optional on a tag with no prefix and
 * required on one with a prefix, so `sys.Boop` is not a tag. Section 2.5.1 of
 * `1-fabric-values.md` in the formal spec is where that syntax is written
 * down. A type tag is such a tag that has a version, which `isCodecTypeTag()`
 * checks.
 *
 * The first alternative is a tag of one component, and the second a tag of
 * two to ten, which is why it repeats a prefix one to nine times.
 */
const INTERCHANGE_TAG_SYNTAX =
  /^(?:[A-Za-z][A-Za-z0-9]{0,99}(?:@[1-9][0-9]{0,9})?|(?:[A-Za-z][A-Za-z0-9]{0,99}\.){1,9}[A-Za-z][A-Za-z0-9]{0,99}@[1-9][0-9]{0,9})$/;

/**
 * Indicates whether `value` is a string in the general syntax of an
 * interchange tag. A hash algorithm tag carried in a `Hash@1` state is held to
 * this syntax rather than to the narrower one of a type tag, its names, such as
 * `fid1`, having no version.
 */
export function isInterchangeTag(value: any): value is string {
  return (typeof value === "string") && INTERCHANGE_TAG_SYNTAX.test(value);
}
