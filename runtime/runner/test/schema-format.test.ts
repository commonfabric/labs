import { assert, assertEquals } from "@std/assert";
import { schemaToTypeString } from "../src/schema-format.ts";

//
// Tests for schemaToTypeString - TypeScript-like schema representation
//

Deno.test("schemaToTypeString converts basic types", () => {
  assertEquals(schemaToTypeString({ type: "string" } as any), "string");
  assertEquals(schemaToTypeString({ type: "number" } as any), "number");
  assertEquals(schemaToTypeString({ type: "boolean" } as any), "boolean");
  assertEquals(schemaToTypeString({ type: "null" } as any), "null");
});

Deno.test("schemaToTypeString converts arrays", () => {
  const schema: any = {
    type: "array",
    items: { type: "string" },
  };
  assertEquals(schemaToTypeString(schema), "string[]");
});

Deno.test("schemaToTypeString converts type arrays to unions", () => {
  // The union formatter merges anyOf branches into type arrays; these used to
  // hit the String(type) fallback and render as "number,string"
  assertEquals(
    schemaToTypeString({ type: ["number", "string"] } as any),
    "number | string",
  );
  assertEquals(
    schemaToTypeString({ type: ["string", "null"] } as any),
    "string | null",
  );
  assertEquals(
    schemaToTypeString({ type: ["integer", "number"] } as any),
    "number",
  );
});

Deno.test("schemaToTypeString renders const literals like their enum twins", () => {
  // The generator's node path emits const where its type path emits a
  // single-value enum; both should render as the TS literal type
  assertEquals(
    schemaToTypeString({ type: "string", const: "x" } as any),
    '"x"',
  );
  assertEquals(schemaToTypeString({ type: "number", const: 42 } as any), "42");
  assertEquals(
    schemaToTypeString({ type: "string", enum: ["x"] } as any),
    '"x"',
  );
});

Deno.test("schemaToTypeString keeps the index-signature value type", () => {
  assertEquals(
    schemaToTypeString({
      type: "object",
      additionalProperties: { type: "number" },
    } as any),
    "Record<string, number>",
  );
  // Named properties alongside an index signature: TS cannot express
  // "every key except the named ones", so the rest claim renders as a
  // descriptive comment line (PR #4969 review, both rounds — the inline
  // index signature was invalid TS, and & Record<string, T> wrongly
  // constrained the named keys too).
  assertEquals(
    schemaToTypeString({
      type: "object",
      properties: { a: { type: "string" } },
      additionalProperties: { type: "number" },
    } as any),
    "{\n  a?: string,\n  // other keys: number\n}",
  );
  // A multiline value type stays fully commented — an uncommented
  // continuation line would read as outer-object syntax.
  assertEquals(
    schemaToTypeString({
      type: "object",
      properties: { a: { type: "string" } },
      additionalProperties: {
        type: "object",
        properties: { x: { type: "number" } },
      },
    } as any),
    "{\n  a?: string,\n  // other keys: {\n  //   x?: number\n  // }\n}",
  );
  // Bare additionalProperties: true stays as before
  assertEquals(
    schemaToTypeString({ type: "object", additionalProperties: true } as any),
    "Record<string, unknown>",
  );
});

Deno.test("schemaToTypeString converts tuples (prefixItems)", () => {
  // CT-1895: tuples used to render as "unknown[]"
  const schema: any = {
    type: "array",
    prefixItems: [
      { type: "string" },
      { type: "object", properties: { x: { type: "number" } } },
    ],
  };
  assertEquals(
    schemaToTypeString(schema),
    "[string, {\n  x?: number\n}, ...unknown[]]",
  );
});

Deno.test("schemaToTypeString renders items alongside prefixItems as a rest element", () => {
  const schema: any = {
    type: "array",
    prefixItems: [{ type: "string" }, { type: "number" }],
    items: { type: "boolean" },
  };
  assertEquals(schemaToTypeString(schema), "[string, number, ...boolean[]]");
});

