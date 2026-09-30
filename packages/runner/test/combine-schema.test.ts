import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { combineSchema, combineSchemaForLink } from "../src/traverse.ts";
import {
  resetReaderSchemaPrecedenceConfig,
  setReaderSchemaPrecedenceConfig,
} from "../src/reader-schema-precedence-config.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import { externalizeSchema } from "../src/link-utils.ts";

describe("combineSchema type handling", () => {
  const disjointCases: readonly {
    name: string;
    a: JSONSchema;
    b: JSONSchema;
  }[] = [
    {
      name: "disjoint primitive types",
      a: { type: "string" },
      b: { type: "number" },
    },
    {
      name: "a type union with no shared member is false",
      a: { type: ["string", "number"] },
      b: { type: "boolean" },
    },
    {
      name: "disjoint structural types",
      a: { type: "object" },
      b: { type: "array" },
    },
    {
      name: "undefined and object are disjoint",
      a: { type: "undefined" },
      b: {
        type: "object",
        properties: { value: { type: "string" } },
      },
    },
    {
      name: "integer and string are disjoint",
      a: { type: "integer" },
      b: { type: "string" },
    },
    {
      name: "a `FabricPrimitive` type and string are disjoint",
      a: { type: "FabricBytes" },
      b: { type: "string" },
    },
    {
      name: "two different `FabricPrimitive` types are disjoint",
      a: { type: "FabricBytes" },
      b: { type: "FabricHash" },
    },
    {
      name: "a `FabricPrimitive` type and array are disjoint",
      a: { type: "FabricRegExp" },
      b: { type: "array" },
    },
  ];
  const directions = [
    { name: "a is the parent", combine: combineSchema },
    {
      name: "b is the parent",
      combine: (a: JSONSchema, b: JSONSchema) => combineSchema(b, a),
    },
  ] as const;

  for (const testCase of disjointCases) {
    for (const direction of directions) {
      it(`${testCase.name} when ${direction.name}`, () => {
        expect(direction.combine(testCase.a, testCase.b)).toBe(false);
      });
    }
  }

  const compatibleCases: readonly {
    name: string;
    a: JSONSchema;
    b: JSONSchema;
  }[] = [
    {
      name: "a type union can overlap one member",
      a: { type: ["string", "number"] },
      b: { type: "number" },
    },
    {
      name: "unknown can overlap another type",
      a: { type: "unknown" },
      b: { type: "string" },
    },
    {
      name: "a union containing unknown can overlap another type",
      a: { type: ["unknown", "string"] },
      b: { type: "boolean" },
    },
  ];

  for (const testCase of compatibleCases) {
    it(`${testCase.name} while retaining parent precedence`, () => {
      expect(combineSchema(testCase.a, testCase.b)).toEqual(testCase.a);
      expect(combineSchema(testCase.b, testCase.a)).toEqual(testCase.b);
    });
  }

  const numberIntegerCases = [
    {
      name: "scalar number and integer",
      a: { type: "number" },
      b: { type: "integer" },
      expectedType: "integer",
    },
    {
      name: "type arrays with only a number/integer overlap",
      a: { type: ["string", "number"] },
      b: { type: ["boolean", "integer"] },
      expectedType: "integer",
    },
    {
      name: "type arrays with exact and number/integer overlaps",
      a: { type: ["string", "number"] },
      b: { type: ["integer", "string"] },
      expectedType: ["integer", "string"],
    },
  ] as const;

  for (const testCase of numberIntegerCases) {
    it(`${testCase.name} narrows number to integer in either direction`, () => {
      expect(combineSchema(testCase.a, testCase.b)).toEqual({
        type: testCase.expectedType,
      });
      expect(combineSchema(testCase.b, testCase.a)).toEqual({
        type: testCase.expectedType,
      });
    });
  }

  // Each `FabricPrimitive` type is a subtype of "object" (mirroring
  // integer under number), so the intersection keeps the narrower member.
  const fabricObjectCases = [
    {
      name: "object and a `FabricPrimitive` type",
      a: { type: "object" },
      b: { type: "FabricBytes" },
      expectedType: "FabricBytes",
    },
    {
      name: "type arrays with only an object/`FabricPrimitive` overlap",
      a: { type: ["string", "object"] },
      b: { type: ["boolean", "FabricEpochNsec"] },
      expectedType: "FabricEpochNsec",
    },
  ] as const;

  for (const testCase of fabricObjectCases) {
    it(`${testCase.name} narrows object to the \`FabricPrimitive\` type in either direction`, () => {
      expect(combineSchema(testCase.a, testCase.b)).toEqual({
        type: testCase.expectedType,
      });
      expect(combineSchema(testCase.b, testCase.a)).toEqual({
        type: testCase.expectedType,
      });
    });
  }
});

