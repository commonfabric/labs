import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { deepFreeze, isDeepFrozen } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";

import { isAliasBinding } from "../src/alias-binding.ts";
import { lift } from "../src/builder/module.ts";
import { resolvedSchema } from "./schema-ref-helpers.ts";
import { pattern, popFrame, pushFrame } from "../src/builder/pattern.ts";
import { reactive } from "../src/builder/reactive.ts";
import {
  type FactoryInput,
  type Frame,
  isModule,
  isPattern,
  type JSONSchema,
  type JSONSchemaObj,
  type Module,
  type Pattern,
} from "../src/builder/types.ts";
import { ContextualFlowControl } from "../src/cfc.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("pattern", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;

  let frame: Frame;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });

    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

    frame = pushFrame({
      space,
      generatedIdCounter: 0,
      reactives: new Set(),
      runtime,
    });
  });

  afterEach(async () => {
    popFrame(frame);
    await runtime?.dispose();
  });

  it("creates a pattern", () => {
    const doublePattern = pattern<{ x: number }>(({ x }) => {
      const double = lift(({ x }) => x * 2);
      return { double: double({ x }) };
    });
    expect(isPattern(doublePattern)).toBe(true);
  });

  it("creates a pattern, with simple function", () => {
    const doublePattern = pattern<{ x: number }>(({ x }) => {
      const double = lift<number>((x) => x * 2);
      return { double: double(x) };
    });
    expect(isPattern(doublePattern)).toBe(true);
  });

  it("creates a pattern, with an inner opaque ref", () => {
    const double = lift(({ x }) => x * 2);
    const doublePattern = pattern<{ x: number }>(() => {
      const x = reactive<number>(1);
      (x as any).for("x");
      return { double: double({ x }) };
    });
    expect(isPattern(doublePattern)).toBe(true);
    expect(doublePattern.nodes.length).toBe(1);
    expect(doublePattern.nodes[0].inputs).toMatchObject({
      x: {
        $alias: {
          partialCause: "x",
          path: [],
          scope: "space",
        },
      },
    });
    expect(doublePattern.derivedInternalCells).toEqual([
      {
        partialCause: "double",
        kind: "computed",
      },
      {
        partialCause: "x",
        schema: { default: 1 },
      },
    ]);
  });

  it("derives numeric partial causes for anonymous internal roots", () => {
    const increment = lift((x: number) => x + 1);
    const double = lift((x: number) => x * 2);
    const testPattern = pattern<{ x: number }>(({ x }) => {
      const intermediate = increment(x);
      return { doubled: double(intermediate) };
    });

    expect(testPattern.derivedInternalCells).toEqual([
      {
        partialCause: { $generated: 0 },
        kind: "computed",
      },
      {
        partialCause: "doubled",
        kind: "computed",
      },
    ]);
    expect(testPattern.nodes[0].outputs).toMatchObject({
      $alias: { partialCause: { $generated: 0 }, path: [] },
    });
  });

  it("deep-freezes its manifest of derived internal cells, partial causes included", () => {
    const increment = lift((x: number) => x + 1);
    const double = lift((x: number) => x * 2);
    const testPattern = pattern<{ x: number }>(({ x }) => {
      const intermediate = increment(x);
      return { doubled: double(intermediate) };
    });

    const manifest = testPattern.derivedInternalCells!;
    expect(manifest[0].partialCause).toEqual({ $generated: 0 });
    expect(Object.isFrozen(manifest[0].partialCause)).toBe(true);
    expect(isDeepFrozen(manifest)).toBe(true);
  });

  it("uniquifies repeated stable internal paths with schemas", () => {
    const isPositive = lift(
      (value: number) => value > 0,
      { type: "number" } as const satisfies JSONSchema,
      { type: "boolean" } as const satisfies JSONSchema,
    );

    const testPattern = pattern(() => {
      const first = (isPositive(1) as any).for("isSelected", true);
      const second = (isPositive(2) as any).for("isSelected", true);
      return { first, second };
    });

    const firstPath = (testPattern.result as any).first.$alias.path;
    const secondPath = (testPattern.result as any).second.$alias.path;
    expect((testPattern.result as any).first.$alias.partialCause).toBe(
      "isSelected",
    );
    expect((testPattern.result as any).second.$alias.partialCause).toEqual({
      name: "isSelected",
      $generated: 0,
    });
    expect(firstPath).toEqual([]);
    expect(secondPath).toEqual([]);
    expect(testPattern.derivedInternalCells).toEqual([
      {
        partialCause: "isSelected",
        schema: { type: "boolean" },
        kind: "computed",
      },
      {
        partialCause: {
          name: "isSelected",
          $generated: 0,
        },
        schema: { type: "boolean" },
        kind: "computed",
      },
    ]);
  });

  it("rejects a reserved $generated key in user-supplied causes at build time", () => {
    const isPositive = lift((value: number) => value > 0);

    // A user cause carrying `$generated` would mimic the anonymous-cause
    // namespace — the build throws at the `.for()` call.
    expect(() =>
      pattern(() => {
        const sneaky = (isPositive(1) as any).for({ $generated: 0 });
        return { sneaky };
      })
    ).toThrow('top-level key "$generated" is reserved');

    expect(() =>
      pattern(() => {
        const sneaky = (isPositive(1) as any).for({
          $kind: "stream",
          $generated: 0,
        });
        return { sneaky };
      })
    ).toThrow("is reserved");
  });

  it("rejects a reserved $instance key in user-supplied causes at build time", () => {
    const isPositive = lift((value: number) => value > 0);

    // A user cause carrying `$instance` would mimic a named sub-pattern
    // instance's cause — the build throws at the `.for()` call.
    expect(() =>
      pattern(() => {
        const sneaky = (isPositive(1) as any).for({ $instance: "child" });
        return { sneaky };
      })
    ).toThrow('top-level key "$instance" is reserved');
  });

  it("accepts record causes without a top-level $generated key", () => {
    const isPositive = lift((value: number) => value > 0);

    const testPattern = pattern(() => {
      // Nested `$generated` can't collide with the flat generated causes, and
      // only `$generated` and `$instance` are reserved — other `$`-keys stay
      // legal.
      const nested = (isPositive(1) as any).for({ outer: { $generated: 0 } });
      const sigilish = (isPositive(2) as any).for({ $kind: "stream" });
      return { nested, sigilish };
    });

    // Both records flow through as partial causes unchanged.
    expect((testPattern.result as any).nested.$alias.partialCause).toEqual({
      outer: { $generated: 0 },
    });
    expect((testPattern.result as any).sigilish.$alias.partialCause).toEqual({
      $kind: "stream",
    });
  });

  it("complex pattern has correct schema and nodes", () => {
    const doublePattern = pattern<{ x: number }>(({ x }) => {
      const double = lift<number>((x) => x * 2);
      return { double: double(double(x)) };
    });
    const { argumentSchema, result, nodes } = doublePattern;

    expect(isPattern(doublePattern)).toBe(true);
    expect(argumentSchema).toBe(true);
    expect(result).toEqual({
      double: {
        $alias: {
          partialCause: "double",
          path: [],
          scope: "space",
        },
      },
    });

    expect(nodes.length).toBe(2);
    expect(isModule(nodes[0].module) && nodes[0].module.type).toBe(
      "javascript",
    );
    expect(nodes[0].inputs).toEqual({
      $alias: { cell: "argument", path: ["x"] },
    });
    expect(nodes[0].outputs).toEqual({
      $alias: { partialCause: { $generated: 0 }, path: [], scope: "space" },
    });
    expect(nodes[1].inputs).toEqual({
      $alias: { partialCause: { $generated: 0 }, path: [], scope: "space" },
    });
    expect(nodes[1].outputs).toEqual({
      $alias: {
        partialCause: "double",
        path: [],
        scope: "space",
      },
    });
  });

  it("supports JSON Schema with descriptions", () => {
    const schema = {
      type: "object",
      properties: {
        x: { type: "number" },
      },
      description: "A number",
    } as const satisfies JSONSchema;

    const testPattern = pattern<{ x: number }>(({ x }) => ({ x }), schema);
    expect(isPattern(testPattern)).toBe(true);
    expect(testPattern.argumentSchema).toMatchObject({
      description: "A number",
      type: "object",
      properties: {
        x: { type: "number" },
      },
    });
  });

  it("works with JSON Schema in lifted functions", () => {
    const inputSchema = {
      type: "number",
      description: "A number",
    } as const satisfies JSONSchema;

    const outputSchema = {
      type: "number",
      description: "Doubled",
    } as const satisfies JSONSchema;

    const double = lift(
      (x: number) => x * 2,
      inputSchema,
      outputSchema,
    );

    const patternInputSchema = {
      type: "object",
      properties: {
        x: { type: "number" },
      },
    } as const satisfies JSONSchema;

    const testPattern = pattern<{ x: number }>(({ x }) => ({
      doubled: double(x),
    }), patternInputSchema);

    const module = testPattern.nodes[0].module as Module;
    expect(module.argumentSchema).toMatchObject({
      description: "A number",
      type: "number",
    });
    expect(module.resultSchema).toMatchObject({
      description: "Doubled",
      type: "number",
    });
  });

  it("complex pattern with path aliases has correct schema, nodes, and serialization", () => {
    const doublePattern = pattern<{ x: number }>(({ x }) => {
      const double = lift<{ x: number }>(({ x }) => ({ doubled: x * 2 }));
      const result = double({ x });
      const result2 = double({ x: result.doubled });
      return { double: result2.doubled };
    });
    const { argumentSchema, result, nodes } = doublePattern;

    expect(isPattern(doublePattern)).toBe(true);
    expect(argumentSchema).toBe(true);
    expect(result).toEqual({
      double: {
        $alias: {
          partialCause: { $generated: 1 },
          path: ["doubled"],
          scope: "space",
        },
      },
    });

    expect(nodes.length).toBe(2);
    expect(isModule(nodes[0].module) && nodes[0].module.type).toBe(
      "javascript",
    );
    expect(nodes[0].inputs).toEqual({
      x: { $alias: { cell: "argument", path: ["x"] } },
    });
    expect(nodes[0].outputs).toEqual({
      $alias: { partialCause: { $generated: 0 }, path: [], scope: "space" },
    });
    expect(nodes[1].inputs).toEqual({
      x: {
        $alias: {
          partialCause: { $generated: 0 },
          path: ["doubled"],
          scope: "space",
        },
      },
    });
    expect(nodes[1].outputs).toEqual({
      $alias: { partialCause: { $generated: 1 }, path: [], scope: "space" },
    });

    const json = JSON.stringify(doublePattern);
    const parsed = JSON.parse(json);
    expect(json.length).toBeGreaterThan(200);
    // A test-built (never verified-evaluated) module has no provenance, so
    // the writer keeps the stringified body as the executable fallback. The
    // legacy `implementationRef` is runtime-only since the flip (PR E1) —
    // never serialized.
    expect(typeof parsed.nodes[0].module.implementation).toBe("string");
    expect("implementationRef" in parsed.nodes[0].module).toBe(false);
  });

  it("pattern with map node serializes correctly", () => {
    const doubleArray = pattern<{ values: { x: number }[] }>(
      ({ values }) => {
        const doubled = (values as any).mapWithPattern(
          pattern(({ element, index, array }: FactoryInput<any>) =>
            ((({ x }: any) => {
              const double = lift<number>((x) => x * 2);
              return { doubled: double(x) };
            }) as any)(element, index, array)
          ),
          {},
        );
        return { doubled };
      },
    );

    expect(doubleArray.nodes.length).toBe(1);
    const module = doubleArray.nodes[0].module as Module;
    expect(module.type).toBe("ref");
    expect(module.implementation).toBe("map");

    const node = doubleArray.nodes[0];
    expect(node.inputs).toMatchObject({
      list: { $alias: { cell: "argument", path: ["values"] } },
    });

    const inputs = doubleArray.nodes[0].inputs as unknown as { op: Pattern };
    expect(isPattern(inputs.op)).toBe(true);

    const innerModule = inputs.op.nodes[0].module as Module;
    expect(innerModule.type).toBe("javascript");
    expect(typeof innerModule.implementation).toBe("function");
  });

  it("pattern with ifc property has correct confidentiality tracking", () => {
    const ArgumentSchema = {
      description: "Double a number",
      type: "object",
      properties: {
        x: {
          type: "integer",
          default: 1,
          ifc: { confidentiality: ["confidential"] },
        },
      },
      required: ["x"],
    } as const satisfies JSONSchema;
    const ResultSchema = {
      description: "Doubled number",
      type: "object",
      properties: {
        double: {
          type: "integer",
          default: 1,
        },
      },
      required: ["double"],
    } as const satisfies JSONSchema;

    const double = lift(
      ({ x }: { x: number }) => ({
        double: x * 2,
      }),
      ArgumentSchema,
      ResultSchema,
    );

    const doublePattern = pattern<{ x: number }, { double: number }>(
      ({ x }) => {
        const result = double({ x });
        const result2 = double({ x: result.double });
        return { double: result2.double };
      },
      ArgumentSchema,
      ResultSchema,
    );
    const { result, nodes, argumentSchema } = doublePattern;

    expect(isPattern(doublePattern)).toBe(true);
    expect(argumentSchema).toMatchObject(ArgumentSchema);

    // It would be nice if we also had the {"type": "integer"} for the schema
    // The lifted function knows this in the result schema
    expect(result).toMatchObject({
      double: {
        $alias: {
          partialCause: { $generated: 1 },
          path: ["double"],
        },
      },
    });
    expect(resolvedSchema((result as any).double.$alias.schema)).toMatchObject({
      ifc: ArgumentSchema.properties.x.ifc,
    });

    expect(nodes.length).toBe(2);
    expect(isModule(nodes[0].module) && nodes[0].module.type).toBe(
      "javascript",
    );
    expect(nodes[0].inputs).toMatchObject({
      x: {
        $alias: {
          cell: "argument",
          path: ["x"],
        },
      },
    });
    expect(
      resolvedSchema((nodes[0].inputs as any).x.$alias.schema),
    ).toMatchObject(ArgumentSchema.properties?.x);
    // I don't like that we don't know the other properties of our output here
    expect(nodes[0].outputs).toMatchObject({
      $alias: {
        partialCause: { $generated: 0 },
        path: [],
      },
    });
    expect(
      resolvedSchema((nodes[0].outputs as any).$alias.schema),
    ).toMatchObject({ ifc: ArgumentSchema.properties.x.ifc });
    expect(nodes[1].inputs).toMatchObject({
      x: {
        $alias: {
          partialCause: { $generated: 0 },
          path: ["double"],
        },
      },
    });
    expect(
      resolvedSchema((nodes[1].inputs as any).x.$alias.schema),
    ).toMatchObject({ ifc: ArgumentSchema.properties.x.ifc });
    expect(nodes[1].outputs).toMatchObject({
      $alias: {
        partialCause: { $generated: 1 },
        path: [],
      },
    });
    expect(
      resolvedSchema((nodes[1].outputs as any).$alias.schema),
    ).toMatchObject({ ifc: ArgumentSchema.properties.x.ifc });
  });

  it("pattern with mixed ifc properties has correct confidentiality in the schema of the ssn result", () => {
    const ArgumentSchema = {
      description: "Capitalize a word",
      type: "object",
      properties: {
        word: {
          type: "string",
          default: "hello",
        },
      },
      required: ["word"],
    } as const satisfies JSONSchema;
    const ResultSchema = {
      description: "Capitalized word",
      type: "object",
      properties: {
        capitalized: {
          type: "string",
          default: "Hello",
        },
      },
      required: ["capitalized"],
    } as const satisfies JSONSchema;

    // Input typed loosely (the original used the schema-first overload whose
    // input was JSONSchema); this lift is applied below with `{ ssn }`.
    const capitalize = lift(
      ({ word }: any) => ({
        capitalized: word.charAt(0).toUpperCase() + word.slice(1),
      }),
      ArgumentSchema,
      ResultSchema,
    );

    const UserSchema = {
      description: "Capitalize a word",
      type: "object",
      properties: {
        name: {
          type: "string",
          default: "hello",
        },
        ssn: {
          type: "string",
          default: "123-45-6789",
          ifc: { confidentiality: ["confidential"] },
        },
      },
      required: ["word"],
    } as const satisfies JSONSchema;

    const capitalizeSsnPattern = pattern<
      { ssn: string },
      { capitalized: string }
    >(
      ({ ssn }) => {
        const result = capitalize({ ssn });
        return { capitalized: result.capitalized };
      },
      UserSchema,
      ResultSchema,
    );

    const { result, nodes, argumentSchema, resultSchema } =
      capitalizeSsnPattern;
    expect(isPattern(capitalizeSsnPattern)).toBe(true);
    expect(argumentSchema).toMatchObject(UserSchema);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].outputs).toHaveProperty("$alias");
    const nodeOutputAlias = (nodes[0].outputs as any)["$alias"];
    expect(nodeOutputAlias).toMatchObject({
      partialCause: { $generated: 0 },
      path: [],
    });
    expect(resolvedSchema(nodeOutputAlias.schema)).toMatchObject({
      ifc: { confidentiality: ["confidential"] },
    });
    expect(result).toMatchObject({
      capitalized: {
        $alias: {
          partialCause: { $generated: 0 },
          path: ["capitalized"],
        },
      },
    });
    expect(
      resolvedSchema((result as any).capitalized.$alias.schema),
    ).toMatchObject({ ifc: { confidentiality: ["confidential"] } });
    // The pattern's own result schema is the one declared above. What carries
    // the confidentiality into the result is the alias, whose schema the lift's
    // module joined it onto.
    expect(resultSchema).toMatchObject(ResultSchema);
    expect((resultSchema as { ifc?: unknown }).ifc).toBeUndefined();
  });

  it("creates a pattern with function-only syntax (no schema)", () => {
    const doublePattern = pattern((input: { x: any }) => {
      const double = lift<number>((x) => x * 2);
      return { double: double(input.x) };
    });
    expect(isPattern(doublePattern)).toBe(true);
  });

  it("creates nodes correctly with function-only syntax", () => {
    const doublePattern = pattern((input: { x: any }) => {
      const double = lift<number>((x) => x * 2);
      return { double: double(double(input.x)) };
    });

    const { nodes } = doublePattern;
    expect(nodes.length).toBe(2);
    expect(isModule(nodes[0].module) && nodes[0].module.type).toBe(
      "javascript",
    );
  });

  it("supports never schemas", () => {
    const neverPattern = pattern(
      () => {
      },
      false,
      false,
    );
    expect(isPattern(neverPattern)).toBe(true);
  });

  describe("schemas", () => {
    // `schemaAtPath()` keeps a narrowing only for a deep-frozen schema, and
    // binding a pattern's nodes narrows its argument schema at every slot,
    // so a pattern holds its schemas deep-frozen from the time it is built.

    // A fresh mutable tree per call, as a compiled pattern's schema literal
    // is. The reference into `$defs` makes a narrowing carry the definitions
    // it reaches, so an uncached one builds a new object.
    const itemsArgumentSchema = () =>
      ({
        type: "object",
        properties: {
          item: { $ref: "#/$defs/Item" },
          count: { type: "number", asCell: ["cell"] },
        },
        required: ["item", "count"],
        $defs: {
          Item: { type: "object", properties: { title: { type: "string" } } },
        },
      }) as JSONSchema;

    const countResultSchema = () =>
      ({
        type: "object",
        properties: { doubled: { type: "number" } },
      }) as JSONSchema;

    const double = lift<number>((x) => x * 2);

    const buildItemsPattern = (
      argumentSchema: JSONSchema = itemsArgumentSchema(),
      resultSchema: JSONSchema = countResultSchema(),
    ) =>
      pattern<{ count: number }, { doubled: number }>(
        ({ count }) => ({ doubled: double(count) }),
        argumentSchema,
        resultSchema,
      );

    it("holds a deep-frozen argument schema and result schema", () => {
      const built = buildItemsPattern();
      expect(isDeepFrozen(built.argumentSchema)).toBe(true);
      expect(isDeepFrozen(built.resultSchema)).toBe(true);
      expect(built.argumentSchema).toEqual(itemsArgumentSchema());
      expect(built.resultSchema).toEqual(countResultSchema());
    });

    it("holds deep-frozen schemas given deep-frozen ones", () => {
      const built = buildItemsPattern(
        deepFreeze(itemsArgumentSchema()),
        deepFreeze(countResultSchema()),
      );
      expect(isDeepFrozen(built.argumentSchema)).toBe(true);
      expect(isDeepFrozen(built.resultSchema)).toBe(true);
      expect(built.argumentSchema).toEqual(itemsArgumentSchema());
      expect(built.resultSchema).toEqual(countResultSchema());
    });

    it("holds schemas of its own, given the schemas another pattern was given", () => {
      // `createRef()` hashes an object it reaches twice in one cause as
      // `null`, so two patterns sharing a schema object would derive other
      // ids from a graph holding both than two patterns holding equal ones.
      const argumentSchema = deepFreeze(itemsArgumentSchema());
      const resultSchema = deepFreeze(countResultSchema());
      const first = buildItemsPattern(argumentSchema, resultSchema);
      const second = buildItemsPattern(argumentSchema, resultSchema);
      expect(second.argumentSchema).toEqual(first.argumentSchema);
      expect(second.argumentSchema).not.toBe(first.argumentSchema);
      expect(second.resultSchema).toEqual(first.resultSchema);
      expect(second.resultSchema).not.toBe(first.resultSchema);
    });

    it("narrows its argument schema to the same object on every call", () => {
      const built = buildItemsPattern();
      const first = ContextualFlowControl.schemaAtPath(
        built.argumentSchema,
        ["item"],
      );
      expect(first).toEqual({
        $ref: "#/$defs/Item",
        $defs: {
          Item: { type: "object", properties: { title: { type: "string" } } },
        },
      });
      expect(
        ContextualFlowControl.schemaAtPath(built.argumentSchema, ["item"]),
      ).toBe(first);
    });

    it("holds deep-frozen copies of a nested pattern's schemas in the node that instantiates it", () => {
      // Copies, for the reason a pattern's schemas are its own: the graph
      // and the pattern nested in it must not share a schema object.
      const inner = buildItemsPattern();
      const outer = pattern<{ count: number }, { doubled: number }>(
        ({ count }) => {
          const nested = inner({ count });
          return { doubled: nested.doubled };
        },
        itemsArgumentSchema(),
        countResultSchema(),
      );
      const patternNodes = outer.nodes.filter((node) =>
        isModule(node.module) && node.module.type === "pattern"
      );
      expect(patternNodes).toHaveLength(1);
      const nested = (patternNodes[0].module as Module).implementation;
      expect(isPattern(nested)).toBe(true);
      const { argumentSchema, resultSchema } = nested as Pattern;
      expect(argumentSchema).toEqual(inner.argumentSchema);
      expect(argumentSchema).not.toBe(inner.argumentSchema);
      expect(resultSchema).toEqual(inner.resultSchema);
      expect(resultSchema).not.toBe(inner.resultSchema);
      expect(isDeepFrozen(argumentSchema)).toBe(true);
      expect(isDeepFrozen(resultSchema)).toBe(true);
    });

    describe("an argument alias's schema", () => {
      // Under the content-addressed flag, which is on by default, a binding
      // carries a reference to its schema's documents. `createRef()` hashes
      // an object it reaches twice in one cause as `null`, so where the
      // schema stays inline, every position holds an object of its own.

      const title = lift<{ title: string }, string>((item) => item.title);

      const titlesResultSchema = (): JSONSchema => ({
        type: "object",
        properties: { a: { type: "string" }, b: { type: "string" } },
      });

      /** The schemas of the aliases binding the argument's `item`. */
      const itemAliasSchemas = (built: Pattern): (JSONSchema | undefined)[] =>
        built.nodes.flatMap((node) => {
          const inputs = node.inputs;
          return isAliasBinding(inputs) && inputs.$alias.cell === "argument" &&
              inputs.$alias.path.length === 1 &&
              inputs.$alias.path[0] === "item"
            ? [inputs.$alias.schema]
            : [];
        });

      it("is one reference object at every position that binds the same cell", () => {
        const built = pattern<
          { item: { title: string }; count: number },
          { a: string; b: string }
        >(
          ({ item }) => ({ a: title(item), b: title(item) }),
          itemsArgumentSchema(),
          titlesResultSchema(),
        );
        const schemas = itemAliasSchemas(built);
        expect(schemas).toHaveLength(2);
        expect((schemas[0] as JSONSchemaObj).$ref).toMatch(/^cid:/);
        expect(schemas[1]).toBe(schemas[0]);
      });

      it("is an object of its own at each position where decomposition refuses", () => {
        // A `definitions` keyword is one decomposition refuses, so the
        // schema stays inline.
        const argumentSchema: JSONSchema = {
          type: "object",
          properties: {
            item: {
              type: "object",
              definitions: { Title: { type: "string" } },
              properties: { title: { type: "string" } },
            },
          },
        };
        const built = pattern<
          { item: { title: string } },
          { a: string; b: string }
        >(
          ({ item }) => ({ a: title(item), b: title(item) }),
          argumentSchema,
          titlesResultSchema(),
        );
        const schemas = itemAliasSchemas(built);
        expect(schemas).toHaveLength(2);
        expect(schemas[0]).toEqual(argumentSchema.properties!.item);
        expect(schemas[1]).toEqual(schemas[0]);
        expect(schemas[1]).not.toBe(schemas[0]);
      });
    });
  });
});
