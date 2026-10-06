/**
 * Replay driver for traverse fixtures (see src/traverse-recorder.ts for the
 * fixture format and capture instructions).
 *
 * Replays the recorded `SchemaObjectTraverser.traverse()` invocations against
 * a corpus-backed read-only transaction and extracts:
 *
 * - an **oracle**: per-invocation result hashes, the set of reads issued
 *   (address + read-option flags), and the schema-tracker contents per
 *   shared context. Behavior-preserving optimizations must keep the oracle
 *   byte-identical; deliberate semantic changes regenerate the goldens.
 * - **metrics**: aggregated traverser counters. These are *not* asserted —
 *   they exist so benchmarks can attribute wins (e.g. anyOfBranches -80%).
 */

import type { SchemaPathSelector } from "@commonfabric/api";
import {
  deepFreeze,
  type FabricValue,
  hashStringOf,
} from "@commonfabric/data-model";
import { hasDataUriScheme } from "@commonfabric/data-model/codec-data-uri";

import { ExtendedStorageTransaction } from "../../src/storage/extended-storage-transaction.ts";
import type {
  IExtendedStorageTransaction,
  IMemorySpaceAddress,
  IReadOptions,
} from "../../src/storage/interface.ts";
import { load as loadDataURI } from "../../src/storage/transaction/attestation.ts";
import {
  fixtureDocKey,
  type TraverseFixture,
} from "../../src/traverse-recorder.ts";
import {
  type BaseMemoryAddress,
  CompoundCycleTracker,
  createSchemaMemo,
  createTraversalContext,
  type IAttestation,
  type IMemorySpaceValueAttestation,
  ManagedStorageTransaction,
  MapSetStringToPathSelectors,
  type ObjectStorageManager,
  SchemaObjectTraverser,
  type TraversalContext,
} from "../../src/traverse.ts";
import { readMaybeGzippedText } from "./gzip.ts";

export type ReplayInvocationOracle = {
  ok: boolean;

  /** TraverseFailure code when ok is false. */
  code?: string;

  /** Truncated structural hash of the returned value ("undefined" if so). */
  hash: string;
};

export type ReplayOracle = {
  invocations: ReplayInvocationOracle[];

  /** Sorted unique read descriptors: `space|scope|id|<json path>|flags`. */
  readSet: string[];

  /**
   * Per context id: sorted `trackerKey::selectorHash` entries. Only contexts
   * shared by multiple invocations or with traverseCells (the server query
   * path, where tracker contents drive subscriptions) are dumped — fresh
   * per-call client contexts would only mirror the read set.
   */
  schemaTrackers: Record<string, string[]>;
};

/** 96 bits of a structural hash: ample for regression detection. */
const truncatedHash = (value: FabricValue): string =>
  hashStringOf(value).slice(0, 16);

/**
 * Compact long ids (`data:` cell URIs embed entire documents)
 * to a recognizable prefix plus a structural hash, so oracle entries stay
 * cheap without losing discriminating power.
 */
const compactId = (id: string): string =>
  id.length <= 80 ? id : `${id.slice(0, 24)}#${truncatedHash(id)}`;

export type ReplayMetrics = {
  invocations: number;
  docs: number;
  traverseWithSchemaCalls: number;
  traversePointerCalls: number;
  traverseArrayCalls: number;
  traverseObjectCalls: number;
  traverseDAGCalls: number;
  anyOfBranches: number;
  anyOfFastRejects: number;
  anyOfPropertyMerges: number;
  getDocAtPathCalls: number;
  schemaMemoHits: number;
  reads: number;
};

/** Per-invocation latency sample, for tail analysis. */
export type ReplayLatencySample = {
  index: number;
  ms: number;
  selector: number;
  docId: string;

  /** Schema-call delta for this single invocation. */
  schemaCalls: number;

  /** `anyOf`-branch delta over the same invocation. */
  anyOfBranches: number;

  /** DAG-call delta over the same invocation. */
  dagCalls: number;

  /** Pointer-call delta over the same invocation. */
  pointerCalls: number;
};

export type ReplayLatencyReport = {
  p50: number;
  p90: number;
  p99: number;
  p999: number;
  max: number;
  mean: number;

  /** The N slowest invocations, slowest first. */
  slowest: ReplayLatencySample[];
};

export type ReplayResult = {
  oracle: ReplayOracle | undefined;
  metrics: ReplayMetrics;
  latency?: ReplayLatencyReport;
};

function buildLatencyReport(
  samples: ReplayLatencySample[],
  topN: number,
): ReplayLatencyReport {
  const sorted = [...samples].sort((a, b) => a.ms - b.ms);
  const at = (q: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))].ms;
  return {
    p50: at(0.5),
    p90: at(0.9),
    p99: at(0.99),
    p999: at(0.999),
    max: sorted[sorted.length - 1].ms,
    mean: sorted.reduce((a, s) => a + s.ms, 0) / sorted.length,
    slowest: sorted.slice(-topN).reverse(),
  };
}

