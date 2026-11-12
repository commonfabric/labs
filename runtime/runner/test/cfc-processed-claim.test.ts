import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type { MemorySpace, URI } from "@commonfabric/memory/interface";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import * as Engine from "@commonfabric/memory/v2/engine";
import {
  ExecutionLeaseCycle,
  executionLeaseHolder,
} from "@commonfabric/memory/v2/execution-lease";
import { streamEntriesDocId } from "@commonfabric/memory/v2";
import { Runtime } from "../src/runtime.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { isCfcLabelReference } from "../src/cfc/label-documents.ts";
import {
  CFC_STRUCTURAL_PROVENANCE_PROCESSED_CLAIM,
  type StoredCfcMetadata,
} from "../src/cfc/types.ts";
import { stampWaveRunContext, WaveAccumulator } from "../src/executor/wave.ts";
import { EngineWaveCommitSink } from "../src/executor/engine-wave-sink.ts";
import { writeProcessedClaim } from "../src/executor/processed-claim.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("runner-cfc-processed-claim");
const space = signer.did() as MemorySpace;
const foreign = (await Identity.fromPassphrase(
  "runner-cfc-processed-claim-foreign",
)).did() as MemorySpace;

/** The label on the foreign document the handler reads. */
const FOREIGN_ATOM = "https://commonfabric.org/cfc/atom/Public/foreign-secret";

