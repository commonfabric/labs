import { expect } from "@std/expect";
import { spy, stub } from "@std/testing/mock";

import { Identity } from "@commonfabric/identity";
import { isObjectOrArray } from "@commonfabric/js-values/types";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

import type { Pattern } from "../src/builder/types.ts";
import { getDerivedInternalCell } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import type { Action } from "../src/scheduler/types.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import {
  localReadFailure,
  restrictToLocalReads,
} from "../src/storage/local-read-policy.ts";
import {
  createTrustedBuilder,
  trustExecutable,
} from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("runner local read errors");
const space = signer.did();

describe("runner-local-read-errors", () => {
  let storage: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storage = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storage.close();
  });

  it("refuses, on its local basis, to start the piece a JavaScript action's result names", async () => {
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const inner = pattern<{ v: number }>(({ v }) => ({
      tripled: lift((input: number) => input * 3)(v),
    }));
    const startInner = (v: number) => inner({ v });
    const double = (v: number) => v * 2;
    const program = pattern<{ value: number }>(({ value }) => ({
      inner: lift(startInner)(value),
      doubled: lift(double)(value),
    }));
    using registrations = spy(runtime.scheduler, "subscribe");
    const result = runtime.run(
      undefined,
      program,
      { value: 2 },
      runtime.getCell(space, "pattern-valued result"),
    );
    await result.pull();
    await runtime.idle();
    expect(result.get()).toMatchObject({ inner: { tripled: 6 }, doubled: 4 });
    const actionRunning = (implementation: unknown) => {
      const action = registrations.calls.map((call) => call.args[0]).find(
        (action) =>
          "module" in action && isObjectOrArray(action.module) &&
          action.module.implementation === implementation,
      );
      expect(action).toBeDefined();
      return action!;
    };

    const runLocally = async (action: Action) => {
      const tx = runtime.edit();
      restrictToLocalReads(tx.tx);
      try {
        const thrown = await Promise.resolve().then(() => action(tx)).then(
          () => undefined,
          (error: unknown) => error,
        );
        return { thrown, failure: localReadFailure(tx) };
      } finally {
        tx.abort();
      }
    };

    const refused = await runLocally(actionRunning(startInner));
    expect(refused.failure?.address.id).toBe(
      result.getAsNormalizedFullLink().id,
    );
    expect(refused.thrown).toBe(refused.failure);
    expect(await runLocally(actionRunning(double))).toEqual({
      thrown: undefined,
      failure: undefined,
    });
  });

  for (const asyncBody of [false, true]) {
    for (
      const failure of ["input", "replaced-input", "output", "body"] as const
    ) {
      it(`handles ${asyncBody ? "an asynchronous" : "a synchronous"} JavaScript action's ${failure} failure on its local basis`, async () => {
        const input = runtime.getCell<number>(space, "input");
        await runtime.editWithRetry((tx) => input.withTx(tx).set(41));
        const bodyError = new Error("body failed");
        let failBody = false;
        const compute = (argument: { value: number }) => {
          if (failBody) throw bodyError;
          try {
            return argument.value + 1;
          } catch (error) {
            if (failure === "replaced-input") throw bodyError;
            throw error;
          }
        };
        const pattern: Pattern = {
          argumentSchema: {},
          resultSchema: { type: "number" },
          derivedInternalCells: [{ partialCause: "output" }],
          result: { $alias: { partialCause: "output", path: [] } },
          nodes: [{
            module: {
              type: "javascript",
              argumentSchema: {
                type: "object",
                properties: { value: { type: "number" } },
                required: ["value"],
              },
              implementation: asyncBody
                ? (argument: { value: number }) =>
                  Promise.resolve().then(() => compute(argument))
                : compute,
            },
            inputs: { value: input.getAsWriteRedirectLink() },
            outputs: { $alias: { partialCause: "output", path: [] } },
          }],
        };
        using registrations = spy(runtime.scheduler, "subscribe");
        const result = runtime.run(
          undefined,
          trustExecutable(runtime, pattern),
          {},
          runtime.getCell(space, "result"),
        );
        await result.pull();
        await runtime.idle();
        expect(result.get()).toBe(42);
        const output = getDerivedInternalCell(result, {
          partialCause: "output",
        });
        const action = registrations.calls.map((call) => call.args[0]).find(
          (action) => "module" in action,
        ) as Action;
        expect(action).toBeDefined();
        failBody = failure === "body" || failure === "output";
        const unavailableId = failure === "output"
          ? output.getAsNormalizedFullLink().id
          : input.getAsNormalizedFullLink().id;
        const tx = runtime.edit();
        restrictToLocalReads(
          tx.tx,
          () => (address) => failure === "body" || address.id !== unavailableId,
        );
        using errors = stub(console, "error");
        try {
          const thrown = await Promise.resolve().then(() => action(tx)).then(
            () => undefined,
            (error: unknown) => error,
          );
          expect(thrown).toBe(
            failure === "input" ? localReadFailure(tx) : bodyError,
          );
          if (failure === "body") {
            expect(localReadFailure(tx)).toBeUndefined();
            expect(output.withTx(tx).get()).toBeUndefined();
            expect(tx.hasWrites()).toBe(true);
          } else {
            expect(localReadFailure(tx)).toBeDefined();
            expect(tx.hasWrites()).toBe(false);
            const outcome = await tx.commit().settled;
            expect(outcome.error?.name).toBe("StorageTransactionAborted");
            expect(output.get()).toBe(42);
          }
          expect(errors.calls).toHaveLength(0);
        } finally {
          tx.abort();
        }
      });
    }
  }
});
