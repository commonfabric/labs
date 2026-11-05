import { assert, assertEquals, assertThrows } from "@std/assert";
import type { FabricValue } from "@commonfabric/data-model";
import {
  createFactoryShell,
  factoryStateOf,
} from "@commonfabric/data-model/fabric-factory";

import { decodeMemoryBoundary, encodeMemoryBoundary } from "../v2.ts";

const FACTORY_STATE = {
  kind: "module",
  ref: {
    identity: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    symbol: "boundaryFactory",
  },
  argumentSchema: {
    type: "object",
    properties: { value: { type: "number" } },
    required: ["value"],
    additionalProperties: false,
  },
  resultSchema: {
    type: "object",
    properties: { result: { type: "number" } },
    required: ["result"],
    additionalProperties: false,
  },
} as const;

const PREFIX = "fvj1:";

Deno.test("memory boundary round-trips Factory@1 through its atomic tag", () => {
  const factory = createFactoryShell(FACTORY_STATE);
  const encoded = encodeMemoryBoundary(factory);

  assert(encoded.startsWith(PREFIX));
  assertEquals(JSON.parse(encoded.slice(PREFIX.length)), {
    "/Factory@1": FACTORY_STATE,
  });

  const decoded = decodeMemoryBoundary(encoded);
  assert(typeof decoded === "function");
  assertEquals(factoryStateOf(decoded), FACTORY_STATE);
  assert(Object.isFrozen(decoded));
  assertEquals(encodeMemoryBoundary(decoded), encoded);
  assertThrows(
    () => (decoded as unknown as () => unknown)(),
    Error,
    "factory requires runner materialization",
  );
});

Deno.test("memory boundary preserves Factory@1 nested in arrays and objects", () => {
  const factory = createFactoryShell(FACTORY_STATE);
  const encoded = encodeMemoryBoundary({
    direct: factory,
    nested: [{ factory }],
  });
  const decoded = decodeMemoryBoundary<{
    direct: FabricValue;
    nested: Array<{ factory: FabricValue }>;
  }>(encoded);

  assert(typeof decoded.direct === "function");
  assert(typeof decoded.nested[0].factory === "function");
  assertEquals(factoryStateOf(decoded.direct), FACTORY_STATE);
  assertEquals(factoryStateOf(decoded.nested[0].factory), FACTORY_STATE);
  assert(Object.isFrozen(decoded));
  assert(Object.isFrozen(decoded.nested));
});

Deno.test("memory boundary rejects arbitrary JavaScript functions", () => {
  const arbitrary = (() => undefined) as unknown as FabricValue;

  assertThrows(
    () => encodeMemoryBoundary(arbitrary),
    Error,
    "no applicable codec",
  );
  assertThrows(
    () => encodeMemoryBoundary({ nested: [arbitrary] }),
    Error,
    "no applicable codec",
  );
});