describe("combineSchema false handling", () => {
  const falseSchemas = [
    { name: "boolean false", schema: false },
    { name: "object false schema", schema: { not: true } },
  ] as const satisfies readonly { name: string; schema: JSONSchema }[];
  const constrainedSchema = { type: "number" } as const satisfies JSONSchema;
  const directions = [
    {
      name: "false schema is the parent",
      combine: (falseSchema: JSONSchema) =>
        combineSchema(falseSchema, constrainedSchema),
    },
    {
      name: "false schema is the link",
      combine: (falseSchema: JSONSchema) =>
        combineSchema(constrainedSchema, falseSchema),
    },
  ] as const;

  for (const testCase of falseSchemas) {
    for (const direction of directions) {
      it(`${testCase.name} absorbs the other schema when the ${direction.name}`, () => {
        expect(direction.combine(testCase.schema)).toEqual(testCase.schema);
      });
    }
  }
});

describe("combineSchema required handling", () => {
  const cases = [
    {
      name: "disjoint required properties",
      parentRequired: ["parentOnly"],
      linkRequired: ["linkOnly"],
      expected: ["parentOnly", "linkOnly"],
      expectedReversed: ["linkOnly", "parentOnly"],
    },
    {
      name: "overlapping required properties",
      parentRequired: ["parentOnly", "shared"],
      linkRequired: ["shared", "linkOnly"],
      expected: ["parentOnly", "shared", "linkOnly"],
      expectedReversed: ["shared", "linkOnly", "parentOnly"],
    },
    {
      name: "required properties on only one side",
      parentRequired: ["parentOnly"],
      linkRequired: undefined,
      expected: ["parentOnly"],
      expectedReversed: ["parentOnly"],
    },
  ] as const;

  for (const testCase of cases) {
    for (const reverse of [false, true]) {
      const direction = reverse ? "link is the parent" : "parent stays first";
      it(`${testCase.name} when the ${direction}`, () => {
        const parent = {
          type: "object",
          properties: {
            shared: { type: "string" },
            parentOnly: { type: "string" },
          },
          ...(testCase.parentRequired !== undefined && {
            required: testCase.parentRequired,
          }),
        } as const satisfies JSONSchema;
        const link = {
          type: "object",
          properties: {
            shared: { type: "string" },
            linkOnly: { type: "string" },
          },
          ...(testCase.linkRequired !== undefined && {
            required: testCase.linkRequired,
          }),
        } as const satisfies JSONSchema;

        const merged = (reverse
          ? combineSchema(link, parent)
          : combineSchema(parent, link)) as { required?: readonly string[] };
        const expected = reverse
          ? testCase.expectedReversed
          : testCase.expected;
        expect(merged.required).toEqual(expected);
      });
    }
  }
});

