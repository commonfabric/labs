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
import { fanOutHoldsSlot } from "./fan-out.ts";
import { entityNameKey } from "./keys.ts";
import type { NodeRegistry, SchedulerNode } from "./node-record.ts";
import type { SchedulerWriteIndex } from "./scheduling-writes.ts";
import type { Action, ReactivityLog, TelemetryAnnotations } from "./types.ts";

/** One reason a piece, or one slice of it, cannot be vouched for. */
export type PieceUnvouchedReason =
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
  | "unattributed-writer";

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
   * computation that ran at its key is clean, and everything they read has
   * no writer the slice cannot answer for, and is in the piece's space or is
   * one instance of a document of another space, the shared one, a user's
   * or a session's, that the snapshot names the seq of.
   */
  unvouched: PieceUnvouchedReason[];

  /**
   * The time, in milliseconds since the epoch, from which the slice is no
   * longer current whatever the store holds: the tick after the one a
   * clock's document held when one of its live computations read it.
   * Absent for a slice that read none.
   */
  expiresAt?: number;

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

  /**
   * The instances at another key that hold what a live, clean computation
   * of the slice wrote: the redirect a run made for one viewer leaves at
   * the user's and the space's key, on its way up to the scope the document
   * is declared at, and the narrower instance a run at a broader key wrote
   * for the identity it ran under. What such a slot holds was decided by
   * the run, so it is answered for here. A slot a later run wrote the same
   * holds what both wrote, and is named by both.
   */
  decides: Array<{ id: string; scopeKey: ScopeKey }>;

  /**
   * The instances at another key that a live, clean computation of the
   * slice wrote and that something has changed since, another viewer's run
   * as a rule. Such a slot holds that later write, so the slice answers for
   * it no longer, and a viewer of the slice who demands it is to have the
   * computation run again.
   */
  superseded: Array<{ id: string; scopeKey: ScopeKey }>;
};

/** One piece as the scheduler holds it at an instant. */
export type PieceCurrencySnapshot = {
  /** The raw id of the piece's result document. */
  piece: string;

  /**
   * The scope the piece's result document is declared at. Each viewer
   * holds an instance of their own of one narrower than the space.
   */
  rootScope: CellScope;

  /** The pieces that enclose this one. */
  under: string[];

  /**
   * Why no slice of the piece can be vouched for, empty when one can:
   * everything it writes is in its own space.
   */
  unvouched: PieceUnvouchedReason[];

  /** The ids in the declared write surface of every node of the piece. */
  writes: string[];

  /**
   * The slices a live computation of the piece ran at. A slice none ran at
   * is not among them, the `space` slice included: the snapshot has nothing
   * to say of it, and the index keeps or replaces the one it holds by that
   * slice's own mark (`storeCurrencyRecords()`).
   */
  slices: PieceCurrencySlice[];

  /**
   * Whether a live computation of the piece read, in its own space, a
   * derived document that no computation registered on the runtime writes:
   * the output of a piece that is not started there. Nothing on the runtime
   * recomputes such a document when its inputs change.
   */
  readsUnstarted: boolean;
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
   * The documents a clock writes, each as `clockDocumentKey()` gives it.
   * What a computation derives from such a document is current only until
   * the tick after the one it read, and a tick takes a runtime that holds
   * the clock.
   */
  clockDocuments: ReadonlyMap<string, ClockDocument>;

  /**
   * The seq of another space's store at which this runtime's replica of it
   * holds the instance of the document at `address` that `scopeKey` names:
   * the shared one, a user's, or a session's. `undefined` where it cannot
   * say.
   */
  sourceSeqOf: (
    address: Pick<IMemorySpaceAddress, "space" | "id"> & { scopeKey: string },
  ) => number | undefined;
};

