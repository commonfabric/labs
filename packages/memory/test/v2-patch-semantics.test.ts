import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { hashStringOf } from "@commonfabric/data-model";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import { encodeMemoryBoundary, PATCH_SEMANTICS_VERSION } from "../v2.ts";
import { applyPatchToDocument, PatchApplyError } from "../v2/patch.ts";

/** The version the cases below record the results of. */
const RECORDED_VERSION = 1;

/**
 * The fingerprint of the cases each version was released with. A released
 * version's entry never changes: results that have to change are recorded as
 * a new version, under a new entry, with `PATCH_SEMANTICS_VERSION` and
 * `RECORDED_VERSION` moved to it.
 */
const RELEASED_FINGERPRINTS: Record<number, string> = {
  1: "ka7-QdTsOLc_ogs444QLoQKFUEXsQbkzoVribprUakA",
};

/** Builds a link record, its keys in one order or the other. */
const link = (order: "id-first" | "space-first") =>
  order === "id-first"
    ? { "/": { "link@1": { id: "of:x", path: [], space: "did:key:x" } } }
    : { "/": { "link@1": { space: "did:key:x", path: [], id: "of:x" } } };

/** Builds the bytes `[1, 2]`, a fresh instance each time. */
const bytes = () => new FabricBytes(new Uint8Array([1, 2]));

/**
 * What applying each list of operations to its base produces at
 * {@link RECORDED_VERSION}, through `applyPatchToDocument()`, the entry point a
 * client's replay and the server's reconstruction share: the result as the
 * memory boundary encodes it — keys in canonical order, `-0` and `NaN` written
 * out — or `PatchApplyError` for a list the patch refuses. Every operation kind
 * appears, and so do the equalities `add-unique` and `remove-by-value` decide
 * with `valueEqual()`. Comparing encodings ties the record to the codec as
 * well, which is right: a client replays the operations it holds in memory,
 * and the server applies the ones it decoded.
 */
