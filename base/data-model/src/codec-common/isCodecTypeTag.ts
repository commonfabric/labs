/**
 * Syntax of a codec type tag: zero or more namespace prefixes, each followed by
 * a `.`, then a name and an optional `@` and version, as in `sys.beep.Boop@1`,
 * `Bytes@1` and `fid1`. Each prefix and the name is an ASCII letter followed by
 * ASCII letters and digits, in any case, and the version is a decimal integer
 * with no leading zero. The version is optional on a tag with no prefix and
 * required on one with a prefix, so `sys.Boop` is not a tag. Section 2.5 of
 * `1-fabric-values.md` in the formal spec is where that syntax is written
 * down; this is the check that holds every format to it. Case, and which
 * namespaces are meant for whom, are convention, and nothing here checks them.
 */
const CODEC_TYPE_TAG_SYNTAX =
  /^(?:[A-Za-z][A-Za-z0-9]*(?:@[1-9][0-9]*)?|(?:[A-Za-z][A-Za-z0-9]*\.)+[A-Za-z][A-Za-z0-9]*@[1-9][0-9]*)$/;

/**
 * Indicates whether `value` is a string whose syntax is that of a codec type
 * tag, as the members of `CODEC_TYPE_TAGS` are.
 *
 * This is the whole of what such a tag is structurally, and says nothing about
 * whether any codec claims it. That second question belongs to a registry, and
 * the two together are what separate an `UnknownValue` -- a tag naming a type
 * nothing here knows -- from a malformation, which names nothing at all. A
 * format may reserve names in the syntax for forms of its own, as the JSON
 * format does the names in `CODEC_META_TAGS`; reserving them is that format's
 * business, and this check admits them.
 */
export function isCodecTypeTag(value: any): value is string {
  return (typeof value === "string") && CODEC_TYPE_TAG_SYNTAX.test(value);
}
