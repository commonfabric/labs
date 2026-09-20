import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import type { CfcConfClause } from "../src/cfc/clause.ts";
import { stampWaveRunContext } from "../src/executor/wave.ts";
import { toMemorySpaceAddress } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";

const signer = await Identity.fromPassphrase("cell read ceiling");
const A = { type: "https://commonfabric.org/cfc/atom/User", subject: "A" };
const B = { type: "https://commonfabric.org/cfc/atom/User", subject: "B" };

describe("cfc-cell-read-ceiling", () => {
  let storage: ReturnType<typeof StorageManager.emulate>;
  let writer: Runtime;
  const readers: Runtime[] = [];

  beforeEach(() => {
    storage = StorageManager.emulate({ as: signer });
    writer = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager: storage,
      cfcEnforcementMode: "enforce-strict",
      cfcFlowLabels: "persist",
    });
  });

  afterEach(async () => {
    for (const reader of readers.splice(0)) await reader.dispose();
    await writer.dispose();
    await storage.close();
  });

  const readerFor = (ceiling: readonly CfcConfClause[]) => {
    const reader = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager: storage,
      cfcReadMaxConfidentiality: ceiling,
      cfcEnforcementMode: "enforce-strict",
      cfcFlowLabels: "persist",
    });
    readers.push(reader);
    return reader;
  };

  const seed = async (clauses: readonly CfcConfClause[]) => {
    const tx = writer.edit();
    const cell = writer.getCell(signer.did(), crypto.randomUUID(), {
      type: "object",
      properties: { secret: { type: "string" } },
      ifc: { confidentiality: [...clauses] },
    }, tx);
    cell.set({ secret: "withheld content" });
    expect((await tx.commit()).error).toBeUndefined();
    await cell.sync();
    return cell.getAsNormalizedFullLink();
  };

  it("withholds a stored cell outside the runtime ceiling on value and raw reads", async () => {
    const link = await seed([B]);
    const cell = readerFor([A]).getCellFromLink(link);
    await cell.sync();

    expect(() => cell.get()).toThrow(/read ceiling/);
    expect(() => cell.getRaw()).toThrow(/read ceiling/);
    expect(() => cell.getRaw({ nonRecursive: true })).toThrow(/read ceiling/);
    expect(() => cell.key("secret").get()).toThrow(/read ceiling/);
  });

  it("withholds direct transaction reads of protected content", async () => {
    const link = await seed([B]);
    const reader = readerFor([A]);
    const tx = reader.edit();
    try {
      expect(() => tx.read(toMemorySpaceAddress(link))).toThrow(/read ceiling/);
      expect(() => tx.readValueOrThrow(link)).toThrow(/read ceiling/);
      expect(() => tx.read({ ...toMemorySpaceAddress(link), path: [] }))
        .toThrow(/read ceiling/);
    } finally {
      tx.abort();
    }
  });

  it("meets a served session ceiling with the runtime ceiling", async () => {
    const link = await seed([B]);
    const reader = readerFor([A, B]);
    const cell = reader.getCellFromLink(link);
    await cell.sync();
    expect(cell.get()).toEqual({ secret: "withheld content" });
    const tx = reader.edit();
    stampWaveRunContext(tx, {
      actionId: "test:cell-read-ceiling",
      kind: "derivation",
      readCeiling: { maxConfidentiality: [A] },
    });
    try {
      expect(() => cell.withTx(tx).get()).toThrow(/read ceiling/);
      expect(() => cell.withTx(tx).sample()).toThrow(/read ceiling/);
    } finally {
      tx.abort();
    }
  });

  it("admits a public sibling while withholding a labeled field and its enclosing object", async () => {
    const tx = writer.edit();
    const cell = writer.getCell(signer.did(), "field labels", {
      type: "object",
      properties: {
        public: { type: "string" },
        private: { type: "string", ifc: { confidentiality: [B] } },
      },
    }, tx);
    cell.set({ public: "public content", private: "private content" });
    expect((await tx.commit()).error).toBeUndefined();
    const projected = readerFor([A]).getCellFromLink(
      cell.getAsNormalizedFullLink(),
    );
    await projected.sync();
    expect(projected.key("public").get()).toBe("public content");
    expect(() => projected.key("private").get()).toThrow(/read ceiling/);
    expect(() => projected.getRaw({ nonRecursive: true })).toThrow(
      /read ceiling/,
    );
  });

  it("withholds an array's length without labeling an addressed element", async () => {
    const tx = writer.edit();
    const cell = writer.getCell(signer.did(), "array membership", {
      type: "array",
      items: { type: "string" },
      ifc: { confidentiality: [B], observes: "enumerate" },
    }, tx);
    cell.set(["public element"]);
    expect((await tx.commit()).error).toBeUndefined();
    const reader = readerFor([A]);
    const projected = reader.getCellFromLink(cell.getAsNormalizedFullLink());
    await projected.sync();

    expect(projected.key(0).get()).toBe("public element");
    expect(() => projected.key("length").get()).toThrow(/read ceiling/);
    const readTx = reader.edit();
    try {
      const address = toMemorySpaceAddress(
        projected.key("length").getAsNormalizedFullLink(),
      );
      expect(() => readTx.read(address)).toThrow(/read ceiling/);
    } finally {
      readTx.abort();
    }
  });

  it("reads a public array length without consuming its element-content label", async () => {
    const tx = writer.edit();
    const cell = writer.getCell(signer.did(), "private array contents", {
      type: "array",
      items: { type: "string" },
      ifc: { confidentiality: [B], observes: "value" },
    }, tx);
    cell.set(["private element"]);
    expect((await tx.commit()).error).toBeUndefined();
    const projected = readerFor([A]).getCellFromLink(
      cell.getAsNormalizedFullLink(),
    );
    await projected.sync();

    expect(projected.key("length").get()).toBe(1);
    expect(() => projected.key(0).get()).toThrow(/read ceiling/);
  });

  it("withholds an array length carrying its own stored label", async () => {
    const tx = writer.edit();
    const cell = writer.getCell(
      signer.did(),
      "labeled native length",
      undefined,
      tx,
    );
    const link = cell.getAsNormalizedFullLink();
    writeSeedEnvelopeDoc(tx, signer.did());
    seedStoredEnvelope(tx, { ...toMemorySpaceAddress(link), path: [] }, {
      value: ["public element"],
      cfc: {
        version: 1,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: {
          version: 1,
          entries: [{ path: ["length"], label: { confidentiality: [B] } }],
        },
      },
    });
    expect((await tx.commit()).error).toBeUndefined();
    const projected = readerFor([A]).getCellFromLink(link);
    await projected.sync();

    expect(projected.key(0).get()).toBe("public element");
    expect(() => projected.key("length").get()).toThrow(/read ceiling/);
  });

  it("reads an object's length field independently of its membership label", async () => {
    const tx = writer.edit();
    const cell = writer.getCell(signer.did(), "ordinary length field", {
      type: "object",
      properties: { length: { type: "number" } },
      ifc: { confidentiality: [B], observes: "enumerate" },
    }, tx);
    cell.set({ length: 17 });
    expect((await tx.commit()).error).toBeUndefined();
    const projected = readerFor([A]).getCellFromLink(
      cell.getAsNormalizedFullLink(),
    );
    await projected.sync();

    expect(projected.key("length").get()).toBe(17);
    expect(() => projected.get()).toThrow(/read ceiling/);
  });

  it("withholds a concrete label under an unresolved database-owner ceiling", async () => {
    const link = await seed([signer.did()]);
    const symbolic = readerFor([{ __ctDbOwner: true }]).getCellFromLink(link);
    const concrete = readerFor([signer.did()]).getCellFromLink(link);
    await symbolic.sync();
    await concrete.sync();
    expect(() => symbolic.get()).toThrow(/read ceiling/);
    expect(concrete.get()).toEqual({ secret: "withheld content" });
  });

  it("admits public and group-readable cells under a group ceiling", async () => {
    const reader = readerFor([{ anyOf: [A, B] }]);
    for (const clauses of [[], [{ anyOf: [A, B] }]]) {
      const cell = reader.getCellFromLink(await seed(clauses));
      await cell.sync();
      expect(cell.get()).toEqual({ secret: "withheld content" });
    }
  });

  it("withholds each single-reader label and their conjunction under a group ceiling", async () => {
    const reader = readerFor([{ anyOf: [A, B] }]);
    for (const clauses of [[A], [B], [A, B]]) {
      const cell = reader.getCellFromLink(await seed(clauses));
      await cell.sync();
      expect(() => cell.get()).toThrow(/read ceiling/);
    }
  });
});
