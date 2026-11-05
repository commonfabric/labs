import { assertEquals, assertThrows } from "@std/assert";
import type { FabricValue } from "@commonfabric/data-model";
import { createFactoryShell } from "@commonfabric/data-model/fabric-factory";

import * as Differential from "../src/storage/differential.ts";
import type { IMemoryAddress, State } from "../src/storage/interface.ts";

const REF = {
  identity: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  symbol: "factory",
} as const;

const shell = (symbol: string = REF.symbol) =>
  createFactoryShell({
    kind: "module",
    ref: { ...REF, symbol },
  });

const fact = (is: FabricValue): State => ({
  the: "application/json",
  of: "of:factory-differential",
  is,
});

const compare = (before: State, after: State) => {
  const memory = {
    get(_address: IMemoryAddress): State {
      return before;
    },
  };
  return [
    ...Differential.create({
      principal: "did:key:z6MkFactoryDifferential",
      sessionId: "factory-differential",
    }).update(memory, [after]),
  ];
};

Deno.test("storage differential compares independent factories by canonical state", () => {
  const before = fact({ value: { factory: shell(), changed: false } });
  const after = fact({ value: { factory: shell(), changed: false } });

  assertEquals(compare(before, after), []);
});

Deno.test("storage differential reports a changed factory atomically at its containing path", () => {
  const before = fact({ value: { factory: shell(), stable: true } });
  const after = fact({
    value: { factory: shell("replacement"), stable: true },
  });

  const changes = compare(before, after);
  assertEquals(changes.length, 1);
  assertEquals(changes[0].address.path, ["value", "factory"]);
  assertEquals(changes[0].before, before.is);
  assertEquals(changes[0].after, after.is);
});

Deno.test("storage differential rejects arbitrary function values", () => {
  const arbitrary = (() => undefined) as unknown as FabricValue;
  const before = fact({ value: { callable: arbitrary, marker: "before" } });
  const after = fact({ value: { callable: arbitrary, marker: "after" } });

  assertThrows(
    () => compare(before, after),
    Error,
    "arbitrary function",
  );
});
