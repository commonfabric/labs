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
import {
  deriveFlowJoin,
  planLabelsFor,
  planWritesByTarget,
} from "../src/cfc/prepare.ts";
import {
  type CfcAddress,
  runtimeWritePolicyAuthorization,
  type WritePolicyInput,
} from "../src/cfc/types.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type {
  IExtendedStorageTransaction,
  IMemorySpaceAddress,
} from "../src/storage/interface.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";

const signer = await Identity.fromPassphrase("cfc-plan-labels");
const space = signer.did();

/**
 * A plan with one body whose write edges take slot 0, slot 1, slot 2 (bound
 * to a staged label in the cases that use it), and a selection between
 * slots 0 and 1 on slot 2.
 */
const plan: CompiledPlan = {
  outputs: [],
  bodies: [{
    writes: [
      { template: { op: "slot", slot: 0 } },
      { template: { op: "slot", slot: 1 } },
      { template: { op: "slot", slot: 2 } },
      {
        template: {
          op: "select",
          selector: 0,
          condition: { op: "slot", slot: 2 },
          branches: [{ op: "slot", slot: 0 }, { op: "slot", slot: 1 }],
        },
      },
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

/** The storage address of `path` in the document `id`, `value` included. */
const memoryAddress = (
  id: string,
  path: readonly string[],
): IMemorySpaceAddress => ({
  space,
  id: id as IMemorySpaceAddress["id"],
  type: "application/json",
  path: [...path],
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

  describe("planLabelsFor()", () => {
    /**
     * Seeds two source documents labeled `secret-a` and `secret-b`, then
     * runs `body` with a transaction that read both and wrote `{ a, b }` to
     * a target document, and the target's address.
     */
    const withSources = async (
      body: (
        runtime: Runtime,
        tx: IExtendedStorageTransaction,
        identity: string,
        target: CfcAddress,
      ) => void,
    ): Promise<void> => {
      await withRuntime(true, async (runtime) => {
        const seed = runtime.edit();
        writeSeedEnvelopeDoc(seed, space);
        for (const name of ["a", "b"]) {
          seedStoredEnvelope(seed, memoryAddress(`of:src-${name}`, []), {
            value: { text: name },
            cfc: {
              version: 1,
              schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
              labelMap: {
                version: 1,
                entries: [{
                  path: [],
                  label: { confidentiality: [`secret-${name}`] },
                }],
              },
            },
          });
        }
        expect((await seed.commit().settled).error).toBeUndefined();
        const identity = runtime.compiledPlans.register(
          plan,
          "code",
          runtimeWritePolicyAuthorization,
        );
        const tx = runtime.edit();
        try {
          tx.readOrThrow(memoryAddress("of:src-a", ["value"]));
          tx.readOrThrow(memoryAddress("of:src-b", ["value"]));
          const cell = runtime.getCell(space, "plan-target", undefined, tx);
          cell.set({ a: "x", b: "y" });
          const link = cell.getAsNormalizedFullLink();
          body(runtime, tx, identity, {
            space: link.space,
            id: link.id,
            scope: "space",
            path: [],
          });
        } finally {
          tx.abort();
        }
      });
    };

    /** The confidentiality planLabelsFor gives the target's path `name`. */
    const confidentialityAt = (
      labels: ReturnType<typeof planLabelsFor>,
      target: CfcAddress,
      name: string,
    ) =>
      [...labels.byTarget.values()].flatMap((paths) => [
        ...(paths.get(`/${name}`)?.confidentiality ?? []),
      ]);

    it("returns for each path the label of the slot its write is bound to", async () => {
      await withSources((_runtime, tx, identity, target) => {
        for (const [write, name] of [[0, "a"], [1, "b"]] as const) {
          tx.recordCfcWritePolicyInput(
            planWrite(
              identity,
              { ...target, path: [name] },
              write,
              address(`of:src-${name}`),
            ),
            runtimeWritePolicyAuthorization,
          );
        }
        const labels = planLabelsFor(tx, deriveFlowJoin(tx));
        expect(labels.reasons).toEqual([]);
        expect(confidentialityAt(labels, target, "a")).toEqual(["secret-a"]);
        expect(confidentialityAt(labels, target, "b")).toEqual(["secret-b"]);
      });
    });

    it("returns the label staged at an address the transaction wrote", async () => {
      await withSources((_runtime, tx, identity, target) => {
        tx.recordCfcWritePolicyInput(
          planWrite(
            identity,
            { ...target, path: ["a"] },
            0,
            address("of:src-a"),
          ),
          runtimeWritePolicyAuthorization,
        );
        tx.recordCfcWritePolicyInput(
          {
            ...planWrite(identity, { ...target, path: ["b"] }, 2, target),
            slots: { 2: { staged: { ...target, path: ["a"] } } },
          },
          runtimeWritePolicyAuthorization,
        );
        const labels = planLabelsFor(tx, deriveFlowJoin(tx));
        expect(labels.reasons).toEqual([]);
        expect(confidentialityAt(labels, target, "b")).toEqual(["secret-a"]);
      });
    });

    it("returns the bound of a selection that was not reported, and counts it", async () => {
      await withSources((runtime, tx, identity, target) => {
        const before = runtime.getCfcStats().planLabelBounds;
        tx.recordCfcWritePolicyInput(
          {
            ...planWrite(identity, { ...target, path: ["a"] }, 3, target),
            slots: {
              0: { chain: [address("of:src-a")], observes: "value" },
              1: { chain: [address("of:src-b")], observes: "value" },
              2: { chain: [address("of:src-a")], observes: "value" },
            },
          },
          runtimeWritePolicyAuthorization,
        );
        const labels = planLabelsFor(tx, deriveFlowJoin(tx));
        expect(confidentialityAt(labels, target, "a").sort()).toEqual([
          "secret-a",
          "secret-b",
        ]);
        expect(runtime.getCfcStats().planLabelBounds).toBe(before + 1);
      });
    });

    it("returns the selected branch alone where the selection was reported", async () => {
      await withSources((_runtime, tx, identity, target) => {
        tx.recordCfcWritePolicyInput(
          {
            ...planWrite(identity, { ...target, path: ["a"] }, 3, target),
            slots: {
              0: { chain: [address("of:src-a")], observes: "value" },
              1: { chain: [address("of:src-b")], observes: "value" },
              2: { chain: [address("of:src-a")], observes: "value" },
            },
            selections: { 0: 0 },
          },
          runtimeWritePolicyAuthorization,
        );
        const labels = planLabelsFor(tx, deriveFlowJoin(tx));
        expect(confidentialityAt(labels, target, "a")).toEqual(["secret-a"]);
      });
    });

    it("refuses a slot bound to an address the transaction did not read", async () => {
      await withSources((_runtime, tx, identity, target) => {
        tx.recordCfcWritePolicyInput(
          planWrite(
            identity,
            { ...target, path: ["a"] },
            0,
            address("of:never-read"),
          ),
          runtimeWritePolicyAuthorization,
        );
        const labels = planLabelsFor(tx, deriveFlowJoin(tx));
        expect(labels.reasons).toHaveLength(1);
        expect(labels.byTarget.size).toBe(0);
      });
    });

    it("refuses a staged slot at an address the transaction did not write", async () => {
      await withSources((_runtime, tx, identity, target) => {
        tx.recordCfcWritePolicyInput(
          {
            ...planWrite(identity, { ...target, path: ["a"] }, 2, target),
            slots: { 2: { staged: address("of:src-a") } },
          },
          runtimeWritePolicyAuthorization,
        );
        expect(planLabelsFor(tx, deriveFlowJoin(tx)).reasons).toHaveLength(1);
      });
    });

    it("refuses a write whose target the transaction did not write", async () => {
      await withSources((_runtime, tx, identity) => {
        tx.recordCfcWritePolicyInput(
          planWrite(
            identity,
            address("of:elsewhere", ["a"]),
            0,
            address("of:src-a"),
          ),
          runtimeWritePolicyAuthorization,
        );
        expect(planLabelsFor(tx, deriveFlowJoin(tx)).reasons).toHaveLength(1);
      });
    });

    it("refuses staged labels that form a cycle", async () => {
      await withSources((_runtime, tx, identity, target) => {
        for (const [from, to] of [["a", "b"], ["b", "a"]]) {
          tx.recordCfcWritePolicyInput(
            {
              ...planWrite(identity, { ...target, path: [from] }, 2, target),
              slots: { 2: { staged: { ...target, path: [to] } } },
            },
            runtimeWritePolicyAuthorization,
          );
        }
        expect(planLabelsFor(tx, deriveFlowJoin(tx)).reasons.length)
          .toBeGreaterThan(0);
      });
    });
  });
});