Deno.test("schemaToTypeString closes the tuple only for items: false", () => {
  assertEquals(
    schemaToTypeString({
      type: "array",
      prefixItems: [{ type: "string" }],
      items: false,
    } as any),
    "[string]",
  );
});

Deno.test("schemaToTypeString parenthesizes union rest elements", () => {
  // PR #4969 review: `...number | string[]` means something else entirely.
  assertEquals(
    schemaToTypeString({
      type: "array",
      prefixItems: [{ type: "string" }],
      items: { type: ["number", "string"] },
    } as any),
    "[string, ...(number | string)[]]",
  );
});

Deno.test("schemaToTypeString parenthesizes function types in array elements", () => {
  // PR #4969 review round 2: `...({...}) => void[]` and `{...} => void[]`
  // are invalid/mean something else; function elements need grouping in
  // both rest and ordinary arrays.
  const streamItems = {
    asCell: ["stream"],
    properties: { value: { type: "string" } },
  };
  assertEquals(
    schemaToTypeString({
      type: "array",
      prefixItems: [{ type: "string" }],
      items: streamItems,
    } as any),
    "[string, ...(({\n  value?: string\n}) => void)[]]",
  );
  assertEquals(
    schemaToTypeString({
      type: "array",
      items: streamItems,
    } as any),
    "(({\n  value?: string\n}) => void)[]",
  );
});

Deno.test("schemaToTypeString escapes string literals and renders JSON constants", () => {
  // PR #4969 review: `"a"b"` was emitted for a legal string constant, and
  // object/array constants rendered as "[object Object]".
  assertEquals(
    schemaToTypeString({ type: "string", const: 'a"b' } as any),
    '"a\\"b"',
  );
  assertEquals(
    schemaToTypeString({ const: { kind: "point" } } as any),
    '{"kind":"point"}',
  );
  assertEquals(
    schemaToTypeString({ enum: ["a", ["b"]] } as any),
    '"a" | ["b"]',
  );
});

Deno.test("schemaToTypeString survives recursive $defs", () => {
  // PR #4969 review: ref hops recursed before the depth cap, so a ref
  // cycle overflowed the stack (reachable from CLI --help).
  const defs: any = { A: { $ref: "#/$defs/A" } };
  assertEquals(schemaToTypeString({ $ref: "#/$defs/A" } as any, { defs }), "A");
  const mutual: any = {
    A: { $ref: "#/$defs/B" },
    B: { $ref: "#/$defs/A" },
  };
  assertEquals(
    schemaToTypeString({ $ref: "#/$defs/A" } as any, { defs: mutual }),
    "A",
  );
});

Deno.test("schemaToTypeString renders type arrays at the depth cap", () => {
  assertEquals(
    schemaToTypeString({ type: ["string", "null"] } as any, { maxDepth: 0 }),
    "string | null",
  );
});

Deno.test("schemaToTypeString abbreviates tuples at max depth", () => {
  const schema: any = {
    type: "object",
    properties: {
      pair: { type: "array", prefixItems: [{ type: "string" }] },
    },
  };
  const result = schemaToTypeString(schema, { maxDepth: 1 });
  assert(result.includes("pair?: [...]"));
});

Deno.test("schemaToTypeString converts objects with properties", () => {
  const schema: any = {
    type: "object",
    properties: {
      name: { type: "string" },
      age: { type: "number" },
    },
  };
  const result = schemaToTypeString(schema);
  assert(result.includes("name?:"));
  assert(result.includes("string"));
  assert(result.includes("age?:"));
  assert(result.includes("number"));
});

Deno.test("schemaToTypeString marks required fields without ?", () => {
  const schema: any = {
    type: "object",
    properties: {
      name: { type: "string" },
      age: { type: "number" },
    },
    required: ["name"],
  };
  const result = schemaToTypeString(schema);
  assert(result.includes("name:"), "required field should not have ?");
  assert(result.includes("age?:"), "optional field should have ?");
});

