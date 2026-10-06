import {
  FabricUnavailable,
  UNAVAILABLE_PENDING,
  UNAVAILABLE_SYNCING,
  unavailableError,
  unavailableMismatch,
  type UnavailableObservationKind,
} from "@commonfabric/data-model/availability";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import type { Module, Pattern } from "../src/builder/types.ts";
import { type Cell, createCell, sendEvent } from "../src/cell.ts";
import { getDerivedInternalCell, parseLink } from "../src/link-utils.ts";
import { resolveLink } from "../src/link-resolution.ts";
import { Runtime } from "../src/runtime.ts";
import type { IReadActivity } from "../src/storage/interface.ts";
import {
  isInternalVerifierRead,
  isLinkResolutionProbe,
  isReadIgnoredForCommit,
  isReadIgnoredForScheduling,
} from "../src/storage/reactivity-log.ts";
import { trustExecutable, trustModule } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("data unavailability test");
const space = signer.did();
const remoteSpace = (await Identity.fromPassphrase(
  "data unavailability remote test",
)).did();

function expectUnavailable(
  value: unknown,
  reason: UnavailableObservationKind,
): FabricUnavailable {
  expect(value).toBeInstanceOf(FabricUnavailable);
  expect((value as FabricUnavailable).reason).toBe(
    reason === "schemaMismatch" ? "error" : reason,
  );
  if (reason === "schemaMismatch") {
    expect((value as FabricUnavailable).errorKind).toBe("schemaMismatch");
  }
  return value as FabricUnavailable;
}