describe("cfc-processed-claim", () => {
  // On the serving posture, the transaction that runs an event's handler also
  // writes the event's processed claim, the entry's `consequenced` mark, on
  // the stream's entries document (`writeProcessedClaim()`). §6.2.2 claims
  // the processed cell apart from the handler, so the claim takes nothing of
  // what the handler reads. Each case's handler reads a document of another
  // space, whose label the stream's space doesn't admit, and the stream holds
  // one entry not yet handled, committed the way the serving loop commits it,
  // in a wave.

  let server: MemoryV2Server.Server;
  let storageManager: EmulatedStorageManager;
  let runtime: Runtime;
  let stream: ReturnType<Runtime["getCell"]>;
  let entriesId: URI;
  let foreignId: URI;

  /** Prepares `tx`, and returns the writer-fit reasons it recorded. */
  const preparedWriterFitReasons = (
    tx: ReturnType<Runtime["edit"]>,
  ): string[] => {
    tx.prepareCfc();
    return tx.getCfcState().diagnostics.filter((d) => d.includes("writer-fit"));
  };

  /**
   * A transaction its serving loop stamped for the event handler `actionId`,
   * which has read the foreign document.
   */
  const handlerRun = (actionId: string) => {
    const tx = runtime.edit();
    stampWaveRunContext(tx, { actionId, kind: "event-handler" });
    const read = runtime.getCellFromLink(
      { space: foreign, scope: "space", id: foreignId, path: [] },
      undefined,
      tx,
    ).getRaw() as { secret?: string };
    expect(read.secret).toBe("s3cr3t");
    return tx;
  };

  /** The `derived` confidentiality `tx` stages on the entries document. */
  const stagedDerivedConfidentiality = (
    tx: ReturnType<Runtime["edit"]>,
  ): unknown[] =>
    ((tx.readOrThrow({ space, scope: "space", id: entriesId, path: [] }) as
      | { cfc?: StoredCfcMetadata }
      | undefined)?.cfc?.labelMap.entries ?? [])
      .filter((entry) => entry.origin === "derived")
      .flatMap((entry) =>
        isCfcLabelReference(entry.label)
          ? []
          : entry.label.confidentiality ?? []
      );

  beforeEach(async () => {
    server = newSharedServer();
    storageManager = EmulatedStorageManager.connectTo(server, { as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      servingPosture: true,
      experimental: { serverExecution: true },
      cfcEnforcementMode: "enforce-strict",
      cfcFlowLabels: "persist",
    });
    const engine = await server.engineForSpace(space);

    stream = runtime.getCell(space, "claimed-stream", { asCell: ["stream"] });
    const link = stream.getAsNormalizedFullLink();
    entriesId = streamEntriesDocId({
      id: link.id,
      path: [...link.path],
      scope: link.scope,
    }) as URI;

    foreignId = runtime.getCell(foreign, "foreign-source", undefined)
      .getAsNormalizedFullLink().id;
    const seed = runtime.edit();
    writeSeedEnvelopeDoc(seed, foreign);
    seedStoredEnvelope(seed, {
      space: foreign,
      scope: "space",
      id: foreignId,
      path: [],
    }, {
      value: { secret: "s3cr3t" },
      cfc: {
        version: 1,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: {
          version: 1,
          entries: [{
            path: ["secret"],
            label: { confidentiality: [FOREIGN_ATOM] },
          }],
        },
      },
    });
    expect((await seed.commit().settled).error).toBeUndefined();

    // An earlier run, which read nothing, sends the event the cases handle.
    const lease = new ExecutionLeaseCycle({
      leases: engine.executionLeases,
      space,
      holder: executionLeaseHolder(`service:${space}`),
    });
    expect(await lease.acquire()).toBe(true);
    try {
      const wave = new WaveAccumulator({
        space,
        basisSeq: Engine.serverSeq(engine),
        scopeKeyIdentity: {
          principal: signer.did(),
          sessionId: "processed-claim-session",
        },
        replicaFor: (s) => storageManager.open(s).replica,
        lease,
      });
      runtime.installSealDestination(wave);
      const tx = runtime.edit();
      stampWaveRunContext(tx, { actionId: "earlier-send", kind: "derivation" });
      stream.withTx(tx).send({ note: "pending" } as never);
      expect((await tx.commit().settled).error).toBeUndefined();
      runtime.clearSealDestination();
      const outcome = await wave.commitWave(
        new EngineWaveCommitSink({
          engineFor: () => engine,
          sessionId: executionLeaseHolder(`service:${space}`),
        }),
      );
      await wave.settled();
      expect(outcome.aborted).toBeUndefined();
    } finally {
      await lease.release();
    }
    await server.flushSessions([space]);
    await storageManager.open(space).pullToServerHead?.();
    await runtime.getCellFromLink({
      space,
      scope: "space",
      id: entriesId,
      path: [],
    }).sync();
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
    await server.close();
  });

  it("records no writer-fit reason for the processed claim of a handler that read another space's label", () => {
    const tx = handlerRun("claiming-handler");
    writeProcessedClaim(
      runtime,
      tx,
      space,
      { sidecarId: entriesId, index: 0 },
      {
        clearDeferral: true,
      },
    );

    expect(preparedWriterFitReasons(tx)).toEqual([]);
    expect(tx.getCfcState().prepare.status).toBe("prepared");
    tx.abort();
  });

  it("stamps none of the handler's join on the processed claim", () => {
    const tx = handlerRun("unstamped-handler");
    writeProcessedClaim(
      runtime,
      tx,
      space,
      { sidecarId: entriesId, index: 0 },
      {
        clearDeferral: false,
      },
    );

    expect(preparedWriterFitReasons(tx)).toEqual([]);
    expect(stagedDerivedConfidentiality(tx)).not.toContain(FOREIGN_ATOM);
    tx.abort();
  });

  it("measures the same mark when nothing names it a processed claim", () => {
    // The control for the cases above: the mark itself, written as any other
    // write, carries the join and misfits the stream's space.
    const tx = handlerRun("unnamed-handler");
    runtime.getCellFromLink<boolean>({
      space,
      scope: "space",
      id: entriesId as never,
      path: ["entries", "0", "consequenced"],
    }).withTx(tx).set(true);

    const reasons = preparedWriterFitReasons(tx);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain(
      `writer-fit confidentiality misfit for ${entriesId}`,
    );
    expect(reasons[0]).toContain(FOREIGN_ATOM);
    tx.abort();
  });

  it("counts a processed claim recorded without the runtime's mark for nothing", () => {
    // The recording method is on the public transaction interface, so code
    // holding a transaction can name any path it likes. The runtime's
    // authorization is what separates the serving loop's claim from that.
    const tx = handlerRun("forged-handler");
    const path = ["entries", "0", "consequenced"];
    tx.recordCfcWritePolicyInput({
      kind: "structural-provenance",
      target: { space, id: entriesId, scope: "space", path },
      claim: CFC_STRUCTURAL_PROVENANCE_PROCESSED_CLAIM,
      sources: [],
    });
    runtime.getCellFromLink<boolean>({
      space,
      scope: "space",
      id: entriesId as never,
      path,
    }).withTx(tx).set(true);

    const reasons = preparedWriterFitReasons(tx);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain(FOREIGN_ATOM);
    tx.abort();
  });

  it("measures a field the handler writes beside the processed claim", () => {
    // Only the claim takes nothing of the join. A value computed from what the
    // handler read, written on the same entry, is measured as any write is.
    const tx = handlerRun("beside-handler");
    writeProcessedClaim(
      runtime,
      tx,
      space,
      { sidecarId: entriesId, index: 0 },
      {
        clearDeferral: false,
      },
    );
    runtime.getCellFromLink<string>({
      space,
      scope: "space",
      id: entriesId as never,
      path: ["entries", "0", "error"],
    }).withTx(tx).set("refused reading the secret");

    const reasons = preparedWriterFitReasons(tx);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain(FOREIGN_ATOM);
    tx.abort();
  });
});