/** A document a clock writes, as `PieceCurrencyState.clockDocuments` holds it. */
export type ClockDocument = {
  /** The interval of the clock's ticks, in milliseconds. */
  intervalMs: number;

  /**
   * Returns the tick the document holds, in milliseconds since the epoch,
   * or `undefined` where it holds none. With the scheduler idle and a
   * reading computation clean, that is the tick the computation read.
   */
  read: () => number | undefined;
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

  /**
   * Whether the instance of the document `id` at `scopeKey`, a key other
   * than the run's, holds what the run left there.
   */
  holds: (scopeKey: ScopeKey, id: string) => boolean;
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
      holds: () => true,
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
    holds: (scopeKey, id) => fanOutHoldsSlot(fanOut, key, scopeKey, id),
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
  // The piece's id is its result document's, after the scope key of the
  // instance this runtime registered it under.
  const rootScope = scopeOfScopeKey(
    identity.pieceId.slice(
      0,
      identity.pieceId.length - piece.length - 1,
    ) as ScopeKey,
  );
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

    /** The broader slots the slice's runs wrote, by scope key and id. */
    decides: Map<string, { id: string; scopeKey: ScopeKey }>;

    /** Those of them that hold a later write, by scope key and id. */
    superseded: Map<string, { id: string; scopeKey: ScopeKey }>;
    expiresAt?: number;
  }>();
  const sliceAt = (key: ScopeKey) => {
    let slice = slices.get(key);
    if (slice === undefined) {
      slice = {
        unvouched: new Set(),
        reads: new Map(),
        vouches: new Set(),
        decides: new Map(),
        superseded: new Map(),
      };
      slices.set(key, slice);
    }
    return slice;
  };

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
        // What a run wrote is answered for in the run's own slice: the
        // instance at its key as one it vouches for, and each instance at
        // another key, a redirect at a broader one among them, as a slot it
        // decides. A slot something changed since holds that later write.
        for (const key of keys) {
          if (key === run.key) {
            slice.vouches.add(write.id);
            continue;
          }
          const slots = run.holds(key, write.id)
            ? slice.decides
            : slice.superseded;
          slots.set(`${key}\0${write.id}`, { id: write.id, scopeKey: key });
        }
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

  let readsUnstarted = false;
  const taken: PieceCurrencySnapshot = {
    piece,
    rootScope,
    under,
    unvouched: [...unvouched],
    writes: [...writes],
    readsUnstarted,
    slices: [...slices].map(([key, slice]) => {
      const reads: PieceCurrencySlice["reads"] = [];
      // A read taken over from a writer that names no piece joins the map
      // while it is walked, and is walked in its turn.
      for (const read of slice.reads.values()) {
        if (read.space !== space) {
          // What says whether the instance moved since is its own space's
          // index, which is asked with the seq it was read at. The replica
          // holds that seq now: it tells the scheduler of a frame in the turn
          // it applies one, so a run that is clean with the scheduler idle
          // read, at the paths it read, the version the replica holds. A
          // read that names no one instance has no seq to be asked with.
          const seq = read.scopeKey === ANY_INSTANCE
            ? undefined
            : state.sourceSeqOf(read);
          if (seq === undefined) slice.unvouched.add("foreign-read");
          reads.push({
            ...read,
            derived: false,
            ...(seq !== undefined && { seq }),
          });
          continue;
        }
        const clock = state.clockDocuments.get(clockDocumentKey(read));
        if (clock !== undefined) {
          // The time is counted from the tick that was read rather than
          // from now: a clock whose tick is late holds a value that is out
          // of date already. A clock that holds no tick vouches for no
          // time at all.
          const tick = clock.read();
          const expiresAt = tick === undefined ? 0 : tick + clock.intervalMs;
          slice.expiresAt = Math.min(slice.expiresAt ?? Infinity, expiresAt);
        }
        const { attributed, unattributed } = writersOf(read.id);
        if (
          !attributed && unattributed.length === 0 &&
          !writes.has(read.id) &&
          entityKindOfIdString(read.id) === "computed"
        ) readsUnstarted = true;
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
        decides: [...slice.decides.values()],
        // A slot one computation of the slice still holds is the slice's,
        // whatever another of its computations wrote there before.
        superseded: [...slice.superseded].filter(([slot]) =>
          !slice.decides.has(slot)
        ).map(([, instance]) => instance),
        ...(slice.expiresAt !== undefined && { expiresAt: slice.expiresAt }),
      };
    }),
  };
  taken.readsUnstarted = readsUnstarted;
  state.nodes.setAnsweredFor(piece, answeredFor);
  return taken;
}
