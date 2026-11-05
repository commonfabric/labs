/** Projects retained research evidence into an outer model's context. */

import type {
  HarnessResearchPatternRecord,
  HarnessResearchResult,
} from "../contracts/research.ts";
import { scrubBareFabricIdentifiersWithPointers } from "../fabric-identifier-scrub.ts";

/** One model-facing kit and the artifact positions reduced to produce it. */
export interface HarnessResearchKitProjection {
  /** Kit whose free text passed through the existing identifier scrub. */
  kit: HarnessResearchResult;

  /** Text changed by the projection, relative to its artifact position. */
  scrubbedPointers: readonly string[];

  /** Raw schemas retained only in the durable evidence. */
  artifactOnlyPointers: readonly string[];
}

/** Host-provided identity, type, and ranking records for indexed components. */
const PATTERN_HOST_FIELDS = [
  "patternId",
  "importHint",
  "ownerDid",
  "createdAt",
  "main",
  "mainExport",
  "files",
  "sourceRoots",
  "dataFiles",
  "dependencies",
  "argumentType",
  "resultType",
  "signals",
] as const satisfies readonly (keyof HarnessResearchPatternRecord)[];

/** Host records and their positions within a raw research artifact. */
const patternPositions = (kit: HarnessResearchResult) => [
  ...kit.patterns.map((pattern, index) => ({
    pattern,
    pointer: `/patterns/${index}`,
  })),
  ...(kit.purpose === "orient"
    ? kit.leads.map((lead, index) => ({
      pattern: lead.pattern,
      pointer: `/leads/${index}/pattern`,
    }))
    : []),
];

/**
 * Scrubs free text by default, preserves exact host identities and source/CFC
 * records, and drops unused raw index schemas. The private loop and durable
 * summaries retain the full kit; this projection owns only outer model context.
 */
export const projectHarnessResearchKitForModel = (
  kit: HarnessResearchResult,
  basePointer = "/kit",
): HarnessResearchKitProjection => {
  const candidate = structuredClone(kit);
  const artifactOnlyPointers: string[] = [];
  const identities = patternPositions(candidate).map(({ pattern, pointer }) => {
    const identity: Partial<HarnessResearchPatternRecord> = {};
    for (const field of PATTERN_HOST_FIELDS) {
      if (Object.hasOwn(pattern, field)) {
        Object.assign(identity, { [field]: pattern[field] });
        delete pattern[field];
      }
    }
    for (const field of ["argumentSchema", "resultSchema"] as const) {
      if (pattern[field] !== undefined) {
        artifactOnlyPointers.push(`${basePointer}${pointer}/${field}`);
      }
      delete pattern[field];
    }
    return identity;
  });
  const sources = candidate.sources;
  candidate.sources = [];
  const projected = scrubBareFabricIdentifiersWithPointers(
    candidate,
    basePointer,
  );
  const result = projected.value as HarnessResearchResult;
  result.sources = sources;
  patternPositions(result).forEach(({ pattern }, index) =>
    Object.assign(pattern, identities[index])
  );
  return {
    kit: result,
    scrubbedPointers: projected.scrubbedPointers,
    artifactOnlyPointers,
  };
};
