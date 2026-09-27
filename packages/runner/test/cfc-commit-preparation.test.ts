import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { cfcAtom } from "@commonfabric/api/cfc";
import { taggedHashStringOf } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
import type { URI } from "@commonfabric/memory/interface";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";
import { createChildCellTransaction } from "../src/storage/extended-storage-transaction.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import { CFC_GRANT_ID_PREFIX } from "../src/cfc/grants.ts";
import type { CfcEnforcementMode } from "../src/cfc/types.ts";
import { registerSchemaDocument } from "../src/schema-registry.ts";
import { internSchemaAsTaggedHashString } from "@commonfabric/data-model-schema";
import type { FabricValue, JSONSchema } from "../src/builder/types.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("runner-cfc-commit-preparation");
const space = signer.did();

/** The space's own readers: a confidentiality every write in it fits. */
const spaceAtom = cfcAtom.space(space);

const makeRuntime = (
  options: { cfcEnforcementMode?: CfcEnforcementMode } = {},
) => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
    // The flow probe is what computes relevance from reads and writes
    // nothing marked; at `off` there is no probe to race.
    cfcFlowLabels: "persist",
    ...options,
  });
  return {
    runtime,
    storageManager,
    dispose: async () => {
      await runtime.dispose();
      await storageManager.close();
    },
  };
};

/**
 * Writes `id`'s whole envelope with a stored label map naming `spaceAtom` at
 * `["note"]`, the shape a reader finds on a document labeled before this
 * transaction existed.
 */
const seedLabeledDoc = (tx: IExtendedStorageTransaction, id: URI): void => {
  writeSeedEnvelopeDoc(tx, space);
  seedStoredEnvelope(tx, { space, scope: "space", id, path: [] }, {
    value: { note: "labeled" },
    cfc: {
      version: 1,
      schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
      labelMap: {
        version: 1,
        entries: [{ path: ["note"], label: { confidentiality: [spaceAtom] } }],
      },
    },
  } as unknown as FabricValue);
};

