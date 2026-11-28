/**
 * The memo of the pattern a JavaScript action's result names, which decides
 * whether the action's next run materializes that piece again, across a run
 * whose transaction does not commit.
 */

import { expect } from "@std/expect";
import { spy } from "@std/testing/mock";

import { Identity } from "@commonfabric/identity";
import { isObjectOrArray } from "@commonfabric/js-values/types";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("runner result pattern memo");
const space = signer.did();

describe("Runner's result-pattern memo", () => {
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

  it("drops the memo a run that does not commit wrote, and keeps one a later run wrote in its place", async () => {
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const inner = pattern<{ v: number }>(({ v }) => ({
      tripled: lift((input: number) => input * 3)(v),
    }));
    const startInner = (v: number) => inner({ v });
    const program = pattern<{ value: number }>(({ value }) => ({
      inner: lift(startInner)(value),
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
    expect(result.get()).toEqual({ inner: { tripled: 6 } });
    const action = registrations.calls.map((call) => call.args[0]).find((
      action,
    ) =>
      "module" in action && isObjectOrArray(action.module) &&
      action.module.implementation === startInner
    );
    expect(action).toBeDefined();

    // No memo is held once the run above has settled, so the next run
    // materializes the piece again and memoizes it.
    const cache = runtime.runner.accessForTestingOnly.resultPatternCache;
    expect(cache.size).toBe(0);
    const dropped = runtime.edit();
    action!(dropped);
    expect(cache.size).toBe(1);
    const [[docKey, memos]] = [...cache];
    expect(memos.size).toBe(1);
    const [[scopeKey, patternKey]] = [...memos];
    const memo = () => cache.get(docKey)?.get(scopeKey);

    // The run's abort takes its memo back.
    dropped.abort("the run does not commit");
    expect(cache.has(docKey)).toBe(false);

    // A memo a later run wrote in the meantime is not the aborted run's to
    // take back.
    const superseded = runtime.edit();
    action!(superseded);
    expect(memo()).toBe(patternKey);
    cache.get(docKey)!.set(scopeKey, "a later run's pattern");
    superseded.abort("the run does not commit");
    expect(memo()).toBe("a later run's pattern");
  });
});
