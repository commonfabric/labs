/**
 * The typed client for the deployed pattern index: a small JSON-over-HTTP
 * surface for searching published patterns, reading one back, recording what
 * a run did with it, publishing a new one, and retracting an owned generation.
 * Pattern calls are POSTs to `{baseUrl}/{function}` signed with the CF1
 * first-party scheme. Public health and enrollment observations use GET;
 * enrollment names the same principal.
 *
 * Callers supply the signer and may substitute the HTTP transport.
 */

import type { JSONSchema, JSONValue } from "@commonfabric/api";
import {
  type FirstPartyHttpSigner,
  signFirstPartyHttpRequest,
} from "@commonfabric/runner/toolshed-http-auth";
import {
  isObjectNotArray,
  isObjectOrArray,
} from "@commonfabric/js-values/types";
import { MAX_PROOF_CHAIN_LENGTH } from "@commonfabric/memory/v2/session-open-auth";
import type { PatternIndexFetch } from "./http-fetch.ts";
import { encodeHex } from "@std/encoding/hex";
import { sha256 } from "@commonfabric/content-hash";

/** Own and publication-bounded inherited evidence computed by the index. */
export interface PatternIndexSignals {
  uses: number;
  score: number;

  /** The inherited portion, distinct from events on this exact generation. */
  inherited?: {
    priorPatternId: string;
    asOf: string;
    events: Readonly<Record<string, number>>;
    score: number;
  };
}

/** Whether a published argument schema classifies a hit as reusable or whole. */
export type PatternIndexPatternKind = "part" | "app";

/** Evidence tier the deployed index computed from recorded run outcomes. */
export type PatternIndexQuality = "penalized" | "unproven" | "proven";

/**
 * Where a listed pattern ranks. `featured` is set by an admin; `main` holds
 * patterns their author has used in a loom, ranked by other people's use;
 * `unvetted` holds listed patterns nobody has shown working yet, returned only
 * as a fallback or on request.
 *
 * Like every state enum the index answers, this may gain values; a consumer
 * treats one it does not know as absent.
 */
export type PatternIndexBucket = "featured" | "main" | "unvetted";

/**
 * Where a pattern's listing request stands. A new publication starts at
 * `not_requested`; its owner's request makes it `pending` while the gate
 * gardeners run; it is `passed` once every gate passed and `held` when one
 * did not. `error` means a gardener run failed and waits for an admin re-run.
 * Whether others can find it is `listed`, which also covers grandfathered and
 * hidden patterns.
 */
export type PatternIndexListing =
  | "not_requested"
  | "pending"
  | "passed"
  | "held"
  | "error";

/** One gardener run's state on one pattern. */
export type PatternIndexGardenerStatus =
  | "pending"
  | "running"
  | "passed"
  | "failed"
  | "error";

/**
 * Something a gardener found. It names the problem without repeating the
 * value that caused it.
 */
export interface PatternIndexFinding {
  file?: string;
  line?: number;
  category: string;
  why: string;
}

/**
 * One gardener's latest verdict on a pattern. A gate gardener's verdict
 * decides listing; an annotation gardener's never does. `output` is shaped by
 * that gardener's declared output schema (see `getGardenerPrompt`).
 *
 * Verdicts go only to the pattern's owner and to admins: a finding says where
 * a personal detail is, and the pattern's source stays readable by id.
 */
export interface PatternIndexGardenerVerdict {
  status: PatternIndexGardenerStatus;

  /** Increments on each admin re-run; a late run from an older attempt is ignored. */
  attempt: number;

  promptVersion?: string;
  findings?: readonly PatternIndexFinding[];
  output?: JSONValue;
}

/** How an event type accumulates into a pattern lineage's evidence. */
export type PatternIndexAggregation =
  | "raw"
  | "count"
  | "distinct_actors"
  | "distinct_actor_days"
  | "last_seen";

/** Whose events of a type count toward a lineage. */
export type PatternIndexEventAudience = "author" | "others" | "any";

/** An event type as the index declares it. */
export interface PatternIndexEventTypeDeclaration {
  weight: number;
  aggregate: PatternIndexAggregation;
  audience: PatternIndexEventAudience;

  /** An effect beyond ranking: the author's first use promotes to `main`. */
  promotes?: "author_first_success";
}

/**
 * One event type's accumulated evidence for a lineage. `value` is what the
 * declared aggregation counts: events (`count`), distinct people
 * (`distinct_actors`), or person-days (`distinct_actor_days`, which also
 * reports how many people came back on a later day). `raw` types keep their
 * events as a stream and produce no aggregate. A day is `YYYY-MM-DD`.
 */
export interface PatternIndexAggregate {
  aggregate: PatternIndexAggregation;
  value: number;
  returningActors?: number;
  lastSeenDay?: string;
}

/**
 * One original along a remix's chain, as the index shows it to the reader:
 * the pattern and its name, or `unavailable` for an original the reader may
 * not read, which ends the chain.
 */
export type PatternIndexRemixLink =
  | { patternId: string; name?: string }
  | { unavailable: true };

/** One hit from `searchPatterns`. Carries metadata and never source. */
export interface PatternIndexSearchResult {
  patternId: string;

  /** Short display name, when the index has or could derive one. */
  name?: string;

  description: string;
  hashtags: readonly string[];

  /**
   * The publisher's DID, from deployments that predate pseudonymous authors.
   * Newer deployments answer `handle` instead.
   */
  ownerDid?: string;

  createdAt: string;
  dependencies: readonly string[];
  signals?: PatternIndexSignals;

  /** Whether the published argument schema classifies this as a part or app. */
  kind: PatternIndexPatternKind;

  /**
   * Whether its author offers it to a person choosing what to place, on its
   * own at the top of a loom. Unlike `kind`, which reads only the argument
   * schema, this is the author's answer, set when published. Absent from
   * deployments that predate the field.
   */
  standalone?: boolean;

  /**
   * The required input with no default that keeps it from standing alone,
   * when that is why `standalone` is false.
   */
  standaloneFloor?: string;

  /** Evidence tier computed by the index from recorded run outcomes. */
  quality: PatternIndexQuality;

  /**
   * With a text query: how many stopword-free terms this hit carries, out of
   * `queryTerms`. Text matching is disjunctive and ranked, so a hit is not a
   * claim that everything matched — the ratio is what says how close.
   */
  matchedTerms?: number;

  queryTerms?: number;

  /**
   * The generation the query matched, when the index answered with its
   * current successor in that generation's place.
   */
  supersedes?: string;

  /** Which ranked bucket this hit came from, absent on older deployments. */
  bucket?: PatternIndexBucket;

  /**
   * @deprecated Read `author.pseudonym`. Deployments with private versions
   * answer the same per-lineage pseudonym here, for older readers; older
   * deployments answer one pseudonym per author, shared across their
   * patterns.
   */
  handle?: string;

  /** How the author is shown: a per-lineage pseudonym, a tier, a name if published. */
  author?: PatternIndexAuthor;

  /** Whether the caller is its author. */
  mine?: boolean;

  /** A remix's nearest original, when the reader may follow it. */
  remixedFrom?: string;

  /** A remix's originals, nearest first, cut to what the reader may see. */
  remixChain?: readonly PatternIndexRemixLink[];

  /** The first generation of this pattern's version chain. */
  lineageId?: string;

  /** Evidence per event type, accumulated over the lineage. */
  aggregates?: Readonly<Record<string, PatternIndexAggregate>>;
}

