import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { FabricValue } from "@commonfabric/api";
import { MERGEABLE_OP_METHODS } from "@commonfabric/api";
import { patchOpDescriptors } from "@commonfabric/memory/v2/patch";
import {
  buildMergeableIntent,
  MERGEABLE_WIRE_OPS,
  mergeableOpPayloadContains,
} from "../src/storage/mergeable-ops.ts";

describe("mergeable op registry consistency", () => {
  // Ties the three places a mergeable patch op is registered together, so a
  // new op added to one but not the others fails loudly here rather than
  // silently degrading a mergeable write to a whole-value diff:
  //
  //   1. api MERGEABLE_OP_METHODS — the author method + wire tag +
  //      classification
  //   2. runner storage/mergeable-ops — how the op folds intent and builds
  //      wire ops
  //   3. memory v2/patch descriptors — the wire op's shape, apply, and
  //      touched paths

  const catalogWireOps = MERGEABLE_OP_METHODS.map((op) => op.wireOp);

  it("every catalog method records a real wire patch op", () => {
    for (const { method, wireOp } of MERGEABLE_OP_METHODS) {
      expect(
        Object.hasOwn(patchOpDescriptors, wireOp),
        `Cell.${method} records "${wireOp}", which is not a registered PatchOp ` +
          `(add a descriptor in memory/v2/patch.ts)`,
      ).toBe(true);
    }
  });

  it("the catalog and the runner registry cover the same wire ops", () => {
    expect([...new Set(catalogWireOps)].sort()).toEqual(
      [...MERGEABLE_WIRE_OPS].sort(),
    );
  });

  it("names each method once", () => {
    const methods = MERGEABLE_OP_METHODS.map((op) => op.method);
    expect(new Set(methods).size).toBe(methods.length);
  });
});

describe("mergeable op createsKey stamping", () => {
  // A create-from-absent mergeable op adds a key to its parent container; the
  // build stamps `createsKey` so the conflict matcher invalidates a shape
  // reader of the parent (see docs/specs/memory-v2/08-conflict-granularity.md
  // and the engine-side conflict test in packages/memory).

  it("stamps createsKey when a tail op materializes an absent array", () => {
    expect(
      buildMergeableIntent(
        { op: "append", path: ["value", "items"], count: 1 },
        { workingArray: ["a"], hadInitialArray: false, hadInitialValue: false },
      ).ops,
    ).toEqual([
      { op: "append", path: "/value/items", values: ["a"], createsKey: true },
    ]);
  });

  it("omits createsKey when the array already existed", () => {
    expect(
      buildMergeableIntent(
        { op: "append", path: ["value", "items"], count: 1 },
        {
          workingArray: ["a", "b"],
          hadInitialArray: true,
          hadInitialValue: true,
          initialArray: ["a"],
        },
      ).ops,
    ).toEqual([{ op: "append", path: "/value/items", values: ["b"] }]);
  });

  it("stamps createsKey when an increment materializes an absent number", () => {
    expect(
      buildMergeableIntent(
        { op: "increment", path: ["value", "n"], by: 3 },
        { hadInitialArray: false, hadInitialValue: false, workingValue: 3 },
      ).ops,
    ).toEqual([
      { op: "increment", path: "/value/n", by: 3, createsKey: true },
    ]);
  });

  it("omits createsKey on an increment to an existing number", () => {
    expect(
      buildMergeableIntent(
        { op: "increment", path: ["value", "n"], by: 3 },
        {
          hadInitialArray: false,
          hadInitialValue: true,
          initialValue: 4,
          workingValue: 7,
        },
      ).ops,
    ).toEqual([{ op: "increment", path: "/value/n", by: 3 }]);
  });
});

