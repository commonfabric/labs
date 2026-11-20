/**
 * What a serving loop records of one piece for the currency index
 * (docs/specs/server-side-execution/serving-loop.md §3b), read off the
 * scheduler's own state: what the piece's live computations read, what its
 * computations declare they write, which document instances the clean ones
 * vouch for, and whether the piece can be vouched for at all.
 */

import {
  canResolveScopeKey,
  resolveScopeKey,
  type ScopeKey,
  type ScopeKeyIdentity,
  scopeOfScopeKey,
} from "@commonfabric/memory/v2";
import {
  ANY_INSTANCE,
  sliceChain,
} from "@commonfabric/memory/v2/currency-keys";
import { entityKindOfIdString } from "../entity-kind.ts";
import type { CellScope } from "../builder/types.ts";
import { normalizeCellScope, scopeRank } from "../scope.ts";
import type { IMemorySpaceAddress, MemorySpace } from "../storage/interface.ts";
import { isLive, type SchedulerLivenessState } from "./dependency-graph.ts";
import { entityNameKey } from "./keys.ts";
import type { NodeRegistry, SchedulerNode } from "./node-record.ts";
import type { SchedulerWriteIndex } from "./scheduling-writes.ts";
import type { Action, ReactivityLog, TelemetryAnnotations } from "./types.ts";

/** One reason a piece, or one slice of it, cannot be vouched for. */
export type PieceUnvouchedReason =
  /** The piece's root is narrower than the space. */
  | "scoped-root"
  /** A computation of the piece declares a write in another space. */
  | "foreign-write"
  /** A live computation of the slice is not clean. */
  | "not-clean"
  /**
   * A live computation of the slice read a document in another space, at an
   * instance or a seq the snapshot cannot name.
   */
  | "foreign-read"
  /**
   * A live computation of the slice read a document whose writer names no
   * piece and cannot be answered for: it is not live, not clean, or runs
   * once for each viewer.
   */
  | "unattributed-writer"
  /** A live computation of the slice read a document a clock writes. */
  | "clock-read";

/**
 * One slice of a piece: what its computations did when they ran at one scope
 * key, `space` for a run every viewer shares and a user's or a session's key
 * for a run made for that viewer.
 */
export type PieceCurrencySlice = {
  /** The scope key the slice's computations ran at. */
  key: ScopeKey;

  /**
   * Why the slice cannot be vouched for, empty when it can: every live
   * computation that ran at its key is clean, and everything they read is no
   * document a clock writes, has no writer the slice cannot answer for, and
   * is in the piece's space or is a shared instance of another space that
   * the snapshot names the seq of.
   */
  unvouched: PieceUnvouchedReason[];

  /**
   * The document instances the slice's live computations read, and those a
   * writer that names no piece read to write one of them. `scopeKey` is
   * `ANY_INSTANCE` for a read whose instance the run does not name. `seq`
   * is, for a read in another space, the seq of that space this runtime's
   * replica of it holds the instance at.
   */
  reads: Array<
    {
      space: MemorySpace;
      id: string;
      scopeKey: string;
      derived: boolean;
      seq?: number;
    }
  >;

  /**
   * The ids of the documents whose instance at the slice's key a live, clean
   * computation of the piece wrote.
   */
  vouches: string[];
};

/** One piece as the scheduler holds it at an instant. */
export type PieceCurrencySnapshot = {
  /** The raw id of the piece's result document. */
  piece: string;

  /** The pieces that enclose this one. */
  under: string[];

  /**
   * Why no slice of the piece can be vouched for, empty when one can: its
   * root is space-scoped and everything it writes is in its own space.
   */
  unvouched: PieceUnvouchedReason[];

  /** The ids in the declared write surface of every node of the piece. */
  writes: string[];

  /**
   * The slices the piece's computations ran at, and each broader slice one
   * of them wrote a redirect in. The `space` slice is always among them.
   */
  slices: PieceCurrencySlice[];
};

/** The scheduler state a snapshot reads. */
export type PieceCurrencyState = {
  nodes: NodeRegistry;
  liveness: SchedulerLivenessState;
  dependencies: WeakMap<Action, ReactivityLog>;
  writeIndex: Pick<
    SchedulerWriteIndex,
    "writersByEntity" | "getSchedulingWrites"
  >;

  /**
   * The documents a clock writes, each as `clockDocumentKey()` gives it. What
   * a computation derives from one is current only until the clock's next
   * tick, and a tick takes a runtime that holds the clock.
   */
  clockDocuments: ReadonlySet<string>;

  /**
   * The seq of another space's store at which this runtime's replica of it
   * holds the shared instance of the document at `address`, or `undefined`
   * where it cannot say.
   */
  sourceSeqOf: (
    address: Pick<IMemorySpaceAddress, "space" | "id">,
  ) => number | undefined;
};

