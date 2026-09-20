import { getLogger } from "@commonfabric/utils/logger";
import { readStatsActive, recordLinkResolution } from "./read-stats.ts";
import {
  ensureExternalSchemaClosure,
  markIfcBearingLinkCrossing,
} from "./schema-ifc.ts";
import { internSchema } from "@commonfabric/data-model-schema";
import { isObjectOrArray } from "@commonfabric/utils/types";
import { debugStr } from "@commonfabric/data-model";
import {
  linkPayloadAtProbe,
  linkProbeSubPath,
} from "@commonfabric/data-model/cell-rep";
import { type CellLinkRefPayload } from "./sigil-types.ts";
import { dataUriFromValueWithResolvedLinks } from "./data-uri.ts";
import {
  type CellLink,
  type NormalizedFullLink,
  parseLink,
  schemaForSpaceCrossing,
  type ScopeCapAtDepth,
  toMemorySpaceAddress,
} from "./link-utils.ts";
import type {
  IExtendedStorageTransaction,
  INotFoundError,
} from "./storage/interface.ts";
import { linkResolutionProbe } from "./storage/reactivity-log.ts";
import { ContextualFlowControl } from "./cfc.ts";
import type { Runtime } from "./runtime.ts";
import type { CfcAddress, CfcDereferenceTrace } from "./cfc/types.ts";
import { canFollowScopedLink, narrowerScopeCap } from "./scope.ts";
import type { JSONSchema, SchemaScope } from "./builder/types.ts";

const logger = getLogger("link-resolution");

export type LastNode = "value" | "writeRedirect" | "top";

/**
 * A resolved link is a link that has been resolved to a document that no longer
 * has any links between the top and the value at `link.path`.
 */
declare const resolvedFullLinkBrand: unique symbol;

export type ResolvedFullLink = NormalizedFullLink & {
  // type-script only marker, doesn't appear in actual data
  [resolvedFullLinkBrand]: true;
};

/**
 * Whether `schema` constrains nothing at all: absent, or a TRUE schema in
 * the canonical sense (`ContextualFlowControl.isTrueSchema`) — JSON Schema
 * `true`, `{}`, or an object carrying only internal flags, `default`, or
 * `$defs`. Such a schema selects every value, so it says nothing the
 * schema a resolution is already carrying does not, and a hop onto a link
 * bearing one keeps carrying rather than adopting it. `false` is not one
 * of these — it selects nothing, which is information. Nor is a schema
 * that declares a stream: it selects every value too, but the document behind
 * a stream holds nothing, so the declaration is the only thing that says what
 * the position is, and a carried schema that lacks it cannot say so. Any
 * other `asCell` entry keeps carrying: its document holds a value, which the
 * carried schema is there to read.
 */
const schemaConstrainsNothing = (schema: JSONSchema | undefined): boolean =>
  schema === undefined ||
  (ContextualFlowControl.isTrueSchema(schema) &&
    !ContextualFlowControl.declaresStream(schema));

export const MAX_PATH_RESOLUTION_LENGTH = 100;

type LinkHop = {
  /**
   * The stored link's schema BEFORE any path narrowing (the ancestor-probe
   * hop narrows by the remaining path), preserved for the crossing seam:
   * narrowing can drop root-level `ifc` declarations, and the seam's
   * subject is the link as stored.
   */
  storedSchema?: JSONSchema;

  link: NormalizedFullLink;
  source: NormalizedFullLink;
  kind: "value" | "write-redirect";

  /**
   * How many of the resolving link's path segments the stored link sits under.
   * Equal to `link.path.length` for a hop found at the full path, and shorter
   * when the hop was discovered at an ancestor — which is the case that has to
   * consult `scopeCaps` rather than the leaf schema.
   */
  depth: number;
};

const cfcAddressFromLink = (link: NormalizedFullLink): CfcAddress => ({
  space: link.space,
  id: link.id,
  scope: link.scope,
  path: [...link.path],
});

const hopKindForLink = (
  link: NormalizedFullLink,
): LinkHop["kind"] =>
  link.overwrite === "redirect" ? "write-redirect" : "value";

/**
 * Record a hop on the transaction and hand back what was recorded, so a
 * memoized resolution can record the same trace object again rather than build
 * an equal one. Sharing it is what lets the label view derived from its
 * addresses be memoized in turn, and the transaction freezes on entry either
 * way, so the trace list reads exactly as it does for an unmemoized walk.
 */
const recordDereferenceHop = (
  tx: IExtendedStorageTransaction,
  hop: LinkHop,
): CfcDereferenceTrace => {
  const trace = {
    source: cfcAddressFromLink(hop.source),
    target: cfcAddressFromLink(hop.link),
    kind: hop.kind,
  };
  tx.recordCfcDereferenceTrace(trace);
  return trace;
};