describe("mergeable tail-op build guards", () => {
  // The tail op builder (append / add-unique) bails in several guarded cases,
  // abandoning the intent so the commit carries the plain diff instead. Some
  // are reachable only through sequences the poison fallback short-circuits
  // before build, so they are covered directly here.

  it("a tail op with no working array abandons the intent", () => {
    // The op path holds no array at commit — the value is absent, or was
    // overwritten with a non-array — so there is nothing to slice a tail from.

    for (const op of ["append", "add-unique"] as const) {
      expect(
        buildMergeableIntent(
          { op, path: ["value"], count: 1 },
          {
            workingArray: undefined,
            hadInitialArray: false,
            hadInitialValue: false,
          },
        ),
      ).toEqual({ ops: [], suppress: [], abandon: true });
    }
  });

  it("a tail op whose prefix no longer matches the base length abandons the intent", () => {
    // The transaction changed the array's length ahead of the recorded tail, so
    // the base no longer lines up element-for-element with the working array's
    // prefix. The tail op cannot carry that reshape and its suppression would
    // discard the diff that can, so the intent is abandoned. A base LONGER than
    // the prefix is the corrupting direction (the store keeps the surplus and
    // appends the tail on top); the guard also covers the shorter direction,
    // where the diff alone is likewise the honest carrier.

    for (const initialArray of [["p", "q", "r"], []]) {
      expect(
        buildMergeableIntent(
          { op: "add-unique", path: ["value"], count: 2 },
          {
            workingArray: ["x", "y", "z"],
            hadInitialArray: true,
            hadInitialValue: true,
            initialArray,
          },
        ),
      ).toEqual({ ops: [], suppress: [], abandon: true });
    }
  });

  it("a tail op whose prefix hole layout changed abandons the intent", () => {
    // Same length, but the prefix's HOLE LAYOUT changed. The diff cannot
    // express a presence change per index, so it falls back to a whole-array
    // replacement — the one candidate the op's suppression drops outright.
    // Length equality alone would let that replacement vanish while the tail
    // still committed.

    const punched: (string | undefined)[] = [];
    punched[1] = "b";
    punched[2] = "c";
    punched[3] = "d";
    expect(
      buildMergeableIntent(
        { op: "append", path: ["value"], count: 1 },
        {
          workingArray: punched,
          hadInitialArray: true,
          hadInitialValue: true,
          initialArray: ["a", "b", "c"],
        },
      ),
    ).toEqual({ ops: [], suppress: [], abandon: true });
  });

  it("a tail op whose appended tail is sparse abandons the intent", () => {
    // The appended tail is itself sparse, which is the diff's other whole-array
    // fallback.

    const sparseTail: (string | undefined)[] = ["a", "b"];
    sparseTail[3] = "d";
    expect(
      buildMergeableIntent(
        { op: "append", path: ["value"], count: 2 },
        {
          workingArray: sparseTail,
          hadInitialArray: true,
          hadInitialValue: true,
          initialArray: ["a", "b"],
        },
      ),
    ).toEqual({ ops: [], suppress: [], abandon: true });
  });

  it("a tail op with no base and a sparse payload abandons the intent", () => {
    // With NO base the payload is the whole working array, so the density check
    // has to cover all of it — the other two conditions need a base to compare
    // against, this one does not.

    const sparse: (string | undefined)[] = [];
    sparse[1] = "b";
    sparse[2] = "c";
    expect(
      buildMergeableIntent(
        { op: "append", path: ["value"], count: 1 },
        {
          workingArray: sparse,
          hadInitialArray: false,
          hadInitialValue: false,
        },
      ),
    ).toEqual({ ops: [], suppress: [], abandon: true });
  });

  it("a tail op whose recorded tail is empty abandons the intent", () => {
    // The recorded tail slice is empty: an empty working array against an empty
    // base makes `array.slice(length - count)` empty, so the op carries
    // nothing.

    expect(
      buildMergeableIntent(
        { op: "append", path: ["value"], count: 2 },
        {
          workingArray: [],
          hadInitialArray: true,
          hadInitialValue: true,
          initialArray: [],
        },
      ),
    ).toEqual({ ops: [], suppress: [], abandon: true });
  });
});

