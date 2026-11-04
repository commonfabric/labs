// A lift running under lazy materialization.
//
// The runner marks the action's transaction, so the body reads the paths it
// touches and nothing else, and disposes of a reader that touches data its
// schema no longer describes the way it disposes of an argument that never
// resolved: an undefined result, not an error.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { type JSONSchema } from "../src/builder/types.ts";

const signer = await Identity.fromPassphrase("lazy-materialization-runner");
const space = signer.did();

const ITEM: JSONSchema = {
  type: "object",
  required: ["label"],
  properties: { label: { type: "string" } },
} as const;

const ARGUMENT: JSONSchema = {
  type: "object",
  properties: {
    items: { type: "array", items: ITEM },
    title: { type: "string" },
  },
} as const;

describe("lazy-materialization-runner", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  const start = (lazyMaterialization: boolean) => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      experimental: { lazyMaterialization },
    });
  };

  beforeEach(() => {
    storageManager = undefined as never;
    runtime = undefined as never;
  });
  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  /**
   * Run `body` as a lift over `input`, and report what it returned along with
   * which of the argument's paths the run registered a read for.
   */
  const runLift = async (
    cause: string,
    input: unknown,
    body: (argument: any) => unknown,
  ): Promise<unknown> => {
    const tx = runtime.edit();
    const inputCell = runtime.getCell(space, `${cause}-input`, undefined, tx);
    inputCell.set(input);
    await tx.commit().settled;

    const readTx = runtime.edit();
    if (runtime.experimental.lazyMaterialization) {
      readTx.markLazyMaterialize(true);
    }
    const argument = runtime
      .getCell(space, `${cause}-input`, ARGUMENT, readTx)
      .get();
    try {
      return body(argument);
    } finally {
      await readTx.commit().settled;
    }
  };

  it("hands the body a value it can read like a plain object", async () => {
    start(true);
    const result = await runLift(
      "plain",
      { items: [{ label: "a" }, { label: "b" }], title: "t" },
      (argument) => `${argument.title}:${argument.items.length}`,
    );
    expect(result).toBe("t:2");
  });

  it("agrees with an eager read on what the body sees", async () => {
    start(false);
    const eager = await runLift(
      "agree",
      { items: [{ label: "a" }], title: "t" },
      (argument) => JSON.stringify(argument),
    );
    await runtime.dispose();
    await storageManager.close();

    start(true);
    const lazy = await runLift(
      "agree",
      { items: [{ label: "a" }], title: "t" },
      (argument) => JSON.stringify(argument),
    );
    expect(lazy).toEqual(eager);
  });

  it("refuses when the body reaches an element the schema no longer describes", async () => {
    start(true);
    let refused = false;
    await runLift(
      "refuse",
      // The second element is missing the `label` the item schema requires.
      { items: [{ label: "a" }, { note: "b" }], title: "t" },
      (argument) => {
        try {
          return argument.items[1].label;
        } catch {
          refused = true;
        }
      },
    );
    expect(refused).toBe(true);
  });

  it("lets the body run when the mismatch is in an element it never reaches", async () => {
    start(true);
    const result = await runLift(
      "unreached",
      { items: [{ label: "a" }, { note: "b" }], title: "t" },
      (argument) => argument.items[0].label,
    );
    expect(result).toBe("a");
  });

  it("leaves reads unchanged when the flag is off", async () => {
    start(false);
    const result = await runLift(
      "flag-off",
      { items: [{ label: "a" }], title: "t" },
      (argument) => argument.title,
    );
    expect(result).toBe("t");
  });
});
