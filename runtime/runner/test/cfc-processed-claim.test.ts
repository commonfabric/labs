import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { CFC_ATOM_TYPE, cfcAtom } from "@commonfabric/api/cfc";
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
import {
  CFC_STRUCTURAL_PROVENANCE_PROCESSED_CLAIM,
  type ImplementationIdentity,
  runtimeWritePolicyAuthorization,
} from "../src/cfc/types.ts";
import { stampWaveRunContext, WaveAccumulator } from "../src/executor/wave.ts";
import { EngineWaveCommitSink } from "../src/executor/engine-wave-sink.ts";
import {
  runOutcomeIsWithheld,
  waveClaimIsWithheld,
  withholdProcessedClaimOutcome,
  writeProcessedClaim,
} from "../src/executor/processed-claim.ts";
import { processedClaimJoinIsForeign } from "../src/cfc/prepare.ts";
import {
  runBeforeAbort,
  setCfcImplementationIdentity,
} from "../src/storage/extended-storage-transaction.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";
import { storedLabelEntries } from "./cfc-stored-labels.ts";

const signer = await Identity.fromPassphrase("runner-cfc-processed-claim");
const space = signer.did() as MemorySpace;
const foreign = (await Identity.fromPassphrase(
  "runner-cfc-processed-claim-foreign",
)).did() as MemorySpace;

