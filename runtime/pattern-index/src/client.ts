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

import type { JSONSchema } from "@commonfabric/api";
import {
  type FirstPartyHttpSigner,
  signFirstPartyHttpRequest,
} from "@commonfabric/runner/toolshed-http-auth";
import { isObjectOrArray } from "@commonfabric/js-values/types";
import type { PatternIndexFetch } from "./http-fetch.ts";

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
 */
export type PatternIndexBucket = "featured" | "main" | "unvetted";

/**
 * Whether a pattern may be discovered. A new publication starts at
 * `not_requested`; its owner's listing request makes it `pending` while the
 * gardeners run; it is `passed` once every gate passed and `held` when one
 * did not. `error` means a gardener run failed and waits for an admin re-run.
 * Patterns the index held before listing existed are `grandfathered`.
 */
export type PatternIndexListing =
  | "not_requested"
  | "pending"
  | "passed"
  | "held"
  | "error"
  | "grandfathered";

/** One gardener's state on one pattern. */
export type PatternIndexGateStatus =
  | "pending"
  | "running"
  | "passed"
  | "failed"
  | "error";

/**
 * Something a gardener found. It names the problem without repeating the
 * value that caused it, so a finding is safe to show and store.
 */
export interface PatternIndexFinding {
  file?: string;
  line?: number;
  category: string;
  why: string;
}

/** A change a gardener suggests, such as lifting a constant into an argument. */
export interface PatternIndexGeneralization {
  category: string;
  suggestion: string;

  /** Index into the verdict's `findings` this suggestion answers. */
  finding?: number;
}

/** A gate gardener's latest verdict on a pattern. */
export interface PatternIndexGate {
  status: PatternIndexGateStatus;

  /** Increments on each admin re-run; a late run from an older attempt is ignored. */
  attempt: number;

  promptVersion?: string;
  findings?: readonly PatternIndexFinding[];
  generalizations?: readonly PatternIndexGeneralization[];
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
 * One event type's accumulated evidence for a lineage. Which fields are
 * present follows the type's declared aggregation; a day is `YYYY-MM-DD`.
 */
export interface PatternIndexAggregate {
  count?: number;
  distinctActors?: number;
  distinctActorDays?: number;
  lastSeenDay?: string;
}

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

  /** The author's stable pseudonym on this index. */
  handle?: string;

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

  /** The author's stable pseudonym on this index. */
  handle?: string;

  createdAt: string;
  description: string;
  hashtags: readonly string[];
  argumentSchema?: JSONSchema;
  resultSchema?: JSONSchema;
  dependencies: readonly string[];
  priorPatternId?: string;
  remixedFrom?: string;
  lineageId?: string;
  program?: PatternIndexProgram;

  /**
   * Whether the pattern is discoverable. `getPattern` serves a pattern by id
   * whatever its listing, so a direct link always works.
   */
  listing?: PatternIndexListing;

  /** Gate gardener verdicts by gardener name. */
  gates?: Readonly<Record<string, PatternIndexGate>>;
}

export interface PatternIndexGetRequest {
  patternId: string;
  includeSource?: boolean;
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

  /** The author's stable pseudonym on this index. */
  handle?: string;

  /** `null` for a pattern the index holds no creation time for. */
  createdAt: string | null;

  /** Event type to how many times it was recorded against this pattern. */
  events: Readonly<Record<string, number>>;

  /**
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
  listing?: PatternIndexListing;
  gates?: Readonly<Record<string, PatternIndexGate>>;
  lineageId?: string;
  aggregates?: Readonly<Record<string, PatternIndexAggregate>>;
  featured?: boolean;
}

/**
 * Which patterns to list. An unlisted pattern is returned only to its owner
 * and to admins.
 */
export interface PatternIndexListPatternsRequest {
  /** Only the caller's own patterns, including unlisted ones. */
  mine?: boolean;

  /** Only featured patterns. */
  featured?: boolean;
}

export interface PatternIndexListPatternsResponse {
  patterns: readonly PatternIndexListedPattern[];

  /** Event type to the weight `score` counts one of them at. */
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
  | "thumbs_down"
  // A person placed the pattern into a loom.
  | "deployed"
  // A person opened a loom holding a piece they placed. Only Loom sends it,
  // never a harness or agent run; from the author it promotes to `main`.
  | "viewed_in_loom"
  // A person removed such a piece.
  | "removed";

/** Signed event payload; the client supplies the author from its identity. */
export interface PatternIndexRecordEventRequest {
  patternId: string;
  eventType: PatternIndexEventType;

  /** Author DID, which the index must verify against the CF1 signer. */
  did: string;

  note?: string;
}

export interface PatternIndexRecordEventResponse {
  ok: boolean;
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

  /** Someone else's pattern this one was built from; credits it, inherits nothing. */
  remixedFrom?: string;

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
}

export interface PatternIndexPublishResponse {
  patternId: string;

  /** `false` when the index already held this identity, which is not an error. */
  created: boolean;
}

/** An owner's request that a pattern be considered for discovery. */
export interface PatternIndexRequestListingRequest {
  patternId: string;
}

/**
 * The listing state after the request. Over the caller's daily gardener cap
 * the index refuses with 429 and the time the cap resets, and the pattern
 * stays `not_requested`.
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
}

/** Redeems an invite; the signing key becomes the new member's root. */
export interface PatternIndexRedeemInviteRequest {
  inviteId: string;
  code: string;
}

/** Who the caller is to the index. */
export interface PatternIndexWhoamiResponse {
  handle: string;
  role: "admin" | "user";

