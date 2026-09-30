import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import type { FabricValue } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { llmToolExecutionHelpers } from "../src/builtins/llm-dialog.ts";
import type { CfcConfClause } from "../src/cfc/clause.ts";
import { cfcObservationFitsCeiling } from "../src/cfc/observation.ts";
import { Runtime } from "../src/runtime.ts";

const signer = await Identity.fromPassphrase("llm-dialog-observation-ceiling");
const space = signer.did();

describe("effectiveObservationCeiling()", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  it("admits an atom holding a sparse array that the pattern's ceiling read as a view names", async () => {
    const atom = () => ({
      type: "custom-policy",
      parameters: new Array<string>(1),
    });
    const tx = runtime.edit();
    const cell = runtime.getCell<unknown>(
      space,
      "sparse-ceiling",
      undefined,
      tx,
    );
    tx.writeValueOrThrow(cell.getAsNormalizedFullLink(), {
      ceiling: [atom()],
    } as FabricValue);
    expect((await tx.commit()).error).toBeUndefined();
    const read = (cell.get() as { ceiling: CfcConfClause[] }).ceiling;

    // A sink the deployment names no ceiling for, so the pattern's bound is
    // the effective one.
    const effective = llmToolExecutionHelpers.effectiveObservationCeiling(
      runtime,
      "unbounded-sink",
      read,
    );

    expect(cfcObservationFitsCeiling([atom()], effective)).toBe(true);
  });
});