export interface PatternIndexSearchRequest {
  tags?: readonly string[];
  text?: string;
  limit?: number;

  /**
   * Also return `unvetted` hits after `featured` and `main`. Without it the
   * index returns unvetted hits only when nothing vetted matched.
   */
  includeUnvetted?: boolean;
}

/**
 * What `searchPatterns` answers. The index resolves successors itself: each
 * result is a current discoverable generation, once, at the earliest position
 * any generation of its chain matched.
 */
export interface PatternIndexSearchResponse {
  results: readonly PatternIndexSearchResult[];

  /** How many matches were left out, by reason, such as `unlisted` or `unvetted`. */
  excluded?: Readonly<Record<string, number>>;
}

export interface PatternIndexProgramFile {
  name: string;
  contents: string;
}

/**
 * The published program, in the shape a `RuntimeProgram` is assembled from.
 * Present only when `getPattern` was asked for source.
 */
export interface PatternIndexProgram {
  main: string;
  mainExport?: string;
  files: readonly PatternIndexProgramFile[];
  sourceRoots?: readonly string[];
  dataFiles?: readonly string[];
}

export interface PatternIndexPattern {
  patternId: string;

  /** Short display name, when the index has or could derive one. */
  name?: string;

  /** The publisher's DID, from deployments that predate `handle`. */
  ownerDid?: string;

  /**
   * @deprecated Read `author.pseudonym`. Deployments with private versions
   * answer the same per-lineage pseudonym here, for older readers; older
   * deployments answer one pseudonym per author, shared across their
   * patterns.
   */
  handle?: string;

  /** How the author is shown: a per-lineage pseudonym, a tier, a name if published. */
  author?: PatternIndexAuthor;

  /** Whether the caller is its author. */
  mine?: boolean;

  createdAt: string;
  description: string;
  hashtags: readonly string[];
  argumentSchema?: JSONSchema;
  resultSchema?: JSONSchema;
  dependencies: readonly string[];
  priorPatternId?: string;
  remixedFrom?: string;

  /** A remix's originals, nearest first, cut to what the reader may see. */
  remixChain?: readonly PatternIndexRemixLink[];

  /** With `ref`: the shared version the link names now. */
  link?: PatternIndexLink;

  lineageId?: string;

  /** The caller's own version with this source; owner only. */
  versionId?: string;

  visibility?: PatternIndexVisibility;
  program?: PatternIndexProgram;

  /**
   * Whether others can find it. `getPattern` serves a pattern by id whether
   * or not it is listed, so a direct link always works.
   */
  listed?: boolean;

  /** Where its listing request stands. */
  listing?: PatternIndexListing;

  /** Held by the index before listing existed, and listed without a check. */
  grandfathered?: true;

  /** Kept out of discovery by an admin. */
  hidden?: true;

  bucket?: PatternIndexBucket;

  /** When its author first used it in a loom (ISO 8601), which put it in `main`. */
  authorProvenAt?: string;

  /** Gate gardener verdicts by gardener name; owner and admins only. */
  gates?: Readonly<Record<string, PatternIndexGardenerVerdict>>;

  /** Annotation gardener verdicts by gardener name; owner and admins only. */
  annotations?: Readonly<Record<string, PatternIndexGardenerVerdict>>;
}

/**
 * One pattern, named by its id, or by a pattern link: its lineage's
 * pseudonym for the stable channel, `<pseudonym>@beta` for beta, or
 * `<pseudonym>@<n>` for shared version n.
 */
export type PatternIndexGetRequest =
  & ({ patternId: string; ref?: never } | { ref: string; patternId?: never })
  & { includeSource?: boolean };

/** The two channels a shared version is on: findable, or by link only. */
export type PatternIndexChannel = "beta" | "stable";

/** What a pattern link names now, as `getPattern {ref}` answers it. */
export interface PatternIndexLink {
  ref: string;
  channel: PatternIndexChannel | "number";

  /** The shared version number it resolved to. */
  number: number;

  /** Whether that number is on the stable channel. */
  stable: boolean;
}

/**
 * One row of `listPatterns`: a pattern's public metadata, the events recorded
 * against it counted by type, and its own plus inherited ranking evidence.
 * Carries no source and none of the private query fields a publication
 * supplied.
 */
export interface PatternIndexListedPattern {
  patternId: string;

  /** Short display name, when the index has or could derive one. */
  name?: string;

  description: string;
  hashtags: readonly string[];
  keywords: readonly string[];

  /** The publisher's DID, from deployments that predate `handle`. */
  ownerDid?: string;

  /**
   * @deprecated Read `author.pseudonym`. Deployments with private versions
   * answer the same per-lineage pseudonym here, for older readers; older
   * deployments answer one pseudonym per author, shared across their
   * patterns.
   */
  handle?: string;

  /** How the author is shown: a per-lineage pseudonym, a tier, a name if published. */
  author?: PatternIndexAuthor;

  /** Whether the caller is its author. */
  mine?: boolean;

  /** `null` for a pattern the index holds no creation time for. */
  createdAt: string | null;

  /** Event type to how many times it was recorded against this pattern. */
  events: Readonly<Record<string, number>>;

  /**
   * @deprecated Retired with pseudonymous authors: newer deployments store no
   * author DIDs on events and never answer this.
   *
   * Event type to author DID to count, for this generation's own events.
   * Absent on indexes that return totals without author attribution.
   */
  eventAuthors?: Readonly<Record<string, Readonly<Record<string, number>>>>;

  score: number;

  /** Combined evidence, absent on index deployments without inheritance. */
  signals?: PatternIndexSignals;

  /** Evidence tier computed by the index, absent on older deployments. */
  quality?: PatternIndexQuality;

  bucket?: PatternIndexBucket;
  listed?: boolean;
  listing?: PatternIndexListing;

  /** `beta` on a record shared to beta only; owner only. */
  channel?: "beta";

  grandfathered?: true;
  hidden?: true;

  /** Owner and admins only. */
  gates?: Readonly<Record<string, PatternIndexGardenerVerdict>>;
  annotations?: Readonly<Record<string, PatternIndexGardenerVerdict>>;

  lineageId?: string;
  aggregates?: Readonly<Record<string, PatternIndexAggregate>>;
}

/**
 * Which patterns to list. An unlisted pattern is returned only to its owner
 * and to admins. Deployments that predate listing ignore these filters and
 * return everything, so a caller that relies on them checks `whoami` first,
 * which those deployments do not answer.
 */
export interface PatternIndexListPatternsRequest {
  /** Only the caller's own patterns, including unlisted ones. */
  mine?: boolean;

  /** Only featured patterns. */
  featured?: boolean;
}

export interface PatternIndexListPatternsResponse {
  patterns: readonly PatternIndexListedPattern[];

  /**
   * Event type to the weight `score` counts one of them at. Kept for older
   * readers; `eventTypeDeclarations` carries the weight too.
   */
  eventTypes: Readonly<Record<string, number>>;

  /** Each event type's full declaration, absent on older deployments. */
  eventTypeDeclarations?: Readonly<
    Record<string, PatternIndexEventTypeDeclaration>
  >;
}

export interface PatternIndexListEventsRequest {
  patternId?: string;

  /** The index caps this at 500, whatever a caller asks for. */
  limit?: number;
}

/** One recorded event of the calling identity's own stream. */
export interface PatternIndexEvent {
  patternId: string;

