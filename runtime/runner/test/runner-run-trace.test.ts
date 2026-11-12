/**
 * The `[RUN]` and `[PATTERN-NODE]` records the `runner.trigger-flow` logger
 * emits, at debug level, for each run of a pattern and each pattern node it
 * instantiates.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { getLogger, type Logger } from "@commonfabric/logger";

import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("runner run trace");
const space = signer.did();

describe("runner-run-trace", () => {
  let storage: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let logger: Logger;
  let original: Logger["debug"];
  let records: { key: string; parts: string[] }[];

  beforeEach(() => {
    storage = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
    });
    // Captured at the logger rather than at the console, so that neither the
    // logger's level nor `LOG_TO_STDERR` decides what the test sees. Each lazy
    // message is resolved the way the logger resolves it.
    logger = getLogger("runner.trigger-flow");
    original = logger.debug;
    records = [];
    logger.debug = (key, ...messages) => {
      records.push({
        key,
        parts: messages.flatMap((message) => {
          const resolved = typeof message === "function" ? message() : message;
          return Array.isArray(resolved) ? resolved.map(String) : [
            String(resolved),
          ];
        }),
      });
      original.call(logger, key, ...messages);
    };
  });

  afterEach(async () => {
    logger.debug = original;
    await runtime.dispose();
    await storage.close();
  });

  const recordsOf = (prefix: string) =>
    records.filter(({ key }) => key.startsWith(prefix)).map(({ parts }) =>
      parts
    );

  it("names the result of each run, and whether its caller gave a transaction", async () => {
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const plain = pattern<{ value: number }>(({ value }) => ({
      answer: lift((input: number) => input + 1)(value),
    }));
    const given = runtime.getCell(space, "run in a given transaction");
    const minted = runtime.getCell(space, "run in a minted transaction");

    const tx = runtime.edit();
    runtime.run(tx, plain, { value: 1 }, given.withTx(tx));
    expect((await tx.commit().settled).error).toBeUndefined();
    runtime.run(undefined, plain, { value: 1 }, minted);
    await runtime.idle();

    const runs = recordsOf("runner-run/");
    expect(runs).toHaveLength(2);
    expect(runs[0]).toEqual(expect.arrayContaining([
      "[RUN] source=none",
      `result=${given.getAsNormalizedFullLink().id}`,
      "providedTx=true",
    ]));
    expect(runs[1]).toEqual(expect.arrayContaining([
      `result=${minted.getAsNormalizedFullLink().id}`,
      "providedTx=false",
    ]));
    expect(recordsOf("instantiate-pattern-node/")).toEqual([]);
  });

  it("names the child of each pattern node a run instantiates", async () => {
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const inner = pattern<{ value: number }>(({ value }) => ({
      answer: lift((input: number) => input + 1)(value),
    }));
    const outer = pattern<{ value: number }>(({ value }) => ({
      child: inner({ value }),
    }));
    const result = runtime.getCell<{ child: unknown }>(space, "nesting run");

    const tx = runtime.edit();
    runtime.run(tx, outer, { value: 1 }, result.withTx(tx));
    expect((await tx.commit().settled).error).toBeUndefined();
    await runtime.idle();

    const nodes = recordsOf("instantiate-pattern-node/");
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toEqual(expect.arrayContaining([
      "[PATTERN-NODE] source=none",
      "sendToBindings=true",
    ]));
    expect(nodes[0].some((part) => part.startsWith("result="))).toBe(true);
    expect(nodes[0]).not.toContain(
      `result=${result.getAsNormalizedFullLink().id}`,
    );
  });
});
