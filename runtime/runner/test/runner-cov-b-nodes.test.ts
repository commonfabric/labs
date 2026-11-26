/**
 * Node shapes a hand-built pattern can hold that compiled patterns rarely do:
 * a sub-pattern node whose outputs are a plain link, and a handler handed an
 * event with a field named `preventDefault`.
 */

import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

import type { Pattern } from "../src/builder/types.ts";
import { getDerivedInternalCell } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { trustExecutable } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("runner-cov-b nodes");
const space = signer.did();

const innerPattern = {
  argumentSchema: {
    type: "object",
    properties: { input: { type: "number" } },
  },
  resultSchema: {},
  result: { $alias: { partialCause: "output", path: [], defer: 1 } },
  nodes: [{
    module: { type: "passthrough" },
    inputs: {
      value: { $alias: { cell: "argument", path: ["input"], defer: 1 } },
    },
    outputs: {
      value: { $alias: { partialCause: "output", path: [], defer: 1 } },
    },
  }],
} as Pattern;

describe("runner nodes", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({ apiUrl: new URL(import.meta.url), storageManager });
  });

  afterEach(async () => {
    await runtime?.storageManager.synced();
    await runtime?.dispose();
    await storageManager?.close();
  });

  describe("a sub-pattern node", () => {
    it("runs its child in the cell its outputs link to", async () => {
      const tx = runtime.edit();
      const target = runtime.getCell<unknown>(space, "plain target", {}, tx);
      const outer = {
        argumentSchema: {
          type: "object",
          properties: { value: { type: "number" } },
        },
        resultSchema: {},
        result: {},
        nodes: [{
          module: { type: "pattern", implementation: innerPattern },
          inputs: {
            input: { $alias: { cell: "argument", path: ["value"] } },
          },
          outputs: target.getAsLink(),
        }],
      } as Pattern;
      const resultCell = runtime.getCell(space, "plain outputs", undefined, tx);
      runtime.run(
        tx,
        trustExecutable(runtime, outer),
        { value: 5 } as never,
        resultCell as never,
      );
      await tx.commit().settled;
      await runtime.idle();

      expect(target.get()).toBe(5);
      expect(runtime.runner.isRunning(target)).toBe(true);
    });
  });

  describe("a handler node", () => {
    it("hands the body an event whose `preventDefault` field is data", async () => {
      // An event reaches a handler as data: a field named `preventDefault`
      // is one more field, not a method the runner calls.

      const received: unknown[] = [];
      const pattern: Pattern = {
        argumentSchema: { type: "object", properties: {} },
        resultSchema: {},
        derivedInternalCells: [
          { partialCause: "events", schema: { asCell: ["stream"] } },
        ],
        result: {},
        nodes: [{
          module: {
            type: "javascript",
            wrapper: "handler",
            implementation: (event: unknown) => {
              received.push(event);
            },
          },
          inputs: { $event: { $alias: { partialCause: "events", path: [] } } },
          outputs: {},
        }],
      };
      const resultCell = runtime.getCell(space, "handler preventDefault");
      runtime.setup(
        undefined,
        trustExecutable(runtime, pattern),
        {} as never,
        resultCell as never,
      );
      expect(await runtime.start(resultCell)).toBe(true);
      const events = getDerivedInternalCell(resultCell, {
        partialCause: "events",
        schema: { asCell: ["stream"] },
      }).getAsNormalizedFullLink();

      runtime.scheduler.queueEvent(events, { n: 1, preventDefault: true });
      runtime.scheduler.queueEvent(events, { n: 2 });
      await runtime.idle();

      expect(received).toEqual([{ n: 1, preventDefault: true }, { n: 2 }]);
    });
  });
});
