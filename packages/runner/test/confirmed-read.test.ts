import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";
import {
  collectExternalSchemaRefHashes,
  parseExternalSchemaRef,
} from "@commonfabric/data-model-schema/schema-refs";
import { isObjectNotArray } from "@commonfabric/utils/types";

import type { Cell } from "../src/cell.ts";
import type {
  IExtendedStorageTransaction,
  SealedCommitVerdict,
  URI,
} from "../src/storage/interface.ts";
import { readConfirmed, readDurable } from "../src/confirmed-read.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import { writeResultSchemaMeta } from "../src/result-schema-meta.ts";
import { Runtime } from "../src/runtime.ts";
import { lookupSchemaDocument } from "../src/schema-registry.ts";
import type { SessionSync } from "@commonfabric/memory/v2";
import type { SpaceReplica } from "../src/storage/v2.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("confirmed read");
const space = signer.did();

const noteSchema = {
  type: "object",
  properties: { n: { type: "number" } },
} as const satisfies JSONSchema;
type Note = { n?: number };

const parentSchema = {
  type: "object",
  properties: {
    n: { type: "number" },
    child: { ...noteSchema, asCell: ["cell"] },
  },
} as const satisfies JSONSchema;
type Parent = { n?: number; child?: Cell<Note> };

describe("confirmed-read", () => {
  let server: MemoryV2Server.Server;
  let writerManager: EmulatedStorageManager;
  let readerManager: EmulatedStorageManager;
  let writer: Runtime;
  let reader: Runtime;

  beforeEach(() => {
    server = newSharedServer();
    writerManager = EmulatedStorageManager.connectTo(server, { as: signer });
    readerManager = EmulatedStorageManager.connectTo(server, { as: signer });
    writer = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: writerManager,
    });
    reader = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: readerManager,
    });
  });

  afterEach(async () => {
    await reader.dispose();
    await writer.dispose();
    await readerManager.close();
    await writerManager.close();
    await server.close();
  });

  /** Writes `n` to the note named `cause` from the writer, and returns the
   * sequence the commit landed at. */
  async function write(cause: string, n: number): Promise<number> {
    const tx = writer.edit();
    writer.getCell<Note>(space, cause, noteSchema, tx).set({ n });
    expect((await tx.commit().settled).error).toBeUndefined();
    return tx.committedSeq!(space)!;
  }

  /** The reader's note named `cause`, loaded. */
  async function loaded(cause: string): Promise<Cell<Note>> {
    const note = reader.getCell<Note>(space, cause, noteSchema);
    await note.sync();
    return note;
  }

  /** Resolves once the reader's `note` holds `n`. */
  function arrival(note: Cell<Note>, n: number): Promise<void> {
    const arrived = Promise.withResolvers<void>();
    const cancel = note.sink((value) => {
      if (value?.n === n) arrived.resolve();
    });
    return arrived.promise.finally(cancel);
  }

  it("returns the read as confirmed and complete through a commit a push delivered", async () => {
    await write("first", 1);
    await write("second", 1);
    const first = await loaded("first");
    const second = await loaded("second");

    const delivered = arrival(first, 2);
    const seq = await write("first", 2);
    await delivered;

    const read = readConfirmed(reader, space, (tx) => ({
      first: first.withTx(tx).get()?.n,
      second: second.withTx(tx).get()?.n,
    }));
    expect(read.value).toEqual({ first: 2, second: 1 });
    expect(read.confirmed).toBe(true);
    expect(read.seq).toBeGreaterThanOrEqual(seq);
  });

  it("reads a document and the document it links to as one confirmed read", async () => {
    await write("child", 1);
    const created = writer.edit();
    writer.getCell<Parent>(space, "parent", parentSchema, created).set({
      n: 1,
      child: writer.getCell<Note>(space, "child", noteSchema, created),
    });
    expect((await created.commit().settled).error).toBeUndefined();
    const parent = reader.getCell<Parent>(space, "parent", parentSchema);
    await parent.sync();
    const child = await loaded("child");

    const delivered = arrival(child, 2);
    const seq = await write("child", 2);
    await delivered;

    const read = readConfirmed(reader, space, (tx) => {
      const value = parent.withTx(tx).get();
      return { n: value?.n, child: value?.child?.withTx(tx).get()?.n };
    });
    expect(read.value).toEqual({ n: 1, child: 2 });
    expect(read.confirmed).toBe(true);
    expect(read.seq).toBeGreaterThanOrEqual(seq);
  });

  it("returns a newly written cell as confirmed after settlement", async () => {
    const tx = reader.edit();
    const note = reader.getCell<Note>(space, "new-own", noteSchema, tx);
    note.set({ n: 1 });
    expect((await tx.commit().settled).error).toBeUndefined();
    expect(
      readConfirmed(reader, space, (readTx) => note.withTx(readTx).get()?.n)
        .confirmed,
    ).toBe(true);
  });

  it("returns a blind whole-document write as confirmed after settlement", async () => {
    const address = {
      space,
      id: "of:blind-own" as URI,
      type: "application/json" as const,
      path: [],
    };
    const tx = reader.edit();
    expect(tx.write(address, { value: { n: 1 } }).error).toBeUndefined();
    expect((await tx.commit().settled).error).toBeUndefined();
    const read = readConfirmed(
      reader,
      space,
      (readTx) => readTx.read(address).ok?.value,
    );
    expect(read.value).toEqual({ value: { n: 1 } });
    expect(read.confirmed).toBe(true);
  });

  describe("of an accepted document without delivery", () => {
    const address = {
      space,
      id: "of:blind-confirmation" as URI,
      type: "application/json" as const,
      path: [],
    };

    /** Writes a complete document through `runtime` without starting a watch. */
    async function replace(runtime: Runtime, n: number): Promise<void> {
      const tx = runtime.edit();
      expect(tx.write(address, { value: { n } }).error).toBeUndefined();
      expect((await tx.commit().settled).error).toBeUndefined();
    }

    /** Reads the complete document without starting a watch. */
    function readDocument() {
      return readConfirmed(reader, space, (tx) => tx.read(address).ok?.value);
    }

    it("returns an elided whole-document set as confirmed", async () => {
      await replace(writer, 7);
      await replace(reader, 7);
      expect(readDocument()).toEqual({
        value: { value: { n: 7 } },
        confirmed: true,
      });
    });

    it("returns an accepted deletion as confirmed", async () => {
      await replace(writer, 7);
      const replica = readerManager.open(space).replica;
      expect(
        (await replica.commitNative!({
          operations: [{
            op: "delete",
            id: address.id,
            type: address.type,
          }],
        })).error,
      ).toBeUndefined();
      expect(readDocument()).toEqual({ value: undefined, confirmed: true });
    });

    it("returns an elided deletion of an absent document as confirmed", async () => {
      const replica = readerManager.open(space).replica;
      expect(
        (await replica.commitNative!({
          operations: [{
            op: "delete",
            id: address.id,
            type: address.type,
          }],
        })).error,
      ).toBeUndefined();
      expect(readDocument()).toEqual({ value: undefined, confirmed: true });
    });

    it("returns no sequence for an unobserved version even after unrelated pushes advance", async () => {
      await replace(reader, 1);
      await replace(writer, 2);
      await write("observed", 1);
      const observed = await loaded("observed");
      const delivered = arrival(observed, 2);
      const seq = await write("observed", 2);
      await delivered;
      expect(
        readConfirmed(reader, space, (tx) => observed.withTx(tx).get()).seq,
      )
        .toBeGreaterThanOrEqual(seq);
      expect(readDocument()).toEqual({
        value: { value: { n: 1 } },
        confirmed: true,
      });

      expect((await readerManager.open(space).sync(address.id)).error)
        .toBeUndefined();
      const read = readDocument();
      expect(read.value).toEqual({ value: { n: 2 } });
      expect(read.confirmed).toBe(true);
      expect(read.seq).toBeGreaterThanOrEqual(seq);
    });

    it("returns an unconfirmed read while a whole-document write is pending", async () => {
      const tx = reader.edit();
      tx.write(address, { value: { n: 1 } });
      const receipt = tx.commit();
      const read = readDocument();
      expect((await receipt.settled).error).toBeUndefined();
      expect(read).toEqual({ value: { value: { n: 1 } }, confirmed: false });
    });

    it("returns an unconfirmed read after a blind patch over an accepted version", async () => {
      await replace(reader, 1);
      const foreign = writer.edit();
      foreign.write(address, { value: { n: 1, hidden: 9 } });
      expect((await foreign.commit().settled).error).toBeUndefined();
      const replica = readerManager.open(space).replica;
      expect(
        (await replica.commitNative!({
          operations: [{
            op: "patch",
            id: address.id,
            type: address.type,
            patches: [{ op: "replace", path: "/value/n", value: 2 }],
            value: { value: { n: 2 } },
          }],
        })).error,
      ).toBeUndefined();
      expect(readDocument().confirmed).toBe(false);
    });
  });

  describe("of a content-addressed schema document", () => {
    // A document's schema is stored as `cid:` documents in the transaction
    // that writes it. The server ships them with a document that refers to
    // them, and does not send a replica its own change to a document it holds,
    // so a replica that changed a loaded document's schema is never sent them.

    const resultSchema = {
      type: "object",
      properties: {
        title: { $ref: "#/$defs/Title" },
        detail: { $ref: "#/$defs/Detail" },
      },
      $defs: {
        Title: { type: "string", description: "A confirmed read's title" },
        Detail: { type: "object", properties: { count: { type: "number" } } },
      },
    } as const satisfies JSONSchema;

    /** The documents `cell`'s stored `schema` metadata names: its root and
     * every document the root refers to. */
    function schemaDocumentsOf(cell: Cell<unknown>): URI[] {
      const stored = cell.getMetaRaw("schema");
      const ref = isObjectNotArray(stored) ? stored.$ref : undefined;
      const root = typeof ref === "string"
        ? parseExternalSchemaRef(ref)?.taggedHash
        : undefined;
      expect(root).toBeDefined();
      const closure = new Set<string>([root!]);
      for (const hash of closure) {
        for (
          const dependency of collectExternalSchemaRefHashes(
            lookupSchemaDocument(hash),
          )
        ) {
          closure.add(dependency);
        }
      }
      return [...closure].map((hash): URI => `cid:${hash}`);
    }

    /** `readConfirmed` of the reader's read of the documents `ids`, returning
     * whether it found each one. */
    function confirmedReadOf(ids: URI[]) {
      return readConfirmed(
        reader,
        space,
        (tx) =>
          ids.every((id) =>
            tx.read({ space, id, type: "application/json", path: [] }).ok
              ?.value !== undefined
          ),
      );
    }

    it("returns a read of the ones the reader's own commit stored as confirmed once a push covers its commit", async () => {
      await write("described", 1);
      const described = await loaded("described");
      const tx = reader.edit();
      expect(writeResultSchemaMeta(described.withTx(tx), resultSchema)).toBe(
        true,
      );
      expect((await tx.commit().settled).error).toBeUndefined();
      const seq = tx.committedSeq!(space)!;
      const ids = schemaDocumentsOf(described);
      expect(ids.length).toBeGreaterThan(1);

      const read = confirmedReadOf(ids);
      expect(read.value).toBe(true);
      expect(read.confirmed).toBe(true);
      expect(read.seq).toBeGreaterThanOrEqual(seq);
    });

    it("returns an unconfirmed read of ones the reader's own commit has not had accepted", async () => {
      await write("described", 1);
      const described = await loaded("described");
      const tx = reader.edit();
      writeResultSchemaMeta(described.withTx(tx), resultSchema);
      const committed = tx.commit();
      const read = confirmedReadOf(schemaDocumentsOf(described));
      expect((await committed.settled).error).toBeUndefined();

      expect(read).toEqual({ value: true, confirmed: false });
    });

    it("returns an unconfirmed read of ones the reader does not hold", async () => {
      const tx = writer.edit();
      const described = writer.getCell<Note>(
        space,
        "described",
        noteSchema,
        tx,
      );
      described.set({ n: 1 });
      writeResultSchemaMeta(described, resultSchema);
      expect((await tx.commit().settled).error).toBeUndefined();

      const read = confirmedReadOf(
        schemaDocumentsOf(writer.getCell<Note>(space, "described", noteSchema)),
      );
      expect(read).toEqual({ value: false, confirmed: false });
    });
  });

  it("returns no sequence once a frame failed to apply", async () => {
    await write("broken", 1);
    const broken = await loaded("broken");
    const delivered = arrival(broken, 2);
    await write("broken", 2);
    await delivered;
    expect(readConfirmed(reader, space, () => undefined).seq).toBeDefined();

    // A frame without the upserts every frame carries fails to apply.
    const malformed = {
      type: "sync",
      fromSeq: 0,
      toSeq: 0,
      removes: [],
    } as unknown as SessionSync;
    const replica = readerManager.open(space).replica as SpaceReplica;
    expect(() =>
      replica.accessForTestingOnly.applySessionSync(malformed, "integrate")
    ).toThrow();

    const read = readConfirmed(
      reader,
      space,
      (tx) => broken.withTx(tx).get()?.n,
    );
    expect(read).toEqual({ value: 2, confirmed: true });
  });

  it("returns a confirmed read with no sequence before any push has applied", async () => {
    await write("only", 1);
    const only = await loaded("only");

    const read = readConfirmed(reader, space, (tx) => only.withTx(tx).get()?.n);
    expect(read).toEqual({ value: 1, confirmed: true });
  });

  it("returns an unconfirmed read of a document with a pending local write", async () => {
    await write("pending", 1);
    const pending = await loaded("pending");

    const tx = reader.edit();
    pending.withTx(tx).set({ n: 2 });
    const committed = tx.commit();
    const read = readConfirmed(
      reader,
      space,
      (readTx) => pending.withTx(readTx).get()?.n,
    );
    expect((await committed.settled).error).toBeUndefined();

    expect(read).toEqual({ value: 2, confirmed: false });
  });

  it("returns the reader's own write as confirmed once a push covers its commit", async () => {
    await write("own", 1);
    const own = await loaded("own");

    const tx = reader.edit();
    own.withTx(tx).set({ n: 2 });
    expect((await tx.commit().settled).error).toBeUndefined();
    const seq = tx.committedSeq!(space)!;

    const read = readConfirmed(
      reader,
      space,
      (readTx) => own.withTx(readTx).get()?.n,
    );
    expect(read.value).toBe(2);
    expect(read.confirmed).toBe(true);
    expect(read.seq).toBeGreaterThanOrEqual(seq);
  });

  it("returns the reader's own deletion as confirmed once a push covers its commit", async () => {
    // The server does not echo a writer's own `delete` back to it, so only
    // the push that covers the commit makes the replica's deletion confirmed.

    await write("deleted", 1);
    const deleted = await loaded("deleted");

    const tx = reader.edit();
    tx.writeValueOrThrow(deleted.getAsNormalizedFullLink(), undefined);
    expect((await tx.commit().settled).error).toBeUndefined();
    const seq = tx.committedSeq!(space)!;

    const read = readConfirmed(
      reader,
      space,
      (readTx) => deleted.withTx(readTx).get(),
    );
    expect(read.value).toBeUndefined();
    expect(read.confirmed).toBe(true);
    expect(read.seq).toBeGreaterThanOrEqual(seq);
  });

  it("returns an unconfirmed read of a document it sampled without loading", async () => {
    await write("anchor", 1);
    const anchor = await loaded("anchor");
    const delivered = arrival(anchor, 2);
    await write("anchor", 2);
    await delivered;
    const unloaded = reader.getCell<Note>(space, "sampled", noteSchema);

    const read = readConfirmed(
      reader,
      space,
      (tx) => unloaded.withTx(tx).sample()?.n,
    );
    expect(read).toEqual({ value: undefined, confirmed: false });
  });

  it("throws for a write inside the read", async () => {
    await write("written", 1);
    const written = await loaded("written");

    expect(() =>
      readConfirmed(reader, space, (tx) => {
        written.withTx(tx).set({ n: 999 });
        return written.withTx(tx).get()?.n;
      })
    ).toThrow();
    expect(
      readConfirmed(reader, space, (tx) => written.withTx(tx).get()?.n).value,
    )
      .toBe(1);
  });

  it("closes the transaction it read through, whether the read returns or throws", async () => {
    await write("closed", 1);
    const closed = await loaded("closed");
    const kept: IExtendedStorageTransaction[] = [];

    readConfirmed(reader, space, (tx) => {
      kept.push(tx);
      return closed.withTx(tx).get()?.n;
    });
    expect(() =>
      readConfirmed(reader, space, (tx) => {
        kept.push(tx);
        throw new Error("read failed");
      })
    ).toThrow("read failed");

    expect(kept.map((tx) => tx.status().status)).not.toContain("ready");
  });

  it("returns no sequence while its server runs server execution", async () => {
    // Set before either session opens, so the server's hello says so.
    server.setServerExecutionObserver({});
    await write("served", 1);
    const served = await loaded("served");
    const delivered = arrival(served, 2);
    await write("served", 2);
    await delivered;

    const read = readConfirmed(
      reader,
      space,
      (tx) => served.withTx(tx).get()?.n,
    );
    expect(read).toEqual({ value: 2, confirmed: true });
  });

  it("returns an unconfirmed read of a document it has not loaded", () => {
    const unloaded = reader.getCell<Note>(space, "unloaded", noteSchema);

    const read = readConfirmed(
      reader,
      space,
      (tx) => unloaded.withTx(tx).get()?.n,
    );
    expect(read).toEqual({ value: undefined, confirmed: false });
  });

  it("returns a confirmed read of a document whose absence a push delivered", async () => {
    const absent = await loaded("never-written");

    const read = readConfirmed(
      reader,
      space,
      (tx) => absent.withTx(tx).get()?.n,
    );
    expect(read).toEqual({ value: undefined, confirmed: true });
  });

  it("returns an unconfirmed read of a document in another space, though this space holds a confirmed document of the same id", async () => {
    // A cause names the same id in every space, so this space's replica
    // holds a delivered document of that id too.
    const other = (await Identity.fromPassphrase("confirmed read other")).did();
    await write("elsewhere", 1);
    const tx = writer.edit();
    writer.getCell<Note>(other, "elsewhere", noteSchema, tx).set({ n: 2 });
    expect((await tx.commit().settled).error).toBeUndefined();
    const here = await loaded("elsewhere");
    const there = reader.getCell<Note>(other, "elsewhere", noteSchema);
    await there.sync();
    expect(there.getAsNormalizedFullLink().id).toBe(
      here.getAsNormalizedFullLink().id,
    );

    const read = (from: typeof space) =>
      readConfirmed(reader, from, (readTx) => there.withTx(readTx).get()?.n);
    expect(read(space)).toEqual({ value: 2, confirmed: false });
    expect(read(other)).toEqual({ value: 2, confirmed: true });
  });

  it("returns an unconfirmed read of a document a local wave promotion holds, though a push covers the wave's sequence", async () => {
    const before = await write("waved", 1);
    const waved = await loaded("waved");
    // Pushes past the wave's sequence, so only the promotion keeps the
    // document from reading as confirmed.
    const advance = await loaded("advance");
    const advanced = arrival(advance, 2);
    await write("advance", 1);
    await write("advance", 2);
    await advanced;

    const replica = reader.storageManager.open(space).replica;
    const sealed = replica.sealNative!(
      {
        operations: [{
          op: "set",
          id: waved.getAsNormalizedFullLink().id,
          type: "application/json",
          value: { value: { n: 9 } },
        }],
      },
      undefined,
      Promise.resolve({ committed: { seq: before + 1 } }),
    );
    expect(await sealed.settled).toEqual({ ok: {} });

    const read = readConfirmed(
      reader,
      space,
      (tx) => waved.withTx(tx).get()?.n,
    );
    expect(read).toEqual({ value: 9, confirmed: false });
  });

  describe("readDurable()", () => {
    /**
     * Seals a speculative layer over the reader's `note`, showing `value` in
     * place of what the note holds, and returns what settles it.
     */
    function speculate(note: Cell<Note>, value: Note): {
      settle: (verdict: SealedCommitVerdict) => Promise<void>;
    } {
      const { id, scope } = note.getAsNormalizedFullLink();
      const replica = readerManager.open(space).replica;
      const verdict = Promise.withResolvers<SealedCommitVerdict>();
      const sealed = replica.sealNative!(
        {
          operations: [{
            op: "set",
            id,
            type: "application/json",
            value: { ...replica.getDocument(id, scope), value },
          }],
        },
        undefined,
        verdict.promise,
        { speculative: true },
      );
      return {
        settle: async (outcome) => {
          verdict.resolve(outcome);
          await sealed.settled;
        },
      };
    }

    const retirement: SealedCommitVerdict = {
      withdrawn: { message: "retired", superseded: true },
    };

    it("returns the value stored beneath a speculation layer", async () => {
      await write("masked", 1);
      const masked = await loaded("masked");
      speculate(masked, { n: 5 });

      expect(masked.get()?.n).toBe(5);
      expect(readDurable(reader, (tx) => masked.withTx(tx).get()?.n).value)
        .toBe(1);
    });

    it("returns a write that arrived beneath a speculation layer", async () => {
      await write("beneath", 1);
      await write("beside", 1);
      const beneath = await loaded("beneath");
      const beside = await loaded("beside");
      speculate(beneath, { n: 5 });

      // `beside` changes in the same commit, and no layer masks it.
      const delivered = arrival(beside, 2);
      const tx = writer.edit();
      writer.getCell<Note>(space, "beneath", noteSchema, tx).set({ n: 2 });
      writer.getCell<Note>(space, "beside", noteSchema, tx).set({ n: 2 });
      expect((await tx.commit().settled).error).toBeUndefined();
      await delivered;

      expect(beneath.get()?.n).toBe(5);
      expect(readDurable(reader, (tx) => beneath.withTx(tx).get()?.n).value)
        .toBe(2);
    });

    it("returns the stored value from a notification the layer's own seal delivers", async () => {
      await write("notified", 1);
      const notified = await loaded("notified");
      const seen: (number | undefined)[] = [];
      let sealing = false;
      const replica = readerManager.open(space).replica as SpaceReplica;
      const cancel = replica.sinkDocument(
        notified.getAsNormalizedFullLink().id,
        () => {
          if (!sealing) return;
          seen.push(
            readDurable(reader, (tx) => notified.withTx(tx).get()?.n).value,
          );
        },
      );
      sealing = true;
      speculate(notified, { n: 5 });
      sealing = false;
      cancel();

      expect(seen).toEqual([1]);
    });

    it("returns `speculationSettled` resolving once the layer over what it read retires, and not before", async () => {
      await write("retiring", 1);
      const retiring = await loaded("retiring");
      const layer = speculate(retiring, { n: 5 });

      const read = readDurable(
        reader,
        (tx) => retiring.withTx(tx).get()?.n,
      );
      let settled = false;
      read.speculationSettled?.then(() => settled = true);
      await reader.idle();

      expect(read.speculationSettled).toBeDefined();
      expect(settled).toBe(false);
      await layer.settle(retirement);
      await read.speculationSettled;
      expect(retiring.get()?.n).toBe(1);
    });

    it("returns `speculationSettled` resolving once the layer over what it read is withdrawn", async () => {
      await write("withdrawn", 1);
      const withdrawn = await loaded("withdrawn");
      const layer = speculate(withdrawn, { n: 5 });

      const read = readDurable(
        reader,
        (tx) => withdrawn.withTx(tx).get()?.n,
      );
      await layer.settle({ withdrawn: { message: "dropped" } });

      expect(read.speculationSettled).toBeDefined();
      await read.speculationSettled;

      expect(withdrawn.get()?.n).toBe(1);
    });

    it("returns no `speculationSettled` when no layer stands over what it read", async () => {
      await write("plain", 1);
      await write("covered", 1);
      const plain = await loaded("plain");
      const covered = await loaded("covered");
      speculate(covered, { n: 5 });

      const read = readDurable(reader, (tx) => plain.withTx(tx).get()?.n);
      expect(read).toEqual({ value: 1 });
    });
  });
});