describe("CFC commit preparation", () => {
  // `docs/specs/cfc-commit-preparation.md` carries the argument these
  // cases pin, including why the last two settle a question about the
  // boundary's schema-document materialization.

  it("prepares a transaction that turns CFC-relevant after the caller prepared it", async () => {
    // Reading a document that carries stored labels marks the transaction
    // relevant, so relevance arrives here after the caller's own prepare has
    // already answered "not relevant".

    const { runtime, dispose } = makeRuntime();
    try {
      const seed = runtime.edit();
      const sourceId = runtime
        .getCell(space, "commit-prep-source", undefined, seed)
        .getAsNormalizedFullLink().id;
      seedLabeledDoc(seed, sourceId);
      expect((await seed.commit()).error).toBeUndefined();

      const tx = runtime.edit();
      const out = runtime.getCell<{ copied?: string }>(
        space,
        "commit-prep-out",
        undefined,
        tx,
      );
      out.set({ copied: "nothing yet" });

      runtime.prepareTxForCommit(tx);
      expect(tx.getCfcState().relevant).toBe(false);
      expect(tx.getCfcState().prepare.status).toBe("unprepared");

      // The read that marks it, after the prepare that did not see it.
      const source = runtime.getCell<{ note: string }>(
        space,
        "commit-prep-source",
        undefined,
        tx,
      );
      out.set({ copied: source.get()?.note });

      expect((await tx.commit()).error).toBeUndefined();
      expect(tx.getCfcState().relevant).toBe(true);
      expect(tx.getCfcState().prepare.status).toBe("prepared");
    } finally {
      await dispose();
    }
  });

  it("runs an `editWithRetry` action once for a CFC verdict on a transaction nothing prepared", async () => {
    // The missed call site, stubbed at the runtime the way
    // edit-with-retry-classification.test.ts stubs it. Preparing inside
    // `commit()` is what turns the refusal into the verdict it is: prepare
    // records a reason, the reason is a verdict on this transaction's data,
    // and a verdict is terminal.

    const { runtime, dispose } = makeRuntime();
    try {
      (runtime as unknown as { prepareTxForCommit: () => void })
        .prepareTxForCommit = () => {};

      let runs = 0;
      const { error } = await runtime.editWithRetry((tx) => {
        runs++;
        // The whole of a reserved grant document is policy state, so any
        // write to one outside `writeCfcGrant` is recorded and refused.
        tx.writeOrThrow({
          space,
          id: `${CFC_GRANT_ID_PREFIX}commit-preparation-probe` as URI,
          type: "application/json",
          path: ["value", "audience"],
        }, "did:key:zForged" as unknown as FabricValue);
      });

      expect(runs).toBe(1);
      expect(error?.name).toBe("CfcCommitRefusalError");
    } finally {
      await dispose();
    }
  });

  it("leaves a read-only transaction unprepared where a writable one is prepared", async () => {
    // A read-only transaction's commit takes none of the step, so neither
    // does the early call site: the two agree on what the ladder sees. The
    // read marks both transactions relevant, so the prepare state is what
    // separates them.

    const { runtime, dispose } = makeRuntime();
    try {
      const seed = runtime.edit();
      const sourceId = runtime
        .getCell(space, "commit-prep-read-only", undefined, seed)
        .getAsNormalizedFullLink().id;
      seedLabeledDoc(seed, sourceId);
      expect((await seed.commit()).error).toBeUndefined();

      const read = (tx: IExtendedStorageTransaction) =>
        runtime
          .getCell<{ note: string }>(
            space,
            "commit-prep-read-only",
            undefined,
            tx,
          )
          .get();

      const readOnlyTx = runtime.readTx();
      expect(read(readOnlyTx)?.note).toBe("labeled");
      expect(readOnlyTx.getCfcState().relevant).toBe(true);
      runtime.prepareTxForCommit(readOnlyTx);
      expect(readOnlyTx.getCfcState().prepare.status).toBe("unprepared");
      expect((await readOnlyTx.commit()).error).toBeUndefined();

      const writableTx = runtime.edit();
      read(writableTx);
      runtime.prepareTxForCommit(writableTx);
      expect(writableTx.getCfcState().prepare.status).toBe("prepared");
    } finally {
      await dispose();
    }
  });

  it("prepares the wrapped transaction when a child-cell wrapper is prepared", async () => {
    // A caller holding the wrapper `createChildCellTransaction` returns
    // prepares through it, and the prepared state lands on the transaction
    // that commits.

    const { runtime, dispose } = makeRuntime();
    try {
      const tx = runtime.edit();
      const childCellTx = runtime.edit();
      const cell = runtime.getCell<{ note: string }>(
        space,
        "commit-prep-wrapped",
        undefined,
        tx,
      );
      cell.set({ note: "wrapped" });
      tx.markCfcRelevant("child-cell wrapper");

      createChildCellTransaction(tx, childCellTx).prepareForCommit();

      expect(tx.getCfcState().prepare.status).toBe("prepared");
      expect((await tx.commit()).error).toBeUndefined();
      childCellTx.abort("unused by this test");
    } finally {
      await dispose();
    }
  });

  it("stages schema documents under `cid:` ids alone", async () => {
    // The materialization pass is the one step `commit()` takes that an
    // earlier prepare did not, and every write it makes lands on a `cid:`
    // document.

    const { runtime, dispose } = makeRuntime();
    try {
      const document = {
        type: "object",
        title: "commit-preparation-staged",
      } as const satisfies JSONSchema;
      const hash = internSchemaAsTaggedHashString(document);
      registerSchemaDocument(hash, document);

      const tx = runtime.edit();
      tx.stageSchemaDocClosure(space, hash);

      const ids = [...(tx.getWriteDetails?.(space) ?? [])].map(
        (write) => write.address.id,
      );
      expect(ids).toContain(`cid:${hash}`);
      expect(ids.filter((id) => !id.startsWith("cid:"))).toEqual([]);
    } finally {
      await dispose();
    }
  });

  it("leaves a transaction that writes a labeled `cid:` document unprepared", async () => {
    // The other half: the commit boundary verifies a `cid:` document's
    // VALUE against its id and never its envelope, so any same-space
    // principal can install one carrying whatever label map it likes, and
    // that map is out of the flow derivation on every channel. The same
    // write on an ordinary document is what relevance looks like when the
    // probe does see it.

    const { runtime, dispose } = makeRuntime();
    try {
      const seed = runtime.edit();
      const plainId = runtime.getCell(space, "commit-prep-plain")
        .getAsNormalizedFullLink().id;
      // `seedLabeledDoc` writes `{ note: "labeled" }` as the value.
      const cidId = `cid:${taggedHashStringOf({ note: "labeled" })}` as URI;
      seedLabeledDoc(seed, plainId);
      seedLabeledDoc(seed, cidId);
      expect((await seed.commit()).error).toBeUndefined();

      const write = (id: URI): IExtendedStorageTransaction => {
        const tx = runtime.edit();
        tx.writeOrThrow(
          { space, scope: "space", id, path: ["value", "note"] },
          "overwritten" as unknown as FabricValue,
        );
        return tx;
      };

      const plainTx = write(plainId);
      runtime.prepareTxForCommit(plainTx);
      expect(plainTx.getCfcState().relevant).toBe(true);

      const cidTx = write(cidId);
      runtime.prepareTxForCommit(cidTx);
      expect(cidTx.getCfcState().relevant).toBe(false);
      expect(cidTx.getCfcState().prepare.status).toBe("unprepared");
    } finally {
      await dispose();
    }
  });

  describe("a recorded write whose value is unchanged", () => {
    // A write the transaction recorded is an attempted write whatever value
    // it leaves behind (spec §8.10.2.1), so a labeled target of one makes the
    // transaction relevant, and the write replaces the derived component at
    // its path (§8.12.8). Neither the value it ends on nor another write in
    // the same space decides either.

    it("marks relevant a transaction whose only write to a labeled document returned to its starting value", async () => {
      const { runtime, dispose } = makeRuntime();
      try {
        const id = runtime.getCell(space, "commit-prep-reverted")
          .getAsNormalizedFullLink().id;
        const seed = runtime.edit();
        seedLabeledDoc(seed, id);
        expect((await seed.commit()).error).toBeUndefined();

        const tx = runtime.edit();
        const address = {
          space,
          scope: "space",
          id,
          path: ["value", "note"],
        } as const;
        tx.writeOrThrow(address, "overwritten" as unknown as FabricValue);
        tx.writeOrThrow(address, "labeled" as unknown as FabricValue);
        runtime.prepareTxForCommit(tx);
        expect(tx.getCfcState().relevant).toBe(true);
      } finally {
        await dispose();
      }
    });

    it("marks relevant a transaction whose only write is an authoritative write of a labeled document's unchanged value", async () => {
      const { runtime, dispose } = makeRuntime();
      try {
        const id = runtime.getCell(space, "commit-prep-authoritative")
          .getAsNormalizedFullLink().id;
        const seed = runtime.edit();
        seedLabeledDoc(seed, id);
        expect((await seed.commit()).error).toBeUndefined();

        const tx = runtime.edit();
        // The extended transaction marks itself only where it serves a seal
        // destination; the mode itself lives on the transaction it wraps.
        tx.tx.markAuthoritativeWrites!();
        tx.writeOrThrow(
          { space, scope: "space", id, path: ["value", "note"] },
          "labeled" as unknown as FabricValue,
        );
        runtime.prepareTxForCommit(tx);
        expect(tx.getCfcState().relevant).toBe(true);
      } finally {
        await dispose();
      }
    });

    it("counts a labeled read after a root write carrying the stored label map forward returned to its starting value", async () => {
      // A root write carrying the stored `cfc` record forward passes the
      // forgery check, and one that ends where it started minted nothing, so
      // the document's labels stay pre-existing ones a read consumes. The
      // unlabeled write beside it is what puts the space among the written
      // ones either way.

      const { runtime, dispose } = makeRuntime();
      try {
        const id = runtime.getCell(space, "commit-prep-carried")
          .getAsNormalizedFullLink().id;
        const copyId = runtime.getCell(space, "commit-prep-copy")
          .getAsNormalizedFullLink().id;
        const seed = runtime.edit();
        seedLabeledDoc(seed, id);
        expect((await seed.commit()).error).toBeUndefined();

        const tx = runtime.edit();
        const note = tx.readOrThrow({
          space,
          scope: "space",
          id,
          path: ["value", "note"],
        });
        const envelope = (value: FabricValue) => ({
          value,
          cfc: {
            version: 1,
            schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
            labelMap: {
              version: 1,
              entries: [{
                path: ["note"],
                label: { confidentiality: [spaceAtom] },
              }],
            },
          },
        } as unknown as FabricValue);
        const root = { space, scope: "space", id, path: [] } as const;
        tx.writeOrThrow(root, envelope({ note: "decoy" } as FabricValue));
        tx.writeOrThrow(root, envelope({ note: "labeled" } as FabricValue));
        tx.writeOrThrow(
          { space, scope: "space", id: copyId, path: [] },
          { value: { copied: note } } as unknown as FabricValue,
        );
        runtime.prepareTxForCommit(tx);
        expect(tx.getCfcState().relevant).toBe(true);
      } finally {
        await dispose();
      }
    });

    it("replaces a reverted path's derived label whether or not another document in its space changed", async () => {
      for (const otherChange of [false, true]) {
        // `observe` lets the schema-less writes commit, so the label map
        // they leave behind can be read back.
        const { runtime, dispose } = makeRuntime({
          cfcEnforcementMode: "observe",
        });
        try {
          const id = runtime.getCell(space, "commit-prep-derived")
            .getAsNormalizedFullLink().id;
          const otherId = runtime.getCell(space, "commit-prep-other")
            .getAsNormalizedFullLink().id;
          const seed = runtime.edit();
          writeSeedEnvelopeDoc(seed, space);
          seedStoredEnvelope(seed, { space, scope: "space", id, path: [] }, {
            value: { note: "labeled" },
            cfc: {
              version: 1,
              schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
              labelMap: {
                version: 1,
                entries: [{
                  path: ["note"],
                  origin: "derived",
                  label: { confidentiality: [spaceAtom] },
                }],
              },
            },
          } as unknown as FabricValue);
          seed.writeOrThrow(
            { space, scope: "space", id: otherId, path: [] },
            { value: { count: 1 } } as unknown as FabricValue,
          );
          expect((await seed.commit()).error).toBeUndefined();

          const tx = runtime.edit();
          const address = {
            space,
            scope: "space",
            id,
            path: ["value", "note"],
          } as const;
          tx.writeOrThrow(address, "overwritten" as unknown as FabricValue);
          tx.writeOrThrow(address, "labeled" as unknown as FabricValue);
          if (otherChange) {
            tx.writeOrThrow(
              { space, scope: "space", id: otherId, path: ["value", "count"] },
              2 as unknown as FabricValue,
            );
          }
          expect((await tx.commit()).error).toBeUndefined();

          const check = runtime.edit();
          const stored = check.readOrThrow({
            space,
            scope: "space",
            id,
            path: [],
          }) as {
            value?: unknown;
            cfc?: { labelMap?: { entries?: unknown[] } };
          };
          check.abort();
          expect(stored.value).toEqual({ note: "labeled" });
          // The value entry is replaced by this transaction's empty
          // derivation; the existence entry is frozen at creation and stays.
          expect(stored.cfc?.labelMap?.entries).toEqual([{
            path: ["note"],
            origin: "derived",
            observes: "shape",
            label: { confidentiality: [spaceAtom] },
          }]);
        } finally {
          await dispose();
        }
      }
    });
  });
});