describe("combineSchema array handling", () => {
  const a = {
    type: "array",
    title: "a title",
    description: "a description",
    minItems: 1,
    items: { type: "string" },
    $defs: {
      aOnly: { type: "string" },
      shared: { const: "a" },
    },
  } as const satisfies JSONSchema;
  const b = {
    type: "array",
    title: "b title",
    description: "b description",
    maxItems: 4,
    items: { type: "string" },
    $defs: {
      bOnly: { type: "number" },
      shared: { const: "b" },
    },
  } as const satisfies JSONSchema;

  const directions = [
    {
      name: "a is the parent",
      parent: a,
      link: b,
      parentTitle: "a title",
      parentDescription: "a description",
      parentSharedDef: { const: "a" },
    },
    {
      name: "b is the parent",
      parent: b,
      link: a,
      parentTitle: "b title",
      parentDescription: "b description",
      parentSharedDef: { const: "b" },
    },
  ] as const;

  for (const direction of directions) {
    it(`keeps parent metadata and merges definitions when ${direction.name}`, () => {
      const merged = combineSchema(direction.parent, direction.link);
      expect(merged).not.toHaveProperty("prefixItems");
      expect(merged).toMatchObject({
        type: "array",
        title: direction.parentTitle,
        description: direction.parentDescription,
        minItems: 1,
        maxItems: 4,
        items: { type: "string" },
        $defs: {
          aOnly: { type: "string" },
          bOnly: { type: "number" },
          shared: direction.parentSharedDef,
        },
      });
    });
  }

  const withoutItems = {
    type: "array",
    title: "without items",
  } as const satisfies JSONSchema;
  const withItems = {
    type: "array",
    title: "with items",
    items: { type: "number" },
  } as const satisfies JSONSchema;

  for (
    const direction of [
      { parent: withoutItems, link: withItems },
      { parent: withItems, link: withoutItems },
    ] as const
  ) {
    it(`uses the available items schema while ${direction.parent.title} is the parent`, () => {
      expect(combineSchema(direction.parent, direction.link)).toMatchObject({
        title: direction.parent.title,
        items: { type: "number" },
      });
    });
  }

  const shortTuple = {
    type: "array",
    prefixItems: [{ type: "number" }],
    items: { type: "string" },
  } as const satisfies JSONSchema;
  const longTuple = {
    type: "array",
    prefixItems: [
      { type: "integer" },
      { type: "string" },
      { type: "boolean" },
    ],
    items: { type: "boolean" },
  } as const satisfies JSONSchema;

  for (
    const direction of [
      {
        name: "short tuple is the parent",
        parent: shortTuple,
        link: longTuple,
      },
      { name: "long tuple is the parent", parent: longTuple, link: shortTuple },
    ] as const
  ) {
    it(`combines prefix items and falls back to items when the ${direction.name}`, () => {
      expect(combineSchema(direction.parent, direction.link)).toEqual({
        type: "array",
        prefixItems: [
          { type: "integer" },
          { type: "string" },
          false,
        ],
        items: false,
      });
    });
  }

  it("uses the available prefix item when the other array has no items schema", () => {
    expect(
      combineSchema(
        { type: "array" },
        {
          type: "array",
          prefixItems: [{ type: "string" }],
        },
      ),
    ).toEqual({
      type: "array",
      prefixItems: [{ type: "string" }],
    });
  });

  it("omits prefixItems when the merged prefix would be empty", () => {
    expect(
      combineSchema(
        { type: "array", prefixItems: [] },
        { type: "array" },
      ),
    ).toEqual({
      type: "array",
    });
  });
});

