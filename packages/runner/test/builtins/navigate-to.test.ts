/**
 * Runs the `navigateTo` builtin's action directly, one transaction at a time,
 * to reach the run that comes after a navigation has already happened.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { entityRefToString } from "@commonfabric/data-model/cell-rep";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { navigateTo } from "../../src/builtins/navigate-to.ts";
import type { Cell } from "../../src/cell.ts";
import { Runtime } from "../../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("navigate-to", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let navigations: string[];

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    navigations = [];
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      navigateCallback: (target) => {
        navigations.push(entityRefToString(target.entityId));
      },
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  it("sets its result again, without navigating, when it runs after it has navigated", async () => {
    const setupTx = runtime.edit();
    const parentCell = runtime.getCell(
      space,
      "navigate-to run-again parent",
      undefined,
      setupTx,
    );
    const target = runtime.getCell(
      space,
      "navigate-to run-again target",
      undefined,
      setupTx,
    );
    target.set({ title: "target" });
    const inputs = runtime.getImmutableCell(
      space,
      target.getAsLink(),
      undefined,
      setupTx,
    );
    expect((await setupTx.commit()).error).toBeUndefined();

    let resultCell: Cell<boolean> | undefined;
    const sendResult = (_tx: IExtendedStorageTransaction, result: unknown) => {
      resultCell = result as Cell<boolean>;
    };
    const builtin = navigateTo(
      inputs,
      sendResult,
      () => {},
      [],
      parentCell,
      runtime,
    );

    const firstTx = runtime.edit();
    builtin.action(firstTx);
    expect((await firstTx.commit()).error).toBeUndefined();
    await runtime.settled();
    expect(navigations).toEqual([entityRefToString(target.entityId)]);

    // With the result cleared, a run that consulted it would navigate a second
    // time. The run below is held to the builtin's own record of having
    // navigated, which is what sends it down the path that only sets the
    // result.
    const clearTx = runtime.edit();
    resultCell!.withTx(clearTx).set(false);
    expect((await clearTx.commit()).error).toBeUndefined();

    const secondTx = runtime.edit();
    builtin.action(secondTx);
    expect((await secondTx.commit()).error).toBeUndefined();
    await runtime.settled();

    expect(navigations.length).toBe(1);
    const readTx = runtime.edit();
    expect(resultCell!.withTx(readTx).get()).toBe(true);
    await readTx.commit();
  });
});
