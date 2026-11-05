import { assertEquals, assertThrows } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import { internSchemaAsTaggedHashString } from "@commonfabric/data-model-schema";

import { assertValidPatternParams } from "../src/builder/factory-params.ts";
import {
  isReactive,
  isReactiveMarker,
  type JSONSchema,
} from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { getCellOrThrow } from "../src/query-result-proxy.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { exportCell } from "../src/cell.ts";
import {
  acquireSchemaRegistryLease,
  registerSchemaDocument,
} from "../src/schema-registry.ts";

function symbolic(schema: JSONSchema): unknown {
  return {
    [isReactiveMarker]: true,
    export: () => ({ schema }),
  };
}

Deno.test("pattern curry accepts finite values with recursive JSON schemas", () => {
  const jsonSchema = {
    anyOf: [
      { type: ["null", "boolean", "number", "string"] },
      {
        type: "array",
        items: { $ref: "#/$defs/JsonValue" },
      },
      {
        type: "object",
        additionalProperties: { $ref: "#/$defs/JsonValue" },
      },
    ],
  } as const satisfies JSONSchema;
  const paramsSchema = {
    type: "object",
    properties: {
      value: { $ref: "#/$defs/JsonValue" },
    },
    required: ["value"],
    $defs: { JsonValue: jsonSchema },
  } as const satisfies JSONSchema;

  assertEquals(
    assertValidPatternParams(
      { value: { source: { class: "Document" } } },
      paramsSchema,
    ),
    undefined,
  );
});

Deno.test("pattern curry rejects a cyclic value under a recursive schema", () => {
  const paramsSchema = {
    type: "object",
    properties: {
      value: { $ref: "#/$defs/JsonObject" },
    },
    required: ["value"],
    $defs: {
      JsonObject: {
        type: "object",
        additionalProperties: { $ref: "#/$defs/JsonObject" },
      },
    },
  } as const satisfies JSONSchema;
  const value: Record<string, unknown> = {};
  value.self = value;

  assertThrows(
    () => assertValidPatternParams({ value }, paramsSchema),
    TypeError,
    "cyclic pattern param value",
  );
});

Deno.test("pattern curry accepts an optional cell schema as one symbolic value", () => {
  const roomSchema = {
    type: "object",
    properties: {
      name: { type: "string" },
      messages: {
        type: "array",
        items: { $ref: "#/$defs/ChatMessage" },
      },
    },
    required: ["name", "messages"],
  } as const satisfies JSONSchema;
  const chatMessageSchema = {
    type: "object",
    properties: { body: { type: "string" } },
    required: ["body"],
  } as const satisfies JSONSchema;
  const sourceSchema = {
    $defs: { Room: roomSchema, ChatMessage: chatMessageSchema },
    $ref: "#/$defs/Room",
    asCell: [{ kind: "cell", scope: "session" }],
  } as const satisfies JSONSchema;
  const paramsSchema = {
    type: "object",
    properties: {
      selectedRoomRef: {
        anyOf: [
          { type: "undefined" },
          { $ref: "#/$defs/Room" },
        ],
        asCell: ["cell"],
      },
    },
    required: ["selectedRoomRef"],
    $defs: { Room: roomSchema, ChatMessage: chatMessageSchema },
  } as const satisfies JSONSchema;

  assertEquals(
    assertValidPatternParams(
      { selectedRoomRef: symbolic(sourceSchema) },
      paramsSchema,
    ),
    undefined,
  );
});

Deno.test("pattern curry still rejects a symbolic schema outside the union", () => {
  const paramsSchema = {
    type: "object",
    properties: {
      value: {
        anyOf: [{ type: "undefined" }, { type: "string" }],
        asCell: ["cell"],
      },
    },
    required: ["value"],
  } as const satisfies JSONSchema;

  assertThrows(
    () =>
      assertValidPatternParams(
        {
          value: symbolic({ type: "number", asCell: ["cell"] }),
        },
        paramsSchema,
      ),
    TypeError,
    "value does not match anyOf",
  );
});

