/**
 * The markdown reference-definition block a projected note carries.
 *
 * A note's mentions live in a map beside its text, so a file written out of
 * that note says nothing about where they point. Emitting the map as the
 * definition block it already resembles makes the file whole, and reading the
 * block back makes editing it a way of editing the mentions.
 *
 * The demanding property is exactness: a file written back untouched has to
 * parse to what was emitted, or every `touch` registers as an edit. That is
 * why the block is recognized structurally — a trailing run of definition
 * lines after a blank line — rather than diffed against what was generated.
 */

/** `[key]: address`, the standard markdown reference definition. */
const DEFINITION = /^\[([0-9a-z]{6,10})\]:\s+(\S+)\s*$/;

export interface ReferenceDefinition {
  key: string;
  address: string;
}

export interface SplitBody {
  /** The prose, with no trailing definition block and no trailing blank run. */
  content: string;

  /** The definitions that were attached to it, in the order they appeared. */
  definitions: ReferenceDefinition[];

  /**
   * Lines in the trailing block that are not definitions. A block holding one
   * is not a generated block, so the whole run stays prose — dropping a line
   * the user wrote would be worse than declining to read the block.
   */
  malformed: string[];
}

/**
 * Attach definitions beneath the content, or return it unchanged when there
 * are none. Emitting nothing for an empty map is what lets a note with no
 * mentions round-trip without acquiring a blank line every time.
 */
export function attachDefinitions(
  content: string,
  definitions: readonly ReferenceDefinition[],
): string {
  if (definitions.length === 0) return content;

  const block = definitions
    .map(({ key, address }) => `[${key}]: ${address}`)
    .join("\n");
  return content.length === 0 ? block : `${content}\n\n${block}`;
}

/**
 * Split a body into its prose and the definitions beneath it.
 *
 * The block is the last run of non-blank lines, taken only when every line in
 * it parses as a definition. Anything else is prose that happens to end in
 * something bracket-shaped, and is left alone.
 */
export function splitDefinitions(body: string): SplitBody {
  const lines = body.split("\n");

  // Walk back over the trailing blank lines, then over the run above them.
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim().length === 0) end--;
  let start = end;
  while (start > 0 && lines[start - 1].trim().length > 0) start--;

  const run = lines.slice(start, end);
  if (run.length === 0) {
    return { content: body, definitions: [], malformed: [] };
  }

  const definitions: ReferenceDefinition[] = [];
  const malformed: string[] = [];
  for (const line of run) {
    const match = DEFINITION.exec(line);
    if (match) definitions.push({ key: match[1], address: match[2] });
    else malformed.push(line);
  }

  // A run holding anything that is not a definition is prose.
  if (definitions.length === 0 || malformed.length > 0) {
    return { content: body, definitions: [], malformed };
  }

  // Drop the blank line that separated the block from the prose, so that
  // attaching what was split off reproduces the input exactly.
  let contentEnd = start;
  if (contentEnd > 0 && lines[contentEnd - 1].trim().length === 0) contentEnd--;

  return {
    content: lines.slice(0, contentEnd).join("\n"),
    definitions,
    malformed: [],
  };
}