describe("JavaScript-node data unavailability", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let nextResultId = 0;

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

  async function runValueNode(options: {
    argument: unknown;
    moduleType?: Module["type"];
    nodeInputs?: unknown;
    argumentSchema?: Module["argumentSchema"];
    resultSchema?: Module["resultSchema"];
    unavailableInputPolicy?: Module["unavailableInputPolicy"];
    implementation: (argument: any) => unknown;
    isEffect?: boolean;
    captureWrittenResult?: (value: unknown) => void;
    captureSelectedInput?: (value: unknown) => void;
    captureArgumentReads?: (reads: readonly IReadActivity[]) => void;
  }): Promise<unknown> {
    const module: Module = {
      type: options.moduleType ?? "javascript",
      implementation: options.implementation,
      ...(options.argumentSchema !== undefined && {
        argumentSchema: options.argumentSchema,
      }),
      ...(options.resultSchema !== undefined && {
        resultSchema: options.resultSchema,
      }),
      ...(options.unavailableInputPolicy !== undefined && {
        unavailableInputPolicy: options.unavailableInputPolicy,
      }),
      ...(options.isEffect !== undefined && { isEffect: options.isEffect }),
    };
    const pattern = {
      argumentSchema: {},
      resultSchema: {},
      result: {
        output: { $alias: { partialCause: "output", path: [] } },
      },
      nodes: [{
        module,
        inputs: options.nodeInputs ?? {
          $alias: { cell: "argument", path: ["value"] },
        },
        outputs: { $alias: { partialCause: "output", path: [] } },
      }],
    } as Pattern;

    const resultCell = runtime.getCell(
      space,
      `data unavailability result ${nextResultId++}`,
    );
    const runner = runtime.runner.accessForTestingOnly;
    runner.javascriptResultObserver = options.captureWrittenResult;
    runner.javascriptArgumentObserver = (result, reads) => {
      options.captureSelectedInput?.(result.unavailable);
      options.captureArgumentReads?.(reads);
    };
    try {
      const result = await runtime.runSynced(
        resultCell,
        trustExecutable(runtime, pattern),
        options.argument as never,
      );
      const output = getDerivedInternalCell(result, {
        partialCause: "output",
      });
      const pulled = await output.pull();
      const raw = output.getRaw();
      return parseLink(raw, output) === undefined ? raw : pulled;
    } finally {
      runner.javascriptResultObserver = undefined;
      runner.javascriptArgumentObserver = undefined;
    }
  }

  it("executes the fail-closed module kind used by policy-bearing lifts", async () => {
    const error = unavailableError(new Error("observed"));
    const result = await runValueNode({
      argument: { value: error },
      moduleType: "javascript-availability",
      argumentSchema: {
        anyOf: [{ type: "string" }, { type: "FabricUnavailable" }],
      },
      resultSchema: { type: "boolean" },
      unavailableInputPolicy: [{ path: [], reasons: ["error"] }],
      implementation: (value) =>
        value instanceof FabricUnavailable && value.reason === "error",
    });

    expect(result).toBe(true);
  });

  it("rejects malformed serialized policy before invoking the callback", async () => {
    let calls = 0;
    await expect(runValueNode({
      argument: { value: "usable" },
      moduleType: "javascript-availability",
      argumentSchema: { type: "string" },
      unavailableInputPolicy: [{
        path: [],
        reasons: ["offline"],
      }] as unknown as Module["unavailableInputPolicy"],
      implementation: () => {
        calls++;
        return "called";
      },
    })).rejects.toThrow(/Invalid unavailable input policy/);
    expect(calls).toBe(0);
  });

  it("suppresses the callback and propagates the selected marker value", async () => {
    const marker = unavailableError(new Error("upstream failed"));
    let calls = 0;
    let writtenResult: unknown;
    let selectedInput: unknown;

    const output = await runValueNode({
      argument: { value: marker },
      argumentSchema: { type: "number" },
      resultSchema: {
        type: "object",
        properties: { answer: { type: "number" } },
        required: ["answer"],
      },
      implementation: () => {
        calls++;
        return { answer: 42 };
      },
      captureWrittenResult: (value) => writtenResult = value,
      captureSelectedInput: (value) => selectedInput = value,
    });

    expect(calls).toBe(0);
    expectUnavailable(selectedInput, "error");
    expectUnavailable(writtenResult, "error");
    expect(expectUnavailable(output, "error").errorMessage).toBe(
      "upstream failed",
    );
  });

  it("selects by reason precedence, then serialized argument order", async () => {
    const firstError = unavailableError(new Error("first"));
    const secondError = unavailableError(new Error("second"));
    let calls = 0;
    let writtenResult: unknown;
    let selectedInput: unknown;

    const output = await runValueNode({
      argument: {
        first: firstError,
        pending: UNAVAILABLE_PENDING,
        syncing: UNAVAILABLE_SYNCING,
        mismatch: unavailableMismatch(),
        second: secondError,
      },
      nodeInputs: {
        first: { $alias: { cell: "argument", path: ["first"] } },
        pending: { $alias: { cell: "argument", path: ["pending"] } },
        syncing: { $alias: { cell: "argument", path: ["syncing"] } },
        mismatch: { $alias: { cell: "argument", path: ["mismatch"] } },
        second: { $alias: { cell: "argument", path: ["second"] } },
      },
      argumentSchema: {
        type: "object",
        properties: {
          first: { type: "object" },
          pending: { type: "object" },
          syncing: { type: "object" },
          mismatch: { type: "object" },
          second: { type: "object" },
        },
      },
      implementation: () => {
        calls++;
        return "ran";
      },
      captureWrittenResult: (value) => writtenResult = value,
      captureSelectedInput: (value) => selectedInput = value,
    });

    expect(calls).toBe(0);
    expect((selectedInput as FabricUnavailable).errorMessage).toBe("first");
    expect(expectUnavailable(writtenResult, "error").errorMessage).toBe(
      "first",
    );
    expect((output as FabricUnavailable).errorMessage).toBe("first");

    const pending = UNAVAILABLE_PENDING;
    const pendingOutput = await runValueNode({
      argument: {
        syncing: UNAVAILABLE_SYNCING,
        pending,
        mismatch: unavailableMismatch(),
      },
      nodeInputs: {
        syncing: { $alias: { cell: "argument", path: ["syncing"] } },
        pending: { $alias: { cell: "argument", path: ["pending"] } },
        mismatch: { $alias: { cell: "argument", path: ["mismatch"] } },
      },
      argumentSchema: { type: "object" },
      implementation: () => {
        calls++;
        return "ran";
      },
    });
    expectUnavailable(pendingOutput, "schemaMismatch");

    const syncing = UNAVAILABLE_SYNCING;
    const syncingOutput = await runValueNode({
      argument: {
        mismatch: unavailableMismatch(),
        syncing,
      },
      nodeInputs: {
        mismatch: { $alias: { cell: "argument", path: ["mismatch"] } },
        syncing: { $alias: { cell: "argument", path: ["syncing"] } },
      },
      argumentSchema: { type: "object" },
      implementation: () => {
        calls++;
        return "ran";
      },
    });
    expectUnavailable(syncingOutput, "schemaMismatch");
    expect(calls).toBe(0);
  });

  it("admits only schema-mismatch errors through a kind-specific policy", async () => {
    for (
      const kind of [
        "schemaMismatch",
        "network",
        "compile",
        "invalidInput",
      ] as const
    ) {
      const marker = new FabricUnavailable("error", kind, "observed failure");
      let calls = 0;
      const output = await runValueNode({
        argument: { value: marker },
        argumentSchema: { type: "FabricUnavailable" },
        unavailableInputPolicy: [{ path: [], reasons: ["schemaMismatch"] }],
        implementation: (argument) => {
          calls++;
          return argument.errorKind;
        },
      });
      expect(calls).toBe(kind === "schemaMismatch" ? 1 : 0);
      if (kind === "schemaMismatch") {
        expect(output).toBe("schemaMismatch");
      } else {
        expect((output as FabricUnavailable).errorKind).toBe(kind);
      }

      const broad = await runValueNode({
        argument: { value: marker },
        argumentSchema: { type: "FabricUnavailable" },
        unavailableInputPolicy: [{ path: [], reasons: ["error"] }],
        implementation: (argument) => argument.errorKind,
      });
      expect(broad).toBe(kind);
    }
  });

  it("allows only the accepted reason at the exact policy path", async () => {
    let calls = 0;
    let acceptedArgument: unknown;
    const nodeInputs = {
      value: { $alias: { cell: "argument", path: ["value"] } },
    };
    const argumentSchema = {
      type: "object" as const,
      properties: {
        value: {
          anyOf: [
            {
              type: "object" as const,
              properties: { answer: { type: "number" as const } },
              required: ["answer"],
            },
            { type: "FabricUnavailable" as const },
          ],
        },
      },
      required: ["value"],
    };
    const unavailableInputPolicy = [{
      path: ["value"],
      reasons: ["error" as const],
    }];

    const observed = unavailableError(new Error("observable"));
    const acceptedOutput = await runValueNode({
      argument: { value: observed },
      nodeInputs,
      argumentSchema,
      unavailableInputPolicy,
      implementation: (argument) => {
        calls++;
        acceptedArgument = argument.value;
        return argument.value.errorMessage;
      },
    });

    expect(acceptedOutput).toBe("observable");
    expect(acceptedArgument).toBeInstanceOf(FabricUnavailable);
    expect((acceptedArgument as FabricUnavailable).reason).toBe("error");
    expect((acceptedArgument as FabricUnavailable).errorMessage).toBe(
      "observable",
    );
    expect(calls).toBe(1);

    const unaccepted = UNAVAILABLE_PENDING;
    const propagatedOutput = await runValueNode({
      argument: { value: unaccepted },
      nodeInputs,
      argumentSchema,
      unavailableInputPolicy,
      implementation: () => {
        calls++;
        return "should not run";
      },
    });

    expectUnavailable(propagatedOutput, "pending");
    expect(calls).toBe(1);
  });

  it("restores accepted markers at multiple object and array paths", async () => {
    const error = unavailableError(new Error("accepted error"));
    const pending = UNAVAILABLE_PENDING;

    const output = await runValueNode({
      argument: { first: error, list: [pending] },
      nodeInputs: {
        first: { $alias: { cell: "argument", path: ["first"] } },
        list: { $alias: { cell: "argument", path: ["list"] } },
      },
      argumentSchema: {
        type: "object",
        properties: {
          first: {
            anyOf: [{ type: "string" }, { type: "FabricUnavailable" }],
          },
          list: {
            type: "array",
            items: {
              anyOf: [{ type: "number" }, { type: "FabricUnavailable" }],
            },
          },
        },
        required: ["first", "list"],
      },
      unavailableInputPolicy: [
        { path: ["first"], reasons: ["error"] },
        { path: ["list", "0"], reasons: ["pending"] },
      ],
      implementation: (argument) => ({
        errorIsMarker: argument.first instanceof FabricUnavailable,
        errorMessage: argument.first.errorMessage,
        pendingIsMarker: argument.list[0] instanceof FabricUnavailable,
        pendingReason: argument.list[0].reason,
      }),
    });

    expect(output).toEqual({
      errorIsMarker: true,
      errorMessage: "accepted error",
      pendingIsMarker: true,
      pendingReason: "pending",
    });
  });

  it("preserves authored schemas and policy when resolving a ref module", async () => {
    let calls = 0;
    runtime.moduleRegistry.addModuleByRef(
      "availability-policy-ref",
      trustModule(runtime, {
        type: "javascript",
        argumentSchema: { type: "number" },
        resultSchema: { type: "number" },
        implementation: (value: FabricUnavailable) => {
          calls++;
          return value.isPending() ? "observed through ref" : "unexpected";
        },
      }),
    );

    const pattern = {
      argumentSchema: {},
      resultSchema: {},
      result: {
        output: { $alias: { partialCause: "output", path: [] } },
      },
      nodes: [{
        module: {
          type: "ref",
          implementation: "availability-policy-ref",
          argumentSchema: { type: "FabricUnavailable" },
          resultSchema: { type: "string" },
          unavailableInputPolicy: [{ path: [], reasons: ["pending"] }],
        },
        inputs: { $alias: { cell: "argument", path: ["value"] } },
        outputs: { $alias: { partialCause: "output", path: [] } },
      }],
    } as Pattern;
    const resultCell = runtime.getCell(
      space,
      `availability ref result ${nextResultId++}`,
    );
    const result = await runtime.runSynced(
      resultCell,
      trustExecutable(runtime, pattern),
      { value: UNAVAILABLE_PENDING },
    );
    await result.pull();

    expect(calls).toBe(1);
    expect(
      getDerivedInternalCell(result, { partialCause: "output" }).getRaw(),
    ).toBe("observed through ref");
  });

  it("does not let outer-path acceptance admit a nested marker", async () => {
    const nested = UNAVAILABLE_PENDING;
    let calls = 0;

    const output = await runValueNode({
      argument: { value: { nested } },
      nodeInputs: {
        value: { $alias: { cell: "argument", path: ["value"] } },
      },
      argumentSchema: {
        type: "object",
        properties: { value: { type: "object" } },
      },
      unavailableInputPolicy: [{
        path: ["value"],
        reasons: ["pending"],
      }],
      implementation: () => {
        calls++;
        return "should not run";
      },
    });

    expect(calls).toBe(0);
    expectUnavailable(output, "pending");
  });

  it("checks each exact path when two aliases share one object", async () => {
    const nested = unavailableError(new Error("shared but unaccepted"));
    let calls = 0;

    const output = await runValueNode({
      argument: { shared: { nested } },
      nodeInputs: {
        accepted: { $alias: { cell: "argument", path: ["shared"] } },
        unaccepted: { $alias: { cell: "argument", path: ["shared"] } },
      },
      argumentSchema: {
        type: "object",
        properties: {
          accepted: { type: "object" },
          unaccepted: { type: "object" },
        },
      },
      unavailableInputPolicy: [{
        path: ["accepted", "nested"],
        reasons: ["error"],
      }],
      implementation: () => {
        calls++;
        return "should not run";
      },
    });

    expect(calls).toBe(0);
    expect(output).toBeInstanceOf(FabricUnavailable);
    expect((output as FabricUnavailable).errorMessage).toBe(
      "shared but unaccepted",
    );
  });

  it("preflights concrete markers before an object schema can accept them", async () => {
    const marker = UNAVAILABLE_PENDING;
    let calls = 0;

    const output = await runValueNode({
      argument: { value: marker },
      argumentSchema: { type: "object" },
      implementation: () => {
        calls++;
        return "should not run";
      },
    });

    expect(calls).toBe(0);
    expectUnavailable(output, "pending");
  });

  it("does not preflight an object property excluded by the schema", async () => {
    let calls = 0;
    const output = await runValueNode({
      argument: {
        value: {
          selected: 41,
          excluded: UNAVAILABLE_PENDING,
        },
      },
      argumentSchema: {
        type: "object",
        properties: { selected: { type: "number" } },
        required: ["selected"],
        additionalProperties: false,
      },
      implementation: (value: { selected: number }) => {
        calls++;
        return value.selected + 1;
      },
    });

    expect(calls).toBe(1);
    expect(output).toBe(42);
  });

  it("does not duplicate an ordinary linked target's effective read", async () => {
    const target = runtime.getCell<number>(
      space,
      `ordinary linked input ${nextResultId++}`,
    );
    const seedTx = runtime.edit();
    target.withTx(seedTx).set(41);
    await seedTx.commit().settled;

    let reads: readonly IReadActivity[] = [];
    const output = await runValueNode({
      argument: { value: target.getAsLink() },
      argumentSchema: { type: "number" },
      implementation: (value: number) => value + 1,
      captureArgumentReads: (argumentReads) => reads = argumentReads,
    });

    expect(output).toBe(42);
    const targetId = target.getAsNormalizedFullLink().id;
    const contentReads = reads.filter((read) =>
      read.id === targetId && !isLinkResolutionProbe(read.meta)
    );
    const ordinaryReads = contentReads.filter((read) =>
      !isReadIgnoredForScheduling(read.meta) &&
      !isReadIgnoredForCommit(read.meta) &&
      !isInternalVerifierRead(read.meta)
    );
    expect(
      ordinaryReads.filter((read) => read.nonRecursive !== true),
    ).toHaveLength(0);
    expect(ordinaryReads).toHaveLength(2);

    const verifierReads = contentReads.filter((read) =>
      isReadIgnoredForScheduling(read.meta) &&
      isReadIgnoredForCommit(read.meta) &&
      isInternalVerifierRead(read.meta)
    );
    expect(verifierReads).toHaveLength(1);
  });

  it("does not traverse opaque guard operands below their root", async () => {
    const nested = runtime.getCell(
      space,
      `opaque guard nested ${nextResultId++}`,
    );
    const target = runtime.getCell(
      space,
      `opaque guard target ${nextResultId++}`,
    );
    const seedTx = runtime.edit();
    nested.withTx(seedTx).setRaw(UNAVAILABLE_PENDING);
    target.withTx(seedTx).setRaw({ nested: nested.getAsLink() });
    await seedTx.commit().settled;

    let calls = 0;
    const output = await runValueNode({
      argument: { value: target.getAsLink() },
      moduleType: "javascript-availability",
      argumentSchema: { type: "unknown" },
      resultSchema: { type: "boolean" },
      unavailableInputPolicy: [{ path: [], reasons: ["error"] }],
      implementation: (value) => {
        calls++;
        return value instanceof FabricUnavailable && value.reason === "error";
      },
    });

    expect(calls).toBe(1);
    expect(output).toBe(false);

    const markerTx = runtime.edit();
    target.withTx(markerTx).setRaw(
      unavailableError(new Error("opaque root failure")),
    );
    await markerTx.commit().settled;
    const markerOutput = await runValueNode({
      argument: { value: target.getAsLink() },
      moduleType: "javascript-availability",
      argumentSchema: { type: "unknown" },
      resultSchema: { type: "boolean" },
      unavailableInputPolicy: [{ path: [], reasons: ["error"] }],
      implementation: (value) => {
        calls++;
        return value instanceof FabricUnavailable && value.reason === "error";
      },
    });

    expect(calls).toBe(2);
    expect(markerOutput).toBe(true);

    const structuralTx = runtime.edit();
    target.withTx(structuralTx).setRaw({ nested: nested.getAsLink() });
    await structuralTx.commit().settled;
    await runtime.scheduler.idle();
    let structuralCalls = 0;
    const structuralOutput = await runValueNode({
      argument: { value: target.getAsLink() },
      moduleType: "javascript-availability",
      argumentSchema: {
        type: "object",
        properties: { nested: { type: "FabricUnavailable" } },
        required: ["nested"],
      },
      unavailableInputPolicy: [{ path: [], reasons: ["error"] }],
      implementation: () => {
        structuralCalls++;
        return "should not run";
      },
    });

    expect(structuralCalls).toBe(0);
    expectUnavailable(structuralOutput, "pending");
  });

  it("propagates initial unavailable values through legacy schema modes", async () => {
    for (const argumentSchema of [undefined, false] as const) {
      let calls = 0;
      const output = await runValueNode({
        argument: { value: UNAVAILABLE_PENDING },
        argumentSchema,
        implementation: () => ++calls,
      });
      expectUnavailable(output, "pending");
      expect(calls).toBe(0);
    }
  });

  it("keeps consumed legacy inputs reactive and leaves unused inputs unsubscribed", async () => {
    for (
      const [label, argumentSchema, readInput] of [
        ["consumed", undefined, true],
        ["unused", undefined, false],
        ["false", false, false],
      ] as const
    ) {
      const target = runtime.getCell<number | FabricUnavailable>(
        space,
        `legacy availability target ${label} ${nextResultId++}`,
      );
      const seedTx = runtime.edit();
      target.withTx(seedTx).set(7);
      await seedTx.commit().settled;

      let calls = 0;
      const pattern = {
        argumentSchema: {},
        resultSchema: {},
        result: {
          output: { $alias: { partialCause: "output", path: [] } },
        },
        nodes: [{
          module: {
            type: "javascript",
            ...(argumentSchema !== undefined && { argumentSchema }),
            implementation: (input: { ignored: number } | undefined) => {
              if (readInput) void input!.ignored;
              return `call ${++calls}`;
            },
          },
          inputs: {
            ignored: { $alias: { cell: "argument", path: ["value"] } },
          },
          outputs: { $alias: { partialCause: "output", path: [] } },
        }],
      } as Pattern;
      const result = await runtime.runSynced(
        runtime.getCell(
          space,
          `legacy availability result ${label} ${nextResultId++}`,
        ),
        trustExecutable(runtime, pattern),
        { value: target.getAsLink() },
      );
      await result.pull();
      const output = getDerivedInternalCell(result, {
        partialCause: "output",
      });
      expect(output.getRaw()).toBe("call 1");

      const pendingTx = runtime.edit();
      target.withTx(pendingTx).set(UNAVAILABLE_PENDING);
      await pendingTx.commit().settled;
      await output.pull();

      expect(calls).toBe(1);
      if (readInput) {
        expectUnavailable(output.getRaw(), "pending");
      } else {
        expect(output.getRaw()).toBe("call 1");
      }
    }
  });

  it("resolves a nested relative marker from the reached linked container", async () => {
    const holder = runtime.getCell(
      space,
      `relative availability holder ${nextResultId++}`,
    );
    const relativeMarker = holder.key("payload").getAsLink({
      base: holder.key("container", "nested"),
    });
    const seedTx = runtime.edit();
    holder.withTx(seedTx).setRaw({
      payload: UNAVAILABLE_PENDING,
      container: { nested: relativeMarker },
    });
    await seedTx.commit().settled;

    let calls = 0;
    const output = await runValueNode({
      argument: { value: holder.key("container").getAsLink() },
      argumentSchema: { type: "object" },
      implementation: () => {
        calls++;
        return "should not run";
      },
    });

    expect(calls).toBe(0);
    expectUnavailable(output, "pending");
  });

  it("preserves local definition scope while scanning nested inputs", async () => {
    const marker = UNAVAILABLE_PENDING;
    let calls = 0;
    const output = await runValueNode({
      argument: { value: { child: { status: marker } } },
      argumentSchema: {
        $defs: {
          envelope: {
            type: "object",
            properties: { child: { $ref: "#/$defs/child" } },
            required: ["child"],
          },
          child: {
            type: "object",
            properties: { status: { type: "number" } },
            required: ["status"],
          },
        },
        $ref: "#/$defs/envelope",
      },
      implementation: () => {
        calls++;
        return "should not run";
      },
    });

    expect(calls).toBe(0);
    expectUnavailable(output, "pending");
  });

  it("terminates a linked-container cycle and still selects its sibling marker", async () => {
    const first = runtime.getCell(
      space,
      `availability cycle first ${nextResultId++}`,
    );
    const second = runtime.getCell(
      space,
      `availability cycle second ${nextResultId++}`,
    );
    const pending = UNAVAILABLE_PENDING;
    const seedTx = runtime.edit();
    first.withTx(seedTx).setRaw({
      next: second.getAsLink(),
      sibling: pending,
    });
    second.withTx(seedTx).setRaw({ next: first.getAsLink() });
    await seedTx.commit().settled;

    let calls = 0;
    const output = await runValueNode({
      argument: { value: first.getAsLink() },
      argumentSchema: { type: "object" },
      implementation: () => {
        calls++;
        return "should not run";
      },
    });

    expect(calls).toBe(0);
    expectUnavailable(output, "pending");
  });

  it("writes schemaMismatch when locally complete input fails its schema", async () => {
    let calls = 0;

    const output = await runValueNode({
      argument: { value: "not a number" },
      argumentSchema: { type: "number" },
      implementation: () => {
        calls++;
        return 42;
      },
    });

    expect(calls).toBe(0);
    expectUnavailable(output, "schemaMismatch");
  });

  it("settles missing linked targets from syncing to schema mismatch", async () => {
    const remoteStates: string[] = [];
    const remoteWrites: string[] = [];
    const missingRemote = runtime.getCell(
      remoteSpace,
      `missing remote input ${nextResultId++}`,
    );
    const remoteOutput = await runValueNode({
      argument: { value: missingRemote.getAsLink() },
      argumentSchema: { type: "number" },
      implementation: () => "should not run",
      captureSelectedInput: (value) => {
        if (value instanceof FabricUnavailable) remoteStates.push(value.reason);
      },
      captureWrittenResult: (value) => {
        if (value instanceof FabricUnavailable) remoteWrites.push(value.reason);
      },
    });
    expect(remoteStates[0]).toBe("syncing");
    expect(remoteStates.at(-1)).toBe("error");
    expect(remoteWrites[0]).toBe("syncing");
    expect(remoteWrites.at(-1)).toBe("error");
    expectUnavailable(remoteOutput, "schemaMismatch");

    const localStates: string[] = [];
    const localWrites: string[] = [];
    const missingLocal = runtime.getCell(
      space,
      `missing local input ${nextResultId++}`,
    );
    const localOutput = await runValueNode({
      argument: { value: missingLocal.getAsLink() },
      argumentSchema: { type: "number" },
      implementation: () => "should not run",
      captureSelectedInput: (value) => {
        if (value instanceof FabricUnavailable) localStates.push(value.reason);
      },
      captureWrittenResult: (value) => {
        if (value instanceof FabricUnavailable) localWrites.push(value.reason);
      },
    });
    // The same-space pre-sync is already in flight when the value node joins
    // it, so the node exposes the same transient as a remote linked target.
    expect(localStates.at(-1)).toBe("error");
    expect(localWrites.at(-1)).toBe("error");
    expectUnavailable(localOutput, "schemaMismatch");
  });

  it("selects a concrete schema error ahead of syncing", async () => {
    for (const required of [["mismatch", "missing"], ["mismatch"]]) {
      const writes: UnavailableObservationKind[] = [];
      const missingRemote = runtime.getCell(
        remoteSpace,
        `precedence missing remote ${nextResultId++}`,
      );
      let calls = 0;

      const output = await runValueNode({
        argument: {
          mismatch: unavailableMismatch(),
          missing: missingRemote.getAsLink(),
        },
        nodeInputs: {
          mismatch: { $alias: { cell: "argument", path: ["mismatch"] } },
          missing: { $alias: { cell: "argument", path: ["missing"] } },
        },
        argumentSchema: {
          type: "object",
          properties: {
            mismatch: { type: "number" },
            missing: { type: "number" },
          },
          required,
        },
        implementation: () => {
          calls++;
          return "should not run";
        },
        captureWrittenResult: (value) => {
          if (value instanceof FabricUnavailable) writes.push(value.reason);
        },
      });

      expect(calls).toBe(0);
      expect(writes[0]).toBe("error");
      expect(writes.at(-1)).toBe("error");
      expectUnavailable(output, "schemaMismatch");
    }
  });

  it("passes policy-accepted readiness syncing to the callback", async () => {
    const missingRemote = runtime.getCell(
      remoteSpace,
      `accepted syncing remote ${nextResultId++}`,
    );
    const writes: unknown[] = [];
    let calls = 0;

    const output = await runValueNode({
      argument: { value: missingRemote.getAsLink() },
      moduleType: "javascript-availability",
      argumentSchema: {
        anyOf: [{ type: "number" }, { type: "FabricUnavailable" }],
      },
      unavailableInputPolicy: [{ path: [], reasons: ["syncing"] }],
      implementation: (value) => {
        calls++;
        expectUnavailable(value, "syncing");
        return "observed syncing";
      },
      captureWrittenResult: (value) => writes.push(value),
    });

    expect(calls).toBe(1);
    expect(writes[0]).toBe("observed syncing");
    expectUnavailable(output, "schemaMismatch");
  });

  it("rejects an accessed sibling mismatch beside accepted readiness syncing", async () => {
    const missingRemote = runtime.getCell(
      remoteSpace,
      `accepted nested syncing remote ${nextResultId++}`,
    );
    const writes: unknown[] = [];
    let calls = 0;

    const output = await runValueNode({
      argument: {
        missing: missingRemote.getAsLink(),
        invalid: "not a number",
      },
      nodeInputs: {
        missing: { $alias: { cell: "argument", path: ["missing"] } },
        invalid: { $alias: { cell: "argument", path: ["invalid"] } },
      },
      moduleType: "javascript-availability",
      argumentSchema: {
        type: "object",
        properties: {
          missing: {
            anyOf: [{ type: "number" }, { type: "FabricUnavailable" }],
          },
          invalid: { type: "number" },
        },
        required: ["missing", "invalid"],
      },
      unavailableInputPolicy: [{
        path: ["missing"],
        reasons: ["syncing"],
      }],
      implementation: (value) => {
        calls++;
        return value.invalid;
      },
      captureWrittenResult: (value) => writes.push(value),
    });

    expect(calls).toBeGreaterThanOrEqual(1);
    expect(
      writes.every((value) =>
        value instanceof FabricUnavailable &&
        value.errorKind === "schemaMismatch"
      ),
    ).toBe(true);
    expectUnavailable(output, "schemaMismatch");
  });

  it("tracks missing-link readiness by full selector identity", async () => {
    type Link = Parameters<Runtime["ensureLinkedDocLoaded"]>[0];
    const originalSyncCell = storageManager.syncCell.bind(storageManager);
    const observed: Link[] = [];
    const releases: Array<() => void> = [];
    storageManager.syncCell = <T>(cell: Cell<T>): Promise<Cell<T>> => {
      observed.push(cell.getAsNormalizedFullLink());
      const { promise, resolve } = Promise.withResolvers<void>();
      releases.push(resolve);
      return promise.then(() => cell);
    };

    try {
      const base = runtime.getCell(
        space,
        `selector readiness ${nextResultId++}`,
      ).getAsNormalizedFullLink();
      const selectors: Link[] = [
        {
          ...base,
          scope: "space",
          path: ["left"],
          schema: { type: "string" },
        },
        {
          ...base,
          scope: "user",
          path: ["left"],
          schema: { type: "string" },
        },
        {
          ...base,
          scope: "space",
          path: ["right"],
          schema: { type: "string" },
        },
        {
          ...base,
          scope: "space",
          path: ["left"],
          schema: { type: "number" },
        },
      ];

      for (const [index, selector] of selectors.entries()) {
        expect(runtime.ensureLinkedDocLoaded(selector)).toBe("pending");
        expect(observed.length).toBe(index + 1);
        releases[index]();
        await storageManager.crossSpaceSettled();
        expect(runtime.ensureLinkedDocLoaded(selector)).toBe("settled");
      }

      // Structural schema identity is canonical: reminting an equivalent
      // selector must reuse its settled coverage rather than issue a fifth sync.
      expect(runtime.ensureLinkedDocLoaded({
        ...selectors[0],
        schema: { type: "string" },
      })).toBe("settled");
      expect(observed.length).toBe(selectors.length);
    } finally {
      for (const release of releases) release();
      await storageManager.crossSpaceSettled();
      storageManager.syncCell = originalSyncCell;
    }
  });

  it("prefetches cross-space link targets without registering an action waiter", async () => {
    const source = runtime.getCell(
      space,
      `reference-only prefetch source ${nextResultId++}`,
    );
    const target = runtime.getCell(
      remoteSpace,
      `reference-only prefetch target ${nextResultId++}`,
    );
    const seedTx = runtime.edit();
    source.withTx(seedTx).setRaw(target.getAsLink());
    await seedTx.commit().settled;

    const targetId = target.getAsNormalizedFullLink().id;
    const originalSyncCell = storageManager.syncCell.bind(storageManager);
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    storageManager.syncCell = async <T>(cell: Cell<T>): Promise<Cell<T>> => {
      if (cell.getAsNormalizedFullLink().id === targetId) {
        started.resolve();
        await release.promise;
        return cell;
      }
      return await originalSyncCell(cell);
    };

    const scheduler = runtime.scheduler;
    const originalSchedule = scheduler.scheduleExternalDependencySettlement;
    let settlementSchedules = 0;
    scheduler.scheduleExternalDependencySettlement = (token) => {
      settlementSchedules++;
      return originalSchedule.call(scheduler, token);
    };

    try {
      const readTx = runtime.edit();
      const action = (() => {}) as Parameters<
        typeof scheduler.withExecutingAction
      >[0];
      const resolved = scheduler.withExecutingAction(
        action,
        () =>
          resolveLink(
            runtime,
            readTx,
            source.getAsNormalizedFullLink(),
          ),
      );

      expect(resolved.space).toBe(remoteSpace);
      await started.promise;
      release.resolve();
      await storageManager.crossSpaceSettled();
      expect(settlementSchedules).toBe(0);
    } finally {
      release.resolve();
      scheduler.scheduleExternalDependencySettlement = originalSchedule;
      storageManager.syncCell = originalSyncCell;
    }
  });

  it("can verify cross-space link topology without starting a prefetch", async () => {
    const source = runtime.getCell(
      space,
      `no-prefetch source ${nextResultId++}`,
    );
    const target = runtime.getCell(
      remoteSpace,
      `no-prefetch target ${nextResultId++}`,
    );
    const seedTx = runtime.edit();
    source.withTx(seedTx).setRaw(target.getAsLink());
    await seedTx.commit().settled;

    const targetId = target.getAsNormalizedFullLink().id;
    const originalSyncCell = storageManager.syncCell.bind(storageManager);
    let targetSyncs = 0;
    storageManager.syncCell = async <T>(cell: Cell<T>): Promise<Cell<T>> => {
      if (cell.getAsNormalizedFullLink().id === targetId) targetSyncs++;
      return await originalSyncCell(cell);
    };

    const readTx = runtime.edit();
    try {
      const resolved = resolveLink(
        runtime,
        readTx,
        source.getAsNormalizedFullLink(),
        "value",
        { kickCrossSpaceTargets: false },
      );
      expect(resolved.space).toBe(remoteSpace);
      expect(targetSyncs).toBe(0);
      expect((await readTx.commit().settled).ok).toBeDefined();
    } finally {
      storageManager.syncCell = originalSyncCell;
    }
  });

  it("keeps linked-target outcomes distinct across selectors", async () => {
    const target = runtime.getCell(
      remoteSpace,
      `reject once target ${nextResultId++}`,
    );
    const targetId = target.getAsNormalizedFullLink().id;
    const originalSyncCell = storageManager.syncCell.bind(storageManager);
    let attempts = 0;
    let rejectedReadiness = false;
    storageManager.syncCell = async <T>(cell: Cell<T>): Promise<Cell<T>> => {
      if (cell.getAsNormalizedFullLink().id === targetId) {
        attempts++;
        // Static input presync may make several coverage passes. Reject the
        // first readiness-owned call so the retry machinery itself is tested.
        if (
          runtime.scheduler.getExecutingActionToken() !== undefined &&
          !rejectedReadiness
        ) {
          rejectedReadiness = true;
          throw new Error("transient selector failure");
        }
      }
      return await originalSyncCell(cell);
    };

    try {
      const states: string[] = [];
      const output = await runValueNode({
        argument: { value: target.getAsLink() },
        argumentSchema: { type: "number" },
        implementation: () => "should not run",
        captureWrittenResult: (value) => {
          if (value instanceof FabricUnavailable) states.push(value.reason);
        },
      });

      expect(attempts).toBeGreaterThanOrEqual(2);
      expect(states[0]).toBe("syncing");
      expect(states.at(-1)).toBe("error");
      expectUnavailable(output, "schemaMismatch");
    } finally {
      storageManager.syncCell = originalSyncCell;
    }
  });

  it("wakes a same-space consumer when its delayed target arrives", async () => {
    const target = runtime.getCell<number>(
      space,
      `delayed same-space target ${nextResultId++}`,
    );
    const targetId = target.getAsNormalizedFullLink().id;
    const originalSyncCell = storageManager.syncCell.bind(storageManager);
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let intercepted = false;
    let targetSyncs = 0;
    storageManager.syncCell = async <T>(cell: Cell<T>): Promise<Cell<T>> => {
      if (cell.getAsNormalizedFullLink().id === targetId) targetSyncs++;
      const readinessOwned =
        runtime.scheduler.getExecutingActionToken() !== undefined;
      if (readinessOwned && !intercepted) {
        intercepted = true;
        started.resolve();
        await release.promise;
      }
      return await originalSyncCell(cell);
    };

    try {
      const writes: unknown[] = [];
      const outputPromise = runValueNode({
        argument: { value: target.getAsLink() },
        argumentSchema: { type: "number" },
        implementation: (value: number) => value,
        captureWrittenResult: (value) => writes.push(value),
      });

      await started.promise;
      const targetTx = runtime.edit();
      target.withTx(targetTx).set(42);
      await targetTx.commit().settled;
      release.resolve();

      expect(await outputPromise).toBe(42);
      // Scheduler-v2 may finish the same-space load gate before the action's
      // first observable write, so the transient marker is not guaranteed to
      // be externally visible. The consumer must still wait and converge.
      expect(writes).toContain(unavailableMismatch());
      expect(writes.at(-1)).toBe(42);
    } finally {
      release.resolve();
      storageManager.syncCell = originalSyncCell;
    }
  });

  it("does not wake an effect for a target from an obsolete action run", async () => {
    const targetA = runtime.getCell<number>(
      space,
      `stale waiter target a ${nextResultId++}`,
    );
    const targetB = runtime.getCell<number>(
      space,
      `stale waiter target b ${nextResultId++}`,
    );
    const selector = runtime.getCell(
      space,
      `stale waiter selector ${nextResultId++}`,
    );
    const seedTx = runtime.edit();
    targetB.withTx(seedTx).set(7);
    selector.withTx(seedTx).setRaw(targetA.getAsLink());
    await seedTx.commit().settled;

    const targetAId = targetA.getAsNormalizedFullLink().id;
    const originalSyncCell = storageManager.syncCell.bind(storageManager);
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let targetASyncs = 0;
    storageManager.syncCell = async <T>(cell: Cell<T>): Promise<Cell<T>> => {
      if (cell.getAsNormalizedFullLink().id === targetAId) targetASyncs++;
      if (runtime.scheduler.getExecutingActionToken() !== undefined) {
        started.resolve();
        await release.promise;
      }
      return await originalSyncCell(cell);
    };

    try {
      let calls = 0;
      const writes: unknown[] = [];
      const outputPromise = runValueNode({
        argument: { value: selector.getAsLink() },
        argumentSchema: { type: "number" },
        isEffect: true,
        implementation: (value: number) => {
          calls++;
          return value;
        },
        captureWrittenResult: (value) => writes.push(value),
      });

      await started.promise;
      const retargetTx = runtime.edit();
      selector.withTx(retargetTx).setRaw(targetB.getAsLink());
      await retargetTx.commit().settled;
      for (let turn = 0; turn < 10 && calls === 0; turn++) {
        await runtime.idle();
        await Promise.resolve();
      }
      expect(calls).toBe(1);

      // Settling A belongs to the earlier action generation. It must not run
      // the now-B-dependent effect for a third time.
      release.resolve();
      expect(await outputPromise).toBe(7);
      await runtime.idle();
      expect(calls).toBe(1);
      expect(writes.at(-1)).toBe(7);
    } finally {
      release.resolve();
      storageManager.syncCell = originalSyncCell;
    }
  });

  it("retains readiness failures without timed retries", async () => {
    const target = runtime.getCell(
      remoteSpace,
      `offline readiness target ${nextResultId++}`,
    );
    const targetId = target.getAsNormalizedFullLink().id;
    const originalSyncCell = storageManager.syncCell.bind(storageManager);
    let attempts = 0;
    let readinessAttempts = 0;
    storageManager.syncCell = async <T>(cell: Cell<T>): Promise<Cell<T>> => {
      if (cell.getAsNormalizedFullLink().id === targetId) {
        attempts++;
        // Let runSynced's static input presync complete. Every attempt owned by
        // the executing availability action then fails as if the provider
        // stayed offline. This remains stable as presync adds coverage passes.
        if (runtime.scheduler.getExecutingActionToken() !== undefined) {
          readinessAttempts++;
          throw new Error("provider offline");
        }
      }
      return await originalSyncCell(cell);
    };

    try {
      const output = await runValueNode({
        argument: { value: target.getAsLink() },
        argumentSchema: { type: "number" },
        isEffect: true,
        implementation: () => "should not run",
      });
      expect(output).toBeInstanceOf(FabricUnavailable);
      expect((output as FabricUnavailable).reason).toBe("error");

      expect((output as FabricUnavailable).errorMessage).toBe(
        "provider offline",
      );
      expect(readinessAttempts).toBeGreaterThanOrEqual(1);
      const settledAttempts = readinessAttempts;
      await runtime.idle();
      expect(readinessAttempts).toBe(settledAttempts);
      expect(attempts).toBeGreaterThanOrEqual(readinessAttempts);
      expect(storageManager.pendingCrossSpacePromiseCount()).toBe(0);
    } finally {
      storageManager.syncCell = originalSyncCell;
    }
  });

  it("executes for authored undefined when the declared schema admits it", async () => {
    let calls = 0;

    const output = await runValueNode({
      argument: { value: undefined },
      argumentSchema: { type: "undefined" },
      implementation: (argument) => {
        calls++;
        expect(argument).toBeUndefined();
        return "valid undefined";
      },
    });

    expect(calls).toBe(1);
    expect(output).toBe("valid undefined");
  });

  it("preserves a required nested undefined admitted by an anyOf schema", async () => {
    let ownsResult = false;
    let resultIsUndefined = false;
    let candidatesLength = -1;
    const output = await runValueNode({
      argument: {
        value: {
          result: undefined,
          candidates: [],
        },
      },
      argumentSchema: {
        type: "object",
        properties: {
          result: {
            anyOf: [
              { type: "undefined" },
              { type: "object", asCell: ["cell"] },
            ],
          },
          candidates: { type: "array", items: true },
        },
        required: ["result", "candidates"],
      },
      implementation: (argument) => {
        ownsResult = Object.hasOwn(argument, "result");
        resultIsUndefined = argument.result === undefined;
        candidatesLength = argument.candidates.length;
        return true;
      },
    });

    expect(output).toBe(true);
    expect(ownsResult).toBe(true);
    expect(resultIsUndefined).toBe(true);
    expect(candidatesLength).toBe(0);
  });

  it("suppresses value-producing effects while propagating unavailable input", async () => {
    const marker = UNAVAILABLE_SYNCING;
    let externalActions = 0;

    const output = await runValueNode({
      argument: { value: marker },
      argumentSchema: { type: "number" },
      isEffect: true,
      implementation: () => {
        externalActions++;
        return 42;
      },
    });

    expect(externalActions).toBe(0);
    expectUnavailable(output, "syncing");
  });

  it("uses the normal input-derived scope when writing a propagated marker", async () => {
    const inputTx = runtime.edit();
    const inputBase = runtime.getCell(
      space,
      `availability scoped input ${nextResultId++}`,
      undefined,
      inputTx,
    );
    const input = createCell<FabricUnavailable>(
      runtime,
      { ...inputBase.getAsNormalizedFullLink(), scope: "user" },
      inputTx,
    );
    input.setRaw(UNAVAILABLE_PENDING);
    await inputTx.commit().settled;

    const pattern = {
      argumentSchema: {},
      resultSchema: {},
      result: {
        output: { $alias: { partialCause: "output", path: [] } },
      },
      nodes: [{
        module: {
          type: "javascript",
          argumentSchema: { type: "number" },
          implementation: () => 42,
        },
        inputs: { $alias: { cell: "argument", path: ["value"] } },
        outputs: { $alias: { partialCause: "output", path: [] } },
      }],
    } as Pattern;
    const resultCell = runtime.getCell(
      space,
      `availability scoped result ${nextResultId++}`,
    );
    const result = await runtime.runSynced(
      resultCell,
      trustExecutable(runtime, pattern),
      { value: input },
    );
    await result.pull();

    const internal = getDerivedInternalCell(result, {
      partialCause: "output",
    });
    const scopedOutputLink = parseLink(internal.getRaw(), internal);
    expect(scopedOutputLink?.scope).toBe("user");
    expectUnavailable(
      runtime.getCellFromLink(scopedOutputLink!).getRaw(),
      "pending",
    );
  });

  it("parks a captured stream until it is available and never invokes terminal markers", async () => {
    const received: number[] = [];
    const setup = runtime.edit();
    const destination = runtime.getCell<unknown>(
      space,
      "availability-stream-destination",
      { asCell: ["stream"] },
      setup,
    );
    const cancel = runtime.scheduler.addEventHandler((_tx, event) => {
      received.push(event as number);
    }, destination.getAsNormalizedFullLink());
    const compiled = await runtime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents: `
import { action, AsyncResult, pattern, resultOf, Stream } from "commonfabric";
export default pattern<{ channel: AsyncResult<Stream<number>> }, { send: Stream<number> }>(({ channel }) => {
  const usable = resultOf(channel);
  const send = action((value: number) => usable.send(value));
  return { send };
});`,
      }],
    }, { space, tx: setup });
    const result = runtime.getCell<any>(space, "captured-stream-availability");
    runtime.run(setup, compiled, { channel: UNAVAILABLE_PENDING }, result);
    runtime.prepareTxForCommit(setup);
    expect((await setup.commit().settled).error).toBeUndefined();
    try {
      await result.pull();
      const completed = Promise.withResolvers<string>();
      let settled = false;
      completed.promise.then(() => settled = true);
      sendEvent(
        result.key("send"),
        5,
        (tx) => completed.resolve(tx.status().status),
      );
      await runtime.idle();
      expect(received).toEqual([]);
      expect(settled).toBe(false);

      const ready = runtime.edit();
      result.getArgumentCell()!.withTx(ready).key("channel").set(destination);
      expect((await ready.commit().settled).error).toBeUndefined();
      expect(await completed.promise).toBe("done");
      await runtime.idle();
      expect(received).toEqual([5]);

      const failed = runtime.edit();
      result.getArgumentCell()!.withTx(failed).key("channel").setRaw(
        unavailableError("The channel failed", "network"),
      );
      expect((await failed.commit().settled).error).toBeUndefined();
      const rejected = Promise.withResolvers<string>();
      sendEvent(
        result.key("send"),
        9,
        (tx) => rejected.resolve(tx.status().status),
      );
      expect(await rejected.promise).toBe("error");
      await runtime.idle();
      expect(received).toEqual([5]);
    } finally {
      cancel();
    }
  });

  it("replays a gated handler event once its captured input is available", async () => {
    let calls = 0;
    const valueAlias = {
      $alias: {
        cell: "argument",
        path: ["value"],
        scope: "space",
        schema: { type: "object" },
      },
    };
    const streamCause = { stream: "availability-handler" };
    const streamAlias = {
      $alias: {
        partialCause: streamCause,
        path: [],
        scope: "space",
        schema: true,
      },
    };
    const pattern = {
      argumentSchema: {},
      resultSchema: {
        type: "object",
        properties: {
          trigger: { asCell: ["stream", "opaque"] },
        },
      },
      derivedInternalCells: [{
        partialCause: streamCause,
        schema: { default: { $stream: true } },
        scope: "space",
      }],
      result: { trigger: streamAlias },
      nodes: [{
        module: {
          type: "javascript",
          wrapper: "handler",
          argumentSchema: {
            type: "object",
            properties: {
              $event: { type: "object" },
              $ctx: {
                type: "object",
                properties: { value: { type: "number" } },
              },
            },
            required: ["$ctx", "$event"],
          },
          implementation: () => {
            calls++;
          },
        },
        inputs: {
          $ctx: { value: valueAlias },
          $event: streamAlias,
        },
        outputs: {},
      }],
    } as Pattern;
    const resultCell = runtime.getCell<any>(
      space,
      `availability handler ${nextResultId++}`,
    );
    const result = await runtime.runSynced(
      resultCell,
      trustExecutable(runtime, pattern),
      { value: UNAVAILABLE_PENDING },
    );

    const eventCommitted = Promise.withResolvers<string>();
    let eventSettled = false;
    eventCommitted.promise.then(() => eventSettled = true);
    sendEvent(
      result.key("trigger"),
      {},
      (committedTx) => eventCommitted.resolve(committedTx.status().status),
    );

    await runtime.idle();
    expect(eventSettled).toBe(false);
    expect(calls).toBe(0);

    const syncingTx = runtime.edit();
    result.getArgumentCell()!.withTx(syncingTx).key("value").setRaw(
      UNAVAILABLE_SYNCING,
    );
    await syncingTx.commit().settled;
    await runtime.idle();
    expect(eventSettled).toBe(false);
    expect(calls).toBe(0);

    // Async producers wait for scheduler quiescence before publishing. A
    // parked handler must not hold idle() open, or the producer write which
    // wakes this event can never happen.
    const producerWrite = (async () => {
      await runtime.idle();
      const updateTx = runtime.edit();
      result.getArgumentCell()!.withTx(updateTx).key("value").set(7);
      await updateTx.commit().settled;
    })();
    await producerWrite;
    const commitStatus = await eventCommitted.promise;
    expect(commitStatus).toBe("done");
    await runtime.idle();
    await result.pull();
    expect(calls).toBe(1);

    const invalidEventCommitted = Promise.withResolvers<string>();
    const followingEventCommitted = Promise.withResolvers<string>();
    sendEvent(
      result.key("trigger"),
      "invalid event",
      (committedTx) =>
        invalidEventCommitted.resolve(committedTx.status().status),
    );
    sendEvent(
      result.key("trigger"),
      {},
      (committedTx) =>
        followingEventCommitted.resolve(committedTx.status().status),
    );
    const queuedStatuses = await Promise.all([
      invalidEventCommitted.promise,
      followingEventCommitted.promise,
    ]);
    expect(queuedStatuses).toEqual(["error", "done"]);
    await runtime.idle();
    expect(calls).toBe(2);

    for (
      const terminal of [
        unavailableError(new Error("terminal handler input")),
        unavailableMismatch(),
      ]
    ) {
      const terminalTx = runtime.edit();
      result.getArgumentCell()!.withTx(terminalTx).key("value").setRaw(
        terminal,
      );
      await terminalTx.commit().settled;

      const terminalCommitted = Promise.withResolvers<string>();
      sendEvent(
        result.key("trigger"),
        {},
        (committedTx) => terminalCommitted.resolve(committedTx.status().status),
      );
      const status = await terminalCommitted.promise;
      expect(status).toBe("error");
      expect(calls).toBe(2);
    }
  });
});
