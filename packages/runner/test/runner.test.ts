import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import "@commonfabric/utils/equal-ignoring-symbols";

import { Identity } from "@commonfabric/identity";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import type { Server as MemoryV2Server } from "@commonfabric/memory/v2/server";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import {
  type JSONSchema,
  type Module,
  NAME,
  type Pattern,
} from "../src/builder/types.ts";
import type { Cell } from "../src/cell.ts";
import { Runtime } from "../src/runtime.ts";
import { entityKey } from "../src/scheduler/keys.ts";
import { validateSchemaValue } from "../src/cfc/mod.ts";
import { resolvedSchema } from "./schema-ref-helpers.ts";
import { testSessionOpenAuthFactory } from "./memory-v2-test-utils.ts";
import { ExtendedStorageTransaction } from "../src/storage/extended-storage-transaction.ts";
import { resultSchemaMetaSpelling } from "../src/result-schema-meta.ts";
import {
  areNormalizedLinksSame,
  getDerivedInternalCell,
  getMetaLink,
  isWriteRedirectLink,
  parseLink,
} from "../src/link-utils.ts";
import {
  extractDefaultValues,
  getPatternIdentityRef,
  getPatternSetupIdentityRef,
  getPieceSourceSnapshot,
  mergeObjects,
  mergeSchemaDefaults,
  PatternSetupPostCommitError,
  type PieceSourceTransition,
  preparePieceSourceTransitionBaseline,
  schemaAcceptsOpaqueCellValue,
  schemaHasDefaultValue,
  SEALING_RECEIPT_REFUSAL,
  SEALING_SOURCE_UPDATE_REFUSAL,
} from "../src/runner.ts";
import {
  type ICommitNotification,
  type IExtendedStorageTransaction,
  type MediaType,
  type URI,
} from "../src/storage/interface.ts";
import { trustExecutable } from "./support/trusted-builder.ts";
import { rawMetaWriteAuthorization } from "../src/meta-seam.ts";
import type { RuntimeTelemetryEvent } from "../src/telemetry.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

function runTrusted(
  runtime: Runtime,
  tx: IExtendedStorageTransaction | undefined,
  executable: Pattern | Module,
  argument: unknown,
  resultCell: unknown,
) {
  return runtime.run(
    tx,
    trustExecutable(runtime, executable),
    argument as never,
    resultCell as never,
  );
}

function setupTrusted(
  runtime: Runtime,
  tx: IExtendedStorageTransaction | undefined,
  executable: Pattern | Module | undefined,
  argument: unknown,
  resultCell: unknown,
) {
  return runtime.setup(
    tx,
    trustExecutable(runtime, executable),
    argument as never,
    resultCell as never,
  );
}

/**
 * A second session on the fixture's loopback server: it reads the space as
 * storage holds it, not as this runtime's replica does.
 */
async function openRemoteSession(
  storageManager: ReturnType<typeof StorageManager.emulate>,
): Promise<
  { client: MemoryV2Client.Client; session: MemoryV2Client.SpaceSession }
> {
  const candidate = storageManager as unknown as {
    server?: () => MemoryV2Server;
  };
  if (typeof candidate.server !== "function") {
    throw new Error("the receipt fixture needs an emulated storage manager");
  }
  const client = await MemoryV2Client.connect({
    transport: MemoryV2Client.loopback(candidate.server()),
  });
  const session = await client.mount(space, {}, testSessionOpenAuthFactory);
  return { client, session };
}

async function compileReceiptPattern(
  runtime: Runtime,
  marker: string,
): Promise<Pattern> {
  return await runtime.patternManager.compilePattern({
    main: "/main.tsx",
    files: [{
      name: "/main.tsx",
      contents: [
        "import { pattern } from 'commonfabric';",
        "interface Args { label?: string }",
        "export default pattern<Args, { marker: string }>(() => ({",
        `  marker: ${JSON.stringify(marker)},`,
        "}));",
      ].join("\n"),
    }],
  }, { space });
}

/** Returns the receipt fixture's durable or session-side source state. */
function receiptSourceSnapshot(
  runtime: Runtime,
  resultCell: Cell<unknown>,
) {
  const snapshot = getPieceSourceSnapshot(
    resultCell,
    runtime.runner.sessionPatternPointerFor(resultCell),
  );
  if (snapshot === undefined) {
    throw new Error("the receipt fixture has no source snapshot");
  }
  return snapshot;
}

async function receiptSourceTransition(
  runtime: Runtime,
  resultCell: Cell<unknown>,
): Promise<PieceSourceTransition> {
  const expected = receiptSourceSnapshot(runtime, resultCell);
  return {
    revisionId: crypto.randomUUID(),
    baseline: await preparePieceSourceTransitionBaseline(
      runtime,
      resultCell,
      expected,
    ),
    timestamp: Date.now(),
    operation: "edit",
    origin: null,
    expected,
  };
}

/** Transition for tests which must refuse before source setup is reached. */
function unreachableReceiptSourceTransition(): PieceSourceTransition {
  return {
    revisionId: crypto.randomUUID(),
    baseline: { kind: "unavailable" },
    timestamp: Date.now(),
    operation: "edit",
    origin: null,
    expected: {
      pattern: { identity: "of:fid1:unreachable", symbol: "default" },
      origin: null,
      revisionId: null,
    },
  };
}