/** A staged label-map entry, as far as these tests read one. */
type StagedEntry = {
  path: string[];
  origin?: string;
  label: { confidentiality?: unknown[]; integrity?: unknown[] };
};

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

  /**
   * The label entries `tx` stages on the document `id` names, each label read
   * out of its label document where the envelope holds it by reference.
   */
  const stagedEntries = (tx: ReturnType<Runtime["edit"]>, id: string) => {
    const read = (docId: string) =>
      tx.readOrThrow({ space, scope: "space", id: docId as URI, path: [] });
    return storedLabelEntries<StagedEntry>(
      (read(id) as { cfc?: unknown } | undefined)?.cfc,
      read,
    );
  };

  /** The `derived` confidentiality `tx` stages on the entries document. */
  const stagedDerivedConfidentiality = (
    tx: ReturnType<Runtime["edit"]>,
  ): unknown[] =>
    stagedEntries(tx, entriesId)
      .filter((entry) => entry.origin === "derived")
      .flatMap((entry) => entry.label.confidentiality ?? []);

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

  it("measures a value the handler writes over the processed claim's own path", () => {
    // The claim's path takes nothing of the join only while it holds what the
    // serving loop wrote there. A handler that writes something else at that
    // path, after the claim, is measured as any write is.
    const tx = handlerRun("overwriting-handler");
    writeProcessedClaim(
      runtime,
      tx,
      space,
      { sidecarId: entriesId, index: 0 },
      { clearDeferral: false },
    );
    runtime.getCellFromLink<string>({
      space,
      scope: "space",
      id: entriesId as never,
      path: ["entries", "0", "consequenced"],
    }).withTx(tx).set("s3cr3t");

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

  it("counts a processed claim naming a document other than a stream's entries for nothing", async () => {
    // Only a stream's entries document holds an event's processed claim, so
    // the runtime's mark on any other document names nothing the gate skips.
    // The document holds an entry already, as the entries document does, so
    // that the mark is the only write the gate could skip.
    const plainId = runtime.getCell(space, "plain-document", undefined)
      .getAsNormalizedFullLink().id;
    const address = { space, scope: "space" as const, id: plainId };
    const seed = runtime.edit();
    seed.writeOrThrow({ ...address, path: ["value"] }, {
      entries: [{ note: "pending" }],
    });
    expect((await seed.commit().settled).error).toBeUndefined();
    const tx = handlerRun("misplaced-handler");
    const path = ["entries", "0", "consequenced"];
    tx.recordCfcWritePolicyInput({
      kind: "structural-provenance",
      target: { ...address, path },
      claim: CFC_STRUCTURAL_PROVENANCE_PROCESSED_CLAIM,
      sources: [],
    }, runtimeWritePolicyAuthorization);
    tx.writeOrThrow({ ...address, path: ["value", ...path] }, true);

    const reasons = preparedWriterFitReasons(tx);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain(
      `writer-fit confidentiality misfit for ${plainId} at /entries/0/consequenced`,
    );
    tx.abort();
  });

  describe("the outcome withheld under a foreign join", () => {
    // Under a join the stream's space doesn't admit, the claim says the same
    // thing however the handling ends: the run records `withheld` beside the
    // mark, or has the wave record it, so that no outcome tells a reader of
    // the stream's space what the handler read.

    /** The entry's `withheld` field, as `tx` sees it. */
    const withheldOn = (tx: ReturnType<Runtime["edit"]>): unknown =>
      runtime.getCellFromLink({
        space,
        scope: "space",
        id: entriesId as never,
        path: ["entries", "0", "withheld"],
      }).withTx(tx).get();

    /** A handler run that read nothing. */
    const plainRun = (actionId: string) => {
      const tx = runtime.edit();
      stampWaveRunContext(tx, { actionId, kind: "event-handler" });
      return tx;
    };

    it("finds the join of a run that read another space's label foreign", () => {
      const foreignTx = handlerRun("foreign-join");
      const plainTx = plainRun("plain-join");

      expect(processedClaimJoinIsForeign(foreignTx, space)).toBe(true);
      expect(processedClaimJoinIsForeign(plainTx, space)).toBe(false);
      foreignTx.abort();
      plainTx.abort();
    });

    it("records the outcome withheld beside the claim, and measures neither", () => {
      const tx = handlerRun("withheld-handler");
      const entry = { sidecarId: entriesId, index: 0 };
      writeProcessedClaim(runtime, tx, space, entry, { clearDeferral: false });

      expect(
        withholdProcessedClaimOutcome(
          runtime,
          tx,
          space,
          entry,
          runOutcomeIsWithheld(tx, space),
        ),
      ).toBe(true);
      expect(withheldOn(tx)).toBe(true);
      expect(preparedWriterFitReasons(tx)).toEqual([]);
      tx.abort();
    });

    it("notes a same-wave run's claim for the wave to record withheld", () => {
      const tx = handlerRun("same-wave-handler");

      expect(
        withholdProcessedClaimOutcome(
          runtime,
          tx,
          space,
          undefined,
          runOutcomeIsWithheld(tx, space),
        ),
      ).toBe(true);
      expect(waveClaimIsWithheld(tx)).toBe(true);
      tx.abort();
    });

    /** Writes the stream's own space's document `name`, labeled outside it or not. */
    const seedLocal = async (
      name: string,
      secret: string,
      labeled: boolean,
    ) => {
      const id = runtime.getCell(space, name, undefined)
        .getAsNormalizedFullLink().id;
      const seed = runtime.edit();
      writeSeedEnvelopeDoc(seed, space);
      seedStoredEnvelope(seed, {
        space,
        scope: "space",
        id,
        path: [],
      }, {
        value: { secret },
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: labeled
              ? [{
                path: ["secret"],
                label: { confidentiality: [FOREIGN_ATOM] },
              }]
              : [],
          },
        },
      });
      expect((await seed.commit().settled).error).toBeUndefined();
      return id;
    };

    /**
     * Aborts `tx` with its decision registered to run first, as the serving
     * loop registers it, and returns what was decided.
     */
    const decideAtAbort = (tx: IExtendedStorageTransaction) => {
      let decided: boolean | undefined;
      runBeforeAbort(tx, () => {
        decided = runOutcomeIsWithheld(tx, space);
      });
      tx.abort();
      return decided;
    };

    it("finds a run that read a document of the stream's own space labeled outside it foreign, decided as it aborts", async () => {
      // A foreign join needs no other space: a document of the stream's own
      // space whose label the entries document doesn't admit makes it foreign
      // too.

      const privateId = await seedLocal("same-space-private", "s3cr3t", true);
      const tx = plainRun("same-space-aborted");
      const read = runtime.getCellFromLink(
        { space, scope: "space", id: privateId, path: [] },
        undefined,
        tx,
      ).getRaw() as { secret?: string };
      expect(read.secret).toBe("s3cr3t");

      expect(decideAtAbort(tx)).toBe(true);
    });

    it("finds a run foreign by the label it read, though the label is released before it aborts", async () => {
      // The decision is the run's own: what its transaction observed, not
      // what the store holds once the run has ended.

      const privateId = await seedLocal("released-private", "s3cr3t", true);
      const tx = plainRun("released-aborted");
      runtime.getCellFromLink(
        { space, scope: "space", id: privateId, path: [] },
        undefined,
        tx,
      ).getRaw();
      await seedLocal("released-private", "released", false);
      // The release has landed: a run that read now would find nothing
      // labeled.
      const after = plainRun("released-after");
      expect(
        runtime.getCellFromLink(
          { space, scope: "space", id: privateId, path: [] },
          undefined,
          after,
        ).getRaw(),
      ).toEqual({ secret: "released" });
      expect(processedClaimJoinIsForeign(after, space)).toBe(false);
      after.abort();

      expect(decideAtAbort(tx)).toBe(true);
    });

    it("finds a run that read nothing labeled not foreign, decided as it aborts", () => {
      expect(decideAtAbort(plainRun("plain-aborted"))).toBe(false);
    });

    it("withholds the outcome of a run that ended undecided, whatever it read", () => {
      // Its observations went with its transaction, so nothing says what its
      // join was.

      const tx = plainRun("plain-ended");
      tx.abort();

      expect(runOutcomeIsWithheld(tx, space)).toBe(true);
    });

    it("withholds nothing for a run whose join the stream's space admits", () => {
      const tx = plainRun("admitted-handler");
      const entry = { sidecarId: entriesId, index: 0 };
      writeProcessedClaim(runtime, tx, space, entry, { clearDeferral: false });

      expect(
        withholdProcessedClaimOutcome(
          runtime,
          tx,
          space,
          entry,
          runOutcomeIsWithheld(tx, space),
        ),
      ).toBe(false);
      expect(withheldOn(tx)).toBeUndefined();
      expect(waveClaimIsWithheld(tx)).toBe(false);
      tx.abort();
    });
  });
  describe("the write-identity summary", () => {
    // §6.2.2 claims the processed cell apart from the handler, so the claim
    // the serving loop writes in the handler's transaction, under no
    // identity, is not one of the handler's writes: a run whose own writes
    // are all the handler's is attributed to the handler (§8.9.3). Only that
    // write is left out. Each case writes the claim, then writes as the
    // handler, and then, in the negative cases, writes something else.
    const HANDLER: ImplementationIdentity = {
      kind: "verified",
      moduleIdentity: "module:processed-claim-identity",
      symbol: "advance",
      bindingPath: ["advance"],
    };

    /**
     * A handler run whose serving loop wrote its processed claim, and whose
     * handler has written one document.
     */
    const claimedHandlerRun = (
      actionId: string,
      { clearDeferral }: { clearDeferral: boolean },
    ) => {
      const tx = handlerRun(actionId);
      writeProcessedClaim(
        runtime,
        tx,
        space,
        { sidecarId: entriesId, index: 0 },
        { clearDeferral },
      );
      setCfcImplementationIdentity(tx, HANDLER);
      runtime.getCell<string>(space, `${actionId}-out`, undefined, tx)
        .set("handled");
      return tx;
    };

    /**
     * The `symbol`s of the `TransformedBy` atoms `tx` stages on document `id`,
     * on label entries at `path` or below it.
     */
    const stagedTransformedBy = (
      tx: ReturnType<Runtime["edit"]>,
      id: URI,
      path: readonly string[],
    ): string[] =>
      stagedEntries(tx, id)
        .filter((entry) => path.every((key, i) => entry.path[i] === key))
        .flatMap((entry) => entry.label.integrity ?? [])
        .flatMap((atom) =>
          typeof atom === "object" && atom !== null &&
            "type" in atom && atom.type === CFC_ATOM_TYPE.TransformedBy &&
            "identity" in atom &&
            typeof (atom.identity as { symbol?: unknown })?.symbol === "string"
            ? [(atom.identity as { symbol: string }).symbol]
            : []
        );

    it("stamps the handler's TransformedBy on what it wrote and none on the claim", async () => {
      // The summary and the join's stamp leave out the same write: were the
      // claim counted out of the one and stamped by the other, the handler
      // would be named on bytes the runtime wrote. The handler reads a value
      // labeled with the stream's own space, and writes a document declared
      // to hold that, so its output fits and the run prepares.
      const LOCAL_ATOM = cfcAtom.space(space);
      const localId = runtime.getCell(space, "local-source", undefined)
        .getAsNormalizedFullLink().id;
      const seed = runtime.edit();
      writeSeedEnvelopeDoc(seed, space);
      seedStoredEnvelope(seed, {
        space,
        scope: "space",
        id: localId,
        path: [],
      }, {
        value: { secret: "local" },
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{
              path: ["secret"],
              label: { confidentiality: [LOCAL_ATOM] },
            }],
          },
        },
      });
      expect((await seed.commit().settled).error).toBeUndefined();

      const tx = runtime.edit();
      stampWaveRunContext(tx, {
        actionId: "stamped-handler",
        kind: "event-handler",
      });
      writeProcessedClaim(
        runtime,
        tx,
        space,
        { sidecarId: entriesId, index: 0 },
        { clearDeferral: true },
      );
      setCfcImplementationIdentity(tx, HANDLER);
      const read = runtime.getCellFromLink(
        { space, scope: "space", id: localId, path: [] },
        undefined,
        tx,
      ).getRaw() as { secret?: string };
      expect(read.secret).toBe("local");
      const out = runtime.getCell<string>(
        space,
        "stamped-handler-out",
        { type: "string", ifc: { confidentiality: [LOCAL_ATOM] } } as const,
        tx,
      );
      out.set("handled");
      tx.prepareCfc();
      expect(tx.getCfcState().prepare.status).toBe("prepared");
      expect(
        stagedTransformedBy(tx, out.getAsNormalizedFullLink().id, []),
      ).toEqual(["advance"]);
      expect(stagedTransformedBy(tx, entriesId, ["entries", "0"])).toEqual([]);
      tx.abort();
    });

    for (const clearDeferral of [false, true]) {
      it(
        `attributes the run to the handler${
          clearDeferral ? " when the claim clears a delivery deferral" : ""
        }`,
        () => {
          const tx = claimedHandlerRun(
            `attributed-handler-${clearDeferral}`,
            { clearDeferral },
          );
          const summary = tx.getCfcState().writeIdentity;
          expect(summary.multiple).toBe(false);
          expect(summary.identity).toEqual(HANDLER);
          tx.abort();
        },
      );
    }

    it("still counts a write made under no identity elsewhere", () => {
      const tx = claimedHandlerRun("mixed-handler", { clearDeferral: false });
      setCfcImplementationIdentity(tx, undefined);
      runtime.getCell<string>(space, "mixed-handler-other", undefined, tx)
        .set("unattributed");
      expect(tx.getCfcState().writeIdentity.multiple).toBe(true);
      tx.abort();
    });

    it("still counts a write under no identity of another value at the claim's path", () => {
      const tx = claimedHandlerRun("overwritten-claim", {
        clearDeferral: false,
      });
      setCfcImplementationIdentity(tx, undefined);
      runtime.getCellFromLink<boolean>({
        space,
        scope: "space",
        id: entriesId as never,
        path: ["entries", "0", "consequenced"],
      }).withTx(tx).set(false);
      expect(tx.getCfcState().writeIdentity.multiple).toBe(true);
      tx.abort();
    });

    it("still counts the claim's own value written at its path under another identity", () => {
      const tx = claimedHandlerRun("restated-claim", { clearDeferral: false });
      setCfcImplementationIdentity(tx, {
        kind: "verified",
        moduleIdentity: "module:processed-claim-identity",
        symbol: "other",
        bindingPath: ["other"],
      });
      // Written on the transaction directly: a cell's `set()` of the value
      // already there writes nothing.
      tx.writeOrThrow({
        space,
        scope: "space",
        id: entriesId,
        path: ["value", "entries", "0", "consequenced"],
      }, true);
      expect(tx.getCfcState().writeIdentity.multiple).toBe(true);
      tx.abort();
    });

    it("still counts a write the runtime named a claim on a document no stream's entries are", () => {
      const tx = claimedHandlerRun("misplaced-claim", { clearDeferral: false });
      setCfcImplementationIdentity(tx, undefined);
      const other = runtime.getCell<{ consequenced?: boolean }>(
        space,
        "not-a-stream-entries-doc",
        undefined,
        tx,
      );
      const link = other.getAsNormalizedFullLink();
      tx.recordCfcWritePolicyInput({
        kind: "structural-provenance",
        target: { space, id: link.id, scope: "space", path: ["consequenced"] },
        claim: CFC_STRUCTURAL_PROVENANCE_PROCESSED_CLAIM,
        sources: [],
      }, runtimeWritePolicyAuthorization);
      other.key("consequenced").set(true);
      expect(tx.getCfcState().writeIdentity.multiple).toBe(true);
      tx.abort();
    });

    it("leaves out no write at a path named a claim without the runtime's mark", () => {
      const tx = handlerRun("forged-claim-identity");
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
      setCfcImplementationIdentity(tx, HANDLER);
      runtime.getCell<string>(space, "forged-claim-identity-out", undefined, tx)
        .set("handled");
      expect(tx.getCfcState().writeIdentity.multiple).toBe(true);
      tx.abort();
    });
  });
});
