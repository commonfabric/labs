// Decode safety: modern `FabricLink` instances are recognized as links (not
// dropped as opaque objects), and non-JSON-safe Fabric leaves -- a `bigint`,
// and a `FabricSpecialObject` of either arm (`FabricPrimitive`,
// `FabricInstance`) -- survive `annotate` → `JSON.stringify` without throwing
// or becoming `{}`. Both are the at-rest shapes a real DB can produce.

import { assert, assertEquals } from "@std/assert";

import type { FabricValue } from "@commonfabric/data-model";
import {
  resetModernCellRepConfig,
  setModernCellRepConfig,
} from "@commonfabric/data-model/cell-rep";
import { jsonFromFabricValue } from "@commonfabric/data-model/codecs";
import {
  FabricError,
  FabricLink,
} from "@commonfabric/data-model/fabric-instances";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";

import {
  annotate,
  decodedLinkOf,
  decodeStored,
  linksWithPaths,
  stringifyInspectorJson,
  summarize,
  summarizeLink,
} from "../decode.ts";

/** Bounds that reach every value in these fixtures, so a decode test states
 * what the decode found and never what a bound hid. */
const UNBOUNDED = {
  maxDepth: Number.POSITIVE_INFINITY,
  maxNodes: Number.POSITIVE_INFINITY,
};

Deno.test("decode: modern FabricLink is recognized as a link", () => {
  const link = new FabricLink({ id: "of:target", path: [] });
  const decoded = decodedLinkOf(link);
  assert(decoded, "FabricLink should be recognized");
  assertEquals(decoded!.id, "of:target");

  // and reachable by the link walk when nested in a plain structure
  const links = linksWithPaths({ a: { b: link } }, UNBOUNDED).links;
  assertEquals(links.length, 1);
  assertEquals(links[0].link.id, "of:target");
});

Deno.test("decode: a modern encoded link round-trips to a recognized link", () => {
  // Encode WITH modern cell rep on (as a modern server would), decode with the
  // inspector's default config — the value-at-rest must still read as a link.
  setModernCellRepConfig(true);
  let encoded: string;
  try {
    encoded = jsonFromFabricValue({
      value: { ref: new FabricLink({ id: "of:x" }) },
    });
  } finally {
    resetModernCellRepConfig();
  }
  const decoded = decodeStored(encoded);
  const links = linksWithPaths(decoded, UNBOUNDED).links;
  assert(links.some((l) => l.link.id === "of:x"), "modern link must be found");
  // and it must not throw when lowered for export
  JSON.stringify(annotate(decoded));
});

Deno.test("decode: summarizeLink keeps the computed: scheme visible", () => {
  const summary = (id: string) => summarizeLink({ id });
  // The hash preimage is kind-free, so of:fid1:H and computed:fid1:H can be
  // two distinct docs for one cause — the display must NOT conflate them.
  assert(
    summary("of:fid1:abcdefghijklmnop") !==
      summary("computed:fid1:abcdefghijklmnop"),
    "schemes must stay distinguishable",
  );
  assert(
    summary("computed:fid1:abcdefghijklmnop").includes("computed:"),
    "computed marker survives shortening",
  );
  assert(
    summary("computed:fid1:abcdefghijklmnop").includes("fid1:abc"),
    "hash body head survives",
  );
});

Deno.test("decode: BigInt is JSON-safe after annotate", () => {
  const annotated = annotate({ big: 10n, nested: [1n, "ok"] }) as {
    big: { $bigint: string };
    nested: Array<unknown>;
  };
  assertEquals(annotated.big, { $bigint: "10" });
  // the whole thing must JSON.stringify without throwing (the HTML/CLI export path)
  const json = JSON.stringify(annotated);
  assert(json.includes('"$bigint"'), "bigint lowered to a tagged record");
});

Deno.test("decode: inspector JSON matches ordinary pretty output", () => {
  const annotated = annotate({
    text: "value",
    list: [1, true, null],
    nested: { leaf: "complete" },
  });
  assertEquals(
    stringifyInspectorJson(annotated),
    JSON.stringify(annotated, null, 2),
  );
});

Deno.test("decode: full-depth output survives deeply nested values", () => {
  const depth = 20_000;
  let value: FabricValue = { leaf: "complete" };
  for (let index = 0; index < depth; index++) value = { child: value };

  const serialized = stringifyInspectorJson({
    value: annotate(value, Number.POSITIVE_INFINITY),
  });
  let nested = (JSON.parse(serialized) as { value: unknown }).value;
  for (let index = 0; index < depth; index++) {
    nested = (nested as { child: unknown }).child;
  }
  assertEquals(nested, { leaf: "complete" });
});