  /** Author DID established by the request's authenticated signer. */
  did: string;

  eventType: string;

  /** `null` for an event the index holds no timestamp for. */
  ts: string | null;

  /** @deprecated Newer deployments store no free text on events. */
  note?: string;
}

export interface PatternIndexListEventsResponse {
  events: readonly PatternIndexEvent[];
}

/**
 * What a run reports back about a pattern it took from the index. The index
 * ranks on these, so a run that instantiates a pattern and then fails says
 * both things rather than only the first.
 */
export type PatternIndexEventType =
  | "created"
  | "instantiated"
  | "run_succeeded"
  | "run_failed"
  | "thumbs_up"
  | "thumbs_down";

/**
 * What a person did with a pattern in their loom, reported by Loom through
 * `recordUsageEvent`. A harness or agent run never sends these: they are what
 * ranks a pattern by people's use, and `viewed_in_loom` from its author is
 * what promotes it to `main`.
 *
 * - `deployed`: a person placed the pattern into a loom.
 * - `viewed_in_loom`: a person opened a loom holding a piece they placed.
 * - `removed`: a person removed such a piece.
 */
export type PatternIndexUsageEventType =
  | "deployed"
  | "viewed_in_loom"
  | "removed";

/**
 * A usage event and what it is about. The owner's `viewed_in_loom` about the
 * piece a version was deployed to counts toward settling that version: once
 * they have used it for a day with no newer version and it passes the
 * privacy check, the index shares it, while the sharing setting covers it.
 */
export type PatternIndexRecordUsageEventRequest = PatternIndexEventSubject & {
  eventType: PatternIndexUsageEventType;
};

/**
 * What an event is about: a pattern by id, or, for its owner's own use of a
 * version in a loom, the piece the version was deployed to
 * ({@link deployedPieceRef}), which is what a loom knows.
 */
export type PatternIndexEventSubject =
  | { patternId: string; piece?: never }
  | { piece: string; patternId?: never };

/** Signed event payload; the client supplies the author from its identity. */
export interface PatternIndexRecordEventRequest {
  patternId: string;
  eventType: PatternIndexEventType;

  /**
   * Author DID, which an older deployment verifies against the CF1 signer.
   * A deployment that attributes events to the signer's member drops it, so
   * the client keeps sending it to work with both.
   */
  did: string;

  /** @deprecated Newer deployments store no free text on events. */
  note?: string;
}

export interface PatternIndexRecordEventResponse {
  ok: boolean;

  /**
   * `false` for an event the index keeps no record of, such as one about a
   * piece the caller has no version for.
   */
  recorded?: boolean;

  /** What the owner's use of a version did about sharing it. */
  settled?: {
    autoShare: PatternIndexAutoShare;
    shared?: boolean;
    reason?: string;
  };
}

/** An owner's request to retire a generation in favor of its direct successor. */
export interface PatternIndexRetractRequest {
  patternId: string;
  successorPatternId: string;
  reason: string;
}

/** The index's durable retirement receipt; source and events remain readable. */
export interface PatternIndexRetractResponse {
  patternId: string;
  status: "retracted";
  successorPatternId: string;
  retractionReason: string;
  retractedBy: string;
  retractedAt: string;
  discoverable: false;
  changed: boolean;
}

/**
 * How a client names a piece a version was deployed to, for `deployedTo`
 * and for an event about it: a hash of the space and the piece's id, so the
 * index learns neither. `pieceId` is the bare `fid1:…` form; an `of:` prefix
 * is taken off.
 */
export function deployedPieceRef(spaceDid: string, pieceId: string): string {
  const bare = pieceId.startsWith("of:") ? pieceId.slice(3) : pieceId;
  return `piece:${
    encodeHex(sha256(new TextEncoder().encode(`${spaceDid}/${bare}`)))
  }`;
}

/** What {@link deployedPieceRef} answers, and nothing else is sent as one. */
const PIECE_REF = /^piece:[0-9a-f]{64}$/;

/** Whether `ref` is a piece reference as {@link deployedPieceRef} answers one. */
export const isPieceRef = (ref: string): boolean => PIECE_REF.test(ref);

/**
 * `ref`, checked to be a hashed piece reference, so a raw piece id never
 * reaches the index.
 *
 * @throws Error naming the field for anything else.
 */
const pieceRef = (field: string, ref: string): string => {
  if (!isPieceRef(ref)) {
    throw new Error(
      `${field} must be a piece reference from deployedPieceRef, not a piece id`,
    );
  }
  return ref;
};

/**
 * Who may read a version: its owner alone, any member who shares (under the
 * lineage's pseudonym), or any member (under its owner's public profile).
 */
export type PatternIndexVisibility = "private" | "shared" | "published";

/**
 * Where a version's share stands:
 *
 * - `none`: never asked to share.
 * - `pending`: the privacy gardener is checking it.
 * - `held`: the gardener found something identifying; its owner reads
 *   `gates`, and a changed source can be shared again.
 * - `error`: the check failed to run; `shareVersion` asks again.
 * - `exposed`: shared, and readable by others.
 * - `public_elsewhere`: the same source is already shared under someone
 *   else, so this one cannot be; a changed source can.
 */
export type PatternIndexShareState =
  | "none"
  | "pending"
  | "held"
  | "error"
  | "exposed"
  | "public_elsewhere";

/**
 * Who made a version, which decides the sharing sub-setting that applies:
 * the person (`cf`, Claude Code) or an agent working for them.
 */
export type PatternIndexOrigin = "self" | "agent";

/** A Common Fabric public profile, by its space. */
export interface PatternIndexProfileRef {
  space: string;

  /** The profile piece, when the client knows it. */
  piece?: string;
}

/**
 * The person a named lineage is published under. Others read the name from
 * the profile itself.
 */
export interface PatternIndexPublishedAuthor {
  profile: PatternIndexProfileRef;

  /** The name the owner gave when naming it; only the owner sees it. */
  displayName?: string;

  /** The UTC day it was named. */
  since: string;
}

/**
 * How a pattern's author is shown to others: a pseudonym of its own lineage,
 * unrelated to the author's other lineages, and a coarse tier saying how much
 * their other shared work is used; a name only where they published it.
 */
export interface PatternIndexAuthor {
  /** Stable for the lineage, and for no other. */
  pseudonym: string;

  /** 0 to 9, logarithmic in uses of the author's other lineages. */
  tier: number;

  published?: PatternIndexPublishedAuthor;
  brand?: {
    githubOrg: string;
    displayName: string;
    profile?: PatternIndexProfileRef;
  };
}

/** One version of a lineage, as its owner (and only its owner) sees it. */
export interface PatternIndexVersionSummary {
  versionId: string;
  lineageId: string;

  /** 1, 2, 3 within the lineage. */
  seq: number;

  patternId: string;
  createdAt: string;
  name?: string;
  description: string;
  hashtags: readonly string[];
  origin: PatternIndexOrigin;
  visibility: PatternIndexVisibility;
  share: PatternIndexShareState;

  /** Whether it is the lineage's current version. */
  head: boolean;

  /** The version whose source a rollback restored. */
  rolledBackFrom?: string;

  remixedFrom?: string;

  /** Its source's newest shared version number, once others can read it. */
  shared?: { number: number; stable: boolean };
}

