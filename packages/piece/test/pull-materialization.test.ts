import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import type { FabricValue } from "@commonfabric/data-model";
import {
  entityRefToString,
  linkRefPayload,
} from "@commonfabric/data-model/cell-rep";
import { createSession, Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import {
  type Cell,
  getPatternIdentityRef,
  getPatternRepository,
  getPieceSourceRevisions,
  isCell,
  isLink,
  type JSONSchema,
  KeepAsCell,
  type Module,
  NAME,
  Pattern,
  PatternSetupPostCommitError,
  Runtime,
  type RuntimeProgram,
} from "@commonfabric/runner";
import {
  validateAgainstSchema,
  validateSchemaValue,
} from "@commonfabric/runner/cfc";
import {
  EmulatedStorageManager,
  newLoopbackServer,
  StorageManager,
} from "@commonfabric/runner/storage/cache.deno";
import { defer } from "@commonfabric/utils/defer";

import {
  assertSuppliedLinkSchemasCompatible,
  assertWritablePiecePath,
  cellCapabilityCanNarrow,
  consumeOuterCellContract,
  consumeStreamEventContract,
  currentValuePathContracts,
  durableSourceContract,
  linkPathContracts,
  localizeOuterCellContract,
  localizeStreamEventContract,
  localizeWritableDestinationContracts,
  materializedValueAtPath,
  omitMissingProjectionAliases,
  PieceController,
  rawResolvedValueAtPath,
  resolveDeclaredStreamCapability,
  selectCurrentContainerSchema,
} from "../src/ops/piece-controller.ts";
import { readPieceSourceState } from "../src/ops/piece-origin.ts";
import { PiecesController } from "../src/ops/pieces-controller.ts";
import { rawMetaWriteAuthorization } from "@commonfabric/runner/meta-seam";

const signer = await Identity.fromPassphrase("piece pull materialization");

function doublePattern(): Pattern {
  return {
    argumentSchema: {
      type: "object",
      properties: {
        input: { type: "number" },
      },
    },
    resultSchema: {
      type: "object",
      properties: {
        output: { type: "number" },
      },
    },
    derivedInternalCells: [{ partialCause: "output" }],
    result: {
      output: { $alias: { partialCause: "output", path: [] } },
    },
    nodes: [
      {
        module: {
          type: "javascript",
          implementation: (input: number) => input * 2,
        },
        inputs: { $alias: { cell: "argument", path: ["input"] } },
        outputs: { $alias: { partialCause: "output", path: [] } },
      },
    ],
  };
}

function sourceLessMultiplierPattern(
  version: string,
  multiplier: number,
): Pattern {
  return {
    argumentSchema: {
      type: "object",
      properties: {
        input: { type: "number" },
      },
      required: ["input"],
    },
    resultSchema: {
      type: "object",
      properties: {
        version: { type: "string" },
        output: { type: "number" },
      },
      required: ["version"],
    },
    derivedInternalCells: [{ partialCause: "output" }],
    result: {
      version,
      output: { $alias: { partialCause: "output", path: [] } },
    },
    nodes: [
      {
        module: {
          type: "javascript",
          implementation: (input: number) => input * multiplier,
        },
        inputs: { $alias: { cell: "argument", path: ["input"] } },
        outputs: { $alias: { partialCause: "output", path: [] } },
      },
    ],
  };
}

function tenfoldPattern(): Pattern {
  return {
    argumentSchema: {
      type: "object",
      properties: {
        input: { type: "number" },
      },
    },
    resultSchema: {
      type: "object",
      properties: {
        output: { type: "number" },
      },
    },
    derivedInternalCells: [{ partialCause: "output" }],
    result: {
      output: { $alias: { partialCause: "output", path: [] } },
    },
    nodes: [
      {
        module: {
          type: "javascript",
          implementation: (input: number) => input * 10,
        },
        inputs: { $alias: { cell: "argument", path: ["input"] } },
        outputs: { $alias: { partialCause: "output", path: [] } },
      },
    ],
  };
}

function namedPattern(name: string, multiplier: number): Pattern {
  return {
    argumentSchema: {
      type: "object",
      properties: {
        input: { type: "number" },
      },
    },
    resultSchema: {
      type: "object",
      properties: {
        [NAME]: { type: "string" },
        output: { type: "number" },
      },
      required: [NAME, "output"],
    },
    derivedInternalCells: [{ partialCause: "output" }],
    result: {
      [NAME]: name,
      output: { $alias: { partialCause: "output", path: [] } },
    },
    nodes: [
      {
        module: {
          type: "javascript",
          implementation: (input: number) => input * multiplier,
        },
        inputs: { $alias: { cell: "argument", path: ["input"] } },
        outputs: { $alias: { partialCause: "output", path: [] } },
      },
    ],
  };
}

function compiledMultiplierProgram(
  version: string,
  multiplier: number,
  main = "/main.tsx",
): RuntimeProgram {
  return {
    main,
    files: [
      {
        name: main,
        contents: [
          "import { pattern, lift } from 'commonfabric';",
          `const multiply = lift((input: number) => input * ${multiplier});`,
          "export default pattern<{ input: number }>(({ input }) => ({",
          `  version: ${JSON.stringify(version)},`,
          "  output: multiply(input),",
          "}));",
        ].join("\n"),
      },
    ],
  };
}

function compiledScopedInputProgram(version: string): RuntimeProgram {
  return {
    main: "/main.tsx",
    files: [
      {
        name: "/main.tsx",
        contents: [
          "import { Default, NAME, pattern, type PerSpace, type PerUser, UI, type VNode } from 'commonfabric';",
          "interface Item { title: string; }",
          "interface In {",
          '  who?: PerUser<string | Default<"">>;',
          "  options?: PerSpace<Item[] | Default<[]>>;",
          "}",
          "interface Out { [NAME]: string; [UI]: VNode; who: string; count: number; }",
          "export default pattern<In, Out>(({ who, options }) => ({",
          `  [NAME]: ${JSON.stringify("probe-" + version)},`,
          "  [UI]: <div>{who}</div>,",
          "  who,",
          "  count: options.length,",
          "}));",
        ].join("\n"),
      },
    ],
  };
}

function compiledSchemaEvolutionProgram(version: 1 | 2 | 3): RuntimeProgram {
  const contents = version === 1
    ? [
      "import { pattern } from 'commonfabric';",
      "interface Input { value: number; }",
      "interface Output { doubled: number; }",
      "export default pattern<Input, Output>(({ value }) => ({",
      "  doubled: value,",
      "}));",
    ]
    : version === 2
    ? [
      "import { Default, pattern } from 'commonfabric';",
      "interface Options { attempts: number | Default<1>; }",
      "interface Input {",
      "  value: number;",
      "  label?: string;",
      "  retries: number | Default<0>;",
      "  options: Options;",
      "  mode?: string | number;",
      "}",
      "interface Output { doubled: number; summary?: string; }",
      "export default pattern<Input, Output>(({ value }) => ({",
      "  doubled: value,",
      "  summary: 'updated',",
      "}));",
    ]
    : [
      "import { pattern } from 'commonfabric';",
      "interface Input { value: string; }",
      "interface Output { doubled: string; }",
      "export default pattern<Input, Output>(({ value }) => ({",
      "  doubled: value,",
      "}));",
    ];
  return {
    main: "/main.tsx",
    files: [{ name: "/main.tsx", contents: contents.join("\n") }],
  };
}

function compiledResultNarrowingProgram(
  resultType:
    | "string | number | boolean"
    | "string | number"
    | "string"
    | "number",
): RuntimeProgram {
  const value = resultType === "string" ? "String(input)" : "input";
  return {
    main: "/main.tsx",
    files: [{
      name: "/main.tsx",
      contents: [
        "import { pattern } from 'commonfabric';",
        "interface Input { input: number; }",
        `interface Output { value: ${resultType}; }`,
        "export default pattern<Input, Output>(({ input }) => ({",
        `  value: ${value},`,
        "}));",
      ].join("\n"),
    }],
  };
}

function compiledOptionalPartialDefaultProgram(
  version: 1 | 2,
): RuntimeProgram {
  const contents = version === 1
    ? [
      "import { pattern } from 'commonfabric';",
      "interface Input { value: number; }",
      "export default pattern<Input>(({ value }) => ({ value }));",
    ]
    : [
      "import { Default, pattern } from 'commonfabric';",
      "interface Options { attempts: number | Default<1>; name: string; }",
      "interface Input { value: number; options?: Options; }",
      "export default pattern<Input>(({ value }) => ({ value }));",
    ];
  return {
    main: "/main.tsx",
    files: [{ name: "/main.tsx", contents: contents.join("\n") }],
  };
}

function compiledOptionalNumberFieldProgram(version: 1 | 2): RuntimeProgram {
  const input = version === 1
    ? "interface Input { value: number; }"
    : "interface Input { value: number; mode?: number; }";
  return {
    main: "/main.tsx",
    files: [{
      name: "/main.tsx",
      contents: [
        "import { pattern } from 'commonfabric';",
        input,
        "export default pattern<Input>(({ value }) => ({ value }));",
      ].join("\n"),
    }],
  };
}

function compiledDefaultedOptionsProgram(version: 1 | 2): RuntimeProgram {
  const contents = version === 1
    ? [
      "import { pattern } from 'commonfabric';",
      "interface Input { value: number; }",
      "export default pattern<Input>(({ value }) => ({ value }));",
    ]
    : [
      "import { Default, pattern } from 'commonfabric';",
      "interface Options { attempts: number | Default<1>; }",
      "interface Input { value: number; options?: Options; }",
      "export default pattern<Input>(({ value }) => ({ value }));",
    ];
  return {
    main: "/main.tsx",
    files: [{ name: "/main.tsx", contents: contents.join("\n") }],
  };
}

function compiledArrayItemDefaultsProgram(version: 1 | 2): RuntimeProgram {
  return {
    main: "/main.tsx",
    files: [{
      name: "/main.tsx",
      contents: [
        `import { ${
          version === 1 ? "pattern" : "Default, pattern"
        } } from 'commonfabric';`,
        "interface Item {",
        "  mode?: string;",
        version === 2 ? "  attempts: number | Default<1>;" : "",
        "}",
        "interface Input { items: Item[]; }",
        "export default pattern<Input>(() => ({ ready: true }));",
      ].filter(Boolean).join("\n"),
    }],
  };
}

function compiledDynamicDefaultsProgram(version: 1 | 2): RuntimeProgram {
  return {
    main: "/main.tsx",
    files: [{
      name: "/main.tsx",
      contents: [
        `import { ${
          version === 1 ? "pattern" : "Default, pattern"
        } } from 'commonfabric';`,
        "interface Item {",
        "  mode?: string;",
        version === 2 ? "  attempts: number | Default<1>;" : "",
        "}",
        "type Input = Record<string, Item>;",
        "export default pattern<Input>(() => ({ ready: true }));",
      ].filter(Boolean).join("\n"),
    }],
  };
}

function linkedSettingsSourcePattern(): Pattern {
  return {
    argumentSchema: { type: "object" },
    resultSchema: {
      type: "object",
      properties: {
        settings: {
          type: "object",
          properties: { mode: { type: "string" } },
          required: ["mode"],
          additionalProperties: false,
        },
      },
      required: ["settings"],
    },
    result: { settings: { mode: "linked" } },
    nodes: [],
  };
}

function compiledLinkedSettingsProgram(version: 1 | 2): RuntimeProgram {
  const attempts = version === 1 ? "" : "  attempts: number | Default<1>;";
  return {
    main: "/main.tsx",
    files: [{
      name: "/main.tsx",
      contents: [
        `import { ${
          version === 1 ? "pattern" : "Default, pattern"
        } } from 'commonfabric';`,
        "interface Settings {",
        "  mode: string;",
        attempts,
        "}",
        "interface Input { settings: Settings; }",
        "export default pattern<Input>(({ settings }) => ({",
        "  mode: settings.mode,",
        "}));",
      ].filter(Boolean).join("\n"),
    }],
  };
}

function trustPattern(runtime: Runtime, pattern: Pattern): Pattern {
  return runtime.unsafeTrustPattern(pattern, {
    reason: "piece pull materialization test fixture",
  });
}

async function withInputRootPullSpy<T>(
  pieces: PiecesController,
  piece: Cell<unknown>,
  action: (rootPulls: () => number) => Promise<T>,
): Promise<T> {
  const inputRoot = pieces.getArgument(piece);
  const originalGetArgument = pieces.getArgument.bind(pieces);
  const originalPull = inputRoot.pull.bind(inputRoot);
  let pullCount = 0;
  pieces.getArgument = (() => inputRoot) as typeof pieces.getArgument;
  inputRoot.pull = () => {
    pullCount++;
    return originalPull();
  };

  try {
    return await action(() => pullCount);
  } finally {
    pieces.getArgument = originalGetArgument;
    inputRoot.pull = originalPull;
  }
}

// Two-replica harness: a server that several emulated replicas can share, so a
// fresh reader must fetch cross-replica rather than read its own warm cache.
// Mirrors newSharedServer/EmulatedStorageManager.connectTo in
// fresh-replica-read-asymmetry.test.ts; the auth matches the server
// EmulatedStorageManager.emulate builds for itself (v2-emulate.ts).
const newSharedServer = (): MemoryV2Server.Server => newLoopbackServer();

describe("piece link contract localization", () => {
  const contract = (schema: JSONSchema, root: JSONSchema = schema) => ({
    schema,
    root,
  });

  it("never grants authority across the Cell capability lattice", () => {
    const kinds = [
      "cell",
      "readonly",
      "writeonly",
      "comparable",
      "opaque",
      "stream",
    ] as const;
    const allowed = new Set([
      "cell:cell",
      "cell:readonly",
      "cell:writeonly",
      "cell:comparable",
      "cell:opaque",
      "readonly:readonly",
      "readonly:comparable",
      "readonly:opaque",
      "writeonly:writeonly",
      "comparable:comparable",
      "opaque:opaque",
      "stream:stream",
    ]);

    for (const source of kinds) {
      for (const target of kinds) {
        expect(cellCapabilityCanNarrow(source, target)).toBe(
          allowed.has(`${source}:${target}`),
        );
      }
    }
  });

  it("fails closed for path ancestors that cannot be localized", () => {
    const unresolvedRoot: JSONSchema = { $defs: {} };
    expect(() =>
      linkPathContracts(
        [contract({ $ref: "#/$defs/Missing" }, unresolvedRoot)],
        [],
      )
    ).toThrow(/cannot resolve a local schema reference/);

    expect(linkPathContracts([contract(false)], ["child"])[0]?.schema)
      .toBe(false);
    expect(linkPathContracts([contract(true)], ["child"])[0]?.schema)
      .toBe(true);

    expect(() =>
      linkPathContracts(
        [contract({ type: "object", items: true })],
        ["child"],
      )
    ).toThrow(/ambiguous object\/array ancestor/);
    expect(() =>
      linkPathContracts(
        [contract({ type: "array", items: true })],
        ["not-an-index"],
      )
    ).toThrow(/array link path contains non-index segment/);

    expect(
      linkPathContracts([contract({ $defs: {} })], ["child"])[0]?.schema,
    ).toBe(true);
    expect(() =>
      linkPathContracts(
        [contract({ type: "number" })],
        ["child"],
      )
    ).toThrow(/schema does not describe a container/);
  });

  it("localizes tuple prefixItems before falling back to items", () => {
    const schema: JSONSchema = {
      type: "array",
      prefixItems: [{ $ref: "#/$defs/First" }],
      items: { type: "number" },
      $defs: { First: { type: "string" } },
    };

    expect(linkPathContracts([contract(schema)], [0])[0]?.schema).toEqual({
      type: "string",
    });
    expect(linkPathContracts([contract(schema)], [1])[0]?.schema).toEqual({
      type: "number",
    });
  });

  it("keeps sparse array indices optional despite minItems", () => {
    const schema: JSONSchema = {
      type: "array",
      prefixItems: [{ type: "number" }],
      items: { type: "number" },
      minItems: 1,
    };

    expect(
      linkPathContracts([contract(schema)], [0], {
        trackSourcePresence: true,
      })[0]?.schema,
    ).toEqual({
      anyOf: [{ type: "number" }, { type: "undefined" }],
    });
  });

  it("selects current container shapes and rejects impossible ones", () => {
    const scalar = { type: "number", maximum: 10 } as const;
    expect(selectCurrentContainerSchema(scalar, 1)).toBe(scalar);
    expect(() =>
      selectCurrentContainerSchema(
        { type: "array", items: true },
        { value: 1 },
      )
    ).toThrow(/not accepted as an object container/);

    expect(
      selectCurrentContainerSchema(
        {
          type: ["object", "array"],
          properties: { value: { type: "number" } },
          required: ["value"],
          items: { type: "number" },
          uniqueItems: true,
          maximum: 10,
          minLength: 1,
          dependentRequired: { value: ["other"] },
        },
        { value: 1 },
      ),
    ).toEqual({
      type: "object",
      properties: { value: { type: "number" } },
      required: ["value"],
    });
  });

  it("localizes every selected current-value composition branch", () => {
    const anyOfSchema: JSONSchema = {
      anyOf: [{
        type: "object",
        properties: { value: { type: "number" } },
        required: ["value"],
      }, {
        type: "object",
        properties: { value: { type: "number", minimum: 0 } },
        required: ["value"],
      }],
    };
    expect(
      currentValuePathContracts(
        contract(anyOfSchema),
        "value",
        { value: 1 },
        { value: 2 },
      ).map((entry) => entry.schema),
    ).toEqual([
      true,
      { type: "number" },
      { type: "number", minimum: 0 },
    ]);

    const oneOfSchema: JSONSchema = {
      oneOf: [{
        type: "object",
        properties: {
          kind: { const: "number" },
          value: { type: "number" },
        },
        required: ["kind", "value"],
      }, {
        type: "object",
        properties: {
          kind: { const: "string" },
          value: { type: "string" },
        },
        required: ["kind", "value"],
      }],
    };
    expect(
      currentValuePathContracts(
        contract(oneOfSchema),
        "value",
        { kind: "number", value: 1 },
        { kind: "string", value: "next" },
      ).map((entry) => entry.schema),
    ).toEqual([true, { type: "string" }, { type: "number" }]);

    const allOfSchema: JSONSchema = {
      allOf: [{
        type: "object",
        properties: { value: { type: "number" } },
        required: ["value"],
      }, {
        type: "object",
        properties: { value: { type: "number", minimum: 0 } },
        required: ["value"],
      }],
    };
    expect(
      currentValuePathContracts(
        contract(allOfSchema),
        "value",
        { value: 1 },
        { value: 2 },
      ).map((entry) => entry.schema),
    ).toEqual([
      true,
      { type: "number" },
      { type: "number", minimum: 0 },
    ]);
    expect(() =>
      currentValuePathContracts(
        contract(allOfSchema),
        "value",
        { value: 1 },
        { value: -1 },
      )
    ).toThrow(/does not satisfy an allOf write contract/);
  });

  it("fails closed when current-value branch selection is not provable", () => {
    expect(() =>
      currentValuePathContracts(
        contract({ type: "number", dependentRequired: {} }),
        "value",
        1,
        2,
      )
    ).toThrow(/dependentRequired correlates/);

    expect(() =>
      currentValuePathContracts(
        contract({
          type: "array",
          anyOf: [{ type: "array", items: { type: "number" } }],
        }),
        0,
        [1],
        { value: 1 },
      )
    ).toThrow(/not accepted as an object container/);

    expect(() =>
      currentValuePathContracts(
        contract({
          dependentSchemas: { value: { required: ["other"] } },
          anyOf: [{ type: "object" }],
        }),
        "value",
        1,
        2,
      )
    ).toThrow(/dependentSchemas correlates/);

    expect(() =>
      currentValuePathContracts(
        contract({ allOf: [] }),
        "value",
        1,
        2,
      )
    ).toThrow(/allOf correlates/);

    expect(() =>
      currentValuePathContracts(
        contract({
          anyOf: [{
            type: "object",
            properties: { kind: { const: "known" } },
            required: ["kind"],
          }],
        }),
        "kind",
        { kind: "known" },
        { kind: "unknown" },
      )
    ).toThrow(/does not select a valid anyOf write contract/);

    const overlapping: JSONSchema = {
      oneOf: [{
        type: "object",
        properties: { value: { type: "number" } },
        required: ["value"],
      }, {
        type: "object",
        properties: { value: { minimum: 0 } },
        required: ["value"],
      }],
    };
    expect(() =>
      currentValuePathContracts(
        contract(overlapping),
        "value",
        { value: 1 },
        { value: 2 },
      )
    ).toThrow(/does not select a valid oneOf write contract/);

    const recursive: JSONSchema = { anyOf: [{ type: "object" }] };
    const active = new WeakSet<object>();
    active.add(recursive as object);
    expect(() =>
      currentValuePathContracts(
        contract(recursive),
        "value",
        { value: 1 },
        { value: 2 },
        active,
      )
    ).toThrow(/recursive correlated write schema/);
  });

  it("localizes outer Cell compositions without erasing authority", () => {
    const readonly = { type: "number", asCell: ["readonly"] } as JSONSchema;
    const writeonly = {
      type: "number",
      asCell: ["writeonly"],
    } as JSONSchema;

    expect(
      localizeOuterCellContract(contract({
        anyOf: [readonly, writeonly],
      })).issue,
    ).toMatch(/incompatible outer capabilities/);

    expect(
      localizeOuterCellContract(
        contract({ anyOf: [readonly, { type: "number" }, { type: "string" }] }),
        { value: 1, opaqueHandle: false },
      ).contract.schema,
    ).toEqual({ anyOf: [{ type: "number" }, { type: "string" }] });

    expect(
      localizeOuterCellContract(contract({
        anyOf: [{ type: "number", asCell: ["stream"] }, true],
      })).issue,
    ).toMatch(/mixed stream and non-stream anyOf alternatives/);
    expect(
      localizeOuterCellContract(contract({ anyOf: [readonly, true] })).issue,
    ).toMatch(/ambiguous wrapped and unwrapped anyOf alternatives/);

    expect(
      localizeOuterCellContract(contract({
        allOf: [readonly, writeonly],
      })).issue,
    ).toMatch(/incompatible outer capabilities/);

    const recursiveAnyOf = {} as { anyOf?: JSONSchema[] };
    recursiveAnyOf.anyOf = [recursiveAnyOf as JSONSchema];
    expect(
      localizeOuterCellContract(
        contract(recursiveAnyOf as JSONSchema),
      ).issue,
    ).toMatch(/recursive Cell schema/);

    const recursiveAllOf = {} as { allOf?: JSONSchema[] };
    recursiveAllOf.allOf = [recursiveAllOf as JSONSchema];
    expect(
      localizeOuterCellContract(
        contract(recursiveAllOf as JSONSchema),
      ).issue,
    ).toMatch(/recursive Cell schema/);
  });

  it("consumes only well-formed outer Cell wrappers", () => {
    expect(consumeOuterCellContract(true)).toEqual({
      kind: "cell",
      payloadSchema: true,
    });
    expect(
      consumeOuterCellContract({
        type: "number",
        asCell: ["stream", "cell"],
      }),
    ).toEqual({
      kind: "stream",
      payloadSchema: { type: "number", asCell: ["cell"] },
    });
    expect(() =>
      consumeOuterCellContract({
        type: "number",
        asCell: [{}],
      } as unknown as JSONSchema)
    ).toThrow(/invalid outer Cell kind/);
  });

  it("fails closed for malformed stream-event compositions", () => {
    expect(() => consumeStreamEventContract(contract(true))).toThrow(
      /no stream-bearing alternative/,
    );

    const cellOnly = localizeStreamEventContract(
      contract({ type: "number", asCell: ["cell"] }),
    );
    expect(cellOnly.consumedStream).toBe(false);
    expect(cellOnly.issue).toMatch(/uses cell wrapper/);

    expect(() =>
      consumeStreamEventContract(contract({
        anyOf: [
          { type: "number", asCell: ["cell"] },
          { type: "number" },
        ],
      }))
    ).toThrow(/uses cell wrapper/);

    expect(() =>
      consumeStreamEventContract(contract({
        allOf: [
          { type: "number", asCell: ["stream"] },
          { type: "number", asCell: ["cell"] },
        ],
      }))
    ).toThrow(/uses cell wrapper/);

    const recursive = {} as { anyOf?: JSONSchema[] };
    recursive.anyOf = [recursive as JSONSchema];
    expect(() =>
      localizeStreamEventContract(
        contract(recursive as JSONSchema),
      )
    ).toThrow(/recursive stream event schema/);
  });
});

describe("piece pull materialization", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let pieces: PiecesController;

  beforeEach(async () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("http://localhost:9999"),
      storageManager,
    });

    const session = await createSession({
      identity: signer,
      spaceName: "pull-materialization-" + crypto.randomUUID(),
    });
    pieces = new PiecesController(session, runtime);
    await pieces.synced();
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("resolves explicit Stream capability without guessing from opaque views", () => {
    expect(resolveDeclaredStreamCapability([undefined, true, true])).toBe(
      true,
    );
    expect(resolveDeclaredStreamCapability([undefined])).toBe(false);
    expect(() => resolveDeclaredStreamCapability([true, false])).toThrow(
      /disagree on Stream capability/,
    );
  });

  it("distinguishes absent projection documents from failed reads", () => {
    const resolved = runtime.getCell(
      pieces.getSpace(),
      "projection-read-" + crypto.randomUUID(),
    ).getAsNormalizedFullLink();
    const transaction = (
      result: unknown,
    ): Parameters<typeof rawResolvedValueAtPath>[0] =>
      ({ read: () => result }) as unknown as Parameters<
        typeof rawResolvedValueAtPath
      >[0];

    expect(
      rawResolvedValueAtPath(
        transaction({ error: { name: "NotFoundError" } }),
        resolved,
      ),
    ).toEqual({ present: false, value: undefined });
    expect(() =>
      rawResolvedValueAtPath(
        transaction({ error: { name: "StorageFailure" } }),
        resolved,
      )
    ).toThrow(/projection alias document read failed: StorageFailure/);
    expect(
      rawResolvedValueAtPath(
        transaction({ ok: { value: { metadata: {} } } }),
        resolved,
      ),
    ).toEqual({ present: false, value: undefined });
    expect(
      rawResolvedValueAtPath(
        transaction({
          ok: { value: { value: { nested: { value: 7 } } } },
        }),
        { ...resolved, path: ["nested", "value"] },
      ),
    ).toEqual({ present: true, value: 7 });
  });

  it("follows materialized Cells and fails closed on recursive write authority", async () => {
    const piece = await pieces.runPersistent(
      trustPattern(runtime, doublePattern()),
      { input: 5 },
      undefined,
      { start: true },
    );
    const argument = pieces.getArgument(piece);

    expect(
      materializedValueAtPath({ argument }, ["argument", "input"]),
    ).toBe(5);
    expect(materializedValueAtPath(1, ["missing"])).toBeUndefined();
    expect(() => assertWritablePiecePath(true, [], false, false, argument)).not
      .toThrow();

    const recursive = {} as { anyOf?: JSONSchema[] };
    recursive.anyOf = [recursive as JSONSchema];
    expect(() =>
      assertWritablePiecePath(
        recursive as JSONSchema,
        ["value"],
        false,
        true,
        argument,
      )
    ).toThrow(/recursive Cell schema/);
  });

  it("rejects conflicting and descendant Stream destinations", async () => {
    const rootCell = runtime.getCell(
      pieces.getSpace(),
      "destination-contract-" + crypto.randomUUID(),
    );
    await runtime.editWithRetry((tx) => {
      rootCell.withTx(tx).setRawUntyped({
        value: 1,
        channel: { nested: 1 },
      });
    });
    const destination = (
      root: JSONSchema,
      path: (string | number)[],
    ): Parameters<typeof localizeWritableDestinationContracts>[0] => ({
      root,
      path,
      rawBasePath: [],
      schemaBaseDepth: 0,
      validationCell: rootCell,
      validationPath: path,
    });

    const conflicting: JSONSchema = {
      type: "object",
      properties: {
        value: { type: "number", asCell: ["cell"] },
      },
      patternProperties: {
        "^value$": { type: "number", asCell: ["readonly"] },
      },
    };
    expect(() =>
      localizeWritableDestinationContracts(
        destination(conflicting, ["value"]),
        rootCell,
        2,
      )
    ).toThrow(/write destination Cell constraints disagree/);

    const stream: JSONSchema = {
      type: "object",
      properties: {
        channel: {
          type: "object",
          properties: { nested: { type: "number" } },
          asCell: ["stream"],
        },
      },
    };
    expect(() =>
      localizeWritableDestinationContracts(
        destination(stream, ["channel", "nested"]),
        rootCell,
        2,
      )
    ).toThrow(/stream Cell write destination path is not writable/);
  });

  it("requires a transaction before reconciling a raw projection alias", () => {
    const base = runtime.getCell(
      pieces.getSpace(),
      "projection-base-" + crypto.randomUUID(),
    );
    const source = runtime.getCell(
      pieces.getSpace(),
      "projection-source-" + crypto.randomUUID(),
    );
    const raw = source.getAsLink({ base, includeSchema: false });

    expect(() =>
      omitMissingProjectionAliases(
        undefined,
        raw,
        undefined,
        base,
        pieces,
      )
    ).toThrow(/projection alias reconciliation requires a transaction/);
  });

  it("restores retained links whose destination declares an outer capability", async () => {
    // A source update (`PieceController.setPattern`, i.e. `cf piece setsrc`)
    // re-applies the piece's retained links from `argumentCell.getRaw()`.
    // Raw storage holds SERIALIZED links, never live Cells, so every link on
    // that path fails `isCell()` — which is what `preservesDirectHandle` used
    // to key off, alone. Every retained link into an `asCell`-declaring slot
    // was therefore rejected: capability kinds as "exposed as an ordinary
    // alias", ordinary `Cell<T>` slots as "asCell changed". Same cause, three
    // error messages.
    //
    // The practical effect: a piece holding an injected `SqliteDb` input
    // (Loom's native connector panels — `db: SqliteDb`, which compiles to
    // `asCell: ["sqlite"]`) could never have its source updated in place.
    // `setPattern` rebuilds nothing, so there was no aliasing to police.
    const sqliteDb: JSONSchema = {
      type: "object",
      properties: {
        id: { type: "string" },
        tables: { type: "object" },
        rev: { type: "number" },
      },
      asCell: ["sqlite"],
    };
    const argumentSchema: JSONSchema = {
      type: "object",
      properties: { db: sqliteDb },
      required: ["db"],
    };

    // The injected handle: seeded directly at a deterministic id, so it
    // carries no producer-owned metadata — exactly how a disk-source handle
    // is created (`linkSqliteDiskSource`). `durableSourceContract` finds
    // nothing, so validation falls back to the prior argument contract.
    const handle = runtime.getCell(
      pieces.getSpace(),
      "sqlite-handle-" + crypto.randomUUID(),
    );
    await runtime.editWithRetry((tx) => {
      handle.withTx(tx).set({ id: "handle-1", tables: {}, rev: 0 });
    });

    const base = runtime.getCell(
      pieces.getSpace(),
      "sqlite-panel-argument-" + crypto.randomUUID(),
    );
    await runtime.editWithRetry((tx) => {
      base.withTx(tx).set({ db: handle });
    });

    const raw = base.getRaw() as { db: unknown };
    // Guard the premise: the restore path really does see a SERIALIZED link,
    // so this cannot silently decay into the already-covered live-Cell case.
    // `isLink` is not enough — it accepts a live Cell too.
    expect(isLink(raw.db)).toBe(true);
    expect(isCell(raw.db)).toBe(false);

    const restore = (destination: JSONSchema) =>
      assertSuppliedLinkSchemasCompatible(
        [{ path: ["db"], value: raw.db }],
        destination,
        base,
        pieces,
        {
          priorArgumentSchema: argumentSchema,
          linksPreservedVerbatim: true,
        },
      );

    expect(() => restore(argumentSchema)).not.toThrow();

    // Same kind, narrowed payload the source already satisfies.
    expect(() =>
      restore({
        type: "object",
        properties: {
          db: { ...sqliteDb, description: "renamed in the new source" },
        },
        required: ["db"],
      })
    ).not.toThrow();

    // Laundering is still refused: the capability may not become a plain
    // alias just because the caller preserves envelopes.
    expect(() =>
      restore({
        type: "object",
        properties: { db: { type: "object", asCell: ["cell"] } },
        required: ["db"],
      })
    ).toThrow(/cannot be exposed as cell/);

    // And a caller that does NOT preserve envelopes is unaffected — the
    // ordinary-alias rule still applies to every other entry point.
    expect(() =>
      assertSuppliedLinkSchemasCompatible(
        [{ path: ["db"], value: raw.db }],
        argumentSchema,
        base,
        pieces,
        { priorArgumentSchema: argumentSchema },
      )
    ).toThrow(/sqlite capability cannot be exposed as an ordinary alias/);

    // And the declaration is scoped by committed state, not taken on trust:
    // the same serialized link supplied at a path where it is NOT already
    // committed is a fresh link riding the restore — the staged argument on
    // a source update is the previous argument merged with the INCOMING
    // pattern's schema defaults, so link-shaped defaults arrive exactly this
    // way — and it faces the rebuild rules despite the flag: the identical
    // bytes that restore fine at `db` are refused at `db2`.
    const twoSlotSchema: JSONSchema = {
      type: "object",
      properties: { db: sqliteDb, db2: sqliteDb },
      required: ["db"],
    };
    expect(() =>
      assertSuppliedLinkSchemasCompatible(
        [{ path: ["db2"], value: raw.db }],
        twoSlotSchema,
        base,
        pieces,
        {
          priorArgumentSchema: twoSlotSchema,
          linksPreservedVerbatim: true,
        },
      )
    ).toThrow(/sqlite capability cannot be exposed as an ordinary alias/);
  });

  it("restores retained links whose payload nests a Cell-typed property", async () => {
    // The roster shape: a plain array element whose `profile` field is a
    // Cell (`asCell: ["cell"]`). The element link's contract carries the
    // nested wrapper; the non-preserving path sanitizes it away from the
    // SOURCE side only, and the exact-match `asCell` comparison then refused
    // the destination's own wrapper — so a piece whose roster held one such
    // element could never have its source updated in place, even with the
    // byte-identical source (`asCell changed` at participants.0.profile).
    // Nested non-stream wrappers are read-side projections, so the proof
    // sees both sides through the same sanitizing lens.
    const profileSchema: JSONSchema = {
      type: "object",
      properties: { name: { type: "string" }, avatar: { type: "string" } },
    };
    const elementSchema: JSONSchema = {
      type: "object",
      properties: {
        name: { type: "string" },
        profile: { ...profileSchema, asCell: ["cell"] },
      },
      required: ["name", "profile"],
    };
    const argumentSchema: JSONSchema = {
      type: "object",
      properties: {
        participants: { type: "array", items: elementSchema },
      },
      required: ["participants"],
    };

    const profileDoc = runtime.getCell(
      pieces.getSpace(),
      "roster-profile-" + crypto.randomUUID(),
    );
    await runtime.editWithRetry((tx) => {
      profileDoc.withTx(tx).set({ name: "Robin", avatar: "" });
    });
    const element = runtime.getCell(
      pieces.getSpace(),
      "roster-element-" + crypto.randomUUID(),
    );
    await runtime.editWithRetry((tx) => {
      element.withTx(tx).set({ name: "Robin", profile: profileDoc });
    });
    const base = runtime.getCell(
      pieces.getSpace(),
      "roster-argument-" + crypto.randomUUID(),
    );
    await runtime.editWithRetry((tx) => {
      base.withTx(tx).set({ participants: [element] });
    });

    const raw = base.getRaw() as { participants: unknown[] };
    // Guard the premise: the restore path sees a SERIALIZED link.
    expect(isLink(raw.participants[0])).toBe(true);
    expect(isCell(raw.participants[0])).toBe(false);

    // The source-update call-site shape: `setPattern` declares
    // `linksPreservedVerbatim`, but the element's slot declares no outer Cell
    // wrapper, so the preserve branch never engages and the link faces the
    // sanitizing proof regardless — which is exactly how a source update
    // reaches the asymmetry this test pins.
    expect(() =>
      assertSuppliedLinkSchemasCompatible(
        [{ path: ["participants", 0], value: raw.participants[0] }],
        argumentSchema,
        base,
        pieces,
        {
          priorArgumentSchema: argumentSchema,
          linksPreservedVerbatim: true,
        },
      )
    ).not.toThrow();

    // Without the flag the same proof runs: a nested wrapper the destination
    // declares does not demand one from the source's payload contract.
    expect(() =>
      assertSuppliedLinkSchemasCompatible(
        [{ path: ["participants", 0], value: raw.participants[0] }],
        argumentSchema,
        base,
        pieces,
        { priorArgumentSchema: argumentSchema },
      )
    ).not.toThrow();
  });

  it("refuses a preserved link whose carried wrapper widens its contract", async () => {
    // The envelope on a SERIALIZED link is caller-written bytes. Declaring
    // that links are preserved verbatim must not become a way to smuggle a
    // forged `asCell` past the check the rebuild branch performs. Two layers
    // refuse it: a forged envelope that was never committed loses preserve
    // status outright (it is not the committed bytes at its path) and faces
    // the rebuild rules; and even a COMMITTED forged envelope — raw write
    // paths like `PiecesController.link` commit links without ever running this
    // validator — is caught by the preserve branch's own wrapper check.
    const readonlyNum: JSONSchema = { type: "number", asCell: ["readonly"] };
    const argumentSchema: JSONSchema = {
      type: "object",
      properties: { v: readonlyNum },
      required: ["v"],
    };

    const producer = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: { type: "object", properties: {} },
        resultSchema: {
          type: "object",
          properties: { v: { type: "number" } },
          required: ["v"],
        },
        result: { v: 1 },
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    await runtime.editWithRetry((tx) => {
      producer.withTx(tx).setMetaRaw(
        "schema",
        argumentSchema,
        rawMetaWriteAuthorization,
      );
    });

    const base = runtime.getCell(
      pieces.getSpace(),
      "forged-wrapper-argument-" + crypto.randomUUID(),
    );
    await runtime.editWithRetry((tx) => {
      base.withTx(tx).set({ v: producer.key("v") });
    });

    const raw = base.getRaw() as { v: Record<string, never> };
    const forged = JSON.parse(JSON.stringify(raw.v));
    const envelope = forged["/"]?.["link@1"];
    // Guard the premise: we really are forging a wire envelope.
    expect(envelope).toBeDefined();
    envelope.schema = { type: "number", asCell: ["cell"] };

    const supplyForged = () =>
      assertSuppliedLinkSchemasCompatible(
        [{ path: ["v"], value: forged }],
        argumentSchema,
        base,
        pieces,
        {
          priorArgumentSchema: argumentSchema,
          linksPreservedVerbatim: true,
        },
      );

    // Layer 1: never committed — the forgery is not the committed bytes at
    // its path, so the flag does not apply and the rebuild rules refuse the
    // capability slot outright.
    expect(supplyForged).toThrow(/cannot be exposed as an ordinary alias/);

    // Layer 2: commit the forgery raw (as an unvalidated write path would),
    // making it identical to committed state — the preserve branch's own
    // wrapper check still refuses the non-durable envelope.
    await runtime.editWithRetry((tx) => {
      base.withTx(tx).key("v").setRawUntyped(forged);
    });
    expect(supplyForged).toThrow(/non-durable Cell wrapper/);
  });

  it("restores a retained ordinary Cell link across a source update", async () => {
    // The same defect with a different error message (`asCell changed`), which
    // is why fixing only the capability wording would have left the class
    // half-broken: ANY `asCell`-declaring input slot was un-restorable.
    const counter: JSONSchema = { type: "number", asCell: ["cell"] };
    const argumentSchema: JSONSchema = {
      type: "object",
      properties: { count: counter },
      required: ["count"],
    };

    const producer = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: { type: "object", properties: {} },
        resultSchema: {
          type: "object",
          properties: { count: { type: "number" } },
          required: ["count"],
        },
        result: { count: 3 },
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );

    const base = runtime.getCell(
      pieces.getSpace(),
      "ordinary-cell-argument-" + crypto.randomUUID(),
    );
    await runtime.editWithRetry((tx) => {
      base.withTx(tx).set({ count: producer.key("count") });
    });

    const raw = base.getRaw() as { count: unknown };
    expect(isCell(raw.count)).toBe(false);

    expect(() =>
      assertSuppliedLinkSchemasCompatible(
        [{ path: ["count"], value: raw.count }],
        argumentSchema,
        base,
        pieces,
        {
          priorArgumentSchema: argumentSchema,
          linksPreservedVerbatim: true,
        },
      )
    ).not.toThrow();
  });

  it("fails closed for ambiguous producer and destination Cell contracts", async () => {
    const ordinarySourceSchema: JSONSchema = {
      type: "object",
      properties: { value: { type: "number" } },
      required: ["value"],
    };
    const makeSource = async (schema: JSONSchema) => {
      const source = await pieces.runPersistent(
        trustPattern(runtime, {
          argumentSchema: { type: "object", properties: {} },
          resultSchema: ordinarySourceSchema,
          result: { value: 7 },
          nodes: [],
        }),
        {},
        undefined,
        { start: true },
      );
      await runtime.editWithRetry((tx) => {
        source.withTx(tx).setMetaRaw(
          "schema",
          schema,
          rawMetaWriteAuthorization,
        );
      });
      return source;
    };
    const base = runtime.getCell(
      pieces.getSpace(),
      "link-contract-base-" + crypto.randomUUID(),
    );
    const supplied = (source: typeof base) => [{
      path: [],
      value: source.key("value"),
    }];

    const ordinary = await makeSource(ordinarySourceSchema);
    const recursiveTarget = {} as { anyOf?: JSONSchema[] };
    recursiveTarget.anyOf = [recursiveTarget as JSONSchema];
    expect(() =>
      assertSuppliedLinkSchemasCompatible(
        supplied(ordinary),
        recursiveTarget as JSONSchema,
        base,
        pieces,
      )
    ).toThrow(/recursive Cell schema/);

    const incompatibleOuter: JSONSchema = {
      type: "object",
      properties: {
        value: {
          anyOf: [
            { type: "number", asCell: ["readonly"] },
            { type: "number", asCell: ["writeonly"] },
          ],
        },
      },
      required: ["value"],
    };
    const incompatible = await makeSource(incompatibleOuter);
    expect(() =>
      assertSuppliedLinkSchemasCompatible(
        supplied(incompatible),
        { type: "number" },
        base,
        pieces,
      )
    ).toThrow(/incompatible outer capabilities/);
    expect(() =>
      assertSuppliedLinkSchemasCompatible(
        supplied(incompatible),
        { type: "number", asCell: ["cell"] },
        base,
        pieces,
      )
    ).toThrow(/incompatible outer capabilities/);

    const conflictingOuter: JSONSchema = {
      type: "object",
      properties: {
        value: { type: "number", asCell: ["cell"] },
      },
      patternProperties: {
        "^value$": { type: "number", asCell: ["readonly"] },
      },
      required: ["value"],
    };
    const conflicting = await makeSource(conflictingOuter);
    expect(() =>
      assertSuppliedLinkSchemasCompatible(
        supplied(conflicting),
        { type: "number" },
        base,
        pieces,
      )
    ).toThrow(/source Cell constraints disagree/);
    expect(() =>
      assertSuppliedLinkSchemasCompatible(
        supplied(conflicting),
        { type: "number", asCell: ["cell"] },
        base,
        pieces,
      )
    ).toThrow(/source Cell constraints disagree/);
  });

  it("fails closed when the producer contract stops at a scalar ancestor", async () => {
    // A supplied link that reaches THROUGH a scalar slot of its producer's
    // durable schema has no derivable source contract: the contract walk in
    // `buildSourceContracts` fails, and that failure must surface as the
    // uniform supplied-link rejection rather than escaping unwrapped.
    const scalarAncestorSchema: JSONSchema = {
      type: "object",
      properties: { value: { type: "number" } },
      required: ["value"],
    };
    const source = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: { type: "object", properties: {} },
        resultSchema: scalarAncestorSchema,
        result: { value: 7 },
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    await runtime.editWithRetry((tx) => {
      source.withTx(tx).setMetaRaw(
        "schema",
        scalarAncestorSchema,
        rawMetaWriteAuthorization,
      );
    });
    const base = runtime.getCell(
      pieces.getSpace(),
      "scalar-ancestor-base-" + crypto.randomUUID(),
    );
    expect(() =>
      assertSuppliedLinkSchemasCompatible(
        [{ path: [], value: source.key("value").key("deep") }],
        true,
        base,
        pieces,
      )
    ).toThrow(
      /input link at <root> schema is not compatible: schema does not describe a container at deep/,
    );
  });

  it("recovers only producer-owned argument and internal contracts", async () => {
    const piece = await pieces.runPersistent(
      trustPattern(runtime, doublePattern()),
      { input: 5 },
      undefined,
      { start: true },
    );
    const internalCell = piece.key("output").resolveAsCell();
    const originalInternal = piece.getMetaRaw("internal");
    expect(Array.isArray(originalInternal)).toBe(true);
    const unrelated = runtime.getCell(
      pieces.getSpace(),
      "unrelated-internal-" + crypto.randomUUID(),
      { type: "number" },
    );
    const orphan = runtime.getCell(
      pieces.getSpace(),
      "orphan-internal-" + crypto.randomUUID(),
      { type: "number" },
    );

    await runtime.editWithRetry((tx) => {
      piece.withTx(tx).setMetaRaw("internal", [
        null,
        {},
        { link: "malformed" },
        {
          link: unrelated.withTx(tx).getAsWriteRedirectLink({
            base: piece.withTx(tx),
            includeSchema: true,
          }),
        },
        ...(originalInternal as FabricValue[]),
      ], rawMetaWriteAuthorization);
      orphan.withTx(tx).setMetaRaw(
        "result",
        piece.withTx(tx).getAsWriteRedirectLink({
          base: orphan.withTx(tx),
          includeSchema: true,
        }),
        rawMetaWriteAuthorization,
      );
    });

    expect(durableSourceContract(internalCell, pieces)?.schemas.length)
      .toBeGreaterThan(0);
    expect(durableSourceContract(orphan, pieces)).toBeUndefined();
  });

  it("terminates projection reconciliation cycles", async () => {
    const source = runtime.getCell(
      pieces.getSpace(),
      "projection-cycle-source-" + crypto.randomUUID(),
    );
    const base = runtime.getCell(
      pieces.getSpace(),
      "projection-cycle-base-" + crypto.randomUUID(),
    );

    await runtime.editWithRetry((tx) => {
      source.withTx(tx).setRawUntyped(7);
      const sourceWithTx = source.withTx(tx);
      const baseWithTx = base.withTx(tx);
      const normalized = sourceWithTx.getAsNormalizedFullLink();
      const resolving = new Set([JSON.stringify([
        normalized.space,
        normalized.id,
        normalized.scope,
        normalized.path,
      ])]);
      expect(
        omitMissingProjectionAliases(
          "already-materialized",
          sourceWithTx.getAsLink({
            base: baseWithTx,
            includeSchema: false,
          }),
          undefined,
          baseWithTx,
          pieces,
          true,
          [],
          undefined,
          resolving,
        ),
      ).toBe("already-materialized");
    });
  });

  it("rejects writes redirected to cells without producer contracts", async () => {
    const target = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          type: "object",
          properties: { slot: { type: "number" } },
          required: ["slot"],
        },
        resultSchema: { type: "object", properties: {} },
        result: {},
        nodes: [],
      }),
      { slot: 0 },
      undefined,
      { start: true },
    );
    const orphan = runtime.getCell(
      pieces.getSpace(),
      "redirect-without-contract-" + crypto.randomUUID(),
      { type: "number" },
    );
    const argument = pieces.getArgument(target);
    await runtime.editWithRetry((tx) => {
      const argumentWithTx = argument.withTx(tx);
      orphan.withTx(tx).set(1);
      argumentWithTx.key("slot").setRawUntyped(
        orphan.withTx(tx).getAsWriteRedirectLink({
          base: argumentWithTx.key("slot"),
          includeSchema: true,
        }),
      );
    });

    await expect(
      new PieceController(pieces, target).input.set(2, ["slot"]),
    ).rejects.toThrow(/write destination has no durable schema contract/);
    expect(orphan.get()).toBe(1);
  });

  it("exposes source provenance and Piece dependency relationships", async () => {
    const sourceProgram = compiledMultiplierProgram("source", 2);
    const source = await pieces.runPersistent(
      await runtime.patternManager.compilePattern(sourceProgram, {
        space: pieces.getSpace(),
      }),
      { input: 5 },
      undefined,
      { start: true },
    );
    const target = await pieces.runPersistent(
      trustPattern(runtime, doublePattern()),
      { input: 1 },
      undefined,
      { start: true },
    );
    const sourceController = new PieceController(pieces, source);
    const targetController = new PieceController(pieces, target);

    expect((await sourceController.getPatternSourceProgram())?.files).toEqual(
      sourceProgram.files,
    );
    expect(await targetController.getPatternSourceProgram()).toBeUndefined();

    await pieces.link(
      sourceController.id,
      ["output"],
      targetController.id,
      ["input"],
    );
    const originalGetPieceRegistry = pieces.getPieceRegistry.bind(pieces);
    pieces.getPieceRegistry = () =>
      Promise.resolve({
        get: () => [source, target],
      } as unknown as Awaited<ReturnType<typeof pieces.getPieceRegistry>>);
    try {
      expect((await targetController.readingFrom()).map((piece) => piece.id))
        .toEqual([sourceController.id]);
      expect((await sourceController.readBy()).map((piece) => piece.id))
        .toEqual([targetController.id]);
    } finally {
      pieces.getPieceRegistry = originalGetPieceRegistry;
    }
  });

  it("loads a pattern through a document-bounded result cell", async () => {
    const pattern = await runtime.patternManager.compilePattern(
      compiledMultiplierProgram("bounded-pattern-load", 2),
      { space: pieces.getSpace() },
    );
    const piece = await pieces.runPersistent(
      pattern,
      { input: 5 },
      undefined,
      { start: false },
    );
    const schemas: unknown[] = [];
    const originalAsSchema = piece.asSchema.bind(piece);
    piece.asSchema = ((schema: unknown) => {
      schemas.push(schema);
      return originalAsSchema(schema as never);
    }) as typeof piece.asSchema;

    const controller = new PieceController(pieces, piece);
    expect(await controller.getPattern({ projectResult: false })).toBe(pattern);
    expect(schemas).toEqual([undefined]);
    // The default keeps the projection: no schema-less sibling is synced.
    schemas.length = 0;
    expect(await controller.getPattern()).toBe(pattern);
    expect(schemas).toEqual([]);
  });

  it("keeps pattern content refs useful when source programs are unavailable", async () => {
    const identityless = runtime.getCell(
      pieces.getSpace(),
      "identityless-piece-" + crypto.randomUUID(),
      { type: "object", properties: {} },
    );
    expect(await new PieceController(pieces, identityless).getPatternRef())
      .toBeUndefined();

    const program = compiledMultiplierProgram("unavailable-source", 2);
    const piece = await pieces.runPersistent(
      await runtime.patternManager.compilePattern(program, {
        space: pieces.getSpace(),
      }),
      { input: 5 },
      undefined,
      { start: true },
    );
    const controller = new PieceController(pieces, piece);
    const identityRef = getPatternIdentityRef(piece)!;
    const contentOnlyRef = {
      ...identityRef,
      source: { ref: `cf:pattern:${identityRef.identity}` },
    };
    const originalLookup = runtime.patternManager
      .getPatternSourceProgramByIdentity.bind(runtime.patternManager);

    try {
      runtime.patternManager.getPatternSourceProgramByIdentity = () =>
        Promise.resolve(undefined);
      expect(await controller.getPatternRef()).toEqual(contentOnlyRef);

      runtime.patternManager.getPatternSourceProgramByIdentity = () =>
        Promise.reject(new Error("source unavailable"));
      expect(await controller.getPatternRef()).toEqual(contentOnlyRef);
    } finally {
      runtime.patternManager.getPatternSourceProgramByIdentity = originalLookup;
    }
  });

  it("distinguishes absent setup patterns from unknown stored identities", async () => {
    const emptyPiece = runtime.getCell(
      pieces.getSpace(),
      "missing-setup-pattern-" + crypto.randomUUID(),
      { type: "object", properties: {} },
    );
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
    try {
      await runtime.setup(undefined, undefined, {}, emptyPiece);
    } finally {
      console.warn = originalWarn;
    }
    expect(warnings).toEqual([
      "No pattern provided and no pattern found in result metadata. Not running.",
    ]);

    const unknownPiece = runtime.getCell(
      pieces.getSpace(),
      "unknown-setup-pattern-" + crypto.randomUUID(),
      { type: "object", properties: {} },
    );
    await runtime.editWithRetry((tx) => {
      unknownPiece.withTx(tx).setMetaRaw("patternIdentity", {
        identity: "Z".repeat(43),
        symbol: "default",
      }, rawMetaWriteAuthorization);
    });

    await expect(runtime.setup(undefined, undefined, {}, unknownPiece))
      .rejects.toThrow(`Unknown pattern: ${"Z".repeat(43)}#default`);
  });

  it("pulls before reading result values", async () => {
    const piece = await pieces.runPersistent(
      trustPattern(runtime, doublePattern()),
      { input: 5 },
      undefined,
      { start: true },
    );
    const controller = new PieceController(pieces, piece);
    const inputCell = await controller.input.getCell();

    await runtime.editWithRetry((tx) => {
      inputCell.withTx(tx).key("input").set(7);
    });

    expect(await controller.result.get(["output"])).toBe(14);
  });

  it("does not pull the input root for a selected path", async () => {
    const piece = await pieces.runPersistent(
      trustPattern(runtime, doublePattern()),
      { input: 5 },
      undefined,
      { start: true },
    );
    const controller = new PieceController(pieces, piece);
    await withInputRootPullSpy(pieces, piece, async (rootPulls) => {
      expect(await controller.input.get(["input"])).toBe(5);
      expect(rootPulls()).toBe(0);

      expect(await controller.input.get()).toEqual({ input: 5 });
      expect(rootPulls()).toBe(1);
    });
  });

  it("pulls a selected asCell value without pulling the input root", async () => {
    const sourcePiece = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: { type: "object", properties: {} },
        resultSchema: {
          type: "object",
          properties: { value: { type: "number" } },
          required: ["value"],
        },
        result: { value: 7 },
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    const targetPiece = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          type: "object",
          properties: {
            handle: { type: "number", asCell: ["cell"] },
          },
          required: ["handle"],
        },
        resultSchema: { type: "object", properties: {} },
        result: {},
        nodes: [],
      }),
      { handle: sourcePiece.key("value") },
      undefined,
      { start: true },
    );
    const controller = new PieceController(pieces, targetPiece);
    await withInputRootPullSpy(pieces, targetPiece, async (rootPulls) => {
      expect(await controller.input.get(["handle"])).toBe(7);
      expect(rootPulls()).toBe(0);
    });
  });

  it("narrows a multi-segment input path without pulling the root", async () => {
    const piece = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          type: "object",
          properties: {
            section: {
              type: "object",
              properties: { value: { type: "number" } },
              required: ["value"],
            },
          },
          required: ["section"],
        },
        resultSchema: { type: "object", properties: {} },
        result: {},
        nodes: [],
      }),
      { section: { value: 7 } },
      undefined,
      { start: true },
    );
    const controller = new PieceController(pieces, piece);

    await withInputRootPullSpy(pieces, piece, async (rootPulls) => {
      expect(await controller.input.get(["section", "value"])).toBe(7);
      expect(rootPulls()).toBe(0);
    });
  });

  it("re-roots a narrow path through an intermediate asCell", async () => {
    const sourcePiece = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: { type: "object", properties: {} },
        resultSchema: {
          type: "object",
          properties: {
            details: {
              type: "object",
              properties: { value: { type: "number" } },
              required: ["value"],
            },
          },
          required: ["details"],
        },
        result: { details: { value: 7 } },
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    const targetPiece = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          type: "object",
          properties: {
            handle: {
              type: "object",
              properties: { value: { type: "number" } },
              required: ["value"],
              asCell: ["cell"],
            },
          },
          required: ["handle"],
        },
        resultSchema: { type: "object", properties: {} },
        result: {},
        nodes: [],
      }),
      { handle: sourcePiece.key("details") },
      undefined,
      { start: true },
    );
    const controller = new PieceController(pieces, targetPiece);

    await withInputRootPullSpy(pieces, targetPiece, async (rootPulls) => {
      expect(await controller.input.get(["handle", "value"])).toBe(7);
      expect(rootPulls()).toBe(0);
    });
  });

  it("re-roots through compound intermediate asCell schemas", async () => {
    const detailsSchema = {
      type: "object",
      properties: {
        kind: { const: "number" },
        value: { type: "number" },
      },
      required: ["kind", "value"],
    } as const satisfies JSONSchema;
    const compoundCellSchema = {
      anyOf: [
        { ...detailsSchema, asCell: ["cell"] },
        {
          type: "object",
          properties: {
            kind: { const: "text" },
            value: { type: "string" },
          },
          required: ["kind", "value"],
          asCell: ["cell"],
        },
      ],
    } as const satisfies JSONSchema;
    const targetPiece = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          type: "object",
          properties: { handle: compoundCellSchema },
          required: ["handle"],
        },
        resultSchema: { type: "object", properties: {} },
        result: {},
        nodes: [],
      }),
      { handle: { kind: "number", value: 7 } },
      undefined,
      { start: true },
    );
    const controller = new PieceController(pieces, targetPiece);

    await withInputRootPullSpy(pieces, targetPiece, async (rootPulls) => {
      expect(await controller.input.get(["handle", "value"])).toBe(7);
      expect(rootPulls()).toBe(0);
    });
  });

  it("refuses an undeclared path without pulling the input root", async () => {
    const piece = await pieces.runPersistent(
      trustPattern(runtime, doublePattern()),
      { input: 5 },
      undefined,
      { start: true },
    );
    const controller = new PieceController(pieces, piece);

    await withInputRootPullSpy(pieces, piece, async (rootPulls) => {
      await expect(controller.input.get(["missing"])).rejects.toThrow(
        'Cannot access path "missing" - property "missing" not found',
      );
      expect(rootPulls()).toBe(0);
    });
  });

  it("preserves schema-valid undefined through the narrow fallback", async () => {
    const piece = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          type: "object",
          properties: {
            value: {
              anyOf: [{ type: "number" }, { type: "undefined" }],
            },
          },
          required: ["value"],
        },
        resultSchema: { type: "object", properties: {} },
        result: {},
        nodes: [],
      }),
      { value: undefined },
      undefined,
      { start: true },
    );
    const controller = new PieceController(pieces, piece);

    await withInputRootPullSpy(pieces, piece, async (rootPulls) => {
      expect(await controller.input.get(["value"])).toBeUndefined();
      expect(rootPulls()).toBe(1);
    });
  });

  it("preserves missing-path diagnostics for an absent asCell slot", async () => {
    const piece = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          type: "object",
          properties: {
            handle: { type: "number", asCell: ["cell"] },
          },
        },
        resultSchema: { type: "object", properties: {} },
        result: {},
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    const controller = new PieceController(pieces, piece);

    await withInputRootPullSpy(pieces, piece, async (rootPulls) => {
      await expect(controller.input.get(["handle"])).rejects.toThrow(
        'Cannot access path "handle" - property "handle" not found',
      );
      expect(rootPulls()).toBe(1);
    });
  });

  it("preserves explicit undefined for an asCell slot", async () => {
    const piece = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          type: "object",
          properties: {
            handle: {
              anyOf: [{ type: "number" }, { type: "undefined" }],
              asCell: ["cell"],
            },
          },
          required: ["handle"],
        },
        resultSchema: { type: "object", properties: {} },
        result: {},
        nodes: [],
      }),
      { handle: undefined },
      undefined,
      { start: true },
    );
    const controller = new PieceController(pieces, piece);

    await withInputRootPullSpy(pieces, piece, async (rootPulls) => {
      expect(await controller.input.get(["handle"])).toBeUndefined();
      expect(rootPulls()).toBe(1);
    });
  });

  it("materializes piece results before setInput returns", async () => {
    const piece = await pieces.runPersistent(
      trustPattern(runtime, doublePattern()),
      { input: 5 },
      undefined,
      { start: true },
    );
    const controller = new PieceController(pieces, piece);

    await controller.setInput({ input: 7 });

    expect(pieces.getResult(piece).get()).toEqual({ output: 14 });
  });

  it("rejects setInput values outside the current argument schema", async () => {
    const piece = await pieces.runPersistent(
      trustPattern(runtime, doublePattern()),
      { input: 5 },
      undefined,
      { start: true },
    );
    const controller = new PieceController(pieces, piece);

    await expect(
      controller.setInput({ input: "wrong" } as unknown as { input: number }),
    ).rejects.toThrow(/updated arguments do not match the candidate schema/);
    expect((await controller.input.getCell()).getRaw()).toEqual({ input: 5 });
    expect(await controller.result.get()).toEqual({ output: 10 });

    await pieces.stopPiece(piece);
    await expect(
      controller.setInput({ input: "still wrong" } as unknown as {
        input: number;
      }),
    ).rejects.toThrow(/updated arguments do not match the candidate schema/);
    expect((await controller.input.getCell()).getRaw()).toEqual({ input: 5 });
  });

  it("validates path-based input writes against the current schema", async () => {
    const piece = await pieces.runPersistent(
      trustPattern(runtime, doublePattern()),
      { input: 5 },
      undefined,
      { start: true },
    );
    const controller = new PieceController(pieces, piece);

    await controller.input.set(7, ["input"]);
    expect(await controller.input.get()).toEqual({ input: 7 });
    expect(await controller.result.get()).toEqual({ output: 14 });

    await expect(controller.input.set("invalid", ["input"])).rejects.toThrow(
      /updated input does not match its schema/,
    );
    await expect(controller.input.set(new Date(), ["input"])).rejects.toThrow(
      /updated input does not match its schema/,
    );
    expect(await controller.input.get()).toEqual({ input: 7 });

    await controller.result.set(99, ["output"]);
    expect(await controller.result.get()).toEqual({ output: 99 });
  });

  it("ignores missing optional result aliases when validating a path write", async () => {
    const model = {
      type: "object",
      properties: {
        value: { type: "number" },
        arrayField: { type: "array", items: { type: "number" } },
      },
      required: ["value"],
    } as const;
    const pattern: Pattern = {
      argumentSchema: model,
      resultSchema: model,
      result: {
        value: { $alias: { cell: "argument", path: ["value"] } },
        arrayField: {
          $alias: { cell: "argument", path: ["arrayField"] },
        },
      },
      nodes: [],
    };
    const piece = await pieces.runPersistent(
      trustPattern(runtime, pattern),
      { value: 1 },
      undefined,
      { start: true },
    );
    const controller = new PieceController(pieces, piece);

    expect(await controller.result.get()).toEqual({ value: 1 });
    await controller.result.set(2, ["value"]);
    expect(await controller.result.get()).toEqual({ value: 2 });

    await expect(controller.result.set("bad", ["value"])).rejects.toThrow(
      /updated (result|value) does not match its schema/,
    );
    expect(await controller.result.get()).toEqual({ value: 2 });
  });

  it("an ABSENT unrelated required property does not invalidate a path write — the ON-arm server-derived-late shape (RULED 2026-08-07)", async () => {
    // The ruled scenario verbatim: under EXPERIMENTAL_SERVER_EXECUTION
    // a fresh client's local view legitimately LACKS server-derived
    // required properties ($NAME et al) when it writes an unrelated
    // property. The whole-result validation failed this with `missing
    // required property`; the narrowed guard validates only the
    // written subtree, so the write succeeds. (Stale-view fixture: the
    // required sibling simply never materializes locally.)
    const resultSchema = {
      type: "object",
      properties: {
        value: { type: "number" },
        name: { type: "string" },
      },
      required: ["value", "name"],
    } as const;
    const piece = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: { type: "object", properties: {} },
        resultSchema,
        // `name` is REQUIRED by the schema but absent from the local
        // view — the server-derived-late shape.
        result: { value: 1 },
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    const controller = new PieceController(pieces, piece);
    await controller.result.set(2, ["value"]);
    // Raw readback: the schema-typed get validates the WHOLE object
    // and reads undefined while the required sibling is still absent —
    // exactly the local view the ruled write succeeds against.
    expect((piece.getRaw() as { value?: number }).value).toBe(2);
    // The written value's own protection still binds.
    await expect(controller.result.set("bad", ["value"])).rejects.toThrow(
      /updated (result|value) does not match its schema/,
    );
  });

  it("a nested result write cannot extend an array past its parent maxItems — ancestor container cardinality survives the narrowed guard (r3739139515)", async () => {
    // The narrowed path-only contract validates the LEAF; pre-fix a
    // write to items[3] of a maxItems:3 array passed leaf validation
    // and persisted a 4-element array the schema forbids. The
    // cardinality re-check binds ONLY minItems/maxItems on ancestors
    // of the written path — never the unrelated-sibling validation the
    // ruling removed.
    const resultSchema = {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: { type: "number" },
          maxItems: 3,
        },
        name: { type: "string" },
      },
      // `name` REQUIRED but server-derived-late (absent locally): its
      // absence must NOT block the container check's error, nor a
      // legal in-bounds write — the ruling's narrowing stands.
      required: ["items", "name"],
    } as const;
    const piece = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: { type: "object", properties: {} },
        resultSchema,
        result: { items: [1, 2] },
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    const controller = new PieceController(pieces, piece);
    // In-bounds nested writes stay legal (index 2 fills to maxItems),
    // even with the required sibling still absent.
    await controller.result.set(9, ["items", "2"]);
    expect((piece.getRaw() as { items?: number[] }).items).toEqual(
      [1, 2, 9],
    );
    // Out-of-bounds extension: refused by the CONTAINER stage.
    await expect(controller.result.set(4, ["items", "3"])).rejects.toThrow(
      /updated value does not match its container at \["items"\]/,
    );
    expect((piece.getRaw() as { items?: number[] }).items).toEqual(
      [1, 2, 9],
    );
  });

  it("an invalid UNRELATED sibling does not invalidate a valid path write (the narrowed #4717 guard — RULED 2026-08-07)", async () => {
    // RECONCILED with the set-validation ruling: the pre-ruling test
    // pinned the WHOLE-RESULT validation deliberately (an invalid raw
    // sibling made an unrelated path write throw). That over-reach is
    // the mechanism that made a fresh ON-arm client's property write
    // fail on server-derived-late unrelated required properties, so
    // the guard now validates ONLY the written subtree — the same
    // rationale the stream branch always carried ("unrelated result
    // projections … cannot invalidate an otherwise valid event"). The
    // written value's own protection stays (the sibling tests above
    // and below still throw on invalid WRITTEN values).
    const resultSchema = {
      type: "object",
      properties: {
        a: { type: "number" },
        b: { type: "number" },
      },
      required: ["a"],
    } as const;
    const piece = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: { type: "object", properties: {} },
        resultSchema,
        result: { a: 1, b: 2 },
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    await runtime.editWithRetry((tx) => {
      piece.withTx(tx).key("b").setRawUntyped("bad");
    });
    const controller = new PieceController(pieces, piece);

    expect(piece.get()).toEqual({ a: 1 });
    expect(piece.getRaw()).toEqual({ a: 1, b: "bad" });
    // The VALID write at ["a"] succeeds regardless of the invalid
    // sibling…
    await controller.result.set(3, ["a"]);
    expect(piece.get()).toEqual({ a: 3 });
    // …and an INVALID write at ["a"] still throws (#4717's protection,
    // narrowed to the written path).
    await expect(controller.result.set("bad", ["a"])).rejects.toThrow(
      /updated (result|value) does not match its schema/,
    );
  });

  it("does not hide present explicit undefined behind an optional alias", async () => {
    const model = {
      type: "object",
      properties: {
        a: { type: "number" },
        b: { type: "number" },
      },
      required: ["a"],
    } as const;
    const piece = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: model,
        resultSchema: model,
        result: {
          a: { $alias: { cell: "argument", path: ["a"] } },
          b: { $alias: { cell: "argument", path: ["b"] } },
        },
        nodes: [],
      }),
      { a: 1 },
      undefined,
      { start: true },
    );
    await runtime.editWithRetry((tx) => {
      pieces.getArgument(piece).withTx(tx).key("b").setRawUntyped(undefined);
    });
    const argument = pieces.getArgument(piece);
    const controller = new PieceController(pieces, piece);

    expect(Object.hasOwn(argument.getRaw() as object, "b")).toBe(true);
    expect(Object.hasOwn(piece.get(), "b")).toBe(false);
    // Post-ruling (the narrowed #4717 guard): the whole-result schema
    // validation no longer fires for the unrelated path — the explicit
    // undefined behind the alias is still NOT hidden, surfaced by the
    // WRITE-DESTINATION validation instead ("updated result does not
    // match its write destination"), which materializes through the
    // alias and catches b on the same write. The regex pins EXACTLY
    // that stage (review thread r3739139525): the previous
    // (schema|write destination) cross-product also accepted the
    // whole-result schema message, so a regression back to the
    // over-reaching validation this ruling removed would have passed.
    await expect(controller.result.set(3, ["a"])).rejects.toThrow(
      /updated (result|value) does not match its write destination/,
    );
    expect(argument.getRaw()).toEqual({ a: 1, b: undefined });
  });

  it("reconciles missing projections through root and nested result aliases", async () => {
    const model = {
      type: "object",
      properties: {
        value: { type: "number" },
        arrayField: { type: "array", items: { type: "number" } },
      },
      required: ["value"],
    } as const;
    const source = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: model,
        resultSchema: model,
        result: {
          value: { $alias: { cell: "argument", path: ["value"] } },
          arrayField: {
            $alias: { cell: "argument", path: ["arrayField"] },
          },
        },
        nodes: [],
      }),
      { value: 1 },
      undefined,
      { start: true },
    );
    const rootTarget = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: { type: "object", properties: {} },
        resultSchema: model,
        result: { value: 0 },
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    const nestedSchema = {
      type: "object",
      properties: { nested: model },
      required: ["nested"],
    } as const;
    const nestedTarget = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: { type: "object", properties: {} },
        resultSchema: nestedSchema,
        result: { nested: { value: 0 } },
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    await runtime.editWithRetry((tx) => {
      rootTarget.withTx(tx).set(source);
      nestedTarget.withTx(tx).key("nested").set(source);
    });

    expect(rootTarget.get()).toEqual({ value: 1 });
    expect(nestedTarget.get()).toEqual({ nested: { value: 1 } });
    await expect(
      new PieceController(pieces, rootTarget).result.set(3, ["value"]),
    ).resolves.toBeUndefined();
    await expect(
      new PieceController(pieces, nestedTarget).result.set(4, [
        "nested",
        "value",
      ]),
    ).resolves.toBeUndefined();
    expect(source.get()).toEqual({ value: 4 });
  });

  it("reconciles a missing optional projection at a cold derived Cell root", async () => {
    const resultSchema = {
      type: "object",
      properties: {
        value: { type: "number" },
        optional: { type: "array", items: { type: "number" } },
      },
      required: ["value"],
    } as const;
    const piece = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: { type: "object", properties: {} },
        resultSchema,
        derivedInternalCells: [{
          partialCause: "optional",
          schema: { type: "array", items: { type: "number" } },
        }],
        result: {
          value: 1,
          optional: {
            $alias: { partialCause: "optional", path: [] },
          },
        },
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    const controller = new PieceController(pieces, piece);

    expect(piece.get()).toEqual({ value: 1 });
    await expect(controller.result.set(2, ["value"]))
      .resolves.toBeUndefined();
    expect(piece.get()).toEqual({ value: 2 });
  });

  it("retains explicit undefined at an optional derived Cell root", async () => {
    const resultSchema = {
      type: "object",
      properties: {
        value: { type: "number" },
        optional: { type: "array", items: { type: "number" } },
      },
      required: ["value"],
    } as const;
    const piece = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: { type: "object", properties: {} },
        resultSchema,
        derivedInternalCells: [{
          partialCause: "optional",
          schema: { type: "array", items: { type: "number" } },
        }],
        result: {
          value: 1,
          optional: {
            $alias: { partialCause: "optional", path: [] },
          },
        },
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    await runtime.editWithRetry((tx) => {
      piece.key("optional").withTx(tx).resolveAsCell()
        .setRawUntyped(undefined);
    });
    const controller = new PieceController(pieces, piece);

    expect(piece.get()).toEqual({ value: 1 });
    // RECONCILED with the set-validation ruling (2026-08-07): the
    // pre-ruling whole-result validation made this unrelated write
    // throw on the sibling's explicit undefined. Under the narrowed
    // guard the valid write at ["value"] succeeds — and the explicit
    // undefined at the derived Cell root is RETAINED, neither hidden
    // nor clobbered by the write.
    await controller.result.set(2, ["value"]);
    expect(piece.get()).toEqual({ value: 2 });
    expect(
      Object.hasOwn(
        (piece.key("optional").resolveAsCell().getRawUntyped() === undefined
          ? { optional: undefined }
          : {}) as object,
        "optional",
      ),
    ).toBe(true);
    // The written value's own protection still binds.
    await expect(controller.result.set("bad", ["value"])).rejects.toThrow(
      /updated (result|value) does not match its schema/,
    );
  });

  it("validates result stream payloads independently of sibling projections", async () => {
    const pattern: Pattern = {
      argumentSchema: {
        type: "object",
        properties: {
          event: { type: "number", asCell: ["stream"] },
        },
        required: ["event"],
      },
      resultSchema: {
        type: "object",
        properties: {
          event: { type: "number", asCell: ["stream"] },
          projection: {
            anyOf: [{
              type: "object",
              properties: {
                type: { type: "string", enum: ["projected"] },
                optionalObject: { type: "object" },
              },
              required: ["type"],
            }],
          },
        },
        required: ["event", "projection"],
      },
      result: {
        event: { $alias: { cell: "argument", path: ["event"] } },
        // This mirrors projections such as $FS: an optional nested alias can
        // materialize as present undefined even though the event is unrelated.
        projection: {
          type: "projected",
          optionalObject: {
            $alias: { cell: "argument", path: ["missing"] },
          },
        },
      },
      nodes: [],
    };
    const piece = await pieces.runPersistent(
      trustPattern(runtime, pattern),
      {},
      undefined,
      { start: true },
    );
    const controller = new PieceController(pieces, piece);
    const stream = pieces.getArgument(piece).key("event");
    const events: unknown[] = [];
    const removeHandler = runtime.scheduler.addEventHandler((_tx, event) => {
      events.push(event);
    }, stream.getAsNormalizedFullLink());

    try {
      await controller.result.set(7, ["event"]);
      await runtime.idle();
      expect(events).toEqual([7]);

      await expect(controller.result.set("bad", ["event"])).rejects.toThrow(
        /updated (result|value) does not match its schema/,
      );
      expect(events).toEqual([7]);
    } finally {
      removeHandler();
    }
  });

  it("fails closed for mixed stream and non-stream result alternatives", async () => {
    for (const keyword of ["anyOf", "oneOf"] as const) {
      const pattern: Pattern = {
        argumentSchema: {
          type: "object",
          properties: {
            event: { type: "number", asCell: ["stream"] },
          },
          required: ["event"],
        },
        resultSchema: {
          type: "object",
          properties: {
            event: {
              [keyword]: [
                { type: "number", asCell: ["stream"] },
                { type: "string" },
              ],
            },
          },
          required: ["event"],
        },
        result: {
          event: { $alias: { cell: "argument", path: ["event"] } },
        },
        nodes: [],
      };
      const piece = await pieces.runPersistent(
        trustPattern(runtime, pattern),
        {},
        undefined,
        { start: true },
      );
      const controller = new PieceController(pieces, piece);
      const stream = pieces.getArgument(piece).key("event");
      const events: unknown[] = [];
      const removeHandler = runtime.scheduler.addEventHandler((_tx, event) => {
        events.push(event);
      }, stream.getAsNormalizedFullLink());

      try {
        const issue = new RegExp(
          `mixed stream and non-stream ${keyword} alternatives`,
        );
        await expect(controller.result.set(7, ["event"])).rejects.toThrow(
          issue,
        );
        await expect(
          controller.result.set("wrong", ["event"]),
        ).rejects.toThrow(issue);
        expect(events).toEqual([]);
      } finally {
        removeHandler();
      }
    }
  });

  it("retains unwrapped allOf constraints on stream payloads", async () => {
    const rootSchema: Pattern["argumentSchema"] = {
      type: "object",
      properties: { event: { $ref: "#/$defs/Event" } },
      required: ["event"],
      $defs: {
        Event: {
          allOf: [
            { $ref: "#/$defs/NumberStream" },
            { minimum: 0 },
          ],
        },
        NumberStream: { type: "number", asCell: ["stream"] },
      },
    };
    const pattern: Pattern = {
      argumentSchema: rootSchema,
      resultSchema: rootSchema,
      result: {
        event: { $alias: { cell: "argument", path: ["event"] } },
      },
      nodes: [],
    };
    const piece = await pieces.runPersistent(
      trustPattern(runtime, pattern),
      {},
      undefined,
      { start: true },
    );
    const controller = new PieceController(pieces, piece);
    const stream = pieces.getArgument(piece).key("event");
    const events: unknown[] = [];
    const removeHandler = runtime.scheduler.addEventHandler((_tx, event) => {
      events.push(event);
    }, stream.getAsNormalizedFullLink());

    try {
      await controller.result.set(5, ["event"]);
      await runtime.idle();
      expect(events).toEqual([5]);
      await expect(controller.result.set(-1, ["event"])).rejects.toThrow(
        /updated (result|value) does not match its schema/,
      );
      expect(events).toEqual([5]);
    } finally {
      removeHandler();
    }
  });

  it("accepts nested Cell handles in result stream events", async () => {
    const eventSchema: Pattern["argumentSchema"] = {
      type: "object",
      properties: {
        handle: { type: "number", asCell: ["cell"] },
      },
      required: ["handle"],
      asCell: ["stream"],
    };
    const pattern: Pattern = {
      argumentSchema: {
        type: "object",
        properties: { event: eventSchema },
        required: ["event"],
      },
      resultSchema: {
        type: "object",
        properties: { event: eventSchema },
        required: ["event"],
      },
      result: {
        event: { $alias: { cell: "argument", path: ["event"] } },
      },
      nodes: [],
    };
    const piece = await pieces.runPersistent(
      trustPattern(runtime, pattern),
      {},
      undefined,
      { start: true },
    );
    const controller = new PieceController(pieces, piece);
    const stream = pieces.getArgument(piece).key("event");
    const events: unknown[] = [];
    const removeHandler = runtime.scheduler.addEventHandler((_tx, event) => {
      events.push(event);
    }, stream.getAsNormalizedFullLink());

    const numberSource = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: { type: "object", properties: {} },
        resultSchema: {
          type: "object",
          properties: { value: { type: "number" } },
          required: ["value"],
        },
        result: { value: 9 },
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    const stringSource = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: { type: "object", properties: {} },
        resultSchema: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
        },
        result: { value: "wrong" },
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    const streamSource = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          type: "object",
          properties: {
            event: { type: "number", asCell: ["stream"] },
          },
          required: ["event"],
        },
        resultSchema: {
          type: "object",
          properties: {
            event: { type: "number", asCell: ["stream"] },
          },
          required: ["event"],
        },
        result: {
          event: { $alias: { cell: "argument", path: ["event"] } },
        },
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );

    try {
      await controller.result.set(
        { handle: numberSource.key("value") },
        ["event"],
      );
      await runtime.idle();
      expect(events).toHaveLength(1);

      await expect(
        controller.result.set(
          { handle: stringSource.key("value") },
          ["event"],
        ),
      ).rejects.toThrow(
        /input link at event.handle.*type string is not accepted/s,
      );
      await expect(
        controller.result.set(
          { handle: streamSource.key("event") },
          ["event"],
        ),
      ).rejects.toThrow(/Stream handle is not accepted as cell/);
      expect(events).toHaveLength(1);
    } finally {
      removeHandler();
    }
  });

  it("validates stale result views against the durable result schema", async () => {
    const initialPattern = await runtime.patternManager.compilePattern(
      compiledResultNarrowingProgram("string | number"),
      { space: pieces.getSpace() },
    );
    const piece = await pieces.runPersistent(
      initialPattern,
      { input: 4 },
      "stale-result-write-" + crypto.randomUUID(),
      { start: true },
    );
    const staleController = new PieceController(pieces, piece);
    const updater = new PieceController(pieces, piece);

    await updater.setPattern(compiledResultNarrowingProgram("number"));
    await expect(
      staleController.result.set("bad", ["value"]),
    ).rejects.toThrow(/updated (result|value) does not match its schema/);
    expect(await updater.result.get(["value"])).toBe(4);
  });

  it("validates a union stream payload before sending exactly one event", async () => {
    const pattern: Pattern = {
      argumentSchema: {
        type: "object",
        properties: {
          slot: { $ref: "#/$defs/Event" },
        },
        required: ["slot"],
        $defs: {
          Event: {
            anyOf: [
              { $ref: "#/$defs/NumberEvent" },
              { $ref: "#/$defs/UndefinedEvent" },
            ],
          },
          NumberEvent: { type: "number", asCell: ["stream"] },
          UndefinedEvent: { type: "undefined", asCell: ["stream"] },
        },
      },
      resultSchema: { type: "object", properties: {} },
      result: {},
      nodes: [],
    };
    const piece = await pieces.runPersistent(
      trustPattern(runtime, pattern),
      {},
      undefined,
      { start: true },
    );
    const controller = new PieceController(pieces, piece);
    const inputCell = await controller.input.getCell();
    const stream = inputCell.key("slot");
    const events: unknown[] = [];
    const removeHandler = runtime.scheduler.addEventHandler((_tx, event) => {
      events.push(event);
    }, stream.getAsNormalizedFullLink());

    try {
      await controller.input.set(5, ["slot"]);
      await runtime.idle();
      expect(events).toEqual([5]);

      await expect(controller.input.set("bad", ["slot"])).rejects.toThrow(
        /does not match/,
      );
      expect(events).toEqual([5]);

      const sourcePiece = await pieces.runPersistent(
        trustPattern(runtime, {
          argumentSchema: { type: "object", properties: {} },
          resultSchema: {
            type: "object",
            properties: { value: { type: "number" } },
            required: ["value"],
          },
          result: { value: 9 },
          nodes: [],
        }),
        {},
        undefined,
        { start: true },
      );
      const source = sourcePiece.key("value");
      const rawLink = source.getAsLink({
        base: inputCell.key("slot"),
        includeSchema: true,
      });
      await controller.input.set(rawLink, ["slot"]);
      await runtime.idle();
      expect(events).toHaveLength(2);

      const broadSource = await pieces.runPersistent(
        trustPattern(runtime, {
          argumentSchema: { type: "object", properties: {} },
          resultSchema: {
            type: "object",
            properties: { value: { type: ["number", "string"] } },
            required: ["value"],
          },
          result: { value: 9 },
          nodes: [],
        }),
        {},
        undefined,
        { start: true },
      );
      await expect(
        controller.input.set(
          broadSource.key("value").getAsLink({
            base: inputCell.key("slot"),
            includeSchema: true,
          }),
          ["slot"],
        ),
      ).rejects.toThrow(/input link.*schema is not compatible/);

      await controller.input.set(undefined, ["slot"]);
      await runtime.idle();
      expect(events).toHaveLength(3);
      expect(Object.hasOwn(events, 2)).toBe(true);
      expect(events[2]).toBeUndefined();
      const rawAfterUndefined = inputCell.asSchema(undefined).get() as {
        slot?: unknown;
      };
      expect(
        Object.hasOwn(rawAfterUndefined, "slot") &&
          rawAfterUndefined.slot === undefined,
      ).toBe(false);
    } finally {
      removeHandler();
    }
  });

  it("accepts an opaque Cell supplied as a path value", async () => {
    const sourcePiece = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: { type: "object", properties: {} },
        resultSchema: {
          type: "object",
          properties: { value: { type: "number" } },
          required: ["value"],
        },
        result: { value: 7 },
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    const source = sourcePiece.key("value");
    const pattern: Pattern = {
      argumentSchema: {
        type: "object",
        properties: {
          handle: { type: "number", asCell: ["cell"] },
        },
      },
      resultSchema: { type: "object", properties: {} },
      result: {},
      nodes: [],
    };
    const piece = await pieces.runPersistent(
      trustPattern(runtime, pattern),
      {},
      undefined,
      { start: true },
    );
    const controller = new PieceController(pieces, piece);

    await controller.input.set(source, ["handle"]);

    expect(await controller.input.get(["handle"])).toBe(7);

    const incompatiblePiece = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: { type: "object", properties: {} },
        resultSchema: {
          type: "object",
          properties: {
            value: { type: ["string", "undefined"] },
          },
        },
        result: {},
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    await expect(
      controller.input.set(incompatiblePiece.key("value"), ["handle"]),
    ).rejects.toThrow(/input link.*schema is not compatible/);

    const nestedPiece = await pieces.runPersistent(
      trustPattern(runtime, {
        ...pattern,
        argumentSchema: {
          type: "object",
          properties: {
            handle: { type: "number", asCell: ["cell", "cell"] },
          },
        },
      }),
      {},
      undefined,
      { start: true },
    );
    await expect(
      new PieceController(pieces, nestedPiece).input.set(source, ["handle"]),
    ).rejects.toThrow(/input link.*schema is not compatible/);

    const readonlyPiece = await pieces.runPersistent(
      trustPattern(runtime, {
        ...pattern,
        argumentSchema: {
          type: "object",
          properties: {
            handle: { type: "number", asCell: ["readonly"] },
          },
        },
      }),
      {},
      undefined,
      { start: true },
    );
    await expect(
      new PieceController(pieces, readonlyPiece).input.set(source, ["handle"]),
    ).resolves.toBeUndefined();
  });

  it("accepts a cold opaque Cell supplied as a path value", async () => {
    const sourcePiece = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: { type: "object", properties: {} },
        resultSchema: {
          type: "object",
          properties: { value: { type: "number" } },
          required: ["value"],
        },
        result: {},
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    const targetPiece = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          type: "object",
          properties: {
            handle: { type: "number", asCell: ["cell"] },
          },
        },
        resultSchema: { type: "object", properties: {} },
        result: {},
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    const controller = new PieceController(pieces, targetPiece);

    await expect(
      controller.input.set(sourcePiece.key("value"), ["handle"]),
    ).resolves.toBeUndefined();
    expect(await controller.input.get(["handle"])).toBeUndefined();
    expect(
      Object.hasOwn(
        pieces.getArgument(targetPiece).getRaw() as object,
        "handle",
      ),
    ).toBe(true);
  });

  it("accepts a cold opaque Cell in a whole setInput value", async () => {
    const payloadSchema = {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    } as const;
    const sourcePiece = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: { type: "object", properties: {} },
        resultSchema: {
          type: "object",
          properties: { value: payloadSchema },
          required: ["value"],
        },
        // The producer contract is durable even while this target is cold.
        result: {},
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    const targetPiece = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          type: "object",
          properties: {
            handle: { ...payloadSchema, asCell: ["cell"] },
          },
          required: ["handle"],
        },
        resultSchema: { type: "object", properties: {} },
        result: {},
        nodes: [],
      }),
      { handle: sourcePiece.key("value") },
      undefined,
      { start: true },
    );
    const controller = new PieceController(pieces, targetPiece);

    await expect(
      controller.setInput({ handle: sourcePiece.key("value") }),
    ).resolves.toBeUndefined();
    expect(await controller.input.get(["handle"])).toBeUndefined();
  });

  it("accepts opaque Cell handles through uniform union wrappers", async () => {
    const sourcePiece = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: { type: "object", properties: {} },
        resultSchema: {
          type: "object",
          properties: { value: { type: ["number", "string"] } },
          required: ["value"],
        },
        result: { value: 7 },
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    const targetPiece = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          type: "object",
          properties: {
            handle: {
              anyOf: [
                { type: "number", asCell: ["cell"] },
                { type: "string", asCell: ["cell"] },
              ],
            },
          },
        },
        resultSchema: { type: "object", properties: {} },
        result: {},
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );

    await expect(
      new PieceController(pieces, targetPiece).input.set(
        sourcePiece.key("value"),
        ["handle"],
      ),
    ).resolves.toBeUndefined();
  });

  it("selects ordinary and optional Cell alternatives by the supplied value", async () => {
    const source = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: { type: "object", properties: {} },
        resultSchema: {
          type: "object",
          properties: { value: { type: "number" } },
          required: ["value"],
        },
        result: { value: 7 },
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    const target = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          type: "object",
          properties: {
            ordinaryOrHandle: {
              anyOf: [
                { type: "number" },
                { type: "number", asCell: ["cell"] },
              ],
            },
            optionalHandle: {
              anyOf: [
                { type: "number", asCell: ["cell"] },
                { type: "undefined" },
              ],
            },
          },
          required: ["ordinaryOrHandle"],
        },
        resultSchema: { type: "object", properties: {} },
        result: {},
        nodes: [],
      }),
      { ordinaryOrHandle: 0 },
      undefined,
      { start: true },
    );
    const controller = new PieceController(pieces, target);

    await expect(
      controller.input.set(1, ["ordinaryOrHandle"]),
    ).resolves.toBeUndefined();
    await expect(
      controller.input.set(source.key("value"), ["optionalHandle"]),
    ).resolves.toBeUndefined();
  });

  it("selects an ordinary union branch for descendant writes", async () => {
    const payload = {
      type: "object",
      properties: { n: { type: "number" } },
      required: ["n"],
    } as const;
    const piece = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          type: "object",
          properties: {
            slot: {
              anyOf: [payload, { ...payload, asCell: ["readonly"] }],
            },
          },
          required: ["slot"],
        },
        resultSchema: { type: "object", properties: {} },
        result: {},
        nodes: [],
      }),
      { slot: { n: 1 } },
      undefined,
      { start: true },
    );
    const controller = new PieceController(pieces, piece);

    await expect(controller.input.set(2, ["slot", "n"]))
      .resolves.toBeUndefined();
    expect(pieces.getArgument(piece).getRaw()).toEqual({ slot: { n: 2 } });
  });

  it("selects an ordinary union branch through a result redirect", async () => {
    const payload = {
      type: "object",
      properties: { n: { type: "number" } },
      required: ["n"],
    } as const;
    const schema = {
      type: "object",
      properties: {
        slot: {
          anyOf: [payload, { ...payload, asCell: ["readonly"] }],
        },
      },
      required: ["slot"],
    } as const;
    const piece = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: schema,
        resultSchema: schema,
        result: {
          slot: { $alias: { cell: "argument", path: ["slot"] } },
        },
        nodes: [],
      }),
      { slot: { n: 1 } },
      undefined,
      { start: true },
    );
    const controller = new PieceController(pieces, piece);

    await expect(controller.result.set(2, ["slot", "n"]))
      .resolves.toBeUndefined();
    expect(pieces.getArgument(piece).getRaw()).toEqual({ slot: { n: 2 } });
  });

  it("narrows Cell capabilities without granting new authority", async () => {
    const numberCell = (kind: "readonly" | "writeonly" | "comparable") => ({
      type: "number" as const,
      asCell: [kind],
    });
    const source = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: { type: "object", properties: {} },
        resultSchema: {
          type: "object",
          properties: {
            readonly: numberCell("readonly"),
            writeonly: numberCell("writeonly"),
            comparable: numberCell("comparable"),
          },
          required: ["readonly", "writeonly", "comparable"],
        },
        result: { readonly: 1, writeonly: 2, comparable: 3 },
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    const target = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          type: "object",
          properties: {
            comparable: numberCell("comparable"),
            opaqueFromWriteonly: { type: "number", asCell: ["opaque"] },
            opaqueFromComparable: { type: "number", asCell: ["opaque"] },
          },
        },
        resultSchema: { type: "object", properties: {} },
        result: {},
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    const controller = new PieceController(pieces, target);

    await expect(
      controller.input.set(source.key("readonly"), ["comparable"]),
    ).resolves.toBeUndefined();
    await expect(
      controller.input.set(source.key("writeonly"), ["opaqueFromWriteonly"]),
    ).rejects.toThrow(/capability cannot be exposed/);
    await expect(
      controller.input.set(source.key("comparable"), [
        "opaqueFromComparable",
      ]),
    ).rejects.toThrow(/capability cannot be exposed/);
  });

  it("does not strip restricted producer capabilities into ordinary aliases", async () => {
    const payload = {
      type: "object",
      properties: { n: { type: "number" } },
      required: ["n"],
    } as const;
    const source = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: { type: "object", properties: {} },
        resultSchema: {
          type: "object",
          properties: {
            readonly: { ...payload, asCell: ["readonly"] },
            writeonly: { type: "number", asCell: ["writeonly"] },
          },
        },
        result: { readonly: { n: 1 }, writeonly: 7 },
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    const target = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          type: "object",
          properties: {
            readableWritable: payload,
            readableNumber: { type: "number" },
          },
        },
        resultSchema: { type: "object", properties: {} },
        result: {},
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    const controller = new PieceController(pieces, target);

    await expect(
      controller.input.set(
        source.key("readonly").asSchema(payload),
        ["readableWritable"],
      ),
    ).rejects.toThrow(/input link.*schema is not compatible/);
    await expect(
      controller.input.set(
        source.key("writeonly").asSchema({ type: "number" }),
        ["readableNumber"],
      ),
    ).rejects.toThrow(/input link.*schema is not compatible/);

    const preexisting = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          type: "object",
          properties: { slot: payload },
          required: ["slot"],
        },
        resultSchema: { type: "object", properties: {} },
        result: {},
        nodes: [],
      }),
      { slot: source.key("readonly").asSchema(payload) },
      undefined,
      { start: true },
    );
    await expect(
      new PieceController(pieces, preexisting).input.set(2, ["slot", "n"]),
    ).rejects.toThrow(/write destination.*not writable/);
    expect(source.getRaw()).toEqual({
      readonly: { n: 1 },
      writeonly: 7,
    });
  });

  it("rejects writable links that widen producer payload contracts", async () => {
    const sourcePayload = {
      type: "object",
      properties: { n: { type: "number" } },
      required: ["n"],
      additionalProperties: false,
    } as const;
    const source = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: { type: "object", properties: {} },
        resultSchema: {
          type: "object",
          properties: { value: sourcePayload },
          required: ["value"],
        },
        result: { value: { n: 1 } },
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    const widePayload = {
      type: "object",
      properties: { n: { type: ["number", "string"] } },
      required: ["n"],
      additionalProperties: false,
    } as const;
    const target = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          type: "object",
          properties: {
            handle: { ...widePayload, asCell: ["cell"] },
            value: widePayload,
          },
        },
        resultSchema: { type: "object", properties: {} },
        result: {},
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    const controller = new PieceController(pieces, target);

    await expect(
      controller.input.set(source.key("value"), ["handle"]),
    ).rejects.toThrow(/input link.*schema is not compatible/);
    await controller.input.set(source.key("value"), ["value"]);
    await expect(
      controller.input.set("bad", ["value", "n"]),
    ).rejects.toThrow(/updated input does not match its write destination/);
    expect(source.getRaw()).toEqual({ value: { n: 1 } });
  });

  it("rejects stream links that widen producer event contracts", async () => {
    const numberStream = { type: "number", asCell: ["stream"] } as const;
    const source = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          type: "object",
          properties: { event: numberStream },
          required: ["event"],
        },
        resultSchema: {
          type: "object",
          properties: { event: numberStream },
          required: ["event"],
        },
        result: { event: { $alias: { cell: "argument", path: ["event"] } } },
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    const wideStream = {
      type: ["number", "string"],
      asCell: ["stream"],
    } as const;
    const target = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          type: "object",
          properties: { event: wideStream },
          required: ["event"],
        },
        resultSchema: {
          type: "object",
          properties: { event: wideStream },
          required: ["event"],
        },
        result: {
          event: { $alias: { cell: "argument", path: ["event"] } },
        },
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );

    await expect(
      new PieceController(pieces, target).setInput({
        event: source.key("event"),
      }),
    ).rejects.toThrow(/input link.*schema is not compatible/);
  });

  it("ignores a producer document the write does not reach", async () => {
    const far = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: { type: "object", properties: {} },
        resultSchema: {
          type: "object",
          properties: { n: { type: "number" } },
          required: ["n"],
        },
        result: { n: 1 },
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    const payload = {
      type: "object",
      properties: { n: { type: "number" } },
      required: ["n"],
    } as const;
    const producer = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          type: "object",
          properties: { obj: payload, linked: { type: "number" } },
          required: ["obj", "linked"],
        },
        resultSchema: {
          type: "object",
          properties: { obj: payload, linked: { type: "number" } },
          required: ["obj", "linked"],
        },
        result: {
          obj: { $alias: { cell: "argument", path: ["obj"] } },
          linked: { $alias: { cell: "argument", path: ["linked"] } },
        },
        nodes: [],
      }),
      { obj: { n: 1 }, linked: 2 },
      undefined,
      { start: true },
    );
    await new PieceController(pieces, producer).input.set(
      far.key("n"),
      ["linked"],
    );
    // The producer now links a document its own schema refuses. Nothing the
    // consumer writes below reaches it.
    await runtime.editWithRetry((tx) => {
      far.withTx(tx).key("n").setRawUntyped("bad");
    });

    const consumer = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          type: "object",
          properties: {
            slot: {
              type: "object",
              properties: { n: { type: ["number", "string"] } },
              required: ["n"],
            },
          },
          required: ["slot"],
        },
        resultSchema: { type: "object", properties: {} },
        result: {},
        nodes: [],
      }),
      { slot: { n: 0 } },
      undefined,
      { start: true },
    );
    const controller = new PieceController(pieces, consumer);
    await controller.input.set(producer.key("obj"), ["slot"]);

    await controller.input.set(5, ["slot", "n"]);
    expect(pieces.getArgument(producer).getRaw()).toMatchObject({
      obj: { n: 5 },
    });

    // The producer's contract still decides the path the write does reach,
    // even though the consumer declares it wider.
    await expect(controller.input.set("bad", ["slot", "n"])).rejects.toThrow(
      /^updated input does not match its write destination: value does not match type number$/,
    );
    expect(pieces.getArgument(producer).getRaw()).toMatchObject({
      obj: { n: 5 },
    });

    // A target that exists but reads as undefined is still a target: the link
    // settles it, and the write goes through.
    await runtime.editWithRetry((tx) => {
      far.withTx(tx).key("n").setRawUntyped(undefined);
    });
    await controller.input.set(7, ["slot", "n"]);
    expect(pieces.getArgument(producer).getRaw()).toMatchObject({
      obj: { n: 7 },
    });

    // Having no target at all is the case the link cannot settle: empty the far
    // document and the producer's `linked` member has nothing behind it, so
    // `required` refuses.
    await runtime.editWithRetry((tx) => {
      far.withTx(tx).setRawUntyped({});
    });
    await expect(controller.input.set(8, ["slot", "n"])).rejects.toThrow(
      /updated input does not match its write destination: missing required property linked/,
    );
    expect(pieces.getArgument(producer).getRaw()).toMatchObject({
      obj: { n: 7 },
    });
  });

  it("sends a stream event past an invalid producer sibling", async () => {
    const members = {
      other: { type: "number" },
      spare: { type: "number" },
    } as const;
    const piece = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          type: "object",
          properties: {
            event: { type: "number", asCell: ["stream"] },
            ...members,
          },
          required: ["event", "other", "spare"],
        },
        // The result declares the same stream with its payload unconstrained,
        // so a payload only the producer refuses reaches the producer contract
        // instead of stopping at this Piece's own result schema.
        resultSchema: {
          type: "object",
          properties: { event: { asCell: ["stream"] }, ...members },
          required: ["event", "other", "spare"],
        },
        result: {
          event: { $alias: { cell: "argument", path: ["event"] } },
          other: { $alias: { cell: "argument", path: ["other"] } },
          spare: { $alias: { cell: "argument", path: ["spare"] } },
        },
        nodes: [],
      }),
      { other: 1, spare: 2 },
      undefined,
      { start: true },
    );
    const controller = new PieceController(pieces, piece);
    const argument = pieces.getArgument(piece);
    // A producer member that no write below touches, holding a value the
    // producer's own schema refuses.
    await runtime.editWithRetry((tx) => {
      argument.withTx(tx).key("spare").setRawUntyped("bad");
    });

    const stream = argument.key("event");
    const events: unknown[] = [];
    const removeHandler = runtime.scheduler.addEventHandler((_tx, event) => {
      events.push(event);
    }, stream.getAsNormalizedFullLink());
    try {
      await controller.result.set(7, ["event"]);
      await runtime.idle();
      expect(events).toEqual([7]);
      // The premise the skip rests on: sending stores nothing, so the producer
      // document the root pass would have judged is the one it already was.
      expect(argument.getRawUntyped()).toEqual({ other: 1, spare: "bad" });

      // Bypassing the root pass does not excuse a payload the producer's own
      // event contract refuses: nothing further reaches the stream.
      await expect(controller.result.set("bad", ["event"])).rejects.toThrow(
        /does not match its write destination: value does not match type number/,
      );
      await runtime.idle();
      expect(events).toEqual([7]);
    } finally {
      removeHandler();
    }
  });

  it("drops a raw key the materialized view does not carry", async () => {
    // `omitMissingProjectionAliases` reconciles two views of one document. A
    // raw key with no counterpart in the materialized view is not a missing
    // alias to resolve — there is nothing on the materialized side to keep — so
    // it is skipped rather than recursed into.
    const piece = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: { type: "object", properties: {} },
        resultSchema: { type: "object", properties: {} },
        result: {},
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    const result = omitMissingProjectionAliases(
      { kept: 1 },
      { kept: 1, absentFromMaterialized: 2 },
      undefined,
      pieces.getResult(piece),
      pieces,
    );
    // `toEqual` treats a present undefined as absent, so ask about the key
    // itself: recursing would have set it, to undefined.
    expect(Object.hasOwn(result as object, "absentFromMaterialized")).toBe(
      false,
    );
    expect(result).toEqual({ kept: 1 });
  });

  it("rejects descendant writes through Stream wrappers", async () => {
    const event = {
      type: "object",
      properties: { n: { type: "number" } },
      required: ["n"],
      asCell: ["stream"],
    } as const;
    const piece = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          type: "object",
          properties: { event },
          required: ["event"],
        },
        resultSchema: { type: "object", properties: {} },
        result: {},
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );

    await expect(
      new PieceController(pieces, piece).input.set(2, ["event", "n"]),
    ).rejects.toThrow(/stream Cell path is not writable/);
  });

  it("does not amplify readonly handles or write through them", async () => {
    const payload = {
      type: "object",
      properties: { n: { type: "number" } },
      required: ["n"],
      additionalProperties: false,
    } as const;
    const readonlyPayload = { ...payload, asCell: ["readonly"] } as const;
    const source = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: { type: "object", properties: {} },
        resultSchema: {
          type: "object",
          properties: { value: readonlyPayload },
          required: ["value"],
        },
        result: { value: { n: 1 } },
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    const target = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          type: "object",
          properties: {
            readonlyHandle: readonlyPayload,
            writableHandle: { ...payload, asCell: ["cell"] },
          },
        },
        resultSchema: { type: "object", properties: {} },
        result: {},
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    const controller = new PieceController(pieces, target);

    await controller.input.set(source.key("value"), ["readonlyHandle"]);
    await expect(
      controller.input.set(2, ["readonlyHandle", "n"]),
    ).rejects.toThrow(/not writable/);
    await expect(
      controller.input.set(source.key("value"), ["writableHandle"]),
    ).rejects.toThrow(/input link.*schema is not compatible/);
    expect(source.getRaw()).toEqual({ value: { n: 1 } });
  });

  it("validates writes against a narrowed redirect destination", async () => {
    const pattern: Pattern = {
      argumentSchema: {
        type: "object",
        properties: {
          settings: {
            type: "object",
            properties: { n: { type: "number" } },
            required: ["n"],
          },
        },
        required: ["settings"],
      },
      resultSchema: {
        type: "object",
        properties: {
          settings: {
            type: "object",
            properties: { n: { type: ["number", "string"] } },
            required: ["n"],
          },
        },
        required: ["settings"],
      },
      result: {
        settings: { $alias: { cell: "argument", path: ["settings"] } },
      },
      nodes: [],
    };
    const piece = await pieces.runPersistent(
      trustPattern(runtime, pattern),
      { settings: { n: 1 } },
      undefined,
      { start: true },
    );
    const controller = new PieceController(pieces, piece);

    await expect(
      controller.result.set("bad", ["settings", "n"]),
    ).rejects.toThrow(/updated result does not match its write destination/);
    expect((await controller.input.getCell()).getRaw()).toEqual({
      settings: { n: 1 },
    });
  });

  it("re-proves supplied links against a narrowed redirect destination", async () => {
    const source = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: { type: "object", properties: {} },
        resultSchema: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
        },
        result: { value: "linked" },
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    const target = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          type: "object",
          properties: {
            settings: {
              type: "object",
              properties: { n: { type: "number" } },
              required: ["n"],
            },
          },
          required: ["settings"],
        },
        resultSchema: {
          type: "object",
          properties: {
            settings: {
              type: "object",
              properties: { n: { type: ["number", "string"] } },
              required: ["n"],
            },
          },
          required: ["settings"],
        },
        result: {
          settings: { $alias: { cell: "argument", path: ["settings"] } },
        },
        nodes: [],
      }),
      { settings: { n: 1 } },
      undefined,
      { start: true },
    );
    const controller = new PieceController(pieces, target);

    await expect(
      controller.result.set(source.key("value"), ["settings", "n"]),
    ).rejects.toThrow(/write destination/);
    expect((await controller.input.getCell()).getRaw()).toEqual({
      settings: { n: 1 },
    });
  });

  it("ignores a widened carried schema on a write destination", async () => {
    const narrow = {
      type: "object",
      properties: { n: { type: "number" } },
      required: ["n"],
    } as const;
    const wide = {
      type: "object",
      properties: { n: { type: ["number", "string"] } },
      required: ["n"],
    } as const;
    const source = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: { type: "object", properties: {} },
        resultSchema: {
          type: "object",
          properties: { value: narrow },
          required: ["value"],
        },
        result: { value: { n: 1 } },
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    const target = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          type: "object",
          properties: { slot: wide },
          required: ["slot"],
        },
        resultSchema: { type: "object", properties: {} },
        result: {},
        nodes: [],
      }),
      { slot: { n: 0 } },
      undefined,
      { start: true },
    );
    const controller = new PieceController(pieces, target);

    await controller.input.set(source.key("value").asSchema(wide), ["slot"]);
    await expect(
      controller.input.set("bad", ["slot", "n"]),
    ).rejects.toThrow(/write destination/);
    expect(source.getRaw()).toEqual({ value: { n: 1 } });
  });

  it("ignores a widened carried schema on another Piece argument", async () => {
    const narrow = {
      type: "object",
      properties: { n: { type: "number" } },
      required: ["n"],
    } as const;
    const wide = {
      type: "object",
      properties: { n: { type: ["number", "string"] } },
      required: ["n"],
    } as const;
    const producer = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          type: "object",
          properties: { value: narrow },
          required: ["value"],
        },
        resultSchema: {
          type: "object",
          properties: { value: narrow },
          required: ["value"],
        },
        result: {
          value: { $alias: { cell: "argument", path: ["value"] } },
        },
        nodes: [],
      }),
      { value: { n: 1 } },
      undefined,
      { start: true },
    );
    const target = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          type: "object",
          properties: { slot: wide },
          required: ["slot"],
        },
        resultSchema: { type: "object", properties: {} },
        result: {},
        nodes: [],
      }),
      {
        slot: pieces.getArgument(producer).key("value").asSchema(wide),
      },
      undefined,
      { start: true },
    );

    await expect(
      new PieceController(pieces, target).input.set("bad", ["slot", "n"]),
    ).rejects.toThrow(/write destination/);
    expect(pieces.getArgument(producer).getRaw()).toEqual({
      value: { n: 1 },
    });
  });

  it("validates linked descendant writes against producer containers", async () => {
    const constrainedArray = {
      type: "array",
      items: { type: "number" },
      maxItems: 1,
    } as const;
    const producer = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          type: "object",
          properties: { arr: constrainedArray },
          required: ["arr"],
        },
        resultSchema: {
          type: "object",
          properties: { arr: constrainedArray },
          required: ["arr"],
        },
        result: {
          arr: { $alias: { cell: "argument", path: ["arr"] } },
        },
        nodes: [],
      }),
      { arr: [1] },
      undefined,
      { start: true },
    );
    const target = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          type: "object",
          properties: {
            slot: { type: "array", items: { type: "number" } },
          },
          required: ["slot"],
        },
        resultSchema: { type: "object", properties: {} },
        result: {},
        nodes: [],
      }),
      { slot: [] },
      undefined,
      { start: true },
    );
    const controller = new PieceController(pieces, target);

    await controller.input.set(producer.key("arr"), ["slot"]);
    await expect(controller.input.set(2, ["slot", 1])).rejects.toThrow(
      /write destination/,
    );
    expect(pieces.getArgument(producer).getRaw()).toEqual({ arr: [1] });
  });

  it("validates concrete writes through correlated producer projections", async () => {
    const producer = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          description: "correlated numeric choice",
          anyOf: [
            {
              type: "object",
              properties: {
                kind: { const: "n" },
                value: { type: "number" },
              },
              required: ["kind", "value"],
            },
            {
              type: "object",
              properties: {
                kind: { const: "s" },
                value: { type: "string" },
              },
              required: ["kind", "value"],
            },
          ],
        },
        resultSchema: {
          type: "object",
          properties: {
            value: { type: ["number", "string"] },
          },
          required: ["value"],
        },
        result: {
          value: { $alias: { cell: "argument", path: ["value"] } },
        },
        nodes: [],
      }),
      { kind: "n", value: 1 },
      undefined,
      { start: true },
    );
    const controller = new PieceController(pieces, producer);

    await controller.result.set(2, ["value"]);
    expect(pieces.getArgument(producer).getRaw()).toEqual({
      kind: "n",
      value: 2,
    });

    await expect(controller.result.set("bad", ["value"]))
      .rejects.toThrow(/write destination/);
    expect(pieces.getArgument(producer).getRaw()).toEqual({
      kind: "n",
      value: 2,
    });

    const futureValue = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: { type: "object", properties: {} },
        resultSchema: {
          type: "object",
          properties: { value: { type: ["number", "string"] } },
          required: ["value"],
        },
        result: { value: 3 },
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    await expect(
      controller.result.set(futureValue.key("value"), ["value"]),
    ).rejects.toThrow(/write destination/);
    expect(pieces.getArgument(producer).getRaw()).toEqual({
      kind: "n",
      value: 2,
    });
  });

  it("retains selected Cell authority through correlated projections", async () => {
    const choiceSchema = {
      anyOf: [{
        type: "object",
        properties: {
          kind: { const: "readonly" },
          value: { type: "number", asCell: ["readonly"] },
        },
        required: ["kind", "value"],
      }, {
        type: "object",
        properties: {
          kind: { const: "plain" },
          value: { type: "number" },
        },
        required: ["kind", "value"],
      }],
    } as const;
    const createProducer = (kind: "readonly" | "plain") =>
      pieces.runPersistent(
        trustPattern(runtime, {
          argumentSchema: {
            type: "object",
            properties: { choice: choiceSchema },
            required: ["choice"],
          },
          resultSchema: {
            type: "object",
            properties: { value: { type: "number" } },
            required: ["value"],
          },
          result: {
            value: {
              $alias: {
                cell: "argument",
                path: ["choice", "value"],
              },
            },
          },
          nodes: [],
        }),
        { choice: { kind, value: 1 } },
        undefined,
        { start: true },
      );

    const readonlyProducer = await createProducer("readonly");
    const readonlyController = new PieceController(pieces, readonlyProducer);
    await expect(readonlyController.result.set(2, ["value"]))
      .rejects.toThrow(/readonly Cell write destination is not writable/);
    expect(pieces.getArgument(readonlyProducer).getRaw()).toEqual({
      choice: { kind: "readonly", value: 1 },
    });

    const plainProducer = await createProducer("plain");
    const plainController = new PieceController(pieces, plainProducer);
    await plainController.result.set(2, ["value"]);
    expect(pieces.getArgument(plainProducer).getRaw()).toEqual({
      choice: { kind: "plain", value: 2 },
    });

    const createProjectedProducer = (kind: "readonly" | "plain") =>
      pieces.runPersistent(
        trustPattern(runtime, {
          argumentSchema: { type: "object", properties: {} },
          resultSchema: {
            anyOf: [{
              type: "object",
              properties: {
                kind: { const: "readonly" },
                value: { type: "number", asCell: ["readonly"] },
              },
              required: ["kind", "value"],
            }, {
              type: "object",
              properties: {
                kind: { const: "plain" },
                value: { type: "number" },
              },
              required: ["kind", "value"],
            }],
          },
          derivedInternalCells: [{
            partialCause: "value",
            schema: { type: "number" },
          }],
          result: {
            kind,
            value: { $alias: { partialCause: "value", path: [] } },
          },
          nodes: [],
        }),
        {},
        undefined,
        { start: true },
      );

    const projectedReadonly = await createProjectedProducer("readonly");
    await expect(
      new PieceController(pieces, projectedReadonly).result.set(2, ["value"]),
    ).rejects.toThrow(/readonly Cell write destination is not writable/);
    expect(projectedReadonly.key("value").resolveAsCell().getRaw()).toBe(
      undefined,
    );

    const projectedPlain = await createProjectedProducer("plain");
    await new PieceController(pieces, projectedPlain).result.set(2, ["value"]);
    expect(projectedPlain.key("value").resolveAsCell().getRaw()).toBe(2);
  });

  it("validates concrete writes through ambiguous container projections", async () => {
    const valueSchema = {
      type: ["object", "array"],
      properties: { x: { type: "number" } },
      required: ["x"],
      items: { type: "number" },
      uniqueItems: true,
      maximum: 10,
    } as const;
    const producer = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          type: "object",
          properties: { value: valueSchema },
          required: ["value"],
        },
        resultSchema: {
          type: "object",
          properties: { value: true },
          required: ["value"],
        },
        result: {
          value: { $alias: { cell: "argument", path: ["value"] } },
        },
        nodes: [],
      }),
      { value: { x: 1 } },
      undefined,
      { start: true },
    );
    const controller = new PieceController(pieces, producer);

    await controller.result.set(2, ["value", "x"]);
    expect(pieces.getArgument(producer).getRaw()).toEqual({
      value: { x: 2 },
    });

    await controller.result.set([3], ["value"]);
    await controller.result.set(4, ["value", 0]);
    expect(pieces.getArgument(producer).getRaw()).toEqual({ value: [4] });

    const futureValue = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: { type: "object", properties: {} },
        resultSchema: {
          type: "object",
          properties: { value: { type: "number" } },
          required: ["value"],
        },
        result: { value: 5 },
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    await expect(
      controller.result.set(futureValue.key("value"), ["value", 0]),
    ).rejects.toThrow(/correlated write destination/);
    expect(pieces.getArgument(producer).getRaw()).toEqual({ value: [4] });

    const bareSchema = { type: ["object", "array"] } as const;
    const bareProducer = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          type: "object",
          properties: { value: bareSchema },
          required: ["value"],
        },
        resultSchema: {
          type: "object",
          properties: { value: true },
          required: ["value"],
        },
        result: {
          value: { $alias: { cell: "argument", path: ["value"] } },
        },
        nodes: [],
      }),
      { value: { x: 1 } },
      undefined,
      { start: true },
    );
    const bareController = new PieceController(pieces, bareProducer);
    await bareController.result.set(2, ["value", "x"]);
    expect(pieces.getArgument(bareProducer).getRaw()).toEqual({
      value: { x: 2 },
    });
    await bareController.result.set([3], ["value"]);
    await bareController.result.set(4, ["value", 0]);
    expect(pieces.getArgument(bareProducer).getRaw()).toEqual({ value: [4] });

    const arrayProducer = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          type: "object",
          properties: {
            value: {
              type: ["object", "array"],
              items: { type: "number" },
              dependentRequired: { x: ["y"] },
              propertyNames: { type: "string" },
            },
          },
          required: ["value"],
        },
        resultSchema: {
          type: "object",
          properties: { value: true },
          required: ["value"],
        },
        result: {
          value: { $alias: { cell: "argument", path: ["value"] } },
        },
        nodes: [],
      }),
      { value: [1] },
      undefined,
      { start: true },
    );
    await new PieceController(pieces, arrayProducer).result.set(
      2,
      ["value", 0],
    );
    expect(pieces.getArgument(arrayProducer).getRaw()).toEqual({ value: [2] });
  });

  it("intersects argument and public result destination contracts", async () => {
    const narrow = {
      type: "object",
      properties: { n: { type: "number" } },
      required: ["n"],
    } as const;
    const wide = {
      type: "object",
      properties: { n: { type: ["number", "string"] } },
      required: ["n"],
    } as const;
    const producer = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          type: "object",
          properties: { settings: wide },
          required: ["settings"],
        },
        resultSchema: {
          type: "object",
          properties: { settings: narrow },
          required: ["settings"],
        },
        result: {
          settings: { $alias: { cell: "argument", path: ["settings"] } },
        },
        nodes: [],
      }),
      { settings: { n: 1 } },
      undefined,
      { start: true },
    );
    const target = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          type: "object",
          properties: { slot: wide },
          required: ["slot"],
        },
        resultSchema: { type: "object", properties: {} },
        result: {},
        nodes: [],
      }),
      { slot: { n: 0 } },
      undefined,
      { start: true },
    );
    const controller = new PieceController(pieces, target);

    await controller.input.set(producer.key("settings"), ["slot"]);
    await expect(controller.input.set("bad", ["slot", "n"]))
      .rejects.toThrow(/write destination/);
    expect(pieces.getArgument(producer).getRaw()).toEqual({
      settings: { n: 1 },
    });
  });

  it("intersects internal and public result destination contracts", async () => {
    const narrow = {
      type: "object",
      properties: { n: { type: "number" } },
      required: ["n"],
      default: { n: 1 },
    } as const;
    const wide = {
      type: "object",
      properties: { n: { type: ["number", "string"] } },
      required: ["n"],
    } as const;
    const producer = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: { type: "object", properties: {} },
        resultSchema: {
          type: "object",
          properties: { value: wide },
          required: ["value"],
        },
        derivedInternalCells: [{
          partialCause: "value",
          schema: narrow,
        }],
        result: {
          value: { $alias: { partialCause: "value", path: [] } },
        },
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    const target = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          type: "object",
          properties: { slot: wide },
          required: ["slot"],
        },
        resultSchema: { type: "object", properties: {} },
        result: {},
        nodes: [],
      }),
      { slot: { n: 0 } },
      undefined,
      { start: true },
    );
    const controller = new PieceController(pieces, target);

    await controller.input.set(producer.key("value"), ["slot"]);
    await expect(controller.input.set("bad", ["slot", "n"]))
      .rejects.toThrow(/write destination/);
    expect(producer.get()).toEqual({ value: { n: 1 } });
  });

  it("materializes Cell ancestors when staging descendant result writes", async () => {
    const eventSchema = {
      type: "number",
      asCell: ["stream"],
    } as const;
    const payloadSchema = {
      type: "object",
      properties: {
        x: { type: "number" },
        sibling: eventSchema,
      },
      required: ["x", "sibling"],
      asCell: ["cell"],
    } as const;
    const producer = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: { type: "object", properties: {} },
        resultSchema: {
          type: "object",
          properties: { payload: payloadSchema, event: eventSchema },
          required: ["payload", "event"],
        },
        derivedInternalCells: [{
          partialCause: "payload",
          schema: payloadSchema,
        }, {
          partialCause: "event",
          schema: eventSchema,
        }],
        result: {
          payload: { $alias: { partialCause: "payload", path: [] } },
          event: { $alias: { partialCause: "event", path: [] } },
        },
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    const controller = new PieceController(pieces, producer);
    const payload = producer.key("payload").resolveAsCell();

    await controller.result.set(
      { x: 1, sibling: producer.key("event") },
      ["payload"],
    );
    const sibling = (payload.getRaw() as { sibling: unknown }).sibling;
    await controller.result.set(2, ["payload", "x"]);

    expect(payload.getRaw()).toEqual({
      x: 2,
      sibling,
    });
  });

  it("ignores opaque nested aliases when identifying Stream capability", async () => {
    const mentionableSchema = {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    } as const;
    const eventSchema = {
      type: "object",
      properties: {
        piece: {
          $ref: "#/$defs/Mentionable",
          asCell: ["cell"],
        },
      },
      required: ["piece"],
      asCell: ["stream"],
    } as const;
    const streamSchema = {
      ...eventSchema,
      $defs: { Mentionable: mentionableSchema },
    } as const;
    const mentionable = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: { type: "object", properties: {} },
        resultSchema: mentionableSchema,
        result: { name: "target" },
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    const producer = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: { type: "object", properties: {} },
        resultSchema: {
          type: "object",
          properties: {
            event: eventSchema,
            sibling: {
              type: "object",
              properties: { detail: { type: "string" } },
              required: ["detail"],
              asCell: ["stream"],
            },
            opaque: true,
          },
          required: ["event", "sibling", "opaque"],
          $defs: { Mentionable: mentionableSchema },
        },
        derivedInternalCells: [{
          partialCause: "event",
          schema: streamSchema,
        }, {
          partialCause: "sibling",
          schema: {
            type: "object",
            properties: { detail: { type: "string" } },
            required: ["detail"],
            asCell: ["stream"],
          },
        }],
        result: {
          event: { $alias: { partialCause: "event", path: [] } },
          sibling: { $alias: { partialCause: "sibling", path: [] } },
          opaque: {
            handler: { $alias: { partialCause: "event", path: [] } },
          },
        },
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    const controller = new PieceController(pieces, producer);
    const stream = producer.key("event").resolveAsCell();
    const events: unknown[] = [];
    const removeHandler = runtime.scheduler.addEventHandler((_tx, event) => {
      events.push(event);
    }, stream.getAsNormalizedFullLink());

    try {
      await controller.result.set({ piece: mentionable }, ["event"]);
      await runtime.idle();
      expect(events).toHaveLength(1);
    } finally {
      removeHandler();
    }
  });

  it("accepts a Piece Stream supplied to a Stream Cell input", async () => {
    const sourcePiece = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: { type: "object", properties: {} },
        resultSchema: {
          type: "object",
          properties: {
            events: { $ref: "#/$defs/Event" },
          },
          required: ["events"],
          $defs: {
            Event: { type: "number", asCell: ["stream"] },
          },
        },
        derivedInternalCells: [
          {
            partialCause: "events",
            schema: { type: "number", asCell: ["stream"] },
          },
        ],
        result: { events: { $alias: { partialCause: "events", path: [] } } },
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    const targetPiece = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          type: "object",
          properties: {
            events: { $ref: "#/$defs/Event" },
          },
          $defs: {
            Event: { type: "number", asCell: ["stream"] },
          },
        },
        resultSchema: { type: "object", properties: {} },
        result: {},
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );

    const controller = new PieceController(pieces, targetPiece);
    await expect(
      controller.setInput({ events: sourcePiece.key("events") }),
    ).resolves.toBeUndefined();

    const inputCell = await controller.input.getCell();
    await expect(
      controller.setInput({
        events: sourcePiece.key("events").getAsLink({
          base: inputCell.key("events"),
          includeSchema: true,
        }),
      }),
    ).resolves.toBeUndefined();

    await expect(
      controller.setInput({
        events: sourcePiece.key("events").getAsLink({
          base: inputCell.key("events"),
          includeSchema: false,
        }),
      }),
    ).rejects.toThrow(/does not preserve its durable stream wrapper/);
  });

  it("rejects conflicting and forged Cell wrapper contracts", async () => {
    const sourcePiece = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: { type: "object", properties: {} },
        resultSchema: {
          type: "object",
          properties: { value: { type: "number" } },
          required: ["value"],
          additionalProperties: false,
        },
        result: { value: 7 },
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );

    const conflictingTarget = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          type: "object",
          properties: {
            handle: { type: "number", asCell: ["cell"] },
          },
          patternProperties: {
            "^handle$": { type: "number", asCell: ["readonly"] },
          },
          additionalProperties: false,
        },
        resultSchema: { type: "object", properties: {} },
        result: {},
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    await expect(
      new PieceController(pieces, conflictingTarget).input.set(
        sourcePiece.key("value"),
        ["handle"],
      ),
    ).rejects.toThrow(/destination Cell constraints disagree/);

    const scalarTarget = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          type: "object",
          properties: { slot: { type: "number" } },
          required: ["slot"],
          additionalProperties: false,
        },
        resultSchema: { type: "object", properties: {} },
        result: {},
        nodes: [],
      }),
      { slot: 0 },
      undefined,
      { start: true },
    );
    const scalarController = new PieceController(pieces, scalarTarget);
    const scalarInput = await scalarController.input.getCell();
    const forged = sourcePiece.key("value").getAsLink({
      base: scalarInput.key("slot"),
      includeSchema: true,
    });
    (linkRefPayload(forged) as { schema?: JSONSchema }).schema = {
      type: "number",
      asCell: ["cell"],
    };
    await expect(
      scalarController.input.set(forged, ["slot"]),
    ).rejects.toThrow(/link carries a non-durable Cell wrapper/);
  });

  it("projects nested Cell wrappers with the canonical link schema", async () => {
    const sourcePiece = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: { type: "object", properties: {} },
        resultSchema: {
          type: "object",
          properties: {
            value: {
              type: "object",
              properties: {
                handle: {
                  $ref: "#/$defs/NumberValue",
                  asCell: ["cell"],
                },
              },
              required: ["handle"],
              additionalProperties: false,
            },
          },
          required: ["value"],
          $defs: { NumberValue: { type: "number" } },
        },
        result: { value: { handle: 7 } },
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    const targetPiece = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          type: "object",
          properties: {
            slot: {
              type: "object",
              properties: { handle: { $ref: "#/$defs/NumberValue" } },
              required: ["handle"],
              additionalProperties: false,
            },
          },
          required: ["slot"],
          $defs: { NumberValue: { type: "number" } },
        },
        resultSchema: { type: "object", properties: {} },
        result: {},
        nodes: [],
      }),
      { slot: { handle: 0 } },
      undefined,
      { start: true },
    );
    const controller = new PieceController(pieces, targetPiece);

    await controller.input.set(sourcePiece.key("value"), ["slot"]);
    expect(await controller.input.get(["slot"])).toEqual({ handle: 7 });
  });

  it("checks patternProperties on both sides of a durable path link", async () => {
    const broadSource = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: { type: "object", properties: {} },
        resultSchema: {
          type: "object",
          properties: { value: { type: ["number", "string"] } },
          required: ["value"],
        },
        result: { value: 1 },
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    const patternedTarget = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          type: "object",
          patternProperties: { "^x": { type: "number" } },
          additionalProperties: true,
        },
        resultSchema: { type: "object", properties: {} },
        result: {},
        nodes: [],
      }),
      { xSlot: 0 },
      undefined,
      { start: true },
    );
    await expect(
      new PieceController(pieces, patternedTarget).input.set(
        broadSource.key("value"),
        ["xSlot"],
      ),
    ).rejects.toThrow(/input link.*schema is not compatible/);

    const patternedSource = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: { type: "object", properties: {} },
        resultSchema: {
          type: "object",
          patternProperties: {
            "^x": { type: ["number", "string"] },
          },
          additionalProperties: false,
        },
        result: { xSlot: 1 },
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    const numericTarget = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          type: "object",
          properties: { slot: { type: "number" } },
          required: ["slot"],
        },
        resultSchema: { type: "object", properties: {} },
        result: {},
        nodes: [],
      }),
      { slot: 0 },
      undefined,
      { start: true },
    );
    await expect(
      new PieceController(pieces, numericTarget).input.set(
        patternedSource.key("xSlot"),
        ["slot"],
      ),
    ).rejects.toThrow(/input link.*schema is not compatible/);
  });

  it("includes possible source-path omission in durable link contracts", async () => {
    const targetPiece = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          type: "object",
          properties: { slot: { type: "number" } },
          required: ["slot"],
        },
        resultSchema: { type: "object", properties: {} },
        result: {},
        nodes: [],
      }),
      { slot: 0 },
      undefined,
      { start: true },
    );
    const target = new PieceController(pieces, targetPiece);
    const optionalSource = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: { type: "object", properties: {} },
        resultSchema: {
          type: "object",
          properties: { value: { type: "number" } },
          additionalProperties: false,
        },
        result: { value: 1 },
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );

    // The current value is a number, but a future schema-valid source write can
    // omit the raw path and make the retained link yield Fabric `undefined`.
    await expect(
      target.input.set(optionalSource.key("value"), ["slot"]),
    ).rejects.toThrow(/input link.*schema is not compatible/);

    const defaultedOptionalSource = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: { type: "object", properties: {} },
        resultSchema: {
          type: "object",
          properties: { value: { type: "number", default: 5 } },
          additionalProperties: false,
        },
        result: { value: 1 },
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    // Defaults are annotations on a source contract, not structural proof that
    // a future raw producer value contains the linked path.
    await expect(
      target.input.set(defaultedOptionalSource.key("value"), ["slot"]),
    ).rejects.toThrow(/input link.*schema is not compatible/);

    const optionalTargetPiece = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          type: "object",
          properties: {
            slot: { type: ["number", "undefined"] },
          },
          required: ["slot"],
        },
        resultSchema: { type: "object", properties: {} },
        result: {},
        nodes: [],
      }),
      { slot: 0 },
      undefined,
      { start: true },
    );
    const optionalTarget = new PieceController(pieces, optionalTargetPiece);
    await optionalTarget.input.set(optionalSource.key("value"), ["slot"]);
    await new PieceController(pieces, optionalSource).result.set({});
    expect(await optionalTarget.input.get(["slot"])).toBeUndefined();

    const requiredSource = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: { type: "object", properties: {} },
        resultSchema: {
          type: "object",
          properties: { value: { type: "number" } },
          required: ["value"],
          additionalProperties: false,
        },
        result: { value: 2 },
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    await target.input.set(requiredSource.key("value"), ["slot"]);
    expect(await target.input.get(["slot"])).toBe(2);
    await expect(
      new PieceController(pieces, requiredSource).result.set({}),
    ).rejects.toThrow(/does not match/);

    const conditionallyObjectSource = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: { type: "object", properties: {} },
        resultSchema: {
          properties: { value: { type: "number" } },
          required: ["value"],
        },
        result: { value: 3 },
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    await expect(
      target.input.set(conditionallyObjectSource.key("value"), ["slot"]),
    ).rejects.toThrow(/input link.*schema is not compatible/);

    const maybeShortArray = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: { type: "object", properties: {} },
        resultSchema: { type: "array", items: { type: "number" } },
        result: [3],
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    await expect(
      target.input.set(maybeShortArray.key(0), ["slot"]),
    ).rejects.toThrow(/input link.*schema is not compatible/);

    const nonemptyArray = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: { type: "object", properties: {} },
        resultSchema: {
          type: "array",
          items: { type: "number" },
          minItems: 1,
        },
        result: [4],
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    await expect(
      target.input.set(nonemptyArray.key(0), ["slot"]),
    ).rejects.toThrow(/input link.*schema is not compatible/);

    await optionalTarget.input.set(nonemptyArray.key(0), ["slot"]);
    const sparse = Array(1);
    expect(validateSchemaValue(
      {
        type: "array",
        items: { type: "number" },
        minItems: 1,
      },
      sparse,
    )).toBeUndefined();
    await new PieceController(pieces, nonemptyArray).result.set(sparse);
    expect(await optionalTarget.input.get(["slot"])).toBeUndefined();
  });

  it("rejects path links through correlated parent schemas", async () => {
    const sourcePiece = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: { type: "object", properties: {} },
        resultSchema: {
          type: "object",
          properties: { value: { type: ["number", "string"] } },
          required: ["value"],
        },
        result: { value: 1 },
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    const targetPiece = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          anyOf: [
            {
              type: "object",
              properties: {
                kind: { const: "n" },
                value: { type: "number" },
              },
              required: ["kind", "value"],
            },
            {
              type: "object",
              properties: {
                kind: { const: "s" },
                value: { type: "string" },
              },
              required: ["kind", "value"],
            },
          ],
        },
        resultSchema: { type: "object", properties: {} },
        result: {},
        nodes: [],
      }),
      { kind: "n", value: 0 },
      undefined,
      { start: true },
    );

    await expect(
      new PieceController(pieces, targetPiece).input.set(
        sourcePiece.key("value"),
        ["value"],
      ),
    ).rejects.toThrow(/anyOf correlates the linked field/);
  });

  it("uses destination scope as a follow cap for every durable link", async () => {
    const sourcePattern: Pattern = {
      argumentSchema: { type: "object", properties: {} },
      resultSchema: {
        type: "object",
        properties: {
          value: { type: "number" },
        },
        required: ["value"],
      },
      result: { value: 1 },
      nodes: [],
    };
    const spaceSource = await pieces.runPersistent(
      trustPattern(runtime, sourcePattern),
      {},
      undefined,
      { start: true },
    );
    const sessionPattern = trustPattern(runtime, {
      argumentSchema: { type: "object", properties: {} },
      resultSchema: { type: "number" },
      result: 7,
      nodes: [],
    });
    const sessionSource = runtime.getCell<number>(
      pieces.getSpace(),
      "session-source-" + crypto.randomUUID(),
      sessionPattern.resultSchema,
      undefined,
      "session",
    );
    await runtime.setup(undefined, sessionPattern, {}, sessionSource);
    await sessionSource.sync();
    expect(sessionSource.getAsNormalizedFullLink().scope).toBe("session");
    const targetPiece = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          type: "object",
          properties: { slot: { type: "number", scope: "user" } },
          required: ["slot"],
        },
        resultSchema: { type: "object", properties: {} },
        result: {},
        nodes: [],
      }),
      { slot: 0 },
      undefined,
      { start: true },
    );
    const controller = new PieceController(pieces, targetPiece);

    await controller.input.set(spaceSource.key("value"), ["slot"]);
    await expect(
      controller.input.set(sessionSource, ["slot"]),
    ).rejects.toThrow(/scope session exceeds the destination scope/);

    const handleTarget = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          type: "object",
          properties: {
            handle: {
              type: "number",
              asCell: [{ kind: "cell", scope: "user" }],
            },
          },
        },
        resultSchema: { type: "object", properties: {} },
        result: {},
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    await expect(
      new PieceController(pieces, handleTarget).input.set(
        sessionSource,
        ["handle"],
      ),
    ).rejects.toThrow(/scope session exceeds the destination scope/);
  });

  it("checks a durable link schema even when its current value is undefined", async () => {
    const pattern: Pattern = {
      argumentSchema: {
        type: "object",
        properties: {
          slot: { type: ["number", "undefined"] },
        },
        required: ["slot"],
      },
      resultSchema: { type: "object", properties: {} },
      result: {},
      nodes: [],
    };
    const piece = await pieces.runPersistent(
      trustPattern(runtime, pattern),
      { slot: undefined },
      undefined,
      { start: true },
    );
    const controller = new PieceController(pieces, piece);
    const inputCell = await controller.input.getCell();
    const compatibleSource = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: { type: "object", properties: {} },
        resultSchema: {
          type: "object",
          properties: {
            value: { type: ["number", "undefined"] },
          },
          required: ["value"],
        },
        result: {},
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    const incompatibleSource = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: { type: "object", properties: {} },
        resultSchema: {
          type: "object",
          properties: {
            value: { type: ["string", "undefined"] },
          },
          required: ["value"],
        },
        result: {},
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    const compatible = compatibleSource.key("value");
    const incompatible = incompatibleSource.key("value");

    await controller.input.set(
      compatible.getAsLink({
        base: inputCell.key("slot"),
        includeSchema: true,
      }),
      ["slot"],
    );
    await expect(
      controller.input.set(
        incompatible.getAsLink({
          base: inputCell.key("slot"),
          includeSchema: true,
        }),
        ["slot"],
      ),
    ).rejects.toThrow(/input link.*schema is not compatible/);

    const compatibleController = new PieceController(pieces, compatibleSource);
    await compatibleController.result.set(7, ["value"]);
    expect(await controller.input.get(["slot"])).toBe(7);
    await expect(
      compatibleController.result.set("bad", ["value"]),
    ).rejects.toThrow(/updated (result|value) does not match its schema/);
    expect(await controller.input.get(["slot"])).toBe(7);
  });

  it("ignores a narrowed carried schema in favor of the producer contract", async () => {
    const sourcePiece = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: { type: "object", properties: {} },
        resultSchema: {
          type: "object",
          properties: { value: { type: ["number", "string"] } },
          required: ["value"],
        },
        result: { value: 1 },
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    const targetPiece = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          type: "object",
          properties: { slot: { type: "number" } },
          required: ["slot"],
        },
        resultSchema: { type: "object", properties: {} },
        result: {},
        nodes: [],
      }),
      { slot: 0 },
      undefined,
      { start: true },
    );
    const controller = new PieceController(pieces, targetPiece);
    const inputCell = await controller.input.getCell();
    const narrowed = sourcePiece.key("value").asSchema({ type: "number" });

    await expect(
      controller.input.set(
        narrowed.getAsLink({
          base: inputCell.key("slot"),
          includeSchema: true,
        }),
        ["slot"],
      ),
    ).rejects.toThrow(/input link.*schema is not compatible/);
    await expect(
      controller.input.set(narrowed, ["slot"]),
    ).rejects.toThrow(/input link.*schema is not compatible/);

    const standalone = runtime.getCell<number>(
      pieces.getSpace(),
      "standalone-link-without-contract-" + crypto.randomUUID(),
      { type: "number" },
    );
    await runtime.editWithRetry((tx) => standalone.withTx(tx).set(1));
    await expect(
      controller.input.set(standalone, ["slot"]),
    ).rejects.toThrow(/source has no durable schema contract/);

    const argumentSourcePiece = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          type: "object",
          properties: { value: { type: "number" } },
          required: ["value"],
        },
        resultSchema: { type: "object", properties: {} },
        result: {},
        nodes: [],
      }),
      { value: 1 },
      undefined,
      { start: true },
    );
    await expect(
      controller.input.set(
        pieces.getArgument(argumentSourcePiece).key("value"),
        ["slot"],
      ),
    ).resolves.toBeUndefined();
    expect(await controller.input.get(["slot"])).toBe(1);
  });

  it("hydrates path defaults while retaining raw explicit undefined", async () => {
    const pattern: Pattern = {
      argumentSchema: {
        type: "object",
        properties: {
          settings: {
            type: "object",
            properties: {
              mode: { type: "string" },
              attempts: { type: "number", default: 1 },
              label: {
                type: ["string", "undefined"],
                default: "fallback",
              },
            },
            required: ["mode", "attempts", "label"],
          },
        },
        required: ["settings"],
      },
      resultSchema: { type: "object", properties: {} },
      result: {},
      nodes: [],
    };
    const piece = await pieces.runPersistent(
      trustPattern(runtime, pattern),
      { settings: { mode: "old", attempts: 1, label: "old" } },
      undefined,
      { start: true },
    );
    const controller = new PieceController(pieces, piece);

    await controller.input.set(
      { mode: "new", label: undefined },
      ["settings"],
    );
    const settings = await controller.input.get(["settings"]) as Record<
      string,
      unknown
    >;
    expect(settings.mode).toBe("new");
    expect(settings.attempts).toBe(1);
    expect(Object.hasOwn(settings, "label")).toBe(true);
    // Typed reads intentionally project a schema default over undefined.
    expect(settings.label).toBe("fallback");
    const rawInput = (await controller.input.getCell()).asSchema(undefined)
      .get() as { settings: Record<string, unknown> };
    expect(Object.hasOwn(rawInput.settings, "label")).toBe(true);
    expect(rawInput.settings.label).toBeUndefined();

    await controller.input.set("again", ["settings", "label"]);
    await controller.input.set(undefined, ["settings", "label"]);
    const explicit = await controller.input.get(["settings"]) as Record<
      string,
      unknown
    >;
    expect(Object.hasOwn(explicit, "label")).toBe(true);
    expect(explicit.label).toBe("fallback");
    const rawExplicit = (await controller.input.getCell()).asSchema(undefined)
      .get() as { settings: Record<string, unknown> };
    expect(Object.hasOwn(rawExplicit.settings, "label")).toBe(true);
    expect(rawExplicit.settings.label).toBeUndefined();
  });

  it("stores explicit undefined at absent object and array paths", async () => {
    const pattern: Pattern = {
      argumentSchema: {
        type: "object",
        properties: {
          slot: { type: ["number", "undefined"] },
          label: {
            type: ["string", "undefined"],
            default: "fallback",
          },
          items: {
            type: "array",
            items: { type: ["number", "undefined"] },
          },
        },
        required: ["slot", "items"],
      },
      resultSchema: { type: "object", properties: {} },
      result: {},
      nodes: [],
    };
    const items = new Array(1);
    const piece = await pieces.runPersistent(
      trustPattern(runtime, pattern),
      { items },
      undefined,
      { start: true },
    );
    const controller = new PieceController(pieces, piece);

    await controller.input.set(undefined, ["slot"]);
    await controller.input.set(undefined, ["label"]);
    await controller.input.set(undefined, ["items", 0]);

    const rawInput = (await controller.input.getCell()).asSchema(undefined)
      .get() as { slot?: unknown; label?: unknown; items: unknown[] };
    expect(Object.hasOwn(rawInput, "slot")).toBe(true);
    expect(rawInput.slot).toBeUndefined();
    expect(Object.hasOwn(rawInput, "label")).toBe(true);
    expect(rawInput.label).toBeUndefined();
    expect(Object.hasOwn(rawInput.items, 0)).toBe(true);
    expect(rawInput.items[0]).toBeUndefined();
    expect(await controller.input.get(["label"])).toBe("fallback");
  });

  it("stores explicit undefined at result object and array paths", async () => {
    const resultSchema = {
      type: "object",
      properties: {
        slot: { type: ["number", "undefined"] },
        label: {
          type: ["string", "undefined"],
          default: "fallback",
        },
        items: {
          type: "array",
          items: { type: ["number", "undefined"] },
        },
      },
      required: ["items"],
    } as const;
    const resultItems = new Array(1);
    const pattern: Pattern = {
      argumentSchema: { type: "object", properties: {} },
      resultSchema,
      result: { items: resultItems },
      nodes: [],
    };
    const piece = await pieces.runPersistent(
      trustPattern(runtime, pattern),
      {},
      undefined,
      { start: true },
    );
    const controller = new PieceController(pieces, piece);

    await controller.result.set(undefined, ["slot"]);
    await controller.result.set(undefined, ["label"]);
    await controller.result.set(undefined, ["items", 0]);

    const rawResult = (await controller.result.getCell()).asSchema(undefined)
      .get() as { slot?: unknown; label?: unknown; items: unknown[] };
    expect(Object.hasOwn(rawResult, "slot")).toBe(true);
    expect(rawResult.slot).toBeUndefined();
    expect(Object.hasOwn(rawResult, "label")).toBe(true);
    expect(rawResult.label).toBeUndefined();
    expect(Object.hasOwn(rawResult.items, 0)).toBe(true);
    expect(rawResult.items[0]).toBeUndefined();
    expect(await controller.result.get(["label"])).toBe("fallback");
  });

  it("selects root union defaults for a path write", async () => {
    const pattern: Pattern = {
      argumentSchema: {
        type: "object",
        anyOf: [
          {
            type: "object",
            properties: {
              kind: { const: "a" },
              settings: {
                type: "object",
                properties: {
                  attempts: { type: "number", default: 1 },
                },
                required: ["attempts"],
              },
            },
            required: ["kind", "settings"],
          },
          {
            type: "object",
            properties: {
              kind: { const: "b" },
              settings: {
                type: "object",
                properties: {
                  retries: { type: "number", default: 2 },
                },
                required: ["retries"],
              },
            },
            required: ["kind", "settings"],
          },
        ],
      },
      resultSchema: { type: "object", properties: {} },
      result: {},
      nodes: [],
    };
    const piece = await pieces.runPersistent(
      trustPattern(runtime, pattern),
      { kind: "a", settings: { attempts: 7 } },
      undefined,
      { start: true },
    );
    const controller = new PieceController(pieces, piece);

    await controller.input.set({}, ["settings"]);

    const rawInput = (await controller.input.getCell()).asSchema(undefined)
      .get();
    expect(rawInput).toEqual({
      kind: "a",
      settings: { attempts: 1 },
    });
    expect(validateSchemaValue(pattern.argumentSchema, rawInput))
      .toBeUndefined();
    expect(await controller.input.get(["kind"])).toBe("a");

    await expect(controller.input.set("b", ["kind"])).rejects.toThrow(
      /updated input does not match its schema/,
    );
    const afterRejectedSwitch = (await controller.input.getCell()).asSchema(
      undefined,
    ).get();
    expect(afterRejectedSwitch).toEqual(rawInput);
    expect(validateSchemaValue(pattern.argumentSchema, afterRejectedSwitch))
      .toBeUndefined();
  });

  it("hydrates item-schema defaults for an array element write", async () => {
    const pattern: Pattern = {
      argumentSchema: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                mode: { type: "string" },
                attempts: { type: "number", default: 1 },
              },
              required: ["mode", "attempts"],
            },
          },
        },
        required: ["items"],
      },
      resultSchema: { type: "object", properties: {} },
      result: {},
      nodes: [],
    };
    const piece = await pieces.runPersistent(
      trustPattern(runtime, pattern),
      { items: [{ mode: "old", attempts: 2 }] },
      undefined,
      { start: true },
    );
    const controller = new PieceController(pieces, piece);

    await controller.input.set({ mode: "new" }, ["items", 0]);

    const rawInput = (await controller.input.getCell()).asSchema(undefined)
      .get();
    expect(rawInput).toEqual({
      items: [{ mode: "new", attempts: 1 }],
    });
  });

  it("hydrates array item defaults for root and whole-array writes", async () => {
    const pattern: Pattern = {
      argumentSchema: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                attempts: { type: "number", default: 1 },
              },
              required: ["attempts"],
            },
          },
        },
        required: ["items"],
      },
      resultSchema: { type: "object", properties: {} },
      result: {},
      nodes: [],
    };
    const piece = await pieces.runPersistent(
      trustPattern(runtime, pattern),
      { items: [{ attempts: 9 }] },
      undefined,
      { start: true },
    );
    const controller = new PieceController(pieces, piece);

    await controller.input.set({ items: [{}] });
    expect(await controller.input.get()).toEqual({
      items: [{ attempts: 1 }],
    });

    await controller.input.set([{}], ["items"]);
    expect(await controller.input.get()).toEqual({
      items: [{ attempts: 1 }],
    });
  });

  it("uses a root discriminator to select array item defaults", async () => {
    const pattern: Pattern = {
      argumentSchema: {
        type: "object",
        anyOf: [
          {
            type: "object",
            properties: {
              kind: { const: "a" },
              items: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    attempts: { type: "number", default: 1 },
                  },
                  required: ["attempts"],
                },
              },
            },
            required: ["kind", "items"],
          },
          {
            type: "object",
            properties: {
              kind: { const: "b" },
              items: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    retries: { type: "number", default: 2 },
                  },
                  required: ["retries"],
                },
              },
            },
            required: ["kind", "items"],
          },
        ],
      },
      resultSchema: { type: "object", properties: {} },
      result: {},
      nodes: [],
    };
    const piece = await pieces.runPersistent(
      trustPattern(runtime, pattern),
      { kind: "a", items: [{ attempts: 7 }] },
      undefined,
      { start: true },
    );
    const controller = new PieceController(pieces, piece);

    await controller.input.set({}, ["items", 0]);

    const rawInput = (await controller.input.getCell()).asSchema(undefined)
      .get();
    expect(rawInput).toEqual({ kind: "a", items: [{ attempts: 1 }] });
  });

  it("materializes piece results before runWithPattern returns", async () => {
    const piece = await pieces.runPersistent(
      trustPattern(runtime, doublePattern()),
      { input: 5 },
      undefined,
      { start: true },
    );

    expect(pieces.getResult(piece).get()).toEqual({ output: 10 });

    await pieces.runWithPattern(
      trustPattern(runtime, tenfoldPattern()),
      entityRefToString(piece.entityId),
      { input: 5 },
      { start: true },
    );

    expect(pieces.getResult(piece).get()).toEqual({ output: 50 });
  });

  it("stores repository metadata when preparing without starting", async () => {
    const repository = "https://github.com/commonfabric/labs";
    const piece = await pieces.runPersistent(
      trustPattern(runtime, doublePattern()),
      { input: 5 },
      undefined,
      { start: false },
    );

    await pieces.runWithPattern(
      trustPattern(runtime, tenfoldPattern()),
      entityRefToString(piece.entityId),
      { input: 5 },
      { start: false, repository },
    );

    expect(getPatternRepository(piece)).toBe(repository);
  });

  it("moves a source-less programmatic piece into source history on edit", async () => {
    const piece = await pieces.runPersistent(
      trustPattern(
        runtime,
        sourceLessMultiplierPattern("source-less", 2),
      ),
      { input: 5 },
      "source-less-set-pattern-" + crypto.randomUUID(),
      { start: true },
    );
    // A hand-built (keyless) piece writes no durable pattern pointer (the
    // never-durable contract; L3(a), RULED 2026-08-27); its session
    // identity lives on the runner.
    expect(getPatternIdentityRef(piece)).toBeUndefined();
    expect(runtime.runner.sessionPatternPointerFor(piece)).toBeDefined();
    expect(getPieceSourceRevisions(piece)).toEqual([]);

    const controller = new PieceController(pieces, piece);
    await controller.setPattern(
      compiledMultiplierProgram("source-backed", 3),
    );

    expect(
      getPieceSourceRevisions(piece).map((revision) => revision.operation),
    ).toEqual(["edit"]);
    // The displaced executable was a session-built value no session can
    // reload: a keyless identity never lands durably, so no
    // `displacedPattern` record is stamped — the history's absent baseline
    // is the record that the pre-edit past was programmatic.
    expect((await readPieceSourceState(runtime, piece)).displacedPattern)
      .toBeUndefined();
    expect(await controller.result.get()).toEqual({
      version: "source-backed",
      output: 15,
    });
  });

  it("syncPattern prefers the live session pointer over a legacy keyless durable pointer", async () => {
    const piece = await pieces.runPersistent(
      trustPattern(
        runtime,
        sourceLessMultiplierPattern("sync-legacy-keyless", 2),
      ),
      { input: 5 },
      "sync-legacy-keyless-" + crypto.randomUUID(),
      { start: true },
    );
    expect(getPatternIdentityRef(piece)).toBeUndefined();
    expect(runtime.runner.sessionPatternPointerFor(piece)).toBeDefined();

    // A legacy pre-guard durable `keyless:` orphan landing AFTER this
    // session's keyless setup — the remote-sync-lag interleaving (the
    // in-session setup cleared the metas transactionally; a lagging sync
    // can still deliver the old record afterwards). Such a pointer is
    // unloadable everywhere except the session that MINTED it — never this
    // one — so it must not shadow the live session pointer.
    const { error } = await runtime.editWithRetry((tx) => {
      piece.withTx(tx).setMetaRaw("patternIdentity", {
        identity: "keyless:fid1:legacy-orphan-from-a-pre-guard-session",
        symbol: "default",
      }, rawMetaWriteAuthorization);
    });
    expect(error).toBeUndefined();

    const pattern = await pieces.syncPattern(piece);
    expect(pattern).toBeDefined();
  });

  it("persists setPattern replacement by identity for fresh runtime reloads", async () => {
    const repository = "https://github.com/commonfabric/labs";
    const firstPattern = await runtime.patternManager.compilePattern(
      compiledMultiplierProgram("v1", 2),
      { space: pieces.getSpace() },
    );
    const piece = await pieces.runPersistent(
      firstPattern,
      { input: 5 },
      "compiled-set-pattern-" + crypto.randomUUID(),
      { start: true, repository },
    );
    const id = entityRefToString(piece.entityId);
    const controller = new PieceController(pieces, piece);
    const firstRef = getPatternIdentityRef(piece);

    expect(firstRef).toBeDefined();
    expect(pieces.getResult(piece).get()).toEqual({
      version: "v1",
      output: 10,
    });

    await controller.setPattern(
      compiledMultiplierProgram(
        "v2",
        10,
        "/packages/patterns/examples/multiplier.tsx",
      ),
      { repository },
    );
    await pieces.runtime.idle();
    await pieces.synced();

    const secondRef = getPatternIdentityRef(piece);
    expect(secondRef).toBeDefined();
    expect(secondRef!.identity).not.toEqual(firstRef!.identity);
    expect(pieces.getResult(piece).get()).toEqual({
      version: "v2",
      output: 50,
    });

    const session = await createSession({
      identity: signer,
      spaceName: pieces.getSpaceName()!,
    });
    const freshRuntime = new Runtime({
      apiUrl: new URL("http://localhost:9999"),
      storageManager,
    });
    const freshPieces = new PiecesController(session, freshRuntime);

    try {
      await freshPieces.synced();
      const freshPiece = await freshPieces.get(id, true);
      const freshCell = freshPiece.getCell();
      const freshRef = getPatternIdentityRef(freshCell);

      expect(freshRef).toEqual(secondRef);
      expect(await freshPiece.result.get()).toEqual({
        version: "v2",
        output: 50,
      });
      const source = await freshPiece.getPatternSourceProgram();
      expect(source?.files.some((file) => file.contents.includes("v2"))).toBe(
        true,
      );
      expect(await freshPiece.getPatternRef()).toEqual({
        ...freshRef,
        source: {
          ref: `cf:pattern:${freshRef!.identity}`,
          repository,
          entry: "/packages/patterns/examples/multiplier.tsx",
        },
      });
      expect(getPatternRepository(freshCell)).toBe(repository);
    } finally {
      await freshRuntime.dispose();
    }
  });

  it("preserves a repository until a source update explicitly replaces it", async () => {
    const originalRepository = "https://github.com/commonfabric/labs";
    const replacementRepository = "https://github.com/commonfabric/patterns";
    const firstPattern = await runtime.patternManager.compilePattern(
      compiledMultiplierProgram("v1", 2),
      { space: pieces.getSpace() },
    );
    const piece = await pieces.runPersistent(
      firstPattern,
      { input: 5 },
      "repository-update-" + crypto.randomUUID(),
      { start: true, repository: originalRepository },
    );
    const controller = new PieceController(pieces, piece);

    await controller.setPattern(compiledMultiplierProgram("v2", 3));
    expect(getPatternRepository(piece)).toBe(originalRepository);

    await controller.setPattern(compiledMultiplierProgram("v3", 4), {
      repository: replacementRepository,
    });
    expect(getPatternRepository(piece)).toBe(replacementRepository);
    expect((await controller.getPatternRef())?.source.repository).toBe(
      replacementRepository,
    );
  });

  it("recovers a durable contract through a scoped redirect link", async () => {
    const piece = await pieces.runPersistent(
      trustPattern(runtime, doublePattern()),
      { input: 5 },
      undefined,
      { start: true },
    );
    const argument = pieces.getArgument(piece);
    // Baseline: the producer-owned argument doc has a durable contract at its
    // own (base) scope.
    expect(durableSourceContract(argument, pieces)?.schemas.length)
      .toBeGreaterThan(0);

    // A PerUser/PerSession input is a redirect to that same producer-owned
    // doc, but tagged with a non-base scope. Producer-owned metadata lives
    // only in the base ("space") partition, so recovery must read there — not
    // the redirect link's own "user"/"session" partition, which holds only the
    // scoped value. Regression guard for #4717: reading scope-locally makes
    // every scoped input permanently reject an in-place setsrc with
    // "source has no durable schema contract".
    for (const scope of ["user", "session"] as const) {
      const scopedSource = runtime.getCellFromLink({
        ...argument.getAsNormalizedFullLink(),
        scope,
      });
      const contract = durableSourceContract(scopedSource, pieces);
      expect(contract?.schemas.length, `scope=${scope}`).toBeGreaterThan(0);
    }
  });

  it("updates a piece whose argument holds scoped and mergeable-element links", async () => {
    // Mirrors a deployed piece: a `PerUser` input is stored as a scoped
    // redirect link, and a mergeable push stores the array element as its own
    // metadata-less document linked from the array. Neither link's contract is
    // provable from the linked document alone; the first recovers through the
    // base-scope producer metadata, the second through the prior pattern's
    // argument contract. Regression guard for the #4717 validation rejecting
    // both shapes ("source has no durable schema contract") and the optional
    // destination slot ("a schema alternative accepted previously...").
    const compiled = await runtime.patternManager.compilePattern(
      compiledScopedInputProgram("v1"),
      { space: pieces.getSpace() },
    );
    const piece = await pieces.runPersistent(
      compiled,
      {},
      "scoped-mergeable-update-" + crypto.randomUUID(),
      { start: true },
    );
    await runtime.idle();
    const controller = new PieceController(pieces, piece);
    const argument = pieces.getArgument(piece);
    const rawWho =
      (argument.getRawUntyped({ lastNode: "top" }) as Record<string, unknown>)
        .who;
    expect(isLink(rawWho)).toBe(true);

    // A version bump forces the full validation path (an identical pattern
    // identity short-circuits before link validation).
    await controller.setPattern(compiledScopedInputProgram("v2"));
    expect(await controller.result.get()).toMatchObject({ count: 0 });

    await runtime.editWithRetry((tx) => {
      (argument.withTx(tx).key("options") as unknown as {
        push: (value: unknown) => void;
      }).push({ title: "Test Cafe" });
    });
    await runtime.idle();
    const rawOptions =
      (argument.getRawUntyped({ lastNode: "top" }) as Record<string, unknown>)
        .options;
    expect(isLink((rawOptions as unknown[])[0])).toBe(true);

    await controller.setPattern(compiledScopedInputProgram("v3"));
    expect(await controller.result.get()).toMatchObject({ count: 1 });
    expect(await controller.input.get()).toMatchObject({
      options: [{ title: "Test Cafe" }],
    });
  });

  it("rejects a producer-declared undefined alternative at an optional destination", async () => {
    // Destination optionality permits *omission*, not a present `undefined`
    // value: a producer whose contract admits `undefined` as a value must
    // still be rejected when the destination value schema does not accept it,
    // even at an optional slot.
    const sourcePiece = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          type: "object",
          properties: {
            value: { anyOf: [{ type: "string" }, { type: "undefined" }] },
          },
          required: ["value"],
        },
        resultSchema: { type: "object", properties: {} },
        result: {},
        nodes: [],
      }),
      { value: "present" },
      undefined,
      { start: true },
    );
    const targetPiece = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          type: "object",
          properties: { slot: { type: "string" } },
        },
        resultSchema: { type: "object", properties: {} },
        result: {},
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    await expect(
      new PieceController(pieces, targetPiece).input.set(
        pieces.getArgument(sourcePiece).key("value"),
        ["slot"],
      ),
    ).rejects.toThrow(/not accepted by the candidate/);
  });

  it("rejects a possibly-missing source at a required destination", async () => {
    const sourcePiece = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          type: "object",
          properties: { maybe: { type: "string" } },
        },
        resultSchema: { type: "object", properties: {} },
        result: {},
        nodes: [],
      }),
      { maybe: "present" },
      undefined,
      { start: true },
    );
    const targetPiece = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: {
          type: "object",
          properties: { slot: { type: "string" } },
          required: ["slot"],
        },
        resultSchema: { type: "object", properties: {} },
        result: {},
        nodes: [],
      }),
      { slot: "seed" },
      undefined,
      { start: true },
    );
    await expect(
      new PieceController(pieces, targetPiece).input.set(
        pieces.getArgument(sourcePiece).key("maybe"),
        ["slot"],
      ),
    ).rejects.toThrow(/not accepted by the candidate/);
  });

  it("updates a piece across backward-compatible schema additions", async () => {
    const firstPattern = await runtime.patternManager.compilePattern(
      compiledSchemaEvolutionProgram(1),
      { space: pieces.getSpace() },
    );
    const piece = await pieces.runPersistent(
      firstPattern,
      { value: 4 },
      "compatible-schema-update-" + crypto.randomUUID(),
      { start: true },
    );
    const controller = new PieceController(pieces, piece);

    expect(await controller.input.get()).toEqual({ value: 4 });
    expect(await controller.result.get()).toEqual({ doubled: 4 });

    await controller.setPattern(compiledSchemaEvolutionProgram(2));

    const updatedPattern = await controller.getPattern();
    expect(updatedPattern.result).toMatchObject({ summary: "updated" });
    const inputProperties = updatedPattern.argumentSchema &&
        typeof updatedPattern.argumentSchema === "object"
      ? updatedPattern.argumentSchema.properties
      : undefined;
    expect(inputProperties?.mode).toMatchObject({
      type: ["number", "string"],
    });
    expect(await controller.input.get()).toEqual({
      value: 4,
      retries: 0,
      options: { attempts: 1 },
    });
    const rawInput = (await controller.input.getCell()).getRaw();
    expect(rawInput).toEqual({
      value: 4,
      retries: 0,
      options: { attempts: 1 },
    });
    expect(validateAgainstSchema(updatedPattern.argumentSchema, rawInput))
      .toBeUndefined();
    expect(await controller.result.get()).toEqual({
      doubled: 4,
      summary: "updated",
    });
  });

  it("migrates defaults through array items and dynamic fields", async () => {
    const arrayPiece = await pieces.runPersistent(
      await runtime.patternManager.compilePattern(
        compiledArrayItemDefaultsProgram(1),
        { space: pieces.getSpace() },
      ),
      { items: [{}] },
      "array-default-migration-" + crypto.randomUUID(),
      { start: true },
    );
    const arrayController = new PieceController(pieces, arrayPiece);
    await arrayController.setPattern(compiledArrayItemDefaultsProgram(2));
    expect((await arrayController.input.getCell()).getRaw()).toEqual({
      items: [{ attempts: 1 }],
    });

    const dynamicPiece = await pieces.runPersistent(
      await runtime.patternManager.compilePattern(
        compiledDynamicDefaultsProgram(1),
        { space: pieces.getSpace() },
      ),
      { extra: {} },
      "dynamic-default-migration-" + crypto.randomUUID(),
      { start: true },
    );
    const dynamicController = new PieceController(pieces, dynamicPiece);
    await dynamicController.setPattern(compiledDynamicDefaultsProgram(2));
    expect((await dynamicController.input.getCell()).getRaw()).toEqual({
      extra: { attempts: 1 },
    });
  });

  it("updates a piece whose durable arguments contain links", async () => {
    const sourcePattern = doublePattern();
    sourcePattern.resultSchema = {
      type: "object",
      properties: { output: { type: "number" } },
      required: ["output"],
    };
    const source = await pieces.runPersistent(
      trustPattern(runtime, sourcePattern),
      { input: 5 },
      "linked-update-source-" + crypto.randomUUID(),
      { start: true },
    );
    const firstPattern = await runtime.patternManager.compilePattern(
      compiledMultiplierProgram("v1", 2),
      { space: pieces.getSpace() },
    );
    const target = await pieces.runPersistent(
      firstPattern,
      { input: 1 },
      "linked-update-target-" + crypto.randomUUID(),
      { start: true },
    );
    const controller = new PieceController(pieces, target);

    await pieces.link(
      entityRefToString(source.entityId),
      ["output"],
      entityRefToString(target.entityId),
      ["input"],
    );

    expect(await controller.input.get()).toEqual({ input: 10 });
    expect(await controller.result.get()).toEqual({
      version: "v1",
      output: 20,
    });
    const rawBefore = (await controller.input.getCell()).getRaw();
    expect(rawBefore).not.toEqual({ input: 10 });

    await controller.setPattern(compiledMultiplierProgram("v2", 10));

    expect((await controller.input.getCell()).getRaw()).toEqual(rawBefore);
    expect(await controller.input.get()).toEqual({ input: 10 });
    expect(await controller.result.get()).toEqual({
      version: "v2",
      output: 100,
    });
  });

  it("preserves linked objects while adding nested defaults", async () => {
    const source = await pieces.runPersistent(
      trustPattern(runtime, linkedSettingsSourcePattern()),
      {},
      "linked-object-default-source-" + crypto.randomUUID(),
      { start: true },
    );
    const firstPattern = await runtime.patternManager.compilePattern(
      compiledLinkedSettingsProgram(1),
      { space: pieces.getSpace() },
    );
    const target = await pieces.runPersistent(
      firstPattern,
      { settings: { mode: "local" } },
      "linked-object-default-target-" + crypto.randomUUID(),
      { start: true },
    );
    const controller = new PieceController(pieces, target);

    await pieces.link(
      entityRefToString(source.entityId),
      ["settings"],
      entityRefToString(target.entityId),
      ["settings"],
    );
    const rawBefore = (await controller.input.getCell()).getRaw();
    expect(await controller.input.get()).toMatchObject({
      settings: { mode: "linked" },
    });

    await controller.setPattern(compiledLinkedSettingsProgram(2));

    expect((await controller.input.getCell()).getRaw()).toEqual(rawBefore);
    expect(await controller.input.get()).toEqual({
      settings: { mode: "linked", attempts: 1 },
    });
    expect(await controller.result.get()).toEqual({ mode: "linked" });
  });

  it("preserves caller-supplied raw links at and below a write path", async () => {
    const sourcePattern: Pattern = {
      argumentSchema: { type: "object", properties: {} },
      resultSchema: {
        type: "object",
        properties: {
          settings: {
            type: "object",
            properties: {
              mode: { type: "string" },
              attempts: { type: "number" },
            },
            required: ["mode", "attempts"],
          },
        },
        required: ["settings"],
      },
      result: { settings: { mode: "linked", attempts: 3 } },
      nodes: [],
    };
    const source = await pieces.runPersistent(
      trustPattern(runtime, sourcePattern),
      {},
      "raw-link-path-source-" + crypto.randomUUID(),
      { start: true },
    );
    const targetPattern = await runtime.patternManager.compilePattern(
      compiledLinkedSettingsProgram(2),
      { space: pieces.getSpace() },
    );
    const target = await pieces.runPersistent(
      targetPattern,
      { settings: { mode: "local", attempts: 1 } },
      "raw-link-path-target-" + crypto.randomUUID(),
      { start: true },
    );
    const controller = new PieceController(pieces, target);
    await pieces.link(
      entityRefToString(source.entityId),
      ["settings"],
      entityRefToString(target.entityId),
      ["settings"],
    );
    const rawBefore = (await controller.input.getCell()).getRaw() as {
      settings: unknown;
    };

    await controller.input.set(rawBefore.settings, ["settings"]);

    expect((await controller.input.getCell()).getRaw()).toEqual(rawBefore);
    await controller.input.set({ settings: rawBefore.settings });
    expect((await controller.input.getCell()).getRaw()).toEqual(rawBefore);
    expect(await controller.input.get()).toEqual({
      settings: { mode: "linked", attempts: 3 },
    });
  });

  it("rejects an incompatible schema update before changing the piece", async () => {
    const firstPattern = await runtime.patternManager.compilePattern(
      compiledSchemaEvolutionProgram(1),
      { space: pieces.getSpace() },
    );
    const piece = await pieces.runPersistent(
      firstPattern,
      { value: 4 },
      "incompatible-schema-update-" + crypto.randomUUID(),
      { start: true },
    );
    const controller = new PieceController(pieces, piece);
    const previousRef = getPatternIdentityRef(controller.getCell());

    await expect(
      controller.setPattern(compiledSchemaEvolutionProgram(3)),
    ).rejects.toThrow(/not backward compatible/);

    expect(getPatternIdentityRef(controller.getCell())).toEqual(previousRef);
    expect(await controller.input.get()).toEqual({ value: 4 });
    expect(await controller.result.get()).toEqual({ doubled: 4 });
  });

  it("allows an explicitly authorized incompatible schema update", async () => {
    const firstPattern = await runtime.patternManager.compilePattern(
      compiledResultNarrowingProgram("number"),
      { space: pieces.getSpace() },
    );
    const piece = await pieces.runPersistent(
      firstPattern,
      { input: 5 },
      "allowed-incompatible-schema-update-" + crypto.randomUUID(),
      { start: true },
    );
    const controller = new PieceController(pieces, piece);

    await controller.setPattern(
      compiledResultNarrowingProgram("string | number"),
      { dangerouslyAllowIncompatibleSchema: true },
    );

    expect(await controller.result.get()).toEqual({ value: 5 });
  });

  it("does not hydrate an invalid partial default into an optional object", async () => {
    const firstPattern = await runtime.patternManager.compilePattern(
      compiledOptionalPartialDefaultProgram(1),
      { space: pieces.getSpace() },
    );
    const piece = await pieces.runPersistent(
      firstPattern,
      { value: 4 },
      "optional-partial-default-" + crypto.randomUUID(),
      { start: true },
    );
    const controller = new PieceController(pieces, piece);

    await controller.setPattern(compiledOptionalPartialDefaultProgram(2));

    const updatedPattern = await controller.getPattern();
    const rawInput = (await controller.input.getCell()).getRaw();
    expect(rawInput).toEqual({ value: 4 });
    expect(validateSchemaValue(updatedPattern.argumentSchema, rawInput))
      .toBeUndefined();
  });

  it("does not hydrate an invalid partial ref default on first start", async () => {
    const pattern = await runtime.patternManager.compilePattern(
      compiledOptionalPartialDefaultProgram(2),
      { space: pieces.getSpace() },
    );
    const piece = await pieces.runPersistent(
      pattern,
      { value: 4 },
      "optional-partial-default-first-start-" + crypto.randomUUID(),
      { start: true },
    );
    const controller = new PieceController(pieces, piece);
    const rawInput = (await controller.input.getCell()).getRaw();

    expect(rawInput).toEqual({ value: 4 });
    expect(validateSchemaValue(pattern.argumentSchema, rawInput))
      .toBeUndefined();
  });

  it("preserves conflicting defined values while merging object defaults", async () => {
    const originalRepository = "https://github.com/commonfabric/labs";
    const firstPattern = await runtime.patternManager.compilePattern(
      compiledDefaultedOptionsProgram(1),
      { space: pieces.getSpace() },
    );
    const piece = await pieces.runPersistent(
      firstPattern,
      { value: 4 },
      "defined-object-default-conflict-" + crypto.randomUUID(),
      { start: true, repository: originalRepository },
    );
    const controller = new PieceController(pieces, piece);
    const inputCell = await controller.input.getCell();
    await runtime.editWithRetry((tx) => {
      inputCell.withTx(tx).setRawUntyped({
        value: 4,
        options: "legacy",
      });
    });
    const previousRef = getPatternIdentityRef(piece);

    await expect(
      controller.setPattern(compiledDefaultedOptionsProgram(2), {
        repository: "https://github.com/commonfabric/other",
      }),
    ).rejects.toThrow(/updated arguments do not match the candidate schema/);

    expect(getPatternIdentityRef(piece)).toEqual(previousRef);
    expect(getPatternRepository(piece)).toBe(originalRepository);
    expect(inputCell.getRaw()).toEqual({ value: 4, options: "legacy" });
  });

  it("rejects an optional field update that conflicts with durable raw args", async () => {
    const firstPattern = await runtime.patternManager.compilePattern(
      compiledOptionalNumberFieldProgram(1),
      { space: pieces.getSpace() },
    );
    const piece = await pieces.runPersistent(
      firstPattern,
      { value: 4 },
      "optional-field-conflict-" + crypto.randomUUID(),
      { start: true },
    );
    const controller = new PieceController(pieces, piece);
    const inputCell = await controller.input.getCell();
    await runtime.editWithRetry((tx) => {
      inputCell.withTx(tx).setRawUntyped({
        value: 4,
        mode: "legacy-string",
      });
    });
    const previousRef = getPatternIdentityRef(piece);

    await expect(
      controller.setPattern(compiledOptionalNumberFieldProgram(2)),
    ).rejects.toThrow(/updated arguments do not match the candidate schema/);

    const candidate = await runtime.patternManager.compilePattern(
      compiledOptionalNumberFieldProgram(2),
      { space: pieces.getSpace() },
    );
    await expect(
      pieces.runWithPattern(candidate, controller.id),
    ).rejects.toThrow(/updated arguments do not match the candidate schema/);

    expect(getPatternIdentityRef(piece)).toEqual(previousRef);
    expect(inputCell.getRaw()).toEqual({ value: 4, mode: "legacy-string" });
  });

  it("validates legacy-open setInput calls against the updated schema", async () => {
    const piece = await pieces.runPersistent(
      await runtime.patternManager.compilePattern(
        compiledOptionalNumberFieldProgram(1),
        { space: pieces.getSpace() },
      ),
      { value: 4 },
      "optional-field-set-input-" + crypto.randomUUID(),
      { start: true },
    );
    const controller = new PieceController(pieces, piece);
    await controller.setPattern(compiledOptionalNumberFieldProgram(2));

    await expect(
      controller.setInput({ value: 4, mode: "legacy-string" }),
    ).rejects.toThrow(/updated arguments do not match the candidate schema/);
    expect((await controller.input.getCell()).getRaw()).toEqual({ value: 4 });
  });

  it("re-proves retained durable links against the candidate schema", async () => {
    const sourcePiece = await pieces.runPersistent(
      trustPattern(runtime, {
        argumentSchema: { type: "object", properties: {} },
        resultSchema: {
          type: "object",
          properties: { value: { type: ["number", "string"] } },
          required: ["value"],
        },
        result: { value: 1 },
        nodes: [],
      }),
      {},
      undefined,
      { start: true },
    );
    const piece = await pieces.runPersistent(
      await runtime.patternManager.compilePattern(
        compiledOptionalNumberFieldProgram(1),
        { space: pieces.getSpace() },
      ),
      { value: 4 },
      "optional-field-linked-contract-" + crypto.randomUUID(),
      { start: true },
    );
    const controller = new PieceController(pieces, piece);
    const previousRef = getPatternIdentityRef(piece);

    // Seed a retained link written before the pattern declared this input.
    // Piece IO refuses new writes through such a hidden path.
    const inputCell = await controller.input.getCell();
    const write = await runtime.editWithRetry((tx) => {
      inputCell.withTx(tx).key("mode").setRawUntyped(
        sourcePiece.key("value").getAsLink({
          base: inputCell,
          includeSchema: true,
        }),
      );
    });
    expect(write.error).toBeUndefined();
    await expect(
      controller.setPattern(compiledOptionalNumberFieldProgram(2)),
    ).rejects.toThrow(/input link.*schema is not compatible/);

    expect(getPatternIdentityRef(piece)).toEqual(previousRef);

    await controller.setPattern(compiledOptionalNumberFieldProgram(2), {
      dangerouslyAllowIncompatibleSchema: true,
    });
    expect(getPatternIdentityRef(piece)).not.toEqual(previousRef);
    expect(await controller.result.get()).toEqual({ value: 4 });
  });

  it("does not accept a linked stream as an optional scalar during migration", async () => {
    const firstPattern = await runtime.patternManager.compilePattern(
      compiledOptionalNumberFieldProgram(1),
      { space: pieces.getSpace() },
    );
    const piece = await pieces.runPersistent(
      firstPattern,
      { value: 4 },
      "optional-field-stream-conflict-" + crypto.randomUUID(),
      { start: true },
    );
    const controller = new PieceController(pieces, piece);
    const inputCell = await controller.input.getCell();
    const stream = runtime.getCell(
      pieces.getSpace(),
      "optional-field-stream-" + crypto.randomUUID(),
      { type: "number", asCell: ["stream"] },
    );
    await runtime.editWithRetry((tx) => {
      inputCell.withTx(tx).key("mode").setRawUntyped(
        stream.getAsLink({
          base: inputCell,
          includeSchema: true,
          keepAsCell: KeepAsCell.OnlyStream,
        }),
      );
    });
    const rawBefore = inputCell.getRaw();
    const previousRef = getPatternIdentityRef(piece);

    await expect(
      controller.setPattern(compiledOptionalNumberFieldProgram(2)),
    ).rejects.toThrow(/updated arguments do not match the candidate schema/);

    expect(getPatternIdentityRef(piece)).toEqual(previousRef);
    expect(inputCell.getRaw()).toEqual(rawBefore);
  });

  it("reapplies setInput against a concurrently installed pattern", async () => {
    const initialProgram = compiledMultiplierProgram("initial", 2);
    const winnerProgram = compiledMultiplierProgram("winner", 10);
    const initialPattern = await runtime.patternManager.compilePattern(
      initialProgram,
      { space: pieces.getSpace() },
    );
    const winnerPattern = await runtime.patternManager.compilePattern(
      winnerProgram,
      { space: pieces.getSpace() },
    );
    const piece = await pieces.runPersistent(
      initialPattern,
      { input: 5 },
      "set-input-pattern-race-" + crypto.randomUUID(),
      { start: true },
    );
    const controller = new PieceController(pieces, piece);
    const oldInputEntered = defer<void>();
    const releaseOldInput = defer<void>();
    const originalRunWithPattern = pieces.runWithPattern;
    pieces.runWithPattern = async (pattern, pieceId, inputs, options) => {
      if (
        pattern === initialPattern &&
        (inputs as { input?: number } | undefined)?.input === 7
      ) {
        oldInputEntered.resolve();
        await releaseOldInput.promise;
      }
      return await originalRunWithPattern.call(
        pieces,
        pattern,
        pieceId,
        inputs,
        options,
      );
    };
    const originalCompile = runtime.patternManager.compilePattern.bind(
      runtime.patternManager,
    );
    runtime.patternManager.compilePattern = (async (program, options) => {
      if (program === winnerProgram) return winnerPattern;
      return await originalCompile(program, options);
    }) as typeof runtime.patternManager.compilePattern;

    try {
      const inputUpdate = controller.setInput({ input: 7 });
      await oldInputEntered.promise;
      await controller.setPattern(winnerProgram);
      releaseOldInput.resolve();
      await inputUpdate;

      expect(getPatternIdentityRef(piece)).toEqual(
        runtime.patternManager.getArtifactEntryRef(winnerPattern),
      );
      expect(await controller.input.get()).toEqual({ input: 7 });
      expect(await controller.result.get()).toEqual({
        version: "winner",
        output: 70,
      });
    } finally {
      releaseOldInput.resolve();
      pieces.runWithPattern = originalRunWithPattern;
      runtime.patternManager.compilePattern = originalCompile;
    }
  });

  it("re-resolves input schema and defaults after a commit retry", async () => {
    const firstPattern = await runtime.patternManager.compilePattern(
      compiledSchemaEvolutionProgram(1),
      { space: pieces.getSpace() },
    );
    const piece = await pieces.runPersistent(
      firstPattern,
      { value: 4 },
      "piece-prop-schema-race-" + crypto.randomUUID(),
      { start: true },
    );
    const controller = new PieceController(pieces, piece);
    const commitEntered = defer<void>();
    const releaseCommit = defer<void>();
    const originalEditWithRetry = runtime.editWithRetry.bind(runtime);
    let interceptNextCommit = true;
    runtime.editWithRetry =
      ((action, maxRetries) =>
        originalEditWithRetry((transaction) => {
          const result = action(transaction);
          if (interceptNextCommit) {
            interceptNextCommit = false;
            const originalCommit = transaction.commit.bind(transaction);
            transaction.commit = async () => {
              commitEntered.resolve();
              await releaseCommit.promise;
              return await originalCommit();
            };
          }
          return result;
        }, maxRetries)) as typeof runtime.editWithRetry;

    try {
      const inputUpdate = controller.input.set({ value: 9 });
      await commitEntered.promise;
      await controller.setPattern(compiledSchemaEvolutionProgram(2));
      releaseCommit.resolve();
      await inputUpdate;

      const currentPattern = await controller.getPattern();
      const rawInput = (await controller.input.getCell()).getRaw();
      expect(rawInput).toEqual({
        value: 9,
        retries: 0,
        options: { attempts: 1 },
      });
      expect(validateSchemaValue(currentPattern.argumentSchema, rawInput))
        .toBeUndefined();
      expect(await controller.result.get()).toEqual({
        doubled: 9,
        summary: "updated",
      });
    } finally {
      releaseCommit.resolve();
      runtime.editWithRetry = originalEditWithRetry;
    }
  });

  it("re-resolves root schema defaults for a path write after retry", async () => {
    const firstPattern = await runtime.patternManager.compilePattern(
      compiledLinkedSettingsProgram(1),
      { space: pieces.getSpace() },
    );
    const piece = await pieces.runPersistent(
      firstPattern,
      { settings: { mode: "old" } },
      "piece-prop-path-schema-race-" + crypto.randomUUID(),
      { start: true },
    );
    const controller = new PieceController(pieces, piece);
    const commitEntered = defer<void>();
    const releaseCommit = defer<void>();
    const originalEditWithRetry = runtime.editWithRetry.bind(runtime);
    let interceptNextCommit = true;
    runtime.editWithRetry =
      ((action, maxRetries) =>
        originalEditWithRetry((transaction) => {
          const result = action(transaction);
          if (interceptNextCommit) {
            interceptNextCommit = false;
            const originalCommit = transaction.commit.bind(transaction);
            transaction.commit = async () => {
              commitEntered.resolve();
              await releaseCommit.promise;
              return await originalCommit();
            };
          }
          return result;
        }, maxRetries)) as typeof runtime.editWithRetry;

    try {
      const inputUpdate = controller.input.set(
        { mode: "new" },
        ["settings"],
      );
      await commitEntered.promise;
      await controller.setPattern(compiledLinkedSettingsProgram(2));
      releaseCommit.resolve();
      await inputUpdate;

      const currentPattern = await controller.getPattern();
      const rawInput = (await controller.input.getCell()).getRaw();
      expect(rawInput).toEqual({
        settings: { mode: "new", attempts: 1 },
      });
      expect(validateSchemaValue(currentPattern.argumentSchema, rawInput))
        .toBeUndefined();
    } finally {
      releaseCommit.resolve();
      runtime.editWithRetry = originalEditWithRetry;
    }
  });

  it("rejects a source update whose validated pattern identity became stale", async () => {
    const initialProgram = compiledResultNarrowingProgram("string | number");
    const stringProgram = compiledResultNarrowingProgram("string");
    const numberProgram = compiledResultNarrowingProgram("number");
    const initialPattern = await runtime.patternManager.compilePattern(
      initialProgram,
      { space: pieces.getSpace() },
    );
    const stringPattern = await runtime.patternManager.compilePattern(
      stringProgram,
      { space: pieces.getSpace() },
    );
    const numberPattern = await runtime.patternManager.compilePattern(
      numberProgram,
      { space: pieces.getSpace() },
    );
    const piece = await pieces.runPersistent(
      initialPattern,
      { input: 4 },
      "concurrent-schema-update-" + crypto.randomUUID(),
      { start: true },
    );
    const controller = new PieceController(pieces, piece);
    const compileEntered = defer<void>();
    const releaseCompile = defer<void>();
    const originalCompile = runtime.patternManager.compilePattern.bind(
      runtime.patternManager,
    );
    runtime.patternManager.compilePattern = (async (program, options) => {
      if (program === stringProgram) {
        compileEntered.resolve();
        await releaseCompile.promise;
        return stringPattern;
      }
      if (program === numberProgram) return numberPattern;
      return await originalCompile(program, options);
    }) as typeof runtime.patternManager.compilePattern;

    try {
      const staleUpdate = expect(controller.setPattern(stringProgram)).rejects
        .toThrow(/pattern changed while the source update was compiling/);
      await compileEntered.promise;
      await controller.setPattern(numberProgram);
      releaseCompile.resolve();
      await staleUpdate;

      expect(getPatternIdentityRef(piece)).toEqual(
        runtime.patternManager.getArtifactEntryRef(numberPattern),
      );
      expect(await controller.result.get()).toEqual({ value: 4 });

      await expect(
        pieces.runWithPattern(numberPattern, controller.id, undefined, {
          start: false,
          expectedPatternIdentity: getPatternIdentityRef(piece),
        }),
      ).rejects.toThrow(/atomic pattern updates require starting the piece/);
    } finally {
      releaseCompile.resolve();
      runtime.patternManager.compilePattern = originalCompile;
    }
  });

  it("rechecks the expected identity after a real commit-conflict retry", async () => {
    const initialProgram = compiledMultiplierProgram("initial", 1);
    const staleProgram = compiledMultiplierProgram("stale", 2);
    const winnerProgram = compiledMultiplierProgram("winner", 10);
    const initialPattern = await runtime.patternManager.compilePattern(
      initialProgram,
      { space: pieces.getSpace() },
    );
    const stalePattern = await runtime.patternManager.compilePattern(
      staleProgram,
      { space: pieces.getSpace() },
    );
    const winnerPattern = await runtime.patternManager.compilePattern(
      winnerProgram,
      { space: pieces.getSpace() },
    );
    const piece = await pieces.runPersistent(
      initialPattern,
      { input: 5 },
      "commit-conflict-update-" + crypto.randomUUID(),
      { start: false },
    );
    const controller = new PieceController(pieces, piece);
    const commitEntered = defer<void>();
    const releaseCommit = defer<void>();
    const originalEditWithRetry = runtime.editWithRetry.bind(runtime);
    let interceptNextCommit = true;
    runtime.editWithRetry =
      ((action, maxRetries) =>
        originalEditWithRetry((transaction) => {
          const result = action(transaction);
          if (interceptNextCommit) {
            interceptNextCommit = false;
            const originalCommit = transaction.commit.bind(transaction);
            transaction.commit = async () => {
              commitEntered.resolve();
              await releaseCommit.promise;
              return await originalCommit();
            };
          }
          return result;
        }, maxRetries)) as typeof runtime.editWithRetry;
    const originalCompile = runtime.patternManager.compilePattern.bind(
      runtime.patternManager,
    );
    runtime.patternManager.compilePattern = (async (program, options) => {
      if (program === staleProgram) return stalePattern;
      if (program === winnerProgram) return winnerPattern;
      return await originalCompile(program, options);
    }) as typeof runtime.patternManager.compilePattern;

    try {
      const staleUpdate = expect(controller.setPattern(staleProgram)).rejects
        .toThrow(/pattern changed while the source update was compiling/);
      await commitEntered.promise;
      await controller.setPattern(winnerProgram);
      releaseCommit.resolve();
      await staleUpdate;

      expect(getPatternIdentityRef(piece)).toEqual(
        runtime.patternManager.getArtifactEntryRef(winnerPattern),
      );
      expect(await controller.result.get()).toEqual({
        version: "winner",
        output: 50,
      });
    } finally {
      releaseCommit.resolve();
      runtime.editWithRetry = originalEditWithRetry;
      runtime.patternManager.compilePattern = originalCompile;
    }
  });

  it("returns the current winner's schema after a post-commit update race", async () => {
    const initialProgram = compiledResultNarrowingProgram(
      "string | number | boolean",
    );
    const firstProgram = compiledResultNarrowingProgram("string | number");
    const winnerProgram = compiledResultNarrowingProgram("number");
    const initialPattern = await runtime.patternManager.compilePattern(
      initialProgram,
      { space: pieces.getSpace() },
    );
    const firstPattern = await runtime.patternManager.compilePattern(
      firstProgram,
      { space: pieces.getSpace() },
    );
    const winnerPattern = await runtime.patternManager.compilePattern(
      winnerProgram,
      { space: pieces.getSpace() },
    );
    const piece = await pieces.runPersistent(
      initialPattern,
      { input: 5 },
      "post-commit-update-race-" + crypto.randomUUID(),
      { start: false },
    );
    const controller = new PieceController(pieces, piece);
    const firstPostCommitSync = defer<void>();
    const winnerPostCommitSync = defer<void>();
    const releaseFirst = defer<void>();
    const releaseWinner = defer<void>();
    const syncCounts = new Map<Module | Pattern, number>();
    runtime.runner.accessForTestingOnly.dependencySyncer = async (
      resultCell,
      pattern,
      inputs,
      sync,
    ) => {
      const synced = await sync(resultCell, pattern, inputs);
      const count = (syncCounts.get(pattern) ?? 0) + 1;
      syncCounts.set(pattern, count);
      if (count === 2 && pattern === firstPattern) {
        firstPostCommitSync.resolve();
        await releaseFirst.promise;
      } else if (count === 2 && pattern === winnerPattern) {
        winnerPostCommitSync.resolve();
        await releaseWinner.promise;
      }
      return synced;
    };
    const originalCompile = runtime.patternManager.compilePattern.bind(
      runtime.patternManager,
    );
    runtime.patternManager.compilePattern = (async (program, options) => {
      if (program === firstProgram) return firstPattern;
      if (program === winnerProgram) return winnerPattern;
      return await originalCompile(program, options);
    }) as typeof runtime.patternManager.compilePattern;

    try {
      const firstUpdate = controller.setPattern(firstProgram);
      await firstPostCommitSync.promise;
      const winnerUpdate = controller.setPattern(winnerProgram);
      await winnerPostCommitSync.promise;

      releaseWinner.resolve();
      const winnerReceipt = await winnerUpdate;
      releaseFirst.resolve();
      const firstReceipt = await firstUpdate;
      await runtime.idle();

      // Each receipt answers whether that caller's transaction committed; it
      // is not a later snapshot of the row. The winner assertion below is the
      // independent current-state check, just as it would be after two
      // successful database updates to the same row.
      expect(firstReceipt.ref).toEqual(
        runtime.patternManager.getArtifactEntryRef(firstPattern),
      );
      expect(winnerReceipt.ref).toEqual(
        runtime.patternManager.getArtifactEntryRef(winnerPattern),
      );
      // Each revision names its own caller's transaction too. This is the
      // field that would drift first if a receipt ever started reporting the
      // history's last entry rather than what the caller committed: both
      // revisions are in the history, and only their order distinguishes
      // them.
      const revisions = getPieceSourceRevisions(piece);
      const revisionIds = revisions.map((revision) => revision.revisionId);
      expect(firstReceipt.revisionId).not.toBe(winnerReceipt.revisionId);
      expect(revisionIds).toContain(firstReceipt.revisionId);
      expect(revisions.at(-1)?.revisionId).toBe(winnerReceipt.revisionId);
      expect(getPatternIdentityRef(piece)).toEqual(
        runtime.patternManager.getArtifactEntryRef(winnerPattern),
      );
      expect(
        controller.getCell().getAsNormalizedFullLink().schema,
      ).toEqual(winnerPattern.resultSchema);
      expect(await controller.result.get()).toEqual({ value: 5 });
      expect(
        validateSchemaValue(
          controller.getCell().getAsNormalizedFullLink().schema!,
          { value: "invalid-for-winner" },
        ),
      ).toMatch(/value does not match type number/);
      expect(await controller.result.get()).toEqual({ value: 5 });
    } finally {
      releaseFirst.resolve();
      releaseWinner.resolve();
      runtime.runner.accessForTestingOnly.dependencySyncer = undefined;
      runtime.patternManager.compilePattern = originalCompile;
    }
  });

  it("keeps the newer mutation's schema when an older one fails after it", async () => {
    const initialProgram = compiledResultNarrowingProgram(
      "string | number | boolean",
    );
    const firstProgram = compiledResultNarrowingProgram("string | number");
    const winnerProgram = compiledResultNarrowingProgram("number");
    const initialPattern = await runtime.patternManager.compilePattern(
      initialProgram,
      { space: pieces.getSpace() },
    );
    const firstPattern = await runtime.patternManager.compilePattern(
      firstProgram,
      { space: pieces.getSpace() },
    );
    const winnerPattern = await runtime.patternManager.compilePattern(
      winnerProgram,
      { space: pieces.getSpace() },
    );
    const piece = await pieces.runPersistent(
      initialPattern,
      { input: 5 },
      "controller-update-race-" + crypto.randomUUID(),
      { start: false },
    );
    const winnerRef = runtime.patternManager.getArtifactEntryRef(winnerPattern);
    if (!winnerRef) {
      throw new Error("missing compiled pattern ref");
    }
    const controller = new PieceController(pieces, piece);
    const firstRunEntered = defer<void>();
    const releaseFirstRun = defer<void>();
    // Only the losing update is intercepted: it is held until the winner has
    // finished, then fails, which is what an update superseded before it
    // commits does — the identity precondition inside the setup transaction
    // refuses it. The winner runs the real update path, so the pointer it
    // commits and the receipt it returns are the ones production would
    // produce rather than values this fixture invented.
    const originalRunPatternUpdate = pieces.runPatternUpdate.bind(pieces);
    pieces.runPatternUpdate = async (
      pattern,
      pieceId,
      inputs,
      options,
    ) => {
      if (pattern === firstPattern) {
        firstRunEntered.resolve();
        await releaseFirstRun.promise;
        throw new Error(
          "piece pattern changed while the source update was compiling",
        );
      }
      return await originalRunPatternUpdate(
        pattern,
        pieceId,
        inputs,
        options,
      );
    };
    const originalCompile = runtime.patternManager.compilePattern.bind(
      runtime.patternManager,
    );
    runtime.patternManager.compilePattern = (async (program, options) => {
      if (program === firstProgram) return firstPattern;
      if (program === winnerProgram) return winnerPattern;
      return await originalCompile(program, options);
    }) as typeof runtime.patternManager.compilePattern;

    try {
      const firstUpdate = expect(controller.setPattern(firstProgram)).rejects
        .toThrow(/pattern changed while the source update was compiling/);
      await firstRunEntered.promise;
      const winnerReceipt = await controller.setPattern(winnerProgram);
      releaseFirstRun.resolve();
      await firstUpdate;

      // The loser's failure is handled after the winner installed its schema,
      // and must leave that schema in place rather than reconciling back to
      // the version it was carrying.
      expect(controller.getCell().getAsNormalizedFullLink().schema).toEqual(
        winnerPattern.resultSchema,
      );
      expect(winnerReceipt.ref).toEqual(winnerRef);
      expect(getPatternIdentityRef(piece)).toEqual(winnerRef);
    } finally {
      releaseFirstRun.resolve();
      pieces.runPatternUpdate = originalRunPatternUpdate;
      runtime.patternManager.compilePattern = originalCompile;
    }
  });

  it("accepts a committed newer schema after its post-commit failure", async () => {
    const initialProgram = compiledResultNarrowingProgram(
      "string | number | boolean",
    );
    const firstProgram = compiledResultNarrowingProgram("string | number");
    const winnerProgram = compiledResultNarrowingProgram("number");
    const initialPattern = await runtime.patternManager.compilePattern(
      initialProgram,
      { space: pieces.getSpace() },
    );
    const firstPattern = await runtime.patternManager.compilePattern(
      firstProgram,
      { space: pieces.getSpace() },
    );
    const winnerPattern = await runtime.patternManager.compilePattern(
      winnerProgram,
      { space: pieces.getSpace() },
    );
    const piece = await pieces.runPersistent(
      initialPattern,
      { input: 5 },
      "controller-post-commit-failure-" + crypto.randomUUID(),
      { start: false },
    );
    const controller = new PieceController(pieces, piece);
    const firstRunReturned = defer<void>();
    const releaseFirstRun = defer<void>();
    const originalRunPatternUpdate = pieces.runPatternUpdate.bind(pieces);
    pieces.runPatternUpdate = async (
      pattern,
      pieceId,
      inputs,
      options,
    ) => {
      const result = await originalRunPatternUpdate(
        pattern,
        pieceId,
        inputs,
        options,
      );
      if (pattern === firstPattern) {
        firstRunReturned.resolve();
        await releaseFirstRun.promise;
      } else if (pattern === winnerPattern) {
        throw new PatternSetupPostCommitError(
          result.commit,
          new Error("injected post-commit failure"),
        );
      }
      return result;
    };
    const originalCompile = runtime.patternManager.compilePattern.bind(
      runtime.patternManager,
    );
    runtime.patternManager.compilePattern = (async (program, options) => {
      if (program === firstProgram) return firstPattern;
      if (program === winnerProgram) return winnerPattern;
      return await originalCompile(program, options);
    }) as typeof runtime.patternManager.compilePattern;

    try {
      const firstUpdate = controller.setPattern(firstProgram);
      await firstRunReturned.promise;
      // Resolves rather than rejects: the transition committed, so the
      // injected post-commit failure is not this call's failure. The receipt
      // names what that committed transition wrote, reports the refresh as
      // failed, and says what it detached — for a piece following no origin,
      // nothing.
      const winnerReceipt = await controller.setPattern(winnerProgram);
      expect(winnerReceipt.ref).toEqual(
        runtime.patternManager.getArtifactEntryRef(winnerPattern),
      );
      expect(winnerReceipt.refresh).toEqual({
        status: "failed",
        warning: "injected post-commit failure",
      });
      expect(winnerReceipt.detachedOrigin).toBeNull();
      expect(getPatternIdentityRef(piece)).toEqual(
        runtime.patternManager.getArtifactEntryRef(winnerPattern),
      );

      releaseFirstRun.resolve();
      const firstReceipt = await firstUpdate;
      expect(firstReceipt.ref).toEqual(
        runtime.patternManager.getArtifactEntryRef(firstPattern),
      );

      expect(controller.getCell().getAsNormalizedFullLink().schema).toEqual(
        winnerPattern.resultSchema,
      );
    } finally {
      releaseFirstRun.resolve();
      pieces.runPatternUpdate = originalRunPatternUpdate;
      runtime.patternManager.compilePattern = originalCompile;
    }
  });

  it("rechecks the durable identity after loading the winner's schema", async () => {
    const initialPattern = await runtime.patternManager.compilePattern(
      compiledResultNarrowingProgram("string | number | boolean"),
      { space: pieces.getSpace() },
    );
    const firstPattern = await runtime.patternManager.compilePattern(
      compiledResultNarrowingProgram("string"),
      { space: pieces.getSpace() },
    );
    const winnerPattern = await runtime.patternManager.compilePattern(
      compiledResultNarrowingProgram("number"),
      { space: pieces.getSpace() },
    );
    const firstRef = runtime.patternManager.getArtifactEntryRef(firstPattern);
    const winnerRef = runtime.patternManager.getArtifactEntryRef(winnerPattern);
    if (!firstRef || !winnerRef) {
      throw new Error("missing compiled pattern ref");
    }

    const piece = await pieces.runPersistent(
      initialPattern,
      { input: 5 },
      "schema-load-race-" + crypto.randomUUID(),
      { start: false },
    );
    const loadEntered = defer<void>();
    const releaseLoad = defer<void>();
    const originalLoad = runtime.patternManager.loadPatternByIdentity.bind(
      runtime.patternManager,
    );
    let heldFirstLoad = false;
    runtime.patternManager.loadPatternByIdentity = async (
      identity,
      symbol,
      space,
    ) => {
      const current = getPatternIdentityRef(piece);
      if (
        !heldFirstLoad && identity === firstRef.identity &&
        current?.identity === firstRef.identity &&
        current.symbol === firstRef.symbol
      ) {
        heldFirstLoad = true;
        loadEntered.resolve();
        await releaseLoad.promise;
      }
      return await originalLoad(identity, symbol, space);
    };

    try {
      const firstRun = runtime.runSynced(piece, firstPattern, { input: 5 });
      await loadEntered.promise;

      const winnerCell = await runtime.runSynced(
        piece,
        winnerPattern,
        { input: 5 },
      );
      expect(getPatternIdentityRef(piece)).toEqual(winnerRef);
      expect(winnerCell.getAsNormalizedFullLink().schema).toEqual(
        winnerPattern.resultSchema,
      );

      releaseLoad.resolve();
      const firstCell = await firstRun;
      expect(getPatternIdentityRef(piece)).toEqual(winnerRef);
      expect(firstCell.getAsNormalizedFullLink().schema).toEqual(
        winnerPattern.resultSchema,
      );
    } finally {
      releaseLoad.resolve();
      runtime.patternManager.loadPatternByIdentity = originalLoad;
    }
  });

  it("syncs dependencies after a remote pattern supersedes local setup", async () => {
    const firstPattern = await runtime.patternManager.compilePattern(
      compiledMultiplierProgram("local", 2),
      { space: pieces.getSpace() },
    );
    const remotePattern = await runtime.patternManager.compilePattern(
      compiledMultiplierProgram("remote", 10),
      { space: pieces.getSpace() },
    );
    const piece = await pieces.runPersistent(
      firstPattern,
      { input: 5 },
      "remote-preparation-supersession-" + crypto.randomUUID(),
      { start: false },
    );
    const id = entityRefToString(piece.entityId);
    const session = await createSession({
      identity: signer,
      spaceName: pieces.getSpaceName()!,
    });
    const remoteRuntime = new Runtime({
      apiUrl: new URL("http://localhost:9999"),
      storageManager,
    });
    const remotePieces = new PiecesController(session, remoteRuntime);

    try {
      await remotePieces.synced();
      await remotePieces.runWithPattern(
        remotePattern,
        id,
        { input: 5 },
        { start: false },
      );
      await remotePieces.synced();
      await pieces.synced();
      await piece.pull();
      expect(getPatternIdentityRef(piece)).toEqual(
        runtime.patternManager.getArtifactEntryRef(remotePattern),
      );

      let dependencySyncs = 0;
      runtime.runner.accessForTestingOnly.dependencySyncer = async (
        resultCell,
        pattern,
        inputs,
        sync,
      ) => {
        if (pattern === remotePattern) dependencySyncs++;
        return await sync(resultCell, pattern, inputs);
      };
      try {
        await runtime.start(piece);
      } finally {
        runtime.runner.accessForTestingOnly.dependencySyncer = undefined;
      }

      expect(dependencySyncs).toBeGreaterThan(0);
      expect(await piece.pull()).toEqual({
        version: "remote",
        output: 50,
      });
    } finally {
      await remoteRuntime.dispose();
    }
  });

  it("waits for setup to settle before setupPersistent syncs pattern metadata", async () => {
    const pattern = doublePattern();
    const patternRef = { identity: "test-pattern-identity", symbol: "default" };
    const originalSetup = pieces.runtime.setup.bind(pieces.runtime);
    const originalGetArtifactEntryRef = pieces.runtime.patternManager
      .getArtifactEntryRef.bind(pieces.runtime.patternManager);
    const originalSyncPatternByIdentity = pieces.syncPatternByIdentity.bind(
      pieces,
    );
    let setupResolved = false;
    let releaseSetup: (() => void) | undefined;
    const setupCalled = defer<void>();

    pieces.runtime.setup = ((...args) => {
      const piece = args[3];
      return new Promise<typeof piece>((resolve) => {
        releaseSetup = () => {
          setupResolved = true;
          resolve(piece);
        };
        setupCalled.resolve();
      });
    }) as typeof pieces.runtime.setup;

    const getRefStub: unknown = () => patternRef;
    pieces.runtime.patternManager.getArtifactEntryRef =
      getRefStub as typeof pieces.runtime.patternManager.getArtifactEntryRef;

    pieces.syncPatternByIdentity = ((
      ref: { identity: string; symbol: string },
    ) => {
      expect(ref).toEqual(patternRef);
      expect(setupResolved).toBe(true);
      return Promise.resolve(pattern);
    }) as typeof pieces.syncPatternByIdentity;

    try {
      const pending = pieces.setupPersistent(pattern, { input: 5 });
      await setupCalled.promise;
      expect(setupResolved).toBe(false);
      if (!releaseSetup) {
        throw new Error("Expected runtime.setup to be called");
      }
      releaseSetup();
      await pending;
    } finally {
      pieces.runtime.setup = originalSetup;
      pieces.runtime.patternManager.getArtifactEntryRef =
        originalGetArtifactEntryRef;
      pieces.syncPatternByIdentity = originalSyncPatternByIdentity;
    }
  });

  it("restarts stopped pieces when runWithPattern is called with start", async () => {
    const piece = await pieces.runPersistent(
      trustPattern(runtime, doublePattern()),
      { input: 5 },
      undefined,
      { start: true },
    );

    expect(runtime.runner.cancels.size).toBe(1);

    await pieces.stopPiece(piece);

    expect(runtime.runner.cancels.size).toBe(0);

    await pieces.runWithPattern(
      trustPattern(runtime, tenfoldPattern()),
      entityRefToString(piece.entityId),
      { input: 5 },
      { start: true },
    );

    expect(runtime.runner.cancels.size).toBe(1);
    expect(pieces.getResult(piece).get()).toEqual({ output: 50 });
  });

  it("updates piece names when runWithPattern changes patterns", async () => {
    const piece = await pieces.runPersistent(
      trustPattern(runtime, namedPattern("double", 2)),
      { input: 5 },
      undefined,
      { start: true },
    );
    const controller = new PieceController(pieces, piece);

    expect(controller.name()).toBe("double");
    expect(pieces.getResult(piece).get()).toEqual({
      [NAME]: "double",
      output: 10,
    });

    await pieces.runWithPattern(
      trustPattern(runtime, namedPattern("tenfold", 10)),
      entityRefToString(piece.entityId),
      { input: 5 },
      { start: true },
    );

    expect(controller.name()).toBe("tenfold");
    expect(pieces.getResult(piece).get()).toEqual({
      [NAME]: "tenfold",
      output: 50,
    });
  });

  it("reads a piece addressed through a value-link wrapper (headless sub-piece slot)", async () => {
    // The canonical piece K — setup writes patternIdentity + the argument link.
    const k = await pieces.runPersistent(
      trustPattern(runtime, doublePattern()),
      { input: 5 },
      undefined,
      { start: true },
    );
    expect(pieces.getResult(k).get()).toEqual({ output: 10 });

    // A value-link "slot" cell R that redirects to K — the exact shape a piece
    // pushed into a list/object gets addressed by (the array/object element,
    // written as the child result cell's getAsLink()). Reproduces the topics
    // board's `addTopic`, whose array element is a plain value-link to the topic
    // piece; the slot itself carries no piece metadata.
    const r = runtime.getCell(
      pieces.getSpace(),
      "wrapper-slot-" + crypto.randomUUID(),
    );
    await runtime.editWithRetry((tx) => {
      r.withTx(tx).set(k.getAsLink());
    });
    await pieces.synced();

    // Reading the argument directly off the slot fails exactly as
    // `cf piece inspect <slot-fid>` did before this fix:
    expect(() => pieces.getArgument(r)).toThrow("piece missing argument cell");

    // Addressing the slot by its fid (the path `cf piece inspect`/`get` take)
    // canonicalizes R -> its result cell K (a VALUE link) in pieces.get, so
    // input/result reads land on the real piece, not the un-materialized wrapper.
    const piece = await pieces.get(entityRefToString(r.entityId), false);
    expect(await piece.result.get(["output"])).toBe(10);
    expect(await piece.input.get(["input"])).toBe(5);
  });
});