describe("runPattern", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    // Create runtime with the shared storage provider
    // We need to bypass the URL-based configuration for this test
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime?.storageManager.synced();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("should work with passthrough", async () => {
    const pattern = {
      argumentSchema: {
        type: "object",
        properties: {
          input: { type: "number" },
          output: { type: "number" },
        },
        description: "passthrough",
      },
      resultSchema: {},
      result: { output: { $alias: { partialCause: "output", path: [] } } },
      nodes: [
        {
          module: {
            type: "passthrough",
          },
          inputs: { value: { $alias: { cell: "argument", path: ["input"] } } },
          outputs: {
            value: { $alias: { partialCause: "output", path: [] } },
          },
        },
      ],
    } as Pattern;

    const resultCell = runtime.getCell(
      space,
      "should work with passthrough",
    );
    const result = runTrusted(
      runtime,
      undefined,
      pattern,
      { input: 1 },
      resultCell,
    );

    await resultCell.pull();
    const argumentCellValue = resultCell.getArgumentCell()?.get();
    expect(argumentCellValue).toEqual({ input: 1 });
    const outputCell = getDerivedInternalCell(resultCell, {
      partialCause: "output",
    });
    const outputLink = outputCell.getAsNormalizedFullLink();
    // getDerivedInternalCell doesn't generate a redirect link,
    // but that's what we want to match, so add that property.
    expect(
      areNormalizedLinksSame(
        parseLink((result.getRaw() as { output: unknown }).output, result)!,
        { ...outputLink, overwrite: "redirect" },
      ),
    ).toBe(true);
    const resultValue = await result.pull();
    expect(resultValue).toEqual({ output: 1 });
  });

  it("writes internal aliases through derived internal cell manifest links", async () => {
    const pattern = {
      argumentSchema: {
        type: "object",
        properties: {
          input: { type: "number" },
        },
      },
      resultSchema: {},
      derivedInternalCells: [{
        partialCause: "output",
        schema: { type: "number", default: 0 },
        scope: "space",
      }],
      result: { output: { $alias: { partialCause: "output", path: [] } } },
      nodes: [
        {
          module: {
            type: "passthrough",
          },
          inputs: { value: { $alias: { cell: "argument", path: ["input"] } } },
          outputs: {
            value: { $alias: { partialCause: "output", path: [] } },
          },
        },
      ],
    } as Pattern;

    const resultCell = runtime.getCell(
      space,
      "derived internal passthrough",
    );
    const result = runTrusted(
      runtime,
      undefined,
      pattern,
      { input: 5 },
      resultCell,
    );

    await resultCell.pull();
    const internalManifest = resultCell.getMetaRaw("internal");
    expect(internalManifest).toBeDefined();
    const rawLink = Array.isArray(internalManifest)
      ? internalManifest.find((entry) => entry?.partialCause === "output").link
      : undefined;
    expect(isWriteRedirectLink(rawLink)).toBe(true);

    const derivedLink = parseLink(rawLink, resultCell);
    expect(derivedLink).toBeDefined();
    expect(derivedLink!.id).not.toBe(resultCell.getAsNormalizedFullLink().id);
    expect(derivedLink!.path).toEqual([]);
    expect(resolvedSchema(derivedLink!.schema)).toEqual({
      type: "number",
      default: 0,
    });

    const derivedCell = runtime.getCellFromLink(derivedLink!);
    expect(await derivedCell.get()).toBe(5);
    expect(await result.pull()).toEqual({ output: 5 });
  });

  it("refreshes derived internal manifest schemas during setup updates", async () => {
    const resultCell = runtime.getCell(
      space,
      "refresh derived internal manifest schema",
    );
    const pattern = (valueSchema: JSONSchema): Pattern => ({
      argumentSchema: { type: "object", properties: {} },
      resultSchema: {
        type: "object",
        properties: { value: valueSchema },
        required: ["value"],
      },
      derivedInternalCells: [{
        partialCause: "value",
        schema: valueSchema,
      }],
      result: {
        value: { $alias: { partialCause: "value", path: [] } },
      },
      nodes: [],
    });
    const wide = {
      type: ["number", "string"],
      default: 1,
    } as const;
    const narrow = { type: "number", default: 1 } as const;

    await setupTrusted(runtime, undefined, pattern(wide), {}, resultCell);
    const firstManifest = resultCell.getMetaRaw("internal");
    const firstLink = Array.isArray(firstManifest)
      ? parseLink(firstManifest[0].link, resultCell)
      : undefined;
    expect(resolvedSchema(firstLink?.schema)).toEqual(wide);

    await setupTrusted(runtime, undefined, pattern(narrow), {}, resultCell);
    const nextManifest = resultCell.getMetaRaw("internal");
    const nextLink = Array.isArray(nextManifest)
      ? parseLink(nextManifest[0].link, resultCell)
      : undefined;
    expect(nextLink?.id).toBe(firstLink?.id);
    expect(resolvedSchema(nextLink?.schema)).toEqual(narrow);
  });

  it("sets scoped write-redirect metadata links for argument and internal cells", async () => {
    const argumentSchema = {
      type: "object",
      properties: {
        input: { type: "number" },
      },
      required: ["input"],
    } as const;
    const resultSchema = {
      type: "object",
      scope: "user",
      properties: {
        output: { type: "number" },
      },
      required: ["output"],
    } as const;
    const pattern = {
      argumentSchema,
      resultSchema,
      derivedInternalCells: [
        {
          partialCause: "output",
          schema: { type: "number" },
        },
      ],
      result: { output: { $alias: { partialCause: "output", path: [] } } },
      nodes: [
        {
          module: {
            type: "passthrough",
          },
          inputs: { value: { $alias: { cell: "argument", path: ["input"] } } },
          outputs: {
            value: { $alias: { partialCause: "output", path: [] } },
          },
        },
      ],
    } as Pattern;

    const resultCell = runtime.getCell(
      space,
      "sets scoped write-redirect metadata links",
      resultSchema,
      undefined,
      "user",
    );
    const result = runTrusted(
      runtime,
      undefined,
      pattern,
      { input: 7 },
      resultCell,
    );

    await resultCell.pull();

    const resultCellLink = resultCell.getAsNormalizedFullLink();
    const argumentLink = getMetaLink(resultCell, "argument");

    expect(resultCellLink.scope).toBe("user");
    expect(resultCell.getMetaRaw("schema")).toEqual(
      resultSchemaMetaSpelling(resultSchema),
    );
    expect(argumentLink).toBeDefined();
    expect(argumentLink!.path).toEqual([]);
    expect(argumentLink!.space).toBe(space);
    expect(argumentLink!.scope).toBe("user");
    expect(resolvedSchema(argumentLink!.schema)).toEqual(argumentSchema);
    expect(argumentLink!.overwrite).toBe("redirect");

    const argumentCell = runtime.getCellFromLink(argumentLink!);
    expect(argumentCell.get()).toEqual({ input: 7 });
    const outputCell = getDerivedInternalCell(resultCell, {
      partialCause: "output",
      schema: pattern.derivedInternalCells![0].schema,
    });
    const outputLink = outputCell.getAsNormalizedFullLink();
    expect(outputLink.path).toEqual([]);
    expect(outputLink.space).toBe(space);
    expect(outputLink.scope).toBe("user");
    expect(resolvedSchema(outputLink.schema)).toEqual({ type: "number" });
    const resultMetaLink = getMetaLink(argumentCell, "result")!;
    expect({
      ...resultMetaLink,
      schema: resolvedSchema(resultMetaLink.schema),
    }).toEqual({
      ...resultCellLink,
      schema: resultSchema,
      overwrite: "redirect",
      // getMetaLink parses the stored sigil, which carries the read-side
      // data-derived mark (OW51 `viaLinkHop`); resultCellLink came off a
      // Cell and does not, so add it to the expected shape.
      viaLinkHop: true,
    });
    // getDerivedInternalCell doesn't generate a redirect link,
    // but that's what we want to match, so add that property.
    expect(
      areNormalizedLinksSame(
        parseLink((result.getRaw() as { output: unknown }).output, result)!,
        { ...outputLink, overwrite: "redirect" },
      ),
    ).toBe(true);
  });

  it("should work with nested patterns", async () => {
    const innerPattern = {
      argumentSchema: {
        type: "object",
        properties: {
          input: { type: "number" },
          output: { type: "number" },
        },
      },
      resultSchema: {},
      result: { $alias: { partialCause: "output", path: [], defer: 1 } },
      nodes: [
        {
          module: {
            type: "passthrough",
          },
          inputs: {
            value: {
              $alias: { cell: "argument", path: ["input"], defer: 1 },
            },
          },
          outputs: {
            value: {
              $alias: { partialCause: "output", path: [], defer: 1 },
            },
          },
        },
      ],
    } as Pattern;

    const outerPattern = {
      argumentSchema: {
        type: "object",
        properties: {
          value: { type: "number" },
          result: { type: "number" },
        },
      },
      resultSchema: {},
      result: { result: { $alias: { partialCause: "output", path: [] } } },
      nodes: [
        {
          module: { type: "pattern", implementation: innerPattern },
          inputs: { input: { $alias: { cell: "argument", path: ["value"] } } },
          outputs: { $alias: { partialCause: "output", path: [] } },
        },
      ],
    } as Pattern;

    const resultCell = runtime.getCell(
      space,
      "should work with nested patterns",
    );
    const result = runTrusted(
      runtime,
      undefined,
      outerPattern,
      { value: 5 },
      resultCell,
    );

    const resultValue = await result.pull();
    expect(resultValue).toEqual({ result: 5 });
  });

  it("should run a simple module", async () => {
    const mockPattern: Pattern = {
      argumentSchema: {},
      resultSchema: {},
      result: { result: { $alias: { partialCause: "result", path: [] } } },
      nodes: [
        {
          module: {
            type: "javascript",
            implementation: (value: number) => value * 2,
          },
          inputs: { $alias: { cell: "argument", path: ["value"] } },
          outputs: { $alias: { partialCause: "result", path: [] } },
        },
      ],
    };

    const tx = runtime.edit();
    const resultCell = runtime.getCell(
      space,
      "should run a simple module",
      undefined,
      tx,
    );
    const result = runTrusted(
      runtime,
      tx,
      mockPattern,
      { value: 1 },
      resultCell,
    );
    tx.commit();

    const resultValue = await result.pull();
    expect(JSON.stringify(resultValue)).toEqual(
      JSON.stringify({ result: 2 }),
    );
  });

  it("registers a dormant module without reading linked input data", async () => {
    let runs = 0;
    const pattern: Pattern = {
      argumentSchema: {
        type: "object",
        properties: { input: { type: "number" } },
      },
      resultSchema: {},
      result: { output: { $alias: { partialCause: "output", path: [] } } },
      nodes: [
        {
          module: {
            type: "javascript",
            implementation: (input: number) => {
              runs++;
              return input * 2;
            },
          },
          inputs: { $alias: { cell: "argument", path: ["input"] } },
          outputs: { $alias: { partialCause: "output", path: [] } },
        },
      ],
    };

    const setupTx = runtime.edit();
    const source = runtime.getCell<{ value: number }>(
      space,
      "dormant registration source",
      {
        type: "object",
        properties: { value: { type: "number" } },
      },
      setupTx,
    );
    source.set({ value: 21 });
    const sourceLink = source.getAsNormalizedFullLink();
    const resultCell = runtime.getCell(
      space,
      "dormant registration result",
      undefined,
      setupTx,
    );

    runTrusted(
      runtime,
      setupTx,
      pattern,
      { input: source.key("value").getAsWriteRedirectLink() },
      resultCell,
    );
    await setupTx.commit();

    let sourceDataReads = 0;
    const countSourceRead = (
      address: { space?: unknown; id?: unknown },
    ): void => {
      if (address.space === sourceLink.space && address.id === sourceLink.id) {
        sourceDataReads++;
      }
    };
    const originalEdit = runtime.edit.bind(runtime) as Runtime["edit"];
    runtime.edit = ((...args: Parameters<Runtime["edit"]>) => {
      const actionTx = originalEdit(...args);
      const originalRead = actionTx.read.bind(actionTx);
      actionTx.read = ((address, options) => {
        countSourceRead(address);
        return originalRead(address, options);
      }) as typeof actionTx.read;
      const originalReadOrThrow = actionTx.readOrThrow.bind(actionTx);
      actionTx.readOrThrow = ((address, options) => {
        countSourceRead(address);
        return originalReadOrThrow(address, options);
      }) as typeof actionTx.readOrThrow;
      return actionTx;
    }) as Runtime["edit"];

    try {
      await runtime.idle();
    } finally {
      runtime.edit = originalEdit;
    }

    expect(runs).toBe(0);
    expect(sourceDataReads).toBe(0);
  });

  it("should run a simple module with no outputs", async () => {
    let ran = false;

    const mockPattern: Pattern = {
      argumentSchema: {},
      resultSchema: {},
      result: { result: { $alias: { partialCause: "result", path: [] } } },
      nodes: [
        {
          module: {
            type: "javascript",
            implementation: () => {
              ran = true;
            },
          },
          inputs: { $alias: { cell: "argument", path: ["value"] } },
          outputs: {},
        },
      ],
    };

    const resultCell = runtime.getCell(
      space,
      "should run a simple module with no outputs",
    );
    const result = await runtime.runSynced(
      resultCell,
      trustExecutable(runtime, mockPattern),
      {
        value: 1,
      },
    );
    const resultValue = await result.pull();
    expect(resultValue).toEqual({ result: undefined });
    expect(ran).toBe(true);
  });

  it("should handle incorrect inputs gracefully", async () => {
    let ran = false;

    const mockPattern: Pattern = {
      argumentSchema: {},
      resultSchema: {},
      result: { result: { $alias: { partialCause: "result", path: [] } } },
      nodes: [
        {
          module: {
            type: "javascript",
            implementation: () => {
              ran = true;
            },
          },
          inputs: { $alias: { cell: "argument", path: ["other"] } },
          outputs: {},
        },
      ],
    };

    const resultCell = runtime.getCell(
      space,
      "should handle incorrect inputs gracefully",
    );
    const result = await runtime.runSynced(
      resultCell,
      trustExecutable(runtime, mockPattern),
      {
        value: 1,
      },
    );
    const resultValue2 = await result.pull();
    expect(resultValue2).toEqual({ result: undefined });
    // We don't run the action if the arguments fail to validate
    expect(ran).toBe(false);
  });

  it("should handle nested patterns", async () => {
    const nestedPattern: Pattern = {
      argumentSchema: {},
      resultSchema: {},
      result: { $alias: { partialCause: "result", path: [], defer: 1 } },
      nodes: [
        {
          module: {
            type: "javascript",
            implementation: (value: number) => value * 2,
          },
          inputs: {
            $alias: { cell: "argument", path: ["input"], defer: 1 },
          },
          outputs: {
            $alias: { partialCause: "result", path: [], defer: 1 },
          },
        },
      ],
    };

    const mockPattern: Pattern = {
      argumentSchema: {},
      resultSchema: {},
      result: { result: { $alias: { partialCause: "result", path: [] } } },
      nodes: [
        {
          module: { type: "pattern", implementation: nestedPattern },
          inputs: { input: { $alias: { cell: "argument", path: ["value"] } } },
          outputs: { $alias: { partialCause: "result", path: [] } },
        },
      ],
    };

    const resultCell = runtime.getCell(
      space,
      "should handle nested patterns",
    );
    const result = runTrusted(
      runtime,
      undefined,
      mockPattern,
      { value: 1 },
      resultCell,
    );
    const resultValue = await result.pull();
    expect(resultValue).toEqual({ result: 2 });
  });

  it("should allow passing a cell as a binding", async () => {
    const pattern: Pattern = {
      argumentSchema: {},
      resultSchema: {},
      result: { output: { $alias: { cell: "argument", path: ["output"] } } },
      nodes: [
        {
          module: {
            type: "javascript",
            implementation: (value: number) => value * 2,
          },
          inputs: { $alias: { cell: "argument", path: ["input"] } },
          outputs: { $alias: { cell: "argument", path: ["output"] } },
        },
      ],
    };

    const tx1 = runtime.edit();
    const inputCell = runtime.getCell<{ input: number; output: number }>(
      space,
      "should allow passing a cell as a binding: input cell",
      undefined,
      tx1,
    );
    inputCell.set({ input: 10, output: 0 });
    await tx1.commit();

    const resultCell = runtime.getCell(
      space,
      "should allow passing a cell as a binding",
    );

    const result = runTrusted(
      runtime,
      undefined,
      pattern,
      inputCell,
      resultCell,
    );

    const inputCellValue = await inputCell.pull();
    expect(inputCellValue).toMatchObject({ input: 10, output: 20 });
    let resultValue = await result.pull();
    expect(resultValue).toEqual({ output: 20 });

    // The result should alias the original cell. Let's verify by stopping the
    // pattern and sending a new value to the input cell.
    runtime.runner.stop(result);

    const tx2 = runtime.edit();
    inputCell.withTx(tx2).send({ input: 10, output: 40 });
    await tx2.commit();

    resultValue = await result.pull();
    expect(resultValue).toEqual({ output: 40 });
  });

  it("should allow stopping a pattern", async () => {
    const pattern: Pattern = {
      argumentSchema: {},
      resultSchema: {},
      result: { output: { $alias: { cell: "argument", path: ["output"] } } },
      nodes: [
        {
          module: {
            type: "javascript",
            implementation: (value: number) => value * 2,
          },
          inputs: { $alias: { cell: "argument", path: ["input"] } },
          outputs: { $alias: { cell: "argument", path: ["output"] } },
        },
      ],
    };

    const tx = runtime.edit();
    const inputCell = runtime.getCell<{ input: number; output: number }>(
      space,
      "should allow stopping a pattern: input cell",
      undefined,
      tx,
    );
    inputCell.set({ input: 10, output: 0 });
    const resultCell = runtime.getCell(
      space,
      "should allow stopping a pattern",
      undefined,
      tx,
    );

    // Commit the initial values before running the pattern
    await tx.commit();

    const result = runTrusted(
      runtime,
      undefined,
      pattern,
      inputCell,
      resultCell,
    );

    let inputCellValue = await inputCell.pull();
    expect(inputCellValue).toMatchObject({ input: 10, output: 20 });

    const tx2 = runtime.edit();
    inputCell.withTx(tx2).send({ input: 20, output: 20 });
    await tx2.commit();

    inputCellValue = await inputCell.pull();
    expect(inputCellValue).toMatchObject({ input: 20, output: 40 });

    // Stop the pattern
    runtime.runner.stop(result);

    const tx3 = runtime.edit();
    inputCell.withTx(tx3).send({ input: 40, output: 40 });
    await tx3.commit();

    inputCellValue = await inputCell.pull();
    expect(inputCellValue).toMatchObject({ input: 40, output: 40 });

    // Restart the pattern
    runTrusted(runtime, undefined, pattern, undefined, result);

    inputCellValue = await inputCell.pull();
    expect(inputCellValue).toMatchObject({ input: 40, output: 80 });
  });

  it("should apply default values from argument schema", async () => {
    const pattern: Pattern = {
      argumentSchema: {
        type: "object",
        properties: {
          input: { type: "number", default: 42 },
          multiplier: { type: "number", default: 2 },
        },
        required: ["input"],
      },
      resultSchema: {},
      result: { result: { $alias: { partialCause: "result", path: [] } } },
      nodes: [
        {
          module: {
            type: "javascript",
            implementation: (args: { input: number; multiplier: number }) =>
              args.input * args.multiplier,
          },
          inputs: { $alias: { cell: "argument", path: [] } },
          outputs: { $alias: { partialCause: "result", path: [] } },
        },
      ],
    };

    // Test with partial arguments (should use default for multiplier)
    const resultWithPartialCell = runtime.getCell(
      space,
      "default values test - partial",
    );

    const resultWithPartial = runTrusted(runtime, undefined, pattern, {
      input: 10,
    }, resultWithPartialCell);
    const partialValue = await resultWithPartial.pull();
    expect(partialValue).toEqual({ result: 20 });

    // Test with no arguments (should use default for input)
    const resultWithDefaultsCell = runtime.getCell(
      space,
      "default values test - all defaults",
    );

    const resultWithDefaults = runTrusted(
      runtime,
      undefined,
      pattern,
      {},
      resultWithDefaultsCell,
    );
    const defaultsValue = await resultWithDefaults.pull();
    expect(defaultsValue).toEqual({ result: 84 }); // 42 * 2
  });

  it("does not persist a union default rejected by the full argument schema", () => {
    const pattern: Pattern = {
      argumentSchema: {
        anyOf: [
          { type: "undefined" },
          {
            type: "object",
            properties: { value: { type: "number", default: 1 } },
            required: ["value"],
          },
        ],
        oneOf: [
          { type: "undefined" },
          { type: "object" },
          {
            type: "object",
            properties: { value: { type: "number" } },
            required: ["value"],
          },
        ],
      },
      resultSchema: {},
      result: {},
      nodes: [],
    };
    const resultCell = runtime.getCell(
      space,
      "invalid full-schema union default",
    );

    runTrusted(runtime, undefined, pattern, undefined, resultCell);

    expect(resultCell.getArgumentCell()?.getRawUntyped()).toBeUndefined();
  });

  it("should handle complex nested schema types", async () => {
    const pattern: Pattern = {
      argumentSchema: {
        type: "object",
        properties: {
          config: {
            type: "object",
            properties: {
              values: {
                type: "array",
                items: { type: "number" },
              },
              operation: { type: "string", enum: ["sum", "avg", "max"] },
            },
            required: ["values", "operation"],
          },
        },
        required: ["config"],
      },
      resultSchema: {},
      result: { result: { $alias: { partialCause: "result", path: [] } } },
      nodes: [
        {
          module: {
            type: "javascript",
            implementation: (
              args: { config: { values: number[]; operation: string } },
            ) => {
              const values = args.config.values;
              switch (args.config.operation) {
                case "sum":
                  return values.reduce((a, b) => a + b, 0);
                case "avg":
                  return values.length
                    ? values.reduce((a, b) => a + b, 0) / values.length
                    : 0;
                case "max":
                  return Math.max(...values);
                default:
                  return 0;
              }
            },
          },
          inputs: { $alias: { cell: "argument", path: [] } },
          outputs: { $alias: { partialCause: "result", path: [] } },
        },
      ],
    };

    const resultCell = runtime.getCell(
      space,
      "complex schema test",
    );
    const result = runTrusted(runtime, undefined, pattern, {
      config: { values: [10, 20, 30, 40], operation: "avg" },
    }, resultCell);
    const resultValue = await result.pull();
    expect(resultValue).toEqual({ result: 25 });

    // Test with a different operation
    const result2 = runTrusted(runtime, undefined, pattern, {
      config: { values: [10, 20, 30, 40], operation: "max" },
    }, resultCell);
    const result2Value = await result2.pull();
    expect(result2Value).toEqual({ result: 40 });
  });

  it("should merge arguments with defaults from schema", async () => {
    const pattern: Pattern = {
      argumentSchema: {
        type: "object",
        properties: {
          options: {
            type: "object",
            properties: {
              enabled: { type: "boolean", default: true },
              value: { type: "number", default: 100 },
              name: { type: "string", default: "default" },
            },
          },
          input: { type: "number", default: 1 },
        },
      },
      resultSchema: {},
      result: {
        result: { $alias: { partialCause: "result", path: [] } },
        options: { $alias: { cell: "argument", path: ["options"] } },
      },
      nodes: [
        {
          module: {
            type: "javascript",
            implementation: (args: { input: number; options: any }) => {
              return args.options.enabled ? args.input * args.options.value : 0;
            },
          },
          inputs: { $alias: { cell: "argument", path: [] } },
          outputs: { $alias: { partialCause: "result", path: [] } },
        },
      ],
    };

    // Provide partial options - should merge with defaults
    const resultCell = runtime.getCell(
      space,
      "merge defaults test",
    );
    const result = runTrusted(runtime, undefined, pattern, {
      options: { value: 10 },
      input: 5,
    }, resultCell);

    const resultValue = await result.pull() as any;
    expect(resultValue.options).toEqual({
      enabled: true,
      value: 10,
      name: "default",
    });
    expect(resultValue.result).toEqual(50); // 5 * 10
  });

  it("should preserve NAME between runs", async () => {
    const pattern: Pattern = {
      argumentSchema: {},
      resultSchema: {},
      derivedInternalCells: [{
        partialCause: "counter",
        schema: { default: 0 },
      }],
      result: {
        [NAME]: "counter",
        counter: { $alias: { partialCause: "counter", path: [] } },
      },
      nodes: [
        {
          module: {
            type: "javascript",
            implementation: (input: any) => {
              return input.value;
            },
          },
          inputs: { $alias: { cell: "argument", path: [] } },
          outputs: { $alias: { partialCause: "counter", path: [] } },
        },
      ],
    };

    const resultCell = runtime.getCell<any>(
      space,
      "state preservation test",
    );

    // First run
    runTrusted(runtime, undefined, pattern, { value: 1 }, resultCell);
    let cellValue = await resultCell.pull();
    expect(cellValue?.[NAME]).toEqual("counter");
    expect(cellValue?.counter).toEqual(1);

    // Now change the name
    const tx = runtime.edit();
    resultCell.withTx(tx).update({ [NAME]: "my counter" });
    await tx.commit();

    // Second run with same pattern but different argument
    runTrusted(runtime, undefined, pattern, { value: 2 }, resultCell);
    cellValue = await resultCell.pull();
    expect(cellValue?.[NAME]).toEqual("my counter");
    expect(cellValue?.counter).toEqual(2);
  });

  it("should refresh NAME when the pattern changes", async () => {
    const pattern: Pattern = {
      argumentSchema: {},
      resultSchema: {},
      derivedInternalCells: [{
        partialCause: "counter",
        schema: { default: 0 },
      }],
      result: {
        [NAME]: "counter",
        counter: { $alias: { partialCause: "counter", path: [] } },
      },
      nodes: [
        {
          module: {
            type: "javascript",
            implementation: (input: any) => input.value,
          },
          inputs: { $alias: { cell: "argument", path: [] } },
          outputs: { $alias: { partialCause: "counter", path: [] } },
        },
      ],
    };

    const renamedPattern: Pattern = {
      ...pattern,
      result: {
        [NAME]: "renamed counter",
        counter: { $alias: { partialCause: "counter", path: [] } },
      },
    };

    const resultCell = runtime.getCell<any>(
      space,
      "state preservation across pattern changes test",
    );

    runTrusted(runtime, undefined, pattern, { value: 1 }, resultCell);
    let cellValue = await resultCell.pull();
    expect(cellValue?.[NAME]).toEqual("counter");
    expect(cellValue?.counter).toEqual(1);

    runTrusted(runtime, undefined, renamedPattern, { value: 2 }, resultCell);
    cellValue = await resultCell.pull();
    expect(cellValue?.[NAME]).toEqual("renamed counter");
    expect(cellValue?.counter).toEqual(2);
  });

  it("should create separate copies of initial values (frozen)", async () => {
    // `getRaw()` returns frozen objects; verify independence via
    // `getRawUntyped({ frozen: false })` for mutable access.
    const sm = StorageManager.emulate({ as: signer });
    const localRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: sm,
    });

    const pattern: Pattern = {
      argumentSchema: {
        type: "object",
        properties: {
          input: { type: "number" },
        },
      },
      derivedInternalCells: [
        {
          partialCause: "nested",
          scope: "space",
          schema: { default: { value: "initial" } },
        },
        {
          partialCause: "counter",
          scope: "space",
          schema: { default: 10 },
        },
      ],
      resultSchema: {},
      result: {
        counter: { $alias: { partialCause: "counter", path: [] } },
        nested: { $alias: { partialCause: "nested", path: [] } },
      },
      nodes: [
        {
          module: {
            type: "javascript",
            implementation: (args: { input: number }) => {
              return {
                counter: args.input,
              };
            },
          },
          inputs: { $alias: { cell: "argument", path: ["input"] } },
          outputs: { $alias: { partialCause: "counter", path: [] } },
        },
      ],
    };

    // Create first instance
    const result1Cell = localRuntime.getCell(
      space,
      "separate copies modern 1",
    );
    const result1 = runTrusted(
      localRuntime,
      undefined,
      pattern,
      { input: 5 },
      result1Cell,
    );
    await result1.pull();

    // Create second instance
    const result2Cell = localRuntime.getCell(
      space,
      "separate copies modern 2",
    );
    const result2 = runTrusted(
      localRuntime,
      undefined,
      pattern,
      { input: 10 },
      result2Cell,
    );
    await result2.pull();

    // Use getRawUntyped({ frozen: false }) for mutable copies
    const internalCell1 = getDerivedInternalCell(result1, {
      partialCause: "nested",
    });
    const internalCell2 = getDerivedInternalCell(result2, {
      partialCause: "nested",
    });
    const nested1 = internalCell1.getRawUntyped({ frozen: false }) as any;
    const nested2 = internalCell2.getRawUntyped({ frozen: false }) as any;

    // Verify they are different objects
    expect(nested1).not.toBe(nested2);

    // Modify nested object in first instance's mutable copy
    nested1.value = "modified";

    // Verify second instance is unaffected
    expect(nested2.value).toBe("initial");

    await localRuntime.storageManager.synced();
    await localRuntime.dispose();
    await sm.close();
  });

  it("materializes derived internal defaults from descriptor schemas", async () => {
    const pattern: Pattern = {
      argumentSchema: { type: "object", properties: {} },
      derivedInternalCells: [
        {
          partialCause: "history",
          schema: { type: "array", default: [] },
        },
        {
          partialCause: "count",
          schema: { type: "number", default: 0 },
        },
      ],
      resultSchema: {
        type: "object",
        properties: {
          history: { type: "array" },
          count: { type: "number" },
        },
      },
      result: {
        history: { $alias: { partialCause: "history", path: [] } },
        count: { $alias: { partialCause: "count", path: [] } },
      },
      nodes: [],
    };

    const result = runTrusted(
      runtime,
      undefined,
      pattern,
      {},
      runtime.getCell(space, "schema default derived internals"),
    );

    expect(await result.key("history").pull()).toEqual([]);
    expect(await result.key("count").pull()).toBe(0);
    expect(
      getDerivedInternalCell(result, {
        partialCause: "history",
        schema: { type: "array", default: [] },
      }).getRawUntyped(),
    ).toEqual([]);
  });
});