// The scope cap a link's schema imposes on the next link it permits a read to
// follow (see ContextualFlowControl.getSchemaScopeCap for the precedence). This
// caps *which* link scopes may be followed; it must never be copied onto the
// followed link itself.
//
// `link.schema` describes the LEAF, so it only applies to a hop found at the
// full path. A hop found at an ancestor is governed by whatever that ancestor's
// schema declared, which `key()` recorded in `scopeCaps` on its way down —
// narrowing had already replaced the declaring schema by the time we get here
// (#5230).
//
// For an ancestor hop we take the NARROWER of the recorded cap and the leaf's.
// The leaf cap is not really the right authority there — it describes a
// different address — but applying it to ancestor hops is what this resolver
// has always done, and a link that never passed through `key()` carries no
// recorded caps at all. Keeping it as a floor means this change can only block
// more than before, never less.
//
// This floor is load-bearing, not just belt-and-braces: a link assembled
// directly (`runtime.getCellFromLink` with a multi-segment path) has no
// recorded caps at all, and removing the floor lets such a read follow a
// narrower link that main blocks. Pinned by a test.

/**
 * Shift recorded caps onto a link's target after a hop consumed `consumed`
 * leading segments. Caps at or below the hop are dropped (already enforced);
 * the rest move by `shift` so their depths still address the same segments.
 */
const rebaseScopeCaps = (
  caps: readonly ScopeCapAtDepth[] | undefined,
  consumed: number,
  shift: number,
): readonly ScopeCapAtDepth[] | undefined => {
  if (caps === undefined) return undefined;
  const moved = caps
    .filter((cap) => cap.depth > consumed)
    .map((cap) => ({ depth: cap.depth + shift, scope: cap.scope }));
  return moved.length > 0 ? moved : undefined;
};

const schemaScopeForLinkAtDepth = (
  link: NormalizedFullLink,
  depth: number,
): SchemaScope | undefined => {
  // getSchemaScopeCap only reads the top level, so a cap wrapped in
  // anyOf/oneOf is invisible to it. A mixed compound (`[<capped handle>,
  // {type:"null"}]`) never mints a handle at all -- the link is simply
  // followed -- so this is the only place that shape can be caught.
  const leafCap = narrowerScopeCap(
    ContextualFlowControl.getSchemaScopeCap(link.schema),
    ContextualFlowControl.getAsCellFollowScopeCap(link.schema),
  );
  if (depth >= link.path.length) return leafCap;
  return narrowerScopeCap(
    link.scopeCaps?.find((cap) => cap.depth === depth)?.scope,
    leafCap,
  );
};

/**
 * The link a blocked or dead-ended chain resolves to: undefined-data in place.
 * Exported so every site that decides a link may not be followed produces the
 * same shape — notably the asCell boundaries, which build a handle instead of
 * following and so never reach the check below (#5230).
 */
export const undefinedDataLink = (
  link: NormalizedFullLink,
): NormalizedFullLink => {
  // `path` is rebased to [], so any recorded cap depths now address segments
  // of a different document. Drop them rather than leave them misaligned.
  // Drop the read-side stamps too (OW51): a deliberately undefined-data
  // result is an HONEST undefined, not a pending hop-target, so it must
  // not carry `pendingHopDoc` (would refuse an honest-undefined read).
  // What this strip GUARANTEES is scoped to the exported
  // asCell-boundary callers, which return the result as built here. On
  // the walk's own scope-blocked break the exit stamps `viaLinkHop`
  // back onto the result (behaviorally inert today: nothing consumes
  // the flag on an undefined-data link) — the re-stamp skip is a named
  // cleanup in the OW51 build report §8.5, not a contract this comment
  // can promise.
  const {
    scopeCaps: _dropped,
    pendingHopDoc: _p,
    viaLinkHop: _v,
    ...rest
  } = link;
  return {
    ...rest,
    id: dataUriFromValueWithResolvedLinks(undefined, link),
    path: [],
  };
};

const canFollowLinkHop = (
  source: NormalizedFullLink,
  hop: LinkHop,
): boolean =>
  canFollowScopedLink(
    schemaScopeForLinkAtDepth(source, hop.depth),
    hop.link.scope,
  );

/**
 * Force a fetch from the server when the local replica cannot serve a hop
 * target: crossing spaces (the origin server never pushes other-space docs), or
 * a same-space doc this replica has never pulled, which `shouldPullDoc`
 * reserves so only the first reader kicks.
 *
 * The second arm is the fresh-replica read-asymmetry fix: selector driven syncs
 * only deliver what a schema covered, so a link can point at a same-space doc
 * no selector ever walked — without this kick such reads mask as `undefined`,
 * indistinguishable from absence. The kick is async; one-shot reads still
 * return the masked value, but `Cell.pull()`'s convergence loop awaits the
 * tracked sync and re-reads.
 *
 * Sync failures are swallowed: the kick is best-effort (the read still resolves
 * from the local replica) and an unhandled rejection here would otherwise
 * escape the resolution path. On failure, retract the `shouldPullDoc`
 * reservation so a later read may retry — but only when THIS kick took it: a
 * cross-space kick never reserved, and must not clear a reservation a
 * concurrent same-space read holds for the same target (that would permit
 * duplicate syncs).
 */
const kickDocPull = (
  runtime: Runtime,
  link: NormalizedFullLink,
  reserved: boolean,
): void => {
  const mgr = runtime.storageManager;
  const { space, id, scope } = link;
  mgr.trackUntilSettled(
    runtime.getCellFromLink(link).sync().catch(() => {
      if (reserved) mgr.retractDocPullKick?.(space, id, scope);
    }),
  );
};