describe("combineSchema additionalProperties handling", () => {
  // combineSchema builds the pseudo-intersection of the schema a doc was
  // entered with and a schema found on a link inside it. For object schemas,
  // keys defined on only ONE side intersect against the other side's
  // additionalProperties — where JSON Schema's "absent additionalProperties"
  // means UNCONSTRAINED, not `false`. The regression pinned here: absent
  // additionalProperties alongside defined properties used to be coerced to
  // `false`, silently blocking the other side's keys exactly as if the author
  // had written an explicitly closed object.

  const schemaWithOneSidedProperty = {
    type: "object",
    properties: {
      shared: { type: "string" },
      oneSided: { type: "number", asCell: ["cell"] },
    },
  } as const satisfies JSONSchema;

  const additionalPropertiesCases: readonly {
    name: string;
    additionalProperties: JSONSchema | undefined;
    expectedOneSidedProperty: JSONSchema;
  }[] = [
    {
      name: "absent additionalProperties is unconstrained",
      additionalProperties: undefined,
      expectedOneSidedProperty: {
        type: "number",
        asCell: ["cell"],
      },
    },
    {
      name: "additionalProperties true is unconstrained",
      additionalProperties: true,
      expectedOneSidedProperty: {
        type: "number",
        asCell: ["cell"],
      },
    },
    {
      name: "additionalProperties false blocks the key",
      additionalProperties: false,
      expectedOneSidedProperty: false,
    },
    {
      name: "an additionalProperties schema intersects with the key",
      additionalProperties: { type: "number" },
      expectedOneSidedProperty: {
        type: "number",
        asCell: ["cell"],
      },
    },
  ];

  const directions = [
    {
      name: "schema with the one-sided key is the parent",
      combine: (otherSchema: JSONSchema) =>
        combineSchema(schemaWithOneSidedProperty, otherSchema),
    },
    {
      name: "schema with the one-sided key is the link",
      combine: (otherSchema: JSONSchema) =>
        combineSchema(otherSchema, schemaWithOneSidedProperty),
    },
  ] as const;

  for (const testCase of additionalPropertiesCases) {
    for (const direction of directions) {
      it(`${testCase.name} when the ${direction.name}`, () => {
        const otherSchema = {
          type: "object",
          properties: { shared: { type: "string" } },
          ...(testCase.additionalProperties !== undefined && {
            additionalProperties: testCase.additionalProperties,
          }),
        } satisfies JSONSchema;

        const merged = direction.combine(otherSchema) as {
          properties: Record<string, unknown>;
        };

        expect(merged.properties.shared).toEqual({ type: "string" });
        expect(merged.properties.oneSided).toEqual(
          testCase.expectedOneSidedProperty,
        );
      });
    }
  }

  for (const direction of directions) {
    it(`a property-less side stays permissive when the ${direction.name}`, () => {
      const anything = { type: "object" } as const satisfies JSONSchema;
      const merged = direction.combine(anything) as {
        properties: Record<string, unknown>;
      };

      expect(merged.properties).toEqual(
        schemaWithOneSidedProperty.properties,
      );
    });
  }

  it("keeps the first side's additionalProperties across a property-less permissive second side", () => {
    const constrained = {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: { type: "string" },
    } as const satisfies JSONSchema;
    const permissive = {
      type: "object",
      additionalProperties: true,
      required: ["extra"],
    } as const satisfies JSONSchema;

    expect(combineSchema(constrained, permissive)).toEqual({
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name", "extra"],
      additionalProperties: { type: "string" },
    });
  });

  it("drops a property-less permissive second side against a first side without additionalProperties", () => {
    const constrained = {
      type: "object",
      properties: { name: { type: "string" } },
    } as const satisfies JSONSchema;
    const permissive = {
      type: "object",
      additionalProperties: true,
    } as const satisfies JSONSchema;

    expect(combineSchema(constrained, permissive)).toEqual(constrained);
  });
});

