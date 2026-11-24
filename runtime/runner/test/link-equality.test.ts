import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { deepFreeze } from "@commonfabric/data-model";
import { linkRefFrom } from "@commonfabric/data-model/cell-rep";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import type { Cell } from "../src/cell.ts";
import { portableSnapshotId } from "../src/data-uri.ts";
import { ImmutableCellStore } from "../src/immutable-cell.ts";
import { areLinksSame, linkEqualityKey } from "../src/link-equality.ts";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("link-equality operator");
const space = signer.did();
const otherSpace = (await Identity.fromPassphrase("link-equality other space"))
  .did();

describe("link-equality", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let snapshots: ImmutableCellStore;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
    snapshots = new ImmutableCellStore();
  });

  afterEach(async () => {
    snapshots.dispose();
    tx.abort();
    await runtime?.dispose();
    await storageManager?.close();
  });

  describe("linkEqualityKey()", () => {
    /** A cell named `name` in `space`, read and written through `tx`. */
    const cellNamed = (name: string): Cell<unknown> =>
      runtime.getCell<unknown>(space, name, undefined, tx);

    /** The sigil link naming `cell` with its scope written as `scope`. */
    const scopedLinkTo = (cell: Cell<unknown>, scope: string | undefined) => {
      const { id, path } = cell.getAsNormalizedFullLink();
      return linkRefFrom({
        id,
        space,
        path,
        ...(scope !== undefined && { scope }),
      });
    };

    /**
     * Values naming cells in every form `areLinksSame()` reads, with the
     * cases it treats specially: an alias and a chain of them, a scope left
     * out against one written as the space's, and an inline document named
     * natively and portably.
     */
    const fixture = (): Record<string, unknown> => {
      const target = cellNamed("target");
      target.set({ x: 1 });
      const alias = cellNamed("alias");
      alias.set(target);
      const aliasOfAlias = cellNamed("alias-of-alias");
      aliasOfAlias.set(alias);
      const snapshot = snapshots.create(deepFreeze({ topping: "glaze" }));
      const otherSnapshot = snapshots.create(deepFreeze({ topping: "sugar" }));
      return {
        target,
        targetLink: target.getAsLink(),
        targetRedirect: target.getAsWriteRedirectLink(),
        targetUnscoped: scopedLinkTo(target, undefined),
        targetSpaceScoped: scopedLinkTo(target, "space"),
        targetUserScoped: scopedLinkTo(target, "user"),
        targetX: target.key("x"),
        targetInOtherSpace: runtime.getCell<unknown>(
          otherSpace,
          "target",
          undefined,
          tx,
        ),
        alias,
        aliasOfAlias,
        other: cellNamed("other"),
        snapshot: linkRefFrom({ id: snapshot.id }),
        snapshotPortable: linkRefFrom({ id: portableSnapshotId(snapshot.id) }),
        otherSnapshot: linkRefFrom({ id: otherSnapshot.id }),
      };
    };

    it("returns equal keys exactly where `areLinksSame()` returns `true`", () => {
      // Every pair of the fixture, both with and without resolution. The
      // cases after this one pin which pairs match, so that this one cannot
      // pass by both sides returning the same wrong answer for all of them.

      const values = Object.entries(fixture());
      for (const resolve of [false, true]) {
        for (const [nameA, a] of values) {
          for (const [nameB, b] of values) {
            const keysMatch =
              linkEqualityKey(a, undefined, resolve, tx, runtime) ===
                linkEqualityKey(b, undefined, resolve, tx, runtime);
            expect({ nameA, nameB, resolve, keysMatch }).toEqual({
              nameA,
              nameB,
              resolve,
              keysMatch: areLinksSame(a, b, undefined, resolve, tx, runtime),
            });
          }
        }
      }
    });

    it("returns one key for a cell and each link form naming it", () => {
      const values = fixture();
      const keys = [
        values.target,
        values.targetLink,
        values.targetRedirect,
        values.targetUnscoped,
        values.targetSpaceScoped,
      ].map((value) => linkEqualityKey(value));
      expect(new Set(keys).size).toBe(1);
    });

    it("returns different keys for another scope, path, space, or cell", () => {
      const values = fixture();
      const keys = [
        values.target,
        values.targetUserScoped,
        values.targetX,
        values.targetInOtherSpace,
        values.other,
      ].map((value) => linkEqualityKey(value));
      expect(new Set(keys).size).toBe(5);
    });

    it("returns the key of the cell an alias resolves to when resolving", () => {
      const { target, alias, aliasOfAlias } = fixture();
      const resolved = (value: unknown) =>
        linkEqualityKey(value, undefined, true, tx, runtime);
      expect(resolved(alias)).toBe(resolved(target));
      expect(resolved(aliasOfAlias)).toBe(resolved(target));
      expect(linkEqualityKey(alias)).not.toBe(linkEqualityKey(target));
    });

    it("returns one key for an inline document named natively and portably", () => {
      const { snapshot, snapshotPortable, otherSnapshot } = fixture();
      expect(linkEqualityKey(snapshotPortable)).toBe(linkEqualityKey(snapshot));
      expect(linkEqualityKey(otherSnapshot)).not.toBe(
        linkEqualityKey(snapshot),
      );
    });

    it("returns `undefined` for a value that is not a link", () => {
      for (const value of [undefined, null, 0, "", "of:target", {}, [1]]) {
        expect(linkEqualityKey(value)).toBeUndefined();
      }
    });

    it("throws when asked to resolve without a transaction", () => {
      expect(() => linkEqualityKey(cellNamed("target"), undefined, true))
        .toThrow("Provide tx to resolve before comparing");
    });
  });
});
