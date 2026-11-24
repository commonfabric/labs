import { isFunction, isObjectOrArray } from "./types.ts";

/**
 * Returns the message of a thrown value, for a report that has to say what
 * failed whatever was thrown.
 *
 * Any object with a `message` property is described by it, whether an `Error`,
 * a plain record such as `{ name, message }`, or a function given one. Other
 * values are converted with `String()`, so a thrown string is its own
 * description.
 *
 * Describing a failure never fails in turn. An object made with
 * `Object.create(null)` has no `toString` to reach, a proxy can throw from any
 * property read, and an `Error` can carry a `message` that is not a string.
 * Such a value is described by a fixed sentence saying that it could not be
 * converted to text, so a caller already reporting one failure does not have
 * it replaced by a second.
 */
export function describeFailure(thrown: unknown): string {
  try {
    const message =
      (isObjectOrArray(thrown) || isFunction(thrown)) && "message" in thrown
        ? thrown.message
        : String(thrown);
    if (typeof message === "string") return message;
  } catch {
    // Reading or converting the value threw.
  }
  return "error could not be converted to text";
}