describe("combineSchemaForLink reader precedence", () => {
  // combineSchemaForLink decides the schema a traversal continues with after
  // crossing a link. The reader's schema takes precedence: a link routinely
  // describes more of its target than the reader asked for, and none of that —
  // extra properties, extra required entries, a different shape — reaches the
  // combined schema. The link schema is adopted only where the reader is
  // agnostic: a true or empty reader takes the link schema (keeping its own
  // asCell wrapper), and a false reader stays false, so a link's false schema
  // attenuates only readers that brought no shape of their own.

  const readerSchema = {
    type: "object",
    properties: { name: { type: "string" } },
    required: ["name"],
  } as const satisfies JSONSchema;
  const linkContactSchema = {
    type: "object",
    properties: {
      name: { type: "string" },
      phoneNumber: { type: "string" },
    },
    required: ["name", "phoneNumber"],
  } as const satisfies JSONSchema;

  it("returns a shaped reader's schema over a link naming and requiring more", () => {
    expect(combineSchemaForLink(readerSchema, linkContactSchema)).toEqual({
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    });
  });

  it("leaves combineSchema's strict union untouched for the same schemas", () => {
    expect(combineSchema(readerSchema, linkContactSchema)).toEqual({
      type: "object",
      properties: {
        name: { type: "string" },
        phoneNumber: { type: "string" },
      },
      required: ["name", "phoneNumber"],
    });
  });

  it("returns the reader's schema even when it admits extra keys", () => {
    const openReader = {
      ...readerSchema,
      additionalProperties: true,
    } as const satisfies JSONSchema;

    expect(combineSchemaForLink(openReader, linkContactSchema)).toEqual(
      openReader,
    );
  });

  it("returns a bare object reader's schema without adopting the link's shape", () => {
    expect(combineSchemaForLink({ type: "object" }, linkContactSchema))
      .toEqual({ type: "object" });
  });

  it("adopts the link schema for a true reader", () => {
    expect(combineSchemaForLink(true, linkContactSchema)).toEqual(
      linkContactSchema,
    );
  });

  it("adopts the link schema for an empty reader", () => {
    expect(combineSchemaForLink({}, linkContactSchema)).toEqual(
      linkContactSchema,
    );
  });

  it("adopts the link schema under a flag-only reader's asCell wrapper", () => {
    expect(combineSchemaForLink({ asCell: ["cell"] }, linkContactSchema))
      .toEqual({
        ...linkContactSchema,
        asCell: ["cell"],
      });
  });

  it("stays false for a false reader", () => {
    expect(combineSchemaForLink(false, linkContactSchema)).toBe(false);
    expect(combineSchemaForLink({ not: true }, linkContactSchema)).toEqual({
      not: true,
    });
  });

  it("ignores a false link schema for a reader with its own shape", () => {
    expect(combineSchemaForLink(readerSchema, false)).toEqual(readerSchema);
  });

  it("adopts a false link schema for a true reader", () => {
    expect(combineSchemaForLink(true, false)).toBe(false);
  });

  //
  // `ifc` does not ride the combination
  //
  // Write policy consumes declared schemas verbatim
  // (`recordSchemaWritePolicyInput`), so a clause grafted onto the reader's
  // schema would read as a declaration nobody authored. The read entry point
  // marks cfc relevance off the link schema directly instead
  // (`validateAndTransform`'s `schemaHasIfc` gate).
  //

  it("leaves a discarded link schema's ifc off a shaped reader", () => {
    const labeledLink = {
      ...linkContactSchema,
      ifc: { confidentiality: ["confidential"] },
    } as const satisfies JSONSchema;

    expect(combineSchemaForLink(readerSchema, labeledLink)).toEqual(
      readerSchema,
    );
  });

  it("keeps an adopted link schema's own ifc for a true reader", () => {
    const labeledLink = {
      ...linkContactSchema,
      ifc: { confidentiality: ["confidential"] },
    } as const satisfies JSONSchema;

    expect(combineSchemaForLink(true, labeledLink)).toEqual(labeledLink);
  });

  //
  // `default` crosses the precedence line
  //
  // A value's default is inherited from the last crossed schema that declares
  // one, the nearest declaration to the data being the aptest.
  //

  it("inherits the link's default onto a shaped reader", () => {
    const defaultedLink = {
      ...linkContactSchema,
      default: { name: "someone" },
    } as const satisfies JSONSchema;

    expect(combineSchemaForLink(readerSchema, defaultedLink)).toEqual({
      ...readerSchema,
      default: { name: "someone" },
    });
  });

  it("prefers the link's default over the reader's own", () => {
    const defaultedReader = {
      ...readerSchema,
      default: { name: "reader" },
    } as const satisfies JSONSchema;
    const defaultedLink = {
      ...linkContactSchema,
      default: { name: "link" },
    } as const satisfies JSONSchema;

    expect(combineSchemaForLink(defaultedReader, defaultedLink)).toEqual({
      ...readerSchema,
      default: { name: "link" },
    });
  });

  it("keeps the reader's default when the link declares none", () => {
    const defaultedReader = {
      ...readerSchema,
      default: { name: "reader" },
    } as const satisfies JSONSchema;

    expect(combineSchemaForLink(defaultedReader, linkContactSchema)).toEqual(
      defaultedReader,
    );
  });

  it("keeps a default-only reader's default across a defaultless link", () => {
    expect(
      combineSchemaForLink({ default: { name: "seed" } }, linkContactSchema),
    )
      .toEqual({
        ...linkContactSchema,
        default: { name: "seed" },
      });
  });

  it("interns the default-carrying adoption so repeated crossings share one schema", () => {
    const reader = { default: { name: "seed" } } as const satisfies JSONSchema;
    const first = combineSchemaForLink(reader, linkContactSchema);
    expect(combineSchemaForLink(reader, linkContactSchema)).toBe(first);
  });

  it("takes the later link's default across two hops", () => {
    const firstLink = {
      ...linkContactSchema,
      default: { name: "first" },
    } as const satisfies JSONSchema;
    const secondLink = {
      ...linkContactSchema,
      default: { name: "second" },
    } as const satisfies JSONSchema;

    const afterFirst = combineSchemaForLink(readerSchema, firstLink);
    expect(combineSchemaForLink(afterFirst, secondLink)).toEqual({
      ...readerSchema,
      default: { name: "second" },
    });
    expect(combineSchemaForLink(afterFirst, linkContactSchema)).toEqual({
      ...readerSchema,
      default: { name: "first" },
    });
  });

  //
  // The rollback
  //
  // Reader precedence is behind the `readerSchemaPrecedence` experimental flag
  // (docs/development/EXPERIMENTAL_OPTIONS.md). With the flag off,
  // combineSchemaForLink must agree with combineSchema exactly.
  //

  it("restores the strict pseudo-intersection while the rollback is set", () => {
    setReaderSchemaPrecedenceConfig(false);
    try {
      expect(combineSchemaForLink(readerSchema, linkContactSchema)).toEqual(
        combineSchema(readerSchema, linkContactSchema),
      );
    } finally {
      resetReaderSchemaPrecedenceConfig();
    }
  });
});