Deno.test("schemaToTypeString converts Stream to function syntax", () => {
  const schema: any = {
    type: "object",
    asCell: ["stream"],
    properties: {
      value: { type: "string" },
    },
  };
  const result = schemaToTypeString(schema);
  assert(result.includes("=>"), "Stream should use arrow function syntax");
  assert(result.includes("void"), "Stream should return void");
  assert(result.includes("value"), "Stream props should be included");
});

Deno.test("schemaToTypeString converts Cell to Cell<T> syntax", () => {
  const schema: any = {
    type: "object",
    asCell: ["cell"],
    properties: {
      count: { type: "number" },
    },
  };
  const result = schemaToTypeString(schema);
  assert(result.startsWith("Cell<"), "Cell should use Cell<> syntax");
  assert(result.includes("count"), "Cell contents should be included");
});

Deno.test("schemaToTypeString converts opaque cells to FactoryInput", () => {
  assertEquals(
    schemaToTypeString({
      type: "string",
      asCell: ["opaque"],
    } as any),
    "FactoryInput",
  );
});

Deno.test('schemaToTypeString formats asCell: ["stream", "cell"] as Stream<Cell<T>>', () => {
  const schema: any = {
    type: "number",
    asCell: ["stream", "cell"],
  };

  const result = schemaToTypeString(schema);
  assertEquals(result, "(Cell<number>) => void");
});

Deno.test("schemaToTypeString names a sqlite handle SqliteDb", () => {
  // The shape a pattern's argument schema carries at a `SqliteDb` position:
  // the brand hoisted into `$defs` under its own name, with the sqlite cell
  // kind beside the reference to it.
  assertEquals(
    schemaToTypeString({
      type: "object",
      properties: {
        bank: { $ref: "#/$defs/SqliteDatabase", asCell: ["sqlite"] },
      },
      required: ["bank"],
      $defs: {
        SqliteDatabase: {
          type: "object",
          properties: {
            id: { type: "string" },
            tables: { type: "object", additionalProperties: true },
            rev: { type: "number" },
          },
          additionalProperties: true,
        },
      },
    } as any),
    "{\n  bank: SqliteDb\n}",
  );
});

Deno.test("schemaToTypeString names a sqlite handle at the depth cap", () => {
  assertEquals(
    schemaToTypeString({ type: "object", asCell: ["sqlite"] } as any, {
      depth: 9,
      maxDepth: 4,
    }),
    "SqliteDb",
  );
});

Deno.test("schemaToTypeString scopes a sqlite handle from its own entry", () => {
  assertEquals(
    schemaToTypeString({
      type: "object",
      asCell: [{ kind: "sqlite", scope: "user" }],
    } as any),
    "PerUser<SqliteDb>",
  );
});

Deno.test("schemaToTypeString restores scope wrappers", () => {
  assertEquals(
    schemaToTypeString({
      type: "string",
      scope: "user",
    } as any),
    "PerUser<string>",
  );
  assertEquals(
    schemaToTypeString({
      type: "string",
      scope: "any",
    } as any),
    "PerAny<string>",
  );
  assertEquals(
    schemaToTypeString({
      type: "string",
      asCell: [{ kind: "cell", scope: "session" }],
    } as any),
    "PerSession<Cell<string>>",
  );
});

Deno.test("schemaToTypeString handles enums as union literals", () => {
  const schema: any = {
    enum: ["open", "closed", "pending"],
  };
  const result = schemaToTypeString(schema);
  assertEquals(result, '"open" | "closed" | "pending"');
});

Deno.test("schemaToTypeString resolves $ref from $defs", () => {
  const schema: any = {
    $ref: "#/$defs/MyType",
  };
  const defs: any = {
    MyType: { type: "string" },
  };
  const result = schemaToTypeString(schema, { defs });
  assertEquals(result, "string");
});

Deno.test("schemaToTypeString uses type name for large $ref definitions", () => {
  const schema: any = {
    $ref: "#/$defs/LargeType",
  };
  const defs: any = {
    LargeType: {
      type: "object",
      properties: {
        field1: { type: "string" },
        field2: { type: "number" },
        field3: { type: "boolean" },
        field4: { type: "string" },
        field5: { type: "number" },
      },
    },
  };
  const result = schemaToTypeString(schema, { defs });
  assertEquals(result, "LargeType");
});

