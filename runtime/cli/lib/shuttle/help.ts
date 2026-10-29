/**
 * How the verbs are written down: the one line `help` lists a verb on, and the
 * page `<verb> --help` writes.
 *
 * A shell whose only account of itself is the refusal a mistyped word gets
 * serves the person who already knows it and nobody else, which is why the
 * text a verb carries is part of the verb rather than something a document
 * elsewhere has to be kept in step with. What each verb says is `verbs.ts`'s;
 * how it is laid out is here, so the list and the page agree about a verb's
 * one-line summary by reading the same string.
 *
 * The options a page lists are the table the line is parsed by, for the same
 * reason: a page that named its own set would be a second record of what a
 * verb accepts, and the two would part company at the first option added.
 */

import { maxOf } from "@commonfabric/utils/math";

import type { VerbOption } from "./options.ts";

/**
 * The column a summary starts at, past the longest usage in `verbs`, so that
 * every summary in a list begins in the same place and a reader runs their eye
 * down them.
 */
const SUMMARY_GAP = 2;

/**
 * The option every verb takes, as the options block writes it. It is every
 * verb's because `readOptions` (`options.ts`) puts it in front of whatever a
 * verb declared, rather than each verb offering one, and it is written here
 * rather than declared beside the verbs' own for the same reason.
 */
const HELP_LINE: readonly [string, string] = [
  "-h, --help",
  "Write this page instead of running the verb.",
];

/** What `help` says about one verb. */
export interface VerbHelp {
  /** The verb and its operands as one line, which opens the verb's page. */
  readonly usage: string;

  /** What the verb does, in the one line `help` lists it by. */
  readonly summary: string;

  /** What the verb's page says past the summary. */
  readonly detail: string;

  /**
   * The options the verb declares, which its page lists under the one every
   * verb takes.
   *
   * It is the table `readOptions` parses by, so a verb's page lists exactly
   * the options its line accepts: an option added is an option described, and
   * one described is one the parse takes.
   */
  readonly options?: readonly VerbOption[];
}

/**
 * Returns `verbs` written as `help` lists them: one to a line, its usage
 * first and its summary in a column past the longest of them, with no
 * trailing break.
 *
 * The closing line names the option that says more, which is the whole of
 * what the list can carry about a verb it gives one line to.
 */
export function renderVerbList(verbs: readonly VerbHelp[]): string {
  const column = maxOf(verbs.map((verb) => verb.usage.length)) +
    SUMMARY_GAP;
  const lines = verbs.map((verb) =>
    `${verb.usage.padEnd(column)}${verb.summary}`
  );
  return `${lines.join("\n")}\n\n\`<verb> --help\` says more about one verb.`;
}

/**
 * Returns the page `verb` writes for `<verb> --help`: what the verb and its
 * operands are written as, what it does, what it does with them, and the
 * options it takes, with no trailing break.
 *
 * The options block opens with the one every verb takes and goes on with the
 * verb's own, read off the table `readOptions` parses by. So the page and the
 * parse cannot disagree about what a verb accepts, which is the drift a page
 * written out beside a table has.
 */
export function renderVerbPage(verb: VerbHelp): string {
  return `Usage: ${verb.usage}\n\n${verb.summary}\n\n${verb.detail}\n\n` +
    optionsBlock(verb.options ?? []);
}

/**
 * Helper for {@link renderVerbPage}, which is the options block for `options`,
 * the option every verb takes first and each spelling in a column of its own.
 *
 * The column is measured over the block rather than fixed, so a verb whose
 * options are all short reads as tightly as one whose are long, and no
 * spelling ever runs into its description.
 */
function optionsBlock(options: readonly VerbOption[]): string {
  const rows: readonly (readonly [string, string])[] = [
    HELP_LINE,
    ...options.map((
      option,
    ) => [spellingOf(option), option.description] as const),
  ];
  const column = maxOf(rows.map(([spelling]) => spelling.length)) +
    SUMMARY_GAP;
  return `Options:\n${
    rows.map(([spelling, description]) =>
      `  ${spelling.padEnd(column)}${description}`
    ).join("\n")
  }`;
}

/**
 * Helper for {@link optionsBlock}, which is how `option` is written on a line
 * a person reads: its aliases first, then its name, then what its value is
 * called where it takes one.
 *
 * A name is written with the number of dashes the parser reads it by, which is
 * one for a single character and two for anything longer (`parseFlags`,
 * `@cliffy/flags`). That rule rather than "an alias is short" is what keeps
 * the page and the parse agreeing: an alias is `string` on the declaration a
 * verb writes, so a long one can be declared, and a page that spelled it `-xy`
 * would offer a line the parse turns down. The pair is held to each other by a
 * case that feeds the page's own spelling back through `readOptions`, over an
 * alias of each length.
 *
 * An option takes a value exactly where it declares a type, so the value is
 * written on that condition rather than on the placeholder's presence — which
 * leaves a table naming a type and no placeholder writing the type's own name,
 * rather than silently writing no value at all.
 */
function spellingOf(option: VerbOption): string {
  const names = [...(option.aliases ?? []), option.name]
    .map(dashed)
    .join(", ");
  return option.type === undefined
    ? names
    : `${names} <${option.placeholder ?? option.type}>`;
}

/**
 * Helper for {@link spellingOf}, which is `name` with the dashes the parser
 * reads it by: one for a single character, two for anything longer.
 */
function dashed(name: string): string {
  return [...name].length === 1 ? `-${name}` : `--${name}`;
}