/**
 * What a resolution leaves on the transaction besides the link it returns, so
 * a memoized one can reproduce it. See {@link resolveLink}'s cache notes.
 */
type LinkResolutionRecord = {
  /** The resolved link. Handed out as a copy, never this object. */
  readonly result: NormalizedFullLink;

  /** Every hop the walk recorded, in order, ready to be recorded again. */
  readonly traces: readonly CfcDereferenceTrace[];

  /**
   * The schema-bearing links this walk crossed, so a memoized resolution
   * can replay the crossing seam's cfc-relevance marking for callers that
   * opt in (`markIfcCrossings`). Pure data: whether a schema carries `ifc`
   * is evaluated at mark time (the predicate is memoized), so a cold
   * external closure neither bakes a stale verdict into this record nor
   * costs the walk its memoizability.
   */
  readonly schemaHops: readonly {
    id: string;
    space: NormalizedFullLink["space"];
    schema: JSONSchema;
  }[];

  /**
   * Hop targets in another space. Their sync kick is unreserved, so it fires on
   * every resolution and a memoized one has to fire it too. A same-space kick
   * is taken against a reservation and fires once whatever happens, so it is
   * not recorded here.
   */
  readonly crossSpaceTargets: readonly NormalizedFullLink[];
};

// Identity tags for the link fields a cache key cannot cheaply serialize.
// Schemas are interned at every resolution exit and `scopeCaps` arrays travel
// by reference, so within one transaction the hot path presents the same
// object each time. A structurally-equal object under a different identity
// simply misses, which costs a resolution rather than serving a wrong one.
let nextIdentityTag = 0;
const identityTags = new WeakMap<object, number>();

const identityTag = (value: object): number => {
  let tag = identityTags.get(value);
  if (tag === undefined) {
    tag = ++nextIdentityTag;
    identityTags.set(value, tag);
  }
  return tag;
};

/**
 * The address a link names, which is both the walk's cycle-detection key and
 * the tail of its memo key. Computed once and reused for both, so a resolution
 * that misses the memo pays for exactly the one the walk needed anyway.
 *
 * A prefix code rather than a join: the id and every path segment are
 * preceded by their length, and the path by its segment count, so two
 * addresses that differ only in where a boundary falls take different keys
 * even where a part contains the separator itself. The space is a DID, which
 * holds no NUL, and the scope is one of a few fixed words.
 */
const linkAddressKey = (link: NormalizedFullLink): string =>
  addressKeyAt(link, link.path);

/** Helper for `linkAddressKey()`, which keys `position` in `link`'s document. */
const addressKeyAt = (
  link: NormalizedFullLink,
  position: readonly string[],
): string => {
  let key = `${link.space}\0${link.id.length}\0${link.id}\0` +
    `${link.scope ?? ""}\0${position.length}`;
  for (const component of position) {
    const segment = String(component);
    key += `\0${segment.length}\0${segment}`;
  }
  return key;
};

/**
 * What a sigil probe found at one position of one document, memoized on the
 * transaction's snapshot memo under `probeMemoKey()`.
 *
 * Walks through one container probe the same positions over and over: reading
 * three properties of an element probes the element's own slot three times,
 * once per property read that passes through it. The answer
 * cannot differ between those probes — the memo is dropped on every write —
 * and the first probe journaled the read, so a repeat would add an identical
 * entry to a set. The record stands in for the probe read and for the read of
 * the stored link behind it; it does not stand in for the dereference trace,
 * which every walk records for itself.
 */
type ProbeRecord = {
  /** The link payload at the position, or `undefined` where it holds none. */
  readonly payload: ReturnType<typeof linkPayloadAtProbe>;

  /**
   * Where the position does not exist, the `NotFoundError` path: the longest
   * prefix that could be addressed, `[]` when the document itself is missing.
   */
  readonly notFound: readonly string[] | undefined;

  /**
   * The stored link parsed from the position, filled in by the first walk to
   * follow it. Every later walk shares this object, and none mutates it: a
   * walk copies a link before it changes one.
   */
  hop?: NormalizedFullLink;
};

/** The snapshot-memo key of the probe at `position` in `link`'s document. */
const probeMemoKey = (
  link: NormalizedFullLink,
  position: readonly string[],
): string => `probe:${addressKeyAt(link, position)}`;

/**
 * What distinguishes two resolutions of the same address. `schema` and
 * `scopeCaps` decide which hops may be followed and what the result carries,
 * `overwrite` survives into the result under `preserveOverwrite`, and all of
 * these change the answer for the same link.
 *
 * `viaLinkHop` (OW51) belongs here too: a DATA-DERIVED input link makes a
 * missing-doc dead-end resolve to a `pendingHopDoc` result (`inputViaLinkHop`
 * in the walk), while a clean input link at the same address resolves to a
 * plain undefined-data result. Two resolutions of one address differing only
 * in this flag therefore have DIFFERENT answers and must NOT share a memo
 * entry — otherwise, within one lazy tx, a clean first-write
 * `get() ?? fallback` read and a derived read of the same missing doc alias:
 * whichever runs first seeds the cache and the other inherits the wrong
 * verdict (a spurious refusal on the clean read, or the lost refusal — the
 * OW51 crash surviving — on the derived read). Confirmed both directions by
 * #6179's review (Finding 1); pinned in `link-resolution-memo.test.ts`.
 */