/** One version with its full metadata and, when asked for, its source. */
export interface PatternIndexVersion extends PatternIndexVersionSummary {
  keywords: readonly string[];
  argumentSchema?: JSONSchema;
  resultSchema?: JSONSchema;
  dependencies: readonly string[];
  program?: PatternIndexProgram;
  gates?: Readonly<Record<string, PatternIndexGardenerVerdict>>;
}

/** One of the caller's lineages: a pattern they have worked on over time. */
export interface PatternIndexLineage {
  lineageId: string;

  /** The client key it was made under, such as a file path. */
  slot?: string;

  origin: PatternIndexOrigin;

  /** How others see its author while it is unnamed. */
  pseudonym: string;

  name?: string;
  description: string;
  head: PatternIndexVersionSummary;

  /** How many versions it has, and how many of them others can read. */
  versions: number;
  sharedVersions: number;

  /**
   * Its shared version numbers: the newest, and the one each channel's link
   * gives now. Each is absent while nothing is there.
   */
  channels?: { latest?: number; stable?: number; beta?: number };

  /** Unshared: nothing of it is offered on a channel until shared again. */
  withdrawn?: boolean;

  published?: PatternIndexPublishedAuthor;
  tier: number;
}

export interface PatternIndexListLineagesResponse {
  /** Newest head first. */
  lineages: readonly PatternIndexLineage[];
}

export interface PatternIndexListVersionsResponse {
  lineageId: string;

  /** Newest first. */
  versions: readonly PatternIndexVersionSummary[];
}

export interface PatternIndexGetVersionRequest {
  versionId: string;
  includeSource?: boolean;
}

export interface PatternIndexRollbackRequest {
  lineageId: string;

  /** The version whose source becomes the new head. */
  toVersionId: string;

  /** Keep the new head private whatever the sharing setting says. */
  keepPrivate?: boolean;
}

export interface PatternIndexShareVersionResponse {
  versionId: string;
  patternId: string;
  visibility: PatternIndexVisibility;
  share: PatternIndexShareState;
  listing?: PatternIndexListing;

  /** Its shared version number, once the check has passed. */
  shared?: number;

  /** `false` when it was already shared or being checked. */
  changed: boolean;
}

/**
 * Names the caller as the author of one lineage. `profileProof` is the
 * profile's root delegation to the person's core identity, then one link
 * from that identity to the request's signing key under
 * `/memory/attest/pattern-index`, in the encoding `proofs` uses.
 */
export interface PatternIndexPublishLineageRequest {
  lineageId: string;
  profile: PatternIndexProfileRef;

  /** A name for the owner's own view; others read it from the profile. */
  displayName?: string;

  profileProof: readonly string[];

  /**
   * Shares this version first; a share the index refuses is answered as
   * that refusal, and nothing is named.
   */
  versionId?: string;
}

export interface PatternIndexPublishLineageResponse {
  lineageId: string;
  published: PatternIndexPublishedAuthor;
  share?: PatternIndexShareState;
}

export interface PatternIndexDeleteVersionResponse {
  versionId: string;
  deleted: true;

  /** Whether it was the lineage's last version, which takes the lineage. */
  lineageDeleted: boolean;

  /** The lineage's head now, when it was the head and others remain. */
  head?: string;

  /** Whether a share not yet exposed was dropped with it. */
  droppedShare: boolean;
}

export interface PatternIndexDeleteLineageResponse {
  lineageId: string;
  deleted: true;

  /** How many shares not yet exposed were dropped with it. */
  droppedShares: number;
}

export interface PatternIndexUnshareLineageResponse {
  lineageId: string;
  unshared: true;
  changed: boolean;
}

export interface PatternIndexUnpublishLineageResponse {
  lineageId: string;
  published: null;
  changed: boolean;
}

/**
 * The member's give-to-get setting. `enabled` is the main switch: while it
 * is on, the index shares versions agents make for the member, and the
 * member sees what others share; `selfBuilt` also shares the versions the
 * member builds themselves (`cf`, Claude Code). Turned off, the member's
 * searches and listings hold only named patterns; fetching a shared one by
 * id still works.
 */
export interface PatternIndexSharingSettings {
  enabled: boolean;
  selfBuilt: boolean;

  /** Whether the member sees anonymous shared patterns; follows `enabled`. */
  receivesAnonymous: boolean;

  /** `null` until the member first sets it. */
  updatedAt: string | null;
}

export interface PatternIndexSetSharingSettingsRequest {
  enabled?: boolean;
  selfBuilt?: boolean;
}

/**
 * What a publish did about sharing the version it recorded. A publish never
 * shares by itself: `when_used` means the index shares the version once its
 * owner has used it in a loom for a day with no newer version and it passes
 * the privacy check, while the sharing setting allows.
 */
export type PatternIndexAutoShare =
  | "when_used"
  | "sharing_off"
  | "kept_private"
  | "already_shared"
  | "not_eligible";

export interface PatternIndexPublishRequest {
  /**
   * The program's content-addressed entry identity — what
   * `computeEntryIdentity` answers for the same `main` and files. The index
   * stores a pattern under the identity the publisher computed, so the same
   * source published twice is the same entry rather than a second copy.
   */
  patternId: string;

  description: string;
  hashtags: readonly string[];

  /**
   * The request this pattern was written to answer. Deployments that predate
   * listing require it; newer ones neither require nor store it, since it can
   * carry the requester's personal details. New callers leave it out.
   */
  directQuery?: string;

  keywords?: readonly string[];
  program: PatternIndexProgram;
  argumentSchema?: JSONSchema;
  resultSchema?: JSONSchema;
  dependencies?: readonly string[];

  /**
   * The same author's previous version. The new version keeps that
   * version's standing; a predecessor owned by someone else is refused.
   */
  priorPatternId?: string;

  /**
   * Someone else's pattern this one was built from; credits it, inherits
   * nothing, and starts a new lineage.
   */
  remixedFrom?: string;

  /** Continue this lineage of the caller's; refused when it is not theirs. */
  lineageId?: string;

  /**
   * Whether this pattern is offered to a person choosing what to place, on
   * its own at the top of a loom, rather than only as a part other patterns
   * build from. Sent only when the publisher knows: absent, the index takes
   * it from the version this one follows (`priorPatternId`), else from the
   * pattern this remixes (`remixedFrom`: only this answer carries over from
   * a remix's source), and otherwise from the entry file being named
   * `main.tsx`. A pattern with a required input and no default is
   * stored as a part whatever this says.
   */
  standalone?: boolean;

  /**
   * A key the caller chooses for the lineage, unique per owner, such as an
   * entry file's path; finds the lineage when no id or predecessor does.
   */
  slot?: string;

  /**
   * Who made it, which decides whether the sharing setting shares it; a
   * version sent without one is never shared on its own.
   */
  origin?: PatternIndexOrigin;

  /** Keep this version private whatever the sharing setting says. */
  keepPrivate?: boolean;

  /**
   * The piece this version was deployed to ({@link deployedPieceRef}), so
   * the owner's later use of that piece in a loom finds the version. Owner
   * only; the index keeps a keyed hash of it.
   */
  deployedTo?: string;

  /**
   * Explicitly offers this entry to search on publication. Deployments with
   * listing ignore it: discovery follows `requestListing` and the gardeners.
   */
  discoverable?: true;

  /**
   * Set to keep this entry out of search. The pattern is recorded in full
   * either way — `getPattern` answers for it, a `cf:pattern:` import resolves
   * it, and events record against it — so this decides discovery and nothing
   * else. Absent means the server applies its recorded-only default.
   *
   * The reason travels with the flag rather than beside it because the index
   * refuses one without the other: a hidden entry nobody recorded a reason
   * for is an entry nobody can decide about later.
   */
  nonDiscoverable?: { readonly reason: string };