Deno.test("pattern curry accepts an equivalent simple type union from a Cell schema", async () => {
  const signer = await Identity.fromPassphrase(
    "factory-params-simple-type-union-test",
  );
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const sourceSchema = {
    anyOf: [
      { type: "undefined" },
      { type: "number", asCell: ["cell"] },
    ],
  } as const satisfies JSONSchema;
  const paramsSchema = {
    type: "object",
    properties: {
      selected: { type: ["number", "undefined"] },
    },
    required: ["selected"],
  } as const satisfies JSONSchema;

  try {
    const selected = runtime.getCell(
      signer.did(),
      "factory-params-simple-type-union",
      sourceSchema,
    ).getAsReactiveProxy();
    assertEquals(
      assertValidPatternParams({ selected }, paramsSchema),
      undefined,
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("pattern curry accepts a union default attached to its matching Cell branch", async () => {
  const signer = await Identity.fromPassphrase(
    "factory-params-union-default-placement-test",
  );
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const sourceSchema = {
    anyOf: [
      { type: "undefined" },
      {
        type: "array",
        items: { type: "string" },
        default: [],
        asCell: ["cell"],
      },
    ],
  } as const satisfies JSONSchema;
  const paramsSchema = {
    type: "object",
    properties: {
      selected: {
        anyOf: [
          { type: "undefined" },
          { type: "array", items: { type: "string" } },
        ],
        default: [],
      },
    },
    required: ["selected"],
  } as const satisfies JSONSchema;

  try {
    const selected = runtime.getCell(
      signer.did(),
      "factory-params-union-default-placement",
      sourceSchema,
    ).getAsReactiveProxy();
    assertEquals(
      assertValidPatternParams({ selected }, paramsSchema),
      undefined,
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("pattern curry accepts a source schema that is stricter than capture metadata", () => {
  const requiredIfc = {
    ownerPrincipal: { __ctCurrentPrincipal: true },
    addIntegrity: [{ kind: "represents-principal" }],
  } as const;
  const paramsSchema = {
    type: "object",
    properties: {
      elements: { ifc: requiredIfc, asCell: ["cell"] },
    },
    required: ["elements"],
  } as const satisfies JSONSchema;
  const sourceSchema = {
    type: "array",
    items: { type: "object" },
    ifc: {
      writeAuthorizedBy: {
        __ctWriterIdentityOf: {
          file: "/profile.tsx",
          path: ["mutateElements"],
        },
      },
      ...requiredIfc,
    },
    asCell: [{ kind: "cell", scope: "space" }],
  } as const satisfies JSONSchema;

  assertEquals(
    assertValidPatternParams(
      { elements: symbolic(sourceSchema) },
      paramsSchema,
    ),
    undefined,
  );
});

Deno.test("pattern curry realizes a serialized cell scope from its schema", () => {
  const paramsSchema = {
    type: "object",
    properties: {
      selected: {
        type: "string",
        asCell: [{ kind: "cell", scope: "session" }],
      },
    },
    required: ["selected"],
  } as const satisfies JSONSchema;
  const selected = {
    "/": {
      "link@1": {
        id: "of:selected",
        path: [],
        scope: "space",
        schema: { type: "string", scope: "session" },
      },
    },
  };

  assertEquals(
    assertValidPatternParams({ selected }, paramsSchema),
    undefined,
  );
});

Deno.test("pattern curry accepts a capability-shrunk stream event schema", () => {
  const expectedEvent = {
    type: "object",
    properties: {
      name: { type: "string" },
      target: {
        type: "object",
        properties: {
          name: { type: "string" },
          value: { type: "string" },
        },
      },
    },
  } as const satisfies JSONSchema;
  const sourceEvent = {
    type: "object",
    properties: {
      name: { type: "string" },
      target: {
        type: "object",
        properties: { name: { type: "string" } },
      },
    },
  } as const satisfies JSONSchema;
  const paramsSchema = {
    type: "object",
    properties: {
      onSelect: { $ref: "#/$defs/ExpectedEvent", asCell: ["stream"] },
    },
    required: ["onSelect"],
    $defs: { ExpectedEvent: expectedEvent },
  } as const satisfies JSONSchema;

  assertEquals(
    assertValidPatternParams(
      { onSelect: symbolic({ ...sourceEvent, asCell: ["stream"] }) },
      paramsSchema,
    ),
    undefined,
  );
  assertThrows(
    () =>
      assertValidPatternParams(
        { onSelect: symbolic({ ...sourceEvent, asCell: ["cell"] }) },
        paramsSchema,
      ),
    TypeError,
    "cell kind mismatch",
  );
});

Deno.test("pattern curry accepts a writable cell where the capture is read-only", () => {
  const paramsSchema = {
    type: "object",
    properties: {
      value: { type: "string", asCell: ["readonly"] },
    },
    required: ["value"],
  } as const satisfies JSONSchema;

  assertEquals(
    assertValidPatternParams(
      { value: symbolic({ type: "string", asCell: ["cell"] }) },
      paramsSchema,
    ),
    undefined,
  );
  assertThrows(
    () =>
      assertValidPatternParams(
        { value: symbolic({ type: "string", asCell: ["readonly"] }) },
        {
          ...paramsSchema,
          properties: {
            value: { type: "string", asCell: ["cell"] },
          },
        },
      ),
    TypeError,
    "cell kind mismatch",
  );
});

Deno.test("pattern curry resolves nested refs for a capability-shrunk stream", async () => {
  const signer = await Identity.fromPassphrase(
    "factory-params-nested-stream-ref-test",
  );
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const itemSchema = {
    type: "object",
    properties: {
      title: { type: "string" },
      indent: { type: "number", default: 0 },
    },
    required: ["title", "indent"],
  } as const satisfies JSONSchema;
  const sourceEventSchema = {
    type: "object",
    properties: {
      item: {
        type: "object",
        properties: { indent: { type: "number", default: 0 } },
        required: ["indent"],
      },
    },
    required: ["item"],
  } as const satisfies JSONSchema;
  const paramsSchema = {
    type: "object",
    properties: {
      removeItem: {
        type: "object",
        properties: { item: { $ref: "#/$defs/Item" } },
        required: ["item"],
        asCell: ["stream"],
      },
    },
    required: ["removeItem"],
    $defs: { Item: itemSchema },
  } as const satisfies JSONSchema;

  try {
    const { pattern, handler } = createTrustedBuilder(runtime).commonfabric;
    pattern(
      () => {
        const removeItem = handler(
          sourceEventSchema,
          true,
          () => undefined,
        )({});
        assertEquals(
          assertValidPatternParams({ removeItem }, paramsSchema),
          undefined,
        );
        return {};
      },
      true,
      true,
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("pattern curry accepts equivalent expanded Default array stream schemas", async () => {
  const signer = await Identity.fromPassphrase(
    "factory-params-expanded-default-array-stream-test",
  );
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const expectedItemSchema = {
    type: "object",
    properties: {
      title: { type: "string" },
      attachments: {
        type: "array",
        items: { asCell: ["cell"] },
        default: [],
      },
    },
    required: ["title", "attachments"],
  } as const satisfies JSONSchema;
  const sourceItemSchema = {
    type: "object",
    properties: {
      title: { type: "string" },
      attachments: {
        anyOf: [
          { type: "array", items: { asCell: ["opaque"] } },
          { type: "array", items: false, default: [] },
        ],
      },
    },
    required: ["title", "attachments"],
  } as const satisfies JSONSchema;
  const sourceEventSchema = {
    type: "object",
    properties: { item: sourceItemSchema },
    required: ["item"],
  } as const satisfies JSONSchema;
  const paramsSchema = {
    type: "object",
    properties: {
      removeItem: {
        type: "object",
        properties: { item: { $ref: "#/$defs/Item" } },
        required: ["item"],
        asCell: ["stream"],
      },
    },
    required: ["removeItem"],
    $defs: { Item: expectedItemSchema },
  } as const satisfies JSONSchema;

  try {
    const { pattern, handler } = createTrustedBuilder(runtime).commonfabric;
    pattern(
      () => {
        const removeItem = handler(
          sourceEventSchema,
          true,
          () => undefined,
        )({});
        assertEquals(
          assertValidPatternParams({ removeItem }, paramsSchema),
          undefined,
        );
        return {};
      },
      true,
      true,
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("pattern curry does not normalize expanded defaults from arbitrary reactive values", () => {
  const paramsSchema = {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: { type: "string" },
        default: [],
        asCell: ["cell"],
      },
    },
    required: ["items"],
  } as const satisfies JSONSchema;
  const sourceSchema = {
    anyOf: [
      { type: "array", items: { type: "string" } },
      { type: "array", items: false, default: [] },
    ],
    asCell: ["cell"],
  } as const satisfies JSONSchema;

  assertThrows(
    () =>
      assertValidPatternParams({ items: symbolic(sourceSchema) }, paramsSchema),
    TypeError,
    "symbolic binding schema mismatch",
  );
});

Deno.test("pattern curry resolves local refs inside an expected content-addressed schema", () => {
  const release = acquireSchemaRegistryLease();
  try {
    const entrySchema = {
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
    } as const satisfies JSONSchema;
    const sourceDocument = {
      type: "array",
      items: { $ref: "#/$defs/Entry" },
      $defs: { Entry: entrySchema },
    } as const satisfies JSONSchema;
    const hash = internSchemaAsTaggedHashString(sourceDocument);
    registerSchemaDocument(hash, sourceDocument);
    const paramsSchema = {
      type: "object",
      properties: {
        entries: {
          $ref: `cid:${hash}`,
          asCell: ["cell"],
        },
      },
      required: ["entries"],
    } as const satisfies JSONSchema;

    assertEquals(
      assertValidPatternParams(
        {
          entries: symbolic({
            $ref: `cid:${hash}`,
            asCell: ["cell"],
          }),
        },
        paramsSchema,
      ),
      undefined,
    );
  } finally {
    release();
  }
});

Deno.test("pattern curry resolves local refs inside a nested content-addressed source schema", () => {
  const release = acquireSchemaRegistryLease();
  try {
    const detailSchema = {
      type: "object",
      properties: { body: { type: "string" } },
      required: ["body"],
    } as const satisfies JSONSchema;
    const entryDocument = {
      type: "object",
      properties: {
        title: { type: "string" },
        detail: { $ref: "#/$defs/Detail" },
      },
      required: ["title", "detail"],
      $defs: { Detail: detailSchema },
    } as const satisfies JSONSchema;
    const hash = internSchemaAsTaggedHashString(entryDocument);
    registerSchemaDocument(hash, entryDocument);
    const paramsSchema = {
      type: "object",
      properties: {
        entries: {
          type: "array",
          items: {
            type: entryDocument.type,
            properties: entryDocument.properties,
            required: entryDocument.required,
          },
          asCell: ["cell"],
        },
      },
      required: ["entries"],
      $defs: { Detail: detailSchema },
    } as const satisfies JSONSchema;

    assertEquals(
      assertValidPatternParams(
        {
          entries: symbolic({
            type: "array",
            items: { $ref: `cid:${hash}` },
            asCell: ["cell"],
          }),
        },
        paramsSchema,
      ),
      undefined,
    );
  } finally {
    release();
  }
});

Deno.test("pattern curry accepts the same rooted ref from a stricter source schema", () => {
  const item = {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
  } as const satisfies JSONSchema;
  const paramsSchema = {
    type: "object",
    properties: {
      items: {
        anyOf: [
          { type: "undefined" },
          { type: "array", items: { $ref: "#/$defs/Item" } },
        ],
      },
    },
    required: ["items"],
    $defs: { Item: item },
  } as const satisfies JSONSchema;
  const sourceSchema = {
    type: "array",
    items: { $ref: "#/$defs/Item" },
    default: [],
    $defs: { Item: item },
    asCell: ["cell"],
  } as const satisfies JSONSchema;

  assertEquals(
    assertValidPatternParams({ items: symbolic(sourceSchema) }, paramsSchema),
    undefined,
  );
});

Deno.test("pattern curry preserves conjunctive constraints on ref siblings", () => {
  const base = {
    type: "object",
    properties: {
      first: { type: "string" },
      second: { type: "string" },
    },
    required: ["first"],
  } as const satisfies JSONSchema;
  const paramsSchema = {
    type: "object",
    properties: {
      selected: {
        $ref: "#/$defs/Base",
        required: ["second"],
        asCell: ["cell"],
      },
    },
    required: ["selected"],
    $defs: { Base: base },
  } as const satisfies JSONSchema;
  const sourceSchema = {
    type: "object",
    properties: base.properties,
    required: ["second"],
    asCell: ["cell"],
  } as const satisfies JSONSchema;

  assertThrows(
    () =>
      assertValidPatternParams(
        { selected: symbolic(sourceSchema) },
        paramsSchema,
      ),
    TypeError,
    "symbolic binding schema mismatch",
  );
});

Deno.test("pattern curry accepts sanitized nested cell metadata only from a real Cell", async () => {
  const signer = await Identity.fromPassphrase(
    "factory-params-sanitized-nested-cell-test",
  );
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const sourceSchema = {
    type: "object",
    properties: {
      subject: {
        anyOf: [{ type: "undefined" }, { type: "string" }],
      },
    },
  } as const satisfies JSONSchema;
  const paramsSchema = {
    type: "object",
    properties: {
      selected: {
        $ref: "#/$defs/Selection",
        asCell: ["cell"],
      },
    },
    required: ["selected"],
    $defs: {
      Selection: {
        type: "object",
        properties: {
          subject: {
            anyOf: [{ type: "undefined" }, { type: "string" }],
            asCell: ["cell"],
          },
        },
      },
    },
  } as const satisfies JSONSchema;

  try {
    const selectedCell = runtime.getCell(
      signer.did(),
      "factory-params-sanitized-nested-cell",
      sourceSchema,
    );
    for (
      const selected of [
        selectedCell.getAsReactiveProxy(),
        selectedCell.getAsNormalizedFullLink(),
      ]
    ) {
      assertEquals(
        assertValidPatternParams({ selected }, paramsSchema),
        undefined,
      );
    }
    assertThrows(
      () =>
        assertValidPatternParams(
          { selected: symbolic({ ...sourceSchema, asCell: ["cell"] }) },
          paramsSchema,
        ),
      TypeError,
      "symbolic binding schema mismatch",
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("pattern curry reads a nested result contract without constraining its live view", async () => {
  const signer = await Identity.fromPassphrase(
    "factory-params-nested-pattern-stream-test",
  );
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const eventSchema = {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
  } as const satisfies JSONSchema;
  const resultSchema = {
    type: "object",
    properties: {
      removeLabels: { ...eventSchema, asCell: ["stream"] },
    },
    required: ["removeLabels"],
  } as const satisfies JSONSchema;
  const paramsSchema = {
    type: "object",
    properties: {
      extractor: resultSchema,
    },
    required: ["extractor"],
  } as const satisfies JSONSchema;

  try {
    const { pattern, handler } = createTrustedBuilder(runtime).commonfabric;
    const removeLabels = handler(
      eventSchema,
      true,
      () => undefined,
    );
    const extractorPattern = pattern(
      () => ({ removeLabels: removeLabels({}) }),
      true,
      resultSchema,
    );
    pattern(
      () => {
        const extractor = extractorPattern({});
        assertEquals(exportCell(getCellOrThrow(extractor)).schema, undefined);
        assertEquals(
          assertValidPatternParams(
            {
              extractor: {
                removeLabels: (extractor as any).key("removeLabels"),
              },
            },
            paramsSchema,
          ),
          undefined,
        );
        return {};
      },
      true,
      true,
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("pattern curry combines a producing result contract with live IFC for reactive and Cell node outputs", async () => {
  const signer = await Identity.fromPassphrase(
    "factory-params-result-contract-live-ifc-test",
  );
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const resultSchema = {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
  } as const satisfies JSONSchema;
  const paramsSchema = {
    type: "object",
    properties: { child: resultSchema },
    required: ["child"],
  } as const satisfies JSONSchema;
  const argumentSchema = {
    type: "object",
    properties: {
      secret: {
        type: "string",
        ifc: { confidentiality: ["secret"] },
      },
    },
    required: ["secret"],
  } as const satisfies JSONSchema;

  try {
    const { pattern } = createTrustedBuilder(runtime).commonfabric;
    const Child = pattern(
      () => ({ value: "ok" }),
      true,
      resultSchema,
    );
    pattern(
      (input: any) => {
        const child = Child({ secret: input.secret });
        assertEquals(
          (exportCell(getCellOrThrow(child)).schema as any)?.ifc
            ?.confidentiality,
          ["secret"],
        );
        assertEquals(
          assertValidPatternParams({ child }, paramsSchema),
          undefined,
        );
        const exported = exportCell(getCellOrThrow(child));
        for (const node of exported.nodes) {
          if (isReactive(node.outputs)) {
            node.outputs = getCellOrThrow(node.outputs);
          }
        }
        assertEquals(
          assertValidPatternParams({ child }, paramsSchema),
          undefined,
        );
        return {};
      },
      argumentSchema,
      true,
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("pattern curry reads a dynamic child contract from call-site metadata", async () => {
  const signer = await Identity.fromPassphrase(
    "factory-params-dynamic-child-contract-test",
  );
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const argumentSchema = {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
  } as const satisfies JSONSchema;
  const resultSchema = {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
  } as const satisfies JSONSchema;
  const expected = {
    kind: "pattern",
    argumentSchema,
    resultSchema,
  } as const;
  const paramsSchema = {
    type: "object",
    properties: { child: resultSchema },
    required: ["child"],
  } as const satisfies JSONSchema;
  const outerArgumentSchema = {
    type: "object",
    properties: { factory: { asFactory: expected } },
    required: ["factory"],
  } as const satisfies JSONSchema;

  try {
    const commonfabric = createTrustedBuilder(runtime).commonfabric;
    const invokeFactory = (commonfabric as unknown as {
      __cfHelpers: {
        invokeFactory: (
          factory: unknown,
          input: unknown,
          contract: typeof expected,
        ) => unknown;
      };
    }).__cfHelpers.invokeFactory;
    commonfabric.pattern(
      (input: any) => {
        const child = invokeFactory(
          input.factory,
          { value: "ok" },
          expected,
        );
        assertEquals(exportCell(getCellOrThrow(child)).schema, undefined);
        assertEquals(
          assertValidPatternParams({ child }, paramsSchema),
          undefined,
        );
        return {};
      },
      outerArgumentSchema,
      true,
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("pattern curry accepts an enum-narrowed symbolic capture", () => {
  const paramsSchema = {
    type: "object",
    properties: {
      identifierType: { type: "string" },
    },
    required: ["identifierType"],
  } as const satisfies JSONSchema;

  assertEquals(
    assertValidPatternParams(
      {
        identifierType: symbolic({
          enum: ["card", "account"],
          asCell: ["cell"],
        }),
      },
      paramsSchema,
    ),
    undefined,
  );
});

Deno.test("pattern curry validates a symbolic Cell default when content schema is deferred", () => {
  const paramsSchema = {
    type: "object",
    properties: {
      body: {
        type: "object",
        additionalProperties: true,
        asCell: ["cell"],
      },
    },
    required: ["body"],
  } as const satisfies JSONSchema;

  assertEquals(
    assertValidPatternParams(
      {
        body: symbolic({
          default: { text: "hello" },
          asCell: ["cell"],
        }),
      },
      paramsSchema,
    ),
    undefined,
  );
});

Deno.test("pattern curry trusts an empty deferred schema only on a real Cell", async () => {
  const signer = await Identity.fromPassphrase(
    "factory-params-deferred-cell-test",
  );
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const paramsSchema = {
    type: "object",
    properties: {
      candidates: {
        type: "array",
        items: { type: "object", properties: { title: { type: "string" } } },
      },
    },
    required: ["candidates"],
  } as const satisfies JSONSchema;

  try {
    const deferredCell = runtime.getCell(
      signer.did(),
      "factory-params-deferred-cell",
      {},
    );
    assertEquals(
      assertValidPatternParams({ candidates: deferredCell }, paramsSchema),
      undefined,
    );
    assertThrows(
      () =>
        assertValidPatternParams(
          { candidates: symbolic({}) },
          paramsSchema,
        ),
      TypeError,
      "symbolic binding schema mismatch",
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});
