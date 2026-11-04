import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import { hostValueOf, readProjected, sinkProjected } from "../src/cell.ts";
import { KeepAsCell } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { newSharedServer } from "./memory-v2-test-utils.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";

const signer = await Identity.fromPassphrase("cell-read-projected");
const space = signer.did();
const SECRET_ATOM = "cell-read-projected-secret";
const OTHER_ATOM = "cell-read-projected-other";

// A record whose `entry` field its schema leaves untyped, holding a link to a
// labeled document one level down. A read of the record under that schema
// leaves the field to be read once something looks at it.
const untyped = {
  type: "object",
  properties: { entry: {} },
} as const;

// The same record read through a schema that types the linked value, as a
// reader that names the field it shows reads it.
const typed = {
  type: "object",
  properties: {
    entry: { type: "object", properties: { inner: { type: "string" } } },
  },
} as const;

/** A runtime holding the labeled document and the record that links to it,
 *  over its own store or over `server`'s, as another client of it. */
async function holder(server?: MemoryV2Server.Server) {
  const storageManager = server
    ? EmulatedStorageManager.connectTo(server, { as: signer })
    : StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    storageManager,
    apiUrl: new URL(import.meta.url),
  });
  const secret = runtime.getCell<string>(space, "secret");
  const writeSecret = async (value: string, atom = SECRET_ATOM) => {
    const tx = runtime.edit();
    writeSeedEnvelopeDoc(tx, space);
    seedStoredEnvelope(tx, { ...secret.getAsNormalizedFullLink(), path: [] }, {
      value,
      cfc: {
        version: 1,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: {
          version: 1,
          entries: [{ path: [], label: { confidentiality: [atom] } }],
        },
      },
    });
    expect((await tx.commit().settled).error).toBeUndefined();
    await runtime.idle();
  };
  // The label alone, stored over the one there, the value left as it is.
  const writeLabel = async (atom: string) => {
    const tx = runtime.edit();
    seedStoredEnvelope(
      tx,
      { ...secret.getAsNormalizedFullLink(), path: ["cfc"] },
      {
        version: 1,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: {
          version: 1,
          entries: [{ path: [], label: { confidentiality: [atom] } }],
        },
      },
    );
    // Its verdict alone: under a server whose fan-out the test delivers,
    // coverage of the write waits on that delivery.
    const committed = await tx.commit({ holdSyncedUntilCovered: false })
      .verdict;
    expect(committed.error).toBeUndefined();
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
  expect((await tx.commit().settled).error).toBeUndefined();
  await runtime.idle();
  return {
    runtime,
    record: record.asSchema(untyped),
    secret,
    writeSecret,
    writeLabel,
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

    it("runs again when only a label of what the projection read changes", async () => {
      // The value stays as it was and only the label stored with it moves,
      // as when someone else writes the same value: what a reader decides on
      // that label (whose a value is, what it may be shown beside) moved. The
      // reader is another client, told of the write by the server, as a
      // reader of someone else's document is, and it reads the value through
      // a schema that types it.
      // Fan-out held until the test delivers it, so the reader is told of
      // the write at a point the test names.
      const server = newSharedServer({ subscriptionRefreshDelayMs: "manual" });
      try {
        await using docs = await holder(server);
        const storageManager = EmulatedStorageManager.connectTo(server, {
          as: signer,
        });
        const reader = new Runtime({
          storageManager,
          apiUrl: new URL(import.meta.url),
        });
        try {
          const record = reader.getCellFromLink(docs.record.getAsLink())
            .asSchema(typed);
          await record.pull();
          const delivered: unknown[] = [];
          let confidentiality: readonly unknown[] = [];
          const cancel = sinkProjected(record, hostValueOf, (value, read) => {
            delivered.push(value);
            confidentiality = read?.confidentiality ?? [];
          });
          try {
            await reader.idle();
            expect(confidentiality).toContain(SECRET_ATOM);
            const before = delivered.length;
            await docs.writeLabel(OTHER_ATOM);
            await server.flushSessions([space]);
            await clock.settle();
            await storageManager.synced();
            await reader.idle();
            // The new label has reached the reader: a read that subscribes to
            // nothing, so it cannot have run the sink itself.
            const secret = reader.getCellFromLink(docs.secret.getAsLink());
            expect(
              readProjected(secret, (value) => value).consumed.confidentiality,
            ).toContain(OTHER_ATOM);

            expect(delivered.length).toBe(before + 1);
            expect(delivered.at(-1)).toEqual({
              entry: { inner: "first secret" },
            });
            expect(confidentiality).toContain(OTHER_ATOM);
            expect(confidentiality).not.toContain(SECRET_ATOM);
          } finally {
            cancel();
          }
        } finally {
          await reader.dispose();
          await storageManager.close();
        }
      } finally {
        await server.close();
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