const CASES: Array<{
  name: string;
  base: unknown;
  ops: unknown[];
  result: string;
}> = [
  {
    name: "replace a nested value",
    base: { a: { b: 1 } },
    ops: [{ op: "replace", path: "/a/b", value: 2 }],
    result: 'fvj1:{"a":{"b":2}}',
  },
  {
    name: "add an object key",
    base: { a: 1 },
    ops: [{ op: "add", path: "/b", value: { c: [1] } }],
    result: 'fvj1:{"a":1,"b":{"c":[1]}}',
  },
  {
    name: "add into an array",
    base: { a: [1, 3] },
    ops: [{ op: "add", path: "/a/1", value: 2 }],
    result: 'fvj1:{"a":[1,2,3]}',
  },
  {
    name: "add at the end of an array",
    base: { a: [1] },
    ops: [{ op: "add", path: "/a/-", value: 2 }],
    result: 'fvj1:{"a":[1,2]}',
  },
  {
    name: "remove an object key",
    base: { a: 1, b: 2 },
    ops: [{ op: "remove", path: "/a" }],
    result: 'fvj1:{"b":2}',
  },
  {
    name: "remove an array element",
    base: { a: [1, 2, 3] },
    ops: [{ op: "remove", path: "/a/1" }],
    result: 'fvj1:{"a":[1,3]}',
  },
  {
    name: "move a value",
    base: { a: { x: 1 }, b: {} },
    ops: [{ op: "move", from: "/a/x", path: "/b/y" }],
    result: 'fvj1:{"a":{},"b":{"y":1}}',
  },
  {
    name: "splice an array",
    base: { a: [1, 2, 3, 4] },
    ops: [{ op: "splice", path: "/a", index: 1, remove: 2, add: ["x"] }],
    result: 'fvj1:{"a":[1,"x",4]}',
  },
  {
    name: "append to an array",
    base: { a: [1] },
    ops: [{ op: "append", path: "/a", values: [2, 3] }],
    result: 'fvj1:{"a":[1,2,3]}',
  },
  {
    name: "append creating the array",
    base: {},
    ops: [{ op: "append", path: "/a/b", values: [1], createsKey: true }],
    result: 'fvj1:{"a":{"b":[1]}}',
  },
  {
    name: "add-unique a new value and an existing one",
    base: { a: [1] },
    ops: [{ op: "add-unique", path: "/a", values: [2, 1] }],
    result: 'fvj1:{"a":[1,2]}',
  },
  {
    name: "add-unique an equal record with its keys in another order",
    base: { a: [{ x: 1, y: 2 }] },
    ops: [{ op: "add-unique", path: "/a", values: [{ y: 2, x: 1 }] }],
    result: 'fvj1:{"a":[{"x":1,"y":2}]}',
  },
  {
    name: "add-unique negative zero over zero",
    base: { a: [0] },
    ops: [{ op: "add-unique", path: "/a", values: [-0] }],
    result: 'fvj1:{"a":[0,{"/SpecialNumber@1":"-0"}]}',
  },
  {
    name: "add-unique NaN over NaN",
    base: { a: [NaN] },
    ops: [{ op: "add-unique", path: "/a", values: [NaN] }],
    result: 'fvj1:{"a":[{"/SpecialNumber@1":"NaN"}]}',
  },
  {
    name: "add-unique a lone surrogate over the replacement character",
    base: { a: ["�"] },
    ops: [{ op: "add-unique", path: "/a", values: ["\uD800"] }],
    result: 'fvj1:{"a":["�","\\ud800"]}',
  },
  {
    name: "add-unique creating the array",
    base: {},
    ops: [{ op: "add-unique", path: "/a", values: [1, 1], createsKey: true }],
    result: 'fvj1:{"a":[1]}',
  },
  {
    name: "remove-by-value every equal element",
    base: { a: [1, { x: 1 }, 1, 2] },
    ops: [{ op: "remove-by-value", path: "/a", value: 1 }],
    result: 'fvj1:{"a":[{"x":1},2]}',
  },
  {
    name: "remove-by-value an equal record with its keys in another order",
    base: { a: [{ x: 1, y: 2 }, 3] },
    ops: [{ op: "remove-by-value", path: "/a", value: { y: 2, x: 1 } }],
    result: 'fvj1:{"a":[3]}',
  },
  {
    name: "remove-by-value an absent value",
    base: { a: [1] },
    ops: [{ op: "remove-by-value", path: "/a", value: 9 }],
    result: 'fvj1:{"a":[1]}',
  },
  {
    name: "increment a number",
    base: { n: 1 },
    ops: [{ op: "increment", path: "/n", by: 2.5 }],
    result: 'fvj1:{"n":3.5}',
  },
  {
    name: "increment creating the number",
    base: {},
    ops: [{ op: "increment", path: "/n", by: -3, createsKey: true }],
    result: 'fvj1:{"n":-3}',
  },
  {
    name: "increment by a non-finite amount",
    base: { n: 1 },
    ops: [{ op: "increment", path: "/n", by: Infinity }],
    result: "PatchApplyError",
  },
  {
    name: "replace a missing path",
    base: { a: 1 },
    ops: [{ op: "replace", path: "/b/c", value: 1 }],
    result: "PatchApplyError",
  },
  {
    name: "append onto a non-array",
    base: { a: 1 },
    ops: [{ op: "append", path: "/a", values: [1] }],
    result: "PatchApplyError",
  },
  {
    name: "replace the root with a document",
    base: { a: 1 },
    ops: [{ op: "replace", path: "", value: { b: 2 } }],
    result: 'fvj1:{"b":2}',
  },
  {
    name: "replace the root with a non-document",
    base: { a: 1 },
    ops: [{ op: "replace", path: "", value: 5 }],
    result: "PatchApplyError",
  },
  {
    name: "patch an absent document",
    base: undefined,
    ops: [{ op: "add", path: "/a", value: 1 }],
    result: 'fvj1:{"a":1}',
  },
  {
    name: "add under a missing parent",
    base: {},
    ops: [{ op: "add", path: "/a/b", value: 1 }],
    result: 'fvj1:{"a":{"b":1}}',
  },
  {
    name: "escaped pointer segments",
    base: { "a/b": 1, "c~d": 2 },
    ops: [
      { op: "replace", path: "/a~1b", value: 3 },
      { op: "remove", path: "/c~0d" },
    ],
    result: 'fvj1:{"a/b":3}',
  },
  {
    name: "splice past the end of an array",
    base: { a: [1] },
    ops: [{ op: "splice", path: "/a", index: 5, remove: 0, add: [2] }],
    result: "PatchApplyError",
  },
  {
    name: "add past the end of an array",
    base: { a: [1] },
    ops: [{ op: "add", path: "/a/5", value: 2 }],
    result: "PatchApplyError",
  },
  {
    name: "increment a non-number",
    base: { n: "x" },
    ops: [{ op: "increment", path: "/n", by: 1 }],
    result: "PatchApplyError",
  },
  {
    name: "increment an absent number without createsKey",
    base: {},
    ops: [{ op: "increment", path: "/n", by: 1 }],
    result: 'fvj1:{"n":1}',
  },
  {
    name: "move a value into its own descendant",
    base: { a: { b: {} } },
    ops: [{ op: "move", from: "/a", path: "/a/b/c" }],
    result: "PatchApplyError",
  },
  {
    name: "add-unique an equal link written in another key order",
    base: { a: [link("id-first")] },
    ops: [{ op: "add-unique", path: "/a", values: [link("space-first")] }],
    result:
      'fvj1:{"a":[{"/quote":{"/":{"link@1":{"id":"of:x","path":[],"space":"did:key:x"}}}}]}',
  },
  {
    name: "add-unique equal bytes",
    base: { a: [bytes()] },
    ops: [{ op: "add-unique", path: "/a", values: [bytes()] }],
    result: 'fvj1:{"a":[{"/Bytes@1":"AQI"}]}',
  },
  {
    name: "remove-by-value equal bytes",
    base: { a: [bytes(), 3] },
    ops: [{ op: "remove-by-value", path: "/a", value: bytes() }],
    result: 'fvj1:{"a":[3]}',
  },
  {
    name: "several operations in order",
    base: { a: [] },
    ops: [
      { op: "append", path: "/a", values: [1] },
      { op: "replace", path: "/a/0", value: 5 },
      { op: "add", path: "/b", value: true },
    ],
    result: 'fvj1:{"a":[5],"b":true}',
  },
];