describe("mergeable remove-by-value build guards", () => {
  // A remove-by-value suppresses the array path AND its whole subtree, so
  // unlike a tail op it leaves the commit no other carrier for that array. It
  // may therefore be emitted only when it fully explains the local value: the
  // working array must be exactly the base with the removed values taken out.
  // Anything else the transaction changed on that array would otherwise be
  // silently discarded.

  const removeIntent = (...values: string[]) =>
    ({ op: "remove-by-value", path: ["value"], values }) as const;

  const ctx = (
    workingArray: FabricValue[] | undefined,
    initialArray?: FabricValue[],
  ) => ({
    workingArray,
    hadInitialArray: initialArray !== undefined,
    hadInitialValue: initialArray !== undefined,
    initialArray,
  });

  it("emits one wire op per removed value and suppresses the subtree", () => {
    expect(
      buildMergeableIntent(removeIntent("a", "c"), ctx(["b"], ["a", "b", "c"])),
    ).toEqual({
      ops: [
        { op: "remove-by-value", path: "/value", value: "a" },
        { op: "remove-by-value", path: "/value", value: "c" },
      ],
      suppress: [{ path: ["value"], subtree: true }],
    });
  });

  it("accounts for every occurrence of a removed value", () => {
    // Every occurrence of a removed value goes, matching how the store applies
    // the wire op — so a base holding duplicates still lines up with the local
    // value and keeps its op.

    expect(
      buildMergeableIntent(removeIntent("a"), ctx(["b"], ["a", "b", "a"])).ops
        .length,
    ).toBe(1);
  });

  it("abandons the intent when the working array holds an edited element", () => {
    // An element edit alongside the removal: the working array is the base
    // minus "c" but with index 0 rewritten, which the removals alone cannot
    // produce.

    expect(
      buildMergeableIntent(removeIntent("c"), ctx(["A", "b"], ["a", "b", "c"])),
    ).toEqual({ ops: [], suppress: [], abandon: true });
  });

  it("abandons the intent when the array was replaced wholesale", () => {
    // A whole-array set alongside the removal: neither the surviving element
    // nor the disappearance of the base's members is expressed by the removals.

    expect(
      buildMergeableIntent(removeIntent("p"), ctx(["q"], ["a", "b", "c"])),
    ).toEqual({ ops: [], suppress: [], abandon: true });
  });

  it("abandons the intent when a hole in the base was filled", () => {
    // Hole layout is part of "explains the local value": the base's hole at
    // index 1 was filled, which the removals do not express and no surviving
    // candidate carries. `valueEqual` compares by canonical content hash, which
    // keeps a hole distinct from a value (and from a stored `undefined`) rather
    // than flattening the distinction the way a length check would.

    const base: FabricValue[] = ["a", , "c"];
    expect(
      buildMergeableIntent(removeIntent("c"), ctx(["a", "b"], base)),
    ).toEqual({ ops: [], suppress: [], abandon: true });
  });

  it("abandons the intent when there was no base array", () => {
    // No base array to check against — the transaction materialized the array
    // itself — so the op cannot be shown to explain the local value, and its
    // subtree suppression would drop the creation entirely.

    expect(
      buildMergeableIntent(removeIntent("p"), ctx(["q"])),
    ).toEqual({ ops: [], suppress: [], abandon: true });
  });

  it("abandons the intent when there is no working array", () => {
    // The op path holds no array at commit (overwritten with a scalar, or
    // gone), so there is no local value for the removals to describe.

    expect(
      buildMergeableIntent(removeIntent("a"), ctx(undefined, ["a", "b"])),
    ).toEqual({ ops: [], suppress: [], abandon: true });
  });
});