describe("storage subscription", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("clears cached patterns when storage notifies of changes — every scope INSTANCE of the changed doc (r3739139481)", () => {
    const internals = runtime.runner.accessForTestingOnly;

    const uri = "pattern-cache-test" as URI;
    // The memo is keyed doc-then-instance: notifications name the DOC
    // (scope arrives by NAME, which cannot address a per-run instance
    // on a serving runtime), so one change clears every instance's
    // memo — the documented safe over-eviction.
    const key = `${space}/${uri}` as const;
    internals.resultPatternCache.set(
      key,
      new Map([
        ["space", "cached-pattern"],
        ["user:did%3Akey%3Aalice", "cached-pattern-alice"],
      ]),
    );

    const notification = {
      type: "commit",
      space,
      changes: [
        {
          address: {
            id: uri,
            type: "application/json" as MediaType,
            path: [],
          },
          before: undefined,
          after: undefined,
        },
      ],
    } satisfies ICommitNotification;

    const evicted: string[] = [];
    const listener = (event: Event) => {
      const { marker } = (event as RuntimeTelemetryEvent).detail;
      if (marker.type === "runner.result-pattern.evict") {
        evicted.push(marker.key);
      }
    };
    runtime.telemetry.addEventListener("telemetry", listener);
    try {
      const subscription = internals.createStorageSubscription();
      subscription.next(notification);
    } finally {
      runtime.telemetry.removeEventListener("telemetry", listener);
    }

    expect(evicted).toEqual([key]);
  });
});

