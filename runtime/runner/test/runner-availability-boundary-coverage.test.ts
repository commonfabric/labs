import {
  FabricUnavailable,
  unavailableError,
} from "@commonfabric/data-model/availability";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { spy } from "@std/testing/mock";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import type { JSONSchema, Module, Pattern } from "../src/builder/types.ts";
import { getDerivedInternalCell } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import type { EventHandler } from "../src/scheduler/types.ts";
import {
  createTrustedBuilder,
  trustExecutable,
} from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase(
  "runner availability boundary coverage",
);

describe("runner availability boundary coverage", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let nextId = 0;

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

  async function runNode(options: {
    argument: unknown;
    module: Module;
    nodeInputs?: unknown;
  }): Promise<unknown> {
    const pattern = {
      argumentSchema: {},
      resultSchema: {},
      result: {
        output: { $alias: { partialCause: "output", path: [] } },
      },
      nodes: [{
        module: options.module,
        inputs: options.nodeInputs ?? {
          $alias: { cell: "argument", path: ["value"] },
        },
        outputs: { $alias: { partialCause: "output", path: [] } },
      }],
    } as Pattern;
    const resultCell = runtime.getCell(
      signer.did(),
      `availability-boundary-${nextId++}`,
    );
    const result = await runtime.runSynced(
      resultCell,
      trustExecutable(runtime, pattern),
      options.argument as never,
    );
    const output = getDerivedInternalCell(result, { partialCause: "output" });
    return await output.pull();
  }

  async function registerCapturedHandler(
    observed: unknown,
    observedSchema: JSONSchema,
  ): Promise<EventHandler> {
    const stateSchema: JSONSchema = {
      type: "object",
      properties: { observed: observedSchema },
      required: ["observed"],
    };
    const { handler, pattern } = createTrustedBuilder(runtime).commonfabric;
    const onEvent = handler(
      { type: "number" },
      stateSchema,
      () => {},
    );
    const HandlerPattern = pattern(
      ({ observed }) => ({ stream: onEvent({ observed }) }),
      stateSchema,
      {
        type: "object",
        properties: { stream: { type: "object" } },
        required: ["stream"],
      },
    );
    Object.assign(HandlerPattern.nodes[0].module, {
      type: "javascript-availability",
      unavailableInputPolicy: [{
        path: ["$event"],
        reasons: ["pending"],
      }],
    });

    const addHandler = spy(runtime.scheduler, "addEventHandler");
    try {
      const resultCell = runtime.getCell(
        signer.did(),
        `availability-handler-${nextId++}`,
      );
      const result = await runtime.runSynced(
        resultCell,
        HandlerPattern,
        { observed } as never,
      );
      await result.pull();

      const registered = addHandler.calls[0]?.args[0] as
        | EventHandler
        | undefined;
      expect(registered?.inputReadiness).toBeDefined();
      return registered!;
    } finally {
      addHandler.restore();
    }
  }

  it("requires policy metadata on availability modules", async () => {
    let calls = 0;
    await expect(runNode({
      argument: { value: "ready" },
      module: {
        type: "javascript-availability",
        argumentSchema: { type: "string" },
        implementation: () => {
          calls++;
          return "called";
        },
      },
    })).rejects.toThrow(
      /javascript-availability modules require policy metadata/,
    );
    expect(calls).toBe(0);
  });

  it("restores accepted unavailable markers nested in arrays", async () => {
    const marker = unavailableError(new Error("accepted array marker"));
    let received: unknown;
    const output = await runNode({
      argument: { marker },
      nodeInputs: [{
        $alias: { cell: "argument", path: ["marker"] },
      }],
      module: {
        type: "javascript-availability",
        argumentSchema: {
          type: "array",
          items: {
            anyOf: [{ type: "number" }, { type: "object" }],
          },
        },
        resultSchema: { type: "boolean" },
        unavailableInputPolicy: [{
          path: ["0"],
          reasons: ["error"],
        }],
        implementation: (value: unknown) => {
          received = value;
          return Array.isArray(value) &&
            value[0] instanceof FabricUnavailable &&
            value[0].reason === "error";
        },
      },
    });

    expect(received).toEqual([marker]);
    expect(output).toBe(true);
  });

  it("checks captured handler readiness without event-only policy", async () => {
    const registered = await registerCapturedHandler(
      unavailableError(new Error("captured failure")),
      {
        anyOf: [{ type: "string" }, { type: "object" }],
      },
    );
    let materializations = 0;
    runtime.runner.accessForTestingOnly.javascriptArgumentObserver = () => {
      materializations++;
    };
    const readinessTx = runtime.edit();
    try {
      expect(registered.inputReadiness!(readinessTx, 1)).toEqual({
        ready: false,
        reason: "error",
      });
      expect(materializations).toBe(0);
    } finally {
      readinessTx.abort("readiness probe complete");
      runtime.runner.accessForTestingOnly.javascriptArgumentObserver =
        undefined;
    }
  });

  it("leaves captured schema validation to dispatch", async () => {
    const registered = await registerCapturedHandler("not a number", {
      type: "number",
    });
    const readinessTx = runtime.edit();
    try {
      expect(registered.inputReadiness!(readinessTx, 1)).toEqual({
        ready: true,
      });
    } finally {
      readinessTx.abort("readiness probe complete");
    }
  });
});
