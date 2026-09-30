import type {
  PatternIndexPatternKind,
  PatternIndexQuality,
  PatternIndexSignals,
} from "../pattern-index/client.ts";

/**
 * What a run knows about a published pattern it may name by id. Search hits,
 * attached references, and research inspection all extend this one metadata
 * record so trust does not depend on which surface first observed it.
 */
export interface TrustedPatternRecord {
  /** Content-addressed pattern identity returned by the index. */
  patternId: string;

  /** Publisher-authored description returned by the index. */
  description: string;

  /** Publisher-authored search hashtags returned by the index. */
  hashtags: readonly string[];

  /** Usage and outcome evidence reported by a search. */
  signals?: PatternIndexSignals;

  /** Whether a search classified the pattern as a reusable part or app. */
  kind?: PatternIndexPatternKind;

  /** Evidence tier reported by a search. */
  quality?: PatternIndexQuality;

  /** Query terms matched by the search that surfaced the pattern. */
  matchedTerms?: number;

  /** Stopword-free terms in the search that surfaced the pattern. */
  queryTerms?: number;

  /** Import statement that composes this exact identity. */
  importHint: string;

  /** Declared argument shape rendered as TypeScript. */
  argumentType?: string;

  /** Declared result shape rendered as TypeScript. */
  resultType?: string;

  /** Identity that published the record, where the index reported it. */
  ownerDid?: string;

  /** Time the index recorded the pattern, where the index reported it. */
  createdAt?: string;
}
