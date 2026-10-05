import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import { hostValueOf, readProjected, sinkProjected } from "../src/cell.ts";
import { KeepAsCell } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";

const signer = await Identity.fromPassphrase("cell-read-projected");
const space = signer.did();
const SECRET_ATOM = "cell-read-projected-secret";

// A record whose `entry` field its schema leaves untyped, holding a link to a
// labeled document one level down. A read of the record under that schema
// leaves the field to be read once something looks at it.
const untyped = {
  type: "object",
  properties: { entry: {} },
} as const;

/** A runtime holding the labeled document and the record that links to it. */
async function holder() {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    storageManager,
    apiUrl: new URL(import.meta.url),
  });
  const secret = runtime.getCell<string>(space, "secret");
  const writeSecret = async (value: string) => {
    const tx = runtime.edit();
    writeSeedEnvelopeDoc(tx, space);
    seedStoredEnvelope(tx, { ...secret.getAsNormalizedFullLink(), path: [] }, {
      value,
      cfc: {
        version: 1,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: {
          version: 1,
          entries: [{ path: [], label: { confidentiality: [SECRET_ATOM] } }],
        },
      },
    });
    expect((await tx.commit()).error).toBeUndefined();
    await runtime.idle();
  };
  await writeSecret("first secret");
  const record = runtime.getCell(space, "record");
  const tx = runtime.edit();
  record.withTx(tx).setRawUntyped({
    entry: {
      inner: secret.getAsLink({
        includeSchema: true,
        keepAsCell: KeepAsCell.All,
      }),
    },
  } as never);
  expect((await tx.commit()).error).toBeUndefined();
  await runtime.idle();
  return {
    runtime,
    record: record.asSchema(untyped),
    writeSecret,
    async [Symbol.asyncDispose]() {
      await runtime.dispose();
      await storageManager.close();
    },
  };
}

describe("cell-read-projected", () => {
  describe("readProjected()", () => {
    it("returns what the projection made of the value", async () => {
      await using docs = await holder();
      const read = readProjected(docs.record, hostValueOf);

      expect(read.value).toEqual({ entry: { inner: "first secret" } });
    });

    it("joins the labels of what the projection read through an untyped field", async () => {
      await using docs = await holder();
      const read = readProjected(docs.record, hostValueOf);

      expect(read.consumed.confidentiality).toContain(SECRET_ATOM);
    });

    it("joins only what the read reached when the projection reads nothing more", async () => {
      await using docs = await holder();
      const read = readProjected(docs.record, () => "nothing read");

      expect(read.consumed.confidentiality).not.toContain(SECRET_ATOM);
    });

    it("returns a stream as itself", async () => {
      await using docs = await holder();
      const stream = docs.runtime.getCell(space, "a-stream", {
        asCell: ["stream"],
      });
      const read = readProjected(stream, hostValueOf);

      expect(read.value).toEqual(
        expect.objectContaining({ "/": expect.anything() }),
      );
    });
  });

  describe("sinkProjected()", () => {
    it("joins the labels of what the projection read, and runs again when that changes", async () => {
      await using docs = await holder();
      const delivered: unknown[] = [];
      let confidentiality: readonly unknown[] = [];
      const cancel = sinkProjected(docs.record, hostValueOf, (value, read) => {
        delivered.push(value);
        confidentiality = read?.confidentiality ?? [];
      });
      try {
        expect(confidentiality).toContain(SECRET_ATOM);
        await docs.writeSecret("second secret");

        expect(delivered.at(-1)).toEqual({ entry: { inner: "second secret" } });
      } finally {
        cancel();
      }
    });

    it("refuses a stream, which holds no value to project", async () => {
      await using docs = await holder();
      const stream = docs.runtime.getCell(space, "a-stream", {
        asCell: ["stream"],
      });

      expect(() => sinkProjected(stream, hostValueOf, () => {})).toThrow(
        TypeError,
      );
    });
  });
});