  /**
   * The repository file this pattern is the newest version of, sent by a
   * repository sync. The index keeps one lineage per repository and path,
   * so it sets the predecessor itself, and `publishPattern` refuses one sent
   * with `priorPatternId`, `lineageId` or `slot`.
   */
  source?: PatternIndexRepoSource;
}

/** Where in a repository a synced pattern comes from. */
export interface PatternIndexRepoSource {
  /** `owner/name`, as GitHub names it. */
  repository: string;

  /** The entry file's path from the repository root. */
  path: string;

  /** The commit the program was read at. */
  commit: string;

  /**
   * A hash of the program's files as read, before compiling. A later sync
   * compares it to decide whether the source changed, without compiling.
   */
  sourceHash: string;

  /**
   * The path in the same repository this file moved from: the index moves
   * that path's lineage here, history and all. It refuses a move it cannot
   * make (no lineage there, or a live one here) with `move_refused`, writing
   * nothing.
   */
  movedFrom?: string;
}

/** Asks for the newest version of every lineage a repository holds. */
export interface PatternIndexListRepoHeadsRequest {
  /** `owner/name`. */
  repository: string;
}

/** The newest version the index holds for one repository path. */
export interface PatternIndexRepoHead {
  path: string;
  patternId: string;
  sourceHash: string;
  commit: string;
  listing?: PatternIndexListing;

  /** Gate gardener verdicts by gardener name. */
  gates?: Readonly<Record<string, PatternIndexGardenerVerdict>>;
}

export interface PatternIndexListRepoHeadsResponse {
  heads: readonly PatternIndexRepoHead[];
}

/**
 * Withdraws the lineages of repository paths that are no longer patterns
 * there: each is unlisted and stays readable by id, and a path that comes
 * back resumes its lineage.
 */
export interface PatternIndexWithdrawRepoPathsRequest {
  /** `owner/name`. */
  repository: string;

  paths: readonly string[];
}

export interface PatternIndexWithdrawRepoPathsResponse {
  /** Each path asked about, and whether a lineage was withdrawn for it. */
  withdrawn: readonly { path: string; withdrawn: boolean }[];
}

export interface PatternIndexPublishResponse {
  patternId: string;

  /** `false` when the index already held this identity, which is not an error. */
  created: boolean;

  /**
   * For a repository sync: `true` when the lineage's newest version already
   * has this identity, so nothing was written.
   */
  unchanged?: boolean;

  /** Request fields this deployment no longer stores and dropped. */
  ignored?: readonly string[];

  /**
   * Whether the version stands alone, which may differ from what was
   * asked: a required input with no default makes it a part. Absent from
   * deployments that predate the field.
   */
  standalone?: boolean;

  /**
   * The required input with no default that made it a part, when that is
   * why `standalone` is false.
   */
  standaloneFloor?: string;

  /**
   * The version recorded, or the head that already had this source. Absent
   * from deployments that predate private versions.
   */
  versionId?: string;
  lineageId?: string;
  seq?: number;

  /**
   * Who may read the new version. A repository sync's version is
   * `published`, unless the same source is already public under someone
   * else, when it is `private`.
   */
  visibility?: PatternIndexVisibility;
  share?: PatternIndexShareState;

  /** What the index did about sharing it, and why where it did not. */
  autoShare?: PatternIndexAutoShare;
  reason?: string;
}

/** An owner's request that a pattern be considered for discovery. */
export interface PatternIndexRequestListingRequest {
  patternId: string;
}

/**
 * The listing state after the request. Over the caller's daily gardener cap
 * the index refuses with 429 and a `resetsAt` time, which arrives as
 * `PatternIndexError.retryAt`, and the pattern stays `not_requested`.
 */
export interface PatternIndexRequestListingResponse {
  patternId: string;
  listing: PatternIndexListing;
}

/** Asks for one gardener's prompt, so a client can run the same check locally. */
export interface PatternIndexGardenerPromptRequest {
  name: string;
}

export interface PatternIndexGardenerPromptResponse {
  name: string;
  kind: "gate" | "annotation";

  /** A hash of `prompt` and `outputSchema`; a client reports the one it used. */
  promptVersion: string;

  prompt: string;
  outputSchema: JSONSchema;

  /**
   * The format of the input the prompt describes (`pattern-json-1`); a
   * client renders that input itself, so one it does not know is one it
   * cannot ask faithfully. Absent on deployments that predate it.
   */
  inputFormat?: string;
}

/** An admin mints a single-use invite. */
export interface PatternIndexCreateInviteRequest {
  /** Seconds until the invite expires; the index applies its own default and cap. */
  ttlSeconds?: number;
}

/**
 * The invite. `code` is the secret: it travels in a link's fragment and the
 * index keeps only a verifier for it.
 */
export interface PatternIndexCreateInviteResponse {
  inviteId: string;
  code: string;
  expiresAt: string;

  /** The invite as a link to share, with `code` in its fragment. */
  link?: string;
}

/** Redeems an invite; the signing key becomes the new member's root. */
export interface PatternIndexRedeemInviteRequest {
  inviteId: string;
  code: string;
}

/**
 * A member of the index: the caller (`whoami`) or one just admitted or moved.
 * A member is a delegation-chain root; the index keeps no list of the other
 * keys a person acts through.
 */
export interface PatternIndexMember {
  handle: string;
  role: "admin" | "user";

  /** @deprecated Always 1: the index knows only a member's root. */
  keys?: number;
}

/**
 * Hands the caller's member's root to the signing key. `rootDelegation` is a
 * delegation from the current root to the signer, for `/index/root`, in
 * unpadded base64url. It works once.
 */
export interface PatternIndexMoveRootRequest {
  rootDelegation: string;
}

/** An admin points a member who lost their root key at a new one. */
export interface PatternIndexMoveMemberRootRequest {
  handle: string;
  did: string;
}

/**
 * Refuses a delegation in the caller's member's chains from now on, or
 * removes one of the caller's legacy keys (one admitted before chains, which
 * has no delegation to revoke).
 */
export type PatternIndexRevokeRequest =
  | { delegation: string }
  | { legacyKey: string };

export type PatternIndexRevokeResponse =
  | { revoked: string }
  | { removed: true };

/** An admin admits a key as a new member, invited by that admin. */
export interface PatternIndexAdmitKeyRequest {
  did: string;
}

/**
 * An admin hides a pattern from discovery, with the reason the record keeps,
 * or shows it again. Showing again never lists a pattern its gates hold.
 */
export type PatternIndexSetHiddenRequest =
  | { patternId: string; hidden: true; reason: string }
  | { patternId: string; hidden: false; reason?: undefined };

/** The pattern's listing after the change; `changed` is false when it already was so. */
export interface PatternIndexSetHiddenResponse {
  patternId: string;
  changed: boolean;
  listed?: boolean;
  listing?: PatternIndexListing;
  hidden?: true;

  /** Why and when an admin hid it; owner and admins only. */
  hiddenReason?: string;
  hiddenAt?: string;
}

/** An admin features or unfeatures a listed pattern. */
export interface PatternIndexSetFeaturedRequest {
  patternId: string;
  featured: boolean;

  /** Lower ranks first among featured hits. */
  rank?: number;