/**
 * ObjectStorageManager over a fixture's doc corpus. Space/scope-aware
 * (ManagedStorageTransaction passes the full space address through);
 * `data:` ids resolve through the canonical attestation loader instead of
 * the corpus, exactly as live storage does.
 */
export class FixtureObjectManager implements ObjectStorageManager {
  #attestations = new Map<string, IAttestation>();

  #docs: Record<string, FabricValue>;

  constructor(docs: Record<string, FabricValue>) {
    this.#docs = docs;
  }

  load(address: BaseMemoryAddress): IAttestation | null {
    if (hasDataUriScheme(address.id)) {
      // Use the canonical data-URI attestation loader so replay matches live
      // semantics (decoded JSON rooted at path [], LRU-cached).
      const { ok } = loadDataURI(address);
      return ok ?? null;
    }
    const key = fixtureDocKey(
      address as BaseMemoryAddress & { space: string },
    );
    const cached = this.#attestations.get(key);
    if (cached !== undefined) return cached;
    const value = this.#docs[key];
    if (value === undefined) return null;
    const attestation: IAttestation = {
      address: { ...address, path: [] },
      // Live storage deep-freezes every doc at the wire-decode boundary
      // (decodeMemoryBoundary), so frozen corpus values are the faithful
      // replay shape — without this, frozen-identity fast paths in traverse
      // can never engage during replay even though they do in production.
      value: deepFreeze(value),
    };
    this.#attestations.set(key, attestation);
    return attestation;
  }
}

