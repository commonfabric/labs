/**
 * A one-line summary of a thrown value, for the first line of a failure
 * message.
 *
 * An `Error` is summarized by its message, or by its name where it carries no
 * message. A page exception does not arrive as an `Error`: the browser
 * protocol reports it as a detail record, whose `exception.description` holds
 * the error's name, its message, and its stack, as the page renders them. Its
 * first line is the name and the message, which is the summary wanted here.
 *
 * Anything else is rendered inline, its top level only, because stringifying it
 * would read as "[object Object]". The summary stands on its own: a caller
 * that attaches the value as its error's cause adds the full detail, and a
 * caller reporting a failure it does not own has nowhere to defer to.
 */

import { isObjectOrArray } from "@commonfabric/utils/types";

export function describeThrown(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (isObjectOrArray(error)) {
    const description = (error as { exception?: { description?: unknown } })
      .exception?.description;
    if (typeof description === "string" && description.length > 0) {
      return description.split("\n")[0];
    }
  }
  return Deno.inspect(error, {
    colors: false,
    compact: true,
    depth: 0,
    breakLength: Infinity,
  });
}
