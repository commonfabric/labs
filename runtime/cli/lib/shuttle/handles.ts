/**
 * What a `%n` operand names: the row a listing numbered, and the place that
 * listing was read at.
 *
 * A listing mints the numbering (`listing.ts`) and a session holds it
 * (`session.ts`); this is the other half, which reads one back. The pair a
 * lookup answers with is what makes a handle a bound reference rather than a
 * row number (decision 27): the row's own operand reaches it from the place
 * the listing was read at, so the pair names a cell from anywhere and goes on
 * naming it after the place has moved.
 *
 * Nothing here reads the fabric and nothing walks. What a row's operand
 * reaches is `place.ts`'s to say, and it says it through the arm a `%n`
 * operand comes back as; what a callable row's name resolves to is the
 * fabric's. This decides only which row was named, and why a token named
 * none.
 */

import type { ListingHandles, ListingRow } from "./listing.ts";
import { handleFor } from "./listing.ts";
import { HANDLE_SIGIL, type Place } from "./place.ts";

/** What reading a `%n` operand against a listing produced. */
export type HandleReading =
  | {
    /** Names this arm of {@link HandleReading}. */
    readonly kind: "row";

    /** Where the listing was read, which the row stands inside. */
    readonly at: Place;

    /** The row the number named. */
    readonly row: ListingRow;
  }
  /** The token named no row, for the reason given. */
  | { readonly kind: "refused"; readonly reason: string };

/**
 * Helper for {@link numberOf}, which is whether `token` is written as a
 * handle: the sigil at its head, whatever follows.
 *
 * Deliberately the sigil alone rather than the whole spelling, so that a token
 * opening with it and naming no row gets the reason {@link resolveHandle}
 * gives it, which names the spelling; read as anything else it would get a
 * reason about a key or a piece nobody wrote.
 *
 * Which operands are read as a handle at all is not decided here. That is the
 * operand grammar's (`movePlace`, `place.ts`), which reads the sigil at the
 * head of an operand and nowhere else, so a key named with it stays reachable
 * by a walk. This is asked only of a token that grammar already picked out.
 */
function isHandle(token: string): boolean {
  return token.startsWith(HANDLE_SIGIL);
}

/**
 * What `token` names in `handles`, or the reason it names nothing.
 *
 * `token` is the operand as it was written, the sigil included, because the
 * reason a handle names nothing quotes it back and a reason quoting something
 * else is a reason about another line.
 *
 * The row comes back whatever it is. Whether a row is somewhere to stand, and
 * whether it is something to call, are questions its kind and its operand
 * answer, and they are answered by the verb that asked — a row a `cd` has
 * nothing to walk to is one a `call` may still invoke.
 */
export function resolveHandle(
  handles: ListingHandles | undefined,
  token: string,
): HandleReading {
  const number = numberOf(token);
  if (number === undefined) {
    return refuse(
      `\`${token}\` names no handle. A handle is \`${HANDLE_SIGIL}\` and the ` +
        `number a listing printed beside a row, as in \`${handleFor(3)}\`.`,
    );
  }
  if (handles === undefined) {
    return refuse(
      `\`${token}\` names no row: no listing has numbered one yet. \`ls\` ` +
        `lists what stands here and numbers what it lists.`,
    );
  }
  const row = handles.rows[number - 1];
  if (row === undefined) {
    return refuse(
      handles.rows.length === 0
        ? `\`${token}\` names no row: the listing numbered none.`
        : `\`${token}\` names no row: the listing numbered \`${
          handleFor(1)
        }\` to \`${handleFor(handles.rows.length)}\`.`,
    );
  }
  return { kind: "row", at: handles.place, row };
}

/**
 * Helper for {@link resolveHandle}, which is the number `token` names, and
 * nothing where it names none.
 *
 * The digits are the whole of what follows the sigil: `%3x` and `%+3` and
 * `%3.0` each name no row, and the leading-zero spellings are turned down for
 * the same reason — a listing prints `%3` and nothing else, so `%03` is a
 * spelling of a number rather than a handle a listing offered.
 */
function numberOf(token: string): number | undefined {
  if (!isHandle(token)) return undefined;
  const digits = token.slice(HANDLE_SIGIL.length);
  return /^[1-9][0-9]*$/.test(digits) ? Number(digits) : undefined;
}

/** Helper for {@link resolveHandle}, which builds a refusal carrying `reason`. */
function refuse(reason: string): HandleReading {
  return { kind: "refused", reason };
}
