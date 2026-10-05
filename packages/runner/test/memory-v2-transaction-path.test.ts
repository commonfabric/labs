import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import type { IMemorySpaceAddress, URI } from "../src/storage/interface.ts";
import { ExtendedStorageTransaction } from "../src/storage/extended-storage-transaction.ts";
import {
  markUiInputBlindWriteTx,
  unmarkUiInputBlindWriteTx,
} from "../src/storage/reactivity-log.ts";
import { ManagedStorageTransaction } from "../src/traverse.ts";
import {
  fixtureDocKey,
  TraverseCaptureRecorder,
} from "../src/traverse-recorder.ts";
import {
  getDirectTransactionNativeCommit,
  getTransactionWriteDetails,
} from "../src/storage/transaction-inspection.ts";

const signer = await Identity.fromPassphrase("memory-v2-transaction-path");
const space = signer.did();

describe("memory v2 transaction path semantics", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({
      as: signer,
    });
    runtime = new Runtime({
      storageManager,
      apiUrl: new URL("http://localhost:8000"),
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  it("preserves sibling fields across repeated path writes", async () => {
    const tx = runtime.edit();
    tx.writeValueOrThrow({
      space,
      scope: "space",
      id: "of:path-write-repeat",
      path: [],
    }, {
      count: 0,
      label: "bench",
      nested: { value: 1 },
    });

    for (let index = 0; index < 10; index += 1) {
      tx.writeValueOrThrow({
        space,
        scope: "space",
        id: "of:path-write-repeat",
        path: ["count"],
      }, index);
    }

    expect(
      tx.readValueOrThrow({
        space,
        scope: "space",
        id: "of:path-write-repeat",
        path: [],
      }),
    ).toEqual({
      count: 9,
      label: "bench",
      nested: { value: 1 },
    });

    await tx.commit().settled;
  });

  it("returns undefined for a missing leaf but errors on a missing parent", async () => {
    const tx = runtime.edit();
    tx.writeValueOrThrow({
      space,
      scope: "space",
      id: "of:path-read-missing",
      path: [],
    }, {
      nested: { value: 1 },
    });

    const missingLeaf = tx.read({
      space,
      scope: "space",
      id: "of:path-read-missing",
      path: ["nested", "missing"],
    });
    expect(missingLeaf.ok?.value).toBeUndefined();

    const missingParent = tx.read({
      space,
      scope: "space",
      id: "of:path-read-missing",
      path: ["nested", "missing", "leaf"],
    });
    expect(missingParent.error?.name).toBe("NotFoundError");

    await tx.commit().settled;
  });

  it("reports a nested read of an absent document as NotFoundError naming the document", () => {
    const tx = runtime.edit();

    const result = tx.read({
      space,
      scope: "space",
      id: "of:path-read-absent-doc",
      path: ["value", "anything"],
    });
    expect(result.error?.name).toBe("NotFoundError");
    // An absent document is reported by id, distinct from the
    // path-does-not-exist wording used inside a document that does exist.
    expect(result.error?.message).toBe(
      "Document not found: of:path-read-absent-doc",
    );

    tx.abort();
  });

  it("read through a primitive intermediate fails with a TypeMismatchError", () => {
    const tx = runtime.edit();
    tx.writeValueOrThrow({
      space,
      scope: "space",
      id: "of:path-read-typemismatch",
      path: [],
    }, { name: "Ada" });

    const result = tx.read({
      space,
      scope: "space",
      id: "of:path-read-typemismatch",
      path: ["value", "name", "deeper"],
    });
    const error = result.error;
    // Reading through a string is a type mismatch, not a missing path and not
    // a plain `undefined`: the slot can never exist while `name` is a string.
    expect(error?.name).toBe("TypeMismatchError");
    expect(
      error?.name === "TypeMismatchError" ? error.actualType : undefined,
    ).toBe("string");

    tx.abort();
  });

  it("batches already-loaded read tracking without changing dependencies", async () => {
    const seedTx = runtime.edit();
    seedTx.writeValueOrThrow({
      space,
      scope: "space",
      id: "of:tracked-read-batch",
      path: [],
    }, { nested: { value: 1 }, label: "one" });
    await seedTx.commit().settled;

    const addresses: IMemorySpaceAddress[] = [
      {
        space,
        scope: "space" as const,
        id: "of:tracked-read-batch" as URI,
        type: "application/json" as const,
        path: ["value", "nested"] as string[],
      },
      {
        space,
        scope: "space" as const,
        id: "of:tracked-read-batch" as URI,
        type: "application/json" as const,
        path: ["value", "nested", "value"] as string[],
      },
      {
        space,
        scope: "space" as const,
        id: "of:tracked-read-batch" as URI,
        type: "application/json" as const,
        path: ["value", "label"] as string[],
      },
    ];

    const individual = runtime.edit();
    for (const address of addresses) {
      individual.read(address, {
        nonRecursive: true,
        trackReadWithoutLoad: true,
      });
    }

    const batched = runtime.edit();
    expect(batched.trackReadPaths).toBeDefined();
    const { path: _path, ...documentAddress } = addresses[0];
    batched.trackReadPaths!(
      documentAddress,
      addresses.map(({ path }) => path),
      { nonRecursive: true },
    );

    expect(Array.from(batched.getReadActivities!())).toEqual(
      Array.from(individual.getReadActivities!()),
    );
    expect(batched.getReactivityLog!()).toEqual(individual.getReactivityLog!());
    individual.abort();
    batched.abort();
  });

  it("preserves batched tracking edge semantics", () => {
    const address = {
      space,
      scope: "space" as const,
      id: "of:tracked-read-batch-edge" as URI,
      type: "application/json" as const,
    };
    const path = ["value", "nested"];

    const individual = runtime.edit();
    const batched = runtime.edit();
    markUiInputBlindWriteTx(individual);
    markUiInputBlindWriteTx(batched);
    try {
      individual.read({ ...address, path }, {
        nonRecursive: true,
        trackReadWithoutLoad: true,
      });
      batched.trackReadPaths!(address, [path], { nonRecursive: true });
      expect(Array.from(batched.getReadActivities!())).toEqual(
        Array.from(individual.getReadActivities!()),
      );
    } finally {
      unmarkUiInputBlindWriteTx(individual);
      unmarkUiInputBlindWriteTx(batched);
      individual.abort();
      batched.abort();
    }

    const extended = runtime.edit() as ExtendedStorageTransaction;
    expect(extended.trackReadPaths!(address, [])).toEqual({ ok: {} });
    expect(extended.tx.trackReadPaths!(address, [])).toEqual({ ok: {} });
    extended.abort();
    const inactiveError = extended.tx.trackReadPaths!(address, [path]).error;
    expect(inactiveError).toBeDefined();

    const fallback = new ExtendedStorageTransaction(
      new ManagedStorageTransaction({ load: () => null }),
    );
    expect(fallback.trackReadPaths!(address, [path])).toEqual({ ok: {} });

    const failingInner = new ManagedStorageTransaction({ load: () => null });
    failingInner.read = () => ({ error: inactiveError! });
    const failingFallback = new ExtendedStorageTransaction(failingInner);
    expect(failingFallback.trackReadPaths!(address, [path]).error).toEqual(
      inactiveError,
    );
  });

  it("captures documents reached only through batched read tracking", async () => {
    const address = {
      space,
      scope: "space" as const,
      id: "of:tracked-read-capture" as URI,
      type: "application/json" as const,
    };
    const seedTx = runtime.edit();
    seedTx.writeValueOrThrow({ ...address, path: [] }, {
      nested: { value: 1 },
    });
    await seedTx.commit().settled;

    const recorder = new TraverseCaptureRecorder();
    const readTx = runtime.edit();
    const capturedTx = recorder.wrapTx(readTx);
    capturedTx.trackReadPaths!(address, [["value", "nested", "value"]], {
      nonRecursive: true,
    });

    const fixture = recorder.toFixture("batched-read", "test");
    expect(fixtureDocKey(address) in fixture.docs).toBe(true);
    readTx.abort();
  });

  it("creates missing parent objects without clobbering siblings", async () => {
    const tx = runtime.edit();
    tx.writeValueOrThrow({
      space,
      scope: "space",
      id: "of:path-write-missing-parent",
      path: [],
    }, {
      count: 0,
      nested: {},
    });

    tx.writeValueOrThrow({
      space,
      scope: "space",
      id: "of:path-write-missing-parent",
      path: ["details", "profile", "name"],
    }, "Ada");

    expect(
      tx.readValueOrThrow({
        space,
        scope: "space",
        id: "of:path-write-missing-parent",
        path: [],
      }),
    ).toEqual({
      count: 0,
      nested: {},
      details: {
        profile: {
          name: "Ada",
        },
      },
    });

    await tx.commit().settled;
  });

  it("preserves siblings across mixed object and array path writes", async () => {
    const tx = runtime.edit();
    tx.writeValueOrThrow({
      space,
      scope: "space",
      id: "of:path-write-mixed-branches",
      path: [],
    }, {
      profile: { name: "Ada" },
      items: [{ label: "one" }],
    });

    tx.writeValueOrThrow({
      space,
      scope: "space",
      id: "of:path-write-mixed-branches",
      path: ["items", "1", "label"],
    }, "two");
    tx.writeValueOrThrow({
      space,
      scope: "space",
      id: "of:path-write-mixed-branches",
      path: ["details", "flags", "active"],
    }, true);

    expect(
      tx.readValueOrThrow({
        space,
        scope: "space",
        id: "of:path-write-mixed-branches",
        path: [],
      }),
    ).toEqual({
      profile: { name: "Ada" },
      items: [{ label: "one" }, { label: "two" }],
      details: {
        flags: {
          active: true,
        },
      },
    });

    await tx.commit().settled;
  });

  it("delete-of-nonexistent: an explicit delete at a missing path is a no-op (does not create intermediates)", () => {
    const tx = runtime.edit();
    tx.writeValueOrThrow({
      space,
      scope: "space",
      id: "of:path-delete-nonexistent",
      path: [],
    }, {
      kept: "intact",
    });

    // Delete a slot that doesn't exist. Should leave the doc unchanged --
    // no `details` container materialized, `kept` preserved.
    tx.writeValueOrThrow(
      {
        space,
        scope: "space",
        id: "of:path-delete-nonexistent",
        path: ["details", "profile", "name"],
      },
      undefined,
      { delete: true },
    );

    expect(
      tx.readValueOrThrow({
        space,
        scope: "space",
        id: "of:path-delete-nonexistent",
        path: [],
      }),
    ).toEqual({ kept: "intact" });
    // The intermediates should NOT have been allocated.
    expect(
      tx.read({
        space,
        scope: "space",
        id: "of:path-delete-nonexistent",
        path: ["details"],
      }).ok?.value,
    ).toBeUndefined();

    tx.abort();
  });

  it("writing undefined at a missing path materializes intermediates and stores undefined", () => {
    const tx = runtime.edit();
    tx.writeValueOrThrow({
      space,
      scope: "space",
      id: "of:path-set-undefined-nonexistent",
      path: [],
    }, {
      kept: "intact",
    });

    // A plain write of `undefined` is a value write: intermediates are
    // created and the leaf slot becomes present-but-undefined.
    tx.writeValueOrThrow({
      space,
      scope: "space",
      id: "of:path-set-undefined-nonexistent",
      path: ["details", "profile", "name"],
    }, undefined);

    const root = tx.readValueOrThrow({
      space,
      scope: "space",
      id: "of:path-set-undefined-nonexistent",
      path: [],
    }) as { kept: string; details: { profile: Record<string, unknown> } };
    expect(root.kept).toBe("intact");
    expect("name" in root.details.profile).toBe(true);
    expect(root.details.profile.name).toBeUndefined();

    tx.abort();
  });

  it("writes the same value at the same path as a no-op (identity-preserving)", () => {
    const tx = runtime.edit();
    const initial = { count: 1, label: "one" };
    tx.writeValueOrThrow({
      space,
      scope: "space",
      id: "of:path-noop",
      path: [],
    }, initial);

    const before = tx.read({
      space,
      scope: "space",
      id: "of:path-noop",
      path: [],
    }).ok?.value;

    // Write a deep-equal but distinct-reference object at the same path.
    tx.writeValueOrThrow({
      space,
      scope: "space",
      id: "of:path-noop",
      path: [],
    }, { count: 1, label: "one" });

    const after = tx.read({
      space,
      scope: "space",
      id: "of:path-noop",
      path: [],
    }).ok?.value;

    // Identity preserved across the no-op write.
    expect(after).toBe(before);

    tx.abort();
  });

  it("does not elide a root rewrite of `0` with `-0`", async () => {
    // `0` and `-0` are distinct stored values -- `valueEqual` and the content
    // hash both tell them apart -- so the no-op elision above must not swallow
    // a `-0` written over a stored `0`.
    const address = {
      space,
      scope: "space" as const,
      id: "of:path-negative-zero" as const,
      path: [] as string[],
    };

    const seed = runtime.edit();
    seed.writeValueOrThrow(address, 0);
    expect((await seed.commit().settled).error).toBeUndefined();

    const tx = runtime.edit();
    tx.writeValueOrThrow(address, -0);

    expect(Object.is(tx.readValueOrThrow(address), -0)).toBe(true);

    const commit = getDirectTransactionNativeCommit(tx, space);
    expect(commit?.operations.length).toBe(1);
    const written = (commit?.operations[0] as { value?: { value?: unknown } })
      .value?.value;
    expect(Object.is(written, -0)).toBe(true);

    tx.abort();
  });

  it("write through a primitive intermediate fails with a TypeMismatchError on the offending path", () => {
    const tx = runtime.edit();
    tx.writeValueOrThrow({
      space,
      scope: "space",
      id: "of:path-typemismatch",
      path: [],
    }, {
      // `name` is a string -- writing /name/whatever should fail with a type
      // mismatch, not silently overwrite or create children.
      name: "Ada",
    });

    const result = tx.write({
      space,
      scope: "space",
      id: "of:path-typemismatch",
      path: ["value", "name", "deeper"],
    }, "should fail");
    const error = result.error;
    expect(error?.name).toBe("TypeMismatchError");
    // The error names the non-container intermediate (`name`, a string), not
    // the leaf the write was aimed at.
    expect(
      error?.name === "TypeMismatchError" ? error.address.path : undefined,
    ).toEqual(["value", "name"]);

    // The doc should be unchanged.
    expect(
      tx.readValueOrThrow({
        space,
        scope: "space",
        id: "of:path-typemismatch",
        path: [],
      }),
    ).toEqual({ name: "Ada" });

    tx.abort();
  });

  it("writing `undefined` to an array's `.length` does not crash with RangeError", () => {
    // Regression: a degenerate write (undefined value at array .length)
    // used to fall through `applyArrayLengthWrite`'s guards and end up
    // attempting `parent.length = NaN`, which throws a `RangeError`.
    const tx = runtime.edit();
    tx.writeValueOrThrow({
      space,
      scope: "space",
      id: "of:path-length-undefined",
      path: [],
    }, { items: [1, 2, 3] });

    // Should not throw.
    tx.writeValueOrThrow({
      space,
      scope: "space",
      id: "of:path-length-undefined",
      path: ["items", "length"],
    }, undefined as unknown as number);

    tx.abort();
  });

  it("setting an array's `.length` to `+Infinity` is a no-op (no phantom write recorded)", () => {
    // Regression: per the documented "+Infinity → unchanged" semantics
    // for length writes, the array's `.length` is left as-is. But the
    // write helper used to return `changed: true` unconditionally, which
    // would make the transaction observe a phantom write (and trigger
    // spurious reactivity / write-activity).
    const tx = runtime.edit();
    tx.writeValueOrThrow({
      space,
      scope: "space",
      id: "of:path-length-infinity",
      path: [],
    }, { items: [1, 2, 3] });

    tx.writeValueOrThrow({
      space,
      scope: "space",
      id: "of:path-length-infinity",
      path: ["items", "length"],
    }, Number.POSITIVE_INFINITY);

    // The array contents must be unchanged.
    expect(
      tx.readValueOrThrow({
        space,
        scope: "space",
        id: "of:path-length-infinity",
        path: ["items"],
      }),
    ).toEqual([1, 2, 3]);

    // And no write should be recorded at the length path: a no-op
    // shouldn't fire reactivity or be reported as a write.
    const lengthWrites = [...getTransactionWriteDetails(tx, space)].filter(
      (detail) =>
        detail.address.id === "of:path-length-infinity" &&
        detail.address.path[detail.address.path.length - 1] === "length",
    );
    expect(lengthWrites).toEqual([]);

    tx.abort();
  });

  it("nested write into a fresh doc materializes the doc value at the root", () => {
    // The whole doc value is what just came into existence; the activity
    // path for subscribers watching the root should reflect that, for a
    // path of length 1 too -- the storage-boundary "value" prefix makes a
    // single-segment user write one.
    const tx = runtime.edit();
    tx.writeValueOrThrow({
      space,
      scope: "space",
      id: "of:path-initial-nested",
      path: [],
    }, { title: "Hello", nested: { count: 0 } });

    expect(
      tx.readValueOrThrow({
        space,
        scope: "space",
        id: "of:path-initial-nested",
        path: ["nested", "count"],
      }),
    ).toEqual(0);

    tx.abort();
  });
});