describe("mergeable increment build guards", () => {
  // An increment suppresses the value candidate at its path, so it is the
  // commit's only carrier for that number. It may be emitted only when
  // applying it to the base reproduces the working value, a missing base
  // counting as zero.

  const incrementIntent = (by: number) =>
    ({ op: "increment", path: ["value"], by }) as const;

  const ctx = (workingValue: FabricValue, initialValue?: FabricValue) => ({
    hadInitialArray: false,
    hadInitialValue: initialValue !== undefined,
    workingValue,
    initialValue,
  });

  const abandoned = { ops: [], suppress: [], abandon: true };

  it("emits the op when the working value is the base plus the delta", () => {
    expect(buildMergeableIntent(incrementIntent(2), ctx(7, 5))).toEqual({
      ops: [{ op: "increment", path: "/value", by: 2 }],
      suppress: [{ path: ["value"] }],
    });
  });

  it("abandons the intent when a write ahead of it changed the number", () => {
    expect(buildMergeableIntent(incrementIntent(1), ctx(11, 5))).toEqual(
      abandoned,
    );
  });

  it("abandons the intent when there was no base and a write ahead of it set the number", () => {
    expect(buildMergeableIntent(incrementIntent(1), ctx(11))).toEqual(
      abandoned,
    );
  });

  it("abandons the intent when the base is not a number", () => {
    expect(buildMergeableIntent(incrementIntent(1), ctx(1, "zero"))).toEqual(
      abandoned,
    );
  });

  it("returns no op and keeps the intent when the deltas summed to zero", () => {
    expect(buildMergeableIntent(incrementIntent(0), ctx(5, 5))).toEqual({
      ops: [],
      suppress: [],
    });
  });
});

describe("mergeable op payload containment", () => {
  // Which paths an op's PAYLOAD already carries. Two intents on one document
  // are mutually exclusive when one contains the other: the contained one has
  // already had its change applied by the containing op, whose payload is read
  // from the working array at commit. `buildMergeableOps` abandons the
  // contained intent; this pins the per-op answers it asks for.

  it("a tail op contains the paths at or past its tail start", () => {
    // A tail op sends `array.slice(tailStart)` — live values out of the
    // working document — so it carries every path at or past that index, at
    // any depth.

    const ctx = {
      workingArray: [["a"], ["x"]],
      hadInitialArray: true,
      hadInitialValue: true,
      initialArray: [["a"]],
    };
    const intent = { op: "append", path: ["value"], count: 1 } as const;

    // The appended element, and anything beneath it.
    expect(mergeableOpPayloadContains(intent, ctx, ["value", "1"])).toBe(true);
    expect(mergeableOpPayloadContains(intent, ctx, ["value", "1", "0"]))
      .toBe(true);
    // An element below the tail is not in the payload; nor is the array itself,
    // a sibling, or a non-index key.
    expect(mergeableOpPayloadContains(intent, ctx, ["value", "0"])).toBe(false);
    expect(mergeableOpPayloadContains(intent, ctx, ["value"])).toBe(false);
    expect(mergeableOpPayloadContains(intent, ctx, ["other", "1"])).toBe(false);
    expect(mergeableOpPayloadContains(intent, ctx, ["value", "length"]))
      .toBe(false);
  });

  it("a tail op with no base array contains every element", () => {
    // With no base array the whole working array is the payload, so every
    // element is contained.

    expect(
      mergeableOpPayloadContains(
        { op: "add-unique", path: ["value"], count: 1 },
        {
          workingArray: [["a"], ["x"]],
          hadInitialArray: false,
          hadInitialValue: false,
        },
        ["value", "0"],
      ),
    ).toBe(true);
  });

  it("the non-tail ops contain nothing", () => {
    // An `increment` sends a number and a `remove-by-value` sends the element
    // it removes; neither carries another intent's target.

    expect(
      mergeableOpPayloadContains(
        { op: "increment", path: ["value"], by: 1 },
        { hadInitialArray: false, hadInitialValue: true },
        ["value", "0"],
      ),
    ).toBe(false);
    expect(
      mergeableOpPayloadContains(
        { op: "remove-by-value", path: ["value"], values: ["a"] },
        {
          workingArray: ["b"],
          hadInitialArray: true,
          hadInitialValue: true,
          initialArray: ["a", "b"],
        },
        ["value", "0"],
      ),
    ).toBe(false);
  });
});
