/**
 * Syntax of a codec type tag: zero or more namespace prefixes, each followed by
 * a `.`, then a type name, `@`, and a version number, as in `sys.beep.Boop@1`
 * and `Bytes@1`. Each prefix and the name is an ASCII letter followed by ASCII
 * letters and digits, in any case, at most 100 characters in all; there are at
 * most ten of them, the name included; and the version is a decimal integer
 * with no leading zero, of at most ten digits. Section 2.5.1 of
 * `1-fabric-values.md` in the formal spec is where that syntax is written down;
 * this is the check that holds every format to it. A type tag is an
 * interchange tag that has a version, which `isInterchangeTag()` checks the
 * wider syntax of. Case, and which namespaces are meant for whom, are
 * convention, and nothing here checks them.
 *
 * A `.` or `@` ends each component, and neither is in a component's alphabet,
 * so a string has one way to split into components, and a match does no more
 * than bounded work at each.
 */
const CODEC_TYPE_TAG_SYNTAX =
  /^(?:[A-Za-z][A-Za-z0-9]{0,99}\.){0,9}[A-Za-z][A-Za-z0-9]{0,99}@[1-9][0-9]{0,9}$/;

/**
 * Indicates whether `value` is a string whose syntax is that of a codec type
 * tag, as the members of `CODEC_TYPE_TAGS` are.
 *
 * This is the whole of what such a tag is structurally, and says nothing about
 * whether any codec claims it. That second question belongs to a registry, and
 * the two together are what separate an `UnknownValue` -- a tag naming a type
 * nothing here knows -- from a malformation, which names nothing at all. The
 * meta-tags in `CODEC_META_TAGS` are in the general syntax of an interchange
 * tag but have no version, so are not type tags, each being a structural
 * marker its format handles itself rather than a type anything can encode.
 */
export function isCodecTypeTag(value: any): value is string {
  return (typeof value === "string") && CODEC_TYPE_TAG_SYNTAX.test(value);
}