Deno.test("decode: full-depth annotation marks cycles", () => {
  const value: Record<string, unknown> = {};
  value.self = value;
  // @ts-expect-error A cycle is not a `FabricValue`.
  assertEquals(annotate(value, Number.POSITIVE_INFINITY), { self: "…" });
});

Deno.test("decode: annotate lowers a `FabricPrimitive` to its debug string", () => {
  // A `FabricPrimitive` keeps its state in private fields, so a walk that
  // rebuilds a record from enumerable properties renders it `{}` -- the outcome
  // `annotate` exists to prevent.
  const annotated = annotate({
    bytes: new FabricBytes(new Uint8Array([1, 2, 3])),
  }) as { bytes: { $fabric: string } };

  assertEquals(Object.keys(annotated.bytes), ["$fabric"]);
  assert(annotated.bytes.$fabric.length > 0, "the debug string says something");
  assert(
    JSON.stringify(annotated).includes('"$fabric"'),
    "survives the HTML/CLI export path",
  );
});

Deno.test("decode: annotate lowers a `FabricInstance` to its debug string", () => {
  // The other arm of `FabricSpecialObject`. A `FabricInstance` is a container
  // reached by its codec contents rather than by property name, so descending
  // it by name is wrong for a second reason beyond the empty result.
  const annotated = annotate({
    err: FabricError.fromNativeError(new Error("boom")),
  }) as { err: { $fabric: string } };

  assertEquals(Object.keys(annotated.err), ["$fabric"]);
  assert(annotated.err.$fabric.length > 0, "the debug string says something");
  assert(
    JSON.stringify(annotated).includes('"$fabric"'),
    "survives the HTML/CLI export path",
  );
});

Deno.test("decode: summarize names a `FabricSpecialObject` of either arm", () => {
  // `summarize` feeds table cells. The empty-brace rendering is the tell that
  // it descended something it should have named instead.
  for (
    const value of [
      new FabricBytes(new Uint8Array([1, 2, 3])),
      FabricError.fromNativeError(new Error("boom")),
    ]
  ) {
    const summary = summarize(value);
    assert(summary !== "{}", `not the empty-record rendering: ${summary}`);
    assert(summary.length > 0, "some canonical description");
  }
});

Deno.test("decode: a present `undefined` is not silently dropped on export", () => {
  // JSON.stringify omits an `undefined` field; the sentinel preserves the
  // present-undefined vs absent-key distinction the data model keeps.
  const annotated = annotate({ a: undefined, b: 1 }) as Record<string, unknown>;
  assertEquals(annotated.a, { $undefined: true });
  assert(
    "a" in JSON.parse(JSON.stringify(annotated)),
    "the undefined field survives JSON round-trip",
  );
});

Deno.test("decode: sparse arrays keep holes without scanning their length", () => {
  const sparse: unknown[] = [];
  sparse.length = 1_000_000_000;
  sparse[5] = undefined;
  Object.defineProperty(sparse, "__proto__", {
    value: "own property",
    enumerable: true,
  });

  // @ts-expect-error An array with a named property is not a `FabricValue`.
  const annotated = annotate(sparse) as {
    $sparseArray: {
      length: number;
      entries: Record<string, unknown>;
      properties: Record<string, unknown>;
    };
  };
  assertEquals(annotated, {
    $sparseArray: {
      length: 1_000_000_000,
      entries: { "5": { $undefined: true } },
      properties: JSON.parse('{"__proto__":"own property"}'),
    },
  });
  assert(Object.hasOwn(annotated.$sparseArray.properties, "__proto__"));
  const ordinary = annotate(
    JSON.parse('{"ordinary":true,"__proto__":"own property"}'),
  ) as Record<string, unknown>;
  assertEquals(Object.getPrototypeOf(ordinary), Object.prototype);
  assert(Object.hasOwn(ordinary, "__proto__"));
});

Deno.test("decode: summaries escape terminal control characters", () => {
  assertEquals(
    summarize("\u001b[2Jforged\nline"),
    '"\\u001b[2Jforged\\nline"',
  );
  assertEquals(
    summarize(JSON.parse('{"line\\nforged":1,"bidi‮forged":2}')),
    '{"line\\nforged", "bidi\\u202eforged"}',
  );
});
