import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";
import {
  createSchedulerTestRuntime,
  disposeSchedulerTestRuntime,
  type SchedulerTestRuntime,
  space,
} from "./scheduler-test-utils.ts";

type Item = { label: string };

/** A pattern whose computed reads the second row's required label. */
const PATTERN = [
  "import { computed, pattern } from 'commonfabric';",
  "type Item = { label: string };",
  "export default pattern<{ items: Item[] }, { second: string }>(",
  "  ({ items }) => ({ second: computed(() => items[1].label) }),",
  ");",
].join("\n");

describe("lift refusal disposition", () => {
  let env: SchedulerTestRuntime | undefined;

  afterEach(async () => {
    if (env !== undefined) await disposeSchedulerTestRuntime(env);
    env = undefined;
  });

  /**
   * Runs the pattern in the given posture over two valid rows, then replaces
   * the second row with one that lacks its required label, then repairs it.
   * Keeps the result demanded throughout and records each settled value and
   * anything that reached the error channel.
   */
  async function breakSecondRow(
    lazyMaterialization: boolean,
  ): Promise<
    {
      before: string | undefined;
      after: string | undefined;
      recovered: string | undefined;
      errors: Error[];
    }
  > {
    env = createSchedulerTestRuntime(import.meta.url, {
      experimental: { lazyMaterialization },
    });
    const { runtime, tx } = env;
    const compiled = await runtime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: PATTERN }],
    }, { space, tx });
    const items = runtime.getCell<Item[]>(space, "items", undefined, tx);
    items.set([{ label: "a" }, { label: "bb" }]);
    const argument = runtime.getCell<{ items: unknown }>(
      space,
      "argument",
      undefined,
      tx,
    );
    argument.set({ items });
    const result = runtime.getCell<{ second?: string }>(
      space,
      "result",
      compiled.resultSchema,
      tx,
    );
    runtime.run(tx, compiled, argument, result);
    await tx.commit();
    env.tx = runtime.edit();
    const second = result.key("second");
    const errors: Error[] = [];
    runtime.scheduler.onError((error) => {
      errors.push(error);
    });
    const cancel = second.sink(() => {});
    try {
      await runtime.settled(Infinity);
      const before = second.get();
      const write = runtime.edit();
      items.key(1).withTx(write).set({ note: 2 } as unknown as Item);
      expect((await write.commit()).error).toBeUndefined();
      await runtime.settled(Infinity);
      const after = second.get();

      const repair = runtime.edit();
      items.key(1).withTx(repair).set({ label: "recovered" });
      expect((await repair.commit()).error).toBeUndefined();
      await runtime.settled(Infinity);
      return { before, after, recovered: second.get(), errors };
    } finally {
      cancel();
    }
  }

  it("writes an undefined result when the body's synchronous read refuses under the view", async () => {
    const outcome = await breakSecondRow(true);
    expect(outcome.before).toBe("bb");
    expect(outcome.errors).toEqual([]);
    expect(outcome.after).toBeUndefined();
    expect(outcome.recovered).toBe("recovered");
  });

  it("writes an undefined result for the same data when the argument is read eagerly", async () => {
    const outcome = await breakSecondRow(false);
    expect(outcome.before).toBe("bb");
    expect(outcome.errors).toEqual([]);
    expect(outcome.after).toBeUndefined();
    expect(outcome.recovered).toBe("recovered");
  });
});
