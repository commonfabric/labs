import {
  type VNode,
  type WishParams,
  type WishState,
  type WishTag,
} from "@commonfabric/api";
import { internSchema } from "@commonfabric/data-model-schema";
import {
  debugStr,
  type DebugValueOptions,
  toCompactDebugString,
} from "@commonfabric/data-model";
import { favoriteListSchema } from "@commonfabric/home-schemas";
import { type DID, isDID } from "@commonfabric/identity/did";
import type { MemorySpace } from "@commonfabric/memory/interface";
import { extractHashtags } from "@commonfabric/utils/hashtags";
import { getLogger } from "@commonfabric/utils/logger";
import { isObjectOrArray } from "@commonfabric/utils/types";

import { h } from "../builder/h.ts";
// The sidecar instantiation observes its wave settlement (a serving-wave
// commit can be withdrawn AFTER commit() resolves — runner.ts's pattern-swap
// settlement precedent) so a withdrawn one-shot is at least named.
import { waveSettlementOf } from "../executor/wave.ts";
import {
  type CellScope,
  type JSONSchema,
  NAME,
  type Pattern,
  UI,
} from "../builder/types.ts";
import { useCancelGroup } from "../cancel.ts";
import { type Cell } from "../cell.ts";
import {
  createSigilLinkFromParsedLink,
  toMemorySpaceAddress,
} from "../link-utils.ts";
import type { RawBuiltinResult } from "../module.ts";
import { systemPatternSource } from "../pattern-source-scheme.ts";
import { setRunnableName } from "../runner-utils.ts";
import { type Runtime, spaceCellSchema } from "../runtime.ts";
import { type Action, type ReactivityLog } from "../scheduler.ts";
import { RetryImmediately } from "../scheduler/retry-immediately.ts";
import { isCellScope, narrowestScope } from "../scope.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import {
  isConflictRejection,
  isStorageTransactionInconsistent,
} from "../storage/rejection.ts";
import { isCfcRejectedCommitError } from "../scheduler/cfc-rejection-report.ts";
import { schemaRegistryEpoch } from "../schema-registry.ts";
import {
  enrollRuntimeOwnedStore,
  recordRuntimeOwnedStore,
} from "./runtime-owned-store.ts";
import { scopedCell } from "./scope-policy.ts";
import {
  createDocumentReadiness,
  DocumentPending,
} from "../document-readiness.ts";
import { wishStateSchemaForResult } from "./wish-schema.ts";
import { setPatternCell, setResultCell } from "../result-utils.ts";

const wishFlowLogger = getLogger("runner.wish-flow", {
  enabled: true,
  level: "warn",
  logCountEvery: 0,
});

// Schema for mentionable array - items are cell references (asCell: ["cell"])
// Don't restrict properties so .get() returns full cell data
const mentionableListSchema = internSchema(
  {
    type: "array",
    items: {
      type: "object",
      properties: { [NAME]: { type: "string" } },
      asCell: ["cell"],
    },
  },
);

const profileElementListSchema = internSchema(
  {
    type: "array",
    items: {
      type: "object",
      properties: {
        cell: { type: "object", asCell: ["cell"] },
        tag: { type: "string" },
        userTags: {
          type: "array",
          items: { type: "string" },
        },
        title: { type: "string" },
        source: { type: "string" },
      },
    },
  },
);

// Schema for a list of profile links (the home `profiles` and `mru` lists). Each
// element is read as a cell *reference* (`asCell`), NOT its inlined value, so the
// list can be enumerated without deep-resolving every profile's own space. A
// plain `.get()` inlines each element and returns `undefined` for the whole list
// whenever any element is a link into a space not yet loaded in the reading
// context — e.g. a shared piece resolving `#profile` right after a profile was
// created in its own (`inSpace`) space. That collapsed the list to length 0 and
// hid the just-created profile behind the "No profile" / create surface.
//
// The item type is `unknown` (not `object`) on purpose: with `asCell`, an
// `object` item schema would trigger a *deep* sync of each linked profile —
// fetching its entire object graph and everything it transitively links, across
// space boundaries — just to count the list. `unknown` keeps the sync shallow
// (we only need the links here). The default profile's name is loaded lazily and
// targeted via `subscribeProfileName` once a candidate is selected.
const profileLinkListSchema = internSchema(
  {
    type: "array",
    items: { type: "unknown", asCell: ["cell"] },
  },
);

class WishError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WishError";
  }
}

/** A confirmed empty profile roster, for which Wish offers creation. */
class NoProfileError extends WishError {}

//
// Interval #now constants and helpers
//
// Bounds for #now/N intervals, specified in whole seconds. Values outside this
// range are rejected, not clamped. The 1-second minimum caps the sampling rate
// at 1Hz; the 24-hour maximum keeps the scheduled delay within the setTimeout
// range. Both serve as defense-in-depth against timing side-channel attacks once
// SES sandboxing removes patterns' direct access to Date.now/performance.now.
//

const MIN_INTERVAL_SECONDS = 1;
const MAX_INTERVAL_SECONDS = 24 * 60 * 60;
const ONE_SHOT_RESOLUTION_MS = 1000;

/**
 * Rendering options for a commit failure shown in a sidecar: strings and
 * objects whole, since the error's message can be an inconsistency report
 * whose tail is the difference it reports.
 */
const COMMIT_FAILURE_RENDER_OPTIONS: DebugValueOptions = {
  maxProperties: Infinity,
  maxStringLines: Infinity,
};

/**
 * Quantize timestamp to resolution boundary.
 *
 * Defense-in-depth: removes sub-second (or sub-interval) precision so that once
 * SES sandboxing blocks direct Date.now() access, patterns cannot use this
 * reactive time source for timing side-channel attacks.
 */
function coarsenTimestamp(nowMs: number, resolutionMs: number): number {
  return Math.floor(nowMs / resolutionMs) * resolutionMs;
}

export type ParsedWishTarget = {
  key: "/" | WishTag;
  path: string[];
};

