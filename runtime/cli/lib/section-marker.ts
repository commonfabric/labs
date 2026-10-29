/**
 * The `--` marker, on a command that has no section for it to close.
 *
 * `--` closes a callable's section, so it is written on the commands that have
 * one — `call` and `exec` — and nowhere else. A command whose read options
 * follow the target directly has no such boundary, and Cliffy hands every word
 * after the marker to the literal arguments instead. An action that reads none
 * of them discards the words in silence: a projection written that way returns
 * an unprojected value and exits zero.
 *
 * That is the failure this refuses. It is the same shape as a field named for
 * a read option being read as one — a line that means something else, succeeds,
 * and says nothing — which is why the marker is refused rather than accepted as
 * a second spelling.
 *
 * The decision, and the alternative of accepting it, are recorded under
 * "Alternatives, and why they are not the design" in
 * [CLI surface shape](../../../docs/history/plans/cli-surface-shape.md).
 */

import { ValidationError } from "@cliffy/command";

/**
 * Refuse a `--` written on a command that has no callable section.
 *
 * `rawArgs` is the command's own argument list, marker included. The marker is
 * read from there rather than from what followed it: a trailing `cf cell get addr
 * --` sets no words aside, so the literal arguments are empty and identical to
 * a line that wrote no marker at all. Judging by what followed would accept the
 * one spelling that most looks like the caller expected the marker to mean
 * something.
 *
 * The message names the words that would have been set aside and the line that
 * works, because every caller who meets it wrote a spelling they expected to
 * mean something.
 */
export function refuseSectionMarker(
  spelling: string,
  rawArgs: readonly string[],
): void {
  const marker = rawArgs.indexOf("--");
  if (marker === -1) return;

  const before = rawArgs.slice(0, marker);
  const after = rawArgs.slice(marker + 1);
  const written = [...before, "--", ...after].join(" ");
  const corrected = [...before, ...after].join(" ");
  const consequence = after.length > 0
    ? "The words after it are set aside rather than read, so this line would " +
      "return a value you did not ask for."
    : "Nothing follows it here, so it closes nothing.";

  throw new ValidationError(
    `\`--\` closes a callable's section, and \`cf ${spelling}\` has none. ` +
      `${consequence}\n\n` +
      `  written:  cf ${spelling} ${written}\n` +
      `  write:    cf ${spelling} ${corrected}\n\n` +
      `\`--\` is written on \`cf piece call\` and \`cf exec\`, where a callable's ` +
      `own flags come first and the marker ends them.`,
  );
}
