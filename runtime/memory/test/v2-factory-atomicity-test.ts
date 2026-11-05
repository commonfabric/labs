import { assertEquals, assertStrictEquals, assertThrows } from "@std/assert";
import type { FabricValue } from "@commonfabric/data-model";
import { createFactoryShell } from "@commonfabric/data-model/fabric-factory";

import { applyPatch } from "../v2/patch.ts";

const REF = {
  identity: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  symbol: "factory",
} as const;

const shell = (symbol: string = REF.symbol) =>
  createFactoryShell({
    kind: "module",
    ref: { ...REF, symbol },
  });

Deno.test("memory v2 mergeable patch equality uses canonical factory state", () => {
  const stored = shell();
  const equal = shell();
  const added = applyPatch({ values: [stored] }, [{
    op: "add-unique",
    path: "/values",
    values: [equal],
  }]) as { values: FabricValue[] };
  assertEquals(added.values.length, 1);
  assertStrictEquals(added.values[0], stored);

  const removed = applyPatch({ values: [stored] }, [{
    op: "remove-by-value",
    path: "/values",
    value: equal,
  }]) as { values: FabricValue[] };
  assertEquals(removed.values, []);

  const replacement = shell("replacement");
  const changed = applyPatch({ values: [stored] }, [{
    op: "add-unique",
    path: "/values",
    values: [replacement],
  }]) as { values: FabricValue[] };
  assertEquals(changed.values.length, 2);
  assertStrictEquals(changed.values[1], replacement);
});

Deno.test("memory v2 patch treats a factory as an atomic value", () => {
  const original = shell();
  const replacement = shell("replacement");
  const patched = applyPatch({ factory: original }, [{
    op: "replace",
    path: "/factory",
    value: replacement,
  }]) as { factory: FabricValue };
  assertStrictEquals(patched.factory, replacement);

  assertThrows(
    () =>
      applyPatch({ factory: original }, [{
        op: "replace",
        path: "/factory/ref/symbol",
        value: "forged",
      }]),
    Error,
    "path is not traversable",
  );
});

Deno.test("memory v2 mergeable patch equality rejects arbitrary functions", () => {
  const arbitrary = (() => undefined) as unknown as FabricValue;

  assertThrows(
    () =>
      applyPatch({ values: [arbitrary] }, [{
        op: "add-unique",
        path: "/values",
        values: [arbitrary],
      }]),
    Error,
    "arbitrary function",
  );
});
