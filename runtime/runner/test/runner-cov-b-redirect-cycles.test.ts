/**
 * What a node's static read and write surfaces record for a binding whose
 * write redirects form a cycle. Collecting a node's redirects stops at a
 * redirect it has seen, so the cycle reaches the runner's static resolution,
 * which cannot resolve it.
 */

import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { getLogger } from "@commonfabric/logger";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

import type { Pattern } from "../src/builder/types.ts";
import type { Cell } from "../src/cell.ts";
import { getDerivedInternalCell } from "../src/link-utils.ts";
import { findAllWriteRedirectCells } from "../src/pattern-binding.ts";
import { resolveLink } from "../src/link-resolution.ts";
import { Runtime } from "../src/runtime.ts";
import { trustExecutable } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("runner-cov-b redirect cycles");
const space = signer.did();
const runnerLogger = getLogger("runner");

describe("runner redirect cycles", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let debugLines: string[];
  let level: typeof runnerLogger.level;
  let debug: typeof console.debug;
  let error: typeof console.error;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({ apiUrl: new URL(import.meta.url), storageManager });
    debugLines = [];
    level = runnerLogger.level;
    debug = console.debug;
    error = console.error;
    runnerLogger.level = "debug";
    console.debug = (...args: unknown[]) => {
      debugLines.push(args.map((arg) => Deno.inspect(arg)).join(" "));
    };
    console.error = () => {};
  });

  afterEach(async () => {
    console.debug = debug;
    console.error = error;
    runnerLogger.level = level;
    await runtime?.dispose();
    await storageManager?.close();
  });

  /**
   * Writes, into `resultCell`'s internal cells `loop` and `back`, write
   * redirects to each other, returning the two cells.
   */
  async function redirectLoop(resultCell: Cell<unknown>) {
    const tx = runtime.edit();
    const loop = getDerivedInternalCell(resultCell.withTx(tx), {
      partialCause: "loop",
    });
    const back = getDerivedInternalCell(resultCell.withTx(tx), {
      partialCause: "back",
    });
    loop.withTx(tx).setRaw(back.getAsWriteRedirectLink());
    back.withTx(tx).setRaw(loop.getAsWriteRedirectLink());
    expect((await tx.commit().settled).error).toBeUndefined();
    return { loop, back };
  }

  const loggedWith = (message: string) =>
    debugLines.filter((line) =>
      line.includes(message) && line.includes("Link cycle detected")
    ).length;

  it("collects both redirects of the cycle, which resolving either one throws on", async () => {
    const resultCell = runtime.getCell<unknown>(space, "cycle walk");
    const { loop, back } = await redirectLoop(resultCell);
    const tx = runtime.readTx();

    const found = findAllWriteRedirectCells(
      { out: loop.getAsWriteRedirectLink() },
      resultCell,
    );

    expect(found.map((link) => link.id)).toEqual([
      loop.getAsNormalizedFullLink().id,
      back.getAsNormalizedFullLink().id,
    ]);
    expect(() => resolveLink(runtime, tx, found[0], "writeRedirect")).toThrow(
      "Link cycle detected",
    );
  });

  it("registers an action whose output redirects into a cycle, logging the write target it could not resolve", async () => {
    const resultCell = runtime.getCell<unknown>(space, "cycle output");
    await redirectLoop(resultCell);
    const pattern: Pattern = {
      argumentSchema: {},
      resultSchema: {},
      result: {},
      nodes: [{
        module: { type: "javascript", implementation: () => 1 },
        inputs: {},
        outputs: { $alias: { partialCause: "loop", path: [] } },
      }],
    };

    runtime.run(
      undefined,
      trustExecutable(runtime, pattern),
      {} as never,
      resultCell as never,
    );
    await runtime.idle();

    expect(loggedWith("Unable to resolve static redirect write target"))
      .toBeGreaterThan(0);
    expect(loggedWith("Unable to resolve static read target")).toBe(0);
  });

  it("registers an action whose complete scope summary reads through a cycle, logging the read target it could not resolve", async () => {
    const resultCell = runtime.getCell<unknown>(space, "cycle input");
    await redirectLoop(resultCell);
    const pattern: Pattern = {
      argumentSchema: {},
      resultSchema: {},
      result: { result: { $alias: { partialCause: "result", path: [] } } },
      nodes: [{
        module: {
          type: "javascript",
          implementation: () => "ran",
          completeSchedulerScopeSummary: true,
        },
        inputs: { value: { $alias: { partialCause: "loop", path: [] } } },
        outputs: { $alias: { partialCause: "result", path: [] } },
      }],
    };

    runtime.run(
      undefined,
      trustExecutable(runtime, pattern),
      {} as never,
      resultCell as never,
    );
    await runtime.idle();

    expect(loggedWith("Unable to resolve static read target"))
      .toBeGreaterThan(0);
    expect(loggedWith("Unable to resolve static redirect write target"))
      .toBe(0);
  });

  it("dispatches to a handler whose state redirects into a cycle, logging the scheduler read it could not resolve", async () => {
    const resultCell = runtime.getCell<unknown>(space, "cycle handler");
    await redirectLoop(resultCell);
    const received: unknown[] = [];
    const pattern: Pattern = {
      argumentSchema: { type: "object", properties: {} },
      resultSchema: {},
      derivedInternalCells: [
        { partialCause: "events", schema: { asCell: ["stream"] } },
        { partialCause: "loop" },
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
        inputs: {
          $event: { $alias: { partialCause: "events", path: [] } },
          $ctx: { state: { $alias: { partialCause: "loop", path: [] } } },
        },
        outputs: {},
      }],
    };
    runtime.setup(
      undefined,
      trustExecutable(runtime, pattern),
      {} as never,
      resultCell as never,
    );
    expect(await runtime.start(resultCell)).toBe(true);
    expect(loggedWith("Unable to resolve scheduler read redirect")).toBe(0);

    runtime.scheduler.queueEvent(
      getDerivedInternalCell(resultCell, {
        partialCause: "events",
        schema: { asCell: ["stream"] },
      }).getAsNormalizedFullLink(),
      { n: 1 },
    );
    await runtime.idle();

    expect(loggedWith("Unable to resolve scheduler read redirect"))
      .toBeGreaterThan(0);
  });

  it("logs the failed write of an erroring action's undefined result, and reports the body's error", async () => {
    const failures: string[] = [];
    await runtime.dispose();
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      errorHandlers: [(error) => {
        failures.push(error.message);
      }],
    });
    const resultCell = runtime.getCell<unknown>(space, "cycle error output");
    await redirectLoop(resultCell);
    const errors: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };
    const pattern: Pattern = {
      argumentSchema: {},
      resultSchema: {},
      result: { out: { $alias: { partialCause: "loop", path: [] } } },
      nodes: [{
        module: {
          type: "javascript",
          implementation: () => {
            throw new Error("body failed");
          },
        },
        inputs: {},
        outputs: { $alias: { partialCause: "loop", path: [] } },
      }],
    };

    const running = runtime.run(
      undefined,
      trustExecutable(runtime, pattern),
      {} as never,
      resultCell as never,
    );
    await running.pull();
    await runtime.idle();

    expect(failures.some((message) => message.includes("body failed")))
      .toBe(true);
    expect(
      errors.filter((args) =>
        args.some((arg) =>
          String(arg).includes("Failed to write undefined to binding on error")
        )
      ).length,
    ).toBeGreaterThan(0);
  });
});
