import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import type { JSONSchema } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { isCfcLabelReference } from "../src/cfc/label-documents.ts";
import type { StoredCfcMetadata } from "../src/cfc/types.ts";

const signer = await Identity.fromPassphrase("runner-cfc-write-destination");
const space = signer.did();

const SECRET_ATOM = "https://commonfabric.org/cfc/atom/Public/room-secret";
const NOTE_ATOM = "https://commonfabric.org/cfc/atom/Public/room-note";
const SOURCE_ATOM = "https://commonfabric.org/cfc/atom/Public/room-source";

/** Two siblings whose declared confidentiality differs. */
const MIXED_SCHEMA = {
  type: "object",
  properties: {
    secret: { type: "string", ifc: { confidentiality: [SECRET_ATOM] } },
    note: { type: "string", ifc: { confidentiality: [NOTE_ATOM] } },
  },
  required: ["secret", "note"],
} as const satisfies JSONSchema;

/** Two siblings under one label, which every path's ceiling admits. */
const SHARED_SCHEMA = {
  type: "object",
  properties: {
    secret: { type: "string", ifc: { confidentiality: [SECRET_ATOM] } },
    note: { type: "string", ifc: { confidentiality: [SECRET_ATOM] } },
  },
  required: ["secret", "note"],
} as const satisfies JSONSchema;

/** One label at the document root, resolving down to both siblings. */
const ROOT_SCHEMA = {
  type: "object",
  ifc: { confidentiality: [SECRET_ATOM] },
  properties: {
    secret: { type: "string" },
    note: { type: "string" },
  },
  required: ["secret", "note"],
} as const satisfies JSONSchema;

/** One labeled sibling beside an unlabeled one. */
const ONE_LABELED_SCHEMA = {
  type: "object",
  properties: {
    secret: { type: "string", ifc: { confidentiality: [SECRET_ATOM] } },
    note: { type: "string" },
  },
  required: ["secret", "note"],
} as const satisfies JSONSchema;

/**
 * One labeled slot, whose stored value can steer a write elsewhere. The slot
 * declares no type, so the same handle both stores a link into it and writes
 * a string over that link.
 */
const SLOT_SCHEMA = {
  type: "object",
  properties: {
    slot: { ifc: { confidentiality: [SECRET_ATOM] } },
  },
  required: ["slot"],
} as const satisfies JSONSchema;

/** One label at the document root, chosen by the caller. */
const rootSchemaOf = (atom: string) =>
  ({
    type: "object",
    ifc: { confidentiality: [atom] },
    properties: { text: { type: "string" } },
    required: ["text"],
  }) as const satisfies JSONSchema;

/**
 * A labeled object a same-document link can name. A link stored at
 * `box/self` points at `box`, which the walk collapses by reading `box` and
 * writing that value in the link's place.
 */
const BOX_SCHEMA = {
  type: "object",
  properties: {
    box: {
      type: "object",
      properties: { s: { type: "string" } },
      ifc: { confidentiality: [SECRET_ATOM] },
    },
  },
  required: ["box"],
} as const satisfies JSONSchema;

/** A labeled document to read, so that a write can be genuinely tainted. */
const SOURCE_SCHEMA = {
  type: "object",
  properties: {
    v: { type: "string", ifc: { confidentiality: [SOURCE_ATOM] } },
  },
  required: ["v"],
} as const satisfies JSONSchema;

type Doc = { secret: string; note: string };

/** The clauses the stored `value`-class derived entry at `path` carries. */
const derivedValueClauses = (
  runtime: Runtime,
  id: string,
  path: string,
): readonly unknown[] => {
  const replica = runtime.storageManager.open(space).replica as unknown as {
    getDocument(id: string): { cfc?: StoredCfcMetadata } | undefined;
  };
  const entry = replica.getDocument(id)?.cfc?.labelMap.entries.find((e) =>
    e.origin === "derived" && e.observes === "value" &&
    e.path.join("/") === path
  );
  // This runtime stores its labels inline, so a reference here would mean
  // the reading, not the label, went wrong.
  if (entry === undefined || isCfcLabelReference(entry.label)) return [];
  return entry.label.confidentiality ?? [];
};