describe("piece cold-replica slot read (two replicas, one server)", () => {
  let server: MemoryV2Server.Server;
  let writerStorage: EmulatedStorageManager;
  let writerRuntime: Runtime;
  let writerPieces: PiecesController;
  let spaceName: string;

  beforeEach(async () => {
    server = newSharedServer();
    writerStorage = EmulatedStorageManager.connectTo(server, {
      as: signer,
    });
    writerRuntime = new Runtime({
      apiUrl: new URL("http://localhost:9999"),
      storageManager: writerStorage,
    });
    spaceName = "cold-slot-" + crypto.randomUUID();
    const session = await createSession({ identity: signer, spaceName });
    writerPieces = new PiecesController(session, writerRuntime);
    await writerPieces.synced();
  });

  afterEach(async () => {
    await writerRuntime?.dispose();
    await writerStorage?.close();
    await server?.close();
  });

  it("a fresh replica reads a piece addressed through a value-link slot (cold fetch)", async () => {
    // Writer replica: create the canonical piece K (setup writes patternIdentity
    // + the argument link), then a value-link slot R -> K — the exact shape the
    // topics board's addTopic produces — and sync both to the shared server.
    const k = await writerPieces.runPersistent(
      trustPattern(writerRuntime, doublePattern()),
      { input: 5 },
      undefined,
      { start: true },
    );
    const r = writerRuntime.getCell(
      writerPieces.getSpace(),
      "wrapper-slot-" + crypto.randomUUID(),
    );
    await writerRuntime.editWithRetry((tx) => {
      r.withTx(tx).set(k.getAsLink());
    });
    await writerPieces.synced();
    const slotId = entityRefToString(r.entityId);

    // Fresh reader replica: a NEW storage manager on the SAME server, so it
    // never pulled K. Reading the slot by its fid must canonicalize R -> K (a
    // VALUE link) AND cold-fetch K's docs from the server — the end-to-end
    // behavior the local-toolshed run confirmed, now repeatable in-process.
    const readerStorage = EmulatedStorageManager.connectTo(server, {
      as: signer,
    });
    const readerRuntime = new Runtime({
      apiUrl: new URL("http://localhost:9999"),
      storageManager: readerStorage,
    });
    const readerSession = await createSession({ identity: signer, spaceName });
    const readerPieces = new PiecesController(readerSession, readerRuntime);
    try {
      await readerPieces.synced();
      const piece = await readerPieces.get(slotId, false);

      // Both reads canonicalize the slot R -> its result cell K (a value link)
      // and cold-fetch K from the shared server. The argument read is the path
      // that threw "piece missing argument cell" pre-fix, so exercise it first.
      expect(await piece.input.get(["input"])).toBe(5);
      expect(await piece.result.get(["output"])).toBe(10);
    } finally {
      await readerRuntime.dispose();
      await readerStorage.close();
    }
  });

  it("a fresh replica's pattern reference loads the piece document alone", async () => {
    // The piece's result reaches a second document through its argument. A
    // meta read registers a load under the reading cell's schema, and the
    // cell `getPieceCell` hands out carries the result schema, so a
    // reference read through it would load that second document too — on a
    // board, every row of its index. The reader replica asks for the
    // reference and nothing else, and the second document must stay cold.
    const items = writerRuntime.getCell<number[]>(
      writerPieces.getSpace(),
      "items-" + crypto.randomUUID(),
      { type: "array", items: { type: "number" } },
    );
    await writerRuntime.editWithRetry((tx) => {
      items.withTx(tx).set([1, 2, 3]);
    });
    const piece = await writerPieces.runPersistent(
      trustPattern(writerRuntime, {
        argumentSchema: {
          type: "object",
          properties: { items: { type: "array", items: { type: "number" } } },
        },
        resultSchema: {
          type: "object",
          properties: { items: { type: "array", items: { type: "number" } } },
        },
        result: { items: { $alias: { cell: "argument", path: ["items"] } } },
        nodes: [],
      }),
      { items },
      undefined,
      { start: true },
    );
    await writerPieces.synced();
    const pieceId = entityRefToString(piece.entityId);
    const itemsUri = items.getAsNormalizedFullLink().id;

    const readerStorage = EmulatedStorageManager.connectTo(server, {
      as: signer,
    });
    const readerRuntime = new Runtime({
      apiUrl: new URL("http://localhost:9999"),
      storageManager: readerStorage,
    });
    const readerSession = await createSession({ identity: signer, spaceName });
    const readerPieces = new PiecesController(readerSession, readerRuntime);
    try {
      await readerPieces.synced();
      const cell = await readerPieces.getPieceCell(pieceId, {
        reconcile: true,
        start: false,
      });
      const reader = new PieceController(readerPieces, cell);
      const ref = await reader.getPatternRef();
      // Every load the reads registered has been issued and answered, so a
      // document still absent here was never asked for.
      await readerPieces.synced();

      expect(ref?.identity).toBe(
        getPatternIdentityRef(piece)?.identity,
      );
      // The replica's own record of what it holds: absent means never
      // loaded, where any read through a cell would register the load this
      // test is about.
      const provider = readerStorage.open(readerPieces.getSpace()) as {
        get?: (uri: string) => unknown;
      };
      expect(provider.get?.(itemsUri)).toBeUndefined();
    } finally {
      await readerRuntime.dispose();
      await readerStorage.close();
    }
  });

  it("a fresh replica preserves visible nested input beside a scoped link", async () => {
    const sectionSchema = {
      type: "object",
      properties: {
        label: { type: "string" },
        inner: {
          type: "object",
          properties: {
            plain: { type: "string" },
            scoped: { type: "string" },
          },
          required: ["plain", "scoped"],
        },
      },
      required: ["label"],
    } as const satisfies JSONSchema;
    const tx = writerRuntime.edit();
    const scoped = writerRuntime.getCell<string>(
      writerPieces.getSpace(),
      "nested-scoped-" + crypto.randomUUID(),
      { type: "string" },
      tx,
      "session",
    );
    scoped.set("writer-only");
    const commit = await tx.commit();
    expect(commit.error).toBeUndefined();

    const piece = await writerPieces.runPersistent(
      trustPattern(writerRuntime, {
        argumentSchema: {
          type: "object",
          properties: { section: sectionSchema },
          required: ["section"],
        },
        resultSchema: { type: "object", properties: {} },
        result: {},
        nodes: [],
      }),
      {
        section: {
          label: "hello",
          inner: { plain: "visible", scoped },
        },
      },
      undefined,
      { start: true },
    );
    await writerPieces.synced();

    const readerStorage = EmulatedStorageManager.connectTo(server, {
      as: signer,
    });
    const readerRuntime = new Runtime({
      apiUrl: new URL("http://localhost:9999"),
      storageManager: readerStorage,
    });
    const readerSession = await createSession({ identity: signer, spaceName });
    const readerPieces = new PiecesController(readerSession, readerRuntime);
    try {
      await readerPieces.synced();
      const readerPiece = await readerPieces.get(
        entityRefToString(piece.entityId),
        false,
      );

      expect(await readerPiece.input.get(["section"])).toEqual({
        label: "hello",
        inner: { plain: "visible" },
      });
    } finally {
      await readerRuntime.dispose();
      await readerStorage.close();
    }
  });

  it("keeps a capped asCell handle capped through the narrow read", async () => {
    // The narrow read reaches a path below an asCell slot with a plain `key()`
    // chain, letting link resolution follow the handle mid-path rather than
    // dereferencing it by hand. This pins the two properties that choice has to
    // keep: the terminal handle still applies the scoped-link relaxation (so a
    // scoped child voids only itself, not its whole object), and a path THROUGH
    // the handle still lands on the right document. #5231 moved the asCell
    // scope cap into the runner's own projection, which let the narrow read
    // drop its resolveAsCell() routing. That routing was the only thing keeping
    // a capped handle capped here, so pin the behavior at this layer rather
    // than trusting the runner test to stand in for it.

    const tx = writerRuntime.edit();
    const target = writerRuntime.getCell(
      writerPieces.getSpace(),
      "capped-target-" + crypto.randomUUID(),
      { type: "object", properties: { field: { type: "string" } } },
      tx,
      "session",
    );
    target.set({ field: "secret" });
    const commit = await tx.commit();
    expect(commit.error).toBeUndefined();

    const piece = await writerPieces.runPersistent(
      trustPattern(writerRuntime, {
        argumentSchema: {
          type: "object",
          properties: {
            // The handle may only follow links at space scope; the stored
            // link is session-scoped, so it must not resolve.
            handle: {
              type: "object",
              properties: { field: { type: "string" } },
              required: ["field"],
              asCell: [{ kind: "cell", scope: "space" }],
            },
            plain: { type: "string" },
          },
          required: ["handle", "plain"],
        },
        resultSchema: { type: "object", properties: {} },
        result: {},
        nodes: [],
      }),
      { handle: target, plain: "visible" },
      undefined,
      { start: true },
    );
    await writerPieces.synced();
    const controller = new PieceController(writerPieces, piece);

    expect(await controller.input.get(["handle"])).toBeUndefined();
    // An uncapped sibling on the same input still reads, so the block above
    // is the cap and not a broken fixture.
    expect(await controller.input.get(["plain"])).toBe("visible");
  });

  it("relaxes a scoped link below an asCell handle, at and through it", async () => {
    const sectionSchema = {
      type: "object",
      properties: {
        label: { type: "string" },
        inner: {
          type: "object",
          properties: {
            plain: { type: "string" },
            scoped: { type: "string" },
          },
          required: ["plain", "scoped"],
        },
      },
      required: ["label"],
    } as const satisfies JSONSchema;
    const tx = writerRuntime.edit();
    const scoped = writerRuntime.getCell<string>(
      writerPieces.getSpace(),
      "handle-scoped-" + crypto.randomUUID(),
      { type: "string" },
      tx,
      "session",
    );
    scoped.set("writer-only");
    const section = writerRuntime.getCell(
      writerPieces.getSpace(),
      "handle-section-" + crypto.randomUUID(),
      sectionSchema,
      tx,
    );
    section.set({
      label: "hello",
      inner: { plain: "visible", scoped },
    } as never);
    const commit = await tx.commit();
    expect(commit.error).toBeUndefined();

    const piece = await writerPieces.runPersistent(
      trustPattern(writerRuntime, {
        argumentSchema: {
          type: "object",
          properties: { handle: { ...sectionSchema, asCell: ["cell"] } },
          required: ["handle"],
        },
        resultSchema: { type: "object", properties: {} },
        result: {},
        nodes: [],
      }),
      { handle: section },
      undefined,
      { start: true },
    );
    await writerPieces.synced();

    const readerStorage = EmulatedStorageManager.connectTo(server, {
      as: signer,
    });
    const readerRuntime = new Runtime({
      apiUrl: new URL("http://localhost:9999"),
      storageManager: readerStorage,
    });
    const readerSession = await createSession({ identity: signer, spaceName });
    const readerPieces = new PiecesController(readerSession, readerRuntime);
    try {
      await readerPieces.synced();
      const readerPiece = await readerPieces.get(
        entityRefToString(piece.entityId),
        false,
      );

      // Terminal asCell: the handle is unwrapped and read through the same
      // relaxation the root read uses, so `inner` survives without `scoped`.
      expect(await readerPiece.input.get(["handle"])).toEqual({
        label: "hello",
        inner: { plain: "visible" },
      });
      // Through the asCell: link resolution follows the handle mid-path.
      expect(await readerPiece.input.get(["handle", "label"])).toBe("hello");
      expect(await readerPiece.input.get(["handle", "inner", "plain"]))
        .toBe("visible");
    } finally {
      await readerRuntime.dispose();
      await readerStorage.close();
    }
  });
});
