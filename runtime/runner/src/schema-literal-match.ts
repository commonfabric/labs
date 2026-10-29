/**
 * How a value is held to a schema's `const` and `enum` members.
 *
 * A member is a JSON value, so a schema cannot write a bigint: the schema
 * generator writes a bigint literal type as the number of that value. JSON
 * Schema compares two numbers by their mathematical value, whatever form each
 * is written in, and a stored bigint is that member's integer, so a
 * whole-number member matches the bigint of its value, and nothing else
 * matches across the two types. The equality of every other pair is the
 * caller's, since the sites differ in whether their operands may hold
 * query-result views.
 */

/**
 * Whether `value` matches the `const` or `enum` member `member`, under
 * `equal` for every pair but a whole-number member and a bigint, which match
 * when the bigint is that number.
 */
export function literalMemberMatches(
  member: unknown,
  value: unknown,
  equal: (member: unknown, value: unknown) => boolean,
): boolean {
  if (typeof value === "bigint" && typeof member === "number") {
    return Number.isInteger(member) && BigInt(member) === value;
  }
  return equal(member, value);
}
