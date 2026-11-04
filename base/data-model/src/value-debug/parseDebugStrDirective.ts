/**
 * Finds the `debugStr` directive which ends the given template string, which
 * is to be the raw form of the string, as `TemplateStringsArray.raw` holds it.
 * A directive is a dollar sign and then one or more lower-case words separated
 * by commas, such as `$quote,long`, at the very end of the string, which is to
 * say right before the substitution which follows the string. Returns the
 * length of the directive, dollar sign included, and its words as written,
 * whether or not each is one a directive can hold; or `undefined` when the
 * string ends in no directive.
 *
 * A directive-like ending whose dollar sign follows an odd number of
 * backslashes is no directive: the last of those backslashes escapes the
 * dollar sign, which is how a template says the ending is literal text.
 */
export function parseDebugStrDirective(
  raw: string,
): { readonly length: number; readonly words: readonly string[] } | undefined {
  const match = /(?<backslashes>\\*)\$(?<words>[a-z]+(?:,[a-z]+)*)$/.exec(raw);
  const { backslashes, words } = match?.groups ?? {};

  if (
    (backslashes === undefined) || (words === undefined) ||
    ((backslashes.length % 2) === 1)
  ) {
    return undefined;
  }

  return { length: words.length + 1, words: words.split(",") };
}
