/**
 * Labels from a compiled pattern's label templates at commit, built without
 * the executor: a transaction reads labeled cells and records, with the
 * runtime's mark, the `plan-write` inputs the executor would record for its
 * writes, and the stored labels of the written paths are compared with and
 * without the experimental option `compiledPatterns`.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { FabricValue } from "@commonfabric/api";
import { hashStringOf } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";

import type { CompiledPlan } from "../src/cfc/compiled-plans.ts";
import { planWritesByTarget } from "../src/cfc/prepare.ts";
import {
  type CfcAddress,
  runtimeWritePolicyAuthorization,
  type WritePolicyInput,
} from "../src/cfc/types.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

const signer = await Identity.fromPassphrase("cfc-plan-labels");
const space = signer.did();

/** A plan with one body whose two write edges take one slot each. */
const plan: CompiledPlan = {
  outputs: [],
  bodies: [{
    writes: [
      { template: { op: "slot", slot: 0 } },
      { template: { op: "slot", slot: 1 } },
    ],
  }],
  cones: [],
  templates: [],
  collections: [],
  stateCells: [],
};

/** Runs `body` with a runtime whose `compiledPatterns` is `enabled`. */
const withRuntime = async (
  enabled: boolean,
  body: (runtime: Runtime) => Promise<void> | void,
): Promise<void> => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
    experimental: { compiledPatterns: enabled },
  });
  try {
    await body(runtime);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
};

/** A `plan-write` input for body 0's write `write` at `target`. */
const planWrite = (
  compiledPattern: string,
  target: CfcAddress,
  write: number,
  source: CfcAddress,
): Extract<WritePolicyInput, { kind: "plan-write" }> => ({
  kind: "plan-write",
  target,
  compiledPattern,
  record: { body: 0, write },
  instance: target.id,
  keys: [],
  slots: { [write]: { chain: [source], observes: "value" } },
});

const address = (id: string, path: readonly string[] = []): CfcAddress => ({
  space,
  id,
  scope: "space",
  path,
});

describe("cfc-plan-labels", () => {
  describe("CompiledPlanRegistry", () => {
    it("returns the content hash of the plan and the value code as the identity", async () => {
      await withRuntime(true, (runtime) => {
        const identity = runtime.compiledPlans.register(
          plan,
          "code",
          runtimeWritePolicyAuthorization,
        );
        expect(identity).toBe(
          hashStringOf({ plan: plan as unknown as FabricValue, code: "code" }),
        );
        expect(
          runtime.compiledPlans.register(
            plan,
            "other code",
            runtimeWritePolicyAuthorization,
          ),
        ).not.toBe(identity);
        expect(
          runtime.compiledPlans.plan(identity, runtimeWritePolicyAuthorization),
        ).toEqual(plan);
        expect(runtime.compiledPlans.plan(identity)).toBeUndefined();
      });
    });

    it("throws for a registration without the runtime's authorization", async () => {
      await withRuntime(true, (runtime) => {
        expect(() => runtime.compiledPlans.register(plan, "code")).toThrow();
      });
    });
  });

  describe("planWritesByTarget()", () => {
    it("returns an authorized input for a registered pattern with the option on", async () => {
      await withRuntime(true, (runtime) => {
        const identity = runtime.compiledPlans.register(
          plan,
          "code",
          runtimeWritePolicyAuthorization,
        );
        const tx = runtime.edit();
        try {
          const input = planWrite(
            identity,
            address("of:target", ["a"]),
            0,
            address("of:source"),
          );
          tx.recordCfcWritePolicyInput(input, runtimeWritePolicyAuthorization);
          const honored = [...planWritesByTarget(tx).values()].flat();
          expect(honored).toEqual([input]);
        } finally {
          tx.abort();
        }
      });
    });

    it("returns nothing for an input recorded without the runtime's authorization", async () => {
      await withRuntime(true, (runtime) => {
        const identity = runtime.compiledPlans.register(
          plan,
          "code",
          runtimeWritePolicyAuthorization,
        );
        const tx = runtime.edit();
        try {
          tx.recordCfcWritePolicyInput(
            planWrite(identity, address("of:t", ["a"]), 0, address("of:s")),
          );
          expect(planWritesByTarget(tx).size).toBe(0);
        } finally {
          tx.abort();
        }
      });
    });

    it("returns nothing for an identity the runtime did not register", async () => {
      await withRuntime(true, (runtime) => {
        const tx = runtime.edit();
        try {
          tx.recordCfcWritePolicyInput(
            planWrite(
              hashStringOf({
                plan: plan as unknown as FabricValue,
                code: "code",
              }),
              address("of:t", ["a"]),
              0,
              address("of:s"),
            ),
            runtimeWritePolicyAuthorization,
          );
          expect(planWritesByTarget(tx).size).toBe(0);
        } finally {
          tx.abort();
        }
      });
    });

    it("returns nothing with the option off", async () => {
      await withRuntime(false, (runtime) => {
        const identity = runtime.compiledPlans.register(
          plan,
          "code",
          runtimeWritePolicyAuthorization,
        );
        const tx = runtime.edit();
        try {
          tx.recordCfcWritePolicyInput(
            planWrite(identity, address("of:t", ["a"]), 0, address("of:s")),
            runtimeWritePolicyAuthorization,
          );
          expect(planWritesByTarget(tx).size).toBe(0);
        } finally {
          tx.abort();
        }
      });
    });
  });
});
