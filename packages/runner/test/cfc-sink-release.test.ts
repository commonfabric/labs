import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import { describeSinkReleaseRefusal } from "../src/cfc/prepare.ts";

const signer = await Identity.fromPassphrase("runner-cfc-sink-release");
const space = signer.did();

//
// The release measurement
//
// The commit boundary answers what a ceiling refuses for the sink requests a
// transaction records. A host releasing a value of its own — a tool answering
// a model with what a piece computed — records no request and commits
// nothing, so it reads what it is about to release through a transaction and
// asks the same question of that transaction's consumed join.
//

describe("describeSinkReleaseRefusal", () => {
  const newRuntime = (
    storageManager: ReturnType<typeof StorageManager.emulate>,
  ) =>
    new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "enforce-strict",
      cfcFlowLabels: "persist",
    });

  /** A document carrying `atom` on its `secret` field. */
  const seedLabeled = async (runtime: Runtime, cause: string, atom: string) => {
    const seed = runtime.edit();
    const cell = runtime.getCell(
      space,
      cause,
      { type: "object", properties: { secret: { type: "string" } } },
      seed,
    );
    const id = cell.getAsNormalizedFullLink().id;
    writeSeedEnvelopeDoc(seed, space);
    seedStoredEnvelope(seed, { space, scope: "space", id, path: [] }, {
      value: { secret: "s3cr3t" },
      cfc: {
        version: 1,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: {
          version: 1,
          entries: [{ path: ["secret"], label: { confidentiality: [atom] } }],
        },
      },
    });
    expect((await seed.commit()).ok).toBeDefined();
    return { id, path: [] as string[], space, scope: "space" as const };
  };

  it("refuses nothing for a transaction that read no labeled document", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = newRuntime(storageManager);
    try {
      const seed = runtime.edit();
      const plain = runtime.getCell(space, "release-plain", undefined, seed);
      plain.set({ note: "public" });
      expect((await seed.commit()).error).toBeUndefined();

      const tx = runtime.edit();
      const cell = runtime.getCellFromLink(
        plain.getAsNormalizedFullLink(),
      ).withTx(tx);
      await cell.pull();
      JSON.stringify(cell.get());
      expect(describeSinkReleaseRefusal(tx, tx, "answer", [])).toBeUndefined();
      tx.abort();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("names the clause a walked read carried, and the read that carried it", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = newRuntime(storageManager);
    try {
      const link = await seedLabeled(runtime, "release-walked", "alice-secret");
      const tx = runtime.edit();
      const cell = runtime.getCellFromLink(link).withTx(tx);
      await cell.pull();
      JSON.stringify(cell.get());

      const refusal = describeSinkReleaseRefusal(tx, tx, "answer", []);
      expect(refusal?.gate).toBe("sink-ceiling");
      expect(refusal?.sink).toBe("answer");
      expect(refusal?.offendingAtoms).toEqual(['"alice-secret"']);
      expect(refusal?.attribution).toBe("complete");
      expect(refusal?.inputs.map((input) => input.read.id)).toContain(link.id);
      tx.abort();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("refuses nothing for a read that stopped above the labeled field", async () => {
    // A label on a field is consumed where that field is read: a read of the
    // document root is recorded as non-recursive, and counts entries at or
    // above it only. A caller measuring a release therefore has to walk the
    // value it is about to hand over, not merely resolve it.
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = newRuntime(storageManager);
    try {
      const link = await seedLabeled(runtime, "release-unwalked", "bob-secret");
      const tx = runtime.edit();
      const cell = runtime.getCellFromLink(link).withTx(tx);
      await cell.pull();
      cell.get();
      expect(describeSinkReleaseRefusal(tx, tx, "answer", [])).toBeUndefined();
      tx.abort();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("reports a clause no attribution read carried as unattributed", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = newRuntime(storageManager);
    try {
      const released = await seedLabeled(
        runtime,
        "release-released",
        "carol-secret",
      );
      const attributed = await seedLabeled(
        runtime,
        "release-attributed",
        "dave-secret",
      );
      const releasedTx = runtime.edit();
      const releasedCell = runtime.getCellFromLink(released).withTx(releasedTx);
      await releasedCell.pull();
      JSON.stringify(releasedCell.get());

      const attributedTx = runtime.edit();
      const attributedCell = runtime.getCellFromLink(attributed)
        .withTx(attributedTx);
      await attributedCell.pull();
      JSON.stringify(attributedCell.get());

      const refusal = describeSinkReleaseRefusal(
        releasedTx,
        attributedTx,
        "answer",
        [],
      );
      expect(refusal?.offendingAtoms).toEqual(['"carol-secret"']);
      expect(refusal?.inputs).toEqual([]);
      expect(refusal?.attribution).toBe("none");
      releasedTx.abort();
      attributedTx.abort();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("admits a clause the ceiling names", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = newRuntime(storageManager);
    try {
      const link = await seedLabeled(runtime, "release-admitted", "erin-ok");
      const tx = runtime.edit();
      const cell = runtime.getCellFromLink(link).withTx(tx);
      await cell.pull();
      JSON.stringify(cell.get());
      expect(describeSinkReleaseRefusal(tx, tx, "answer", ["erin-ok"]))
        .toBeUndefined();
      tx.abort();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