const resolutionMemoVariant = (
  link: NormalizedFullLink,
  lastNode: LastNode,
  preserveOverwrite: boolean,
): string => {
  const schema = isObjectOrArray(link.schema)
    ? `#${identityTag(link.schema)}`
    : String(link.schema);
  const caps = link.scopeCaps === undefined
    ? ""
    : `#${identityTag(link.scopeCaps)}`;
  return `link:${lastNode}|${preserveOverwrite ? 1 : 0}|` +
    `${link.overwrite ?? ""}|${schema}|${caps}|${link.viaLinkHop ? "v" : ""}|`;
};

/**
 * Resolves a document path with support for links inside documents.
 *
 * It returns a `ResolvedFullLink` that points to a document that no longer has
 * any links between the top and the value at `link.path`. When a cycle is
 * detected, an error is logged and thrown.
 *
 * `lastNode` controls whether to follow links on the last path segment. By
 * default all links are followed, but if `lastNode` is `LastNode.WriteRedirect`
 * only write redirects are followed and if `lastNode` is `LastNode.Top` no
 * links are followed at all.
 *
 * Links can point to another (document, path) pair, and may appear either at
 * leaf nodes or in the middle of a document. This resolver transparently
 * follows such links and detects cycles.
 *
 * The resolved link carries a schema. A followed link's own stored schema
 * describes the value at its target, where the caller's describes the value at
 * the source, so the stored one replaces what the resolution carried in. One
 * that constrains nothing describes nothing, so the caller's schema keeps
 * traveling instead; see `schemaConstrainsNothing()`.
 *
 * A cycle is detected if the exact (document, path) pair is visited more than
 * once. This detects cycles like:
 * - A/foo → A/foo
 * - A → B → C → A
 *
 * A link whose target passes back through the link's own position in the same
 * document (e.g. A → A/foo) makes the path grow on every hop, so the pair
 * never repeats; that shape is detected separately on the first hop.
 *
 * Growing-path cycles that span documents, e.g.
 * - A → B, B → A/foo
 *
 * are difficult to detect, since there are many legitimate cases for the
 * same link to be followed several times, so they are bounded by an upper
 * limit of `MAX_PATH_RESOLUTION_LENGTH` iterations, which throws.
 *
 * A transaction is a consistent snapshot, so resolving the same link twice
 * against one has to give the same answer, and the second walk is redundant.
 * The transaction memoizes them: it hands out a cache while it may be used, and
 * replaces it on every write, so an entry is only ever served when nothing has
 * been written since it was made. It withholds the cache entirely where a
 * resolution is not a pure function of the snapshot — once CFC is prepared,
 * where the read-after-prepare invalidation is load-bearing, and inside an
 * ambient-read-meta scope, where the same read carries different metadata.
 *
 * A hit still has to leave behind what the walk would have: the dereference
 * traces, which the transaction accumulates for the commit's digest, and the
 * sync kicks that fire on every resolution. What it does skip is the probe
 * reads, which the first resolution already journaled on this transaction —
 * the reactivity log is a set of addresses, and the second walk adds nothing
 * to it.
 *
 * The same memo holds each sigil probe on its own (`ProbeRecord`), so a walk
 * that misses as a whole still skips the probes an earlier walk through the
 * same container made: the element slot every property read passes. That is
 * most of what a wide read probes more than once, and each probe skipped is
 * one read fewer for the commit, the scheduler and the flow-label pass to
 * process.
 *
 * @param tx - The storage transaction to read from.
 * @param link - The link to read.
 * @param lastNode - The last node in the path.
 * @param options - `preserveOverwrite` keeps the `overwrite` field if needed.
 *   `onScopeBlocked` is invoked when a narrower-scope follow is blocked by a
 *   schema scope cap (the chain then terminates at an undefined-data link);
 *   it is the only way to distinguish that cut from a chain that genuinely
 *   ends at a stored undefined-data link.
 * @returns The resolved link.
 */
export function resolveLink(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  link: NormalizedFullLink,
  lastNode: LastNode = "value",
  options: {
    preserveOverwrite?: boolean;
    onScopeBlocked?: () => void;

    /**
     * Mark the transaction cfc-relevant for every crossed link whose
     * stored schema carries `ifc` (the crossing seam,
     * `markIfcBearingLinkCrossing`). Read entry points opt in; write-path
     * resolutions leave relevance to the write-policy gate.
     */
    markIfcCrossings?: boolean;
  } = {},
): ResolvedFullLink {
  return resolveLinkTracingDereferences(runtime, tx, link, lastNode, options)
    .link;
}

