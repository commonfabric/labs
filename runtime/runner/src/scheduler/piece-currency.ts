/**
 * What a serving loop records of one piece for the currency index
 * (docs/specs/server-side-execution/serving-loop.md §3b), read off the
 * scheduler's own state: what the piece's live computations read, what its
 * computations declare they write, which document instances the clean ones
 * vouch for, and whether the piece can be vouched for at all.
 */

import type { ScopeKey } from "@commonfabric/memory/v2";
import { entityKindOfIdString } from "../entity-kind.ts";
import { normalizeCellScope } from "../scope.ts";
import type { IMemorySpaceAddress, MemorySpace } from "../storage/interface.ts";
import { isLive, type SchedulerLivenessState } from "./dependency-graph.ts";
import { entityNameKey } from "./keys.ts";
import type { NodeRegistry, SchedulerNode } from "./node-record.ts";
import type { SchedulerWriteIndex } from "./scheduling-writes.ts";
import type { Action, ReactivityLog, TelemetryAnnotations } from "./types.ts";

/** One piece as the scheduler holds it at an instant. */
export type PieceCurrencySnapshot = {
  /** The raw id of the piece's result document. */
  piece: string;

  /** The pieces that enclose this one. */
  under: string[];

  /**
   * Whether every live node of the piece is clean in every instance it runs,
   * the piece's root is space-scoped, and everything it reads and writes is
   * in its own space with a writer that names a piece.
   */
  vouched: boolean;

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
  if (key === "space") return ["space"];
  const [kind, principal] = key.split(":");
  return kind === "session"
    ? [key, `user:${principal}` as ScopeKey, "space"]
    : [key, "space"];
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
  let vouched = identity.pieceId.startsWith("space:");
  const under = (identity.demandRootIds ?? []).filter((id) => id !== piece);
  const reads = new Map<string, Pick<IMemorySpaceAddress, "space" | "id">>();
  const writes = new Set<string>();
  const vouches = new Map<string, { id: string; scopeKey: ScopeKey }>();

  for (const node of nodes) {
    const surface = state.writeIndex.getSchedulingWrites(node.action) ?? [];
    for (const write of surface) {
      if (write.space !== space) {
        vouched = false;
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
      vouched = false;
      continue;
    }
    for (const write of surface) {
      if (write.space !== space) continue;
      const keys: ScopeKey[] = node.fanOut !== undefined
        ? [...node.fanOut.clean].flatMap(chainOf)
        : normalizeCellScope(write.scope) === "space"
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
      vouched = false;
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
        if (identityOf(writer)?.pieceRootId === undefined) vouched = false;
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
    vouched,
    reads: readRows,
    writes: [...writes],
    vouches: [...vouches.values()],
  };
}