function sanitizeQueryKey(query: string): string {
  const normalized = query.trim().replace(/[^a-zA-Z0-9#/_:-]+/g, "_");
  if (!normalized) return "empty";
  return normalized.slice(0, 80);
}

function recordWishPhaseTiming(
  startedAt: number,
  phase: string,
  queryKey?: string,
): number {
  const endedAt = performance.now();
  wishFlowLogger.time(startedAt, endedAt, "wish", "phase", phase);
  if (queryKey) {
    wishFlowLogger.time(
      startedAt,
      endedAt,
      "wish",
      "phase-query",
      phase,
      queryKey,
    );
  }
  return endedAt - startedAt;
}

function measureWishPhase<T>(
  phase: string,
  queryKey: string | undefined,
  fn: () => T,
): T {
  const startedAt = performance.now();
  try {
    return fn();
  } finally {
    recordWishPhaseTiming(startedAt, phase, queryKey);
  }
}

function getResolutionKind(parsed: ParsedWishTarget): string {
  switch (parsed.key) {
    case "/":
    case "#default":
    case "#mentionable":
    case "#summaryIndex":
    case "#knowledgeGraph":
    case "#pieceRegistry":
    case "#now":
      return "space-target";
    case "#favorites":
    case "#journal":
    case "#learned":
    case "#learnedSummary":
    case "#agent_queue":
    case "#profile":
    case "#profileName":
    case "#profileAvatar":
    case "#profileBio":
    case "#profileSpace":
      return "home-target";
    default:
      return "hashtag-search";
  }
}

export function parseWishTarget(target: string): ParsedWishTarget {
  const trimmed = target.trim();
  if (trimmed === "") {
    throw new WishError(`Wish target "${target}" is empty.`);
  }

  if (trimmed.startsWith("#")) {
    const segments = trimmed.slice(1).split("/").filter((segment) =>
      segment.length > 0
    );
    if (segments.length === 0) {
      throw new WishError(`Wish tag target "${target}" is not recognized.`);
    }
    const key = `#${segments[0]}` as WishTag;
    return { key, path: segments.slice(1) };
  }

  if (trimmed.startsWith("/")) {
    const segments = trimmed.split("/").filter((segment) => segment.length > 0);
    return { key: "/", path: segments };
  }

  throw new WishError(`Wish path target "${target}" is not recognized.`);
}

/**
 * Check if a tag string contains a hashtag matching the search term.
 * Extracts all #hashtags from the tag and checks for exact match.
 */
export function tagMatchesHashtag(
  tag: string | undefined,
  searchTermWithoutHash: string,
): boolean {
  if (tag === undefined) return false;
  return extractHashtags(tag).includes(searchTermWithoutHash);
}

type WishContext = {
  runtime: Runtime;
  readiness: ReturnType<typeof createDocumentReadiness>;
  tx: IExtendedStorageTransaction;
  parentCell: Cell<any>;
  spaceCell?: Cell<unknown>;
  scope?: ("~" | "." | "profile" | string)[];

  /** Cached #now cell to avoid non-idempotent re-runs from Date.now() */
  nowCell?: Cell<unknown>;

  /** The wish node's cause, keying the durable one-shot #now capture cell. */
  nowCause?: Cell<any>[];

  usedHomeSpace?: boolean;
};

type BaseResolution = {
  cell: Cell<unknown>;
  pathPrefix?: readonly string[];
  // When true, pathPrefix is the full path to resolve from cell.
  pathConsumed?: boolean;
};

type SharedHashtagState = {
  result?: Cell<unknown>;
  candidates: Cell<unknown>[];
  error?: unknown;
  [UI]?: VNode;
};

type SharedHashtagResolver = {
  cell: Cell<SharedHashtagState>;
  cancel: () => void;
  refCount: number;
};

const sharedHashtagResolvers = new WeakMap<
  Runtime,
  Map<string, SharedHashtagResolver>
>();

function getSpaceCell(ctx: WishContext): Cell<unknown> {
  if (!ctx.spaceCell) {
    ctx.spaceCell = ctx.runtime.getCell(
      ctx.parentCell.space,
      ctx.parentCell.space,
      spaceCellSchema,
      ctx.tx,
    );
  }
  return ctx.spaceCell;
}

function getSpaceCellForDID(
  runtime: Runtime,
  did: DID,
  tx: IExtendedStorageTransaction,
): Cell<unknown> {
  return runtime.getCell(did, did, spaceCellSchema, tx);
}

/**
 * The scope entries that name a space outright, as opposed to the three
 * keywords. Each one becomes a space to search, so an entry that is not a DID
 * would be read as the id of a space nobody named; say so instead.
 */
export function getArbitraryDIDs(scope?: string[]): DID[] {
  const named = (scope ?? []).filter((s) =>
    s !== "~" && s !== "." && s !== "profile"
  );
  for (const entry of named) {
    if (!isDID(entry)) {
      throw new WishError(
        `Invalid scope "${entry}": expected "~", ".", "profile", or a ` +
          `space DID.`,
      );
    }
  }
  return named as DID[];
}

function resolvePath(
  base: Cell<any>,
  path: readonly string[],
  ctx: Pick<WishContext, "readiness" | "tx">,
): Cell<unknown> {
  let current = base.resolveAsCell();
  ctx.readiness.requireDocument(current, ctx.tx);
  for (const segment of path) {
    current = current.key(segment).resolveAsCell();
    ctx.readiness.requireDocument(current, ctx.tx);
  }
  return current;
}

function buildResolutionPath(
  baseResolution: BaseResolution,
  parsedPath: readonly string[],
): readonly string[] {
  if (baseResolution.pathConsumed) {
    return baseResolution.pathPrefix ?? [];
  }
  return baseResolution.pathPrefix
    ? [...baseResolution.pathPrefix, ...parsedPath]
    : parsedPath;
}

function getHomeSpaceCell(ctx: WishContext): Cell<unknown> {
  ctx.usedHomeSpace = true;
  return ctx.runtime.getHomeSpaceCell(ctx.tx);
}

/**
 * The user whose HOME SPACE this wish resolution targets (server-execution
 * v2 Phase 5; builtins.md §5's per-demanding-identity wish resolution,
 * RULED 2026-08-14): the runtime's own user on a client (cardinality 1,
 * today's behavior), the RUN's demanding identity on a serving runtime —
 * NEVER the service identity (the lunch-wall trap: a served wish
 * materializing against the service home space). Undefined on a serving
 * runtime whose run carries no demanding principal; callers refuse with
 * a WishError.
 */
function homeSpaceUserDID(ctx: WishContext): string | undefined {
  return ctx.runtime.homeSpacePrincipalFor(ctx.tx);
}

/**
 * A profile link is valid when it resolves to a cell in another space (the
 * profile's own `inSpace` space) with an empty path. An unset link, or one that
 * still points into the home space, means the profile does not exist yet.
 */
function profileCellIsValid(
  cell: Cell<unknown>,
  rawIsSet: boolean,
  homeSpace: Cell<unknown>["space"],
): boolean {
  if (!rawIsSet) return false;
  const link = cell.getAsNormalizedFullLink();
  return link.space !== homeSpace && link.path.length === 0;
}

/**
 * Whether a `mru` / `defaultProfile` entry names the SAME profile as a candidate
 * from the home `profiles` list — compared by the profile's own SPACE, NOT by
 * `Cell.equals` or by entity id.
 *
 * CT-1842: the `#profile` ordering matches candidates (from `profiles`) against
 * the `defaultProfile` link and the `mru` list. Those name the same profiles but
 * reach them through DIFFERENT links. Two distinct differences defeat a naive
 * comparison, both observed on live data:
 *   - `scope` skew — `Cell.equals` (`areNormalizedLinksSame`) compares `scope`,
 *     which the two sides don't always agree on; and
 *   - DIFFERENT entity `id` — the `mru`/`defaultProfile` link and the `profiles`
 *     link for the SAME profile point at different cells WITHIN that profile's
 *     space (e.g. the picker stores the profile pattern's result cell while the
 *     list stores the pattern cell). So even id+space+path comparison fails.
 *
 * The stable per-profile identity is the profile's own SPACE. Each profile is a
 * distinct anonymous `ProfileHome.inSpace()` (see submitProfileCreation), whose
 * DID is unique per user AND per creation event, and `profileCellIsValid`
 * guarantees every valid candidate lives in its OWN non-home space. No two
 * distinct valid profiles ever share a space, so equal space ⇒ same profile.
 * Reading each cell's normalized link keeps the ordering reactive to
 * `mru`/`defaultProfile` changes.
 *
 * `homeSpace` guards the degenerate case: a `mru`/`defaultProfile` entry that
 * still resolves into the home space (an unmaterialized / invalid link) must
 * never match — candidates are never in the home space, but the guard makes the
 * intent explicit and defends against a future home-space candidate slipping in.
 */
function sameProfileCell(
  a: Cell<unknown>,
  b: Cell<unknown>,
  homeSpace: Cell<unknown>["space"],
): boolean {
  const spaceA = a.getAsNormalizedFullLink().space;
  const spaceB = b.getAsNormalizedFullLink().space;
  if (spaceA === homeSpace || spaceB === homeSpace) return false;
  return spaceA === spaceB;
}

/**
 * Subscribe to a profile cell's live name so the wish re-runs once a
 * freshly-created profile's name materializes across the space boundary.
 */
function subscribeProfileName(cell: Cell<unknown>): void {
  void cell.pull().catch((error) => {
    wishFlowLogger.warn("profile-pull", () => [
      "Failed to pull profile pattern",
      error,
    ]);
  });
  void cell.key("initialNameApplied").pull().catch((error) => {
    wishFlowLogger.warn("profile-name-pull", () => [
      "Failed to pull profile name",
      error,
    ]);
  });
  cell.key("initialNameApplied").get();
}

/**
 * Enumerate the user's profile candidate cells from the home `profiles` list,
 * ordered: default first, then by most-recently-used (MRU), then remaining list
 * order. Identity is by the profile's own SPACE — each profile is a distinct
 * `ProfileHome.inSpace()` space, so the `defaultProfile` / `mru` links are
 * matched to candidates by space, not `Cell.equals` (see `sameProfileCell`;
 * CT-1842). Skips confirmed-absent entries when a valid candidate remains.
 * Throws `DocumentPending` while backing documents load, and `WishError`
 * when absent entries leave no valid candidate.
 */
function getProfileCandidateCells(
  ctx: WishContext,
): { ordered: Cell<unknown>[]; defaultValid: boolean } {
  const homeSpaceCell = getHomeSpaceCell(ctx);
  // These checks gate loading; confirmed absence yields an empty roster below.
  ctx.readiness.requireDocument(homeSpaceCell, ctx.tx);
  const defaultPattern = homeSpaceCell.key("defaultPattern").resolveAsCell();
  ctx.readiness.requireDocument(defaultPattern, ctx.tx);
  const profilesCell = defaultPattern.key("profiles").resolveAsCell();
  ctx.readiness.requireDocument(profilesCell, ctx.tx);
  // Read the list as cell references so a freshly-created profile (a link into
  // its own space, not yet loaded here) is still counted rather than collapsing
  // the whole list to `undefined`. See profileLinkListSchema.
  const rawList = profilesCell.asSchema(profileLinkListSchema).get();
  const length = Array.isArray(rawList) ? rawList.length : 0;

  const candidates: Cell<unknown>[] = [];
  let hasAbsentProfile = false;
  for (let i = 0; i < length; i++) {
    const entry = profilesCell.key(i);
    const cell = entry.resolveAsCell();
    if (!ctx.readiness.requireDocument(cell, ctx.tx)) {
      hasAbsentProfile = true;
      continue;
    }
    if (
      !profileCellIsValid(
        cell,
        entry.getRaw() !== undefined,
        homeSpaceCell.space,
      )
    ) {
      continue;
    }
    subscribeProfileName(cell);
    candidates.push(cell);
  }
  if (candidates.length === 0) {
    if (hasAbsentProfile) throw new WishError("Profile data is unavailable");
    return { ordered: [], defaultValid: false };
  }

  // Ordering inputs: the default link and the MRU list.
  const defaultEntry = defaultPattern.key("defaultProfile");
  const defaultCell = defaultEntry.resolveAsCell();
  const defaultValid = profileCellIsValid(
    defaultCell,
    defaultEntry.getRaw() !== undefined,
    homeSpaceCell.space,
  );

  const mruCell = defaultPattern.key("mru");
  const mruRaw = mruCell.asSchema(profileLinkListSchema).get();
  const mruLength = Array.isArray(mruRaw) ? mruRaw.length : 0;
  const mruCells: Cell<unknown>[] = [];
  for (let j = 0; j < mruLength; j++) {
    mruCells.push(mruCell.key(j).resolveAsCell());
  }
  // Match by the profile's own space, not `Cell.equals` — see sameProfileCell.
  const homeSpace = homeSpaceCell.space;
  const mruRank = (cell: Cell<unknown>): number => {
    const idx = mruCells.findIndex((m) => sameProfileCell(m, cell, homeSpace));
    return idx === -1 ? Number.MAX_SAFE_INTEGER : idx;
  };

  const ordered = [...candidates];
  ordered.sort((a, b) => {
    if (defaultValid) {
      const aDef = sameProfileCell(defaultCell, a, homeSpace);
      const bDef = sameProfileCell(defaultCell, b, homeSpace);
      if (aDef && !bDef) return -1;
      if (bDef && !aDef) return 1;
    }
    return mruRank(a) - mruRank(b);
  });
  return { ordered, defaultValid };
}

/**
 * The user's default profile cell: the first ordered candidate (default link
 * when valid, else the most-recently-used / first profile). Throws when no
 * profile exists yet so callers can fall back to the create surface.
 */
function getDefaultProfileCell(ctx: WishContext): Cell<unknown> {
  const { ordered } = getProfileCandidateCells(ctx);
  if (ordered.length === 0) {
    throw new NoProfileError("No profile exists yet");
  }
  return ordered[0];
}

function getProfileSpaceCell(ctx: WishContext): Cell<unknown> {
  const profileDefaultCell = getDefaultProfileCell(ctx);
  const { space } = profileDefaultCell.getAsNormalizedFullLink();
  return getSpaceCellForDID(ctx.runtime, space, ctx.tx);
}

function isProfilePersonaTarget(parsed: ParsedWishTarget): boolean {
  return parsed.key === "#profile" && parsed.path.length === 0;
}

function formatTarget(parsed: ParsedWishTarget): string {
  return parsed.key +
    (parsed.path.length > 0 ? "/" + parsed.path.join("/") : "");
}

/**
 * Search favorites in home space for pieces matching a hashtag.
 */
function searchFavoritesForHashtag(
  ctx: WishContext,
  searchTermWithoutHash: string,
  pathPrefix: string[],
): BaseResolution[] {
  const queryKey = sanitizeQueryKey(`#${searchTermWithoutHash}`);
  const userDID = homeSpaceUserDID(ctx);
  if (!userDID) return [];

  const favoritesCell = measureWishPhase(
    "favorites-cell",
    queryKey,
    () => {
      const homeSpaceCell = getHomeSpaceCell(ctx);
      return resolvePath(homeSpaceCell, ["defaultPattern", "favorites"], ctx)
        .asSchema(favoriteListSchema);
    },
  );
  const favorites = measureWishPhase(
    "favorites-get",
    queryKey,
    () => favoritesCell.get() || [],
  );

  const matches = measureWishPhase(
    "favorites-filter",
    queryKey,
    () =>
      favorites.filter((entry) => {
        // Check userTags first (stored without # prefix)
        const userTags = entry.userTags ?? [];
        for (const t of userTags) {
          if (t.toLowerCase() === searchTermWithoutHash) return true;
        }
        // Match the discovery tags snapshotted when favorited.
        return (entry.tags ?? []).includes(searchTermWithoutHash);
      }),
  );

  return measureWishPhase(
    "favorites-result-map",
    queryKey,
    () => matches.map((match) => ({ cell: match.cell, pathPrefix })),
  );
}

/**
 * Search mentionables in current space for pieces matching a hashtag.
 * Waits for the index and candidate documents before choosing a result.
 */
function searchMentionablesForHashtag(
  ctx: WishContext,
  searchTermWithoutHash: string,
  pathPrefix: string[],
  spaceCell?: Cell<unknown>,
): BaseResolution[] {
  const queryKey = sanitizeQueryKey(`#${searchTermWithoutHash}`);
  const mentionableCell = measureWishPhase(
    "mentionable-cell",
    queryKey,
    () =>
      resolvePath(
        spaceCell ?? getSpaceCell(ctx),
        ["defaultPattern", "backlinksIndex", "mentionable"],
        ctx,
      ).asSchema(mentionableListSchema),
  );
  const raw = measureWishPhase(
    "mentionable-get",
    queryKey,
    () => mentionableCell.get(),
  );
  if (raw === undefined || raw === null) {
    return [];
  }
  const mentionables = (raw || []) as Cell<any>[];

  const matches = measureWishPhase(
    "mentionable-filter",
    queryKey,
    () =>
      mentionables.filter((pieceCell: Cell<any>) => {
        if (!pieceCell) return false;

        const piece = measureWishPhase(
          "mentionable-piece-get",
          queryKey,
          () => pieceCell.get(),
        );
        if (!piece) return false;

        // Check [NAME] field for exact match
        const nameMatches = measureWishPhase(
          "mentionable-name-check",
          queryKey,
          () => {
            const name = piece[NAME]?.toLowerCase() ?? "";
            return name === searchTermWithoutHash;
          },
        );
        if (nameMatches) return true;

        // Compute schema tag lazily from the cell
        let tag: string | undefined;
        try {
          const schema = measureWishPhase(
            "mentionable-schema",
            queryKey,
            () =>
              pieceCell.resolveAsCell()?.asSchema(undefined)
                .asSchemaFromLinks?.()?.schema,
          );
          if (typeof schema === "object") {
            tag = measureWishPhase(
              "mentionable-schema-stringify",
              queryKey,
              () => JSON.stringify(schema),
            );
          }
        } catch {
          // Schema not available yet
        }

        return measureWishPhase(
          "mentionable-tag-match",
          queryKey,
          () => tagMatchesHashtag(tag, searchTermWithoutHash),
        );
      }),
  );

  return measureWishPhase(
    "mentionable-result-map",
    queryKey,
    () => matches.map((match) => ({ cell: match, pathPrefix })),
  );
}

function searchProfileForHashtag(
  ctx: WishContext,
  searchTermWithoutHash: string,
  pathPrefix: string[],
): BaseResolution[] {
  const queryKey = sanitizeQueryKey(`#${searchTermWithoutHash}`);
  const elementsCell = measureWishPhase(
    "profile-elements-cell",
    queryKey,
    () =>
      resolvePath(getDefaultProfileCell(ctx), ["elements"], ctx)
        .asSchema(profileElementListSchema),
  );
  const elements = measureWishPhase(
    "profile-elements-get",
    queryKey,
    () => elementsCell.get(),
  );
  if (elements === undefined || elements === null) {
    return [];
  }

  const profileElements = elements as Array<{
    cell?: Cell<unknown>;
    tag?: string;
    userTags?: string[];
  }>;

  const matches = measureWishPhase(
    "profile-elements-filter",
    queryKey,
    () =>
      profileElements.filter((entry) => {
        const userTags = entry.userTags ?? [];
        for (const t of userTags) {
          if (t.toLowerCase() === searchTermWithoutHash) return true;
        }
        return tagMatchesHashtag(entry.tag, searchTermWithoutHash);
      }),
  );

  return measureWishPhase(
    "profile-elements-result-map",
    queryKey,
    () =>
      matches.flatMap((match) =>
        match.cell ? [{ cell: match.cell, pathPrefix }] : []
      ),
  );
}

/**
 * Search for pieces by hashtag across favorites and/or mentionables based on scope.
 * Publishes only after every searched scope's backing documents have loaded.
 */
function searchByHashtag(
  parsed: ParsedWishTarget,
  ctx: WishContext,
): BaseResolution[] {
  const searchTerm = parsed.key.toLowerCase();
  const searchTermWithoutHash = searchTerm.slice(1);

  // Determine what to search based on scope
  // Default (no scope) = favorites only for backward compatibility
  const searchFavorites = !ctx.scope || ctx.scope.includes("~");
  const searchMentionables = ctx.scope?.includes(".");
  const searchProfile = ctx.scope?.includes("profile");

  const allMatches: BaseResolution[] = [];

  if (searchFavorites) {
    allMatches.push(
      ...searchFavoritesForHashtag(ctx, searchTermWithoutHash, parsed.path),
    );
  }

  if (searchMentionables) {
    const matches = searchMentionablesForHashtag(
      ctx,
      searchTermWithoutHash,
      parsed.path,
    );
    allMatches.push(...matches);
  }

  if (searchProfile) {
    const matches = searchProfileForHashtag(
      ctx,
      searchTermWithoutHash,
      parsed.path,
    );
    allMatches.push(...matches);
  }

  // Search mentionables in arbitrary DID spaces
  const arbitraryDIDs = getArbitraryDIDs(ctx.scope);
  for (const did of arbitraryDIDs) {
    const didSpaceCell = getSpaceCellForDID(ctx.runtime, did, ctx.tx);
    const matches = searchMentionablesForHashtag(
      ctx,
      searchTermWithoutHash,
      parsed.path,
      didSpaceCell,
    );
    allMatches.push(...matches);
  }

  if (allMatches.length === 0) {
    const parts: string[] = [];
    if (searchFavorites) parts.push("favorites");
    if (searchMentionables) parts.push("mentionables");
    if (searchProfile) parts.push("profile");
    if (arbitraryDIDs.length > 0) {
      parts.push(`${arbitraryDIDs.length} space(s)`);
    }
    const scopeDesc = parts.join(" or ") || "favorites";
    throw new WishError(`No ${scopeDesc} found matching "${searchTerm}"`);
  }

  return allMatches;
}

/**
 * Resolve well-known targets that map to home space paths.
 */
function resolveHomeSpaceTarget(
  parsed: ParsedWishTarget,
  ctx: WishContext,
): BaseResolution[] | null {
  switch (parsed.key) {
    case "#favorites": {
      const userDID = homeSpaceUserDID(ctx);
      if (!userDID) {
        throw new WishError("User identity DID not available for #favorites");
      }
      const homeSpaceCell = getHomeSpaceCell(ctx);

      // No path = return favorites list
      if (parsed.path.length === 0) {
        return [{
          cell: homeSpaceCell,
          pathPrefix: ["defaultPattern", "favorites"],
        }];
      }

      // Path provided = search by tag (legacy behavior)
      const searchTerm = parsed.path[0].toLowerCase();
      const favoritesCell = resolvePath(
        homeSpaceCell,
        ["defaultPattern", "favorites"],
        ctx,
      ).asSchema(favoriteListSchema);
      const favorites = favoritesCell.get() || [];

      const match = favorites.find((entry) => {
        const userTags = entry.userTags ?? [];
        for (const t of userTags) {
          if (t.toLowerCase().includes(searchTerm)) return true;
        }

        // Match the discovery tags snapshotted when favorited.
        return (entry.tags ?? []).some((t) => t.includes(searchTerm));
      });

      if (!match) {
        throw new WishError(`No favorite found matching "${searchTerm}"`);
      }

      return [{
        cell: match.cell,
        pathPrefix: parsed.path.slice(1),
        pathConsumed: true,
      }];
    }

    case "#journal": {
      const userDID = homeSpaceUserDID(ctx);
      if (!userDID) {
        throw new WishError("User identity DID not available for #journal");
      }
      return [{
        cell: getHomeSpaceCell(ctx),
        pathPrefix: ["defaultPattern", "journal"],
      }];
    }

    case "#learned": {
      const userDID = homeSpaceUserDID(ctx);
      if (!userDID) {
        throw new WishError("User identity DID not available for #learned");
      }
      return [{
        cell: getHomeSpaceCell(ctx),
        pathPrefix: ["defaultPattern", "learned"],
      }];
    }

    case "#agent_queue": {
      // The user's agent queue: the index of their agent runs and their
      // registered runner. A hashtag search would not find it, since under
      // `scope: ["~"]` that search reads the user's favorites only.
      const userDID = homeSpaceUserDID(ctx);
      if (!userDID) {
        throw new WishError(
          "User identity DID not available for #agent_queue",
        );
      }
      return [{
        cell: getHomeSpaceCell(ctx),
        pathPrefix: ["defaultPattern", "agentQueue"],
      }];
    }

    case "#learnedSummary": {
      // The free-form learned summary string (home `learned.summary`). This is
      // what `#profile` used to resolve to before it was repurposed for the
      // profile default pattern object; summary consumers wish for this instead.
      const userDID = homeSpaceUserDID(ctx);
      if (!userDID) {
        throw new WishError(
          "User identity DID not available for #learnedSummary",
        );
      }
      return [{
        cell: getHomeSpaceCell(ctx),
        pathPrefix: ["defaultPattern", "learned", "summary"],
      }];
    }

    case "#profile": {
      const userDID = homeSpaceUserDID(ctx);
      if (!userDID) {
        throw new WishError("User identity DID not available for #profile");
      }
      const { ordered } = getProfileCandidateCells(ctx);
      if (ordered.length === 0) {
        // No profile yet — throw so the #profile error path falls back to the
        // create surface (see profileCreateUI).
        throw new NoProfileError("No profile exists yet");
      }
      // Always expose the full, ordered roster as `candidates`. The wish action
      // below still makes `ordered[0]` the current profile and only renders the
      // picker when no valid default exists. Keeping the roster here is important
      // for identity-only consumers such as ProfileHome's owner edit gate.
      return ordered.map((cell) => ({ cell, pathPrefix: [] }));
    }

    case "#profileName": {
      // The live name (`initialNameApplied`) of the default profile. Tracks
      // edits made via the profile's setName handler.
      const profileDefault = getDefaultProfileCell(ctx);
      return [{ cell: profileDefault, pathPrefix: ["initialNameApplied"] }];
    }

    case "#profileAvatar": {
      return [{
        cell: getDefaultProfileCell(ctx),
        pathPrefix: ["avatar"],
      }];
    }

    case "#profileBio": {
      // The owner-authored free-text bio of the default profile (CT-1648).
      // Tracks edits made via the profile's setBio handler.
      return [{
        cell: getDefaultProfileCell(ctx),
        pathPrefix: ["bio"],
      }];
    }

    case "#profileSpace": {
      return [{
        cell: getProfileSpaceCell(ctx),
        pathPrefix: [],
      }];
    }

    default:
      return null;
  }
}

/**
 * A shared interval #now timer: one ticking cell plus the timer that advances
 * it, reference-counted across the wish instances using it.
 */
type IntervalNowTimer = {
  cell: Cell<number>;
  timerId: ReturnType<typeof setTimeout> | undefined;
  // Bumped when the timer is torn down, so in-flight ticks become no-ops.
  generation: number;
  refCount: number;
};

// Per-runtime registry of interval #now timers, keyed by space and interval.
// All wish instances in one runtime requesting the same interval share a single
// timer and ticking cell, so re-runs and extra instances do not multiply timers.
const intervalNowTimers = new WeakMap<
  Runtime,
  Map<string, IntervalNowTimer>
>();

function getRuntimeIntervalNowTimers(
  runtime: Runtime,
): Map<string, IntervalNowTimer> {
  let timers = intervalNowTimers.get(runtime);
  if (!timers) {
    timers = new Map();
    intervalNowTimers.set(runtime, timers);
  }
  return timers;
}

function intervalNowTimerKey(space: MemorySpace, intervalMs: number): string {
  return `${space}\x00${intervalMs}`;
}

// Write the current coarsened timestamp into the shared cell unless it is
// already current. Runs in its own retrying transaction so that when several
// tabs tick at once the first commit wins and the rest become no-ops.
function writeIntervalNowTick(
  runtime: Runtime,
  timer: IntervalNowTimer,
  intervalMs: number,
): void {
  const generation = timer.generation;
  const cell = timer.cell;
  void runtime.editWithRetry((tx) => {
    if (generation !== timer.generation) return; // torn down, skip
    // Pure timer write (setTimeout — no scheduler run stamps it):
    // bookkeeping per serving-loop.md §3d, RULED 2026-08-05, so a
    // serving runtime's wave admits the tick instead of refusing the
    // unstamped seal. No-op off the serving posture.
    runtime.stampServerRun(tx, {
      actionId: `wish/interval-now-tick/${cell.sourceURI}`,
      kind: "bookkeeping",
    });
    const coarsened = coarsenTimestamp(Date.now(), intervalMs);
    const current = cell.withTx(tx).get() as number | null | undefined;
    if (current == null || current !== coarsened) {
      cell.withTx(tx).set(coarsened);
    }
  }).then(({ error }) => {
    if (!error) return;
    // The generation is what a refusal answers for. A tick armed before the
    // beat was torn down or restarted speaks for a generation that is gone,
    // so it reports what it dropped and leaves the timer alone: stopping
    // there would take down a beat this tick was never part of.
    if (isCfcRejectedCommitError(error) && generation === timer.generation) {
      // CFC enforcement refused the labels this transaction carries, and the
      // instant being written has no part in that verdict, so the next tick
      // would carry the same labels to the same cell for the same answer.
      // The beat stops here rather than schedule one refused write per
      // interval; the next acquire of this interval starts a fresh one.
      //
      // The other two rejections the vocabulary calls terminal leave the
      // beat running. Each is terminal for its own transaction rather than
      // for a writer that runs again later: a `SpeculativeBasisError` names
      // the next derivation as its recovery, and a `RowLabelCommitError`
      // reads server state a later tick may find changed.
      stopIntervalNowTimer(timer);
      console.error(
        "[wish] #now interval tick refused; the tick is stopped:",
        error,
      );
      return;
    }
    console.error("[wish] #now interval tick failed:", error);
  });
}

// Stop a timer's beat. Clearing the pending timeout drops a tick that has not
// fired; bumping the generation makes one that has fired a no-op. A cleared
// `timerId` is also what marks the timer as not beating, which is what an
// acquire reads to decide whether to start one.
function stopIntervalNowTimer(timer: IntervalNowTimer): void {
  clearTimeout(timer.timerId);
  timer.timerId = undefined;
  timer.generation++;
}

// Schedule the next tick on a wall-clock-aligned boundary, so patterns cannot
// choose a phase offset to correlate timing with other operations.
function scheduleIntervalNowTick(
  runtime: Runtime,
  timer: IntervalNowTimer,
  intervalMs: number,
): void {
  const now = Date.now();
  const nextBoundary = (Math.floor(now / intervalMs) + 1) * intervalMs;
  const delay = nextBoundary - now;
  const generation = timer.generation;
  timer.timerId = setTimeout(() => {
    if (generation !== timer.generation) return; // torn down
    writeIntervalNowTick(runtime, timer, intervalMs);
    scheduleIntervalNowTick(runtime, timer, intervalMs);
  }, delay);
}

function acquireIntervalNowTimer(
  runtime: Runtime,
  space: MemorySpace,
  intervalMs: number,
  tx: IExtendedStorageTransaction,
): IntervalNowTimer {
  const timers = getRuntimeIntervalNowTimers(runtime);
  const key = intervalNowTimerKey(space, intervalMs);
  let timer = timers.get(key);
  if (!timer) {
    // Content-addressed by interval, so all instances in the same space with
    // the same interval share one cell.
    const cell = runtime.getCell<number>(
      space,
      { wish: { now: true, interval: intervalMs } },
      undefined,
      tx,
    );
    timer = { cell, timerId: undefined, generation: 0, refCount: 0 };
    timers.set(key, timer);
  }

  if (timer.timerId === undefined) {
    // Nothing is beating this cell — a timer just minted, or one a refused
    // tick stopped. Initialize the value if the cell is empty or stale (e.g.
    // after reload, or after a stop the grid moved on from), then start the
    // aligned timer. sample() reads without subscribing the acquiring
    // action, so ticks never re-trigger it.
    const coarsened = coarsenTimestamp(Date.now(), intervalMs);
    const existing = timer.cell.withTx(tx).sample() as
      | number
      | null
      | undefined;
    if (existing == null) {
      timer.cell.withTx(tx).set(coarsened);
    } else if (existing !== coarsened) {
      writeIntervalNowTick(runtime, timer, intervalMs);
    }
    scheduleIntervalNowTick(runtime, timer, intervalMs);
  }
  timer.refCount++;
  return timer;
}

function releaseIntervalNowTimer(
  runtime: Runtime,
  space: MemorySpace,
  intervalMs: number,
): void {
  const timers = intervalNowTimers.get(runtime);
  const key = intervalNowTimerKey(space, intervalMs);
  const timer = timers?.get(key);
  if (!timer) return;

  timer.refCount--;
  if (timer.refCount > 0) return;

  // Last user gone: stop the recurring timer and drop the registry entry so an
  // unused interval no longer consumes resources. The durable cell (one small
  // value per distinct interval per space, possibly shared with other tabs) is
  // left in place; deleting it would race a re-acquire of the same
  // content-addressed cell and could blank another tab still ticking it.
  stopIntervalNowTimer(timer);
  timers!.delete(key);
}

/** The interval #now timer a wish() instance currently holds. */
type IntervalNowState = {
  cell: Cell<number> | undefined;
  intervalMs: number; // 0 = none held
  cancelRegistered: boolean;
};

/**
 * Handle interval #now — a timer subscription, not a cell resolution.
 *
 * Called before the resolution pipeline. Returns true if the target was an
 * interval #now (and has been fully handled), false otherwise.
 *
 * The interval rides in the path slot (#now/N, N a whole number of seconds in
 * base ten), reusing the convention #favorites already uses for parsed.path[0].
 * No parser or WishParams changes are needed.
 */
function handleIntervalNow(
  parsed: ParsedWishTarget,
  state: IntervalNowState,
  ctx: WishContext,
  sendResult: (tx: IExtendedStorageTransaction, result: unknown) => void,
  addCancel: (cancel: () => void) => void,
): boolean {
  if (parsed.key !== "#now" || parsed.path.length === 0) {
    // The wish navigated away from an interval #now (to the one-shot #now or a
    // different query). Drop the shared interval timer we were holding so it can
    // stop ticking once no instance wants it, instead of waiting for teardown.
    if (state.intervalMs !== 0) {
      releaseIntervalNowTimer(
        ctx.runtime,
        ctx.parentCell.space,
        state.intervalMs,
      );
      state.intervalMs = 0;
      state.cell = undefined;
    }
    return false;
  }

  if (parsed.path.length > 1) {
    throw new WishError(
      `Wish now target "${formatTarget(parsed)}" is not recognized.`,
    );
  }

  const intervalStr = parsed.path[0];
  if (!/^[0-9]+$/.test(intervalStr)) {
    throw new WishError(
      `Wish now interval "${intervalStr}" must be a whole number of ` +
        `seconds in base ten.`,
    );
  }
  const seconds = Number.parseInt(intervalStr, 10);
  if (seconds < MIN_INTERVAL_SECONDS || seconds > MAX_INTERVAL_SECONDS) {
    throw new WishError(
      `Wish now interval "${intervalStr}" must be between ` +
        `${MIN_INTERVAL_SECONDS} and ${MAX_INTERVAL_SECONDS} seconds.`,
    );
  }
  const intervalMs = seconds * 1000;

  // Acquire the shared timer for this (space, interval), releasing the
  // previously-held one when the interval changes.
  if (state.intervalMs !== intervalMs) {
    if (state.intervalMs !== 0) {
      releaseIntervalNowTimer(
        ctx.runtime,
        ctx.parentCell.space,
        state.intervalMs,
      );
    }
    const timer = acquireIntervalNowTimer(
      ctx.runtime,
      ctx.parentCell.space,
      intervalMs,
      ctx.tx,
    );
    state.cell = timer.cell;
    state.intervalMs = intervalMs;
  }

  if (!state.cancelRegistered) {
    addCancel(() => {
      if (state.intervalMs !== 0) {
        releaseIntervalNowTimer(
          ctx.runtime,
          ctx.parentCell.space,
          state.intervalMs,
        );
        state.intervalMs = 0;
        state.cell = undefined;
      }
    });
    state.cancelRegistered = true;
  }

  // The action does not read the ticking cell — the timer owns it — so ticks
  // do not re-trigger this action; consumers of the result cell still react.
  const resultCell = state.cell!;
  const candidatesCell = ctx.runtime.getImmutableCell(
    ctx.parentCell.space,
    [resultCell],
    undefined,
    ctx.tx,
  );
  sendResult(ctx.tx, {
    result: resultCell,
    candidates: candidatesCell,
  });
  return true;
}

/**
 * Resolve well-known targets that map to current space paths.
 */
function resolveSpaceTarget(
  parsed: ParsedWishTarget,
  ctx: WishContext,
): BaseResolution[] | null {
  // #now is special — not scope-dependent.
  if (parsed.key === "#now") {
    // Interval #now is handled by handleIntervalNow() before resolveBase.
    if (parsed.path.length > 0) return null;

    // One-shot #now captures the load time ONCE and keeps it, durably. The value
    // lives in a per-instance content-addressed cell (keyed by the wish node's
    // cause), written only when the cell is still empty — so re-instantiating the
    // piece (a stop/start, or a reload in another runtime) reads the first-ever
    // captured time instead of re-reading the clock and jumping forward. sample()
    // reads without subscribing the resolving action, so the write does not
    // re-trigger it. The per-instance closure cache (ctx.nowCell) just avoids
    // re-fetching the cell on every sync re-run within one instantiation.
    if (!ctx.nowCell) {
      const cell = ctx.runtime.getCell(
        ctx.parentCell.space,
        { wish: { nowOneShot: ctx.nowCause } },
        undefined,
        ctx.tx,
      );
      recordRuntimeOwnedStore(ctx.tx, ctx.parentCell, cell);
      enrollRuntimeOwnedStore(ctx.tx, ctx.parentCell, cell);
      const existing = cell.withTx(ctx.tx).sample();
      if (existing == null) {
        cell.withTx(ctx.tx).set(
          coarsenTimestamp(Date.now(), ONE_SHOT_RESOLUTION_MS),
        );
      }
      ctx.nowCell = cell;
    }
    return [{ cell: ctx.nowCell }];
  }

  const pathForKey: Record<string, readonly string[]> = {
    "/": [],
    "#default": ["defaultPattern"],
    "#mentionable": ["defaultPattern", "backlinksIndex", "mentionable"],
    "#summaryIndex": ["defaultPattern", "summaryIndex"],
    "#knowledgeGraph": ["defaultPattern", "knowledgeGraph"],

    "#suggestions": ["defaultPattern", "suggestionHistory"],
  };

  const registryTarget = parsed.key === "#pieceRegistry";
  const pathPrefix = pathForKey[parsed.key];
  if (!registryTarget && !pathPrefix) return null;

  const resolutionFor = (spaceCell: Cell<unknown>): BaseResolution => {
    if (!registryTarget) {
      return { cell: spaceCell, pathPrefix: [...pathPrefix!] };
    }

    return {
      cell: spaceCell,
      pathPrefix: ["defaultPattern", "pieceRegistry"],
    };
  };

  const results: BaseResolution[] = [];

  // "." or no scope → include current space (backward compat)
  if (!ctx.scope || ctx.scope.includes(".")) {
    results.push(resolutionFor(getSpaceCell(ctx)));
  }

  // "~" → include home space
  if (ctx.scope?.includes("~") && homeSpaceUserDID(ctx) !== undefined) {
    const homeSpaceCell = getHomeSpaceCell(ctx);
    results.push(resolutionFor(homeSpaceCell));
  }

  // Arbitrary DIDs → include each space
  for (const did of getArbitraryDIDs(ctx.scope)) {
    const didSpaceCell = getSpaceCellForDID(ctx.runtime, did, ctx.tx);
    results.push(resolutionFor(didSpaceCell));
  }

  if (results.length === 0) {
    console.warn(
      `[wish] Target "${parsed.key}" cannot resolve with scope: [${
        ctx.scope?.join(", ")
      }]`,
    );
    return null;
  }

  return results;
}

/**
 * Main resolution function - dispatches to appropriate resolver based on target type.
 *
 * Resolution paths:
 * 1. Well-known space targets (/, #default, #mentionable, #pieceRegistry,
 *    #now)
 * 2. Well-known home space targets (#favorites, #journal, #learned, #profile)
 * 3. Hashtag search (arbitrary #tags in favorites/mentionables)
 *
 * Returns at least one resolution or throws a pending-load or resolution error.
 */
function resolveBase(
  parsed: ParsedWishTarget,
  ctx: WishContext,
): BaseResolution[] {
  try {
    // Try space targets first (most common)
    const spaceResult = resolveSpaceTarget(parsed, ctx);
    if (spaceResult) return spaceResult;

    // Try home space targets
    const homeResult = resolveHomeSpaceTarget(parsed, ctx);
    if (homeResult) return homeResult;

    // Hashtag search
    if (parsed.key.startsWith("#")) {
      return searchByHashtag(parsed, ctx);
    }

    throw new WishError(`Wish target "${parsed.key}" is not recognized.`);
  } finally {
    ctx.readiness.requireLoadedReads(ctx.tx);
  }
}

function isSharedHashtagSearchTarget(parsed: ParsedWishTarget): boolean {
  if (!parsed.key.startsWith("#")) return false;
  return getResolutionKind(parsed) === "hashtag-search";
}

function canUseSharedHashtagResult(
  parsed: ParsedWishTarget,
  options: { headless?: boolean },
): boolean {
  return isSharedHashtagSearchTarget(parsed) &&
    options.headless === true;
}

function sharedHashtagResolverKey(
  parentSpace: string,
  parsed: ParsedWishTarget,
  scope?: ("~" | "." | "profile" | string)[],
): string {
  return JSON.stringify({
    space: parentSpace,
    query: formatTarget(parsed),
    scope: scope ?? null,
  });
}

function getRuntimeSharedHashtagResolvers(
  runtime: Runtime,
): Map<string, SharedHashtagResolver> {
  let resolvers = sharedHashtagResolvers.get(runtime);
  if (!resolvers) {
    resolvers = new Map();
    sharedHashtagResolvers.set(runtime, resolvers);
  }
  return resolvers;
}

function createSharedHashtagResolver(
  ctx: WishContext,
  parsed: ParsedWishTarget,
): SharedHashtagResolver {
  const sharedParsed: ParsedWishTarget = {
    key: parsed.key,
    path: [...parsed.path],
  };
  const sharedScope = ctx.scope ? [...ctx.scope] : undefined;
  const query = formatTarget(sharedParsed);
  const sharedCell = ctx.runtime.getCell<SharedHashtagState>(
    ctx.parentCell.space,
    {
      wish: {
        kind: "hashtag",
        space: ctx.parentCell.space,
        scope: sharedScope ?? null,
        query,
      },
    },
    undefined,
    ctx.tx,
  );

  const [cancel, addCancel] = useCancelGroup();
  const readiness = createDocumentReadiness(ctx.runtime, addCancel);
  const action: Action = (tx: IExtendedStorageTransaction) => {
    const sharedContext: WishContext = {
      runtime: ctx.runtime,
      readiness,
      tx,
      parentCell: ctx.parentCell,
      scope: sharedScope,
    };
    const actionStartedAt = performance.now();
    const stateCell = sharedCell.withTx(tx);
    const queryKey = sanitizeQueryKey(query);
    try {
      const baseResolutions = resolveBase(sharedParsed, sharedContext);

      const resultCells = measureWishPhase(
        "shared-resolve-paths",
        queryKey,
        () =>
          baseResolutions.map((baseResolution) => {
            const combinedPath = buildResolutionPath(
              baseResolution,
              sharedParsed.path,
            );
            return resolvePath(
              baseResolution.cell,
              combinedPath,
              sharedContext,
            );
          }),
      );
      const uniqueResultCells = measureWishPhase(
        "shared-dedupe-results",
        queryKey,
        () =>
          resultCells.filter(
            (cell, index) =>
              resultCells.findIndex((candidate) => candidate.equals(cell)) ===
                index,
          ),
      );
      const resultUI = measureWishPhase(
        "shared-result-ui-get",
        queryKey,
        () => uniqueResultCells[0].key(UI).get(),
      ) as VNode | undefined;

      stateCell.set({
        result: uniqueResultCells[0],
        candidates: uniqueResultCells,
        [UI]: resultUI ?? cellLinkUI(uniqueResultCells[0]),
      });
    } catch (error) {
      if (error instanceof DocumentPending) return;
      const errorMessage = error instanceof Error
        ? error.message
        : String(error);
      stateCell.set({
        result: undefined,
        candidates: [],
        error: errorMessage,
        [UI]: errorUI(errorMessage),
      });
    } finally {
      recordWishPhaseTiming(
        actionStartedAt,
        "shared-action-total",
        queryKey,
      );
    }
  };
  const actionName = `wish:hashtag:${ctx.parentCell.space}:${query}`;
  setRunnableName(action, actionName, { setSrc: true });
  Object.assign(action, {
    writes: [sharedCell.getAsNormalizedFullLink()],
  });

  const initialLog: ReactivityLog = {
    reads: [],
    shallowReads: [],
    writes: [toMemorySpaceAddress(sharedCell.getAsNormalizedFullLink())],
  };
  readiness.onActionRegistered(action);
  addCancel(ctx.runtime.scheduler.subscribe(action, initialLog));

  return { cell: sharedCell, cancel, refCount: 0 };
}

function acquireSharedHashtagResolver(
  ctx: WishContext,
  parsed: ParsedWishTarget,
): SharedHashtagResolver {
  const key = sharedHashtagResolverKey(ctx.parentCell.space, parsed, ctx.scope);
  const resolvers = getRuntimeSharedHashtagResolvers(ctx.runtime);
  let resolver = resolvers.get(key);
  if (!resolver) {
    resolver = createSharedHashtagResolver(ctx, parsed);
    resolvers.set(key, resolver);
  }
  resolver.refCount++;
  return resolver;
}

function releaseSharedHashtagResolver(runtime: Runtime, key: string): void {
  const resolvers = sharedHashtagResolvers.get(runtime);
  const resolver = resolvers?.get(key);
  if (!resolver) return;

  resolver.refCount--;
  if (resolver.refCount > 0) return;

  resolver.cancel();
  resolvers?.delete(key);
}

/**
 * A surface the wish builtin instantiates: a pattern this deployment's
 * toolshed serves, which the surface's piece records as its source origin.
 *
 * Nothing else knows where such a piece's code comes from. The runtime is what
 * brings the piece into being, so the runtime is what claims its provenance —
 * and once it is claimed, the surface is an ordinary piece whose source the
 * ordinary lifecycle follows, rather than one kept current by a mechanism of
 * its own.
 */
type SidecarSurface = {
  /** The `system:` origin the surface's piece records. */
  readonly origin: string;

  /** The file the origin names. Labels errors. */
  readonly name: string;
};

function sidecarSurface(name: string): SidecarSurface {
  return { name, origin: systemPatternSource(`system/${name}`) };
}

const SUGGESTION_SURFACE = sidecarSurface("suggestion.tsx");
const PROFILE_CREATE_SURFACE = sidecarSurface("profile-create.tsx");
const PROFILE_PICKER_SURFACE = sidecarSurface("profile-picker.tsx");

/**
 * What one wish node holds about a surface it instantiates: the pattern that
 * surface's piece runs, and the open still answering that question.
 *
 * A compiled pattern's serialized graph embeds `cid:` schema references minted
 * in the registry epoch that compiled it (`externalizeSchema` at binding
 * serialization), and both backings of those references die with that epoch:
 * the registry clears on last-lease-out, and the compile context's space is not
 * the next session's. A pattern held across the clear would stage links whose
 * references nothing anywhere can resolve — the emission gate throws on exactly
 * that shape — so a pattern is only reused inside the epoch that produced it,
 * and the next launch opens the surface again.
 */
export type SidecarSurfaceState = {
  pattern?: Pattern;
  patternEpoch?: number;
  opening?: Promise<Pattern | undefined>;
  openingEpoch?: number;
};

/** The pattern this slot has already opened, when it is still usable. */
export function openedSidecarSurface(
  state: SidecarSurfaceState,
): Pattern | undefined {
  return state.patternEpoch === schemaRegistryEpoch()
    ? state.pattern
    : undefined;
}

/**
 * Open a surface's piece and answer with the pattern it runs.
 *
 * Opening is what a piece gets when somebody looks at it: the runtime resolves
 * the origin that piece records, adopts the source it names when the deployment
 * has shipped a new version, and answers with what to run. A piece that does
 * not exist yet is answered with the source its origin currently names, which
 * the run then records as its creation revision.
 *
 * Once per slot, because that is what one look is. The wish node behind a
 * surface re-runs whenever anything it reads changes, and a piece is not opened
 * again by each of those.
 *
 * `retryOnFailure` decides what a launch that could not open the surface leaves
 * behind. The profile surfaces retry, because a user with no profile has no
 * other way to get one and nothing else re-triggers their launch. The
 * suggestion surface keeps its failure: it is an addition to a view that
 * already works.
 */
export function openSidecarSurface(
  runtime: Runtime,
  state: SidecarSurfaceState,
  piece: Cell<unknown>,
  surface: SidecarSurface,
  options: { retryOnFailure?: boolean } = {},
): Promise<Pattern | undefined> {
  const opened = openedSidecarSurface(state);
  if (opened !== undefined) return Promise.resolve(opened);
  const epoch = schemaRegistryEpoch();
  // An open started in an epoch that has since ended would answer with a
  // pattern whose schema references nothing can resolve, so it is left to
  // settle on its own and a fresh one is asked instead.
  if (state.opening !== undefined && state.openingEpoch === epoch) {
    return state.opening;
  }
  const opening: Promise<Pattern | undefined> = runtime.sourceReconciler
    .open(piece, surface.origin)
    .then((pattern) => {
      // An open answers about the registry epoch it ran in. Once that epoch has
      // ended — because a later launch replaced this open, or because the
      // registry simply cleared while it was in flight — the pattern it
      // resolved carries `cid:` schema references that resolve to nothing, and
      // running it would stage links nothing anywhere can resolve. So ask
      // again, in the epoch that will use the answer: a launch that has already
      // started one joins it, and otherwise a fresh one starts here. The
      // caller is handed a live answer either way, rather than a dead one or an
      // error account written over a surface still on its way.
      if (epoch !== schemaRegistryEpoch()) {
        return openSidecarSurface(runtime, state, piece, surface, options);
      }
      if (pattern !== undefined) {
        state.pattern = pattern;
        state.patternEpoch = epoch;
        state.opening = undefined;
      } else {
        console.error(`Can't load ${surface.name}`);
        if (options.retryOnFailure) state.opening = undefined;
      }
      return pattern;
    });
  state.opening = opening;
  state.openingEpoch = epoch;
  return opening;
}

/** What a failed sidecar instantiation attempt does next — the OW45
 * discrimination, shared verbatim by the commit-error arm and the
 * thrown-error arm of `runSidecarInOwnTx` (a thrown conflict is the same
 * object shape as a commit-refused one, so one function decides both):
 *
 * - a CONFLICT-CLASS failure (`ConflictError` /
 *   `StorageTransactionInconsistent`) with the result cell already
 *   materialized means a racing sibling instantiation won → `"yield"`
 *   (never clobber the winner with an error UI — the OW45
 *   profile-starvation defect);
 * - a conflict-class failure with the cell still EMPTY means an INPUT doc
 *   moved under the run (no winner exists) → `"retry"` against fresh
 *   state while attempts remain — abandoning the only instantiation
 *   leaves the surface permanently blank;
 * - anything else — and the bounded-retry terminal — → `"error-ui"`, the
 *   surface's loud account of why it never came up. The winner probe is
 *   consulted ONLY for conflict-class failures: the real-failure path
 *   performs no reads.
 *
 * Exported for the unit half of `wish-sidecar-duplicate-launch.test.ts`:
 * the thrown arm is not deterministically drivable through the public
 * flow (it needs a third-party write between a transaction's snapshot
 * and its own reads), so the discrimination itself is pinned here and
 * each arm reduces to a mechanical consume.
 */
export async function sidecarRunFailureDisposition(
  error: { name?: string } | undefined | null,
  winnerPresent: () => Promise<boolean> | boolean,
  lastAttempt: boolean,
): Promise<"yield" | "retry" | "error-ui"> {
  if (isConflictRejection(error) || isStorageTransactionInconsistent(error)) {
    if (await winnerPresent()) return "yield";
    if (!lastAttempt) return "retry";
  }
  return "error-ui";
}

/** Whether a sidecar result cell's raw value is a RACING WINNER a
 * conflict-class loser may yield to. An error ACCOUNT written by
 * `commitPatternErrorUI` is NOT a winner (Cubic P2 on the review round:
 * yielding to a stale error account makes the surface permanently red and
 * defeats the heal path) — it carries the `sidecarError` marker for exactly
 * this discrimination. Exported for the unit pin. */
export function sidecarValueIsWinner(raw: unknown): boolean {
  if (raw === undefined) return false;
  return !(isObjectOrArray(raw) && "sidecarError" in raw);
}

// Test seam (this package has no logger-capture idiom — the OW45 register's
// F9 note): process-global counts of sidecar launch activity, so a pin that
// must WITNESS a duplicate launch can assert it happened instead of passing
// vacuously when a timing window closes early. Monotonic; consumers compare
// deltas, never absolutes.
export const wishSidecarDiagnostics = {
  /** Opens of a profile-create surface (one per launch that found no pattern
   * already opened — the duplicate-launch producer). */
  profileCreateSurfaceOpens: 0,

  /** runSidecarInOwnTx invocations (instantiation attempts). */
  sidecarRunsStarted: 0,

  /** Conflict-class losers that yielded to a materialized winner. */
  sidecarRunsRaced: 0,
};

function errorUI(message: string): VNode {
  return h("span", { style: "color: red" }, `⚠️ ${message}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cellLinkUI(cell: Cell<unknown>): VNode {
  return h("cf-cell-link", { $cell: cell });
}

function wishResultUI(
  parsed: ParsedWishTarget,
  resultCell: Cell<unknown>,
): VNode | undefined {
  if (isProfilePersonaTarget(parsed)) {
    return cellLinkUI(resultCell);
  }
  return resultCell.key(UI).get() as VNode | undefined;
}

function projectWishCellValue(
  cell: Cell<unknown>,
  schema: unknown,
): unknown {
  if (schema === undefined) return cell;
  return cell.asSchema(schema as JSONSchema).getAsLink({ includeSchema: true });
}

function createWishCandidatesCell(
  runtime: Runtime,
  space: Cell<unknown>["space"],
  candidates: Cell<unknown>[],
  schema: unknown,
  tx: IExtendedStorageTransaction,
): Cell<unknown> {
  const values = schema === undefined
    ? candidates
    : candidates.map((candidate) => projectWishCellValue(candidate, schema));
  return runtime.getImmutableCell(space, values, undefined, tx);
}

function explicitWishSchemaScope(schema: unknown): CellScope | undefined {
  if (
    schema &&
    typeof schema === "object" &&
    "scope" in schema &&
    isCellScope((schema as { scope?: unknown }).scope)
  ) {
    return (schema as { scope: CellScope }).scope;
  }
  return undefined;
}

function wishOutputScope(
  schema: unknown,
  inputScope: CellScope,
  usesHomeSpace: boolean,
): CellScope {
  const explicitScope = explicitWishSchemaScope(schema);
  if (explicitScope) return explicitScope;
  if (usesHomeSpace) {
    return narrowestScope([inputScope, "user"]);
  }
  return inputScope;
}

/**
 * Whether a settled wish-state commit failure deserves the error surface
 * (verification-coverage OW50, seat S-J). Excluded, because re-running
 * converges them and a red surface would race the converged state:
 * - conflict-class rejections (stale basis) and local inconsistencies — the
 *   scheduler re-queues the action against fresh state;
 * - deliberate control-flow aborts: `RetryImmediately` (an `inSpace("name")`
 *   target just resolved; the scheduler aborts THIS transaction and
 *   immediately re-runs the action, which then lands the good state — a red
 *   error over that is the repair-manufactures-failure shape).
 * Everything else — the CFC-modeled refusals and genuine crash-backstop
 * aborts — surfaces.
 */
export function isSurfacableWishCommitFailure(
  error: { name?: string; reason?: unknown },
): boolean {
  if (isConflictRejection(error) || isStorageTransactionInconsistent(error)) {
    return false;
  }
  if (
    error.name === "StorageTransactionAborted" &&
    (error as { reason?: unknown }).reason instanceof RetryImmediately
  ) {
    return false;
  }
  return true;
}

/**
 * The text the wish surface shows for a settled commit failure: the
 * informative layer, not the debug dump. A plain abort's own message is the
 * generic "Transaction was aborted" — the cause rides `reason` — while a
 * CFC-modeled rejection carries everything in `message`.
 */
export function wishCommitFailureMessage(
  error: { message?: string; reason?: unknown },
): string {
  const message = typeof error.message === "string" ? error.message : "";
  if (message !== "" && !message.startsWith("Transaction was aborted")) {
    return message;
  }
  const reason = (error as { reason?: unknown }).reason;
  if (reason instanceof Error && reason.message !== "") {
    return reason.message;
  }
  if (message !== "") return message;
  return toCompactDebugString(error);
}

export function wishTargetMayUseHomeSpace(
  query: unknown,
  scope?: ("~" | "." | "profile" | string)[],
): boolean {
  if (typeof query !== "string") {
    return scope?.includes("~") === true ||
      scope?.includes("profile") === true;
  }

  let parsed: ParsedWishTarget;
  try {
    parsed = parseWishTarget(query);
  } catch {
    return false;
  }

  const kind = getResolutionKind(parsed);
  if (kind === "home-target") return true;
  if (scope?.includes("~") || scope?.includes("profile")) return true;
  return kind === "hashtag-search" && scope === undefined;
}

function sharedWishCellValue(
  cell: Cell<SharedHashtagState>,
  schema: unknown,
): unknown {
  const wishStateSchema = wishStateSchemaForResult(schema);
  if (!wishStateSchema) return cell;
  return cell.asSchema(wishStateSchema).getAsLink({ includeSchema: true });
}

const TARGET_SCHEMA = internSchema(
  {
    type: "object",
    properties: {
      query: { type: "string" },
      path: { type: "array", items: { type: "string" } },
      schema: true,
      context: { type: "object", additionalProperties: { asCell: ["cell"] } },
      scope: { type: "array", items: { type: "string" } },
      headless: { type: "boolean" },
    },
    required: ["query"],
  },
);

/** Resolves a wish and re-arms profile resolution after pending document loads. */
export function wish(
  inputsCell: Cell<[unknown, unknown]>,
  sendResult: (tx: IExtendedStorageTransaction, result: unknown) => void,
  addCancel: (cancel: () => void) => void,
  cause: Cell<any>[],
  parentCell: Cell<any>,
  runtime: Runtime,
): RawBuiltinResult {
  let cancelled = false;
  const readiness = createDocumentReadiness(runtime, addCancel);
  // Per-instance cached #now cell — prevents non-idempotent re-runs from
  // Date.now() producing a different value each time the sync action fires.
  let nowCell: Cell<unknown> | undefined;
  let sharedHashtagKey: string | undefined;
  // Per-instance interval #now state
  const nowState: IntervalNowState = {
    cell: undefined,
    intervalMs: 0,
    cancelRegistered: false,
  };

  // Per-instance sidecar state, keyed by the HOME-SPACE user (the F2
  // fix, builtins.md §5's per-demanding-identity wish resolution): the
  // scheduler drives ONE singular wish node once per demanded instance
  // (same Action closure, per-instance stamped txs), so on a serving
  // runtime two demanders reach these caches through one closure. A
  // single cached cell/input made demander #2 reuse demander #1's
  // sidecar result cell and clobber the shared pending input —
  // cross-user mixing in both directions. Each demanding identity gets
  // its own slot; the slot key is the SAME expression the sidecar cell
  // causes key on (`homeSpaceUserDID(ctx) ?? runtime.userIdentityDID`),
  // so cells and closure state can never disagree. Clients stay
  // cardinality 1 (one slot: the runtime's own user).
  interface SuggestionSidecarSlot extends SidecarSurfaceState {
    input?: {
      situation: string;
      context: Record<string, any>;
      initialResults?: unknown;
    };
    resultCell?: Cell<WishState<any>>;
  }
  interface ProfileCreateSidecarSlot extends SidecarSurfaceState {
    input?: {
      profiles: unknown;
      inputId: string;
      buttonId: string;
    };
    resultCell?: Cell<any>;
    readyCell?: Cell<boolean>;
  }
  interface ProfilePickerSidecarSlot extends SidecarSurfaceState {
    input?: {
      profiles: unknown;
      defaultProfile: unknown;
      mru: unknown;
    };
    resultCell?: Cell<any>;
  }
  const suggestionSidecars = new Map<string, SuggestionSidecarSlot>();
  const profileCreateSidecars = new Map<string, ProfileCreateSidecarSlot>();
  const profilePickerSidecars = new Map<string, ProfilePickerSidecarSlot>();
  const slotFor = <T>(map: Map<string, T>, user: string, empty: () => T): T => {
    let slot = map.get(user);
    if (slot === undefined) {
      slot = empty();
      map.set(user, slot);
    }
    return slot;
  };
  // Server-execution v2 (Phase 7; builtins.md §3, §5): a wish's sidecar
  // surfaces — the profile create/picker patterns and the suggestion
  // pattern — are compile-INSTANTIATE steps (fetch a system pattern, run
  // it into a deterministic result cell). Under the flag those belong to
  // the SpaceServer: the served wish run for the demanding identity
  // fetches, instantiates and commits the sidecar (bookkeeping stamps,
  // serving-loop.md §3d), and the client's SPECULATIVE wish run only
  // REFERENCES the same cell — cause-derived, so both sides name one
  // doc — and renders whatever the server materialized (speculation.md
  // §2: compile-instantiate children stay unspeculated; the client reads
  // through). Pre-fix a flag-ON client also fetched + instantiated the
  // sidecar through its own bookkeeping-stamped (authored) commits,
  // racing the server's derived commits on the SAME docs — the
  // lunch-gate churn (a stale-basis rejection loop on the readers of
  // those cells, ~13 wish re-runs/s, no settle). OFF arm and the serving
  // runtime: unchanged.
  const sidecarIsServed = runtime.experimental.serverExecution === true &&
    !runtime.servingPosture;
  // The sidecar's DEMAND-ROOT CHAIN (server-execution v2 fan-out stage B,
  // design §B4 + the panel's Lens 5; the P7 review's finding 4 for the
  // list builtins): a sidecar piece is instantiated by THIS wish's run
  // with its own result doc as piece root, which no client watches — a
  // served sidecar's own actions therefore resolved NO demanders and fell
  // to the wave-level (service) identity, and the per-demander demand
  // walk could not reach a per-user wish child. Chaining the sidecar to
  // the wish's owning piece (`RunnerRunOptions.parentPieceRootId`, as
  // map/filter/flatMap do) makes its actions demanded through the OUTER
  // root the client watches — a served `#profile` create surface's nodes
  // run as demanders. Off the serving posture the chain is inert (the run
  // supply consults nothing there). FLAGGED, not filled: the sidecar's
  // instance SET is the chain's demanders (every principal demanding the
  // outer root), not only the demander the sidecar was minted for
  // (`sidecarUser`) — a sibling's instance runs of a per-user sidecar's
  // narrowed nodes are inert (nobody reads them) but not free; pinning a
  // per-demander sidecar to exactly its own demander is an unstated
  // semantic recorded in the register (OW29's row).
  // `sourceOrigin` is the surface's own provenance, recorded with the creation
  // revision of the piece this run brings into being. A run that finds the
  // piece already there changes neither, so what a surface records after that
  // is decided by its source lifecycle.
  const sidecarRunOptions = (surface: SidecarSurface) => ({
    parentPieceRootId: parentCell.getAsNormalizedFullLink().id,
    sourceOrigin: surface.origin,
    // A sidecar the wish instantiates, in a continuation of its action, is
    // no principal's act.
    attributeInitialization: false,
  });

  addCancel(() => {
    cancelled = true;
    releaseCurrentSharedHashtagResolver();
    for (const slot of suggestionSidecars.values()) {
      if (slot.resultCell) runtime.runner.stop(slot.resultCell);
    }
    for (const slot of profileCreateSidecars.values()) {
      if (slot.resultCell) runtime.runner.stop(slot.resultCell);
    }
    for (const slot of profilePickerSidecars.values()) {
      if (slot.resultCell) runtime.runner.stop(slot.resultCell);
    }
  });

  function releaseCurrentSharedHashtagResolver(): void {
    if (!sharedHashtagKey) return;
    releaseSharedHashtagResolver(runtime, sharedHashtagKey);
    sharedHashtagKey = undefined;
  }

  function getCurrentSharedHashtagResolver(
    ctx: WishContext,
    parsed: ParsedWishTarget,
  ): SharedHashtagResolver {
    const nextKey = sharedHashtagResolverKey(
      ctx.parentCell.space,
      parsed,
      ctx.scope,
    );
    const existing = sharedHashtagResolvers.get(runtime)?.get(nextKey);
    if (nextKey === sharedHashtagKey && existing) return existing;

    releaseCurrentSharedHashtagResolver();
    const resolver = acquireSharedHashtagResolver(ctx, parsed);
    sharedHashtagKey = nextKey;
    return resolver;
  }

  function sendWishState(
    tx: IExtendedStorageTransaction,
    value: unknown,
    outputScope: CellScope,
    schema: unknown,
  ): void {
    const baseCell = runtime.getCell(
      parentCell.space,
      { wish: { state: cause } },
      wishStateSchemaForResult(schema),
      tx,
    );
    const scoped = scopedCell(runtime, tx, baseCell, outputScope);
    recordRuntimeOwnedStore(tx, parentCell, scoped);
    enrollRuntimeOwnedStore(tx, parentCell, scoped);
    setResultCell(scoped, parentCell.withTx(tx));
    setPatternCell(scoped, parentCell.withTx(tx).key("pattern"));
    scoped.set(value);
    surfaceWishStateCommitFailure(tx, scoped);
    sendResult(tx, scoped);
  }

  // Transactions that already carry the wish-state failure observer — one
  // callback per action tx, however many sendWishState calls it makes.
  const wishFailureObservedTxs = new WeakSet<IExtendedStorageTransaction>();
  // One in-flight failure-UI write per state doc: the scheduler retries a
  // refused wish action (bounded), and each retry's failure observer would
  // otherwise start its own surfacing write racing the others on the same
  // doc and the same fields.
  const wishFailureUIInFlight = new Set<string>();

  /**
   * Surface a failed wish-state commit in the wish UI (verification-coverage
   * OW50, seat S-J). The wish action's own writes — including any error state
   * the body wrote — die with a refused transaction, so until now a killed
   * wish left its surface silently never-mounted (the served-wish shape:
   * commit-prep refuses the /result envelope, first-on-ci-gate.md row 3).
   * A commit callback observes the settled failure and writes the reason
   * where the wish UI belongs, in a fresh bookkeeping transaction.
   *
   * Conflict-class rejections (stale basis / local inconsistency) are NOT
   * surfaced: the scheduler re-runs the action against fresh state and
   * convergence is the norm — an error surface there would flash noise.
   */
  function surfaceWishStateCommitFailure(
    tx: IExtendedStorageTransaction,
    stateCell: Cell<any>,
  ): void {
    if (wishFailureObservedTxs.has(tx)) return;
    wishFailureObservedTxs.add(tx);
    const link = stateCell.getAsNormalizedFullLink();
    // The failed run's demand-supplied identity (a served per-instance run
    // stamps it on its transaction; clients and the OFF arm carry none): the
    // error write must land in the SAME scoped instance the failed writes
    // aimed at, not the service's own.
    const scopeIdentity = tx.scopeKeyIdentity;
    tx.addCommitCallback((_tx, result) => {
      if (!result.error) return;
      if (!isSurfacableWishCommitFailure(result.error)) return;
      const message = wishCommitFailureMessage(result.error);
      // Keyed per scoped INSTANCE: scope and identity separate user/session
      // instances of one doc id, so one demander's in-flight report cannot
      // hide another's failure.
      const inFlightKey = `${link.space}/${link.scope ?? "space"}/${
        scopeIdentity?.principal ?? ""
      }:${scopeIdentity?.sessionId ?? ""}/${link.id}`;
      if (wishFailureUIInFlight.has(inFlightKey)) return;
      wishFailureUIInFlight.add(inFlightKey);
      // Deliberately NOT `scheduler.trackBackgroundTask` (unlike the sidecar
      // launches below): quiescence waits on tracked tasks, and this chain
      // must wait on quiescence — its conflict retries wait out the refused
      // action's own bounded re-runs (which write the same doc) before
      // re-deriving the error state, so tracking it would deadlock
      // `runtime.idle()` against itself, and retrying without that wait
      // collides with the action's retries until both budgets exhaust. The
      // cost is bounded and benign: `idle()` can resolve a beat before the
      // error surface lands, and the surface still arrives on the doc's
      // ordinary change notification.
      void commitWishFailureUI(link, message, scopeIdentity)
        .catch((surfacingError) => {
          // The surfacing must never become a new unhandled failure itself
          // (e.g. a raw write refused on a doc that never materialized).
          console.error(
            `Can't report "${message}" in the surface it belongs to`,
            surfacingError,
          );
        })
        .finally(() => {
          wishFailureUIInFlight.delete(inFlightKey);
        });
    });
  }

  /**
   * Write `{error, [UI]}` into the wish state doc in its own committed
   * bookkeeping transaction, presenting the two fields it writes and nothing
   * else. The commit it reports was refused with the whole wish-state
   * envelope in play, and that envelope is the document's stored one.
   *
   * Bounded retries for the transient classes only: a stale-basis conflict
   * or a local inconsistency converges when re-run against settled state —
   * unlike a policy refusal, which would repeat identically and is reported
   * instead. (The previous error-report path treated every failure as the
   * repeating kind and gave up after one attempt — the
   * "Can't report … in the surface it belongs to" /
   * StorageTransactionInconsistent follow-on OW50 names: the transient
   * classes are exactly the ones a fresh transaction CAN land.)
   */
  async function commitWishFailureUI(
    stateLink: ReturnType<Cell<any>["getAsNormalizedFullLink"]>,
    message: string,
    scopeIdentity?: IExtendedStorageTransaction["scopeKeyIdentity"],
    attempt = 0,
  ): Promise<void> {
    const errorTx = runtime.edit();
    // Async error surfacing after the originating wish tx is gone — no
    // scheduler run stamps it; bookkeeping per serving-loop.md §3d. The
    // failed run's demand-supplied identity rides along so the stamper
    // resolves the scoped error write against the DEMANDER's instance, not
    // the service's (clients pass none — unchanged).
    runtime.stampServerRun(errorTx, {
      actionId: `wish/commit-failure-ui/${stateLink.id}`,
      kind: "bookkeeping",
      ...(scopeIdentity !== undefined
        ? { scopeKeyIdentity: scopeIdentity }
        : {}),
    });
    const { schema: _schema, ...bareLink } = stateLink;
    // One field of the report: the value, and the schema it is authored
    // against, written and named together.
    //
    // The write is a raw value rather than a cell write, which would record
    // the document's STORED schema as this write's candidate envelope.
    //
    // A value write reaching a path the stored label map reaches is refused
    // unless something names the schema it was authored against. A resolved
    // wish whose result carries no `[UI]` of its own emits a `cf-cell-link`
    // there, and that link persists a label entry under `[UI]/props/$cell`,
    // so on such a document `[UI]` is one of those paths.
    //
    // The schema named is `true`, which is what the wish-state schema says
    // at both paths. It declares nothing, so a stored claim at either path
    // is not checked against this write; and a candidate declaring nothing
    // is covered by whatever the document has stored, which keeps the report
    // out of the schema merge.
    //
    // The requirement is decided per document rather than per path. What
    // bounds the report is this transaction: it is created here, carries
    // these two writes and no others, and the transaction whose refusal it
    // reports is a separate one that has already settled.
    const report = (
      path: readonly string[],
      value: Parameters<IExtendedStorageTransaction["writeValueOrThrow"]>[1],
    ) => {
      errorTx.writeValueOrThrow({ ...bareLink, path }, value);
      errorTx.recordCfcWritePolicyInput({
        kind: "schema",
        target: {
          space: stateLink.space,
          id: stateLink.id,
          scope: stateLink.scope,
          path,
        },
        schema: true,
      });
    };
    report([...stateLink.path, "error"], message);
    report(
      [...stateLink.path, UI],
      errorUI(message) as unknown as Parameters<
        IExtendedStorageTransaction["writeValueOrThrow"]
      >[1],
    );
    runtime.prepareTxForCommit(errorTx);
    const { error } = await errorTx.commit();
    if (error === undefined) return;
    if (
      attempt < 2 &&
      (isConflictRejection(error) || isStorageTransactionInconsistent(error))
    ) {
      // Let the conflicting writers settle — including the refused action's
      // own bounded re-runs against this doc — then re-derive the error
      // state on a fresh transaction. This wait is why the chain must stay
      // untracked (see the launch site above).
      await runtime.idle();
      return commitWishFailureUI(
        stateLink,
        message,
        scopeIdentity,
        attempt + 1,
      );
    }
    // The account of the failure failed to land, so the surface stays blank
    // and this is the only place the reason exists.
    console.error(
      `Can't report "${message}" in the surface it belongs to`,
      error,
    );
  }

  /**
   * Counts a sidecar pattern's deferred launch — the fetch, and the run that
   * follows it — as outstanding scheduler work.
   *
   * A wish emits a sidecar's surface into the view before the pattern behind it
   * exists: the `[UI]` it sends is a `cf-render` bound to a result cell that
   * only the launch fills. Between the send and the landing the scheduler has
   * nothing to run, so without this the runtime reports itself idle while a
   * surface the page is about to grow is still on its way. Anything read off
   * the layout in that window is read off a page that has not finished
   * arriving — a click point most of all, since content appearing above a
   * control moves it out from under the point the click was aimed at.
   */
  function trackSidecarLaunch(launch: Promise<unknown>): void {
    runtime.scheduler.trackBackgroundTask(launch);
  }

  /** Whether this demander's suggestion surface has already been opened. */
  function suggestionSurfaceOpened(ctx: WishContext): boolean {
    const slot = suggestionSidecars.get(
      homeSpaceUserDID(ctx) ?? runtime.userIdentityDID,
    );
    return slot !== undefined && openedSidecarSurface(slot) !== undefined;
  }

  function launchSuggestionPattern(
    ctx: WishContext,
    input: {
      situation: string;
      context: Record<string, any>;
      initialResults?: unknown;
    },
    providedTx?: IExtendedStorageTransaction,
  ) {
    // Per-demanding-identity slot (the F2 fix; see the slot map above).
    const sidecarUser = homeSpaceUserDID(ctx) ?? runtime.userIdentityDID;
    const slot = slotFor(
      suggestionSidecars,
      sidecarUser,
      (): SuggestionSidecarSlot => ({}),
    );
    slot.input = input;
    const tx = providedTx || runtime.edit();

    if (!slot.resultCell) {
      slot.resultCell = runtime.getCell(
        parentCell.space,
        {
          wish: {
            suggestionPattern: cause,
            situation: input.situation,
            // The F2 fix's suggestion half (pre-existing gap: this cause
            // carried NO user key): on a SERVING runtime the cell keys
            // by the demanding identity, so two demanders never share a
            // suggestion cell. Clients keep the pre-existing cause
            // byte-identical (cardinality 1 — re-keying would orphan
            // every persisted client suggestion cell for no gain).
            ...(runtime.servingPosture ? { user: sidecarUser } : {}),
          },
        },
        undefined,
        tx,
      );
    }

    const openedSuggestionPattern = openedSidecarSurface(slot);
    if (sidecarIsServed) {
      // The SpaceServer instantiates the suggestion sidecar for this
      // demander; this speculative run references its cell only.
    } else if (!openedSuggestionPattern) {
      // Once the surface opens, run the pattern without a tx (it creates its own)
      const launch = openSidecarSurface(
        runtime,
        slot,
        slot.resultCell,
        SUGGESTION_SURFACE,
      ).then(
        (pattern) => {
          if (!cancelled && pattern && slot.resultCell) {
            runtime.runner.run(
              undefined,
              pattern,
              slot.input,
              slot.resultCell,
              sidecarRunOptions(SUGGESTION_SURFACE),
            );
          }
        },
      );
      trackSidecarLaunch(launch);
    } else {
      if (!cancelled && slot.resultCell) {
        runtime.runner.run(
          tx,
          openedSuggestionPattern,
          slot.input,
          slot.resultCell,
          sidecarRunOptions(SUGGESTION_SURFACE),
        );
      }
    }

    if (!providedTx) {
      runtime.prepareTxForCommit(tx);
      tx.commit();
    }

    return slot.resultCell;
  }

  // Renders an error message into a pattern result cell in its own committed
  // transaction. Used when a deferred system-pattern run fails after the
  // originating wish transaction has already gone.
  async function commitPatternErrorUI(
    resultCell: Cell<any>,
    message: string,
  ): Promise<void> {
    const errorTx = runtime.edit();
    // Async error surfacing after the originating wish tx is gone — no
    // scheduler run stamps it; bookkeeping per serving-loop.md §3d.
    runtime.stampServerRun(errorTx, {
      actionId: `wish/pattern-error-ui/${resultCell.sourceURI}`,
      kind: "bookkeeping",
    });
    // The `sidecarError` marker is the winner predicate's discriminator
    // (sidecarValueIsWinner): a conflict-class loser must never yield to
    // this account as if it were a materialized surface.
    resultCell.withTx(errorTx).set({
      [UI]: errorUI(message),
      sidecarError: message,
    });
    runtime.prepareTxForCommit(errorTx);
    const { error } = await errorTx.commit();
    // The account of the failure failed to land, so the surface stays blank
    // and this is the only place the reason exists. Writing it again would
    // meet whatever refused it the first time.
    if (error) {
      console.error(
        `Can't report "${message}" in the surface it belongs to`,
        error,
      );
    }
  }

  // Run a just-fetched sidecar pattern (profile create / picker) into its
  // result cell on its own committed transaction. Shared by
  // launchProfileCreatePattern and launchProfilePickerPattern so the
  // commit/failure lifecycle lives in one place. Failure semantics, per arm:
  // a CONFLICT-CLASS failure with the result cell already materialized means
  // a racing sibling instantiation won — yield to it (never clobber it with
  // an error UI; that was the OW45 profile-starvation defect); a
  // conflict-class failure with the cell still EMPTY means an INPUT doc
  // moved under the run — re-run against fresh state (bounded), because
  // abandoning the only instantiation leaves the surface permanently blank;
  // every other failure writes the error UI into the cell (the surface's
  // account of why it never came up).
  async function runSidecarInOwnTx(
    resultCell: Cell<any>,
    pattern: Pattern,
    surface: SidecarSurface,
    inputForTx: (tx: IExtendedStorageTransaction) => unknown,
  ): Promise<void> {
    wishSidecarDiagnostics.sidecarRunsStarted += 1;
    // A conflict-class failure means SOME other writer advanced a doc this
    // run's basis read: a sibling instantiation of the same cause-derived
    // sidecar (the same node launched again before its surface opened —
    // every pre-open launch chains its own continuation on that open —
    // another runtime/instance of the node, or the serving loop's
    // re-run), or concurrent traffic on an INPUT doc (e.g. the home
    // `profiles` list). The decision is `sidecarRunFailureDisposition`
    // (module level, unit-pinned); loudness per serving-loop.md §3d's
    // failure-arm contract; the flow pin is
    // wish-sidecar-duplicate-launch.test.ts.
    const yieldToRacingWinner = (error: { name?: string }) => {
      wishSidecarDiagnostics.sidecarRunsRaced += 1;
      wishFlowLogger.warn("sidecar-run-raced", () => [
        `sidecar run for ${resultCell.sourceURI} lost a same-cell race ` +
        `and yields to the winner's surface: ${error.name}: ${
          (error as { message?: string }).message ?? ""
        }`,
      ]);
    };
    // Whether a sibling's materialization (or its error account) is already
    // in the cell — read through a fresh handle so no stale bound tx is
    // consulted; sync errors fall through to the local view.
    const winnerInCell = async (): Promise<boolean> => {
      const fresh = runtime.getCellFromLink(
        resultCell.getAsNormalizedFullLink(),
      );
      try {
        await fresh.sync();
      } catch {
        // The local replica view still answers below.
      }
      return sidecarValueIsWinner(fresh.getRaw());
    };
    // Bounded: an input-doc conflict converges by re-reading fresh state;
    // three attempts outlasts any plausible burst, and the terminal arm is
    // the loud error UI, never a silent drop.
    for (let attempt = 0; attempt < 3; attempt++) {
      const lastAttempt = attempt === 2;
      try {
        const runTx = runtime.edit();
        // Sidecar run from a surface-open continuation — no scheduler run
        // stamps it; bookkeeping per serving-loop.md §3d.
        runtime.stampServerRun(runTx, {
          actionId: `wish/sidecar-run/${resultCell.sourceURI}`,
          kind: "bookkeeping",
        });
        runtime.runner.run(
          runTx,
          pattern,
          inputForTx(runTx),
          resultCell.withTx(runTx),
          sidecarRunOptions(surface),
        );
        runtime.prepareTxForCommit(runTx);
        const { error } = await runTx.commit();
        if (error) {
          const disposition = await sidecarRunFailureDisposition(
            error,
            winnerInCell,
            lastAttempt,
          );
          if (disposition === "yield") {
            yieldToRacingWinner(error);
            return;
          }
          if (disposition === "retry") continue;
          await commitPatternErrorUI(
            resultCell,
            toCompactDebugString(error, COMMIT_FAILURE_RENDER_OPTIONS),
          );
          return;
        }
        // Under a serving wave, commit() resolving ok is not durability:
        // the commit step can still withdraw the contribution (runner.ts's
        // pattern-swap settlement precedent). Nothing re-issues a withdrawn
        // sidecar instantiation, so at least SAY so — the silent one-shot
        // loss class this row keeps producing. Observed OUTSIDE this
        // launch's awaited chain: the launch promise is tracked into
        // idle(), and a wave's settlement can resolve only at the commit
        // step — awaiting it here would make idle() wait on the wave that
        // waits on quiescence (stalling cold sidecars until the flush
        // deadline). Recovery is deliberately not attempted (re-running
        // against a withdrawn basis is its own design question, flagged in
        // the register).
        const settlement = waveSettlementOf(runTx);
        if (settlement !== undefined) {
          void settlement.then((settled) => {
            if (settled.error !== undefined) {
              wishFlowLogger.warn("sidecar-run-withdrawn", () => [
                `sidecar run for ${resultCell.sourceURI} committed but ` +
                `the wave withdrew it; nothing re-issues this ` +
                `instantiation: ${settled.error.message}`,
              ]);
            }
          }, () => {
            // A settlement rejection is the wave's own failure account;
            // nothing to add here.
          });
        }
        return;
      } catch (error) {
        // The same conflict classes surface as THROWS from the run/prepare
        // path (a stale read met mid-run) — same shared discrimination.
        const disposition = await sidecarRunFailureDisposition(
          error as { name?: string },
          winnerInCell,
          lastAttempt,
        );
        if (disposition === "yield") {
          yieldToRacingWinner(error as { name?: string });
          return;
        }
        if (disposition === "retry") continue;
        await commitPatternErrorUI(resultCell, errorMessage(error));
        return;
      }
    }
  }

  function launchProfileCreatePattern(
    ctx: WishContext,
    providedTx?: IExtendedStorageTransaction,
  ): Cell<any> {
    // Phase 5: the sidecar cells key by the HOME-SPACE user — the
    // demanding identity on a serving runtime (two users' create
    // surfaces must not collide on the service DID), the runtime's own
    // user on a client (unchanged). The CLOSURE state keys by the SAME
    // expression (the F2 fix): the singular wish node runs once per
    // demanded instance, and a shared cached cell/input made demander
    // #2 reuse demander #1's surface and clobber the pending input.
    const sidecarUser = homeSpaceUserDID(ctx) ?? runtime.userIdentityDID;
    const slot = slotFor(
      profileCreateSidecars,
      sidecarUser,
      (): ProfileCreateSidecarSlot => ({}),
    );
    const homeDefaultPattern = getHomeSpaceCell(ctx).key("defaultPattern")
      .resolveAsCell();
    slot.input = {
      profiles: createSigilLinkFromParsedLink(
        homeDefaultPattern.key("profiles").getAsNormalizedFullLink(),
      ),
      inputId: "wish-profile-name-input",
      buttonId: "wish-profile-create-button",
    };
    const tx = providedTx || runtime.edit();

    if (!slot.resultCell) {
      slot.resultCell = runtime.getCell(
        parentCell.space,
        {
          wish: {
            profileCreatePattern: cause,
            user: sidecarUser,
          },
        },
        undefined,
        tx,
      );
    }
    if (!slot.readyCell) {
      slot.readyCell = runtime.getCell<boolean>(
        parentCell.space,
        {
          wish: {
            profileCreatePatternReady: cause,
            user: sidecarUser,
          },
        },
        undefined,
        tx,
      );
      recordRuntimeOwnedStore(tx, parentCell, slot.readyCell);
      enrollRuntimeOwnedStore(tx, parentCell, slot.readyCell);
    }
    slot.readyCell.get();

    const profileCreateInputForTx = (tx: IExtendedStorageTransaction) => {
      const bindInputCell = (cell: unknown) =>
        cell && typeof (cell as { withTx?: unknown }).withTx === "function"
          ? (cell as Cell<unknown>).withTx(tx)
          : cell;
      return slot.input && {
        ...slot.input,
        profiles: bindInputCell(slot.input.profiles),
      };
    };

    const openedProfileCreatePattern = openedSidecarSurface(slot);
    if (sidecarIsServed) {
      // The SpaceServer fetches/instantiates the create surface for this
      // demander and flips its ready cell; this speculative run only
      // references the served cells (read above for the re-run trigger).
    } else if (!openedProfileCreatePattern) {
      // Each entry here chains one instantiation continuation on the
      // (possibly in-flight) open of this demander's surface — the
      // duplicate-launch producer the pin's witness counts at REGISTRATION
      // time.
      wishSidecarDiagnostics.profileCreateSurfaceOpens += 1;
      const launch = openSidecarSurface(
        runtime,
        slot,
        slot.resultCell,
        PROFILE_CREATE_SURFACE,
        { retryOnFailure: true },
      ).then(
        (pattern) => {
          if (cancelled || !slot.resultCell) return;
          if (pattern) {
            // The surface's pattern is here: re-arm this demander's create
            // surface so its wish re-runs and renders what just arrived. Every
            // launch that joined this open runs this, so a signal already sent
            // is not sent again.
            const readyCell = slot.readyCell;
            if (readyCell !== undefined && readyCell.get() !== true) {
              const readyTx = runtime.edit();
              // Surface-open continuation — no scheduler run stamps it;
              // bookkeeping per serving-loop.md §3d.
              runtime.stampServerRun(readyTx, {
                actionId: `wish/profile-create-ready/${readyCell.sourceURI}`,
                kind: "bookkeeping",
              });
              readyCell.withTx(readyTx).set(true);
              runtime.prepareTxForCommit(readyTx);
              trackSidecarLaunch(readyTx.commit());
            }
            return runSidecarInOwnTx(
              slot.resultCell,
              pattern,
              PROFILE_CREATE_SURFACE,
              profileCreateInputForTx,
            );
          }
          // The surface could not be opened (openSidecarSurface reports the
          // reason and resolves to undefined). The create surface is the only
          // way a user with no profile gets one, and nothing re-triggers this
          // launch, so a silent undefined leaves that surface blank for the
          // life of the piece. Say so in the cell the surface renders from —
          // unless a later open has since landed a pattern, whose surface is
          // in that same cell and is the better answer than this failure.
          if (!openedSidecarSurface(slot)) {
            return commitPatternErrorUI(
              slot.resultCell,
              `Can't load ${PROFILE_CREATE_SURFACE.name}`,
            );
          }
        },
      );
      trackSidecarLaunch(launch);
    } else if (!cancelled && slot.resultCell) {
      runtime.runner.run(
        tx,
        openedProfileCreatePattern,
        profileCreateInputForTx(tx),
        slot.resultCell.withTx(tx),
        sidecarRunOptions(PROFILE_CREATE_SURFACE),
      );
    }

    if (!providedTx) {
      runtime.prepareTxForCommit(tx);
      tx.commit();
    }

    return slot.resultCell;
  }

  function profileCreateUI(ctx: WishContext): VNode {
    return h("cf-render", {
      "data-profile-create-ui": "wish",
      $cell: launchProfileCreatePattern(ctx, ctx.tx),
    });
  }

  // The profile-picker sidecar rendered as a VNode, for the `[UI]` slot of a
  // #profile wish with 2+ candidates and no valid default. `.result` rides the
  // main wish state (ordered[0]) — the picker is only the switching affordance
  // (CT-1829); its "Use" / "Set default" writes reorder candidates so the
  // builtin's ordered[0] — and thus `.result` — flips reactively.
  function profilePickerUI(ctx: WishContext): VNode {
    return h("cf-render", {
      "data-profile-picker-ui": "wish",
      $cell: launchProfilePickerPattern(ctx, ctx.tx),
    });
  }

  // Launch the profile picker for #profile wishes with multiple profiles. Feeds
  // the home `profiles`/`defaultProfile`/`mru` cells (as sigil links) so the
  // picker can render natively, select (stamp MRU), set the default, and create
  // another — all as trusted picker-surface writes. Mirrors
  // launchProfileCreatePattern's deferred-fetch/run handling.
  function launchProfilePickerPattern(
    ctx: WishContext,
    providedTx?: IExtendedStorageTransaction,
  ): Cell<any> {
    // Per-demanding-identity slot (the F2 fix) — the slot key is the
    // same expression the cell cause keys on; see
    // launchProfileCreatePattern.
    const sidecarUser = homeSpaceUserDID(ctx) ?? runtime.userIdentityDID;
    const slot = slotFor(
      profilePickerSidecars,
      sidecarUser,
      (): ProfilePickerSidecarSlot => ({}),
    );
    const homeDefaultPattern = getHomeSpaceCell(ctx).key("defaultPattern")
      .resolveAsCell();
    slot.input = {
      profiles: createSigilLinkFromParsedLink(
        homeDefaultPattern.key("profiles").getAsNormalizedFullLink(),
      ),
      defaultProfile: createSigilLinkFromParsedLink(
        homeDefaultPattern.key("defaultProfile").getAsNormalizedFullLink(),
      ),
      mru: createSigilLinkFromParsedLink(
        homeDefaultPattern.key("mru").getAsNormalizedFullLink(),
      ),
    };
    const tx = providedTx || runtime.edit();

    if (!slot.resultCell) {
      slot.resultCell = runtime.getCell(
        parentCell.space,
        {
          wish: {
            profilePickerPattern: cause,
            // Phase 5: keyed by the home-space user (the demanding
            // identity on serving) — see launchProfileCreatePattern.
            user: sidecarUser,
          },
        },
        undefined,
        tx,
      );
    }

    const pickerInputForTx = (tx: IExtendedStorageTransaction) => {
      const bindInputCell = (cell: unknown) =>
        cell && typeof (cell as { withTx?: unknown }).withTx === "function"
          ? (cell as Cell<unknown>).withTx(tx)
          : cell;
      return slot.input && {
        profiles: bindInputCell(slot.input.profiles),
        defaultProfile: bindInputCell(slot.input.defaultProfile),
        mru: bindInputCell(slot.input.mru),
      };
    };

    const openedProfilePickerPattern = openedSidecarSurface(slot);
    if (sidecarIsServed) {
      // The SpaceServer instantiates the picker for this demander; this
      // speculative run references its cell only.
    } else if (!openedProfilePickerPattern) {
      const launch = openSidecarSurface(
        runtime,
        slot,
        slot.resultCell,
        PROFILE_PICKER_SURFACE,
        { retryOnFailure: true },
      ).then(
        (pattern) => {
          if (cancelled || !slot.resultCell) return;
          if (pattern) {
            runSidecarInOwnTx(
              slot.resultCell,
              pattern,
              PROFILE_PICKER_SURFACE,
              pickerInputForTx,
            );
          } else {
            // The surface could not be opened (openSidecarSurface reports the
            // reason and resolves to undefined). Surface it as an error UI in
            // the picker sidecar cell so the picker slot doesn't stay blank
            // forever. `.result` is unaffected: under CT-1829 it rides the main
            // wish state (ordered[0]), not this sidecar.
            commitPatternErrorUI(
              slot.resultCell,
              `Can't load ${PROFILE_PICKER_SURFACE.name}`,
            );
          }
        },
      ).catch((error) => {
        // Defensive: a throw inside the `.then` body (or a truly-rejecting
        // open) would otherwise be an unhandled rejection. Surface it too.
        if (!cancelled && slot.resultCell) {
          commitPatternErrorUI(
            slot.resultCell,
            errorMessage(error),
          );
        }
      });
      trackSidecarLaunch(launch);
    } else if (!cancelled && slot.resultCell) {
      runtime.runner.run(
        tx,
        openedProfilePickerPattern,
        pickerInputForTx(tx),
        slot.resultCell.withTx(tx),
        sidecarRunOptions(PROFILE_PICKER_SURFACE),
      );
    }

    if (!providedTx) {
      runtime.prepareTxForCommit(tx);
      tx.commit();
    }

    return slot.resultCell;
  }

  // Wish action, reactive to changes in inputsCell and any cell we read during
  // initial resolution. Synchronous: reads cell.get() which triggers sync and
  // returns undefined if data isn't loaded yet. The reactive system re-triggers
  // wish when the data arrives.
  const action: Action = (tx: IExtendedStorageTransaction) => {
    if (cancelled) return;
    const actionStartedAt = performance.now();
    let actionQueryKey: string | undefined;
    let usedSharedHashtagResolver = false;

    try {
      tx.resetNarrowestReadScope();
      const targetValue = measureWishPhase(
        "input-get",
        undefined,
        () => {
          const inputsWithTx = inputsCell.withTx(tx);
          return inputsWithTx.asSchema(TARGET_SCHEMA).get();
        },
      );

      if (typeof targetValue === "object") {
        const { query, path, schema, context, scope, headless } =
          targetValue as WishParams;
        const queryKey = sanitizeQueryKey(String(query ?? ""));
        actionQueryKey = queryKey;
        const inputScope = tx.getNarrowestReadScope();
        const targetMayUseHomeSpace = wishTargetMayUseHomeSpace(query, scope);

        if (query === undefined || query === null || query === "") {
          const errorMsg =
            debugStr`Wish target $quote${targetValue} has no query.`;
          const outputScope = wishOutputScope(
            schema,
            inputScope,
            targetMayUseHomeSpace,
          );
          measureWishPhase(
            "send-error",
            queryKey,
            () =>
              sendWishState(
                tx,
                {
                  result: undefined,
                  candidates: [],
                  error: errorMsg,
                  [UI]: errorUI(errorMsg),
                } satisfies WishState<any>,
                outputScope,
                schema,
              ),
          );
          return;
        }

        // If the query is a path or a hash tag, resolve it directly
        if (query.startsWith("/") || /^#[a-zA-Z0-9-]+/.test(query)) {
          const ctx: WishContext = {
            runtime,
            readiness,
            tx,
            parentCell,
            scope,
            nowCell,
            nowCause: cause,
          };
          let parsed: ParsedWishTarget | undefined;
          try {
            const resolveStartedAt = performance.now();
            const activeParsed = parsed = measureWishPhase(
              "parse-target",
              queryKey,
              () => {
                const nextParsed = parseWishTarget(query);
                nextParsed.path = [...nextParsed.path, ...(path ?? [])];
                return nextParsed;
              },
            );

            // Interval #now is not a resolution — it's a timer subscription.
            // Handle it before entering the resolution pipeline.
            if (
              handleIntervalNow(
                activeParsed,
                nowState,
                ctx,
                sendResult,
                addCancel,
              )
            ) {
              return;
            }

            // Home discovery must run under the demander's transaction. A
            // shared subscription has no demanding principal of its own.
            if (
              !targetMayUseHomeSpace &&
              wishOutputScope(schema, inputScope, false) === "space" &&
              canUseSharedHashtagResult(activeParsed, { headless })
            ) {
              const shared = getCurrentSharedHashtagResolver(ctx, activeParsed);
              usedSharedHashtagResolver = true;
              measureWishPhase(
                "send-shared-hashtag",
                queryKey,
                () =>
                  sendResult(
                    tx,
                    sharedWishCellValue(shared.cell, schema),
                  ),
              );
              return;
            }

            const baseResolutions = measureWishPhase(
              "resolve-base",
              queryKey,
              () => resolveBase(activeParsed, ctx),
            );
            const outputScope = wishOutputScope(
              schema,
              inputScope,
              targetMayUseHomeSpace || ctx.usedHomeSpace === true,
            );
            // Persist #now cell across re-runs to avoid non-idempotent loops
            if (ctx.nowCell) nowCell = ctx.nowCell;

            const resultCells = measureWishPhase(
              "resolve-paths",
              queryKey,
              () =>
                baseResolutions.map((baseResolution) => {
                  const combinedPath = buildResolutionPath(
                    baseResolution,
                    activeParsed.path,
                  );
                  const resolvedCell = resolvePath(
                    baseResolution.cell,
                    combinedPath,
                    ctx,
                  );
                  return schema ? resolvedCell.asSchema(schema) : resolvedCell;
                }),
            );

            // Deduplicate result cells using Cell.equals()
            const uniqueResultCells = measureWishPhase(
              "dedupe-results",
              queryKey,
              () =>
                resultCells.filter(
                  (cell, index) =>
                    resultCells.findIndex((c) => c.equals(cell)) === index,
                ),
            );
            wishFlowLogger.time(
              resolveStartedAt,
              "wish",
              "resolve",
              queryKey,
            );

            // Unified shape: always return { result, candidates, [UI] }
            // For single result, use fast path (no picker needed)
            // For multiple results, launch suggestion pattern for picker
            const candidatesCell = measureWishPhase(
              "candidates-cell",
              queryKey,
              () =>
                createWishCandidatesCell(
                  runtime,
                  parentCell.space,
                  uniqueResultCells,
                  schema,
                  tx,
                ),
            );
            const profileHasValidDefault =
              isProfilePersonaTarget(activeParsed) &&
              getProfileCandidateCells(ctx).defaultValid;

            // #profile with 2+ candidates and no valid default → CT-1829: `.result` is
            // always the single best profile (ordered default → MRU → first, i.e.
            // uniqueResultCells[0]), sent eagerly on the main wish state exactly
            // like the generic multi-match path does at wish.ts:2052. The picker
            // sidecar becomes the `[UI]` switching affordance: its "Use" (MRU)
            // and "Set default" writes reorder candidates so `.result` follows
            // reactively. This removes the orphan-second-profile deadlock where
            // the wish output was replaced by the picker's initially-empty (and
            // forever-empty on fetch failure) result cell.
            if (
              isProfilePersonaTarget(activeParsed) &&
              !headless &&
              uniqueResultCells.length > 1 &&
              !profileHasValidDefault
            ) {
              measureWishPhase(
                "send-profile-picker",
                queryKey,
                () =>
                  sendWishState(
                    tx,
                    {
                      result: projectWishCellValue(
                        uniqueResultCells[0],
                        schema,
                      ),
                      candidates: candidatesCell,
                      [UI]: profilePickerUI(ctx),
                    },
                    outputScope,
                    schema,
                  ),
              );
              return;
            }

            if (
              uniqueResultCells.length === 1 ||
              headless ||
              profileHasValidDefault
            ) {
              // Single result or headless mode - fast path with unified shape
              // Prefer the result cell's own [UI]; fall back to cf-cell-link
              const resultUI = measureWishPhase(
                "result-ui-get",
                queryKey,
                () => wishResultUI(activeParsed, uniqueResultCells[0]),
              );
              measureWishPhase(
                "send-fast",
                queryKey,
                () =>
                  sendWishState(
                    tx,
                    {
                      result: projectWishCellValue(
                        uniqueResultCells[0],
                        schema,
                      ),
                      candidates: candidatesCell,
                      [UI]: resultUI ?? cellLinkUI(uniqueResultCells[0]),
                    },
                    outputScope,
                    schema,
                  ),
              );
            } else {
              // Multiple results — if this demander's suggestion surface is
              // already open, launch it and send its result cell so the
              // picker's output flows through. Otherwise fall back to first
              // result and open the surface for next time.
              if (suggestionSurfaceOpened(ctx)) {
                measureWishPhase(
                  "send-suggestion",
                  queryKey,
                  () =>
                    sendResult(
                      tx,
                      launchSuggestionPattern(
                        ctx,
                        {
                          situation: query,
                          context: context ?? {},
                          initialResults: candidatesCell,
                        },
                        tx,
                      ),
                    ),
                );
              } else {
                // Surface not open yet — send first result, start opening it
                const resultUI = measureWishPhase(
                  "result-ui-get",
                  queryKey,
                  () => wishResultUI(activeParsed, uniqueResultCells[0]),
                );
                measureWishPhase(
                  "send-fast-before-suggestion",
                  queryKey,
                  () =>
                    sendWishState(
                      tx,
                      {
                        result: projectWishCellValue(
                          uniqueResultCells[0],
                          schema,
                        ),
                        candidates: candidatesCell,
                        [UI]: resultUI ?? cellLinkUI(uniqueResultCells[0]),
                      },
                      outputScope,
                      schema,
                    ),
                );
                measureWishPhase(
                  "launch-suggestion",
                  queryKey,
                  () =>
                    launchSuggestionPattern(
                      ctx,
                      {
                        situation: query,
                        context: context ?? {},
                        initialResults: candidatesCell,
                      },
                      tx,
                    ),
                );
              }
            }
          } catch (e) {
            if (e instanceof DocumentPending) return;
            const errorMsg = e instanceof WishError ? e.message : String(e);
            const ui = e instanceof NoProfileError && parsed &&
                isProfilePersonaTarget(parsed)
              ? profileCreateUI(ctx)
              : errorUI(errorMsg);
            measureWishPhase(
              "send-error",
              queryKey,
              () =>
                sendWishState(
                  tx,
                  {
                    result: undefined,
                    candidates: [],
                    error: errorMsg,
                    [UI]: ui,
                  } satisfies WishState<any>,
                  wishOutputScope(
                    schema,
                    inputScope,
                    targetMayUseHomeSpace || ctx.usedHomeSpace === true,
                  ),
                  schema,
                ),
            );
          }
        } else if (headless) {
          // Headless mode with freeform query — no suggestion pattern
          measureWishPhase(
            "send-freeform",
            queryKey,
            () =>
              sendWishState(
                tx,
                {
                  result: undefined,
                  candidates: [],
                  [UI]: undefined,
                } satisfies WishState<any>,
                wishOutputScope(schema, inputScope, false),
                schema,
              ),
          );
        } else {
          // Otherwise it's a generic query, instantiate suggestion.tsx
          const suggestionCtx: WishContext = {
            runtime,
            readiness,
            tx,
            parentCell,
            scope,
            nowCell,
            nowCause: cause,
          };
          measureWishPhase(
            "send-suggestion",
            queryKey,
            () =>
              sendResult(
                tx,
                launchSuggestionPattern(
                  suggestionCtx,
                  { situation: query, context: context ?? {} },
                  tx,
                ),
              ),
          );
        }
        return;
      } else {
        const errorMsg =
          debugStr`Wish target is not recognized: $quote${targetValue}`;
        const inputScope = tx.getNarrowestReadScope();
        measureWishPhase(
          "send-error",
          undefined,
          () =>
            sendWishState(
              tx,
              {
                result: undefined,
                candidates: [],
                error: errorMsg,
                [UI]: errorUI(errorMsg),
              } satisfies WishState<any>,
              inputScope,
              undefined,
            ),
        );
        return;
      }
    } finally {
      if (!usedSharedHashtagResolver) {
        releaseCurrentSharedHashtagResolver();
      }
      recordWishPhaseTiming(
        actionStartedAt,
        "action-total",
        actionQueryKey,
      );
    }
  };
  return { action, onActionRegistered: readiness.onActionRegistered };
}