/** The key `PieceCurrencyState.clockDocuments` holds a document under. */
export const clockDocumentKey = (
  address: Pick<IMemorySpaceAddress, "space" | "id">,
): string => `${address.space}\0${address.id}`;

/** The scope names a document id can have a writer registered under. */
const SCOPE_NAMES = ["space", "user", "session"] as const;

/** The observation identity `action` carries, if any. */
const identityOf = (action: Action) =>
  (action as Partial<TelemetryAnnotations>).schedulerObservationIdentity;

/**
 * The scope keys a clean run at the instance `key`, resolved under
 * `identity`, wrote a document declared at the scope `declared` at. The
 * value lands at the narrower of the run's instance and the declared scope
 * as the run's identity resolves it, and each slot from there up to the
 * declared scope holds the redirect that leads to it. Empty where the
 * declared scope is narrower than the run's and the identity cannot name it.
 */
const writtenKeys = (
  declared: CellScope,
  key: ScopeKey,
  identity: ScopeKeyIdentity | undefined,
): ScopeKey[] => {
  let value = key;
  if (scopeRank(declared) > scopeRank(scopeOfScopeKey(key))) {
    if (identity === undefined || !canResolveScopeKey(declared, identity)) {
      return [];
    }
    value = resolveScopeKey(declared, identity);
  }
  return (sliceChain(value) as ScopeKey[]).filter((slot) =>
    scopeRank(scopeOfScopeKey(slot)) >= scopeRank(declared)
  );
};

/**
 * The scope key of the instance a run under `identity` read at `read`, or
 * `ANY_INSTANCE` where neither the read nor the run names it.
 */
const instanceRead = (
  read: Pick<IMemorySpaceAddress, "scope" | "scopeKey">,
  identity: ScopeKeyIdentity | undefined,
): string => {
  if (read.scopeKey !== undefined) return read.scopeKey;
  const scope = normalizeCellScope(read.scope);
  if (scope === "space") return "space";
  return identity !== undefined && canResolveScopeKey(scope, identity)
    ? resolveScopeKey(scope, identity)
    : ANY_INSTANCE;
};

/** One run of a node: the scope key it ran at, and what that run left. */
type NodeRun = {
  key: ScopeKey;
  identity: ScopeKeyIdentity | undefined;
  log: ReactivityLog | undefined;
  clean: boolean;
};

/**
 * The runs `node` holds: one at `space` for a node that runs once, and one
 * for each instance of a node that runs for each demander.
 */
const runsOf = (state: PieceCurrencyState, node: SchedulerNode): NodeRun[] => {
  const fanOut = node.fanOut;
  if (fanOut === undefined) {
    return [{
      key: "space",
      identity: undefined,
      log: state.dependencies.get(node.action),
      clean: node.status === "clean",
    }];
  }
  // The node's one status is invalid while any instance is owed a run. Which
  // instances are current is what its per-instance record says: every
  // invalidation dirties the keys it covers there (`markInvalid()`), so one
  // viewer's stale instance does not make another's unclean.
  return [...fanOut.instances].map(([key, instance]) => ({
    key,
    identity: instance.identity,
    log: instance.log,
    clean: fanOut.clean.has(key),
  }));
};

/**
 * Snapshots the piece whose result document is `piece`, in `space`, or
 * returns `undefined` when no active node names it as its piece. Tells
 * `state.nodes` of each computation that names no piece and whose output the
 * piece read, so that a change to one reports the piece as changed.
 */