describe("setup/start", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime?.storageManager.synced();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("setup does not schedule; start schedules and runs", async () => {
    const pattern: Pattern = {
      argumentSchema: {
        type: "object",
        properties: { input: { type: "number" }, output: { type: "number" } },
      },
      resultSchema: {},
      result: { output: { $alias: { partialCause: "output", path: [] } } },
      nodes: [
        {
          module: { type: "passthrough" },
          inputs: { value: { $alias: { cell: "argument", path: ["input"] } } },
          outputs: {
            value: { $alias: { partialCause: "output", path: [] } },
          },
        },
      ],
    };

    const resultCell = runtime.getCell(space, "setup does not schedule");

    // Only setup – should not run the node yet
    setupTrusted(runtime, undefined, pattern, { input: 1 }, resultCell);

    // Output hasn't been computed yet
    let cellValue = await resultCell.pull();
    expect(cellValue).toEqual({ output: undefined });

    // Start – should schedule and compute output
    runtime.start(resultCell);
    cellValue = await resultCell.pull();
    expect(cellValue).toEqual({ output: 1 });
  });

  it("reports the start failure, not a failure of the cleanup it triggers", () => {
    // A start that fails cancels what it already registered, and a cancel can
    // itself throw -- a builtin winding down state it had not finished
    // building, say. Were that allowed to escape it would REPLACE the error
    // being handled, and what surfaced would describe the cleanup rather than
    // the failure that caused it.
    const pattern: Pattern = {
      argumentSchema: { type: "object", properties: {} },
      resultSchema: {},
      result: {},
      nodes: [
        {
          // Registers a cancel that fails, then the node below fails the
          // start, so the cancel runs against a half-built piece.
          module: {
            type: "raw",
            implementation: (
              _inputs: unknown,
              _sendResult: unknown,
              addCancel: (cancel: () => void) => void,
            ) => {
              addCancel(() => {
                throw new Error("cleanup blew up");
              });
            },
          } as unknown as Module,
          inputs: {},
          outputs: {},
        },
        {
          // `instantiateRawNode` rejects a raw module with no implementation.
          module: { type: "raw" } as unknown as Module,
          inputs: {},
          outputs: {},
        },
      ],
    };

    const resultCell = runtime.getCell(space, "start failure beats cleanup");

    expect(() => runtime.run(undefined, pattern, {}, resultCell)).toThrow(
      /Raw module is not a function/,
    );
  });

  it("refuses an action node whose inputs bind `$event`", async () => {
    // A handler lowered where a lift belongs has this shape: no handler
    // wrapper on the module, and a `$event` among the inputs.

    const pattern: Pattern = {
      argumentSchema: { type: "object", properties: {} },
      resultSchema: {},
      result: {},
      nodes: [
        {
          module: { type: "javascript", implementation: () => undefined },
          inputs: { $event: 42 },
          outputs: {},
        },
      ],
    };

    const resultCell = runtime.getCell(space, "action node binds $event");
    setupTrusted(runtime, undefined, pattern, {}, resultCell);

    await expect(runtime.start(resultCell)).rejects.toThrow(
      "binds a `$event` input",
    );
  });

  it("refuses a handler node with no `$event` input", async () => {
    const pattern: Pattern = {
      argumentSchema: { type: "object", properties: {} },
      resultSchema: {},
      result: {},
      nodes: [
        {
          module: {
            type: "javascript",
            wrapper: "handler",
            implementation: () => undefined,
          },
          inputs: { $ctx: {} },
          outputs: {},
        },
      ],
    };

    const resultCell = runtime.getCell(space, "handler node without $event");
    setupTrusted(runtime, undefined, pattern, {}, resultCell);

    await expect(runtime.start(resultCell)).rejects.toThrow(
      "has no `$event` input",
    );
  });

  it("refuses a handler node whose `$event` input is not a link", async () => {
    const pattern: Pattern = {
      argumentSchema: { type: "object", properties: {} },
      resultSchema: {},
      result: {},
      nodes: [
        {
          module: {
            type: "javascript",
            wrapper: "handler",
            implementation: () => undefined,
          },
          inputs: { $event: 42 },
          outputs: {},
        },
      ],
    };

    const resultCell = runtime.getCell(space, "handler $event is not a link");
    setupTrusted(runtime, undefined, pattern, {}, resultCell);

    await expect(runtime.start(resultCell)).rejects.toThrow(
      "is not a link (got: `42`)",
    );
  });

  it("registers a handler on a stream whose document holds no value", async () => {
    // Nothing is read at the stream's target to decide the node is a handler:
    // the module's wrapper says so, and `$event` names the stream.

    let received: unknown;
    const pattern: Pattern = {
      argumentSchema: { type: "object", properties: {} },
      resultSchema: {},
      derivedInternalCells: [
        { partialCause: "events", schema: { asCell: ["stream"] } },
      ],
      result: {},
      nodes: [
        {
          module: {
            type: "javascript",
            wrapper: "handler",
            implementation: (event: unknown) => {
              received = event;
            },
          },
          inputs: { $event: { $alias: { partialCause: "events", path: [] } } },
          outputs: {},
        },
      ],
    };

    const resultCell = runtime.getCell(space, "handler on a valueless stream");
    setupTrusted(runtime, undefined, pattern, {}, resultCell);
    expect(await runtime.start(resultCell)).toBe(true);

    const events = getDerivedInternalCell(resultCell, {
      partialCause: "events",
      schema: { asCell: ["stream"] },
    });
    expect(events.getRaw()).toBeUndefined();
    runtime.scheduler.queueEvent(events.getAsNormalizedFullLink(), { n: 1 });
    await runtime.idle();
    expect(received).toEqual({ n: 1 });
  });

  it("start() leaves no running registration when instantiation throws", async () => {
    // An action node binding a `$event` input makes node instantiation
    // throw.
    const pattern: Pattern = {
      argumentSchema: { type: "object", properties: {} },
      resultSchema: {},
      result: {},
      nodes: [
        {
          module: { type: "javascript", implementation: () => undefined },
          inputs: { $event: 42 },
          outputs: {},
        },
      ],
    };

    const resultCell = runtime.getCell(
      space,
      "start cleans up when instantiation throws",
    );
    setupTrusted(runtime, undefined, pattern, {}, resultCell);

    await expect(runtime.start(resultCell)).rejects.toThrow(
      "binds a `$event` input",
    );

    // A zombie registration would make the second start() short-circuit to
    // "already running" and return without error. It must throw identically.
    await expect(runtime.start(resultCell)).rejects.toThrow(
      "binds a `$event` input",
    );
  });

  it("run() with a given pattern leaves no running registration when instantiation throws", () => {
    // Same regression as above, via the fresh-run entry (the path a live
    // `cf piece new` takes): `Runner.#startCore()`'s givenPattern branch must
    // also clean up when node instantiation throws.
    const pattern: Pattern = {
      argumentSchema: { type: "object", properties: {} },
      resultSchema: {},
      result: {},
      nodes: [
        {
          module: { type: "javascript", implementation: () => undefined },
          inputs: { $event: 42 },
          outputs: {},
        },
      ],
    };

    const resultCell = runtime.getCell(
      space,
      "fresh run cleans up when instantiation throws",
    );

    expect(() => runTrusted(runtime, undefined, pattern, {}, resultCell))
      .toThrow("binds a `$event` input");

    // A zombie registration would make the second run() short-circuit to
    // "already running" and return without error. It must throw identically.
    expect(() => runTrusted(runtime, undefined, pattern, {}, resultCell))
      .toThrow("binds a `$event` input");
  });

  it("setup ignores exhausted retry errors and still resolves", async () => {
    const pattern: Pattern = {
      argumentSchema: {
        type: "object",
        properties: { input: { type: "number" } },
      },
      resultSchema: {},
      result: { output: { $alias: { partialCause: "output", path: [] } } },
      nodes: [],
    };

    const resultCell = runtime.getCell(space, "setup ignores retry errors");
    const originalEditWithRetry = runtime.editWithRetry.bind(runtime);
    runtime.editWithRetry = (() =>
      Promise.resolve({
        error: {
          name: "StorageTransactionAborted" as const,
          message: "always-fail",
          reason: "always-fail",
        },
      })) as typeof runtime.editWithRetry;

    try {
      await expect(runtime.setup(undefined, pattern, { input: 1 }, resultCell))
        .resolves.toBe(resultCell);
    } finally {
      runtime.editWithRetry = originalEditWithRetry;
    }
  });

  it("runSynced rethrows retry exhaustion as the same `Error` when identity is required", async () => {
    const pattern: Pattern = {
      argumentSchema: { type: "object", properties: {} },
      resultSchema: {},
      result: {},
      nodes: [],
    };
    const resultCell = runtime.getCell(
      space,
      "runSynced rethrows precondition retry exhaustion",
    );
    const originalEditWithRetry = runtime.editWithRetry.bind(runtime);
    const failure = new Error("precondition retry exhausted");
    runtime.editWithRetry = (() => Promise.resolve({ error: failure })) as any;

    try {
      await expect(runtime.runSynced(
        resultCell,
        trustExecutable(runtime, pattern),
        {},
        {
          expectedPatternIdentity: {
            identity: "of:fid1:expected",
            symbol: "default",
          },
        },
      )).rejects.toBe(failure);
    } finally {
      runtime.editWithRetry = originalEditWithRetry;
    }
  });

  it("runSynced returns the untyped cell when the pattern has no result schema", async () => {
    const pattern = {
      argumentSchema: { type: "object", properties: {} },
      result: {},
      nodes: [],
    } as unknown as Pattern;
    const resultCell = runtime.getCell(
      space,
      "runSynced pattern without result schema",
    );

    const result = await runtime.runSynced(
      resultCell,
      trustExecutable(runtime, pattern),
      {},
    );

    expect(result).toBe(resultCell);
  });

  it("runSynced returns the untyped cell when the durable pattern cannot be loaded", async () => {
    // After post-commit work, the returned view is re-typed by the pattern
    // that is durable NOW. When that pattern cannot be loaded, the answer is
    // the raw cell rather than a stale schema. What the branch responds to is
    // the load's answer, so the load is answered directly instead of staging
    // the timing that would produce it.
    const resultCell = runtime.getCell(space, "runSynced unloadable winner");
    const pattern = await compileReceiptPattern(runtime, "unloadable");
    await runtime.runSynced(resultCell, pattern, {});
    expect(getPatternIdentityRef(resultCell)).toBeDefined();

    const manager = runtime.patternManager;
    const originalLoad = manager.loadPatternByIdentity.bind(manager);
    manager.loadPatternByIdentity = () => Promise.resolve(undefined);

    try {
      const result = await runtime.runSynced(resultCell, pattern, {});
      expect(result).toBe(resultCell);
    } finally {
      manager.loadPatternByIdentity = originalLoad;
    }
  });

  it("runSynced follows the durable identity when it moves during the schema load", async () => {
    // The recheck after each load is what makes the loop settle on the
    // pattern that is durable now: a pointer that moved while its pattern
    // loaded restarts the resolution instead of typing the view by the
    // pattern that was current a moment ago. The move is performed from
    // inside the load itself, which is the window the recheck exists for.
    const resultCell = runtime.getCell(space, "runSynced moving winner");
    const first = await compileReceiptPattern(runtime, "moving-first");
    const second = await compileReceiptPattern(runtime, "moving-second");
    const secondRef = runtime.patternManager.getArtifactEntryRef(second);
    if (secondRef === undefined) {
      throw new Error("the compiled pattern has no entry ref");
    }
    await runtime.runSynced(resultCell, first, {});
    expect(getPatternIdentityRef(resultCell)).toBeDefined();

    const manager = runtime.patternManager;
    const originalLoad = manager.loadPatternByIdentity.bind(manager);
    let moved = false;
    manager.loadPatternByIdentity = async (identity, symbol, loadSpace) => {
      if (!moved) {
        moved = true;
        const { error } = await runtime.editWithRetry((tx) => {
          resultCell.withTx(tx).setMetaRaw(
            "patternIdentity",
            secondRef,
            rawMetaWriteAuthorization,
          );
        });
        if (error !== undefined) throw error;
      }
      return await originalLoad(identity, symbol, loadSpace);
    };

    try {
      const result = await runtime.runSynced(resultCell, first, {});

      expect(moved).toBe(true);
      expect(getPatternIdentityRef(resultCell)).toEqual(secondRef);
      expect(result.getAsNormalizedFullLink().schema).toEqual(
        second.resultSchema,
      );
    } finally {
      manager.loadPatternByIdentity = originalLoad;
    }
  });

  it("start() yields to a pointer that moved again while the swapped-in pattern's dependencies synced", async () => {
    // The watcher follows the durable pointer to a pattern the runtime does
    // not hold by loading it and naming what it reads before the swap. A
    // pointer that moves again during that naming has its own swap on the
    // way, so the earlier chain swaps nothing: the piece ends up on the
    // pattern the pointer names, not on the one whose sync finished last.

    const resultCell = runtime.getCell(
      space,
      "watcher yields to a later pointer move",
    );
    const first = await compileReceiptPattern(runtime, "yield-first");
    const second = await compileReceiptPattern(runtime, "yield-second");
    const third = await compileReceiptPattern(runtime, "yield-third");
    const manager = runtime.patternManager;
    const secondRef = manager.getArtifactEntryRef(second);
    const thirdRef = manager.getArtifactEntryRef(third);
    if (secondRef === undefined || thirdRef === undefined) {
      throw new Error("a compiled pattern has no entry ref");
    }
    await runtime.runSynced(resultCell, first, {});
    const movePointer = async (ref: { identity: string; symbol: string }) => {
      const { error } = await runtime.editWithRetry((tx) => {
        resultCell.withTx(tx).setMetaRaw(
          "patternIdentity",
          ref,
          rawMetaWriteAuthorization,
        );
      });
      if (error !== undefined) throw error;
    };
    // The second pattern is compiled here, so the runtime holds it. Hiding
    // it from the in-memory lookup sends the watcher down the load path,
    // whose swap names what the loaded pattern reads before it happens.
    const originalLookup = manager.artifactFromIdentitySync.bind(manager);
    manager.artifactFromIdentitySync = (identity, symbol) =>
      identity === secondRef.identity
        ? undefined
        : originalLookup(identity, symbol);
    let movedDuringSync = false;
    runtime.runner.accessForTestingOnly.dependencySyncer = async (
      cell,
      pattern,
      inputs,
      sync,
    ) => {
      if (
        !movedDuringSync &&
        manager.getArtifactEntryRef(pattern)?.identity === secondRef.identity
      ) {
        movedDuringSync = true;
        await movePointer(thirdRef);
      }
      return await sync(cell, pattern, inputs);
    };

    try {
      await movePointer(secondRef);
      await runtime.runner.idlePointerMaintenance();
      await runtime.idle();

      expect(movedDuringSync).toBe(true);
      expect(getPatternIdentityRef(resultCell)).toEqual(thirdRef);
      expect((resultCell.getAsQueryResult() as { marker: string }).marker)
        .toBe("yield-third");
    } finally {
      manager.artifactFromIdentitySync = originalLookup;
      runtime.runner.accessForTestingOnly.dependencySyncer = undefined;
    }
  });

  it("runSyncedWithCommit returns the pattern accepted by its setup transaction", async () => {
    const resultCell = runtime.getCell(space, "runSynced commit receipt");
    const initialPattern = await compileReceiptPattern(runtime, "v1");
    const nextPattern = await compileReceiptPattern(runtime, "v2");

    await runtime.runSynced(
      resultCell,
      initialPattern,
      {},
    );
    const previous = receiptSourceSnapshot(runtime, resultCell).pattern;
    const pieceSourceTransition = await receiptSourceTransition(
      runtime,
      resultCell,
    );

    const result = await runtime.runSyncedWithCommit(
      resultCell,
      nextPattern,
      {},
      { expectedPatternIdentity: previous, pieceSourceTransition },
    );

    expect(result.commit.pattern).toEqual(
      receiptSourceSnapshot(runtime, resultCell).pattern,
    );
    expect(result.cell.get()).toEqual({ marker: "v2" });

    // The seq is the commit's own position in the space's log: read there,
    // the document already carries the receipt's pointer, and read one seq
    // earlier it still carries the pointer the setup replaced.
    expect(result.commit.space).toBe(space);
    const remote = await openRemoteSession(storageManager);
    try {
      const id = resultCell.getAsNormalizedFullLink().id;
      const pointerAt = async (seq: number) =>
        (await remote.session.queryGraph({
          roots: [{ id, selector: { path: [], schema: false } }],
          atSeq: seq,
        }))
          .entities.find((entity) => entity.id === id)?.document
          ?.patternIdentity;
      expect(await pointerAt(result.commit.seq)).toEqual(result.commit.pattern);
      expect(await pointerAt(result.commit.seq - 1)).toEqual(previous);
    } finally {
      await remote.client.close();
    }
  });

  it("runSyncedWithCommit carries its receipt through post-commit failures", async () => {
    const resultCell = runtime.getCell(
      space,
      "runSynced post-commit receipt",
    );
    const initialPattern = await compileReceiptPattern(runtime, "v1");
    const nextPattern = await compileReceiptPattern(runtime, "v2");
    await runtime.runSynced(
      resultCell,
      initialPattern,
      {},
    );
    const previous = receiptSourceSnapshot(runtime, resultCell).pattern;
    const pieceSourceTransition = await receiptSourceTransition(
      runtime,
      resultCell,
    );

    const postCommitFailure = new Error("injected post-commit failure");
    let syncCount = 0;
    runtime.runner.accessForTestingOnly.dependencySyncer = async (
      resultCell,
      executable,
      inputs,
      sync,
    ) => {
      syncCount++;
      if (syncCount === 2) throw postCommitFailure;
      return await sync(resultCell, executable, inputs);
    };

    try {
      let reported: unknown;
      try {
        await runtime.runSyncedWithCommit(
          resultCell,
          nextPattern,
          {},
          { expectedPatternIdentity: previous, pieceSourceTransition },
        );
      } catch (error) {
        reported = error;
      }

      expect(reported).toBeInstanceOf(PatternSetupPostCommitError);
      const failure = reported as PatternSetupPostCommitError;
      expect(failure.cause).toBe(postCommitFailure);
      expect(failure.commit.pattern).toEqual(
        receiptSourceSnapshot(runtime, resultCell).pattern,
      );
      expect(failure.commit.space).toBe(space);
      expect(failure.commit.seq).toBeGreaterThan(0);
    } finally {
      runtime.runner.accessForTestingOnly.dependencySyncer = undefined;
    }
  });

  it("runSyncedWithCommit refuses a receipt when the accepted commit reports no seq", async () => {
    // The seq is recorded at the verdict, so a resolved commit without one is
    // the type's edge — and a receipt that names no commit is refused loudly
    // there rather than issued.

    const resultCell = runtime.getCell(space, "runSynced receipt without seq");
    const initialPattern = await compileReceiptPattern(runtime, "v1");
    const nextPattern = await compileReceiptPattern(runtime, "v2");
    await runtime.runSynced(resultCell, initialPattern, {});
    const previous = receiptSourceSnapshot(runtime, resultCell).pattern;
    const pieceSourceTransition = await receiptSourceTransition(
      runtime,
      resultCell,
    );
    const committedSeq = ExtendedStorageTransaction.prototype.committedSeq;
    ExtendedStorageTransaction.prototype.committedSeq = () => undefined;

    try {
      await expect(runtime.runSyncedWithCommit(
        resultCell,
        nextPattern,
        {},
        { expectedPatternIdentity: previous, pieceSourceTransition },
      )).rejects.toThrow(
        "the pattern setup committed without recording its store seq",
      );
    } finally {
      ExtendedStorageTransaction.prototype.committedSeq = committedSeq;
    }
  });

  it("runSyncedWithCommit throws a refused setup commit as an `Error` that keeps the refusal's fields", async () => {
    // Storage reports a refusal as a `Result` error, a plain object rather
    // than an `Error`. Thrown as it stands it fails `instanceof Error`, has
    // no stack, and renders as `[object Object]`, so the message, the one
    // line an operator can act on, never reaches them. The refusal below has
    // the shape the CFC boundary produces when not every reason is a
    // verdict.

    const resultCell = runtime.getCell(space, "runSynced refused setup commit");
    const initialPattern = await compileReceiptPattern(runtime, "v1");
    const nextPattern = await compileReceiptPattern(runtime, "v2");
    await runtime.runSynced(resultCell, initialPattern, {});
    const previous = receiptSourceSnapshot(runtime, resultCell).pattern;
    const pieceSourceTransition = await receiptSourceTransition(
      runtime,
      resultCell,
    );
    const refusal = {
      name: "StorageTransactionAborted" as const,
      message: "CFC enforcement rejected commit: relevant transaction was " +
        "not prepared: a policy check refused the write",
      reason: new Error("cfc-refusal-not-a-verdict"),
    };
    const originalEditWithRetry = runtime.editWithRetry.bind(runtime);
    runtime.editWithRetry =
      (() =>
        Promise.resolve({ error: refusal })) as typeof runtime.editWithRetry;

    try {
      const thrown = await runtime.runSyncedWithCommit(
        resultCell,
        nextPattern,
        {},
        { expectedPatternIdentity: previous, pieceSourceTransition },
      ).then(() => undefined, (error: unknown) => error);
      expect(thrown).toBeInstanceOf(Error);
      const error = thrown as Error & { reason?: unknown };
      expect(error.message).toBe(refusal.message);
      expect(error.name).toBe("StorageTransactionAborted");
      expect(error.reason).toBe(refusal.reason);
    } finally {
      runtime.editWithRetry = originalEditWithRetry;
    }
  });

  it("runSyncedWithCommit refuses a receipt without a fresh source transition", async () => {
    const pattern: Pattern = {
      argumentSchema: { type: "object", properties: {} },
      resultSchema: {},
      result: {},
      nodes: [],
    };
    const resultCell = runtime.getCell(
      space,
      "runSyncedWithCommit no-op receipt refusal",
    );
    const executable = trustExecutable(runtime, pattern);
    await runtime.runSynced(resultCell, executable, {});
    const previous = receiptSourceSnapshot(runtime, resultCell).pattern;

    await expect(runtime.runSyncedWithCommit(
      resultCell,
      executable,
      {},
      // JavaScript callers can bypass the required TypeScript field; the
      // runtime boundary must still refuse rather than minting a receipt for
      // the zero-write setup this exact fixture produces.
      { expectedPatternIdentity: previous } as never,
    )).rejects.toThrow("requires a fresh source transition");
  });

  it("runSynced refuses a run without a pattern", async () => {
    const resultCell = runtime.getCell(space, "runSynced without a pattern");

    await expect(runtime.runSynced(
      resultCell,
      // JavaScript callers can omit the required TypeScript argument; the
      // runtime boundary must still refuse by name rather than failing on
      // the first read of the missing pattern.
      undefined as never,
      {},
    )).rejects.toThrow("requires a pattern");
  });

  it("runSyncedWithCommit refuses a run without a pattern", async () => {
    const resultCell = runtime.getCell(
      space,
      "runSyncedWithCommit without a pattern",
    );
    const transition = unreachableReceiptSourceTransition();

    await expect(runtime.runSyncedWithCommit(
      resultCell,
      // JavaScript callers can omit the required TypeScript argument; the
      // runtime boundary must still refuse by name rather than failing on
      // the first read of the missing pattern.
      undefined as never,
      {},
      {
        expectedPatternIdentity: transition.expected.pattern,
        pieceSourceTransition: transition,
      },
    )).rejects.toThrow("requires a pattern");
  });

  it("runSyncedWithCommit refuses a source revision ID already in history", async () => {
    const resultCell = runtime.getCell(
      space,
      "runSyncedWithCommit reused source revision",
    );
    const initialPattern = await compileReceiptPattern(runtime, "v1");
    const secondPattern = await compileReceiptPattern(runtime, "v2");
    const thirdPattern = await compileReceiptPattern(runtime, "v3");

    await runtime.runSynced(resultCell, initialPattern, {});
    const initial = receiptSourceSnapshot(runtime, resultCell);
    const firstTransition = await receiptSourceTransition(runtime, resultCell);
    await runtime.runSyncedWithCommit(resultCell, secondPattern, {}, {
      expectedPatternIdentity: initial.pattern,
      pieceSourceTransition: firstTransition,
    });
    const current = receiptSourceSnapshot(runtime, resultCell);
    const reusedTransition = {
      ...await receiptSourceTransition(runtime, resultCell),
      revisionId: firstTransition.revisionId,
    };

    await expect(runtime.runSyncedWithCommit(
      resultCell,
      thirdPattern,
      {},
      {
        expectedPatternIdentity: current.pattern,
        pieceSourceTransition: reusedTransition,
      },
    )).rejects.toThrow("source revision ID already exists");
    expect(receiptSourceSnapshot(runtime, resultCell)).toEqual(current);
    expect(resultCell.get()).toEqual({ marker: "v2" });
  });

  it("runSyncedWithCommit refuses to issue a receipt while sealing into a wave", async () => {
    // A serving runtime seals rather than commits: acceptance means the wave
    // took the contribution, and a later withdrawal — superseded, requeued,
    // lease lost — can undo it. A receipt saying `committed` would overstate
    // that, and waiting for the wave to settle from inside the action feeding
    // it can deadlock, so the boundary refuses instead of weakening the word.
    const pattern: Pattern = {
      argumentSchema: { type: "object", properties: {} },
      resultSchema: {},
      result: {},
      nodes: [],
    };
    // A serving runtime of its own: installing a seal destination is the ON
    // arm's posture, which the suite's shared client runtime does not have.
    const servingStorage = StorageManager.emulate({ as: signer });
    const serving = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: servingStorage,
      servingPosture: true,
      experimental: { serverExecution: true },
    });
    const resultCell = serving.getCell(
      space,
      "runSyncedWithCommit while sealing",
    );
    const sealed: IExtendedStorageTransaction[] = [];
    serving.installSealDestination({
      seal: (tx: IExtendedStorageTransaction) => {
        sealed.push(tx);
        return tx.commit();
      },
    });

    try {
      await expect(serving.runSyncedWithCommit(
        resultCell,
        trustExecutable(serving, pattern),
        {},
        {
          expectedPatternIdentity: {
            identity: "of:fid1:expected",
            symbol: "default",
          },
          pieceSourceTransition: unreachableReceiptSourceTransition(),
        },
      )).rejects.toThrow(SEALING_RECEIPT_REFUSAL);
      // Refused at the boundary, so nothing reached the wave to be withdrawn.
      expect(sealed).toEqual([]);
    } finally {
      serving.clearSealDestination();
      await serving.dispose();
      await servingStorage.close();
    }
  });

  it("runSyncedWithCommit refuses a wave that starts sealing mid-call", async () => {
    // The entry check answers for the moment the call started, and the call
    // then awaits. A destination installed during those awaits would seal the
    // very transaction the receipt describes, so the condition is asked again
    // inside the transaction — which is also what covers `editWithRetry`
    // building a fresh one per retry.
    const pattern: Pattern = {
      argumentSchema: { type: "object", properties: {} },
      resultSchema: {},
      result: {},
      nodes: [],
    };
    const servingStorage = StorageManager.emulate({ as: signer });
    const serving = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: servingStorage,
      servingPosture: true,
      experimental: { serverExecution: true },
    });
    const resultCell = serving.getCell(
      space,
      "runSyncedWithCommit sealing mid-call",
    );
    await serving.runSynced(resultCell, trustExecutable(serving, pattern), {});
    const previous = receiptSourceSnapshot(serving, resultCell).pattern;

    // Installed from the synchronization the call performs before it opens
    // its transaction, which is the window the entry check cannot see.
    const sealed: IExtendedStorageTransaction[] = [];
    const mutableCell = resultCell as unknown as {
      sync: typeof resultCell.sync;
    };
    const originalSync = resultCell.sync.bind(resultCell);
    mutableCell.sync = (async (...args: Parameters<typeof resultCell.sync>) => {
      const synced = await originalSync(...args);
      if (!serving.sealDestinationInstalled) {
        serving.installSealDestination({
          seal: (tx: IExtendedStorageTransaction) => {
            sealed.push(tx);
            return tx.commit();
          },
        });
      }
      return synced;
    }) as typeof resultCell.sync;

    try {
      await expect(serving.runSyncedWithCommit(
        resultCell,
        trustExecutable(serving, pattern),
        {},
        {
          expectedPatternIdentity: previous,
          pieceSourceTransition: unreachableReceiptSourceTransition(),
        },
      )).rejects.toThrow(SEALING_RECEIPT_REFUSAL);
      expect(sealed).toEqual([]);
    } finally {
      mutableCell.sync = originalSync;
      serving.clearSealDestination();
      await serving.dispose();
      await servingStorage.close();
    }
  });

  it("runSynced refuses source-update authority while sealing without requesting a receipt", async () => {
    const servingStorage = StorageManager.emulate({ as: signer });
    const serving = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: servingStorage,
      servingPosture: true,
      experimental: { serverExecution: true },
    });
    try {
      const resultCell = serving.getCell(
        space,
        "source authority while sealing",
      );
      const initial = await compileReceiptPattern(serving, "v1");
      const candidate = await compileReceiptPattern(serving, "v2");
      await serving.runSynced(resultCell, initial, {});
      const before = receiptSourceSnapshot(serving, resultCell);
      const transition = await receiptSourceTransition(serving, resultCell);
      const sealed: IExtendedStorageTransaction[] = [];
      serving.installSealDestination({
        seal: (tx: IExtendedStorageTransaction) => {
          sealed.push(tx);
          return tx.commit();
        },
      });

      await expect(serving.runSynced(resultCell, candidate, {}, {
        expectedPatternIdentity: before.pattern,
        pieceSourceTransition: transition,
      })).rejects.toThrow(SEALING_SOURCE_UPDATE_REFUSAL);
      expect(sealed).toEqual([]);
      expect(receiptSourceSnapshot(serving, resultCell)).toEqual(before);
      expect(resultCell.get()).toEqual({ marker: "v1" });
      const successor = serving.patternManager.getArtifactEntryRef(candidate)!;
      const tx = serving.edit();
      try {
        expect(
          tx.getCfcState().moduleDelegations.get(space)?.get(
            successor.identity,
          ),
        )
          .toBeUndefined();
      } finally {
        tx.abort();
      }
    } finally {
      serving.clearSealDestination();
      await serving.dispose();
      await servingStorage.close();
    }
  });

  it("runSyncedWithCommit issues a receipt while sealing when the caller asks for a direct commit", async () => {
    // A direct commit is the serving loop's own commit to the store, made
    // outside the wave, so its verdict is the store's and a receipt minted
    // from it claims nothing a withdrawal can undo. The runner's part is to
    // stamp the request and lift the refusal; the routing is the seal
    // destination's.
    const servingStorage = StorageManager.emulate({ as: signer });
    const serving = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: servingStorage,
      servingPosture: true,
      experimental: { serverExecution: true },
    });
    try {
      const resultCell = serving.getCell(
        space,
        "runSyncedWithCommit direct commit while sealing",
      );
      const initial = await compileReceiptPattern(serving, "v1");
      const candidate = await compileReceiptPattern(serving, "v2");
      await serving.runSynced(resultCell, initial, {});
      const before = receiptSourceSnapshot(serving, resultCell);
      const transition = await receiptSourceTransition(serving, resultCell);
      const stamped: Array<{
        tx: IExtendedStorageTransaction;
        actionId: string;
        directCommit?: boolean;
      }> = [];
      const sealed: IExtendedStorageTransaction[] = [];
      serving.installSealDestination({
        // The double commits the inner transaction to the store, which is
        // what the serving loop's direct commit does.
        seal: (tx: IExtendedStorageTransaction) => {
          sealed.push(tx);
          return tx.tx.commit();
        },
      }, {
        runStamper: (tx, info) => {
          stamped.push({
            tx,
            actionId: info.actionId,
            ...(info.directCommit === undefined
              ? {}
              : { directCommit: info.directCommit }),
          });
        },
      });

      const result = await serving.runSyncedWithCommit(
        resultCell,
        candidate,
        {},
        {
          expectedPatternIdentity: before.pattern,
          pieceSourceTransition: transition,
          directCommit: true,
          cfcTrustSnapshot: serving.trustSnapshotForPrincipal(
            "did:key:requester",
          ),
        },
      );
      const successor = serving.patternManager.getArtifactEntryRef(candidate)!;
      expect(result.commit.pattern).toEqual(successor);
      // The setup transaction reached the destination stamped as a direct
      // commit and carrying the requester's trust snapshot; the swap the
      // pointer write triggers stamps its own.
      const setup = stamped.find((stamp) => stamp.directCommit === true);
      expect(setup?.actionId).toBe(`piece-run-synced/${resultCell.sourceURI}`);
      expect(sealed).toContain(setup?.tx);
      expect(setup?.tx.getCfcState().trustSnapshot?.actingPrincipal).toBe(
        "did:key:requester",
      );
      expect(receiptSourceSnapshot(serving, resultCell).pattern).toEqual(
        successor,
      );
      // The update's authority registered from the committed transaction.
      expect(
        serving.grantsModuleDelegation(
          space,
          successor.identity,
          before.pattern.identity,
        ),
      ).toBe(true);
    } finally {
      serving.clearSealDestination();
      await serving.dispose();
      await servingStorage.close();
    }
  });

  it("runSyncedWithCommit leaves the piece unstarted when `start` is `false`", async () => {
    const resultCell = runtime.getCell(space, "runSyncedWithCommit no start");
    const initial = await compileReceiptPattern(runtime, "v1");
    const second = await compileReceiptPattern(runtime, "v2");
    const third = await compileReceiptPattern(runtime, "v3");
    await runtime.runSynced(resultCell, initial, {});
    const started: unknown[] = [];
    using _start = stub(runtime.runner, "start", (cell) => {
      started.push(cell);
      return Promise.resolve(true);
    });

    const unstarted = await runtime.runSyncedWithCommit(
      resultCell,
      second,
      {},
      {
        expectedPatternIdentity: receiptSourceSnapshot(runtime, resultCell)
          .pattern,
        pieceSourceTransition: await receiptSourceTransition(
          runtime,
          resultCell,
        ),
        start: false,
      },
    );
    expect(unstarted.commit.pattern).toEqual(
      runtime.patternManager.getArtifactEntryRef(second),
    );
    expect(receiptSourceSnapshot(runtime, resultCell).pattern).toEqual(
      unstarted.commit.pattern,
    );
    expect(started).toEqual([]);

    // Absent, the option keeps the start.
    await runtime.runSyncedWithCommit(resultCell, third, {}, {
      expectedPatternIdentity: unstarted.commit.pattern,
      pieceSourceTransition: await receiptSourceTransition(
        runtime,
        resultCell,
      ),
    });
    expect(started).toHaveLength(1);
  });

  it("runSynced refuses to grant update authority in a caller-owned transaction", async () => {
    const resultCell = runtime.getCell(space, "bound source authority");
    const initial = await compileReceiptPattern(runtime, "v1");
    const candidate = await compileReceiptPattern(runtime, "v2");
    await runtime.runSynced(resultCell, initial, {});
    const before = receiptSourceSnapshot(runtime, resultCell);
    const transition = await receiptSourceTransition(runtime, resultCell);
    const tx = runtime.edit();
    try {
      await expect(runtime.runSynced(resultCell.withTx(tx), candidate, {}, {
        expectedPatternIdentity: before.pattern,
        pieceSourceTransition: transition,
      })).rejects.toThrow(
        "source update authority requires an owned setup transaction",
      );
      expect(receiptSourceSnapshot(runtime, resultCell)).toEqual(before);
    } finally {
      tx.abort();
    }
    const successor = runtime.patternManager.getArtifactEntryRef(candidate)!;
    const storedTx = runtime.edit();
    try {
      expect(
        storedTx.getCfcState().moduleDelegations.get(space)?.get(
          successor.identity,
        ),
      ).toBeUndefined();
    } finally {
      storedTx.abort();
    }
  });

  it("runSyncedWithCommit refuses a result cell bound to an open transaction", async () => {
    // Writes staged in a transaction the caller still owns have no storage
    // verdict yet — the caller decides their fate — so there is nothing to
    // issue a receipt for. Refusing up front is what makes "resolved means
    // storage accepted it" true of every receipt this method returns.
    const pattern: Pattern = {
      argumentSchema: { type: "object", properties: {} },
      resultSchema: {},
      result: {},
      nodes: [],
    };
    const resultCell = runtime.getCell(
      space,
      "runSyncedWithCommit bound transaction",
    );
    const tx = runtime.edit();

    try {
      await expect(runtime.runSyncedWithCommit(
        resultCell.withTx(tx),
        trustExecutable(runtime, pattern),
        {},
        {
          expectedPatternIdentity: {
            identity: "of:fid1:expected",
            symbol: "default",
          },
          pieceSourceTransition: unreachableReceiptSourceTransition(),
        },
      )).rejects.toThrow("requires an unbound result cell");
    } finally {
      await tx.commit();
    }
  });

  it("runSyncedWithCommit rejects a commit storage refused", async () => {
    // The receipt's whole claim is that storage accepted the transaction, so
    // a rejected commit has to reach the caller as that rejection. Reported
    // through a resolved `{ error }` — the shape `editWithRetry` uses for a
    // refusal it did not throw — because a receipt path that treats it as
    // anything other than a failure would report success for a write storage
    // turned down.
    const pattern: Pattern = {
      argumentSchema: { type: "object", properties: {} },
      resultSchema: {},
      result: {},
      nodes: [],
    };
    const resultCell = runtime.getCell(
      space,
      "runSyncedWithCommit rejected commit",
    );
    const originalEditWithRetry = runtime.editWithRetry.bind(runtime);
    const failure = new Error("commit refused by storage");
    runtime.editWithRetry = (() => Promise.resolve({ error: failure })) as any;

    try {
      await expect(runtime.runSyncedWithCommit(
        resultCell,
        trustExecutable(runtime, pattern),
        {},
        {
          expectedPatternIdentity: {
            identity: "of:fid1:expected",
            symbol: "default",
          },
          pieceSourceTransition: unreachableReceiptSourceTransition(),
        },
      )).rejects.toThrow("commit refused by storage");
    } finally {
      runtime.editWithRetry = originalEditWithRetry;
    }
  });

  it("runSynced preserves its legacy error when post-commit work fails", async () => {
    const pattern = (marker: string): Pattern => ({
      argumentSchema: { type: "object", properties: {} },
      resultSchema: { type: "object", properties: {} },
      result: { marker },
      nodes: [],
    });
    const resultCell = runtime.getCell(
      space,
      "runSynced legacy post-commit error",
    );
    await runtime.runSynced(
      resultCell,
      trustExecutable(runtime, pattern("v1")),
      {},
    );
    const previous = receiptSourceSnapshot(runtime, resultCell).pattern;

    let syncCount = 0;
    runtime.runner.accessForTestingOnly.dependencySyncer = async (
      resultCell,
      executable,
      inputs,
      sync,
    ) => {
      syncCount++;
      if (syncCount === 2) {
        throw new Error("injected legacy post-commit failure");
      }
      return await sync(resultCell, executable, inputs);
    };

    try {
      await expect(runtime.runSynced(
        resultCell,
        trustExecutable(runtime, pattern("v2")),
        {},
        { expectedPatternIdentity: previous },
      )).rejects.toThrow("injected legacy post-commit failure");
    } finally {
      runtime.runner.accessForTestingOnly.dependencySyncer = undefined;
    }
  });

  it("setup rethrows callback failures from editWithRetry", async () => {
    const pattern: Pattern = {
      argumentSchema: {
        type: "object",
        properties: { input: { type: "number" } },
      },
      resultSchema: {},
      result: { output: { $alias: { partialCause: "output", path: [] } } },
      nodes: [],
    };

    const resultCell = runtime.getCell(space, "setup rethrows callback errors");
    const originalEditWithRetry = runtime.editWithRetry.bind(runtime);
    const thrown = new Error("boom");
    runtime.editWithRetry = (() =>
      Promise.resolve({
        error: {
          name: "StorageTransactionAborted" as const,
          message: `editWithRetry action threw: ${thrown}`,
          reason: thrown,
        },
      })) as typeof runtime.editWithRetry;

    try {
      await expect(runtime.setup(undefined, pattern, { input: 1 }, resultCell))
        .rejects.toThrow("boom");
    } finally {
      runtime.editWithRetry = originalEditWithRetry;
    }
  });

  it("setup with same pattern updates argument without restart", async () => {
    const pattern: Pattern = {
      argumentSchema: {
        type: "object",
        properties: { input: { type: "number" }, output: { type: "number" } },
      },
      resultSchema: {},
      result: { output: { $alias: { partialCause: "output", path: [] } } },
      nodes: [
        {
          module: { type: "passthrough" },
          inputs: { value: { $alias: { cell: "argument", path: ["input"] } } },
          outputs: {
            value: { $alias: { partialCause: "output", path: [] } },
          },
        },
      ],
    };

    const resultCell = runtime.getCell(space, "setup updates argument");
    setupTrusted(runtime, undefined, pattern, { input: 1 }, resultCell);
    runtime.start(resultCell);
    let cellValue = await resultCell.pull();
    expect(cellValue).toEqual({ output: 1 });

    // Update only via setup; scheduler should react to argument change
    setupTrusted(runtime, undefined, pattern, { input: 2 }, resultCell);
    cellValue = await resultCell.pull();
    expect(cellValue).toEqual({ output: 2 });
  });

  it("replays same-pattern opaque Cell arguments without validating payloads", async () => {
    const pattern: Pattern = {
      argumentSchema: {
        type: "object",
        properties: {
          myProfile: {
            type: "object",
            properties: { name: { type: "string" } },
            required: ["name"],
            asCell: ["cell"],
          },
        },
        required: ["myProfile"],
      },
      resultSchema: { type: "object", properties: {} },
      result: {},
      nodes: [],
    };
    const trusted = trustExecutable(runtime, pattern);
    const profile = runtime.getCell(space, "cold profile");
    const resultCell = runtime.getCell(space, "opaque replay result");

    await runtime.runSynced(resultCell, trusted, { myProfile: profile });
    // A hand-built (keyless) piece writes no durable pattern pointer (the
    // never-durable contract); the expected-identity guard resolves the
    // session mint through the runner's session-side map.
    expect(getPatternIdentityRef(resultCell)).toBeUndefined();
    const expectedPatternIdentity = runtime.patternManager.getArtifactEntryRef(
      trusted as unknown as object,
    );
    expect(expectedPatternIdentity).toBeDefined();

    // Both a live same-pattern update and a stopped-piece replay receive the
    // Cell handle itself. Its absent payload is not the argument value to
    // validate against the wrapped object schema.
    await expect(runtime.runSynced(
      resultCell,
      trusted,
      { myProfile: profile },
      { expectedPatternIdentity: expectedPatternIdentity! },
    )).resolves.toBeDefined();

    runtime.runner.stop(resultCell);
    await expect(runtime.runSynced(
      resultCell,
      trusted,
      { myProfile: profile },
      { expectedPatternIdentity: expectedPatternIdentity! },
    )).resolves.toBeDefined();
  });

  it("start is idempotent when called multiple times", async () => {
    const pattern: Pattern = {
      argumentSchema: {
        type: "object",
        properties: { input: { type: "number" } },
      },
      resultSchema: {},
      result: { output: { $alias: { partialCause: "output", path: [] } } },
      nodes: [
        {
          module: {
            type: "javascript",
            implementation: (v: { input: number }) => v.input,
          },
          inputs: { $alias: { cell: "argument", path: [] } },
          outputs: { $alias: { partialCause: "output", path: [] } },
        },
      ],
    };

    const resultCell = runtime.getCell(space, "start idempotent");
    setupTrusted(runtime, undefined, pattern, { input: 7 }, resultCell);
    runtime.start(resultCell);
    runtime.start(resultCell);

    let cellValue = await resultCell.pull();
    expect(cellValue).toEqual({ output: 7 });

    // Change input and ensure only a single recomputation occurs in effect
    setupTrusted(runtime, undefined, pattern, { input: 9 }, resultCell);
    cellValue = await resultCell.pull();
    expect(cellValue).toEqual({ output: 9 });
  });

  it("does not retain direct ownership after stop wins a start race", async () => {
    const pattern: Pattern = {
      argumentSchema: {
        type: "object",
        properties: { input: { type: "number" } },
      },
      resultSchema: {},
      result: { output: { $alias: { partialCause: "output", path: [] } } },
      nodes: [
        {
          module: {
            type: "javascript",
            implementation: (v: { input: number }) => v.input,
          },
          inputs: { $alias: { cell: "argument", path: [] } },
          outputs: { $alias: { partialCause: "output", path: [] } },
        },
      ],
    };

    const resultCell = runtime.getCell(space, "stopped direct start");
    setupTrusted(runtime, undefined, pattern, { input: 1 }, resultCell);
    await runtime.start(resultCell);

    // The redundant start resolves on the already-running fast path, so its
    // claim to a direct lifetime is decided by the bookkeeping that runs when
    // its promise settles — after the stop and the replacement run below.
    const redundantStart = runtime.start(resultCell);
    runtime.runner.stop(resultCell);
    runTrusted(runtime, undefined, pattern, { input: 2 }, resultCell);

    // The stop superseded the redundant start: it reports that it left
    // nothing running and claims no lifetime for the replacement's
    // registration.
    await expect(redundantStart).resolves.toBe(false);

    await resultCell.pull();
    const resultKey = entityKey(
      resultCell.getAsNormalizedFullLink(),
      runtime.scopeKeyIdentity,
    );
    expect(runtime.runner.cancels.has(resultKey)).toBe(true);
    runtime.runner.releaseChild(resultCell, undefined);
    expect(runtime.runner.cancels.has(resultKey)).toBe(false);
  });

  it("stop and restart works with setup/start", async () => {
    const pattern: Pattern = {
      argumentSchema: {
        type: "object",
        properties: { input: { type: "number" } },
      },
      resultSchema: {},
      result: { output: { $alias: { partialCause: "output", path: [] } } },
      nodes: [
        {
          module: {
            type: "javascript",
            implementation: (v: { input: number }) => v.input,
          },
          inputs: { $alias: { cell: "argument", path: [] } },
          outputs: { $alias: { partialCause: "output", path: [] } },
        },
      ],
    };

    const resultCell = runtime.getCell(space, "stop and restart");
    setupTrusted(runtime, undefined, pattern, { input: 1 }, resultCell);
    runtime.start(resultCell);
    let cellValue = await resultCell.pull();
    expect(cellValue).toEqual({ output: 1 });

    // Stop the scheduling
    runtime.runner.stop(resultCell);

    // Change argument via setup; without start nothing should recompute yet
    setupTrusted(runtime, undefined, pattern, { input: 5 }, resultCell);
    cellValue = await resultCell.pull();
    // Still the old output
    expect(cellValue).toEqual({ output: 1 });

    // Restart
    runtime.start(resultCell);
    cellValue = await resultCell.pull();
    expect(cellValue).toEqual({ output: 5 });
  });

  it("setup with Module wraps to pattern and runs on start", async () => {
    const mod = {
      type: "javascript" as const,
      implementation: (v: { input: number }) => ({ output: v.input * 3 }),
    };

    const resultCell = runtime.getCell(space, "setup with module");
    setupTrusted(
      runtime,
      undefined,
      mod as any,
      { input: 2 } as any,
      resultCell,
    );

    // Not started yet; no output
    let cellValue = await resultCell.pull();
    expect(cellValue).toEqual(undefined);

    runtime.start(resultCell);
    cellValue = await resultCell.pull();
    expect(cellValue).toEqual({ output: 6 });
  });

  it("setup without pattern reuses previous pattern", async () => {
    const pattern: Pattern = {
      argumentSchema: {
        type: "object",
        properties: { input: { type: "number" }, output: { type: "number" } },
      },
      resultSchema: {},
      result: { output: { $alias: { partialCause: "output", path: [] } } },
      nodes: [
        {
          module: { type: "passthrough" },
          inputs: { value: { $alias: { cell: "argument", path: ["input"] } } },
          outputs: {
            value: { $alias: { partialCause: "output", path: [] } },
          },
        },
      ],
    };

    const resultCell = runtime.getCell(space, "setup reuse previous pattern");
    setupTrusted(runtime, undefined, pattern, { input: 5 }, resultCell);
    runtime.start(resultCell);
    const cellValue = await resultCell.pull();
    expect(cellValue).toEqual({ output: 5 });

    // Stop and setup without specifying pattern; should reuse stored one
    runtime.runner.stop(resultCell);
    setupTrusted(
      runtime,
      undefined,
      undefined as any,
      { input: 10 } as any,
      resultCell,
    );
    // Not started yet; the result still aliases the reused pattern's
    // internals, so the fresh argument value is already visible through the
    // alias chain on read.
    const rawValue = resultCell.get();
    expect(rawValue).toMatchObjectIgnoringSymbols({ output: 10 });

    // A hand-built (keyless) pattern writes no durable pattern pointer (the
    // never-durable contract; L3(a), RULED 2026-08-27) — the reuse above
    // resolved through the runner's session-side pointer instead, which the
    // fresh-argument read and the restart below are the evidence for.
    const patternValue = resultCell.getMetaRaw("patternIdentity");
    expect(patternValue).toBeUndefined();

    // Also verify the argument metadata cell was updated
    await resultCell.pull();
    const argumentValue = runtime.getCellFromLink<{ input: number }>(
      getMetaLink(resultCell, "argument")!,
    ).get();
    expect(argumentValue.input).toEqual(10);

    // Start again (scheduling) just to ensure no errors
    runtime.start(resultCell);
    await resultCell.pull();
  });

  it("guards stored setup state when no argument was recorded", async () => {
    const resultCell = runtime.getCell(
      space,
      "stored setup argument absent result",
    );
    const guard = await runtime.runner.syncStoredSetupArgument(resultCell);

    expect(guard(resultCell)).toBe(true);

    const tx = runtime.edit();
    const argumentCell = runtime.getCell(
      space,
      "stored setup argument unexpected argument",
      undefined,
      tx,
    );
    argumentCell.set({ value: 1 });
    const candidate = runtime.getCell(
      space,
      "stored setup argument unexpected candidate",
      undefined,
      tx,
    );
    candidate.setMetaRaw(
      "argument",
      argumentCell.getAsWriteRedirectLink(),
      rawMetaWriteAuthorization,
    );

    expect(guard(candidate)).toBe(false);
    tx.abort();
  });

  it("guards the stored argument link, value, and linked targets", async () => {
    const setupTx = runtime.edit();
    const targetCell = runtime.getCell(
      space,
      "stored setup argument linked target",
      undefined,
      setupTx,
    );
    targetCell.set({ name: "Ada" });
    const argumentCell = runtime.getCell(
      space,
      "stored setup argument value",
      undefined,
      setupTx,
    );
    argumentCell.setRaw({
      profile: targetCell.getAsWriteRedirectLink(),
    });
    const resultCell = runtime.getCell(
      space,
      "stored setup argument result",
      undefined,
      setupTx,
    );
    resultCell.setMetaRaw(
      "argument",
      argumentCell.getAsWriteRedirectLink(),
      rawMetaWriteAuthorization,
    );
    await setupTx.commit();
    await runtime.idle();

    const guard = await runtime.runner.syncStoredSetupArgument(resultCell);
    expect(guard(resultCell)).toBe(true);

    const noLinkCandidate = runtime.getCell(
      space,
      "stored setup argument no link candidate",
    );
    expect(guard(noLinkCandidate)).toBe(false);

    const differentTx = runtime.edit();
    const differentArgument = runtime.getCell(
      space,
      "stored setup argument different value",
      undefined,
      differentTx,
    );
    differentArgument.set({ value: 2 });
    const differentCandidate = runtime.getCell(
      space,
      "stored setup argument different candidate",
      undefined,
      differentTx,
    );
    differentCandidate.setMetaRaw(
      "argument",
      differentArgument.getAsWriteRedirectLink(),
      rawMetaWriteAuthorization,
    );
    expect(guard(differentCandidate)).toBe(false);
    differentTx.abort();

    const changedTx = runtime.edit();
    argumentCell.withTx(changedTx).setRaw({
      profile: targetCell.getAsWriteRedirectLink(),
      changed: true,
    });
    expect(guard(resultCell.withTx(changedTx))).toBe(false);
    changedTx.abort();
  });

  it("keeps the stored-argument guard when a linked target does not sync", async () => {
    const setupTx = runtime.edit();
    const targetCell = runtime.getCell(
      space,
      "stored setup argument unavailable linked target",
      undefined,
      setupTx,
    );
    targetCell.set({ name: "Ada" });
    const argumentCell = runtime.getCell(
      space,
      "stored setup argument with unavailable target",
      undefined,
      setupTx,
    );
    argumentCell.setRaw({
      profile: targetCell.getAsWriteRedirectLink(),
    });
    const resultCell = runtime.getCell(
      space,
      "stored setup argument unavailable target result",
      undefined,
      setupTx,
    );
    resultCell.setMetaRaw(
      "argument",
      argumentCell.getAsWriteRedirectLink(),
      rawMetaWriteAuthorization,
    );
    await setupTx.commit();
    await runtime.idle();

    const originalSyncCell = runtime.storageManager.syncCell;
    const targetLink = targetCell.getAsNormalizedFullLink();
    let targetSyncs = 0;
    Reflect.set(runtime.storageManager, "syncCell", (cell: unknown) => {
      const linkedCell = cell as typeof targetCell;
      if (
        areNormalizedLinksSame(
          linkedCell.getAsNormalizedFullLink(),
          targetLink,
        )
      ) {
        targetSyncs++;
        return Promise.reject(new Error("linked target unavailable"));
      }
      return Reflect.apply(originalSyncCell, runtime.storageManager, [cell]);
    });

    try {
      const guard = await runtime.runner.syncStoredSetupArgument(resultCell);
      expect(targetSyncs).toBe(1);
      expect(guard(resultCell)).toBe(true);
    } finally {
      Reflect.set(runtime.storageManager, "syncCell", originalSyncCell);
    }
  });

  it("setup with cell argument and start reacts to cell updates", async () => {
    const pattern: Pattern = {
      argumentSchema: {
        type: "object",
        properties: { input: { type: "number" }, output: { type: "number" } },
      },
      resultSchema: {},
      result: { output: { $alias: { cell: "argument", path: ["output"] } } },
      nodes: [
        {
          module: {
            type: "javascript",
            implementation: (value: number) => value * 2,
          },
          inputs: { $alias: { cell: "argument", path: ["input"] } },
          outputs: { $alias: { cell: "argument", path: ["output"] } },
        },
      ],
    };

    const tx = runtime.edit();
    const inputCell = runtime.getCell<{ input: number; output: number }>(
      space,
      "setup with cell arg: input",
      undefined,
      tx,
    );
    inputCell.set({ input: 3, output: 0 });
    await tx.commit();

    const resultCell = runtime.getCell(space, "setup with cell arg");
    setupTrusted(runtime, undefined, pattern, inputCell, resultCell);
    runtime.start(resultCell);
    let cellValue = await resultCell.pull();
    expect(cellValue).toEqual({ output: 6 });

    const tx2 = runtime.edit();
    inputCell.withTx(tx2).send({ input: 4, output: 0 });
    await tx2.commit();
    cellValue = await resultCell.pull();
    expect(cellValue).toEqual({ output: 8 });
  });

  it("checks an expected pattern identity on transaction-bound cells", async () => {
    const pattern: Pattern = {
      argumentSchema: {
        type: "object",
        properties: { input: { type: "number" } },
      },
      resultSchema: {
        type: "object",
        properties: { input: { type: "number" } },
      },
      result: { input: { $alias: { cell: "argument", path: ["input"] } } },
      derivedInternalCells: [],
      nodes: [],
    };
    const trusted = trustExecutable(runtime, pattern);
    const resultCell = runtime.getCell(space, "tx-bound-expected-identity");
    await runtime.runSynced(resultCell, trusted, { input: 1 });
    runtime.runner.stop(resultCell);
    const boundTx = runtime.edit();
    // The piece is keyless: no durable pointer (never-durable contract). Its
    // current identity is the session mint on the pattern object, and the
    // expected-identity guard resolves it through the runner's session map.
    expect(getPatternIdentityRef(resultCell)).toBeUndefined();
    const currentIdentity = runtime.patternManager.getArtifactEntryRef(
      trusted as unknown as object,
    );
    expect(currentIdentity).toBeDefined();

    try {
      await expect(runtime.runSynced(
        resultCell.withTx(boundTx),
        trusted,
        { input: 2 },
        {
          expectedPatternIdentity: {
            identity: "of:fid1:stale",
            symbol: "default",
          },
        },
      )).rejects.toThrow(
        /pattern changed while the source update was compiling/,
      );

      await runtime.runSynced(
        resultCell.withTx(boundTx),
        trusted,
        { input: 2 },
        { expectedPatternIdentity: currentIdentity! },
      );
      expect(runtime.runner.cancels.size).toBe(1);
    } finally {
      await boundTx.commit();
    }
  });

  it("rethrows post-setup failures when writes remain transaction-bound", async () => {
    const pattern: Pattern = {
      argumentSchema: { type: "object", properties: {} },
      resultSchema: { type: "object", properties: {} },
      result: {},
      nodes: [],
    };
    const trusted = trustExecutable(runtime, pattern);
    const resultCell = runtime.getCell(
      space,
      "transaction-bound post-setup failure",
    );
    await runtime.runSynced(resultCell, trusted, {});
    const currentIdentity = receiptSourceSnapshot(runtime, resultCell).pattern;

    const boundTx = runtime.edit();
    let syncCount = 0;
    runtime.runner.accessForTestingOnly.dependencySyncer = async (
      resultCell,
      executable,
      inputs,
      sync,
    ) => {
      syncCount++;
      if (syncCount === 2) {
        throw new Error("transaction-bound post-setup failure");
      }
      return await sync(resultCell, executable, inputs);
    };

    try {
      await expect(runtime.runSynced(
        resultCell.withTx(boundTx),
        trusted,
        {},
        { expectedPatternIdentity: currentIdentity },
      )).rejects.toThrow("transaction-bound post-setup failure");
    } finally {
      runtime.runner.accessForTestingOnly.dependencySyncer = undefined;
      boundTx.abort();
    }
  });
});

