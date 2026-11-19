/**
 * What a serving loop records of one piece for the currency index
 * (docs/specs/server-side-execution/serving-loop.md §3b), read off the
 * scheduler's own state: what the piece's live computations read, what its
 * computations declare they write, which document instances the clean ones
 * vouch for, and whether the piece can be vouched for at all.
 */

import {
  canResolveScopeKey,
  identityOfScopeKey,
  resolveScopeKey,
  type ScopeKey,
  type ScopeKeyIdentity,
  scopeOfScopeKey,
} from "@commonfabric/memory/v2";
import { entityKindOfIdString } from "../entity-kind.ts";
import type { CellScope } from "../builder/types.ts";
import { normalizeCellScope, scopeRank } from "../scope.ts";
import type { IMemorySpaceAddress, MemorySpace } from "../storage/interface.ts";
import { isLive, type SchedulerLivenessState } from "./dependency-graph.ts";
import { entityNameKey } from "./keys.ts";
import type { NodeRegistry, SchedulerNode } from "./node-record.ts";
import type { SchedulerWriteIndex } from "./scheduling-writes.ts";
import type { Action, ReactivityLog, TelemetryAnnotations } from "./types.ts";

/** One reason a piece cannot be vouched for. */
export type PieceUnvouchedReason =
  /** The piece's root is narrower than the space. */
  | "scoped-root"
  /** A computation of the piece declares a write in another space. */
  | "foreign-write"
  /** A live computation of the piece is not clean in some instance. */
  | "not-clean"
  /** A live computation of the piece read a document in another space. */
  | "foreign-read"
  /** A live computation read a document whose writer names no piece. */
  | "unattributed-writer";

/** One piece as the scheduler holds it at an instant. */
export type PieceCurrencySnapshot = {
  /** The raw id of the piece's result document. */
  piece: string;

  /** The pieces that enclose this one. */
  under: string[];

  /**
   * Why the piece cannot be vouched for, empty when it can: every live node
   * of it is clean in every instance it runs, its root is space-scoped, and
   * everything it reads and writes is in its own space with a writer that
   * names a piece.
   */
  unvouched: PieceUnvouchedReason[];

  /** The documents the piece's live nodes read. */
  reads: Array<{ space: MemorySpace; id: string; derived: boolean }>;

  /** The ids in the declared write surface of every node of the piece. */
  writes: string[];

  /** The document instances the live, clean nodes of the piece write. */
  vouches: Array<{ id: string; scopeKey: ScopeKey }>;
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
};

/** The scope names a document id can have a writer registered under. */
const SCOPE_NAMES = ["space", "user", "session"] as const;

/** The observation identity `action` carries, if any. */
const identityOf = (action: Action) =>
  (action as Partial<TelemetryAnnotations>).schedulerObservationIdentity;

/**
 * The scope keys a run at the instance `key` writes at: `key` itself, and the
 * broader slots on its chain, which hold the redirects that lead to it.
 */
const chainOf = (key: ScopeKey): ScopeKey[] => {
  if (scopeOfScopeKey(key) !== "session") {
    return key === "space" ? ["space"] : [key, "space"];
  }
  const identity = identityOfScopeKey(key);
  return identity === undefined
    ? [key, "space"]
    : [key, resolveScopeKey("user", identity), "space"];
};

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
  return chainOf(value).filter((slot) =>
    scopeRank(scopeOfScopeKey(slot)) >= scopeRank(declared)
  );
};

/** Whether `node` is clean in every instance it runs. */
const isCleanThroughout = (node: SchedulerNode): boolean => {
  if (node.status !== "clean") return false;
  const fanOut = node.fanOut;
  if (fanOut === undefined) return true;
  for (const key of fanOut.instances.keys()) {
    if (!fanOut.clean.has(key)) return false;
  }
  return true;
};

/**
 * Snapshots the piece whose result document is `piece`, in `space`, or
 * returns `undefined` when no active node names it as its piece.
 */
export function snapshotPieceCurrency(
  state: PieceCurrencyState,
  space: MemorySpace,
  piece: string,
): PieceCurrencySnapshot | undefined {
  const nodes = state.nodes.nodesUnderDemandRoots([piece]).filter((node) =>
    identityOf(node.action)?.pieceRootId === piece
  );
  if (nodes.length === 0) return undefined;
  const identity = identityOf(nodes[0].action)!;
  const unvouched = new Set<PieceUnvouchedReason>();
  if (!identity.pieceId.startsWith("space:")) unvouched.add("scoped-root");
  const under = (identity.demandRootIds ?? []).filter((id) => id !== piece);
  const reads = new Map<string, Pick<IMemorySpaceAddress, "space" | "id">>();
  const writes = new Set<string>();
  const vouches = new Map<string, { id: string; scopeKey: ScopeKey }>();

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
    const logs = [
      state.dependencies.get(node.action),
      ...[...(node.fanOut?.instances.values() ?? [])].map((instance) =>
        instance.log
      ),
    ];
    for (const log of logs) {
      if (log === undefined) continue;
      for (const read of [...log.reads, ...log.shallowReads]) {
        reads.set(`${read.space}\0${read.id}`, {
          space: read.space,
          id: read.id,
        });
      }
    }
    if (!isCleanThroughout(node)) {
      unvouched.add("not-clean");
      continue;
    }
    for (const write of surface) {
      if (write.space !== space) continue;
      const declared = normalizeCellScope(write.scope);
      const keys: ScopeKey[] = node.fanOut !== undefined
        ? [...node.fanOut.clean].flatMap((key) =>
          writtenKeys(declared, key, node.fanOut!.instances.get(key)?.identity)
        )
        : declared === "space"
        ? ["space"]
        : [];
      for (const scopeKey of keys) {
        vouches.set(`${scopeKey}\0${write.id}`, { id: write.id, scopeKey });
      }
    }
  }

  const readRows: PieceCurrencySnapshot["reads"] = [];
  for (const read of reads.values()) {
    if (read.space !== space) {
      unvouched.add("foreign-read");
      readRows.push({ ...read, derived: false });
      continue;
    }
    let written = false;
    for (const scope of SCOPE_NAMES) {
      const writers = state.writeIndex.writersByEntity.get(
        entityNameKey({ space: read.space, id: read.id, scope }),
      );
      if (writers === undefined) continue;
      for (const writer of writers) {
        written = true;
        // A writer that names no piece is one no record covers, so nothing
        // says whether what it wrote is current.
        if (identityOf(writer)?.pieceRootId === undefined) {
          unvouched.add("unattributed-writer");
        }
      }
    }
    readRows.push({
      ...read,
      derived: written || entityKindOfIdString(read.id) === "computed",
    });
  }

  return {
    piece,
    under,
    unvouched: [...unvouched],
    reads: readRows,
    writes: [...writes],
    vouches: [...vouches.values()],
  };
}
