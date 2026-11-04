/** The vocabulary of the `debugStr` template tag. */

/**
 * The words a `debugStr` directive can hold. `short`, `long`, and `xlong` say
 * how much of a rendering to keep, and no more than one of them belongs in a
 * directive; `indent` asks for the indented rendering rather than the compact
 * one; and `quote` asks for the rendering quoted as Markdown code.
 */
export const DEBUG_STR_WORDS = [
  "indent",
  "long",
  "quote",
  "short",
  "xlong",
] as const;

/** One of the words a `debugStr` directive can hold. */
export type DebugStrWord = (typeof DEBUG_STR_WORDS)[number];

/** The words of a `debugStr` directive which say how much to keep. */
export const DEBUG_STR_SIZE_WORDS = ["short", "long", "xlong"] as const;