/**
 * Runs `body` against a runtime with both dials the refusal needs at their
 * strictest rungs: `enforce-strict` is where a writer-fit misfit rejects
 * rather than diagnoses, and `persist` is what gives the transaction derived
 * labels to join.
 */
const withStrictRuntime = async (
  body: (runtime: Runtime) => Promise<void>,
): Promise<void> => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
    cfcEnforcementMode: "enforce-strict",
    cfcFlowLabels: "persist",
  });
  try {
    await body(runtime);
  } finally {
    await runtime.dispose();
  }
};

/** The commit's refusal reason, or `undefined` when it committed. */
const refusalOf = (
  result: { ok?: unknown; error?: unknown },
): string | undefined =>
  result.ok !== undefined
    ? undefined
    : (result.error as Error | undefined)?.message ?? String(result.error);

/** One whole-object `set()` of `value` into `name`, committed. */
const wholeObjectWrite = async (
  runtime: Runtime,
  schema: JSONSchema,
  name: string,
  value: Doc,
): Promise<string | undefined> => {
  const tx = runtime.edit();
  runtime.getCell(space, name, schema, tx).set(value);
  tx.prepareCfc();
  const refusal = refusalOf(await tx.commit());
  await runtime.storageManager.synced();
  return refusal;
};

describe("CFC write-destination reads", () => {
  // The write path reads the document it is about to write, to decide which
  // sub-paths differ. Those reads leave the transaction's flow join, so a
  // whole-object `set()` no longer carries one field's label onto the write
  // of a sibling that declares another. A read the calling program made is
  // not one of them and still joins.

  describe("a whole-object set under differing sibling labels", () => {
    it("commits a second write that changes one field", async () => {
      await withStrictRuntime(async (runtime) => {
        expect(
          await wholeObjectWrite(runtime, MIXED_SCHEMA, "changes-secret", {
            secret: "classified",
            note: "n",
          }),
        ).toBeUndefined();
        expect(
          await wholeObjectWrite(runtime, MIXED_SCHEMA, "changes-secret", {
            secret: "updated",
            note: "n",
          }),
        ).toBeUndefined();
      });
    });

    it("commits a second write that changes the other field", async () => {
      await withStrictRuntime(async (runtime) => {
        expect(
          await wholeObjectWrite(runtime, MIXED_SCHEMA, "changes-note", {
            secret: "classified",
            note: "n",
          }),
        ).toBeUndefined();
        expect(
          await wholeObjectWrite(runtime, MIXED_SCHEMA, "changes-note", {
            secret: "classified",
            note: "updated",
          }),
        ).toBeUndefined();
      });
    });

    it("commits a third write, and a fourth", async () => {
      await withStrictRuntime(async (runtime) => {
        for (const secret of ["one", "two", "three", "four"]) {
          expect(
            await wholeObjectWrite(runtime, MIXED_SCHEMA, "repeated", {
              secret,
              note: "n",
            }),
          ).toBeUndefined();
        }
      });
    });

    it("commits a second write that changes neither field", async () => {
      await withStrictRuntime(async (runtime) => {
        const value = { secret: "classified", note: "n" };
        expect(
          await wholeObjectWrite(runtime, MIXED_SCHEMA, "unchanged", value),
        ).toBeUndefined();
        expect(
          await wholeObjectWrite(runtime, MIXED_SCHEMA, "unchanged", value),
        ).toBeUndefined();
      });
    });
  });

  describe("two documents in one transaction", () => {
    // The shape a SQL query result takes when it rewrites its row
    // documents: one transaction writing several documents, each carrying a
    // label of its own, and no label inside any other's ceiling.

    it("commits a second write to documents whose labels differ", async () => {
      await withStrictRuntime(async (runtime) => {
        const write = async (text: string) => {
          const tx = runtime.edit();
          runtime.getCell(space, "row-secret", rootSchemaOf(SECRET_ATOM), tx)
            .set({ text });
          runtime.getCell(space, "row-note", rootSchemaOf(NOTE_ATOM), tx)
            .set({ text });
          tx.prepareCfc();
          const refusal = refusalOf(await tx.commit());
          await runtime.storageManager.synced();
          return refusal;
        };

        expect(await write("one")).toBeUndefined();
        expect(await write("two")).toBeUndefined();
      });
    });
  });

  describe("the shapes that committed before", () => {
    // Each of these puts one label over every path the write measures, so the
    // transaction's join fit each path's ceiling even with the destination
    // reads in it. They stay committing.

    it("commits a whole-object set under one shared sibling label", async () => {
      await withStrictRuntime(async (runtime) => {
        expect(
          await wholeObjectWrite(runtime, SHARED_SCHEMA, "shared", {
            secret: "classified",
            note: "n",
          }),
        ).toBeUndefined();
        expect(
          await wholeObjectWrite(runtime, SHARED_SCHEMA, "shared", {
            secret: "updated",
            note: "n",
          }),
        ).toBeUndefined();
      });
    });

    it("commits a whole-object set under one root label", async () => {
      await withStrictRuntime(async (runtime) => {
        expect(
          await wholeObjectWrite(runtime, ROOT_SCHEMA, "rooted", {
            secret: "classified",
            note: "n",
          }),
        ).toBeUndefined();
        expect(
          await wholeObjectWrite(runtime, ROOT_SCHEMA, "rooted", {
            secret: "updated",
            note: "n",
          }),
        ).toBeUndefined();
      });
    });

    it("commits a whole-object set beside an unlabeled sibling", async () => {
      await withStrictRuntime(async (runtime) => {
        expect(
          await wholeObjectWrite(runtime, ONE_LABELED_SCHEMA, "one-label", {
            secret: "classified",
            note: "n",
          }),
        ).toBeUndefined();
        expect(
          await wholeObjectWrite(runtime, ONE_LABELED_SCHEMA, "one-label", {
            secret: "updated",
            note: "n",
          }),
        ).toBeUndefined();
      });
    });

    it("commits a write spelled through the field's own cell", async () => {
      await withStrictRuntime(async (runtime) => {
        expect(
          await wholeObjectWrite(runtime, MIXED_SCHEMA, "per-key", {
            secret: "classified",
            note: "n",
          }),
        ).toBeUndefined();
        const tx = runtime.edit();
        runtime.getCell(space, "per-key", MIXED_SCHEMA, tx)
          .key("secret").set("updated");
        tx.prepareCfc();
        expect(refusalOf(await tx.commit())).toBeUndefined();
      });
    });
  });

  describe("a read the calling program made", () => {
    it("refuses a write to the sibling whose ceiling excludes what was read", async () => {
      await withStrictRuntime(async (runtime) => {
        expect(
          await wholeObjectWrite(runtime, MIXED_SCHEMA, "explicit-read", {
            secret: "classified",
            note: "n",
          }),
        ).toBeUndefined();

        const tx = runtime.edit();
        const cell = runtime.getCell(space, "explicit-read", MIXED_SCHEMA, tx);
        cell.key("note").get();
        cell.key("secret").set("updated");
        tx.prepareCfc();
        const refusal = refusalOf(await tx.commit());
        expect(refusal).toContain("writer-fit confidentiality misfit");
        expect(refusal).toContain("/secret");
        expect(refusal).toContain(NOTE_ATOM);
      });
    });

    it("refuses a read-modify-write that spreads the document it read", async () => {
      await withStrictRuntime(async (runtime) => {
        expect(
          await wholeObjectWrite(runtime, MIXED_SCHEMA, "spread", {
            secret: "classified",
            note: "n",
          }),
        ).toBeUndefined();

        const tx = runtime.edit();
        const cell = runtime.getCell(space, "spread", MIXED_SCHEMA, tx);
        cell.set({ ...cell.get(), secret: "updated" });
        tx.prepareCfc();
        expect(refusalOf(await tx.commit())).toContain(
          "writer-fit confidentiality misfit",
        );
      });
    });

    it("refuses a whole-object set whose transaction read the sibling too", async () => {
      await withStrictRuntime(async (runtime) => {
        expect(
          await wholeObjectWrite(runtime, MIXED_SCHEMA, "read-then-set", {
            secret: "classified",
            note: "n",
          }),
        ).toBeUndefined();

        const tx = runtime.edit();
        const cell = runtime.getCell(space, "read-then-set", MIXED_SCHEMA, tx);
        cell.key("note").get();
        cell.set({ secret: "updated", note: "n" });
        tx.prepareCfc();
        expect(refusalOf(await tx.commit())).toContain(
          "writer-fit confidentiality misfit",
        );
      });
    });
  });

  describe("the derived component a write leaves behind", () => {
    // The dial pair here is the one a deployment ships with rather than the
    // strictest: at `enforce-explicit` a writer-fit misfit is a diagnostic
    // rather than a rejection, so the write lands and what it stamped is
    // what there is to read.

    it("drops the clause a tainted write left once an untainted write replaces the value", async () => {
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
        cfcEnforcementMode: "enforce-explicit",
        cfcFlowLabels: "persist",
      });
      try {
        const seed = runtime.edit();
        runtime.getCell(space, "source", SOURCE_SCHEMA, seed).set({ v: "x" });
        const dest = runtime.getCell(space, "tainted", MIXED_SCHEMA, seed);
        dest.set({ secret: "one", note: "n" });
        expect(refusalOf(await seed.commit())).toBeUndefined();
        await runtime.storageManager.synced();
        const id = dest.getAsNormalizedFullLink().id;

        // A read the program made, so the write it feeds is tainted by it.
        const tainted = runtime.edit();
        runtime.getCell(space, "source", SOURCE_SCHEMA, tainted).key("v").get();
        runtime.getCell(space, "tainted", MIXED_SCHEMA, tainted)
          .set({ secret: "two", note: "n" });
        tainted.prepareCfc();
        expect(refusalOf(await tainted.commit())).toBeUndefined();
        await runtime.storageManager.synced();
        expect(derivedValueClauses(runtime, id, "secret")).toContain(
          SOURCE_ATOM,
        );

        // The same write spelled without the read. What the walk observes of
        // the destination is its own, so nothing re-derives the clause.
        const clean = runtime.edit();
        runtime.getCell(space, "tainted", MIXED_SCHEMA, clean)
          .set({ secret: "three", note: "n" });
        clean.prepareCfc();
        expect(refusalOf(await clean.commit())).toBeUndefined();
        await runtime.storageManager.synced();
        expect(derivedValueClauses(runtime, id, "secret")).not.toContain(
          SOURCE_ATOM,
        );
      } finally {
        await runtime.dispose();
      }
    });
  });

  describe("a document whose label sits at its root", () => {
    // A root label resolves at every path beneath it, the marker's path
    // included, so narrowing the stream probe does not keep it out of the
    // join. What keeps it out is that on the write path the probe is the
    // write machinery asking which of two ways to write.

    it("commits an unlabeled write in the transaction that rewrites the labeled document", async () => {
      await withStrictRuntime(async (runtime) => {
        expect(
          await wholeObjectWrite(runtime, ROOT_SCHEMA, "rooted-pair", {
            secret: "classified",
            note: "n",
          }),
        ).toBeUndefined();

        const tx = runtime.edit();
        runtime.getCell(space, "rooted-pair", ROOT_SCHEMA, tx)
          .set({ secret: "updated", note: "n" });
        runtime.getCell<{ n: number }>(space, "rooted-pair-sink", undefined, tx)
          .set({ n: 1 });
        tx.prepareCfc();
        expect(refusalOf(await tx.commit())).toBeUndefined();
      });
    });

    it("refuses an unlabeled write in a transaction that read the labeled document", async () => {
      await withStrictRuntime(async (runtime) => {
        expect(
          await wholeObjectWrite(runtime, ROOT_SCHEMA, "rooted-read", {
            secret: "classified",
            note: "n",
          }),
        ).toBeUndefined();

        const tx = runtime.edit();
        runtime.getCell(space, "rooted-read", ROOT_SCHEMA, tx).get();
        runtime.getCell<{ n: number }>(space, "rooted-read-sink", undefined, tx)
          .set({ n: 1 });
        tx.prepareCfc();
        expect(refusalOf(await tx.commit())).toContain(
          "writer-fit confidentiality misfit",
        );
      });
    });
  });

  describe("a stored link that steers the write", () => {
    // Two branches of the walk let what is stored at a slot decide where the
    // write lands rather than only whether it happens. Each reads the slot
    // again outside the exclusion, so the slot's own label gates the write
    // the redirect carries the walk to.

    it("refuses a write the slot's write-redirect carries into an undeclared document", async () => {
      await withStrictRuntime(async (runtime) => {
        const setup = runtime.edit();
        const target = runtime.getCell<{ landed: string }>(
          space,
          "redirect-target",
          undefined,
          setup,
        );
        target.set({ landed: "before" });
        const holder = runtime.getCell(
          space,
          "redirect-holder",
          SLOT_SCHEMA,
          setup,
        );
        holder.key("slot").setRaw(
          target.key("landed").getAsWriteRedirectLink(),
        );
        expect(refusalOf(await setup.commit())).toBeUndefined();
        await runtime.storageManager.synced();

        const tx = runtime.edit();
        runtime.getCell(space, "redirect-holder", SLOT_SCHEMA, tx)
          .set({ slot: "after" });
        tx.prepareCfc();
        const refusal = refusalOf(await tx.commit());
        expect(refusal).toContain("writer-fit confidentiality misfit");
        expect(refusal).toContain(SECRET_ATOM);
        expect(target.get()).toEqual({ landed: "before" });
      });
    });

    it("refuses a write the slot's narrower-scope link carries into an undeclared instance", async () => {
      await withStrictRuntime(async (runtime) => {
        const setup = runtime.edit();
        const instance = runtime.getCell<string>(
          space,
          "scoped-target",
          undefined,
          setup,
          "user",
        );
        instance.set("before");
        const holder = runtime.getCell(
          space,
          "scoped-holder",
          SLOT_SCHEMA,
          setup,
        );
        holder.key("slot").setRaw(instance.getAsLink());
        expect(refusalOf(await setup.commit())).toBeUndefined();
        await runtime.storageManager.synced();

        const tx = runtime.edit();
        runtime.getCell(space, "scoped-holder", SLOT_SCHEMA, tx)
          .set({ slot: "after" });
        tx.prepareCfc();
        const refusal = refusalOf(await tx.commit());
        expect(refusal).toContain("writer-fit confidentiality misfit");
        expect(refusal).toContain(SECRET_ATOM);
        expect(instance.get()).toBe("before");
      });
    });
  });

  describe("a read whose result is written", () => {
    // The walk reads for two reasons the exclusion must not reach, because
    // what those reads return becomes part of a written value. A link naming
    // its own immediate parent is collapsed by reading that parent and
    // storing the value in the link's place. And the parent of an array
    // element is read to settle the identity the element is anchored under,
    // which is written as the link the slot comes to hold. Marking either
    // would label a written value more weakly than its content.

    it("refuses an unlabeled write beside one embedding a link target's value", async () => {
      await withStrictRuntime(async (runtime) => {
        const seed = runtime.edit();
        runtime.getCell(space, "boxed", BOX_SCHEMA, seed).set({
          box: { s: "x" },
        });
        seed.prepareCfc();
        expect(refusalOf(await seed.commit())).toBeUndefined();
        await runtime.storageManager.synced();

        const tx = runtime.edit();
        const box = runtime.getCell(space, "boxed", BOX_SCHEMA, tx).key("box");
        box.key("self").set(box.getAsLink());
        runtime.getCell<{ copied?: string }>(space, "beside", undefined, tx)
          .set({ copied: "plain" });
        tx.prepareCfc();

        const refusal = refusalOf(await tx.commit());
        expect(refusal).toContain("writer-fit confidentiality misfit");
        expect(refusal).toContain(SECRET_ATOM);
      });
    });

    it("refuses an element anchored out of a labeled array", async () => {
      await withStrictRuntime(async (runtime) => {
        // Each element becomes an entity document of its own, under an
        // identity derived from how far the enclosing arrays reach. Reading
        // the parent to settle that is what the anchored document's own
        // ceiling, which declares nothing, then has to admit.
        //
        // What this pins is that the parent read's label reaches the
        // anchored document: mark that read and the write commits. Whether
        // a labeled array should be rewritable whole at this rung is a
        // question about the write ceiling an anchored document resolves,
        // which this case neither settles nor blesses.
        const listSchema = {
          type: "object",
          properties: {
            items: {
              type: "array",
              items: {
                type: "object",
                properties: { note: { type: "string" } },
              },
              ifc: { confidentiality: [SECRET_ATOM] },
            },
          },
          required: ["items"],
        } as const satisfies JSONSchema;

        const seed = runtime.edit();
        runtime.getCell(space, "anchored", listSchema, seed).set({
          items: [{ note: "a" }],
        });
        seed.prepareCfc();
        expect(refusalOf(await seed.commit())).toBeUndefined();
        await runtime.storageManager.synced();

        const tx = runtime.edit();
        runtime.getCell(space, "anchored", listSchema, tx).set({
          items: [{ note: "b" }],
        });
        tx.prepareCfc();

        const refusal = refusalOf(await tx.commit());
        expect(refusal).toContain("writer-fit confidentiality misfit");
        expect(refusal).toContain(SECRET_ATOM);
      });
    });
  });

  describe("the stream marker", () => {
    // The marker is a scalar at one known key, and the probe reads that
    // key's own path. A probe made off the write path carries no exclusion,
    // so what it consumes is what it reads: asking the narrow question keeps
    // the labels of the fields beside the marker out of the reading
    // transaction's join.

    it("commits a write beside a subscription to a labeled document", async () => {
      await withStrictRuntime(async (runtime) => {
        expect(
          await wholeObjectWrite(runtime, MIXED_SCHEMA, "watched", {
            secret: "classified",
            note: "n",
          }),
        ).toBeUndefined();

        const tx = runtime.edit();
        // `sink()` probes for the marker, and this cell has none. The probe
        // is not a write, so it joins whatever it consumed.
        const cancel = runtime.getCell(space, "watched", MIXED_SCHEMA, tx)
          .sink(() => {});
        runtime.getCell<{ copied?: string }>(space, "elsewhere", undefined, tx)
          .set({ copied: "plain" });
        tx.prepareCfc();
        const refusal = refusalOf(await tx.commit());
        cancel();

        expect(refusal).toBeUndefined();
      });
    });

    // `set()` asks whether the cell holds a stream by reading the marker's own
    // path. A value carrying the marker still reaches the stream arm, where
    // the write is delivered to listeners instead of stored.

    it("delivers a send to the listeners of a cell holding the marker", async () => {
      await withStrictRuntime(async (runtime) => {
        const tx = runtime.edit();
        const stream = runtime.getCell(space, "stream-marker", undefined, tx);
        stream.setRaw({ $stream: true });

        const seen: unknown[] = [];
        const cancel = stream.sink((event) => {
          seen.push(event);
        });
        stream.send({ tag: "hello" });
        cancel();

        expect(seen).toEqual([{ tag: "hello" }]);
        // The marker is what the cell still holds: the send was delivered, not
        // stored over the top of it.
        expect(stream.getRaw()).toEqual({ $stream: true });
        expect(refusalOf(await tx.commit())).toBeUndefined();
      });
    });

    it("stores a set into a cell whose value has no marker", async () => {
      await withStrictRuntime(async (runtime) => {
        const tx = runtime.edit();
        const cell = runtime.getCell<{ tag: string }>(
          space,
          "plain-value",
          undefined,
          tx,
        );
        cell.set({ tag: "hello" });
        expect(refusalOf(await tx.commit())).toBeUndefined();
        expect(cell.get()).toEqual({ tag: "hello" });
      });
    });
  });
});
