import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { collectConsumedLabel } from "../src/cfc/prepare.ts";
import { createFrozenRequestSnapshot } from "../src/cfc/request-snapshot.ts";
import { enqueueSinkRequestPostCommitEffect } from "../src/cfc/sink-request.ts";

const signer = await Identity.fromPassphrase("runner-cfc-runtime-stats");
const space = signer.did();

describe("CFC runtime stats", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate> | undefined;
  let runtime: Runtime | undefined;

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
    runtime = undefined;
    storageManager = undefined;
  });

  it("counts dereference traces and the largest set one transaction held", () => {
    // The size of that set is what `probeBelongsToDereference` scans per read
    // activity at commit preparation, so the maximum is the figure a reader
    // wants — not the running total, which spans every transaction.

    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

    const trace = (path: string[]) => ({
      source: {
        space,
        id: "of:cfc-stats-source" as const,
        scope: "space" as const,
        path,
      },
      target: {
        space,
        id: "of:cfc-stats-target" as const,
        scope: "space" as const,
        path: [] as string[],
      },
      kind: "value" as const,
    });

    const first = runtime.edit();
    first.recordCfcDereferenceTrace(trace(["a"]));
    first.recordCfcDereferenceTrace(trace(["b"]));
    first.recordCfcDereferenceTrace(trace(["c"]));
    first.abort("counted");

    expect(runtime.getCfcStats().dereferenceTracesRecorded).toBe(3);
    expect(runtime.getCfcStats().dereferenceTracesMax).toBe(3);

    // A shorter transaction adds to the total and leaves the maximum alone.
    const second = runtime.edit();
    second.recordCfcDereferenceTrace(trace(["d"]));
    second.abort("counted");

    expect(runtime.getCfcStats().dereferenceTracesRecorded).toBe(4);
    expect(runtime.getCfcStats().dereferenceTracesMax).toBe(3);
  });

  it("counts attribution work without changing preparation or relevance and resets the counters", () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const tx = runtime.edit();
    const prepare = { ...tx.getCfcState().prepare };
    const relevant = tx.getCfcState().relevant;
    collectConsumedLabel(tx);
    const snapshot = runtime.getCfcStats();
    collectConsumedLabel(tx);
    expect(snapshot.consumedLabelWalks).toBe(1);
    expect(runtime.getCfcStats().consumedLabelWalks).toBe(2);
    expect(runtime.getCfcStats().refusalDetailsRecorded).toBe(0);
    tx.recordCfcRefusalDetail({
      gate: "writer-fit",
      offendingAtoms: ['"secret"'],
      inputs: [],
      attribution: "none",
      reason: "stats fixture",
    });
    expect(runtime.getCfcStats().refusalDetailsRecorded).toBe(1);
    expect(snapshot.refusalDetailsRecorded).toBe(0);
    expect(tx.getCfcState().prepare).toEqual(prepare);
    expect(tx.getCfcState().relevant).toBe(relevant);
    runtime.resetCfcStats();
    expect(runtime.getCfcStats().consumedLabelWalks).toBe(0);
    expect(runtime.getCfcStats().refusalDetailsRecorded).toBe(0);
    tx.abort("counted");
  });

  it("tracks relevant, prepared, reject, invalidation, outbox, and sink dedupe counters", async () => {
    storageManager = StorageManager.emulate({
      as: signer,
    });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

    expect(runtime.getCfcStats()).toEqual({
      cfcRelevantTx: 0,
      flowLabelProbesComputed: 0,
      flowLabelProbeMemoHits: 0,
      dereferenceTracesRecorded: 0,
      dereferenceTracesMax: 0,
      refusalDetailsRecorded: 0,
      consumedLabelWalks: 0,
      overlapWildcardQueries: 0,
      overlapConcreteQueries: 0,
      authoritativeCoverCalls: 0,
      stagedReferenceDerivations: 0,
      stagedReferenceCacheHits: 0,
      flowTemplateEntriesMinted: 0,
      flowTemplateContainers: 0,
      cfcPreparedTx: 0,
      cfcPrepareRejects: 0,
      cfcDigestInvalidations: 0,
      cfcOutboxFlushes: 0,
      sinkDedupHits: 0,
      sinkReleaseRejects: 0,
      prefixProvenanceSummaries: 0,
      prefixProtectedWrites: 0,
      prefixGatedReads: 0,
      prefixTxGlobalGatedReads: 0,
      prefixBoundReal: 0,
      prefixBoundInfinityFallback: 0,
      prefixBoundClockLess: 0,
      prefixS7ExemptionFires: 0,
      prefixClockLessReads: 0,
    });

    const preparedTx = runtime.edit();
    preparedTx.markCfcRelevant("stats-prepared");
    const preparedCell = runtime.getCell(
      space,
      "cfc-runtime-stats-prepared",
      {
        type: "object",
        properties: {
          secret: {
            type: "string",
            ifc: { confidentiality: ["secret"] },
          },
        },
        required: ["secret"],
      },
      preparedTx,
    );
    preparedCell.set({ secret: "value" });
    let preparedFlushCount = 0;
    enqueueSinkRequestPostCommitEffect(
      preparedTx,
      "fetchJson",
      "fetchJson:cfc-runtime-stats-prepared",
      createFrozenRequestSnapshot({
        url: "https://example.com/cfc-runtime-stats-prepared",
      }),
      "fetchJson-start",
      () => {
        preparedFlushCount++;
      },
    );
    preparedTx.prepareCfc();
    expect((await preparedTx.commit()).ok).toBeDefined();
    expect(preparedFlushCount).toBe(1);

    const rejectTx = runtime.edit();
    rejectTx.markCfcRelevant("stats-reject");
    const rejectCell = runtime.getCell(
      space,
      "cfc-runtime-stats-reject",
      {
        type: "object",
        properties: {
          value: {
            type: "string",
            ifc: { collection: ["unsupported"] } as any,
          },
        },
        required: ["value"],
      },
      rejectTx,
    );
    rejectCell.set({ value: "blocked" });
    expect(rejectTx.prepareCfc()).toBe("");
    expect((await rejectTx.commit()).error?.message).toContain(
      "unsupported trust-sensitive claim collection",
    );

    const invalidationTx = runtime.edit();
    invalidationTx.markCfcRelevant("stats-invalidation");
    const invalidationCell = runtime.getCell(
      space,
      "cfc-runtime-stats-invalidation",
      {
        type: "object",
        properties: {
          secret: {
            type: "string",
            ifc: { confidentiality: ["secret"] },
          },
        },
        required: ["secret"],
      },
      invalidationTx,
    );
    invalidationCell.set({ secret: "initial" });
    invalidationTx.prepareCfc();
    invalidationCell.set({ secret: "mutated" });
    expect((await invalidationTx.commit()).error?.message).toContain(
      "read-after-prepare",
    );

    const sinkTx = runtime.edit();
    sinkTx.markCfcRelevant("stats-sink");
    const request = createFrozenRequestSnapshot({
      url: "https://example.com/cfc-runtime-stats",
    });
    let flushCount = 0;
    enqueueSinkRequestPostCommitEffect(
      sinkTx,
      "fetchJson",
      "fetchJson:cfc-runtime-stats",
      request,
      "fetchJson-start",
      () => {
        flushCount++;
      },
    );
    enqueueSinkRequestPostCommitEffect(
      sinkTx,
      "fetchJson",
      "fetchJson:cfc-runtime-stats",
      request,
      "fetchJson-start",
      () => {
        flushCount++;
      },
    );
    sinkTx.prepareCfc();
    expect((await sinkTx.commit()).ok).toBeDefined();
    expect(flushCount).toBe(1);

    expect(runtime.getCfcStats()).toEqual({
      cfcRelevantTx: 4,
      // Two gates keep the probe from running here. It runs only on a
      // transaction nothing has marked relevant, and every transaction above
      // calls markCfcRelevant before it commits; it also runs only when the
      // flow-labels dial is not "off", and this runtime leaves it off. The
      // probe's own counters are exercised in cfc-flow-probe-memo.test.ts.
      flowLabelProbesComputed: 0,
      flowLabelProbeMemoHits: 0,
      dereferenceTracesRecorded: 0,
      dereferenceTracesMax: 0,
      refusalDetailsRecorded: 0,
      consumedLabelWalks: 0,
      overlapWildcardQueries: 0,
      overlapConcreteQueries: 0,
      authoritativeCoverCalls: 0,
      stagedReferenceDerivations: 0,
      stagedReferenceCacheHits: 0,
      flowTemplateEntriesMinted: 0,
      flowTemplateContainers: 0,
      cfcPreparedTx: 3,
      cfcPrepareRejects: 1,
      cfcDigestInvalidations: 1,
      cfcOutboxFlushes: 2,
      sinkDedupHits: 1,
      sinkReleaseRejects: 0,
      // Stage-0 prefix-provenance counters stay untouched without the
      // cfcPrefixProvenanceStats opt-in — the hook-absent default collects
      // nothing even across relevant, rejected, and invalidated prepares.
      prefixProvenanceSummaries: 0,
      prefixProtectedWrites: 0,
      prefixGatedReads: 0,
      prefixTxGlobalGatedReads: 0,
      prefixBoundReal: 0,
      prefixBoundInfinityFallback: 0,
      prefixBoundClockLess: 0,
      prefixS7ExemptionFires: 0,
      prefixClockLessReads: 0,
    });
  });
});