/** Wrap a tx so each read/readOrThrow/trackReadPaths appends to `log`. */
function wrapTxWithReadLog(
  tx: IExtendedStorageTransaction,
  log: Set<string>,
): IExtendedStorageTransaction {
  const recordRead = (
    address: IMemorySpaceAddress,
    options: IReadOptions | undefined,
    trackReadWithoutLoad = options?.trackReadWithoutLoad === true,
  ) => {
    const flags = `${options?.nonRecursive ? "n" : ""}${
      trackReadWithoutLoad ? "t" : ""
    }${options?.meta !== undefined ? "m" : ""}`;
    log.add(
      `${address.space}|${address.scope ?? "space"}|${compactId(address.id)}|${
        JSON.stringify(address.path)
      }|${flags}`,
    );
  };

  return new Proxy(tx, {
    get(target, prop) {
      if (prop === "read" || prop === "readOrThrow") {
        return (address: IMemorySpaceAddress, options?: IReadOptions) => {
          recordRead(address, options);
          // deno-lint-ignore no-explicit-any
          return (target as any)[prop](address, options);
        };
      }
      if (prop === "trackReadPaths") {
        const trackReadPaths = target.trackReadPaths;
        if (trackReadPaths === undefined) return undefined;
        return (
          address: Omit<IMemorySpaceAddress, "path">,
          paths: readonly (readonly string[])[],
          options?: Omit<IReadOptions, "trackReadWithoutLoad">,
        ) => {
          for (const path of paths) {
            recordRead({ ...address, path }, options, true);
          }
          return trackReadPaths.call(target, address, paths, options);
        };
      }
      // deno-lint-ignore no-explicit-any
      const value = (target as any)[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

// The acting identity replayed traversals resolve scoped addresses against
// (stage E) — fixtures are recorded from space-scoped runs.
const REPLAY_SCOPE_IDENTITY = {
  principal: "did:test:replay",
  sessionId: "replay-session",
};

function makeContext(traverseCells: boolean): TraversalContext {
  return createTraversalContext(
    new CompoundCycleTracker(),
    new MapSetStringToPathSelectors(true),
    REPLAY_SCOPE_IDENTITY,
    traverseCells,
  );
}

export function replayFixture(
  fixture: TraverseFixture,
  options: {
    collectOracle?: boolean;
    limit?: number;

    /** Collect per-invocation latency samples (slight timing overhead). */
    collectLatency?: boolean;
  } = {},
): ReplayResult {
  const collectOracle = options.collectOracle ?? false;
  const collectLatency = options.collectLatency ?? false;
  const latencySamples: ReplayLatencySample[] = [];
  const invocations = options.limit !== undefined
    ? fixture.invocations.slice(0, options.limit)
    : fixture.invocations;

  const manager = new FixtureObjectManager(fixture.docs);
  const managedTx = new ManagedStorageTransaction(manager);
  const rawTx = new ExtendedStorageTransaction(managedTx);
  const readLog = new Set<string>();
  const tx = collectOracle ? wrapTxWithReadLog(rawTx, readLog) : rawTx;

  const contexts = new Map<number, TraversalContext>();
  const contextUses = new Map<number, number>();
  const contextTraversesCells = new Map<number, boolean>();
  const memos = new Map<number, ReturnType<typeof createSchemaMemo>>();

  const invocationOracles: ReplayInvocationOracle[] = [];
  const metrics: ReplayMetrics = {
    invocations: invocations.length,
    docs: Object.keys(fixture.docs).length,
    traverseWithSchemaCalls: 0,
    traversePointerCalls: 0,
    traverseArrayCalls: 0,
    traverseObjectCalls: 0,
    traverseDAGCalls: 0,
    anyOfBranches: 0,
    anyOfFastRejects: 0,
    anyOfPropertyMerges: 0,
    getDocAtPathCalls: 0,
    schemaMemoHits: 0,
    reads: 0,
  };

  let invocationIndex = -1;
  for (const invocation of invocations) {
    invocationIndex++;
    let context = contexts.get(invocation.context);
    if (context === undefined) {
      context = makeContext(invocation.traverseCells);
      contexts.set(invocation.context, context);
    }
    contextUses.set(
      invocation.context,
      (contextUses.get(invocation.context) ?? 0) + 1,
    );
    if (invocation.traverseCells) {
      contextTraversesCells.set(invocation.context, true);
    }
    let memo = undefined;
    if (invocation.memo !== undefined) {
      memo = memos.get(invocation.memo);
      if (memo === undefined) {
        memo = createSchemaMemo();
        memos.set(invocation.memo, memo);
      }
    }
    const selector = fixture.selectors[invocation.selector];
    const link = invocation.link !== undefined
      ? fixture.links[invocation.link]
      : undefined;
    const address: IMemorySpaceAddress = {
      space: invocation.address.space as IMemorySpaceAddress["space"],
      id: invocation.address.id as IMemorySpaceAddress["id"],
      type: invocation.address.type as IMemorySpaceAddress["type"],
      path: [...invocation.address.path],
      ...(invocation.address.scope !== undefined &&
        { scope: invocation.address.scope as IMemorySpaceAddress["scope"] }),
    };
    // Mirror validateAndTransform: materialize the root value outside the
    // read log (the live path reads it with ignoreReadForScheduling).
    const value = rawTx.readOrThrow(address);
    const doc: IMemorySpaceValueAttestation = {
      address: address as IMemorySpaceValueAttestation["address"],
      value,
    };
    const traverser = new SchemaObjectTraverser(
      tx,
      selector as SchemaPathSelector,
      context,
      undefined,
      memo,
    );
    const t0 = collectLatency ? performance.now() : 0;
    const rv = traverser.traverse(doc, link);
    if (collectLatency) {
      latencySamples.push({
        index: invocationIndex,
        ms: performance.now() - t0,
        selector: invocation.selector,
        docId: invocation.address.id,
        schemaCalls: traverser.traverseWithSchemaCalls,
        anyOfBranches: traverser.anyOfBranches,
        dagCalls: traverser.traverseDAGCalls,
        pointerCalls: traverser.traversePointerCalls,
      });
    }

    metrics.traverseWithSchemaCalls += traverser.traverseWithSchemaCalls;
    metrics.traversePointerCalls += traverser.traversePointerCalls;
    metrics.traverseArrayCalls += traverser.traverseArrayCalls;
    metrics.traverseObjectCalls += traverser.traverseObjectCalls;
    metrics.traverseDAGCalls += traverser.traverseDAGCalls;
    metrics.anyOfBranches += traverser.anyOfBranches;
    metrics.anyOfFastRejects += traverser.anyOfFastRejects;
    metrics.anyOfPropertyMerges += traverser.anyOfPropertyMerges;
    metrics.getDocAtPathCalls += traverser.getDocAtPathCalls;
    metrics.schemaMemoHits += traverser.schemaMemoHits;

    if (collectOracle) {
      invocationOracles.push({
        ok: rv.error === undefined,
        ...(rv.error !== undefined && { code: rv.error.code }),
        hash: rv.ok === undefined ? "undefined" : truncatedHash(rv.ok),
      });
    }
  }

  metrics.reads = readLog.size;

  let oracle: ReplayOracle | undefined;
  if (collectOracle) {
    const schemaTrackers: Record<string, string[]> = {};
    for (const [contextId, context] of contexts) {
      const shared = (contextUses.get(contextId) ?? 0) > 1;
      const traversesCells = contextTraversesCells.get(contextId) ?? false;
      if (!shared && !traversesCells) continue;
      const entries: string[] = [];
      for (const [key, selectors] of context.schemaTracker) {
        for (const selector of selectors) {
          entries.push(`${compactId(key)}::${truncatedHash(selector)}`);
        }
      }
      schemaTrackers[String(contextId)] = entries.sort();
    }
    oracle = {
      invocations: invocationOracles,
      readSet: [...readLog].sort(),
      schemaTrackers,
    };
  }

  return {
    oracle,
    metrics,
    ...(collectLatency &&
      { latency: buildLatencyReport(latencySamples, 12) }),
  };
}

/**
 * Reads a fixture from `path`, gzipped or not. A fixture of another format
 * version is refused rather than replayed: its invocations would carry the
 * traversal flag under another name, and replay would read every one of
 * them as a value-shaped traversal.
 */
export async function loadFixture(path: string): Promise<TraverseFixture> {
  const fixture = JSON.parse(
    await readMaybeGzippedText(path),
  ) as TraverseFixture;
  const version: number = fixture.version;
  if (version !== 2) {
    throw new Error(
      `Fixture \`${path}\` is format version ${version}; replay reads ` +
        "version 2, whose invocations carry `traverseCells`",
    );
  }
  return fixture;
}
