/**
 * The `[SETUP]` record the `runner.trigger-flow` logger emits, at debug level,
 * for each pattern setup: which result it set up, and the pattern identity it
 * replaced and installed.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { getLogger, type Logger } from "@commonfabric/logger";

import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("runner setup trace");
const space = signer.did();

describe("runner-setup-trace", () => {
  let storage: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let logger: Logger;
  let original: Logger["debug"];
  let records: string[][];

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
      if (key.startsWith("setup-internal/")) {
        records.push(messages.flatMap((message) => {
          const resolved = typeof message === "function" ? message() : message;
          return Array.isArray(resolved) ? resolved.map(String) : [
            String(resolved),
          ];
        }));
      }
      original.call(logger, key, ...messages);
    };
  });

  afterEach(async () => {
    logger.debug = original;
    await runtime.dispose();
    await storage.close();
  });

  it("names the result, the replaced identity, and the installed identity of each setup", async () => {
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const first = pattern<{ value: number }>(({ value }) => ({
      answer: lift((input: number) => input + 1)(value),
    }));
    const second = pattern<{ value: number }>(({ value }) => ({
      answer: lift((input: number) => input + 10)(value),
    }));
    const result = runtime.getCell<{ answer: number }>(
      space,
      "traced-piece",
      first.resultSchema,
    );
    const id = result.getAsNormalizedFullLink().id;

    const tx = runtime.edit();
    runtime.setup(tx, first, { value: 1 }, result.withTx(tx));
    expect((await tx.commit().settled).error).toBeUndefined();
    const firstIdentity = runtime.runner.sessionPatternPointerFor(result)
      ?.identity;
    const again = runtime.edit();
    runtime.setup(again, second, { value: 1 }, result.withTx(again));
    expect((await again.commit().settled).error).toBeUndefined();
    const secondIdentity = runtime.runner.sessionPatternPointerFor(result)
      ?.identity;

    expect(firstIdentity).toBeDefined();
    expect(secondIdentity).toBeDefined();
    expect(secondIdentity).not.toBe(firstIdentity);
    expect(records.length).toBe(2);
    expect(records[0]).toEqual(expect.arrayContaining([
      "[SETUP] source=none",
      `result=${id}`,
      "previousPatternIdentity=none",
      `nextPatternIdentity=${firstIdentity}`,
    ]));
    expect(records[1]).toEqual(expect.arrayContaining([
      `result=${id}`,
      `previousPatternIdentity=${firstIdentity}`,
      `nextPatternIdentity=${secondIdentity}`,
    ]));
  });
});