/**
 * {@link resolveLink}, with the dereference traces this resolution recorded.
 *
 * A caller that derives a CFC label view from those traces would otherwise
 * bracket the call and slice them back off the transaction, which reads the
 * CFC state through its read-only proxy twice per resolution — the dominant
 * cost of an element read once the resolution itself is memoized. Taking them
 * from here reads nothing.
 *
 * The traces are recorded on the transaction either way; this is the same list,
 * not an alternative to recording it.
 *
 * `memoKey` is the key this resolution was memoized under, or `undefined` where
 * the transaction memoized nothing. A caller memoizing something of its own
 * derived from the same link against the same transaction can extend it rather
 * than build a second key over the same fields — and gets the transaction's
 * "may I memoize at all" answer with it.
 */
export function resolveLinkTracingDereferences(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  link: NormalizedFullLink,
  lastNode: LastNode = "value",
  options: {
    preserveOverwrite?: boolean;
    onScopeBlocked?: () => void;

    /**
     * Mark the transaction cfc-relevant for every crossed link whose
     * stored schema carries `ifc` (the crossing seam,
     * `markIfcBearingLinkCrossing`). Read entry points opt in; write-path
     * resolutions leave relevance to the write-policy gate.
     */
    markIfcCrossings?: boolean;
  } = {},
): {
  link: ResolvedFullLink;
  traces: readonly CfcDereferenceTrace[];
  memoKey: string | undefined;
} {
  // The walk needs this to detect cycles; the memo needs it to name the entry.
  let addressKey = linkAddressKey(link);
  const memo = tx.getSnapshotMemo?.();
  const memoKey = memo === undefined ? "" : resolutionMemoVariant(
    link,
    lastNode,
    options.preserveOverwrite === true,
  ) + addressKey;
  const cached = memo?.get(memoKey) as LinkResolutionRecord | undefined;
  if (cached !== undefined) {
    for (const trace of cached.traces) tx.recordCfcDereferenceTrace(trace);
    if (options.markIfcCrossings === true) {
      for (const hop of cached.schemaHops) {
        markIfcBearingLinkCrossing(tx, hop.space, hop.schema, hop.id);
      }
    }
    for (const target of cached.crossSpaceTargets) {
      kickDocPull(runtime, target, false);
    }
    return {
      // A copy, so a caller that mutates what it got back cannot reach into
      // the entry the next resolution will serve.
      link: { ...cached.result } as unknown as ResolvedFullLink,
      traces: cached.traces,
      memoKey,
    };
  }

  // The sigil probe at `position` in `link`'s document, from the memo where
  // it holds one and from a read where it does not. Probe reads are shape
  // observations of link topology — flow labels must not treat them as
  // content reads (reactivity still does, so the link appearing later
  // re-resolves). A read that fails other than by `NotFoundError` reads as a
  // position holding no link, and is not memoized.
  const probeAt = (
    link: NormalizedFullLink,
    position: readonly string[],
  ): ProbeRecord => {
    const key = memo === undefined ? undefined : probeMemoKey(link, position);
    if (memo !== undefined && key !== undefined) {
      const memoized = memo.get(key) as ProbeRecord | undefined;
      if (memoized !== undefined) return memoized;
    }
    const probe = tx.read(
      toMemorySpaceAddress({
        ...link,
        path: [...position, ...linkProbeSubPath()],
      }),
      { meta: linkResolutionProbe },
    );
    let record: ProbeRecord;
    if (probe.ok) {
      record = {
        payload: linkPayloadAtProbe(probe.ok.value),
        notFound: undefined,
      };
    } else if (probe.error?.name === "NotFoundError") {
      record = {
        payload: undefined,
        notFound: (probe.error as INotFoundError).path,
      };
    } else {
      return { payload: undefined, notFound: undefined };
    }
    if (memo !== undefined && key !== undefined) memo.set(key, record);
    return record;
  };

  // The stored link at `position`, which `record` says holds one. The first
  // walk to follow it reads the whole value there — the walk depends on the
  // siblings that could replace the link, not on the probe alone — and parses
  // it; every later walk takes the parsed link from the record. The read is a
  // step of the dereference rather than a standalone reference-identity
  // observation, and it is where a reader following the reference consumes a
  // confidentiality the referring document declares at that position.
  const hopAt = (
    link: NormalizedFullLink,
    position: readonly string[],
    record: ProbeRecord,
  ): NormalizedFullLink => {
    if (record.hop === undefined) {
      const base = { ...link, path: position };
      record.hop = parseLink(tx.readValueOrThrow(base) as CellLink, base);
    }
    return record.hop;
  };

  const seen = new Set<string>();
  const traces: CfcDereferenceTrace[] = [];
  const schemaHops: {
    id: string;
    space: NormalizedFullLink["space"];
    schema: JSONSchema;
  }[] = [];
  const crossSpaceTargets: NormalizedFullLink[] = [];
  // A resolution is memoized only when replaying `traces` and
  // `crossSpaceTargets` reproduces everything it left behind. A blocked follow
  // does not: its `onScopeBlocked` and its warning belong to every resolution
  // that reaches the cut, not just the first.
  let memoizable = true;

  let iteration = 0;
  // The RULED OW51 dead-end marker (link-types.ts `pendingHopDoc`): a
  // walk that FOLLOWED at least one hop and then stopped because the
  // current doc itself is missing may be pointing into data that has
  // simply not arrived — the value at the returned link is unknowable,
  // not absent. `followedHop` distinguishes that from a first-hop read
  // of the handle's own absent doc (the ordinary first-write idiom);
  // `deadEndDocMissing` is re-decided per iteration from the sigil
  // probe's NotFoundError path (`[]` = the DOC is missing, anything
  // else = a present doc without this path).
  let followedHop = false;
  let pendingDeadEnd = false;
  // The input handle's own provenance (link-types.ts `viaLinkHop`): a
  // handle minted from a stored sigil starts AT its hop target, so a
  // first-probe dead-end there is still a dead-end behind a hop — the
  // asCell boundary consumed the hop when it minted the handle.
  const inputViaLinkHop = link.viaLinkHop === true;

  while (true) {
    let deadEndDocMissing = false;
    if (iteration++ > MAX_PATH_RESOLUTION_LENGTH) {
      logger.error("link-res-error", `Link resolution iteration limit reached`);
      throw new Error(`Link resolution iteration limit reached`);
    }

    // Detect cycles. `addressKey` always names the link this iteration starts
    // from: computed for the first before the loop, refreshed by each hop.
    const key = addressKey;
    if (seen.has(key)) {
      logger.error(
        "link-res-error",
        debugStr`Link cycle detected ${key}: $quote,long${[...seen]}`,
      );
      throw new Error(
        debugStr`Link cycle detected at ${key}: $quote,long${[...seen]}`,
      );
    }
    seen.add(key);

    // Optimized fast-path: a single sigil probe at the full remaining path.
    // If not a sigil link, use that error's path to check the parent once.
    let nextHop: LinkHop | undefined;

    const probe = probeAt(link, link.path);
    if (
      probe.payload !== undefined &&
      lastNode !== "top" &&
      (lastNode !== "writeRedirect" ||
        (probe.payload as CellLinkRefPayload).overwrite === "redirect")
    ) {
      const nextLink = hopAt(link, link.path, probe);
      nextHop = {
        link: nextLink,
        source: { ...link, path: [...link.path] },
        kind: hopKindForLink(nextLink),
        depth: link.path.length,
      };
    } else if (probe.notFound !== undefined) {
      const lastValid = probe.notFound.slice(); // [] => doc missing
      if (lastValid.length === 0) deadEndDocMissing = true;

      if (lastValid.length > 0) {
        // remove `value` prefix
        lastValid.shift();

        // remove last path element (it's valid in that it can be addressed,
        // but we want to assume it doesn't exist and look for a link there
        // instead)
        lastValid.pop();

        // A full-path candidate needs no further check: the sigil probe above
        // already covered it, and `$alias` records in data are not links.
        if (lastValid.length < link.path.length) {
          const parent = probeAt(link, lastValid);
          if (parent.payload !== undefined) {
            const nextLink = hopAt(link, lastValid, parent);
            nextHop = {
              link: nextLink,
              source: { ...link, path: [...lastValid] },
              kind: hopKindForLink(nextLink),
              depth: lastValid.length,
            };
          }
        }

        if (nextHop) {
          const remainingPath = link.path.slice(lastValid.length);
          let { schema, ...restLink } = nextHop.link;
          const storedSchema = schema;
          if (schema !== undefined && remainingPath.length > 0) {
            // The stored schema's external cid: refs must be registered
            // before the narrowing walks them; the documents travel with
            // the referring document, so they live in the referrer's
            // space. A ref the closure cannot resolve names a corrupt or
            // malformed declaration (the loader logs it): the declaration
            // is ignored — narrowing it would throw on the dangling ref.
            const closureComplete = ensureExternalSchemaClosure(
              tx,
              nextHop.source.space,
              schema,
            );
            schema = closureComplete
              ? ContextualFlowControl.getSchemaAtPath(schema, remainingPath)
              : undefined;
          }
          nextHop = {
            ...nextHop,
            ...(storedSchema !== undefined && { storedSchema }),
            link: {
              ...restLink,
              path: [...nextHop.link.path, ...remainingPath],
              ...(schema !== undefined && { schema }),
            },
          };
        }
      }
      // If still nothing found we fall through and break the loop
    }

    if (nextHop !== undefined) {
      if (!canFollowLinkHop(link, nextHop)) {
        // Blocked narrower-scope follow during link resolution — resolves to
        // undefined silently. Warn (not info) so the drop is observable; see
        // the matching site in traverse.ts followPointer (CT-1642).
        const schemaScope = schemaScopeForLinkAtDepth(link, nextHop.depth);
        logger.warn("scope: blocked narrower link follow", () => [
          `a "${schemaScope}"-scoped read cannot follow a ` +
          `"${nextHop.link.scope}"-scoped link, so it resolves to undefined. ` +
          `If this is inside a .map()/lift, resolve the narrower-scoped value ` +
          `at the top level and pass the value down.`,
          {
            schemaScope,
            linkScope: nextHop.link.scope,
            source: cfcAddressFromLink(link),
            target: cfcAddressFromLink(nextHop.link),
          },
        ]);
        options.onScopeBlocked?.();
        memoizable = false;
        link = undefinedDataLink(link);
        break;
      }
      // A link whose target passes back through the link's own position can
      // never resolve: the value at that position is the link itself, so
      // every hop re-follows it with a longer path and the (document, path)
      // cycle key never repeats. Detect this on the first hop.
      const hopSource = nextHop.source;
      const hopTarget = nextHop.link;
      if (
        hopTarget.space === hopSource.space &&
        hopTarget.id === hopSource.id &&
        hopTarget.scope === hopSource.scope &&
        hopTarget.path.length > hopSource.path.length &&
        hopSource.path.every((part, i) => hopTarget.path[i] === part)
      ) {
        const detail = `link at [${hopSource.path.join("/")}] targets its ` +
          `own subpath [${hopTarget.path.join("/")}]`;
        logger.error("link-res-error", `Link cycle detected: ${detail}`);
        throw new Error(`Link cycle detected at ${key}: ${detail}`);
      }
      traces.push(recordDereferenceHop(tx, nextHop));
      if (readStatsActive) recordLinkResolution(tx);
      followedHop = true;
      // The crossing seam's data: schema-bearing hops are collected AS
      // STORED and evaluated at mark time below (and on memo hits), for
      // callers that opt in. The stored schema decides — an ancestor hop's
      // narrowing can reduce the traveling schema to nothing while the
      // declaration stands — and the SOURCE space names where the stored
      // link (and so its schema's closure documents) lives.
      const crossingSchema = nextHop.storedSchema ?? nextHop.link.schema;
      if (crossingSchema !== undefined) {
        schemaHops.push({
          id: nextHop.link.id,
          space: nextHop.source.space,
          schema: crossingSchema,
        });
      }
      const crossSpace = nextHop.link.space !== link.space;
      const nextLink = nextHop.link;
      // Precedence and defaults depend on what a reference declares, in
      // either space. The traveling schema keeps its reference form until
      // a space boundary requires a self-contained representation.
      let declaration = nextLink.schema;
      if (
        isObjectOrArray(declaration) && typeof declaration.$ref === "string"
      ) {
        declaration = ensureExternalSchemaClosure(
            tx,
            nextHop.source.space,
            declaration,
          )
          ? ContextualFlowControl.resolveSchemaRefs(declaration) ?? false
          : false;
      }
      // The hop consumed `nextHop.depth` of our path and re-rooted the rest
      // under the target. Caps recorded for the consumed prefix have done
      // their job; caps for the REMAINING segments still have to travel, or a
      // capped handle below an already-followed link goes unchecked -- the
      // shape you get whenever a cell's root value is a link. `nextHop.link`
      // comes from `parseLink` and carries no caps of its own, so rebasing is
      // just a shift onto the target's path.
      const carriedCaps = rebaseScopeCaps(
        link.scopeCaps,
        nextHop.depth,
        // A cap at old depth k lands at (target base length) + (k - depth).
        // target base length = nextHop.link.path.length - (path.length - depth),
        // so the shift reduces to target-path length minus our own.
        nextHop.link.path.length - link.path.length,
      );
      // A stored schema that is only a stream's declaration adds nothing to
      // a carried schema that already declares the stream, and that one can
      // also type the event, so it keeps carrying.
      const carriedDeclaresStoredStream = declaration !== undefined &&
        ContextualFlowControl.isTrueSchema(declaration) &&
        ContextualFlowControl.declaresStream(link.schema);
      if (
        link.schema !== undefined &&
        (schemaConstrainsNothing(declaration) || carriedDeclaresStoredStream)
      ) {
        // `default` still inherits from the last declaration even when the
        // stored schema is otherwise unconstrained — a top-level `default`
        // is trivially true, and narrowing can reduce a stored schema to
        // one. A false carried schema stays false: the reader selected
        // nothing, so no default stands in.
        const storedDefault = isObjectOrArray(declaration)
          ? declaration.default
          : undefined;
        const carriedSchema = storedDefault !== undefined &&
            !ContextualFlowControl.isFalseSchema(link.schema)
          ? internSchema(
            isObjectOrArray(link.schema)
              ? { ...link.schema, default: storedDefault }
              : { default: storedDefault },
          )
          : link.schema;
        link = {
          ...nextLink,
          schema: carriedSchema,
          ...(carriedCaps !== undefined && { scopeCaps: carriedCaps }),
        };
      } else {
        link = carriedCaps === undefined
          ? nextLink
          : { ...nextLink, scopeCaps: carriedCaps };
      }
      if (crossSpace) {
        link = {
          ...link,
          schema: schemaForSpaceCrossing(tx, nextHop.source.space, link.schema),
        };
      }
      const mgr = runtime.storageManager;
      const reserved = !crossSpace &&
        mgr.shouldPullDoc?.(link.space, link.id, link.scope) === true;
      if (crossSpace || reserved) {
        // Only the cross-space kick is replayed. A same-space one is taken
        // against a reservation, so a second resolution of this link would not
        // kick it either — and if the sync fails and retracts the reservation,
        // the read that retries is in a later transaction with its own memo.
        if (crossSpace) crossSpaceTargets.push(link);
        kickDocPull(runtime, link, reserved);
      }
      addressKey = linkAddressKey(link);
    } else {
      // The walk stops here. When it stops because the CURRENT doc is
      // missing AND we got here by following a hop, the chain may
      // continue inside the unarrived doc — mark the result pending
      // (see the declaration above; the lazy read boundary refuses on
      // it). A stop at a PRESENT doc, or on the handle's own root doc,
      // is an honest end.
      //
      // SPACE scope only: a missing USER- or SESSION-scoped row is
      // KNOWLEDGE, not transit — a principal's instance row exists only
      // once that principal writes it (the scoped first-write idiom),
      // and the fan-out run supply materializes instances by running
      // derivations over exactly such absent rows, so a refusal here
      // starves every first materialization whose scoped input carries
      // no schema default. Composition must not change the verdict
      // either: relaying a per-user cell through a nested pattern's arg
      // doc stores a sigil, which makes the child's handle data-derived
      // — the same absent row that reads `undefined` through the flat
      // form must read `undefined` through the relay.
      if (
        (followedHop || inputViaLinkHop) && deadEndDocMissing &&
        link.scope === "space"
      ) {
        pendingDeadEnd = true;
      }
      break;
    }
  }

  // The crossing seam: every schema-bearing hop a content-reading
  // resolution (the callers that opt in) crossed marks off its stored
  // schema. Evaluation happens here at mark time, and the memoized record
  // replays the same hops per call.
  if (options.markIfcCrossings === true) {
    for (const hop of schemaHops) {
      markIfcBearingLinkCrossing(tx, hop.space, hop.schema, hop.id);
    }
  }

  const result = { ...link } satisfies NormalizedFullLink;
  // Clear the input's stale `pendingHopDoc` before deciding this walk's own
  // (Finding 2): a successful walk that followed no hop spreads the input's
  // stamp, and nothing else unsets it — a later read of a now-present doc
  // through a handle minted from a once-pending result would then refuse an
  // honest value. Only THIS walk's dead-end verdict may set it.
  delete result.pendingHopDoc;
  if (pendingDeadEnd) result.pendingHopDoc = true;
  // A post-hop result is itself data-derived: a handle minted from it
  // (the asCell boundary) carries the provenance its later reads need.
  if (followedHop || inputViaLinkHop) result.viaLinkHop = true;

  // Intern the schema at this single link-resolution exit so downstream
  // consumers see an identity-canonical, deep-frozen schema reference.
  // `getSchemaAtPath` (called within the loop above) can emit freshly-
  // constructed schemas; interning here collapses structurally-equal
  // outputs to the same `===` reference across calls, letting
  // identity-based caches downstream hit rather than miss.
  result.schema = internSchema(result.schema);

  // Remove overwrite field, i.e. when the last followed link was a write
  // redirect. The idea is that this is a link pointing to the final value, it
  // doesn't matter how we got there.
  if (!options.preserveOverwrite) {
    delete result.overwrite;
  }

  if (memoizable) {
    // The entry keeps its own copy, for the same reason a hit hands one out:
    // this caller owns what it is about to be returned.
    memo?.set(
      memoKey,
      {
        result: { ...result },
        traces,
        schemaHops,
        crossSpaceTargets,
      } satisfies LinkResolutionRecord,
    );
  }

  // The casting is a workaround for the branding, we don't actually want to add
  // the symbol to the result.
  return {
    link: result as unknown as ResolvedFullLink,
    traces,
    memoKey: memo !== undefined && memoizable ? memoKey : undefined,
  };
}