  note?: string;
}

export interface PatternIndexSetFeaturedResponse {
  patternId: string;
  featured: boolean;
}

/** An admin re-runs a gardener on a pattern, as a fresh attempt. */
export interface PatternIndexRegardenRequest {
  patternId: string;
  gardener: string;
}

/**
 * A non-2xx answer from the index, carrying the HTTP status alongside the
 * `error` message the service returned. The status is what separates a
 * misconfigured identity (401/403) from a pattern that is not there (404),
 * and callers phrase their own message from it.
 */
export class PatternIndexError extends Error {
  override name = "PatternIndexError";
  readonly status: number;

  /** The index function that answered, for a message that says where. */
  readonly fn: string;

  /**
   * What the service actually said. Deliberately NOT part of `message`: a
   * failure body from the index can quote indexed source or storage detail,
   * and `message` is what tool error paths render toward the model. The
   * detail is for artifacts — the paths that stash withheld text into
   * `rawCauseMessage` read it from here.
   */
  readonly detail?: string;

  /** When a refusal for a limit says to try again (ISO 8601). */
  readonly retryAt?: string;

  constructor(fn: string, status: number, detail?: string, retryAt?: string) {
    super(`pattern index ${fn} failed (${status})`);
    this.fn = fn;
    this.status = status;
    if (detail !== undefined) {
      this.detail = detail;
    }
    if (retryAt !== undefined) {
      this.retryAt = retryAt;
    }
  }

  /**
   * A 2xx answer this client cannot read. `problem` is the client's own
   * account of what is wrong, naming fields and never quoting the answer, so
   * unlike a service's `detail` it is part of `message`.
   */
  static malformed(
    fn: string,
    status: number,
    problem: string,
  ): PatternIndexError {
    const error = new PatternIndexError(fn, status);
    error.message = `pattern index ${fn} answer is malformed: ${problem}`;
    return error;
  }
}

export interface PatternIndexClientOptions {
  baseUrl: string;
  fetchFn?: PatternIndexFetch;
  signer: FirstPartyHttpSigner;

  /**
   * The delegation chain the signer acts for its member through, root first:
   * each link a delegation for `/index` about the root, in unpadded base64url,
   * the first issued by the root itself, the last to the signer and expiring
   * within 90 days; at most 8. Sent inside every signed call. Without it the
   * signer is its own root.
   */
  proofs?: readonly string[];

  /**
   * Mints a GitHub Actions OIDC token whose audience is
   * `pattern-index:<index host>:<signer DID>`, sent inside every signed call.
   * The host keeps a token minted for one index deployment from being
   * accepted by another, and the DID binds it to this client's signer. It makes the signer act for the brand that
   * owns the token's repository; `github-oidc.ts` says how the token is
   * minted. Called once per call, since a token lives only minutes and a
   * sync can run longer.
   */
  githubOidc?: () => Promise<string>;
}

/** A JSON object's own property, or `undefined` for anything else. */
const ownField = (value: unknown, key: string): unknown =>
  isObjectOrArray(value) && !Array.isArray(value)
    ? Object.getOwnPropertyDescriptor(value, key)?.value
    : undefined;

/**
 * What keeps `program` from being a {@link PatternIndexProgram}, or
 * `undefined` when nothing does, as when there is no program at all. Names
 * fields, never their values, so the answer is safe to show whoever asked.
 */
const programProblem = (program: unknown): string | undefined => {
  if (program === undefined) return undefined;
  if (!isObjectNotArray(program)) {
    return "program is not an object";
  }
  if (typeof ownField(program, "main") !== "string") {
    return "program.main is not a string";
  }
  const mainExport = ownField(program, "mainExport");
  if (mainExport !== undefined && typeof mainExport !== "string") {
    return "program.mainExport is not a string";
  }
  const files = ownField(program, "files");
  if (!Array.isArray(files)) return "program.files is not an array";
  for (const [index, file] of files.entries()) {
    for (const key of ["name", "contents"]) {
      if (typeof ownField(file, key) !== "string") {
        return `program.files[${index}].${key} is not a string`;
      }
    }
  }
  for (const key of ["sourceRoots", "dataFiles"]) {
    const list = ownField(program, key);
    if (
      list !== undefined &&
      !(Array.isArray(list) && list.every((entry) => typeof entry === "string"))
    ) {
      return `program.${key} is not an array of strings`;
    }
  }
  return undefined;
};

/**
 * Joins an index function onto the configured base, keeping every segment the
 * base already carries. `new URL(fn, base)` would drop the base's last
 * segment whenever it has no trailing slash, which is how a deployment served
 * under a path prefix loses that prefix.
 */
const functionUrl = (baseUrl: string, fn: string): URL =>
  new URL(`${baseUrl.replace(/\/+$/, "")}/${fn}`);

export class PatternIndexClient {
  readonly #baseUrl: string;
  readonly #fetchFn: PatternIndexFetch;
  readonly #signer: FirstPartyHttpSigner;
  readonly #proofs?: readonly string[];
  readonly #githubOidc?: () => Promise<string>;

  constructor(options: PatternIndexClientOptions) {
    // The function name is appended to the base's path, so a base carrying a
    // query or fragment would put the function after that component and
    // every request would sign and address the wrong URL. Refused here,
    // where the misconfiguration is nameable, rather than as N opaque 404s.
    const base = new URL(options.baseUrl);
    if (base.search !== "" || base.hash !== "") {
      throw new Error(
        `pattern index base URL must not carry a query or fragment: ${options.baseUrl}`,
      );
    }
    // The parsed base is what gets joined, not the configured string: a bare
    // trailing "?" or "#" parses to an empty search/hash the guard cannot
    // see, and appending to the raw string would put the function after the
    // delimiter.
    this.#baseUrl = base.origin + base.pathname;
    this.#fetchFn = options.fetchFn ?? ((input, init) => fetch(input, init));
    this.#signer = options.signer;
    if (options.proofs !== undefined) {
      // The index refuses a longer chain on every call; say so once, here.
      if (options.proofs.length > MAX_PROOF_CHAIN_LENGTH) {
        throw new Error(
          `pattern index proofs: the chain is longer than ${MAX_PROOF_CHAIN_LENGTH} links`,
        );
      }
      // A copy, so the caller's later edits never change what is sent.
      this.#proofs = [...options.proofs];
    }
    this.#githubOidc = options.githubOidc;
  }

  /**
   * The DID every call from this client is signed as, which is the principal
   * the index attributes what this client did to.
   */
  get did(): string {
    return this.#signer.did();
  }