Deno.test("schemaToTypeString skips $-prefixed properties", () => {
  const schema: any = {
    type: "object",
    properties: {
      $UI: { type: "object" },
      $TYPE: { type: "string" },
      name: { type: "string" },
    },
  };
  const result = schemaToTypeString(schema);
  assert(!result.includes("$UI"), "$UI should be skipped");
  assert(!result.includes("$TYPE"), "$TYPE should be skipped");
  assert(result.includes("name"), "regular props should be included");
});

Deno.test("schemaToTypeString handles anyOf as union", () => {
  const schema: any = {
    anyOf: [{ type: "string" }, { type: "number" }],
  };
  const result = schemaToTypeString(schema);
  assertEquals(result, "string | number");
});

Deno.test("schemaToTypeString limits recursion depth", () => {
  const deepSchema: any = {
    type: "object",
    properties: {
      a: {
        type: "object",
        properties: {
          b: {
            type: "object",
            properties: {
              c: {
                type: "object",
                properties: {
                  d: { type: "string" },
                },
              },
            },
          },
        },
      },
    },
  };
  const result = schemaToTypeString(deepSchema, { maxDepth: 3 });
  assert(result.includes("{...}"), "Deep nesting should be abbreviated");
});

Deno.test("schemaToTypeString produces compact output for complex schema", () => {
  // This is the example from the user's request
  const schema: any = {
    type: "object",
    properties: {
      test: { type: "string" },
      count: { type: "number" },
      person: {
        type: "object",
        properties: {
          name: { type: "string" },
          email: { type: "string" },
        },
      },
      doAnAction: {
        type: "object",
        asCell: ["stream"],
        properties: {
          parameter: { type: "number" },
        },
      },
      aCell: {
        type: "object",
        asCell: ["cell"],
        properties: {
          subfield: { type: "string" },
        },
      },
    },
  };
  const result = schemaToTypeString(schema);

  // Check key features of the output
  assert(result.includes("test?:"), "should have test property");
  assert(result.includes("string"), "should have string type");
  assert(result.includes("count?:"), "should have count property");
  assert(result.includes("number"), "should have number type");
  assert(result.includes("person?:"), "should have person property");
  assert(result.includes("doAnAction?:"), "should have doAnAction property");
  assert(result.includes("=> void"), "doAnAction should be a handler");
  assert(result.includes("aCell?:"), "should have aCell property");
  assert(result.includes("Cell<"), "aCell should use Cell wrapper");
});

Deno.test("schemaToTypeString converts PatternToolResult to function syntax", () => {
  // PatternToolResult<{ content: string }> schema
  const schema: any = {
    type: "object",
    properties: {
      pattern: {
        type: "object",
        additionalProperties: true,
      },
      extraParams: {
        type: "object",
        properties: {
          content: { type: "string" },
        },
      },
    },
  };
  const result = schemaToTypeString(schema);
  // Should format as a handler function, not as an object with pattern/extraParams
  assert(
    result.includes("=>"),
    "PatternToolResult should use arrow function syntax",
  );
  assert(result.includes("void"), "PatternToolResult should return void");
  assert(result.includes("content"), "extraParams content should be included");
  assert(!result.includes("pattern"), "pattern property should not be visible");
  assert(
    !result.includes("extraParams"),
    "extraParams key should not be visible",
  );
});

