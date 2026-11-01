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
import type { StoredCfcMetadata } from "../src/cfc/types.ts";
import { stampWaveRunContext, WaveAccumulator } from "../src/executor/wave.ts";
import { EngineWaveCommitSink } from "../src/executor/engine-wave-sink.ts";
import { txToReactivityLog } from "../src/scheduler/reactivity.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("runner-cfc-served-append");
const space = signer.did() as MemorySpace;

/** The label on what the earlier sender read, and so on its entry. */
const EARLIER_ATOM = "https://commonfabric.org/cfc/atom/Public/room-earlier";

describe("CFC write-destination reads: the served event append", () => {
  // On the serving posture, a send from a run its serving loop stamped
  // appends the event's entry to the stream's entries document inside that
  // run's transaction. The append reads the entries already there, to write
  // them back with the new one after them, and an earlier entry carries the
  // label of the run that appended or handled it. Each case starts from a
  // stream whose one entry an earlier run appended after reading labeled
  // data, committed the way the serving loop commits it, in a wave.

  let server: MemoryV2Server.Server;
  let storageManager: EmulatedStorageManager;
  let runtime: Runtime;
  let stream: ReturnType<Runtime["getCell"]>;
  let entriesId: URI;

  /** Prepares `tx`, and returns the writer-fit reasons it recorded. */
  const preparedWriterFitReasons = (
    tx: ReturnType<Runtime["edit"]>,
  ): string[] => {
    tx.prepareCfc();
    return tx.getCfcState().diagnostics.filter((d) => d.includes("writer-fit"));
  };

  /** A transaction its serving loop stamped for the derivation `actionId`. */
  const servedRun = (actionId: string) => {
    const tx = runtime.edit();
    stampWaveRunContext(tx, { actionId, kind: "derivation" });
    return tx;
  };

  /** Writes an unlabeled value into an ordinary document of the space. */
  const writeElsewhere = (tx: ReturnType<Runtime["edit"]>, value: string) =>
    runtime.getCell<{ copied?: string }>(space, "elsewhere", undefined, tx)
      .set({ copied: value });

  /** Whether `tx` wrote the document `id`. */
  const wrote = (tx: ReturnType<Runtime["edit"]>, id: string): boolean =>
    txToReactivityLog(tx).writes.some((write) => write.id === id);

  /** The `derived` confidentiality the replica holds for `id`. */
  const storedDerivedConfidentiality = (id: URI): unknown[] => {
    const replica = storageManager.open(space).replica as unknown as {
      getDocument(id: string): { cfc?: StoredCfcMetadata } | undefined;
    };
    return (replica.getDocument(id)?.cfc?.labelMap.entries ?? [])
      .filter((entry) => entry.origin === "derived")
      .flatMap((entry) =>
        isCfcLabelReference(entry.label)
          ? []
          : entry.label.confidentiality ?? []
      );
  };

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

    stream = runtime.getCell(space, "served-stream", { asCell: ["stream"] });
    const link = stream.getAsNormalizedFullLink();
    entriesId = streamEntriesDocId({
      id: link.id,
      path: [...link.path],
      scope: link.scope,
    }) as URI;

    const source = runtime.getCell(space, "earlier-source", undefined);
    const seed = runtime.edit();
    writeSeedEnvelopeDoc(seed, space);
    seedStoredEnvelope(seed, {
      space,
      scope: "space",
      id: source.getAsNormalizedFullLink().id,
      path: [],
    }, {
      value: { v: "classified" },
      cfc: {
        version: 1,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: {
          version: 1,
          entries: [{
            path: ["v"],
            label: { confidentiality: [EARLIER_ATOM] },
          }],
        },
      },
    });
    expect((await seed.commit().settled).error).toBeUndefined();

    // The earlier run reads the labeled source and sends what it read.
    const lease = new ExecutionLeaseCycle({
      engine,
      space,
      holder: executionLeaseHolder(`service:${space}`),
    });
    expect(lease.acquire()).toBe(true);
    try {
      const wave = new WaveAccumulator({
        space,
        basisSeq: Engine.serverSeq(engine),
        scopeKeyIdentity: {
          principal: signer.did(),
          sessionId: "served-append-session",
        },
        replicaFor: (s) => storageManager.open(s).replica,
        lease,
      });
      runtime.installSealDestination(wave);
      const tx = servedRun("earlier-send");
      const { v } = source.withTx(tx).getRaw() as { v: string };
      stream.withTx(tx).send({ note: v } as never);
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
      lease.release();
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

  it("labels the entry a sending run appends with what that run read", () => {
    // What the exclusion leaves alone: the sending run's own inputs join, and
    // land on the entry it appends.
    expect(storedDerivedConfidentiality(entriesId)).toContain(EARLIER_ATOM);
  });

  it("joins no label an earlier entry carries into the next sender's writes", () => {
    const tx = servedRun("next-send");
    stream.withTx(tx).send({ note: "next" } as never);
    writeElsewhere(tx, "plain");

    // The send took the serving arm: the entry rides this transaction.
    expect(wrote(tx, entriesId)).toBe(true);
    expect(preparedWriterFitReasons(tx)).toEqual([]);
    tx.abort();
  });

  it("joins the entries a run reads for itself", () => {
    // The control for the case above: the earlier entry's label reaches a
    // run that reads the entries as data, and sending in the same run does
    // not take that read back out of its join.
    const tx = servedRun("reading-send");
    const entries = runtime.getCellFromLink(
      { space, scope: "space", id: entriesId, path: ["entries"] },
      undefined,
      tx,
    ).get() as unknown[];
    expect(entries).toHaveLength(1);
    stream.withTx(tx).send({ note: "next" } as never);
    writeElsewhere(tx, `${entries.length}`);

    expect(wrote(tx, entriesId)).toBe(true);
    const reasons = preparedWriterFitReasons(tx);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain("writer-fit confidentiality misfit");
    expect(reasons[0]).toContain(EARLIER_ATOM);
    tx.abort();
  });
});