  /**
   * Posts `payload` to one index function and returns its parsed answer.
   *
   * @throws PatternIndexError when the index answers non-2xx, or when a 2xx
   * answer does not parse as JSON or `problem` finds fault with it — a body
   * the caller cannot read is a failure of the call rather than a result.
   */
  async #call<T>(
    fn: string,
    payload: Record<string, unknown>,
    problem?: (answer: unknown) => string | undefined,
  ): Promise<T> {
    const url = functionUrl(this.#baseUrl, fn);
    // The proof commits to the body hash, so the bytes signed and the bytes
    // sent must be identical — serialize once.
    const body = JSON.stringify({
      ...payload,
      ...(this.#proofs === undefined ? {} : { proofs: [...this.#proofs] }),
      ...(this.#githubOidc === undefined
        ? {}
        : { githubOidc: await this.#githubOidc() }),
    });
    const headers = await signFirstPartyHttpRequest({
      url,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signer: this.#signer,
    });
    const response = await this.#fetchFn(url, {
      method: "POST",
      headers,
      body,
    });
    return await this.#readResponse<T>(fn, response, problem);
  }

  /** Parses a service response while keeping its failure detail artifact-only. */
  async #readResponse<T>(
    fn: string,
    response: Response,
    problem?: (answer: unknown) => string | undefined,
  ): Promise<T> {
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (!response.ok) {
      const error = isObjectOrArray(parsed) &&
          typeof (parsed as { error?: unknown }).error === "string"
        ? (parsed as { error: string }).error
        : text.slice(0, 200);
      const resetsAt = ownField(parsed, "resetsAt");
      throw new PatternIndexError(
        fn,
        response.status,
        error,
        typeof resetsAt === "string" ? resetsAt : undefined,
      );
    }
    const fault = parsed === undefined ? "it is not JSON" : problem?.(parsed);
    if (fault !== undefined) {
      throw PatternIndexError.malformed(fn, response.status, fault);
    }
    return parsed as T;
  }

  /** Reads the index's public health response. */
  async health(): Promise<unknown> {
    const response = await this.#fetchFn(functionUrl(this.#baseUrl, "health"));
    return await this.#readResponse("health", response);
  }

  /** Reads public membership for the principal this client signs as. */
  async enrollmentStatus(): Promise<unknown> {
    const url = functionUrl(this.#baseUrl, "enrollmentStatus");
    url.searchParams.set("did", this.did);
    const response = await this.#fetchFn(url);
    return await this.#readResponse("enrollmentStatus", response);
  }

  /**
   * Searches current discoverable generations. The index substitutes each
   * matched generation's discoverable successor and withholds ambiguous
   * chains, so the answer is returned as the index gave it.
   */
  searchPatterns(
    request: PatternIndexSearchRequest,
  ): Promise<PatternIndexSearchResponse> {
    return this.#call<PatternIndexSearchResponse>("searchPatterns", {
      ...(request.tags !== undefined ? { tags: [...request.tags] } : {}),
      ...(request.text !== undefined ? { text: request.text } : {}),
      ...(request.limit !== undefined ? { limit: request.limit } : {}),
      ...(request.includeUnvetted !== undefined
        ? { includeUnvetted: request.includeUnvetted }
        : {}),
    });
  }

  /**
   * Reads one pattern, with its program when `includeSource` asks for it.
   *
   * @throws PatternIndexError when the answer carries a program without the
   * shape of a {@link PatternIndexProgram}, naming what is missing.
   */
  getPattern(request: PatternIndexGetRequest): Promise<PatternIndexPattern> {
    return this.#call<PatternIndexPattern>(
      "getPattern",
      {
        ...(request.ref !== undefined
          ? { ref: request.ref }
          : { patternId: request.patternId }),
        ...(request.includeSource !== undefined
          ? { includeSource: request.includeSource }
          : {}),
      },
      (answer) => programProblem(ownField(answer, "program")),
    );
  }

  /**
   * Every pattern the index holds, scored, for an operator reading the index
   * as a whole. Counts, weights and available author counts are public;
   * individual event notes remain in the caller's own event stream.
   */
  listPatterns(
    request: PatternIndexListPatternsRequest = {},
  ): Promise<PatternIndexListPatternsResponse> {
    return this.#call<PatternIndexListPatternsResponse>("listPatterns", {
      ...(request.mine !== undefined ? { mine: request.mine } : {}),
      ...(request.featured !== undefined ? { featured: request.featured } : {}),
    });
  }

  /**
   * The calling identity's OWN events, newest first, from a deployment that
   * still keeps a per-author stream.
   *
   * @deprecated A deployment that keeps none answers HTTP 410 (see "Index
   *   service contract for authors" in the cf-harness console README), and
   *   nothing in this checkout calls it.
   */
  listEvents(
    request: PatternIndexListEventsRequest = {},
  ): Promise<PatternIndexListEventsResponse> {
    return this.#call<PatternIndexListEventsResponse>("listEvents", {
      ...(request.patternId !== undefined
        ? { patternId: request.patternId }
        : {}),
      ...(request.limit !== undefined ? { limit: request.limit } : {}),
    });
  }

  /** Records an event authored by this client's authenticated identity. */
  recordEvent(
    request: Omit<PatternIndexRecordEventRequest, "did">,
  ): Promise<PatternIndexRecordEventResponse> {
    return this.#call<PatternIndexRecordEventResponse>("recordEvent", {
      patternId: request.patternId,
      eventType: request.eventType,
      did: this.did,
      ...(request.note !== undefined ? { note: request.note } : {}),
    });
  }

  /** Retracts a generation as this client's signer; the index checks ownership. */
  retractPattern(
    request: PatternIndexRetractRequest,
  ): Promise<PatternIndexRetractResponse> {
    return this.#call<PatternIndexRetractResponse>("retractPattern", {
      patternId: request.patternId,
      successorPatternId: request.successorPatternId,
      reason: request.reason,
    });
  }

  async publishPattern(
    request: PatternIndexPublishRequest,
  ): Promise<PatternIndexPublishResponse> {
    // The index places a synced version in its path's lineage itself.
    if (
      request.source !== undefined &&
      (request.priorPatternId !== undefined ||
        request.lineageId !== undefined || request.slot !== undefined)
    ) {
      throw new Error(
        "a publish with a repository source names no predecessor, lineage or slot",
      );
    }
    const schemas = {
      ...(request.argumentSchema !== undefined
        ? { argumentSchema: request.argumentSchema }
        : {}),
      ...(request.resultSchema !== undefined
        ? { resultSchema: request.resultSchema }
        : {}),
    };
    return await this.#call<PatternIndexPublishResponse>("publishPattern", {
      patternId: request.patternId,
      program: request.program,
      meta: {
        ...(request.directQuery !== undefined
          ? { directQuery: request.directQuery }
          : {}),
        description: request.description,
        hashtags: [...request.hashtags],
        ...(request.keywords !== undefined
          ? { keywords: [...request.keywords] }
          : {}),
      },
      ...(Object.keys(schemas).length > 0 ? { schemas } : {}),
      ...(request.dependencies !== undefined
        ? { dependencies: [...request.dependencies] }
        : {}),
      ...(request.nonDiscoverable !== undefined
        ? {
          discoverable: false,
          discoverabilityReason: request.nonDiscoverable.reason,
        }
        : request.discoverable === true
        ? { discoverable: true }
        : {}),
      ...(request.priorPatternId !== undefined
        ? { priorPatternId: request.priorPatternId }
        : {}),
      ...(request.remixedFrom !== undefined
        ? { remixedFrom: request.remixedFrom }
        : {}),
      ...(request.source !== undefined ? { source: request.source } : {}),
      ...(request.lineageId !== undefined
        ? { lineageId: request.lineageId }
        : {}),
      ...(request.slot !== undefined ? { slot: request.slot } : {}),
      ...(request.standalone !== undefined
        ? { standalone: request.standalone }
        : {}),
      ...(request.origin !== undefined ? { origin: request.origin } : {}),
      ...(request.keepPrivate === true ? { keepPrivate: true } : {}),
      ...(request.deployedTo !== undefined
        ? { deployedTo: pieceRef("deployedTo", request.deployedTo) }
        : {}),
    });
  }

  /** Withdraws the lineages of repository paths that are gone. */
  withdrawRepoPaths(
    request: PatternIndexWithdrawRepoPathsRequest,
  ): Promise<PatternIndexWithdrawRepoPathsResponse> {
    return this.#call(
      "withdrawRepoPaths",
      { ...request, paths: [...request.paths] },
      (answer) =>
        Array.isArray(ownField(answer, "withdrawn"))
          ? undefined
          : "withdrawn is not an array",
    );
  }

  /** Reads the newest version of every lineage a repository holds. */
  listRepoHeads(
    request: PatternIndexListRepoHeadsRequest,
  ): Promise<PatternIndexListRepoHeadsResponse> {
    return this.#call(
      "listRepoHeads",
      { ...request },
      (answer) =>
        Array.isArray(ownField(answer, "heads"))
          ? undefined
          : "heads is not an array",
    );
  }

  /**
   * Reports what a person did with a pattern in their loom. Only Loom calls
   * this; a harness or agent run never does. The index takes it through the
   * same function as a run's outcome, which is why the two are kept apart
   * here by type.
   */
  async recordUsageEvent(
    request: PatternIndexRecordUsageEventRequest,
  ): Promise<PatternIndexRecordEventResponse> {
    return await this.#call("recordEvent", {
      ...(request.patternId !== undefined
        ? { patternId: request.patternId }
        : { piece: pieceRef("piece", request.piece) }),
      eventType: request.eventType,
      did: this.did,
    });
  }

  /** Asks that an owned pattern be checked and, if it passes, listed. */
  requestListing(
    request: PatternIndexRequestListingRequest,
  ): Promise<PatternIndexRequestListingResponse> {
    return this.#call("requestListing", { ...request });
  }

  /** Reads a gardener's prompt and output schema. */
  getGardenerPrompt(
    request: PatternIndexGardenerPromptRequest,
  ): Promise<PatternIndexGardenerPromptResponse> {
    return this.#call("getGardenerPrompt", { ...request });
  }

  /** Re-runs a gardener on a pattern as a fresh attempt. Admin only. */
  regarden(
    request: PatternIndexRegardenRequest,
  ): Promise<PatternIndexRequestListingResponse> {
    return this.#call("regarden", { ...request });
  }

  /** Mints a single-use invite. Admin only. */
  createInvite(
    request: PatternIndexCreateInviteRequest = {},
  ): Promise<PatternIndexCreateInviteResponse> {
    return this.#call("createInvite", { ...request });
  }

  /** Redeems an invite, making this client's key a new member's root. */
  redeemInvite(
    request: PatternIndexRedeemInviteRequest,
  ): Promise<PatternIndexMember> {
    return this.#call("redeemInvite", { ...request });
  }

  /** Makes this client's key its member's root, with the current root's consent. */
  moveRoot(request: PatternIndexMoveRootRequest): Promise<PatternIndexMember> {
    return this.#call("moveRoot", { ...request });
  }

  /** Points a member's root at a new key. Admin only. */
  moveMemberRoot(
    request: PatternIndexMoveMemberRootRequest,
  ): Promise<PatternIndexMember> {
    return this.#call("moveMemberRoot", { ...request });
  }

  /** Revokes a delegation in the caller's chains, or removes a legacy key. */
  revoke(
    request: PatternIndexRevokeRequest,
  ): Promise<PatternIndexRevokeResponse> {
    return this.#call("revoke", { ...request });
  }

  /** Admits a key as a new member. Admin only. */
  admitKey(request: PatternIndexAdmitKeyRequest): Promise<PatternIndexMember> {
    return this.#call("admitKey", { ...request });
  }

  /** Who this client's key acts as. */
  whoami(): Promise<PatternIndexMember> {
    return this.#call("whoami", {});
  }

  /** Hides a pattern from discovery, or shows it again. Admin only. */
  setPatternHidden(
    request: PatternIndexSetHiddenRequest,
  ): Promise<PatternIndexSetHiddenResponse> {
    return this.#call("setPatternHidden", { ...request });
  }

  /** Features or unfeatures a listed pattern. Admin only. */
  setPatternFeatured(
    request: PatternIndexSetFeaturedRequest,
  ): Promise<PatternIndexSetFeaturedResponse> {
    return this.#call("setPatternFeatured", { ...request });
  }

  /** The caller's lineages, newest head first. */
  listLineages(): Promise<PatternIndexListLineagesResponse> {
    return this.#call("listLineages", {});
  }

  /** Every version of one of the caller's lineages, newest first. */
  listVersions(
    request: { lineageId: string },
  ): Promise<PatternIndexListVersionsResponse> {
    return this.#call("listVersions", { ...request });
  }

  /** One of the caller's versions, with its source when asked. */
  getVersion(
    request: PatternIndexGetVersionRequest,
  ): Promise<PatternIndexVersion> {
    return this.#call("getVersion", { ...request });
  }

  /**
   * Makes an earlier version's source the lineage's head again, as a new
   * version; shared by the same rule as any update.
   */
  rollback(
    request: PatternIndexRollbackRequest,
  ): Promise<PatternIndexPublishResponse> {
    return this.#call("rollback", { ...request });
  }

  /**
   * Asks that one of the caller's versions be checked and shared anonymously,
   * on `channel` (stable when unsaid). On a source already shared, it moves
   * the channel: `stable` promotes the newest shared version, and is refused
   * (409 `not_newest`) for an older one.
   */
  shareVersion(
    request: { versionId: string; channel?: PatternIndexChannel },
  ): Promise<PatternIndexShareVersionResponse> {
    return this.#call("shareVersion", { ...request });
  }

  /** Names the caller as the author of one lineage, under their profile. */
  publishLineage(
    request: PatternIndexPublishLineageRequest,
  ): Promise<PatternIndexPublishLineageResponse> {
    return this.#call("publishLineage", {
      ...request,
      profileProof: [...request.profileProof],
    });
  }

  /**
   * Takes one of the caller's lineages out of listing and stops sharing it
   * on its own; what was exposed stays readable by id. A later
   * `shareVersion` shares it again.
   */
  unshareLineage(
    request: { lineageId: string },
  ): Promise<PatternIndexUnshareLineageResponse> {
    return this.#call("unshareLineage", { ...request });
  }

  /**
   * Deletes one of the caller's versions. A version already exposed stays
   * readable by id; one being checked to share is dropped.
   */
  deleteVersion(
    request: { versionId: string },
  ): Promise<PatternIndexDeleteVersionResponse> {
    return this.#call("deleteVersion", { ...request });
  }

  /**
   * Deletes one of the caller's lineages and its versions. Versions already
   * exposed stay readable by id, unlisted.
   */
  deleteLineage(
    request: { lineageId: string },
  ): Promise<PatternIndexDeleteLineageResponse> {
    return this.#call("deleteLineage", { ...request });
  }

  /** Stops naming the caller on a lineage from now on. */
  unpublishLineage(
    request: { lineageId: string },
  ): Promise<PatternIndexUnpublishLineageResponse> {
    return this.#call("unpublishLineage", { ...request });
  }

  /** The caller's give-to-get setting. */
  getSharingSettings(): Promise<PatternIndexSharingSettings> {
    return this.#call("getSharingSettings", {});
  }

  /** Changes the caller's give-to-get setting. */
  setSharingSettings(
    request: PatternIndexSetSharingSettingsRequest,
  ): Promise<PatternIndexSharingSettings> {
    return this.#call("setSharingSettings", { ...request });
  }
}