  /** How many keys act as this member, the root included. */
  keys: number;
}

/**
 * Links the signing key to an existing member. `delegation` is a UCAN chain
 * text whose audience is the signing key and whose issuer is the member's
 * root, granting the `/index` command.
 */
export interface PatternIndexLinkKeyRequest {
  delegation: string;
}

/** An admin admits a key as a new member, invited by that admin. */
export interface PatternIndexAdmitKeyRequest {
  did: string;
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

  constructor(fn: string, status: number, detail?: string) {
    super(`pattern index ${fn} failed (${status})`);
    this.fn = fn;
    this.status = status;
    if (detail !== undefined) {
      this.detail = detail;
    }
  }
}

export interface PatternIndexClientOptions {
  baseUrl: string;
  fetchFn?: PatternIndexFetch;
  signer: FirstPartyHttpSigner;
}

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
   * answer does not parse as JSON — a body the caller cannot read is a
   * failure of the call rather than a result.
   */
  async #call<T>(fn: string, payload: Record<string, unknown>): Promise<T> {
    const url = functionUrl(this.#baseUrl, fn);
    // The proof commits to the body hash, so the bytes signed and the bytes
    // sent must be identical — serialize once.
    const body = JSON.stringify(payload);
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
    return await this.#readResponse<T>(fn, response);
  }

  /** Parses a service response while keeping its failure detail artifact-only. */
  async #readResponse<T>(fn: string, response: Response): Promise<T> {
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
      throw new PatternIndexError(fn, response.status, error);
    }
    if (parsed === undefined) {
      throw new PatternIndexError(
        fn,
        response.status,
        "answer was not JSON",
      );
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

  getPattern(request: PatternIndexGetRequest): Promise<PatternIndexPattern> {
    return this.#call<PatternIndexPattern>("getPattern", {
      patternId: request.patternId,
      ...(request.includeSource !== undefined
        ? { includeSource: request.includeSource }
        : {}),
    });
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
   * The calling identity's OWN events, newest first. The index answers each
   * signer with their own stream and nobody else's, so this is what a run made
   * of the index rather than what everyone made of it.
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

  publishPattern(
    request: PatternIndexPublishRequest,
  ): Promise<PatternIndexPublishResponse> {
    const schemas = {
      ...(request.argumentSchema !== undefined
        ? { argumentSchema: request.argumentSchema }
        : {}),
      ...(request.resultSchema !== undefined
        ? { resultSchema: request.resultSchema }
        : {}),
    };
    return this.#call<PatternIndexPublishResponse>("publishPattern", {
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
    });
  }

  /** Asks that an owned pattern be checked and, if it passes, listed. */
  requestListing(
    request: PatternIndexRequestListingRequest,
  ): Promise<PatternIndexRequestListingResponse> {
    return this.#call<PatternIndexRequestListingResponse>("requestListing", {
      patternId: request.patternId,
    });
  }

  /** Reads a gardener's prompt and output schema. */
  getGardenerPrompt(
    request: PatternIndexGardenerPromptRequest,
  ): Promise<PatternIndexGardenerPromptResponse> {
    return this.#call<PatternIndexGardenerPromptResponse>(
      "getGardenerPrompt",
      { name: request.name },
    );
  }

  /** Mints a single-use invite. Admin only. */
  createInvite(
    request: PatternIndexCreateInviteRequest = {},
  ): Promise<PatternIndexCreateInviteResponse> {
    return this.#call<PatternIndexCreateInviteResponse>("createInvite", {
      ...(request.ttlSeconds !== undefined
        ? { ttlSeconds: request.ttlSeconds }
        : {}),
    });
  }

  /** Redeems an invite, making this client's key a new member's root. */
  redeemInvite(
    request: PatternIndexRedeemInviteRequest,
  ): Promise<PatternIndexWhoamiResponse> {
    return this.#call<PatternIndexWhoamiResponse>("redeemInvite", {
      inviteId: request.inviteId,
      code: request.code,
    });
  }

  /** Links this client's key to the member whose root issued the delegation. */
  linkKey(request: PatternIndexLinkKeyRequest): Promise<PatternIndexWhoamiResponse> {
    return this.#call<PatternIndexWhoamiResponse>("linkKey", {
      delegation: request.delegation,
    });
  }

  /** Admits a key as a new member. Admin only. */
  admitKey(request: PatternIndexAdmitKeyRequest): Promise<PatternIndexWhoamiResponse> {
    return this.#call<PatternIndexWhoamiResponse>("admitKey", {
      did: request.did,
    });
  }

  /** Who this client's key acts as. */
  whoami(): Promise<PatternIndexWhoamiResponse> {
    return this.#call<PatternIndexWhoamiResponse>("whoami", {});
  }

  /** Features or unfeatures a listed pattern. Admin only. */
  setPatternFeatured(
    request: PatternIndexSetFeaturedRequest,
  ): Promise<PatternIndexSetFeaturedResponse> {
    return this.#call<PatternIndexSetFeaturedResponse>("setPatternFeatured", {
      patternId: request.patternId,
      featured: request.featured,
      ...(request.rank !== undefined ? { rank: request.rank } : {}),
      ...(request.note !== undefined ? { note: request.note } : {}),
    });
  }
}
