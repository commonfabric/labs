import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { SchemaGenerationDiagnostic } from "../../src/interface.ts";
import { SchemaGenerator } from "../../src/schema-generator.ts";
import { MAX_EXPANDING_READINGS } from "../../src/typescript/expanding-recursion.ts";
import { asObjectSchema, getTypeFromCode } from "../utils.ts";

describe("Schema: Recursion variants", () => {
  it("simple recursive: next?: Node", async () => {
    const code = `
      interface Node { value: number; next?: Node; }
    `;
    const { type, checker } = await getTypeFromCode(code, "Node");
    const gen = new SchemaGenerator();
    const result = asObjectSchema(gen.generateSchema(type, checker));
    expect(result.$ref).toBe("#/$defs/Node");
    const defs = result.$defs as Record<string, any>;
    expect(defs).toBeDefined();
    expect(defs.Node?.type).toBe("object");
    expect(defs.Node?.properties?.value?.type).toBe("number");
    const next = defs.Node?.properties?.next;
    expect(next?.$ref).toBe("#/$defs/Node");
  });

  it("nested recursive: children?: Node[]", async () => {
    const code = `
      interface Node { value: string; children?: Node[] }
    `;
    const { type, checker } = await getTypeFromCode(code, "Node");
    const s = asObjectSchema(
      new SchemaGenerator().generateSchema(type, checker),
    );
    expect(s.$ref).toBe("#/$defs/Node");
    const d = s.$defs as any;
    const node = d.Node;
    expect(node.properties?.children?.type).toBe("array");
    expect(node.properties?.children?.items?.$ref).toBe("#/$defs/Node");
  });

  it("multi-hop circular A -> B -> C -> A", async () => {
    const code = `
      interface A { b: B }
      interface B { c: C }
      interface C { a: A }
    `;
    const { type, checker } = await getTypeFromCode(code, "A");
    const s = asObjectSchema(
      new SchemaGenerator().generateSchema(type, checker),
    );
    expect(s.$ref).toBe("#/$defs/A");
    const defs = s.$defs as any;
    expect(defs.A?.properties?.b?.$ref).toBe("#/$defs/B");
    expect(defs.B?.properties?.c?.$ref).toBe("#/$defs/C");
    expect(defs.C?.properties?.a?.$ref).toBe("#/$defs/A");
  });

  it("mutually recursive A <-> B", async () => {
    const code = `
      interface A { b?: B }
      interface B { a?: A }
    `;
    const { type, checker } = await getTypeFromCode(code, "A");
    const s = asObjectSchema(
      new SchemaGenerator().generateSchema(type, checker),
    );
    expect(s.$ref).toBe("#/$defs/A");
    const defs = s.$defs as any;
    expect(defs.A?.properties?.b?.$ref).toBe("#/$defs/B");
    expect(defs.B?.properties?.a?.$ref).toBe("#/$defs/A");
  });

  it("reads an alias that instantiates itself without end to the nesting bound, and reports the rest unread", async () => {
    // Each `Nest<T[]>` is a new type, so no reading of it meets one in
    // progress. The nesting bound ends the reading at a level that accepts
    // any value, beside the `undefined` the optional member adds.

    const code = `
      type Nest<T> = { v: T; inner?: Nest<T[]> };
      interface Root { a: Nest<string> }
    `;
    const { type, checker } = await getTypeFromCode(code, "Root");
    const diagnostics: SchemaGenerationDiagnostic[] = [];
    const s = asObjectSchema(
      new SchemaGenerator().generateSchema(type, checker, undefined, {
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      }),
    );
    const values: unknown[] = [];
    let innermost: unknown;
    let level: Record<string, unknown> | undefined =
      (s.properties as Record<string, Record<string, unknown>>).a;
    while (level) {
      const properties = level.properties as Record<
        string,
        Record<string, unknown>
      >;
      values.push(properties.v);
      innermost = properties.inner;
      level = (properties.inner!.anyOf as Record<string, unknown>[]).find(
        (member) => member.type === "object",
      );
    }
    let expected: unknown = { type: "string" };
    const expectedValues = values.map(() => {
      const value = expected;
      expected = { type: "array", items: value };
      return value;
    });

    expect(values.length).toBeGreaterThan(1);
    expect(values).toEqual(expectedValues);
    expect(innermost).toEqual({ anyOf: [{}, { type: "undefined" }] });
    expect(diagnostics.map(({ severity, type }) => ({ severity, type })))
      .toEqual([{ severity: "warning", type: "schema-type:unread" }]);
  });

  it("reads an alias that instantiates itself without end at a type parameter no binding names to the declaration nesting bound, and reports the rest unread", async () => {
    // Read under no bindings, the recursion has no shape to bound it, and the
    // declarations it is inside do instead.

    const code = `
      type Nest<T> = { v: T; children: Nest<T[]>[] };
      interface Root<T> { a: Nest<T> }
    `;
    const { type, checker } = await getTypeFromCode(code, "Root");
    const diagnostics: SchemaGenerationDiagnostic[] = [];
    const s = asObjectSchema(
      new SchemaGenerator().generateSchema(type, checker, undefined, {
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      }),
    );
    const values: unknown[] = [];
    let innermost: unknown;
    let level: Record<string, unknown> | undefined =
      (s.properties as Record<string, Record<string, unknown>>).a;
    while (level) {
      const properties = level.properties as Record<
        string,
        Record<string, unknown>
      >;
      values.push(properties.v);
      innermost = properties.children;
      const items = properties.children!.items as Record<string, unknown>;
      level = items.properties ? items : undefined;
    }
    let expected: unknown = {};
    const expectedValues = values.map(() => {
      const value = expected;
      expected = { type: "array", items: value };
      return value;
    });

    expect(values.length).toBeGreaterThan(1);
    expect(values).toEqual(expectedValues);
    expect(innermost).toEqual({ type: "array", items: {} });
    expect(diagnostics.map(({ severity, type }) => ({ severity, type })))
      .toEqual([{ severity: "warning", type: "schema-type:unread" }]);
  });

  it("reads a recursion without end through three of an alias's members, under bindings, to a budget of readings in all, and reports the rest unread", async () => {
    // Each member reaches the nesting bound of its own shape along every
    // path, which is exponentially many readings. Every reading inside its
    // own shape spends one budget the whole schema shares instead.

    const code = `
      type Nest<T> = { v: T; a?: Nest<T[]>; b?: Nest<[T]>; c?: Nest<{ x: T }> };
      interface Root { n: Nest<string> }
    `;
    const { type, checker } = await getTypeFromCode(code, "Root");
    const diagnostics: SchemaGenerationDiagnostic[] = [];
    const s = new SchemaGenerator().generateSchema(type, checker, undefined, {
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    let levels = 0;
    const count = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(count);
      if (!node || typeof node !== "object") return;
      const properties = (node as { properties?: Record<string, unknown> })
        .properties;
      if (properties?.v) levels++;
      Object.values(node).forEach(count);
    };
    count(s);

    expect(levels).toBeGreaterThan(MAX_EXPANDING_READINGS);
    expect(levels).toBeLessThan(2 * MAX_EXPANDING_READINGS);
    expect(diagnostics.map(({ severity, type }) => ({ severity, type })))
      .toEqual([{ severity: "warning", type: "schema-type:unread" }]);
  });

  it("ends a recursion without end through two tuples an alias writes, at a type parameter no binding names, within the budget of readings, and reports the rest unread", async () => {
    // Read under no bindings, each branch reaches the declaration nesting
    // bound along every path, two to the power of the bound in all, unless
    // the budget ends them first.

    const code = `
      type Tup<T> = [T, Tup<T[]>?, Tup<[T]>?];
      interface Root<T> { n: Tup<T> }
    `;
    const { type, checker } = await getTypeFromCode(code, "Root");
    const diagnostics: SchemaGenerationDiagnostic[] = [];
    const s = new SchemaGenerator().generateSchema(type, checker, undefined, {
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    expect(JSON.stringify(s).length).toBeLessThan(
      100 * MAX_EXPANDING_READINGS,
    );
    expect(diagnostics.map(({ severity, type }) => ({ severity, type })))
      .toEqual([{ severity: "warning", type: "schema-type:unread" }]);
  });

  it("reads every level of a nesting of one declaration written out nine deep, at a type parameter no binding names", async () => {
    // A nesting written out is instantiated from the inside out, so its
    // deeper levels are the older, and the cut by the instantiations a
    // reading is within does not count them.

    const written = `${"Pair<".repeat(9)}T${">".repeat(9)}`;
    const code = `
      type Pair<T> = { v: T };
      interface Root<T> { a: ${written} }
    `;
    const { type, checker } = await getTypeFromCode(code, "Root");
    const diagnostics: SchemaGenerationDiagnostic[] = [];
    const s = asObjectSchema(
      new SchemaGenerator().generateSchema(type, checker, undefined, {
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      }),
    );
    let depth = 0;
    let level = (s.properties as Record<string, Record<string, unknown>>).a;
    while (level?.properties) {
      level = (level.properties as Record<string, Record<string, unknown>>).v;
      depth++;
    }

    expect(depth).toBe(9);
    expect(diagnostics).toEqual([]);
  });

  for (
    const [shape, declaration] of [
      [
        "a tuple",
        "type Chain<N extends unknown[]> = [number, N extends [unknown, ...infer R] ? Chain<R> : { end: string }];",
      ],
      [
        "an array",
        "type Chain<N extends unknown[]> = (N extends [unknown, ...infer R] ? Chain<R> : { end: string })[];",
      ],
    ] as const
  ) {
    it(`reads every level of a finite chain twelve long that recurses through ${shape} an alias writes`, async () => {
      // Each level is a newer instantiation of the alias, as in a recursion
      // without end, but the chain ends, and twelve levels are within the cut.

      const ones = Array.from({ length: 12 }, () => "1").join(", ");
      const code = `
        ${declaration}
        interface Root { a: Chain<[${ones}]> }
      `;
      const { type, checker } = await getTypeFromCode(code, "Root");
      const diagnostics: SchemaGenerationDiagnostic[] = [];
      const s = new SchemaGenerator().generateSchema(type, checker, undefined, {
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      });

      expect(JSON.stringify(s)).toContain('"end"');
      expect(diagnostics).toEqual([]);
    });
  }

  it("reads every level of a nesting written out nine deep under a mapped type, at a type parameter no binding names", async () => {
    // The mapped type is read as the type it maps over, and the nesting
    // inside it is written out.

    const written = `${"Pair<".repeat(9)}T${">".repeat(9)}`;
    const code = `
      type DeepReadonly<T> = { readonly [K in keyof T]: DeepReadonly<T[K]> };
      type Pair<T> = { v: T };
      interface Root<T> { a: DeepReadonly<${written}> }
    `;
    const { type, checker } = await getTypeFromCode(code, "Root");
    const diagnostics: SchemaGenerationDiagnostic[] = [];
    const s = asObjectSchema(
      new SchemaGenerator().generateSchema(type, checker, undefined, {
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      }),
    );
    let depth = 0;
    let level = (s.properties as Record<string, Record<string, unknown>>).a;
    while ((level?.properties as Record<string, unknown> | undefined)?.v) {
      level = (level!.properties as Record<string, Record<string, unknown>>).v;
      depth++;
    }

    expect(depth).toBe(9);
    expect(diagnostics).toEqual([]);
  });
});
