/**
 * Source evidence for a shared extension that is read past the blank lines and
 * comments a file opens with. Those lines are read one at a time: a regular
 * expression that repeats once for each of them exhausts the stack of V8's
 * regular expression engine on a few million lines.
 */

/**
 * Evidence that `pattern` matches starting at the source's first line that is
 * neither blank nor a comment. A comment line is one whose first character
 * other than white space is one of `commentStarts`. The pattern is matched at
 * that line's start, so `^` in it matches only when that line is the first.
 */
export function firstContentLineMatches(
  commentStarts: string,
  pattern: RegExp,
): (text: string) => boolean {
  const comment = commentStarts.replace(/[\]\\^-]/g, "\\$&");
  const skipped = new RegExp(
    String.raw`[^\S\n]*(?:[${comment}][^\n]*)?\n`,
    "y",
  );
  const atLine = new RegExp(
    pattern.source,
    pattern.flags.replace("y", "") + "y",
  );
  return (text) => {
    let at = 0;
    for (skipped.lastIndex = 0; skipped.test(text);) at = skipped.lastIndex;
    atLine.lastIndex = at;
    return atLine.test(text);
  };
}
