/**
 * The three states `Cell.push()`, `Cell.pushAll()` and `Cell.addUnique()` can
 * find the stored value in: absent, an array, or something else. Each method
 * decides between them before it has an array to work with, so all three are
 * covered here for each.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { Runtime } from "../src/runtime.ts";
import type { Cell } from "../src/cell.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("array write guards");
const space = signer.did();

describe("array write guards", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit().settled;
    await runtime?.dispose();
    await storageManager?.close();
  });

  // Typed as `Cell<string[]>` rather than cast to a structural `{ push(...) }`,
  // so these calls are checked against the real signatures and would stop
  // compiling if either method changed shape or left `Cell`.
  for (
    const { name, write } of [
      {
        name: "push()",
        write: (cell: Cell<string[]>, v: string) => cell.push(v),
      },
      {
        name: "pushAll()",
        write: (cell: Cell<string[]>, v: string) => cell.pushAll([v]),
      },
      {
        name: "addUnique()",
        write: (cell: Cell<string[]>, v: string) => cell.addUnique(v),
      },
    ]
  ) {
    describe(name, () => {
      it("creates the array when there is no value yet", () => {
        const cell = runtime.getCell<string[]>(
          space,
          `absent-${name}`,
          undefined,
          tx,
        );

        write(cell, "one");

        expect(cell.get()).toEqual(["one"]);
      });

      it("seeds from the schema default when there is no value yet", () => {
        // The other absent-value case takes the `: []` arm. This one reaches
        // `processDefaultValue()`, whose `any` return is what the created
        // array's annotation exists to constrain.
        const cell = runtime.getCell<string[]>(
          space,
          `defaulted-${name}`,
          {
            type: "array",
            items: { type: "string" },
            default: ["seed"],
          } as const,
          tx,
        );

        write(cell, "one");

        expect(cell.get()).toEqual(["seed", "one"]);
      });

      it("appends to an existing array", () => {
        const cell = runtime.getCell<string[]>(
          space,
          `existing-${name}`,
          undefined,
          tx,
        );
        cell.set(["one"]);

        write(cell, "two");

        expect(cell.get()).toEqual(["one", "two"]);
      });

      it("throws when the stored value is not an array", () => {
        const cell = runtime.getCell<string[]>(
          space,
          `non-array-${name}`,
          undefined,
          tx,
        );
        // A cell typed as an array whose stored value is not one. Only reachable
        // through a cast, which is the point: the guard is what stands between
        // that state and a silently wrong write.
        cell.set("not an array" as unknown as string[]);

        expect(() => write(cell, "one")).toThrow(
          /requires transaction and array value/,
        );
      });
    });
  }
});
