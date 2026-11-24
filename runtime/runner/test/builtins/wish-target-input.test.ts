import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";

import { UI } from "../../src/builder/types.ts";
import { wish } from "../../src/builtins/wish.ts";
import type { Cell } from "../../src/cell.ts";
import { Runtime } from "../../src/runtime.ts";
import { EmulatedStorageManager } from "../../src/storage/v2-emulate.ts";

const user = await Identity.fromPassphrase("wish target input");

describe("wish-target-input", () => {
  let runtime: Runtime;
  let cancels: (() => void)[];

  beforeEach(() => {
    runtime = new Runtime({
      apiUrl: new URL("https://example.invalid"),
      storageManager: EmulatedStorageManager.emulate({ as: user }),
      experimental: { serverExecution: false },
    });
    cancels = [];
  });

  afterEach(async () => {
    cancels.forEach((cancel) => cancel());
    await runtime.storageManager.synced();
    await runtime.dispose();
  });

  /** The state one run of a wish over `target` sends. */
  async function stateFor(
    label: string,
    target: unknown,
  ): Promise<Cell<unknown>> {
    const owner = runtime.getCell(user.did(), `${label} owner`);
    const input = runtime.getCell(user.did(), `${label} input`);
    const seed = runtime.edit();
    owner.withTx(seed).set({});
    input.withTx(seed).set(target);
    runtime.prepareTxForCommit(seed);
    expect((await seed.commit().settled).error).toBeUndefined();

    let output: Cell<unknown> | undefined;
    const builtin = wish(
      input as Cell<[unknown, unknown]>,
      (_tx, value) => {
        output = value as Cell<unknown>;
      },
      (cancel) => cancels.push(cancel),
      [owner],
      owner,
      runtime,
    );
    const tx = runtime.edit();
    builtin.action(tx);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await runtime.idle();
    expect(output).toBeDefined();
    return output!.withTx(undefined);
  }

  for (
    const { kind, target } of [
      { kind: "a string", target: "#journal" },
      { kind: "a number", target: 42 },
      { kind: "a record without a query", target: { scope: ["."] } },
    ]
  ) {
    it(`reports an unrecognized target when the input is ${kind}`, async () => {
      // The input is read as a wish's parameters, which a value of any other
      // shape does not match, so the target is read as absent.
      const state = await stateFor(kind, target);

      expect(state.key("error").get()).toBe(
        "Wish target is not recognized: `undefined`",
      );
      expect(state.key("result").get()).toBeUndefined();
      expect(state.key("candidates").get()).toEqual([]);
      expect(state.key(UI).get()).toBeDefined();
    });
  }

  it("reports a missing query, rather than an unrecognized target, when the input names an empty one", async () => {
    const state = await stateFor("empty query", { query: "" });

    expect(state.key("error").get()).toMatch(/has no query\.$/);
    expect(state.key("result").get()).toBeUndefined();
  });
});
