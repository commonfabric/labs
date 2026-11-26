/**
 * Indicates whether every own enumerable key of `record` is one of `keys`. A
 * codec whose state is a record of fixed fields asks this from `canDecode()`,
 * so that a state carrying a field the codec does not read is refused rather
 * than decoded without it. The "Decoding validation" note in Section 3 of
 * `3-json-encoding.md` and Section 7.1 of `4-realm-encoding.md` state that
 * rule.
 */
export function hasOnlyKeys(
  record: object,
  keys: readonly string[],
): boolean {
  return Object.keys(record).every((key) => keys.includes(key));
}