/** Returns what applying `ops` to `base` produces, in the form `CASES` records. */
const outcome = (base: unknown, ops: unknown[]): string => {
  try {
    return encodeMemoryBoundary(
      applyPatchToDocument(base as never, ops as never),
    );
  } catch (error) {
    if (error instanceof PatchApplyError) return "PatchApplyError";
    throw error;
  }
};

/** Returns the fingerprint of `CASES`: every name, input and result. */
const fingerprint = (): string =>
  hashStringOf(
    encodeMemoryBoundary(
      CASES.map(({ name, base, ops, result }) => [
        name,
        base ?? null,
        ops,
        result,
      ]) as never,
    ),
  );

describe("PATCH_SEMANTICS_VERSION", () => {
  it("is the version the recorded results belong to", () => {
    // A client replays its own patches with the patch code it was built
    // with, and the server elides the result on the strength of the version
    // it advertises. A case below whose result has to change therefore
    // changes what a client built at this version replays to: record the new
    // results, and give them a new version in `v2/patch-semantics.ts` and in
    // `RECORDED_VERSION` together.

    expect(PATCH_SEMANTICS_VERSION).toBe(RECORDED_VERSION);
  });

  it("records the cases its version was released with", () => {
    expect(fingerprint()).toBe(RELEASED_FINGERPRINTS[RECORDED_VERSION]);
  });

  describe("recorded results", () => {
    for (const { name, base, ops, result } of CASES) {
      it(`produces the recorded result for: ${name}`, () => {
        expect(outcome(base, ops)).toBe(result);
      });
    }
  });
});
