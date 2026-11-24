/**
 * How many write-policy inputs commit preparation examines when one
 * transaction writes many link slots of one labeled document. Each written
 * slot records one input, and the preparation decides for each slot what its
 * label mints, so the inputs examined per slot have to stay bounded for the
 * whole preparation to stay proportional to what was written.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";

import type { JSONSchema } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

const signer = await Identity.fromPassphrase("runner-cfc-link-slot-inputs");
const space = signer.did();

const LABELED: JSONSchema = {
  ifc: { confidentiality: [{ anyOf: [{ type: "space", id: space }] }] },
} as unknown as JSONSchema;

describe("cfc-prepare-link-slot-inputs", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cfcFlowLabels: "persist",
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  /**
   * Writes a labeled list of `slots` links in one transaction and returns how
   * many write-policy inputs the preparation of that commit asked the
   * transaction about, and how many inputs the transaction held.
   */
  const inputsExaminedWriting = async (
    slots: number,
  ): Promise<{ examined: number; recorded: number }> => {
    const members = Array.from(
      { length: slots },
      (_, index) =>
        runtime.getCell<{ title: string }>(space, `member ${slots} ${index}`),
    );
    const list = runtime.getCell<unknown[]>(space, `list ${slots}`, LABELED);
    const tx = runtime.edit();
    members.forEach((member, index) =>
      member.withTx(tx).set({ title: `t${index}` })
    );
    list.withTx(tx).set(members);

    let examined = 0;
    const isRuntimeWritePolicyInput = tx.isRuntimeWritePolicyInput.bind(tx);
    tx.isRuntimeWritePolicyInput = (input) => {
      examined++;
      return isRuntimeWritePolicyInput(input);
    };
    const recorded = tx.getCfcState().writePolicyInputs.length;
    runtime.prepareTxForCommit(tx);
    const { error } = await tx.commit().settled;
    expect(error).toBeUndefined();
    return { examined, recorded };
  };

  it("examines a bounded number of inputs for each link slot written", async () => {
    const small = await inputsExaminedWriting(40);
    const large = await inputsExaminedWriting(160);

    // Each slot records an input, so the case is one the count can grow in.
    expect(small.recorded).toBeGreaterThanOrEqual(40);
    expect(large.recorded).toBeGreaterThanOrEqual(160);

    // Four times the slots examine at most four times the inputs, with room
    // for what a preparation examines once whatever it wrote.
    expect(large.examined).toBeLessThanOrEqual(4 * small.examined + 64);
  });
});