export function snapshotPieceCurrency(
  state: PieceCurrencyState,
  space: MemorySpace,
  piece: string,
): PieceCurrencySnapshot | undefined {
  const nodes = state.nodes.nodesUnderDemandRoots([piece]).filter((node) =>
    identityOf(node.action)?.pieceRootId === piece
  );
  if (nodes.length === 0) {
    state.nodes.setAnsweredFor(piece, new Set());
    return undefined;
  }
  const identity = identityOf(nodes[0].action)!;
  const unvouched = new Set<PieceUnvouchedReason>();
  if (!identity.pieceId.startsWith("space:")) unvouched.add("scoped-root");
  const under = (identity.demandRootIds ?? []).filter((id) => id !== piece);
  const writes = new Set<string>();

  /** What each slice gathers, by its scope key. */
  const slices = new Map<ScopeKey, {
    unvouched: Set<PieceUnvouchedReason>;
    reads: Map<
      string,
      Pick<IMemorySpaceAddress, "space" | "id"> & { scopeKey: string }
    >;
    vouches: Set<string>;
  }>();
  const sliceAt = (key: ScopeKey) => {
    let slice = slices.get(key);
    if (slice === undefined) {
      slice = { unvouched: new Set(), reads: new Map(), vouches: new Set() };
      slices.set(key, slice);
    }
    return slice;
  };
  sliceAt("space");

  for (const node of nodes) {
    const surface = state.writeIndex.getSchedulingWrites(node.action) ?? [];
    for (const write of surface) {
      if (write.space !== space) {
        unvouched.add("foreign-write");
        continue;
      }
      writes.add(write.id);
    }
    if (!isLive(state.liveness, node)) continue;
    for (const run of runsOf(state, node)) {
      const slice = sliceAt(run.key);
      for (
        const read of [
          ...(run.log?.reads ?? []),
          ...(run.log?.shallowReads ?? []),
        ]
      ) {
        const scopeKey = instanceRead(read, run.identity);
        slice.reads.set(`${read.space}\0${scopeKey}\0${read.id}`, {
          space: read.space,
          id: read.id,
          scopeKey,
        });
      }
      if (!run.clean) {
        slice.unvouched.add("not-clean");
        continue;
      }
      for (const write of surface) {
        if (write.space !== space) continue;
        const declared = normalizeCellScope(write.scope);
        const keys: ScopeKey[] = node.fanOut !== undefined
          ? writtenKeys(declared, run.key, run.identity)
          : declared === "space"
          ? ["space"]
          : [];
        // An instance is vouched for in the slice at its own key, which for
        // a redirect is broader than the run's.
        for (const key of keys) sliceAt(key).vouches.add(write.id);
      }
    }
  }

  /**
   * The computations that name no piece and whose output the piece read.
   * What one read can change, and it can become clean, with nothing of the
   * piece's own changing, so the piece is due a snapshot whenever one
   * changes.
   */
  const answeredFor = new Set<Action>();

  /**
   * Whether a computation that names a piece writes `id`, and the
   * computations that write it and name none.
   */
  const writersOf = (
    id: IMemorySpaceAddress["id"],
  ): { attributed: boolean; unattributed: Action[] } => {
    let attributed = false;
    const unattributed: Action[] = [];
    for (const scope of SCOPE_NAMES) {
      const writers = state.writeIndex.writersByEntity.get(
        entityNameKey({ space, id, scope }),
      );
      if (writers === undefined) continue;
      for (const writer of writers) {
        if (identityOf(writer)?.pieceRootId === undefined) {
          unattributed.push(writer);
        } else attributed = true;
      }
    }
    return { attributed, unattributed };
  };

  /**
   * What `writer`, a computation that names no piece, read, or `undefined`
   * where it cannot be answered for. No record covers such a computation, so
   * a slice that read what it wrote answers for it by taking over its reads:
   * what it wrote is current while it ran clean, once for every viewer, and
   * nothing it read has changed since.
   */
  const readsOf = (writer: Action): IMemorySpaceAddress[] | undefined => {
    answeredFor.add(writer);
    const node = state.nodes.get(writer);
    const log = state.dependencies.get(writer);
    if (
      node === undefined || log === undefined || node.fanOut !== undefined ||
      node.status !== "clean" || !isLive(state.liveness, node)
    ) return undefined;
    return [...log.reads, ...log.shallowReads];
  };

  const taken: PieceCurrencySnapshot = {
    piece,
    under,
    unvouched: [...unvouched],
    writes: [...writes],
    slices: [...slices].map(([key, slice]) => {
      const reads: PieceCurrencySlice["reads"] = [];
      // A read taken over from a writer that names no piece joins the map
      // while it is walked, and is walked in its turn.
      for (const read of slice.reads.values()) {
        if (read.space !== space) {
          // What says whether the instance moved since is its own space's
          // index, which is asked with the seq it was read at.
          const seq = read.scopeKey === "space"
            ? state.sourceSeqOf(read)
            : undefined;
          if (seq === undefined) slice.unvouched.add("foreign-read");
          reads.push({
            ...read,
            derived: false,
            ...(seq !== undefined && { seq }),
          });
          continue;
        }
        if (state.clockDocuments.has(clockDocumentKey(read))) {
          slice.unvouched.add("clock-read");
        }
        const { attributed, unattributed } = writersOf(read.id);
        const takenOver = unattributed.map(readsOf);
        if (takenOver.includes(undefined)) {
          slice.unvouched.add("unattributed-writer");
        }
        for (const inherited of takenOver) {
          for (const address of inherited ?? []) {
            const scopeKey = instanceRead(address, undefined);
            const entry = `${address.space}\0${scopeKey}\0${address.id}`;
            if (slice.reads.has(entry)) continue;
            slice.reads.set(entry, {
              space: address.space,
              id: address.id,
              scopeKey,
            });
          }
        }
        reads.push({
          ...read,
          // A document only such writers write is an input the slice
          // answers for through their reads, and no recorded piece's.
          derived: attributed || takenOver.includes(undefined) ||
            (unattributed.length === 0 &&
              entityKindOfIdString(read.id) === "computed"),
        });
      }
      return {
        key,
        unvouched: [...slice.unvouched],
        reads,
        vouches: [...slice.vouches],
      };
    }),
  };
  state.nodes.setAnsweredFor(piece, answeredFor);
  return taken;
}
