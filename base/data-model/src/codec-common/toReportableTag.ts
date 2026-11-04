import { toCompactDebugString } from "@/value-debug";

/** How much of a rendered tag to keep. */
const MAX_RENDERED_LENGTH = 60;

/**
 * Converts a tag of any type at all into one that can be reported: a string is
 * returned as it stands, and anything else is replaced by a debug rendering of
 * itself.
 *
 * A string is kept whether or not it is a well-formed tag, because what a
 * report is for is saying what arrived. `"hole"` is exactly the thing a reader
 * needs to see, and replacing it with a description of itself would lose the
 * one fact worth carrying.
 *
 * What is not a string cannot be kept: a tag is read out of wire data, where a
 * format's tag position can hold anything its transport carries -- a
 * realm-crossing `Map` is keyed by any value at all. `toCompactDebugString()`
 * returns `"<unrenderable debug string>"` for anything it cannot render, so
 * this cannot fail while reporting a failure.
 *
 * The counterpart to {@link toReportableState}, which does the same for the
 * state under a tag.
 *
 * @param tag - The tag at fault, of any type whatsoever.
 * @returns `tag` itself, or a rendering of it.
 */
export function toReportableTag(tag: any): string {
  return (typeof tag === "string")
    ? tag
    : toCompactDebugString(tag, { maxLength: MAX_RENDERED_LENGTH });
}
