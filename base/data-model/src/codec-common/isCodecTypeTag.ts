/**
 * Syntax of a codec type tag: zero or more namespace prefixes, a type name,
 * `@`, and a version number, as in `sys.beep.Boop@1`. Each prefix is a
 * `lowerCamelCase` name -- a lowercase ASCII letter followed by ASCII letters
 * and digits -- followed by a `.`. The type name is `UpperCamelCase` -- an
 * uppercase ASCII letter followed by ASCII letters and digits -- and the
 * version is a decimal integer with no leading zero. Section 2.5 of
 * `1-fabric-values.md` in the formal spec is where that syntax is written
 * down; this is the check that holds every format to it. Which namespaces are
 * meant for whom is convention, and nothing here checks it.
 */
const CODEC_TYPE_TAG_SYNTAX =
  /^(?:[a-z][A-Za-z0-9]*\.)*[A-Z][A-Za-z0-9]*@[1-9][0-9]*$/;

/**
 * Indicates whether `value` is a string whose syntax is that of a codec type
 * tag, as the members of `CODEC_TYPE_TAGS` are.
 *
 * This is the whole of what such a tag is structurally, and says nothing about
 * whether any codec claims it. That second question belongs to a registry, and
 * the two together are what separate an `UnknownValue` -- a tag naming a type
 * nothing here knows -- from a malformation, which names nothing at all. The
 * meta-tags in `CODEC_META_TAGS` are deliberately outside this syntax, each
 * being a structural marker its format handles itself rather than a type
 * anything can encode.
 */
export function isCodecTypeTag(value: any): value is string {
  return (typeof value === "string") && CODEC_TYPE_TAG_SYNTAX.test(value);
}