describe("runner utils", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    // Create runtime with the shared storage provider
    // We need to bypass the URL-based configuration for this test
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("accepts opaque cells only for matching schema wrappers", () => {
    const cell = runtime.getCell(space, "opaque-cell");
    const stream = runtime.getCell(space, "opaque-stream", {
      type: "number",
      asCell: ["stream"],
    });

    expect(schemaAcceptsOpaqueCellValue(cell, { asCell: ["cell"] })).toBe(
      true,
    );
    expect(schemaAcceptsOpaqueCellValue(stream, { asCell: ["stream"] })).toBe(
      true,
    );
    expect(schemaAcceptsOpaqueCellValue(stream, { asCell: ["cell"] })).toBe(
      false,
    );
    expect(schemaAcceptsOpaqueCellValue(cell, {
      asCell: [{ kind: "cell", scope: undefined }],
      scope: undefined,
    })).toBe(true);
    expect(schemaAcceptsOpaqueCellValue({}, { asCell: ["cell"] })).toBe(false);
    const nonEnumerableKind = {};
    Object.defineProperty(nonEnumerableKind, "kind", { value: "cell" });
    const nonEnumerableScope = { kind: "cell" };
    Object.defineProperty(nonEnumerableScope, "scope", { value: "session" });
    const inheritedAsCell = Object.assign(
      Object.create({ asCell: ["cell"] }),
      { type: "number" },
    );
    const nonEnumerableAsCell = { type: "number" };
    Object.defineProperty(nonEnumerableAsCell, "asCell", {
      value: ["cell"],
    });
    const inheritedSchemaScope = Object.assign(
      Object.create({ scope: "session" }),
      { type: "number", asCell: ["cell"] },
    );
    const nonEnumerableSchemaScope = { type: "number", asCell: ["cell"] };
    Object.defineProperty(nonEnumerableSchemaScope, "scope", {
      value: "session",
    });
    const observedAccessorKinds: string[] = [];
    const accessorAsCell = ["stream"];
    Object.defineProperty(accessorAsCell, 0, {
      enumerable: true,
      get: () => {
        const kind = observedAccessorKinds.length === 0 ? "stream" : "cell";
        observedAccessorKinds.push(kind);
        return kind;
      },
    });
    const malformedWrappers = [
      { type: "number", asCell: [] },
      { type: "number", asCell: "cell" },
      { type: "number", asCell: ["bogus"] },
      { type: "number", asCell: ["cell", "bogus"] },
      {
        type: "number",
        asCell: [{ kind: "cell" }, { kind: "bogus" }],
      },
      { type: "number", asCell: [{ kind: "cell", scope: "bogus" }] },
      { type: "number", asCell: [Object.create({ kind: "cell" })] },
      {
        type: "number",
        asCell: [
          Object.assign(Object.create({ scope: "session" }), { kind: "cell" }),
        ],
      },
      { type: "number", asCell: [nonEnumerableKind] },
      { type: "number", asCell: [nonEnumerableScope] },
      inheritedAsCell,
      nonEnumerableAsCell,
      inheritedSchemaScope,
      nonEnumerableSchemaScope,
      { type: "number", asCell: accessorAsCell },
      { type: "number", asCell: ["cell"], scope: "bogus" },
    ] as unknown as JSONSchema[];
    for (const schema of malformedWrappers) {
      expect(schemaAcceptsOpaqueCellValue(cell, schema)).toBe(false);
      expect(validateSchemaValue(schema, cell, schema, {
        acceptOpaqueValue: schemaAcceptsOpaqueCellValue,
      })).toBeDefined();
    }
    expect(observedAccessorKinds).toEqual([]);
  });

  it("reads the identity installed by completed setup", () => {
    const resultCell = runtime.getCell(
      space,
      "completed setup identity",
      undefined,
      tx,
    );

    expect(getPatternSetupIdentityRef(resultCell)).toBeUndefined();

    resultCell.setMetaRaw("patternSetupIdentity", {
      identity: "pattern-identity",
      symbol: "main",
    }, rawMetaWriteAuthorization);
    expect(getPatternSetupIdentityRef(resultCell)).toEqual({
      identity: "pattern-identity",
      symbol: "main",
    });

    resultCell.setMetaRaw("patternSetupIdentity", {
      identity: 42,
      symbol: "main",
    }, rawMetaWriteAuthorization);
    expect(getPatternSetupIdentityRef(resultCell)).toBeUndefined();
  });

  describe("extractDefaultValues", () => {
    it("should extract default values from a schema", () => {
      const schema = {
        type: "object" as const,
        properties: {
          name: { type: "string" as const, default: "John" },
          age: { type: "number" as const, default: 30 },
          address: {
            type: "object" as const,
            properties: {
              street: { type: "string" as const, default: "Main St" },
              city: { type: "string" as const, default: "New York" },
            },
          },
        },
      };

      const result = extractDefaultValues(schema);
      expect(result).toEqual({
        name: "John",
        age: 30,
        address: {
          street: "Main St",
          city: "New York",
        },
      });
    });

    it("resolves defaults behind local refs without recursing forever", () => {
      const schema: JSONSchema = {
        type: "object",
        properties: {
          options: { $ref: "#/$defs/Options" },
        },
        $defs: {
          Options: {
            type: "object",
            properties: {
              attempts: { type: "number", default: 1 },
              next: { $ref: "#/$defs/Options" },
            },
          },
        },
      };

      expect(extractDefaultValues(schema)).toEqual({
        options: { attempts: 1 },
      });
    });

    it("returns no defaults for non-object and unresolved schemas", () => {
      expect(extractDefaultValues(false)).toBeUndefined();
      expect(extractDefaultValues({ $ref: "#/$defs/Missing" }))
        .toBeUndefined();
    });

    it("keeps the owning root while traversing embedded schema refs", () => {
      const warn = stub(console, "warn", () => {});
      try {
        expect(extractDefaultValues({
          type: "object",
          properties: {
            $UI: { $ref: "https://commonfabric.org/schemas/vnode.json" },
          },
        })).toBeUndefined();
        expect(warn.calls).toHaveLength(0);
      } finally {
        warn.restore();
      }
    });

    it("reads a nested ref's default from the document's map, not the subtree's own `$defs`", () => {
      const schema: JSONSchema = {
        type: "object",
        properties: {
          nested: {
            type: "object",
            properties: { value: { $ref: "#/$defs/Value" } },
            $defs: {
              Value: { type: "string", default: "local" },
            },
          },
        },
        $defs: {
          Value: { type: "number", default: 1 },
        },
      };

      expect(extractDefaultValues(schema)).toEqual({
        nested: { value: 1 },
      });
    });

    it("extracts defaults from object-containing extended unions", () => {
      expect(extractDefaultValues({
        type: ["object", "undefined"],
        properties: { x: { type: "number", default: 1 } },
        required: ["x"],
      })).toEqual({ x: 1 });

      expect(extractDefaultValues({
        anyOf: [
          { type: "undefined" },
          {
            type: "object",
            properties: { x: { type: "number", default: 1 } },
            required: ["x"],
          },
        ],
      })).toEqual({ x: 1 });
    });

    it("returns no default unless the candidate satisfies the full schema", () => {
      const duplicateOneOf: JSONSchema = {
        oneOf: [
          {
            type: "object",
            properties: { x: { type: "number", default: 1 } },
            required: ["x"],
          },
          {
            type: "object",
            properties: { x: { type: "number", default: 1 } },
            required: ["x"],
          },
        ],
      };
      const baseConflict: JSONSchema = {
        type: "undefined",
        anyOf: [{
          type: "object",
          properties: { x: { type: "number", default: 1 } },
          required: ["x"],
        }],
      };

      expect(extractDefaultValues(duplicateOneOf)).toBeUndefined();
      expect(extractDefaultValues(baseConflict)).toBeUndefined();
    });

    it("combines defaults across simultaneous union families", () => {
      const schema: JSONSchema = {
        type: "object",
        anyOf: [{
          type: "object",
          properties: { fromAny: { type: "number", default: 1 } },
          required: ["fromAny"],
        }],
        oneOf: [{
          type: "object",
          properties: { fromOne: { type: "number", default: 2 } },
          required: ["fromOne"],
        }],
      };

      expect(extractDefaultValues(schema)).toEqual({
        fromAny: 1,
        fromOne: 2,
      });
    });

    it("preserves explicit undefined while combining union defaults", () => {
      const schema: JSONSchema = {
        type: "object",
        anyOf: [{
          type: "object",
          properties: {
            x: { type: "undefined", default: undefined },
          },
          required: ["x"],
        }],
        oneOf: [{
          type: "object",
          properties: { y: { type: "number", default: 2 } },
          required: ["y"],
        }],
      };

      const defaults = extractDefaultValues(schema) as
        | Record<string, unknown>
        | undefined;
      expect(schemaHasDefaultValue(schema)).toBe(true);
      expect(defaults).toBeDefined();
      expect(Object.hasOwn(defaults!, "x")).toBe(true);
      expect(defaults!.x).toBeUndefined();
      expect(defaults!.y).toBe(2);
      expect(validateSchemaValue(schema, defaults)).toBeUndefined();
    });

    it("preserves explicit empty, non-object, and undefined defaults", () => {
      const noDefault: JSONSchema = {
        type: "object",
        properties: {},
      };
      expect(extractDefaultValues(noDefault)).toBeUndefined();
      expect(schemaHasDefaultValue(noDefault)).toBe(false);
      expect(extractDefaultValues({
        type: "object",
        properties: {},
        default: {},
      })).toEqual({});
      expect(extractDefaultValues({
        type: ["object", "null"],
        properties: {},
        default: null,
      })).toBeNull();

      const undefinedDefault: JSONSchema = {
        type: "undefined",
        default: undefined,
      };
      expect(extractDefaultValues(undefinedDefault)).toBeUndefined();
      expect(schemaHasDefaultValue(undefinedDefault)).toBe(true);
      const parentDefaults = extractDefaultValues({
        type: "object",
        properties: { value: undefinedDefault },
        required: ["value"],
      }) as Record<string, unknown>;
      expect(Object.hasOwn(parentDefaults, "value")).toBe(true);
      expect(parentDefaults.value).toBeUndefined();
    });
  });

  describe("mergeObjects", () => {
    it("should merge multiple objects", () => {
      const obj1 = { a: 1, b: { x: 10 } };
      const obj2 = { b: { y: 20 }, c: 3 };
      const obj3 = { a: 4, d: 5 };

      const result = mergeObjects<unknown>(obj1, obj2, obj3);
      expect(result).toEqual({
        a: 1,
        b: { x: 10, y: 20 },
        c: 3,
        d: 5,
      });
    });

    it("should handle undefined values", () => {
      const obj1 = { a: 1 };
      const obj2 = undefined;
      const obj3 = { b: 2 };

      const result = mergeObjects<unknown>(obj1, obj2, obj3);
      expect(result).toEqual({ a: 1, b: 2 });
    });

    it("should give precedence to earlier objects in the case of a conflict", () => {
      const obj1 = { a: 1 };
      const obj2 = { a: 2, b: { c: 3 } };
      const obj3 = { a: 3, b: { c: 4 } };

      const result = mergeObjects(obj1, obj2, obj3);
      expect(result).toEqual({ a: 1, b: { c: 3 } });
    });

    it("should treat cell aliases and references as values", () => {
      const testCell = runtime.getCell<{ a: any }>(
        space,
        "should treat cell aliases and references as values 1",
        undefined,
        tx,
      );
      const redirect = testCell.key("a").getAsWriteRedirectLink();
      const obj1 = { a: redirect };
      const obj2 = { a: 2, b: { c: testCell.getAsLink() } };
      const obj3 = {
        a: testCell.getAsWriteRedirectLink(),
        b: { c: 4 },
      };

      const result = mergeObjects<unknown>(obj1, obj2, obj3);
      expect(result).toEqual({
        a: redirect,
        b: { c: testCell.getAsLink() },
      });
    });
  });

  describe("mergeSchemaDefaults", () => {
    const schema: JSONSchema = {
      type: "object",
      properties: {
        options: { $ref: "#/$defs/Options" },
        requiredOptions: { $ref: "#/$defs/Options" },
      },
      required: ["requiredOptions"],
      $defs: {
        Options: {
          type: "object",
          properties: {
            attempts: { type: "number", default: 1 },
            name: { type: "string" },
          },
          required: ["name"],
        },
      },
    };
    const defaults = {
      options: { attempts: 1 },
      requiredOptions: { attempts: 1 },
    };

    it("skips invalid optional partial objects but retains required defaults", () => {
      expect(mergeSchemaDefaults<Record<string, unknown>>(
        {},
        defaults,
        schema,
      )).toEqual({
        requiredOptions: { attempts: 1 },
      });
    });

    it("merges nested defaults when existing values complete the object", () => {
      expect(mergeSchemaDefaults<Record<string, unknown>>(
        {
          options: { name: "safe" },
          requiredOptions: { name: "required" },
        },
        defaults,
        schema,
      )).toEqual({
        options: { name: "safe", attempts: 1 },
        requiredOptions: { name: "required", attempts: 1 },
      });
    });

    it("preserves explicitly present undefined values", () => {
      const value = mergeSchemaDefaults<Record<string, unknown>>(
        { value: undefined },
        { value: "fallback" },
        {
          type: "object",
          properties: {
            value: { type: ["string", "undefined"] },
          },
          required: ["value"],
        },
      );

      expect(Object.hasOwn(value, "value")).toBe(true);
      expect(value.value).toBeUndefined();
    });

    it("preserves explicitly present undefined values in object type unions", () => {
      const value = mergeSchemaDefaults<Record<string, unknown>>(
        { value: undefined },
        { value: "fallback" },
        {
          type: ["object", "undefined"],
          properties: {
            value: { type: ["string", "undefined"] },
          },
        },
      );

      expect(Object.hasOwn(value, "value")).toBe(true);
      expect(value.value).toBeUndefined();
    });

    it("preserves explicitly present undefined values in anyOf objects", () => {
      const value = mergeSchemaDefaults<Record<string, unknown>>(
        { value: undefined },
        { value: "fallback" },
        {
          anyOf: [
            {
              type: "object",
              properties: {
                value: { type: ["string", "undefined"] },
              },
            },
            { type: "undefined" },
          ],
        },
      );

      expect(Object.hasOwn(value, "value")).toBe(true);
      expect(value.value).toBeUndefined();
    });

    it("does not splice a default from another anyOf variant", () => {
      const schema: JSONSchema = {
        anyOf: [
          {
            type: "object",
            properties: { kind: { const: "A" } },
            required: ["kind"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              kind: { const: "B" },
              x: { type: "number" },
            },
            required: ["kind", "x"],
            additionalProperties: false,
          },
        ],
        default: { kind: "B", x: 1 },
      };
      const existing = { kind: "A" };
      const value = mergeSchemaDefaults<Record<string, unknown>>(
        existing,
        { kind: "B", x: 1 },
        schema,
      );

      expect(value).toEqual(existing);
      expect(validateSchemaValue(schema, value)).toBeUndefined();
    });

    it("hydrates explicit object defaults into present union values", () => {
      const unionSchema: JSONSchema = {
        type: "object",
        default: { kind: "a", x: 1 },
        anyOf: [
          {
            type: "object",
            properties: {
              kind: { const: "a" },
              x: { type: "number" },
            },
            required: ["kind", "x"],
          },
          {
            type: "object",
            properties: { kind: { const: "b" } },
            required: ["kind"],
          },
        ],
      };
      const typeArraySchema: JSONSchema = {
        type: ["object", "undefined"],
        properties: { x: { type: "number" } },
        required: ["x"],
        default: { x: 2 },
      };

      const unionValue = mergeSchemaDefaults(
        {},
        extractDefaultValues(unionSchema),
        unionSchema,
      );
      const typeArrayValue = mergeSchemaDefaults(
        {},
        extractDefaultValues(typeArraySchema),
        typeArraySchema,
      );

      expect(unionValue).toEqual({ kind: "a", x: 1 });
      expect(validateSchemaValue(unionSchema, unionValue)).toBeUndefined();
      expect(typeArrayValue).toEqual({ x: 2 });
      expect(validateSchemaValue(typeArraySchema, typeArrayValue))
        .toBeUndefined();
    });

    it("hydrates defaults from the anyOf branch matching existing state", () => {
      const schema: JSONSchema = {
        anyOf: [
          { type: "undefined" },
          {
            type: "object",
            properties: { x: { type: "number", default: 1 } },
            required: ["x"],
          },
        ],
      };
      const value = mergeSchemaDefaults<Record<string, unknown>>(
        {},
        extractDefaultValues(schema),
        schema,
      );

      expect(value).toEqual({ x: 1 });
      expect(validateSchemaValue(schema, value)).toBeUndefined();
    });

    it("combines defaults required by simultaneous anyOf and oneOf", () => {
      const schema: JSONSchema = {
        type: "object",
        anyOf: [{
          type: "object",
          properties: { fromAny: { type: "number", default: 1 } },
          required: ["fromAny"],
        }],
        oneOf: [{
          type: "object",
          properties: { fromOne: { type: "number", default: 2 } },
          required: ["fromOne"],
        }],
      };

      const value = mergeSchemaDefaults({}, undefined, schema);

      expect(value).toEqual({ fromAny: 1, fromOne: 2 });
      expect(validateSchemaValue(schema, value)).toBeUndefined();
    });

    it("hydrates defaults through present arrays and dynamic object fields", () => {
      const itemSchema: JSONSchema = {
        anyOf: [
          {
            type: "object",
            properties: { attempts: { type: "number", default: 1 } },
            required: ["attempts"],
          },
          { type: "undefined" },
        ],
      };
      const sparse = [{}, , undefined];
      const arrayValue = mergeSchemaDefaults(
        sparse,
        undefined,
        { type: "array", items: itemSchema },
      ) as unknown[];

      expect(arrayValue[0]).toEqual({ attempts: 1 });
      expect(Object.hasOwn(arrayValue, 1)).toBe(false);
      expect(Object.hasOwn(arrayValue, 2)).toBe(true);
      expect(arrayValue[2]).toBeUndefined();

      const unionArrayValue = mergeSchemaDefaults(
        [{}],
        undefined,
        { type: ["array", "undefined"], items: itemSchema },
      );
      expect(unionArrayValue).toEqual([{ attempts: 1 }]);

      const dynamicValue = mergeSchemaDefaults(
        { extra: {}, xPattern: {} },
        undefined,
        {
          type: ["object", "undefined"],
          patternProperties: { "^x": itemSchema },
          additionalProperties: itemSchema,
        },
      );
      expect(dynamicValue).toEqual({
        extra: { attempts: 1 },
        xPattern: { attempts: 1 },
      });
    });

    it("terminates on cyclic values under recursive schemas", () => {
      const value: { self?: unknown } = {};
      value.self = value;
      const schema: JSONSchema = {
        $ref: "#/$defs/Node",
        $defs: {
          Node: {
            type: "object",
            properties: { self: { $ref: "#/$defs/Node" } },
          },
        },
      };

      expect(mergeSchemaDefaults(value, undefined, schema)).toBe(value);
    });

    it("merges shared base defaults before selecting a union branch", () => {
      const schema: JSONSchema = {
        type: "object",
        properties: {
          shared: { type: "number", default: 1 },
        },
        anyOf: [
          {
            type: "object",
            properties: { kind: { const: "a" } },
            required: ["kind"],
          },
          {
            type: "object",
            properties: { kind: { const: "b" } },
            required: ["kind"],
          },
        ],
      };
      const defaults = extractDefaultValues(schema);

      expect(mergeSchemaDefaults({ kind: "a" }, defaults, schema)).toEqual({
        kind: "a",
        shared: 1,
      });

      const invalid = { kind: "other" };
      expect(mergeSchemaDefaults(invalid, defaults, schema)).toBe(invalid);
    });

    it("uses full-context acceptance to disambiguate union defaults", () => {
      const schema: JSONSchema = {
        anyOf: [
          {
            type: "object",
            properties: { attempts: { type: "number", default: 1 } },
            required: ["attempts"],
          },
          {
            type: "object",
            properties: { retries: { type: "number", default: 2 } },
            required: ["retries"],
          },
        ],
      };

      expect(mergeSchemaDefaults({}, undefined, schema, {
        acceptUnionCandidate: (candidate) =>
          Object.hasOwn(candidate as object, "attempts"),
      })).toEqual({ attempts: 1 });
    });

    it("compares identical unsupported union candidates defensively", () => {
      const marker = () => "opaque";
      const value = { marker };
      const schema: JSONSchema = {
        anyOf: [
          { type: "object" },
          { type: "object" },
        ],
      };

      expect(mergeSchemaDefaults(value, undefined, schema)).toBe(value);
    });

    it("keeps a non-object type-union default while hydrating present objects", () => {
      const schema: JSONSchema = {
        type: ["object", "null"],
        properties: { x: { type: "number", default: 1 } },
        required: ["x"],
        default: null,
      };

      expect(extractDefaultValues(schema)).toBeNull();
      expect(mergeSchemaDefaults(undefined, null, schema)).toBeNull();
      expect(mergeSchemaDefaults<Record<string, unknown>>(
        {},
        null,
        schema,
      )).toEqual({ x: 1 });
    });

    it("does not throw while comparing opaque union candidates", () => {
      class Opaque {
        self: Opaque = this;
      }
      const schema: JSONSchema = {
        anyOf: [
          {
            type: "object",
            properties: { x: { type: "number", default: 1 } },
          },
          {
            type: "object",
            properties: { x: { type: "number", default: 1 } },
          },
        ],
      };
      const value = { opaque: new Opaque() };

      expect(() => mergeSchemaDefaults(value, undefined, schema)).not
        .toThrow();
      expect(mergeSchemaDefaults(value, undefined, schema)).toEqual({
        opaque: value.opaque,
        x: 1,
      });
    });

    it("validates a nested default against the document's definition, not the subtree's own `$defs`", () => {
      const schema: JSONSchema = {
        type: "object",
        properties: {
          nested: {
            type: "object",
            properties: { value: { $ref: "#/$defs/Value" } },
            $defs: { Value: { type: "string" } },
          },
        },
        $defs: { Value: { type: "number" } },
      };

      expect(mergeSchemaDefaults<Record<string, unknown>>(
        { nested: {} },
        { nested: { value: "local" } },
        schema,
      )).toEqual({ nested: {} });
      expect(mergeSchemaDefaults<Record<string, unknown>>(
        { nested: {} },
        { nested: { value: 2 } },
        schema,
      )).toEqual({ nested: { value: 2 } });
    });

    it("reads a definition body's default from the document's map, not the body's own `$defs`", () => {
      const schema: JSONSchema = {
        type: "object",
        properties: { item: { $ref: "#/$defs/Entry" } },
        $defs: {
          Entry: {
            type: "object",
            properties: { value: { $ref: "#/$defs/Value" } },
            required: ["value"],
            $defs: {
              Value: { type: "string", default: "local" },
            },
          },
          Value: { type: "number", default: 1 },
        },
      };

      expect(extractDefaultValues(schema)).toEqual({
        item: { value: 1 },
      });
    });

    it("does not treat inherited names as existing argument values", () => {
      const value = mergeSchemaDefaults<Record<string, unknown>>(
        {},
        { toString: 1 },
        {
          type: "object",
          properties: { toString: { type: "number" as const } },
        },
      );

      expect(Object.hasOwn(value, "toString")).toBe(true);
      expect(value.toString).toBe(1);
    });

    it("falls back to ordinary object merging for non-object schemas", () => {
      expect(mergeSchemaDefaults<Record<string, unknown>>(
        { existing: true },
        { added: true },
        true,
      )).toEqual({ existing: true, added: true });
    });
  });

  describe("start() lazy sync behavior", () => {
    it("start() returns Promise<boolean> that resolves to true", async () => {
      const pattern: Pattern = {
        argumentSchema: {
          type: "object",
          properties: { input: { type: "number" } },
        },
        resultSchema: {},
        result: { output: { $alias: { partialCause: "output", path: [] } } },
        nodes: [
          {
            module: {
              type: "javascript",
              implementation: (v: { input: number }) => v.input * 2,
            },
            inputs: { $alias: { cell: "argument", path: [] } },
            outputs: { $alias: { partialCause: "output", path: [] } },
          },
        ],
      };

      const resultCell = runtime.getCell(space, "start returns promise");
      setupTrusted(runtime, undefined, pattern, { input: 5 }, resultCell);
      const result = await runtime.start(resultCell);
      expect(result).toBe(true);
      await resultCell.pull();
      await runtime.idle();
      expect(resultCell.getAsQueryResult()).toEqual({ output: 10 });
    });

    it("start() returns true immediately if already running", async () => {
      const pattern: Pattern = {
        argumentSchema: {
          type: "object",
          properties: { input: { type: "number" } },
        },
        resultSchema: {},
        result: { output: { $alias: { partialCause: "output", path: [] } } },
        nodes: [
          {
            module: {
              type: "javascript",
              implementation: (v: { input: number }) => v.input,
            },
            inputs: { $alias: { cell: "argument", path: [] } },
            outputs: { $alias: { partialCause: "output", path: [] } },
          },
        ],
      };

      const resultCell = runtime.getCell(space, "start idempotent");
      setupTrusted(runtime, undefined, pattern, { input: 1 }, resultCell);
      await runtime.start(resultCell);
      await runtime.idle();

      // Second call should return true immediately
      const result = await runtime.start(resultCell);
      expect(result).toBe(true);
    });

    it("does not register duplicate handlers while resumed dependencies sync", async () => {
      const valueAlias = {
        $alias: {
          cell: "argument",
          path: ["value"],
          scope: "space",
          schema: { type: "number", default: 0 },
        },
      };
      const streamAlias = {
        $alias: {
          partialCause: { stream: "increment" },
          path: [],
          scope: "space",
          schema: true,
        },
      };
      const pattern: Pattern = {
        argumentSchema: {
          type: "object",
          properties: {
            value: {
              type: "number",
              default: 0,
              asCell: ["cell"],
            },
          },
        },
        resultSchema: {
          type: "object",
          properties: {
            value: { type: "number" },
            increment: { asCell: ["stream", "opaque"] },
          },
        },
        derivedInternalCells: [
          {
            partialCause: { stream: "increment" },
            schema: { default: { $stream: true } },
            scope: "space",
          },
        ],
        result: {
          value: valueAlias,
          increment: streamAlias,
        },
        nodes: [
          {
            module: {
              type: "javascript",
              wrapper: "handler",
              argumentSchema: {
                type: "object",
                properties: {
                  $event: false,
                  $ctx: {
                    type: "object",
                    properties: {
                      value: {
                        type: "number",
                        asCell: ["cell"],
                      },
                    },
                    required: ["value"],
                  },
                },
                required: ["$ctx"],
              },
              implementation: (_event: unknown, { value }: any) => {
                value.set(value.get() + 1);
              },
            },
            inputs: {
              $ctx: { value: valueAlias },
              $event: streamAlias,
            },
            outputs: {},
          },
        ],
      };

      const resultCell = runtime.getCell<any>(
        space,
        "concurrent start dedupe",
      );
      await setupTrusted(runtime, undefined, pattern, { value: 0 }, resultCell);

      // Simulate a persisted piece being resumed. In that path start() syncs
      // dependencies before registering handlers, which is where this race
      // used to allow duplicate starts for the same result cell.
      runtime.runner.accessForTestingOnly.locallyPreparedResults.clear();

      let dependencySyncRuns = 0;
      runtime.runner.accessForTestingOnly.dependencySyncer = async (
        resultCell,
        executable,
        inputs,
        sync,
      ) => {
        dependencySyncRuns++;
        await clock.settle();
        return sync(resultCell, executable, inputs);
      };

      try {
        const [first, second] = await Promise.all([
          runtime.start(resultCell),
          runtime.start(resultCell),
        ]);
        expect(first).toBe(true);
        expect(second).toBe(true);
        // The second start joins the first attempt, so the dependency
        // pre-sync — the expensive phase concurrent starts used to repeat —
        // runs once for the pair.
        expect(dependencySyncRuns).toBe(1);

        resultCell.key("increment").send();
        await runtime.idle();
        await resultCell.pull();

        expect(resultCell.key("value").get()).toBe(1);
      } finally {
        runtime.runner.accessForTestingOnly.dependencySyncer = undefined;
      }
    });

    it("start() runs synchronously when data is available", async () => {
      const pattern: Pattern = {
        argumentSchema: {
          type: "object",
          properties: { input: { type: "number" } },
        },
        resultSchema: {},
        result: { output: { $alias: { partialCause: "output", path: [] } } },
        nodes: [
          {
            module: {
              type: "javascript",
              implementation: (v: { input: number }) => v.input * 3,
            },
            inputs: { $alias: { cell: "argument", path: [] } },
            outputs: { $alias: { partialCause: "output", path: [] } },
          },
        ],
      };

      const resultCell = runtime.getCell(space, "start sync behavior");
      setupTrusted(runtime, undefined, pattern, { input: 4 }, resultCell);

      // start() should execute synchronously when data is available
      // The piece should be registered in cancels map immediately
      const started = runtime.start(resultCell);
      // Should be running now (check via runner.cancels having the key)
      expect(
        runtime.runner.cancels.has(
          runtime.runner.accessForTestingOnly.getDocKey(resultCell),
        ),
      ).toBe(true);

      expect(await started).toBe(true);
      await resultCell.pull();
      await runtime.idle();
      expect(resultCell.getAsQueryResult()).toEqual({ output: 12 });
    });

    it("start() on subpath cell starts the root cell", async () => {
      const pattern: Pattern = {
        argumentSchema: {
          type: "object",
          properties: { input: { type: "number" } },
        },
        resultSchema: {},
        result: {
          nested: {
            value: { $alias: { partialCause: "output", path: [] } },
          },
        },
        nodes: [
          {
            module: {
              type: "javascript",
              implementation: (v: { input: number }) => v.input * 2,
            },
            inputs: { $alias: { cell: "argument", path: [] } },
            outputs: { $alias: { partialCause: "output", path: [] } },
          },
        ],
      };

      const resultCell = runtime.getCell(space, "start subpath cell");
      setupTrusted(runtime, undefined, pattern, { input: 5 }, resultCell);

      // Get a subpath cell
      const subpathCell = resultCell.key("nested").key("value");

      // Start via the subpath cell - should start the root
      const result = await runtime.start(subpathCell);
      expect(result).toBe(true);

      await subpathCell.pull();
      await runtime.idle();
      expect(resultCell.getAsQueryResult()).toEqual({ nested: { value: 10 } });

      // Verify root cell is running
      expect(
        runtime.runner.cancels.has(
          runtime.runner.accessForTestingOnly.getDocKey(resultCell),
        ),
      ).toBe(true);
    });

    it("restarts with new pattern when the pattern changes via setup()", async () => {
      const pattern1: Pattern = {
        argumentSchema: {
          type: "object",
          properties: { input: { type: "number" } },
        },
        resultSchema: {},
        result: { output: { $alias: { partialCause: "output", path: [] } } },
        nodes: [
          {
            module: {
              type: "javascript",
              implementation: (v: { input: number }) => v.input * 2,
            },
            inputs: { $alias: { cell: "argument", path: [] } },
            outputs: { $alias: { partialCause: "output", path: [] } },
          },
        ],
      };

      const pattern2: Pattern = {
        argumentSchema: {
          type: "object",
          properties: { input: { type: "number" } },
        },
        resultSchema: {},
        result: { output: { $alias: { partialCause: "output", path: [] } } },
        nodes: [
          {
            module: {
              type: "javascript",
              implementation: (v: { input: number }) => v.input * 10,
            },
            inputs: { $alias: { cell: "argument", path: [] } },
            outputs: { $alias: { partialCause: "output", path: [] } },
          },
        ],
      };

      const resultCell = runtime.getCell(space, "pattern change restart");

      // Run with first pattern
      runTrusted(runtime, undefined, pattern1, { input: 5 }, resultCell);
      expect(await resultCell.pull()).toEqual({ output: 10 }); // 5 * 2

      // Change pattern via setup (not run or start)
      // The pattern sink should detect the change and restart once the result is pulled.
      await setupTrusted(
        runtime,
        undefined,
        pattern2,
        { input: 5 },
        resultCell,
      );
      expect(await resultCell.pull()).toEqual({ output: 50 }); // 5 * 10
    });
  });
});
