/**
 * What a running action does with an argument that does not match its schema,
 * with a refusal its body caught, and with a body that asks to be run again.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { hasSchemaMismatch } from "@commonfabric/data-model/availability";
import { getLogger } from "@commonfabric/logger";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import type { Pattern } from "../src/builder/types.ts";
import type { Cell } from "../src/cell.ts";
import { Runtime } from "../src/runtime.ts";
import { RetryImmediately } from "../src/scheduler/retry-immediately.ts";
import { trustExecutable } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("runner-cov-b action arguments");
const space = signer.did();
const runnerLogger = getLogger("runner");

/** A one-node pattern running `implementation` over the argument's `value`. */
function doubling(
  implementation: (value: any) => unknown,
  argumentSchema: Pattern["argumentSchema"],
): Pattern {
  return {
    argumentSchema: {},
    resultSchema: {},
    result: { result: { $alias: { partialCause: "result", path: [] } } },
    nodes: [{
      module: { type: "javascript", implementation, argumentSchema },
      inputs: { $alias: { cell: "argument", path: ["value"] } },
      outputs: { $alias: { partialCause: "result", path: [] } },
    }],
  };
}

/** Runs `body` with the runner's info lines collected rather than printed. */
async function collectingInfo(body: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const level = runnerLogger.level;
  const log = console.log;
  runnerLogger.level = "info";
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    await body();
  } finally {
    console.log = log;
    runnerLogger.level = level;
  }
  return lines;
}

describe("runner action arguments", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
  });

  afterEach(async () => {
    await runtime?.storageManager.synced();
    await runtime?.dispose();
    await storageManager?.close();
  });

  function start(pattern: Pattern, argument: unknown, cause: string) {
    const tx = runtime.edit();
    const resultCell = runtime.getCell<{ result?: unknown }>(
      space,
      cause,
      undefined,
      tx,
    );
    const result = runtime.run(
      tx,
      trustExecutable(runtime, pattern),
      argument as never,
      resultCell as never,
    ) as Cell<{ result?: unknown }>;
    tx.commit();
    return result;
  }

  it("skips an action whose argument mismatches its schema, and runs it once the argument matches", async () => {
    runtime = new Runtime({ apiUrl: new URL(import.meta.url), storageManager });
    const seen: unknown[] = [];
    let result!: Cell<{ result?: unknown }>;
    const lines = await collectingInfo(async () => {
      result = start(
        doubling((value: number) => {
          seen.push(value);
          return value * 2;
        }, { type: "number" }),
        { value: "two" },
        "mismatching argument",
      );
      await result.pull();
      expect(hasSchemaMismatch(result.key("result").get())).toBe(true);
      expect(seen).toEqual([]);

      const argument = result.getArgumentCell<{ value: unknown }>()!;
      const tx = runtime.edit();
      argument.withTx(tx).key("value").set(2);
      await tx.commit().settled;
      expect(await result.pull()).toEqual({ result: 4 });
    });

    expect(seen).toEqual([2]);
    expect(lines.filter((line) => line.includes("not running")).length)
      .toBe(1);
    expect(lines.filter((line) => line.includes("valid now -- running")).length)
      .toBe(1);
  });

  it("writes no result for a body that caught a schema refusal", async () => {
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      experimental: { lazyMaterialization: true },
    });
    let caught: unknown;
    const schema = {
      type: "object",
      properties: { n: { type: "number" } },
      required: ["n"],
    } as const;
    const body = (value: { n: number }) => {
      try {
        return value.n * 2;
      } catch (error) {
        caught = error;
        return "built on a refused read";
      }
    };

    let refused!: Cell<{ result?: unknown }>;
    let matching!: Cell<{ result?: unknown }>;
    const lines = await collectingInfo(async () => {
      refused = start(doubling(body, schema), { value: { n: "bad" } }, "r");
      await refused.pull();
      expect(hasSchemaMismatch(refused.key("result").get())).toBe(true);
      matching = start(doubling(body, schema), { value: { n: 3 } }, "m");
      expect(await matching.pull()).toEqual({ result: 6 });
    });

    expect(caught).toBeInstanceOf(Error);
    expect(
      lines.filter((line) => line.includes("stopped matching its schema"))
        .length,
    ).toBe(1);
  });

  it("runs an action again when its body throws `RetryImmediately`", async () => {
    runtime = new Runtime({ apiUrl: new URL(import.meta.url), storageManager });
    let runs = 0;
    const result = start(
      doubling((value: number) => {
        runs++;
        if (runs === 1) throw new RetryImmediately();
        return value * 2;
      }, { type: "number" }),
      { value: 5 },
      "retrying body",
    );

    expect(await result.pull()).toEqual({ result: 10 });
    expect(runs).toBe(2);
  });

  describe("an implementation no verified registry entry backs", () => {
    /** Runs a module whose implementation is `source`, counting the runner's log keys. */
    async function runFromSource(
      module: Record<string, unknown>,
      cause: string,
    ) {
      runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
      });
      const before = structuredClone(runnerLogger.countsByKey);
      const debugLines: string[] = [];
      const level = runnerLogger.level;
      const debug = console.debug;
      const error = console.error;
      runnerLogger.level = "debug";
      console.debug = (...args: unknown[]) => {
        debugLines.push(args.map(String).join(" "));
      };
      console.error = () => {};
      let value: unknown;
      try {
        const result = start(
          {
            ...doubling(() => undefined, { type: "number" }),
            nodes: [{
              module: { type: "javascript", ...module },
              inputs: { $alias: { cell: "argument", path: ["value"] } },
              outputs: { $alias: { partialCause: "result", path: [] } },
            }],
          } as Pattern,
          { value: 4 },
          cause,
        );
        value = await result.pull();
      } finally {
        console.debug = debug;
        console.error = error;
        runnerLogger.level = level;
      }
      const delta = (key: string, kind: "debug" | "error") =>
        (runnerLogger.countsByKey[key]?.[kind] ?? 0) -
        (before[key]?.[kind] ?? 0);
      return {
        value,
        debugLines,
        downgrades: delta("verified-fallback-downgrade", "debug"),
        unverified: delta("unverified-source-fallback", "error"),
      };
    }

    it("runs the source of a module whose `$implRef` resolves to nothing, logging the downgrade", async () => {
      const run = await runFromSource({
        implementation: "(value) => value * 3",
        $implRef: { identity: "of:fid1:unregistered", symbol: "triple" },
      }, "unresolved implRef");

      expect(run.value).toEqual({ result: 12 });
      expect([run.downgrades, run.unverified]).toEqual([1, 0]);
      expect(
        run.debugLines.some((line) =>
          line.includes("Verified function resolution missed")
        ),
      ).toBe(true);
    });

    it("counts a module with no `$implRef` as unverified source instead", async () => {
      const run = await runFromSource({
        implementation: "(value) => value * 3",
      }, "no implRef");

      expect(run.value).toEqual({ result: 12 });
      expect([run.downgrades, run.unverified]).toEqual([0, 1]);
    });
  });
});
