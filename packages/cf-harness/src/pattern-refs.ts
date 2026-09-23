/**
 * Task pattern references: published patterns the caller attaches to a task
 * by id, the way `--input-cell` attaches a cell by reference. A pattern id is
 * the content-addressed identity of published source, so the id itself
 * discloses nothing and asserts nothing — it either names an entry the index
 * holds or it names nothing at all.
 *
 * The run resolves each id against the index before its first model turn and
 * seeds what comes back as a searched hit, so `run_pattern`'s `patternId` and
 * `delegate_task`'s `patternRefs` name the pattern with no search. What the
 * reference grants is what a search hit grants: compose this source by
 * identifier. It is provenance, not endorsement — the record carries the
 * index's own account of the pattern, and attaching one adds nothing to it.
 *
 * Like an input cell, a reference is explicit caller configuration, so
 * failure is closed and loud: an id the index does not know fails the run
 * rather than leaving it to proceed without what the caller attached.
 */

import type { PatternIndexClient } from "./pattern-index/client.ts";
import { PatternIndexError } from "./pattern-index/client.ts";
import {
  patternIndexDeclaredType,
  patternIndexImportHint,
} from "./tools/search-patterns.ts";
import type {
  HarnessPatternRef,
  HarnessPatternRefSpec,
} from "./contracts/pattern-refs.ts";

export type {
  HarnessPatternRef,
  HarnessPatternRefSpec,
} from "./contracts/pattern-refs.ts";

/**
 * The id grammar, which is the grammar a `cf:pattern:` specifier carries: an
 * index id is a content hash written in these characters and no others.
 */
const PATTERN_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Whether an id uses the spelling accepted by the pattern index. */
export const isPatternRefId = (id: string): boolean =>
  PATTERN_ID_PATTERN.test(id);

/**
 * References one task may attach. Each costs an index read before the run's
 * first model turn, and the same bound `delegate_task` holds a selection to
 * is what a task carries.
 */
export const MAX_HARNESS_PATTERN_REFS = 8;

/**
 * Holds one pattern reference to the index's id grammar. A value that is not
 * an id names nothing the index could hold, so it is refused wherever it
 * first arrives rather than spent on a read.
 *
 * @throws Error naming the value and the grammar it missed.
 */
export const checkPatternRefSpec = (spec: HarnessPatternRefSpec): void => {
  if (!isPatternRefId(spec.patternId)) {
    throw new Error(
      `patternRefs patternId must match ${PATTERN_ID_PATTERN}, got \`${spec.patternId}\``,
    );
  }
};

/**
 * Resolves each reference through the index, answering the records a run
 * seeds as searched hits. Source is never requested: what a composing model
 * needs is what a pattern is for and what it takes and returns.
 *
 * @throws Error naming the failing id on a duplicate, on an id the index does
 * not hold, and on a read the index refused, and stating the bound when more
 * references arrive than {@link MAX_HARNESS_PATTERN_REFS} — the caller fails
 * the run with it, before any model turn.
 */
export const resolvePatternRefs = async (
  client: PatternIndexClient,
  specs: readonly HarnessPatternRefSpec[],
): Promise<HarnessPatternRef[]> => {
  if (specs.length > MAX_HARNESS_PATTERN_REFS) {
    throw new Error(
      `patternRefs takes at most ${MAX_HARNESS_PATTERN_REFS} references, got ${specs.length}`,
    );
  }
  const refs: HarnessPatternRef[] = [];
  const seen = new Set<string>();
  for (const spec of specs) {
    // Checked here, not only at the surface the caller wrote to: a library
    // caller reaches this resolution without passing that surface's grammar.
    checkPatternRefSpec(spec);
    if (seen.has(spec.patternId)) {
      throw new Error(`patternRefs names \`${spec.patternId}\` twice`);
    }
    seen.add(spec.patternId);
    let pattern;
    try {
      pattern = await client.getPattern({ patternId: spec.patternId });
    } catch (error) {
      // The id is what the caller can act on, so it leads the message; the
      // index's own words follow it, and the pattern's source is in neither.
      throw new Error(
        error instanceof PatternIndexError && error.status === 404
          ? `patternRefs \`${spec.patternId}\` is not in the pattern index`
          : `patternRefs \`${spec.patternId}\` could not be read from the pattern index: ${
            error instanceof Error ? error.message : String(error)
          }`,
      );
    }
    const argumentType = patternIndexDeclaredType(pattern.argumentSchema);
    const resultType = patternIndexDeclaredType(pattern.resultSchema);
    refs.push({
      patternId: pattern.patternId,
      record: {
        patternId: pattern.patternId,
        description: pattern.description,
        hashtags: pattern.hashtags,
        importHint: patternIndexImportHint(pattern.patternId),
        ownerDid: pattern.ownerDid,
        createdAt: pattern.createdAt,
        ...(argumentType !== undefined ? { argumentType } : {}),
        ...(resultType !== undefined ? { resultType } : {}),
      },
    });
  }
  return refs;
};

/**
 * The context message announcing attached patterns to the model, in the terms
 * a search hit is reported in: what each one is for, the specifier that
 * composes it, and the shapes to wire against. The message says how to name
 * them and stops there — an attachment is the caller pointing at published
 * source, not a claim that the source is any good. An empty list yields no
 * message at all rather than an empty header.
 */
export const patternRefsContextMessage = (
  patternRefs: readonly HarnessPatternRef[],
): string | undefined => {
  if (patternRefs.length === 0) {
    return undefined;
  }
  return [
    "Published patterns attached to this task by the caller:",
    ...patternRefs.flatMap(({ record }, index) => [
      "",
      `Pattern ${index + 1}: ${record.patternId}`,
      `Description: ${record.description}`,
      ...(record.hashtags.length > 0
        ? [`Hashtags: ${record.hashtags.join(", ")}`]
        : []),
      `Import: ${record.importHint}`,
      "Argument shape:",
      record.argumentType ?? "Not available.",
      "Result shape:",
      record.resultType ?? "Not available.",
    ]),
    "",
    "These are available to name as search_patterns hits are: run one with run_pattern's patternId, compose one through its import specifier, or select one for a child with delegate_task's patternRefs. You do not need to search for them. Attaching a pattern says which published source it is and nothing about whether it works.",
  ].join("\n");
};