Deno.test("schemaToTypeString handles nested PatternToolResult in object", () => {
  // Schema for a piece output with handler properties
  const schema: any = {
    type: "object",
    properties: {
      name: { type: "string" },
      grep: {
        type: "object",
        properties: {
          pattern: { type: "object" },
          extraParams: {
            type: "object",
            properties: {
              content: { type: "string" },
            },
          },
        },
      },
      translate: {
        type: "object",
        properties: {
          pattern: { type: "object" },
          extraParams: {
            type: "object",
            properties: {
              content: { type: "string" },
            },
          },
        },
      },
    },
  };
  const result = schemaToTypeString(schema);

  // Both grep and translate should be formatted as handlers
  assert(
    (result.match(/=>/g) || []).length >= 2,
    "both grep and translate should be handlers",
  );
  assert(result.includes("grep?:"), "should have grep property");
  assert(result.includes("translate?:"), "should have translate property");
  assert(result.includes("void"), "handlers should return void");
});

Deno.test("schemaToTypeString formats fixture-style PatternToolResult without leaking internals", () => {
  const schema: any = {
    type: "object",
    properties: {
      search: {
        type: "object",
        properties: {
          pattern: {
            type: "object",
            properties: {
              argumentSchema: {
                type: "object",
                properties: {
                  query: { type: "string" },
                  help: { type: "string" },
                  source: { type: "string" },
                },
              },
              resultSchema: {
                type: "object",
                properties: {
                  summary: { type: "string" },
                },
              },
              nodes: { type: "array", items: { type: "object" } },
            },
            asCell: ["cell"],
          },
          extraParams: {
            type: "object",
            properties: {
              source: { type: "string" },
            },
          },
        },
      },
    },
  };

  const result = schemaToTypeString(schema);

  assert(result.includes("search?:"), "should include the tool key");
  assert(result.includes("source"), "should describe the bound extraParams");
  assert(!/\bpattern\??:/.test(result), "pattern internals should stay hidden");
  assert(
    !/\bextraParams\??:/.test(result),
    "extraParams internals should stay hidden",
  );
});

//
// A conjunction states its fields across its members. These pin that the
// rendering merges them the way the CLI's reader does, so a help page's type
// block and its flag list cannot disagree about the same schema.
//

Deno.test("schemaToTypeString renders a conjunction's fields alongside its own", () => {
  assertEquals(
    schemaToTypeString({
      type: "object",
      properties: { note: { type: "string" } },
      allOf: [{ type: "object", properties: { count: { type: "number" } } }],
    } as never),
    "{\n  note?: string,\n  count?: number\n}",
  );
});

Deno.test("schemaToTypeString renders fields a schema declares only through allOf", () => {
  // No `type` and no `properties` of its own, so this reaches the object
  // branch only because the conjunction was gathered before it was chosen.
  assertEquals(
    schemaToTypeString({
      allOf: [{ type: "object", properties: { count: { type: "number" } } }],
    } as never),
    "{\n  count?: number\n}",
  );
});

Deno.test("schemaToTypeString requires a field any conjunct requires", () => {
  // Required is a union across members, not first-wins: every member's
  // constraint holds at once.
  assertEquals(
    schemaToTypeString({
      type: "object",
      properties: { a: { type: "string" } },
      allOf: [{ properties: { b: { type: "number" } }, required: ["b"] }],
    } as never),
    "{\n  a?: string,\n  b: number\n}",
  );
});

Deno.test("schemaToTypeString keeps the first declaration of a repeated field", () => {
  assertEquals(
    schemaToTypeString({
      type: "object",
      properties: { a: { type: "string" } },
      allOf: [{ properties: { a: { type: "number" } } }],
    } as never),
    "{\n  a?: string\n}",
  );
});

Deno.test("schemaToTypeString resolves a $defs reference inside a conjunction", () => {
  assertEquals(
    schemaToTypeString(
      {
        type: "object",
        properties: { a: { type: "string" } },
        allOf: [{ $ref: "#/$defs/B" }],
      } as never,
      {
        defs: {
          B: { type: "object", properties: { b: { type: "number" } } },
        } as never,
      },
    ),
    "{\n  a?: string,\n  b?: number\n}",
  );
});

Deno.test("schemaToTypeString terminates on a conjunction that references itself", () => {
  assertEquals(
    schemaToTypeString(
      {
        type: "object",
        properties: { a: { type: "string" } },
        allOf: [{ $ref: "#/$defs/C" }],
      } as never,
      {
        defs: {
          C: {
            type: "object",
            properties: { c: { type: "number" } },
            allOf: [{ $ref: "#/$defs/C" }],
          },
        } as never,
      },
    ),
    "{\n  a?: string,\n  c?: number\n}",
  );
});