/**
 * Read a value that might be a link.
 *
 * We're first checking for the deeper link paths, so that we're not reactive to
 * other changes in the doc. If it looks like it could be a link, read the whole
 * value, which might include siblings to the "/" and thus make the link
 * invalid. In these cases, we do need to be reactive to all changes there.
 *
 * Both reads observe which reference sits at the position. The second runs
 * only once the first has found a sigil payload beneath it, and what the
 * function hands back is the parsed link alone, so nothing beyond the
 * reference reaches the caller. They are journaled as reference-identity
 * observations (`linkResolutionProbe`): they consume a pointer's own label and
 * none of the content labels at the position, and they stay in the journal for
 * reactivity.
 *
 * @param tx - The storage transaction to read from.
 * @param link - The link to read.
 * @param onlyWriteRedirects - Whether to only read write redirects.
 * @returns The value that might be a link.
 */
export function readMaybeLink(
  tx: IExtendedStorageTransaction,
  link: NormalizedFullLink,
  onlyWriteRedirects = false,
): NormalizedFullLink | undefined {
  const readSubPath = (extraPath: readonly string[]) =>
    tx.readValueOrThrow({ ...link, path: [...link.path, ...extraPath] }, {
      meta: linkResolutionProbe,
    });

  const maybeSigilPayload = linkPayloadAtProbe(readSubPath(linkProbeSubPath()));
  if (
    // Sigil link: { "/": { "link@1": { id: <id>, ... } } }
    maybeSigilPayload !== undefined &&
    (!onlyWriteRedirects ||
      (maybeSigilPayload as CellLinkRefPayload).overwrite === "redirect")
  ) {
    return parseLink(readSubPath([]) as CellLink, link);
  } else {
    return undefined;
  }
}