describe("combineSchemaForLink over a link that declares a stream", () => {
  // A stream target holds no value, so its declaration crosses reader
  // precedence. Each reader is judged in its structural form, so the inline
  // spelling and the content-addressed reference a stored schema rides as get
  // the same verdict.
  const streamLink = {
    asCell: ["stream"],
    type: "number",
  } as JSONSchema & object;
  const spellings = (schema: JSONSchema & object) =>
    [
      ["inline", schema],
      ["as a content-addressed reference", externalizeSchema(schema)],
    ] as const;

  for (const [spelling, link] of spellings(streamLink)) {
    it(`hands a shaped reader the declaration, spelled ${spelling}`, () => {
      expect(combineSchemaForLink({ type: "object" }, link)).toEqual(
        streamLink,
      );
      expect(combineSchemaForLink({ type: "unknown" }, link)).toEqual(
        streamLink,
      );
    });
  }

  for (const [spelling, reader] of spellings({ asCell: ["cell"] })) {
    it(`refuses a reader asking for a plain cell, spelled ${spelling}`, () => {
      expect(combineSchemaForLink(reader, streamLink)).toBe(false);
    });
  }

  for (
    const [spelling, reader] of spellings({
      asCell: ["stream"],
      type: "integer",
    })
  ) {
    it(`leaves a reader that declares the stream as it stands, spelled ${spelling}`, () => {
      expect(combineSchemaForLink(reader, streamLink)).toEqual(reader);
    });
  }

  it("keeps a false reader false", () => {
    expect(combineSchemaForLink(false, streamLink)).toBe(false);
  });
});