Deno.test("schemaToTypeString leaves a disjunction a union", () => {
  // Only a conjunction states fields that all hold at once; `anyOf` is a
  // union and keeps rendering as one.
  assertEquals(
    schemaToTypeString({
      anyOf: [{ type: "string" }, { type: "number" }],
    } as never),
    "string | number",
  );
});

Deno.test("schemaToTypeString does not make an object of a scalar conjunction", () => {
  // `allOf: [{type: "string"}]` constrains a scalar and contributes no field.
  // Rendering it as `{}` would invent an object the schema never described.
  assertEquals(
    schemaToTypeString({ allOf: [{ type: "string" }] } as never),
    "unknown",
  );
});

Deno.test("schemaToTypeString steps over a conjunct that is not a schema", () => {
  // `allOf` is caller data and can hold anything. A member that is not an
  // object contributes no field rather than ending the walk, so the members
  // beside it are still read.
  assertEquals(
    schemaToTypeString({
      allOf: [null, "nope", { properties: { a: { type: "string" } } }],
    } as never),
    "{\n  a?: string\n}",
  );
});

Deno.test("schemaToTypeString steps over a conjunct naming a definition that is absent", () => {
  assertEquals(
    schemaToTypeString(
      {
        type: "object",
        properties: { a: { type: "string" } },
        allOf: [{ $ref: "#/$defs/Missing" }],
      } as never,
      { defs: {} as never },
    ),
    "{\n  a?: string\n}",
  );
});

Deno.test("schemaToTypeString stops following a conjunction past its depth bound", () => {
  // Nested `allOf` is followed 8 levels. The 10th level's field is beyond the
  // bound and does not appear; the levels within it still do. The bound is
  // what keeps a pathological schema from walking forever.
  let deepest: Record<string, unknown> = {
    properties: { level10: { type: "string" } },
  };
  for (let level = 9; level >= 1; level--) {
    deepest = {
      properties: { [`level${level}`]: { type: "string" } },
      allOf: [deepest],
    };
  }
  const rendered = schemaToTypeString(deepest as never, { maxDepth: 99 });
  assert(rendered.includes("level1"), "the outermost level is read");
  assert(rendered.includes("level8"), "the level at the bound is read");
  assert(!rendered.includes("level10"), "the level past the bound is not");
});

Deno.test("schemaToTypeString follows a definition that aliases another", () => {
  // A definition may be an alias for a second one. Stopping after a single hop
  // would collect the alias, which states no field, instead of what it names.
  assertEquals(
    schemaToTypeString(
      {
        type: "object",
        properties: { a: { type: "string" } },
        allOf: [{ $ref: "#/$defs/Alias" }],
      } as never,
      {
        defs: {
          Alias: { $ref: "#/$defs/Real" },
          Real: { type: "object", properties: { b: { type: "number" } } },
        } as never,
      },
    ),
    "{\n  a?: string,\n  b?: number\n}",
  );
});

Deno.test("schemaToTypeString terminates on a definition that aliases itself", () => {
  // The chain above has to end somewhere. A definition naming itself is the
  // shortest loop there is.
  assertEquals(
    schemaToTypeString(
      {
        type: "object",
        properties: { a: { type: "string" } },
        allOf: [{ $ref: "#/$defs/S" }],
      } as never,
      { defs: { S: { $ref: "#/$defs/S" } } as never },
    ),
    "{\n  a?: string\n}",
  );
});

Deno.test("schemaToTypeString renders an object conjunct that names no field", () => {
  // `type: "object"` makes the whole an object even with nothing named, and
  // `{}` is what that is. A scalar conjunct is the contrasting case below.
  assertEquals(
    schemaToTypeString({ allOf: [{ type: "object" }] } as never),
    "{}",
  );
});
