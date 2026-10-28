import { isObjectNotArray } from "@commonfabric/utils/types";
import type {
  PatternIndexListedPattern,
  PatternIndexPattern,
  PatternIndexSearchResponse,
  PatternIndexSearchResult,
} from "./client.ts";

/**
 * Replaces ranked hits with their discoverable successors, once at the earliest
 * matching position. Only an unambiguous chain declared by the same owner
 * redirects discovery. Exact-ID reads remain the caller's responsibility.
 *
 * @throws Error when a matching chain branches or cycles, or its terminal
 * generation has no quality classification. Such a search cannot safely
 * recommend a generation.
 */
export const resolvePatternIndexSuccessors = (
  response: PatternIndexSearchResponse,
  listed: readonly PatternIndexListedPattern[],
  patterns: readonly PatternIndexPattern[],
): PatternIndexSearchResponse => {
  const rows = new Map(listed.map((row) => [row.patternId, row]));
  const records = new Map(
    patterns.map((pattern) => [pattern.patternId, pattern]),
  );
  const successors = new Map<string, string[]>();
  for (const pattern of patterns) {
    const prior = pattern.priorPatternId;
    if (
      prior === undefined || !rows.has(pattern.patternId) ||
      records.get(prior)?.ownerDid !== pattern.ownerDid
    ) continue;
    const next = successors.get(prior) ?? [];
    next.push(pattern.patternId);
    successors.set(prior, next);
  }

  const seen = new Set<string>();
  const results: PatternIndexSearchResult[] = [];
  for (const hit of response.results) {
    let id = hit.patternId;
    const chain = new Set<string>();
    while (successors.has(id)) {
      const next = successors.get(id)!;
      if (chain.has(id) || next.length !== 1) {
        throw new Error("pattern index successor chain is ambiguous or cyclic");
      }
      chain.add(id);
      id = next[0];
    }
    if (seen.has(id)) continue;
    seen.add(id);
    if (
      rows.get(id)?.quality === "penalized" ||
      (id === hit.patternId && hit.quality === "penalized")
    ) continue;
    if (id === hit.patternId) {
      results.push(hit);
      continue;
    }
    const row = rows.get(id)!;
    const pattern = records.get(id)!;
    if (row.quality !== "proven" && row.quality !== "unproven") {
      throw new Error("pattern index successor has no quality classification");
    }
    results.push({
      patternId: id,
      description: pattern.description,
      hashtags: pattern.hashtags,
      ownerDid: pattern.ownerDid,
      createdAt: pattern.createdAt,
      dependencies: pattern.dependencies,
      signals: row.signals ?? {
        uses: Object.values(row.events).reduce((sum, count) => sum + count, 0),
        score: row.score,
      },
      quality: row.quality,
      kind: isObjectNotArray(pattern.argumentSchema) ? "part" : "app",
    });
  }
  return { ...response, results };
};
