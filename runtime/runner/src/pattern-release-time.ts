/**
 * When a deployment released the system patterns it serves, which is what
 * orders two releases of one `system:` pattern.
 *
 * A pattern's identity is a content hash, so two identities say only that two
 * sources differ, and a piece that adopted whatever differed would move back
 * and forth whenever two hosts serving one space offer different releases: a
 * deployment partway through restarting its instances, or two deployments
 * reaching the same memory. The release time is what decides which of the two
 * is the later one. A deployment states it once per deploy, the patterns route
 * sends it beside each identity it advertises, and the piece records it with
 * the revision that adopts the source, moving it forward when a later release
 * offers that same source, so the reconciler can refuse to move a piece from a
 * later release to an earlier one.
 *
 * It is the time of the deploy, not of the commit or the build: deploying an
 * earlier commit again, to roll a bad release back, is the latest release the
 * deployment has made, and pieces follow it there.
 *
 * Written as an RFC 3339 date-time with an explicit offset, such as
 * `2026-10-16T14:03:00Z`, wherever it is text, and held as milliseconds since
 * the epoch everywhere else.
 */

/**
 * The response header in which the patterns route sends its release time
 * beside an advertised identity. Absent when the deployment states none.
 */
export const RELEASED_AT_HEADER = "CF-Released-At";

/**
 * An RFC 3339 date-time: a full date, `T`, a time to the second or finer, and
 * an offset, `Z` or numeric. Lowercase `t` and `z`, which RFC 3339 also
 * admits, are refused, so the text form has one spelling per instant and
 * offset.
 */
const RFC_3339_DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/;

/**
 * Reads a release time written as an RFC 3339 date-time, returning it as
 * milliseconds since the epoch, or `undefined` when `text` is not one. A date
 * alone, a time without an offset, and the other spellings `Date.parse()`
 * accepts are all refused: each leaves the instant to the reader's time zone
 * or to the parser's leniency, and two hosts reading one release differently
 * is the disagreement this value exists to settle. So is a field outside its
 * calendar range, such as February 30, which `Date.parse()` would carry into
 * the next month. A leap second is refused too, having no millisecond of its
 * own to name, and so is an instant before the epoch, which no deploy is. A
 * fraction finer than a millisecond is cut to one.
 */
export function parseReleaseTime(text: string): number | undefined {
  const match = RFC_3339_DATE_TIME.exec(text);
  if (match === null) return undefined;
  const [year, month, day, hour, minute, second, offsetHour, offsetMinute] = [
    ...match.slice(1, 7),
    ...match.slice(9, 11),
  ].map((field) => field === undefined ? 0 : Number(field));
  if (
    month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month) ||
    hour > 23 || minute > 59 || second > 59 || offsetHour > 23 ||
    offsetMinute > 59
  ) return undefined;
  const fraction = match[7];
  const sign = match[8] === "-" ? -1 : 1;
  // `Date.UTC()` reads a two-digit year as one in the 1900s, so the year is
  // set on its own.
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(
    hour,
    minute,
    second,
    fraction === undefined ? 0 : Math.floor(Number(`0${fraction}`) * 1000),
  );
  const time = date.getTime() -
    sign * (offsetHour * 60 + offsetMinute) * 60_000;
  return time < 0 ? undefined : time;
}

/** The number of days in `month` (1 to 12) of `year`, by the Gregorian rule. */
function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/** Writes a release time as an RFC 3339 date-time in UTC. */
export function formatReleaseTime(time: number): string {
  return new Date(time).toISOString();
}
