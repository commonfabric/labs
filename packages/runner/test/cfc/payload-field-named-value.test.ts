import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import type { JSONSchema } from "../../src/builder/types.ts";
import type { Cell } from "../../src/cell.ts";
import { cfcLabelViewForCell } from "../../src/cfc/label-view.ts";
import { readStoredCfcMetadata } from "../../src/cfc/metadata.ts";
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";

const signer = await Identity.fromPassphrase("payload field named value");
const space = signer.did();
const ATOM = "payload-field-probe-atom";
const A = { type: "https://commonfabric.org/cfc/atom/User", subject: "A" };
const B = { type: "https://commonfabric.org/cfc/atom/User", subject: "B" };

/** The string integrity atoms a cell's label view carries, deduplicated. */
const integrityAtoms = (cell: Cell<unknown>): string[] => [
  ...new Set(
    (cfcLabelViewForCell(cell)?.entries ?? []).flatMap((entry) =>
      (entry.label.integrity ?? []).filter((atom) => typeof atom === "string")
    ) as string[],
  ),
];

describe("payload-field-named-value", () => {
  // A document keeps its payload under `value`, so a transaction address for
  // payload field `x` is `["value", "x"]`. A payload field that is itself
  // named `value` must not be mistaken for that wrapper. Every case runs for
  // a field named `value` and for one named `val`, which must behave alike.

  let storage: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  const readers: Runtime[] = [];

  beforeEach(() => {
    storage = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager: storage,
      trustSnapshotProvider: () => ({
        id: signer.did(),
        actingPrincipal: signer.did(),
      }),
    });
  });

  afterEach(async () => {
    for (const reader of readers.splice(0)) await reader.dispose();
    await runtime.dispose();
    await storage.close();
  });

  /** Commits `value` under `schema` and returns the cell, read back synced. */
  const seed = async (name: string, schema: JSONSchema, value: unknown) => {
    const tx = runtime.edit();
    runtime.getCell(space, name, schema, tx).set(value as never);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit()).error).toBeUndefined();
    const cell = runtime.getCell(space, name, schema);
    await cell.sync();
    return cell;
  };

  for (const field of ["value", "val"]) {
    describe(`a field named \`${field}\``, () => {
      it("reads none of a labeled sibling's integrity", async () => {
        const cell = await seed(`unlabeled-${field}`, {
          type: "object",
          properties: {
            [field]: { type: "string" },
            other: { type: "string", ifc: { addIntegrity: [ATOM] } },
          },
        }, { [field]: "a", other: "b" });

        expect(integrityAtoms(cell.key(field as never) as Cell<unknown>))
          .toEqual([]);
        expect(integrityAtoms(cell.key("other" as never) as Cell<unknown>))
          .toEqual([ATOM]);
      });

      it("keeps a label declared on it off its sibling", async () => {
        const cell = await seed(`labeled-${field}`, {
          type: "object",
          properties: {
            [field]: { type: "string", ifc: { addIntegrity: [ATOM] } },
            other: { type: "string" },
          },
        }, { [field]: "a", other: "b" });

        expect(integrityAtoms(cell.key(field as never) as Cell<unknown>))
          .toEqual([ATOM]);
        expect(integrityAtoms(cell.key("other" as never) as Cell<unknown>))
          .toEqual([]);
      });

      it("commits a write to it alone on a document whose schema carries a label", async () => {
        const schema = {
          type: "object",
          properties: {
            [field]: { type: "string" },
            other: { type: "string" },
          },
          ifc: { addIntegrity: [ATOM] },
        } as JSONSchema;
        await seed(`field-write-${field}`, schema, {
          [field]: "a",
          other: "b",
        });

        const tx = runtime.edit();
        (runtime.getCell(space, `field-write-${field}`, schema, tx)
          .key(field as never) as Cell<string>).set("changed");
        runtime.prepareTxForCommit(tx);

        expect((await tx.commit()).error).toBeUndefined();
        const after = runtime.getCell(space, `field-write-${field}`, schema);
        await after.sync();
        expect(after.get()).toEqual({ [field]: "changed", other: "b" });
      });

      it("refuses a raw write below it that carries no schema write-policy input", async () => {
        const cell = await seed(`raw-write-${field}`, {
          type: "object",
          properties: {
            [field]: {
              type: "object",
              properties: {
                x: { type: "string", ifc: { confidentiality: ["guarded"] } },
              },
            },
          },
        }, { [field]: { x: "old" } });

        const tx = runtime.edit();
        tx.writeValueOrThrow({
          ...cell.getAsNormalizedFullLink(),
          path: [field, "x"],
        }, "new");
        tx.prepareCfc();

        expect((await tx.commit()).error?.message).toContain(
          "missing schema write-policy input",
        );
      });

      describe("as the source of an `exactCopyOf` claim", () => {
        const copySchema = {
          type: "object",
          properties: {
            [field]: {
              type: "object",
              properties: {
                x: { type: "string", ifc: { confidentiality: ["secret"] } },
              },
            },
            x: { type: "string" },
            copy: { type: "string", ifc: { exactCopyOf: [field, "x"] } },
          },
        } as JSONSchema;

        it("accepts a copy of its member when a top-level field of the member's name differs", async () => {
          const tx = runtime.edit();
          const cell = runtime.getCell(
            space,
            `copy-${field}`,
            copySchema,
            tx,
          );
          cell.set({ [field]: { x: "S" }, x: "T", copy: "S" } as never);
          tx.prepareCfc();

          expect((await tx.commit()).error).toBeUndefined();
          const inspect = runtime.edit();
          const stored = readStoredCfcMetadata(
            inspect,
            cell.getAsNormalizedFullLink(),
          );
          inspect.abort();
          expect(stored?.labelMap.entries).toContainEqual(
            expect.objectContaining({
              path: ["copy"],
              label: { confidentiality: ["secret"] },
            }),
          );
        });

        it("refuses a copy that holds a different value from its member", async () => {
          const tx = runtime.edit();
          runtime.getCell(space, `mismatch-${field}`, copySchema, tx).set(
            { [field]: { x: "S" }, x: "T", copy: "T" } as never,
          );
          tx.prepareCfc();

          expect((await tx.commit()).error?.message).toContain(
            "exactCopyOf failed at /copy",
          );
        });
      });

      it("withholds a read of it under a ceiling its labeled member exceeds", async () => {
        const cell = await seed(`ceiling-${field}`, {
          type: "object",
          properties: {
            [field]: {
              type: "object",
              properties: {
                x: { type: "string", ifc: { confidentiality: [B] } },
              },
            },
            public: { type: "string" },
          },
        }, { [field]: { x: "private content" }, public: "public content" });
        const reader = new Runtime({
          apiUrl: new URL("http://toolshed.test"),
          storageManager: storage,
          cfcReadMaxConfidentiality: [A],
        });
        readers.push(reader);
        const projected = reader.getCellFromLink(
          cell.getAsNormalizedFullLink(),
        );
        await projected.sync();

        expect(projected.key("public" as never).get()).toBe("public content");
        expect(() => projected.key(field as never).get()).toThrow(
          /read ceiling/,
        );
      });
    });
  }
});
