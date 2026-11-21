/**
 * Labels from a compiled pattern's label templates at commit, built without
 * the executor: a transaction reads labeled cells and records, with the
 * runtime's mark, the `plan-write` inputs the executor would record for its
 * writes, and the stored labels of the written paths are compared with and
 * without the experimental option `compiledPatterns`.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import type { FabricValue } from "@commonfabric/api";
import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import { hashStringOf } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";

import type { CompiledPlan } from "../src/cfc/compiled-plans.ts";
import { readStoredCfcMetadata } from "../src/cfc/metadata.ts";
import { observedDocumentKey } from "../src/cfc/observation-label.ts";
import {
  deriveFlowJoin,
  planLabelsFor,
  planWritesByTarget,
} from "../src/cfc/prepare.ts";
import {
  type CfcAddress,
  type PlanElements,
  runtimeWritePolicyAuthorization,
  type SlotBindings,
  type WritePolicyInput,
} from "../src/cfc/types.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import type {
  IExtendedStorageTransaction,
  IMemorySpaceAddress,
} from "../src/storage/interface.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("cfc-plan-labels");
const space = signer.did();

/**
 * A plan with one body whose write edges take slot 0, slot 1, slot 2 (bound
 * to a staged label in the cases that use it), a selection between slots 0
 * and 1 on slot 2, a fold of slot 3 over the elements of collection 0, a
 * constant, and a fold of slot 3 over the elements of collection 1, a
 * `filter` over slot 0 whose membership template is that fold; an output of
 * slot 0; and a kept output with no template.
 */
const plan: CompiledPlan = {
  outputs: [{ template: { op: "slot", slot: 0 } }, { kept: true }],
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
      {
        template: {
          op: "fold",
          collection: 0,
          body: { op: "slot", slot: 3 },
        },
      },
      { template: { op: "const" } },
      {
        template: {
          op: "fold",
          collection: 1,
          body: { op: "slot", slot: 3 },
        },
      },
    ],
  }],
  cones: [],
  templates: [],
  collections: [
    { membership: { op: "const" } },
    {
      membership: {
        op: "fold",
        collection: 1,
        body: { op: "slot", slot: 3 },
      },
      source: { slot: 0 },
    },
  ],
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
    servingPosture: true,
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
      ) => void | Promise<void>,
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
          await body(runtime, tx, identity, {
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
    ) => [
      ...(labels.byTarget.get(observedDocumentKey(target))?.get(`/${name}`)
        ?.confidentiality ?? []),
    ];

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

    it("joins, for a slot whose read reached further positions through links in its value, the label of each of them", async () => {
      // The read of a value that holds a link observes the value and what
      // the link leads to: the binding lists the second position as a chain
      // below the slot's own, and the label holds the clauses of both.
      await withSources((_runtime, tx, identity, target) => {
        tx.recordCfcWritePolicyInput(
          {
            ...planWrite(
              identity,
              { ...target, path: ["a"] },
              0,
              address("of:src-a"),
            ),
            slots: {
              0: {
                chain: [address("of:src-a")],
                observes: "value",
                below: [[address("of:src-b")]],
              },
            },
          },
          runtimeWritePolicyAuthorization,
        );
        const labels = planLabelsFor(tx, deriveFlowJoin(tx));
        expect(labels.reasons).toEqual([]);
        expect(confidentialityAt(labels, target, "a").sort()).toEqual([
          "secret-a",
          "secret-b",
        ]);
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

    it("returns, for a staged address below a path a write covers, the label of that write", async () => {
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
            slots: { 2: { staged: { ...target, path: ["a", "inner"] } } },
          },
          runtimeWritePolicyAuthorization,
        );
        const labels = planLabelsFor(tx, deriveFlowJoin(tx));
        expect(labels.reasons).toEqual([]);
        // The transaction's join holds `secret-b` too, which a staged
        // address no write covers takes.
        expect(confidentialityAt(labels, target, "b")).toEqual(["secret-a"]);
      });
    });

    it("returns the join for a staged address below the target of the write that reads it", async () => {
      await withSources((_runtime, tx, identity, target) => {
        tx.recordCfcWritePolicyInput(
          {
            ...planWrite(identity, { ...target, path: ["a"] }, 2, target),
            slots: { 2: { staged: { ...target, path: ["a", "inner"] } } },
          },
          runtimeWritePolicyAuthorization,
        );
        const labels = planLabelsFor(tx, deriveFlowJoin(tx));
        expect(labels.reasons).toEqual([]);
        expect(confidentialityAt(labels, target, "a").sort()).toEqual([
          "secret-a",
          "secret-b",
        ]);
      });
    });

    it("joins, for a binding read after the transaction wrote the end of its chain, the label staged there with the label of each position below it", async () => {
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
            slots: {
              2: {
                chain: [{ ...target, path: ["a"] }],
                observes: "value",
                below: [[address("of:src-b")]],
                staged: true,
              },
            },
          },
          runtimeWritePolicyAuthorization,
        );
        const labels = planLabelsFor(tx, deriveFlowJoin(tx));
        expect(labels.reasons).toEqual([]);
        expect(confidentialityAt(labels, target, "b").sort()).toEqual([
          "secret-a",
          "secret-b",
        ]);
      });
    });

    it("reads a position of such a binding that the write itself covers as it was stored", async () => {
      await withSources((_runtime, tx, identity, target) => {
        tx.recordCfcWritePolicyInput(
          {
            ...planWrite(identity, { ...target, path: ["b"] }, 2, target),
            slots: {
              2: {
                chain: [address("of:src-a")],
                observes: "value",
                below: [[{ ...target, path: ["b"] }]],
                staged: true,
              },
            },
          },
          runtimeWritePolicyAuthorization,
        );
        const labels = planLabelsFor(tx, deriveFlowJoin(tx));
        expect(labels.reasons).toEqual([]);
        expect(confidentialityAt(labels, target, "b")).toEqual(["secret-a"]);
      });
    });

    it("takes as the membership of a collection over the array an output computes the label of that output", async () => {
      await withSources((runtime, tx, _identity, target) => {
        // Collection 1 is a `filter` whose membership template is its own
        // fold: here it iterates output 0, the template of slot 0.
        const overOutput = runtime.compiledPlans.register(
          {
            ...plan,
            collections: [plan.collections[0], {
              ...plan.collections[1],
              source: { output: 0 },
            }],
          },
          "code",
          runtimeWritePolicyAuthorization,
        );
        tx.recordCfcWritePolicyInput(
          {
            kind: "plan-write",
            target: { ...target, path: ["a"] },
            compiledPattern: overOutput,
            record: { body: 0, write: 6 },
            instance: target.id,
            keys: [],
            slots: {},
            elements: {
              1: {
                uniform: {
                  slots: {
                    3: { chain: [address("of:src-a")], observes: "value" },
                  },
                },
              },
            },
            outputs: {
              0: {
                slots: {
                  0: { chain: [address("of:src-b")], observes: "value" },
                },
              },
            },
          },
          runtimeWritePolicyAuthorization,
        );
        const labels = planLabelsFor(tx, deriveFlowJoin(tx));
        expect(labels.reasons).toEqual([]);
        expect(confidentialityAt(labels, target, "a").sort()).toEqual([
          "secret-a",
          "secret-b",
        ]);
      });
    });

    /** `plan` with a `wish` whose operands are slot 0. */
    const wishPlan: CompiledPlan = {
      ...plan,
      operations: [{ kind: "wish", input: { op: "slot", slot: 0 } }, {
        kind: "reduce",
      }],
      dynamicReads: [{ why: { kind: "search", operation: 0 } }],
    };

    /** A `plan-write` input for the outcome of operation `operation`. */
    const outcomeWrite = (
      runtime: Runtime,
      target: CfcAddress,
      operation: number,
    ): Extract<WritePolicyInput, { kind: "plan-write" }> => ({
      kind: "plan-write",
      target,
      compiledPattern: runtime.compiledPlans.register(
        wishPlan,
        "code",
        runtimeWritePolicyAuthorization,
      ),
      record: { operation },
      instance: target.id,
      keys: [],
      slots: { 0: { chain: [address("of:src-a")], observes: "value" } },
      dynamic: { 0: [address("of:src-b")] },
    });

    it("returns for the outcome of a `wish` the label of its operands joined with the label of what its resolution read, with no integrity", async () => {
      await withSources((runtime, tx, _identity, target) => {
        tx.recordCfcWritePolicyInput(
          outcomeWrite(runtime, { ...target, path: ["a"] }, 0),
          runtimeWritePolicyAuthorization,
        );
        const labels = planLabelsFor(tx, deriveFlowJoin(tx));
        expect(labels.reasons).toEqual([]);
        expect(confidentialityAt(labels, target, "a").sort()).toEqual([
          "secret-a",
          "secret-b",
        ]);
        expect(
          labels.byTarget.get(observedDocumentKey(target))?.get("/a")
            ?.integrity,
        ).toEqual([]);
      });
    });

    it("returns for the outcome of a `wish` that read nothing the label of its operands alone", async () => {
      await withSources((runtime, tx, _identity, target) => {
        tx.recordCfcWritePolicyInput(
          {
            ...outcomeWrite(runtime, { ...target, path: ["a"] }, 0),
            dynamic: { 0: [] },
          },
          runtimeWritePolicyAuthorization,
        );
        const labels = planLabelsFor(tx, deriveFlowJoin(tx));
        expect(labels.reasons).toEqual([]);
        expect(confidentialityAt(labels, target, "a")).toEqual(["secret-a"]);
      });
    });

    it("refuses a write that names as its `wish` an operation of another kind", async () => {
      await withSources((runtime, tx, _identity, target) => {
        tx.recordCfcWritePolicyInput(
          outcomeWrite(runtime, { ...target, path: ["a"] }, 1),
          runtimeWritePolicyAuthorization,
        );
        const labels = planLabelsFor(tx, deriveFlowJoin(tx));
        expect(labels.reasons).toHaveLength(1);
        expect(labels.reasons[0]).toContain("is no `wish` of the plan");
      });
    });

    it("mints for expression code of a pattern compiled in the atom of that pattern's entry of the plan's patterns", async () => {
      // PL §3.2, "The atom of the pattern": "code of a pattern B compiled
      // into a pattern A mints B's atom", entry `pattern` of
      // `Plan.patterns`, so the atom is the same in every plan that holds
      // the code.
      const compiledIn: CompiledPlan = {
        ...plan,
        patterns: ["pattern-a", "pattern-b"],
        bodies: [{
          writes: [
            ...plan.bodies[0].writes,
            {
              template: {
                op: "derive",
                by: { expression: true, pattern: 1 },
                inputs: [{ op: "slot", slot: 7 }],
              },
            },
          ],
        }],
      };
      await withSources((runtime, tx, _identity, target) => {
        const identity = runtime.compiledPlans.register(
          compiledIn,
          "code",
          runtimeWritePolicyAuthorization,
        );
        tx.recordCfcWritePolicyInput(
          planWrite(
            identity,
            { ...target, path: ["a"] },
            7,
            address("of:src-a"),
          ),
          runtimeWritePolicyAuthorization,
        );
        const labels = planLabelsFor(tx, deriveFlowJoin(tx));
        expect(labels.reasons).toEqual([]);
        const integrity = labels.byTarget.get(observedDocumentKey(target))
          ?.get("/a")?.integrity ?? [];
        expect(integrity).toContainEqual({
          type: CFC_ATOM_TYPE.TransformedBy,
          identity: { kind: "compiled", pattern: "pattern-b" },
        });
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

    it("returns the transaction's join for an output the plan has no template for, and counts it as a bound", async () => {
      await withSources((runtime, tx, identity, target) => {
        const before = runtime.getCfcStats().planLabelBounds;
        tx.recordCfcWritePolicyInput(
          {
            kind: "plan-write",
            target: { ...target, path: ["a"] },
            compiledPattern: identity,
            record: { output: 1 },
            instance: target.id,
            keys: [],
            slots: {},
          },
          runtimeWritePolicyAuthorization,
        );
        const labels = planLabelsFor(tx, deriveFlowJoin(tx));
        expect(labels.reasons).toEqual([]);
        expect(confidentialityAt(labels, target, "a").sort()).toEqual([
          "secret-a",
          "secret-b",
        ]);
        expect(runtime.getCfcStats().planLabelBounds).toBe(before + 1);
      });
    });

    it("returns the transaction's join for a record of an envelope and for a record given as bound", async () => {
      await withSources((_runtime, tx, identity, target) => {
        tx.recordCfcWritePolicyInput(
          {
            kind: "plan-write",
            target: { ...target, path: ["a"] },
            compiledPattern: identity,
            record: { body: 0, envelope: 0 },
            instance: target.id,
            keys: [],
            slots: {},
          },
          runtimeWritePolicyAuthorization,
        );
        tx.recordCfcWritePolicyInput(
          {
            ...planWrite(
              identity,
              { ...target, path: ["b"] },
              0,
              address("of:src-a"),
            ),
            bound: true,
          },
          runtimeWritePolicyAuthorization,
        );
        const labels = planLabelsFor(tx, deriveFlowJoin(tx));
        expect(labels.reasons).toEqual([]);
        for (const name of ["a", "b"]) {
          expect(confidentialityAt(labels, target, name).sort()).toEqual([
            "secret-a",
            "secret-b",
          ]);
        }
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

    it("joins the label of a list's membership for a slot bound to a position of the list that holds no member, and not for one that holds a member", async () => {
      await withSources(async (runtime, tx, identity, target) => {
        const seed = runtime.edit();
        seedStoredEnvelope(seed, memoryAddress("of:src-list", []), {
          value: { list: ["x", "y"] },
          cfc: {
            version: 1,
            schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
            labelMap: {
              version: 1,
              entries: [{
                path: ["list"],
                label: { confidentiality: ["secret-members"] },
                origin: "derived",
                observes: "enumerate",
              }],
            },
          },
        });
        expect((await seed.commit().settled).error).toBeUndefined();
        for (const [name, position] of [["a", "5"], ["b", "1"]] as const) {
          tx.recordCfcWritePolicyInput(
            {
              ...planWrite(
                identity,
                { ...target, path: [name] },
                0,
                address("of:src-list", ["list", position]),
              ),
              slots: {
                0: {
                  chain: [address("of:src-list", ["list", position])],
                  observes: "value",
                },
              },
            },
            runtimeWritePolicyAuthorization,
          );
        }
        const labels = planLabelsFor(tx, deriveFlowJoin(tx));
        expect(labels.reasons).toEqual([]);
        expect(confidentialityAt(labels, target, "a")).toEqual([
          "secret-members",
        ]);
        expect(confidentialityAt(labels, target, "b")).toEqual([]);
      });
    });

    it("resolves a slot bound to an address the transaction did not read from the label stored there, without reading its value", async () => {
      // Ruling (c): a template label may rest on labels observed in an
      // earlier transaction. The pre-pass observes the stored label of the
      // address in the committing transaction and reads no value there.
      await withSources(async (runtime, tx, identity, target) => {
        const seed = runtime.edit();
        seedStoredEnvelope(seed, memoryAddress("of:src-c", []), {
          value: { text: "c" },
          cfc: {
            version: 1,
            schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
            labelMap: {
              version: 1,
              entries: [{ path: [], label: { confidentiality: ["secret-c"] } }],
            },
          },
        });
        expect((await seed.commit().settled).error).toBeUndefined();
        tx.recordCfcWritePolicyInput(
          planWrite(
            identity,
            { ...target, path: ["a"] },
            0,
            address("of:src-c"),
          ),
          runtimeWritePolicyAuthorization,
        );
        const labels = planLabelsFor(tx, deriveFlowJoin(tx));
        expect(labels.reasons).toEqual([]);
        expect(confidentialityAt(labels, target, "a")).toEqual(["secret-c"]);
        // The transaction's value reads are as they were: its join does
        // not hold the clause. It journaled a read of the label metadata of
        // `of:src-c`, which the commit validates, and no read of its value.
        expect(deriveFlowJoin(tx).confidentiality).not.toContain("secret-c");
        const reads = [...tx.getReadActivities!()].filter((read) =>
          read.id === "of:src-c"
        );
        expect(reads.some((read) => read.path[0] === "cfc")).toBe(true);
        expect(reads.some((read) => read.path[0] === "value")).toBe(false);
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

  describe("commit", () => {
    /**
     * Seeds two sources labeled `secret-a` and `secret-b` and a target
     * holding `{ a, b }`, enrolled as a store the runtime owns, then runs a
     * transaction that reads both sources, writes `a` and `b`, and lets
     * `record` record its inputs. Returns the commit's error and the
     * confidentiality of the target's `value` and `shape` entries by path.
     */
    const commitWrites = async (
      enabled: boolean,
      record: (
        tx: IExtendedStorageTransaction,
        identity: string,
        target: CfcAddress,
        runtime: Runtime,
      ) => void,
      writeRoot: boolean | FabricValue = false,
      options: {
        /** Whether the transaction reads `of:src-a`. */
        readA?: boolean;
        /** Whether the transaction reads `of:src-b`. */
        readB?: boolean;
        /** Runs after `record` and before the transaction commits. */
        beforeCommit?: (runtime: Runtime) => Promise<void>;
        /** The plan registered, `plan` where absent. */
        plan?: CompiledPlan;
        /** What the transaction writes at `a`, where not `"x"`. */
        a?: (runtime: Runtime) => FabricValue;
      } = {},
    ) => {
      let outcome:
        | {
          error: unknown;
          value: Record<string, unknown[]>;
          shape: Record<string, unknown[]>;
          /** Every derived entry, as `observes /path` to its label. */
          derived: Record<string, unknown>;
        }
        | undefined;
      await withRuntime(enabled, async (runtime) => {
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
        const targetCell = runtime.getCell(
          space,
          "plan-target",
          undefined,
          seed,
        );
        targetCell.set({ a: "", b: "" });
        const link = targetCell.getAsNormalizedFullLink();
        const target: CfcAddress = {
          space: link.space,
          id: link.id,
          scope: "space",
          path: [],
        };
        seed.enrollRuntimeOwnedStore(
          target,
          "plan-labels-test",
          runtimeWritePolicyAuthorization,
        );
        expect((await seed.commit().settled).error).toBeUndefined();
        const identity = runtime.compiledPlans.register(
          options.plan ?? plan,
          "code",
          runtimeWritePolicyAuthorization,
        );
        const tx = runtime.edit();
        if (options.readA !== false) {
          tx.readOrThrow(memoryAddress("of:src-a", ["value"]));
        }
        if (options.readB !== false) {
          tx.readOrThrow(memoryAddress("of:src-b", ["value"]));
        }
        const cell = runtime.getCell(space, "plan-target", undefined, tx);
        if (writeRoot !== false) {
          tx.writeValueOrThrow(
            { ...link, path: [] },
            writeRoot === true ? { a: "x", b: "y", c: "z" } : writeRoot,
          );
        } else if (options.a !== undefined) {
          tx.writeValueOrThrow({ ...link, path: ["a"] }, options.a(runtime));
          cell.key("b").set("y");
        } else {
          cell.key("a").set("x");
          cell.key("b").set("y");
        }
        record(tx, identity, target, runtime);
        await options.beforeCommit?.(runtime);
        const { error } = await tx.commit().settled;
        const reader = runtime.edit();
        try {
          const metadata = readStoredCfcMetadata(reader, {
            space,
            id: target.id,
            scope: "space",
            type: "application/json",
          });
          const at = (observes: string) =>
            Object.fromEntries(
              (metadata?.labelMap.entries ?? [])
                .filter((entry) =>
                  entry.origin === "derived" && entry.observes === observes
                )
                .map((entry) => [
                  `/${entry.path.join("/")}`,
                  [...(entry.label.confidentiality ?? [])].sort(),
                ]),
            );
          const derived = Object.fromEntries(
            (metadata?.labelMap.entries ?? [])
              .filter((entry) => entry.origin === "derived")
              .map((entry) => [
                `${entry.observes} /${entry.path.join("/")}`,
                entry.label,
              ]),
          );
          outcome = {
            error,
            value: at("value"),
            shape: at("shape"),
            derived,
          };
        } finally {
          reader.abort();
        }
      });
      return outcome!;
    };

    /** Records the two authorized writes, each bound to its own source. */
    const recordBoth = (
      tx: IExtendedStorageTransaction,
      identity: string,
      target: CfcAddress,
    ) => {
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
    };

    it("stores each path's own source's label with the option on", async () => {
      const { error, value, shape } = await commitWrites(true, recordBoth);
      expect(error).toBeUndefined();
      expect(value["/a"]).toEqual(["secret-a"]);
      expect(value["/b"]).toEqual(["secret-b"]);
      expect(shape["/a"]).toEqual(["secret-a"]);
      expect(shape["/b"]).toEqual(["secret-b"]);
    });

    it("stores the label of a write as the `enumerate` entry of the array it writes and of each array inside the value written", async () => {
      const { error, derived } = await commitWrites(
        true,
        recordBoth,
        false,
        {
          a: () => ({ rows: [["x"], ["y", "z"]], names: ["n"], count: 2 }),
        },
      );
      expect(error).toBeUndefined();
      for (const path of ["/a/rows", "/a/rows/0", "/a/rows/1", "/a/names"]) {
        expect(derived[`enumerate ${path}`]).toEqual({
          confidentiality: ["secret-a"],
        });
      }
      expect(derived["enumerate /a"]).toBeUndefined();
      expect(derived["enumerate /a/count"]).toBeUndefined();
    });

    it("stores no `enumerate` entry for an array inside a value written with the option off", async () => {
      const { error, derived } = await commitWrites(
        false,
        recordBoth,
        false,
        { a: () => ({ rows: [["x"]] }) },
      );
      expect(error).toBeUndefined();
      expect(
        Object.keys(derived).filter((key) => key.startsWith("enumerate")),
      ).toEqual([]);
    });

    it("stores each covered path's own label below a path written whole, beside the join there", async () => {
      const { error, value, shape } = await commitWrites(
        true,
        (tx, identity, target) => {
          recordBoth(tx, identity, target);
          tx.recordCfcWritePolicyInput(
            {
              kind: "plan-write",
              target: { ...target, path: ["c"] },
              compiledPattern: identity,
              record: { body: 0, write: 5 },
              instance: target.id,
              keys: [],
              slots: {},
            },
            runtimeWritePolicyAuthorization,
          );
        },
        true,
      );
      expect(error).toBeUndefined();
      // A covered path whose label is empty stores entries all the same,
      // which replace the written path's join down there.
      expect(value["/c"]).toEqual([]);
      expect(shape["/c"]).toEqual([]);
      expect(value["/"]).toEqual(["secret-a", "secret-b"]);
      expect(value["/a"]).toEqual(["secret-a"]);
      expect(value["/b"]).toEqual(["secret-b"]);
      expect(shape["/a"]).toEqual(["secret-a"]);
      expect(shape["/b"]).toEqual(["secret-b"]);
    });

    /** Records body 0's write `write` at `items/<index>` for each source. */
    const recordItems = (sources: readonly string[]) =>
    (
      tx: IExtendedStorageTransaction,
      identity: string,
      target: CfcAddress,
    ) => {
      sources.forEach((name, index) => {
        tx.recordCfcWritePolicyInput(
          planWrite(
            identity,
            { ...target, path: ["items", String(index)] },
            0,
            address(`of:src-${name}`),
          ),
          runtimeWritePolicyAuthorization,
        );
      });
    };

    it("stores one entry at `*` for the elements of an array written whole whose covered labels are equal", async () => {
      const { error, value, shape } = await commitWrites(
        true,
        recordItems(["a", "a", "a"]),
        { items: ["x", "y", "z"] },
      );
      expect(error).toBeUndefined();
      expect(value["/items/*"]).toEqual(["secret-a"]);
      expect(shape["/items/*"]).toEqual(["secret-a"]);
      expect(Object.keys(value).filter((path) => /\/\d+$/.test(path)))
        .toEqual([]);
    });

    it("stores an entry per element where the covered labels of the elements differ", async () => {
      const { error, value } = await commitWrites(
        true,
        recordItems(["a", "b", "a"]),
        { items: ["x", "y", "z"] },
      );
      expect(error).toBeUndefined();
      expect(value["/items/*"]).toBeUndefined();
      expect(value["/items/1"]).toEqual(["secret-b"]);
    });

    it("stores the atom of a kept output that passes a reference on, on the entry of the link at the output's path", async () => {
      // PL §3.2, "Where the atom of a kept output is stored": "A kept
      // output that passes a value on by reference stores a link, and the
      // atom is in the label of the link at the output path."
      const kept: CompiledPlan = {
        ...plan,
        outputs: [{ template: { op: "slot", slot: 0 }, kept: true }],
      };
      const { error, derived } = await commitWrites(
        true,
        (tx, identity, target) => {
          tx.recordCfcWritePolicyInput(
            {
              kind: "plan-write",
              target: { ...target, path: ["a"] },
              compiledPattern: identity,
              record: { output: 0 },
              instance: target.id,
              keys: [],
              slots: {
                0: { chain: [address("of:src-a")], observes: "followRef" },
              },
            },
            runtimeWritePolicyAuthorization,
          );
        },
        false,
        {
          plan: kept,
          a: () =>
            ({
              "/": { "link@1": { id: "of:src-a", path: [], space } },
            }) as unknown as FabricValue,
        },
      );
      expect(error).toBeUndefined();
      const atLink = Object.entries(derived).filter(([where]) =>
        where.endsWith(" /a")
      );
      expect(atLink.length).toBeGreaterThan(0);
      expect(JSON.stringify(atLink)).toContain(CFC_ATOM_TYPE.TransformedBy);
    });

    it("stores the label of a kept output written by a transaction whose join is empty", async () => {
      // Every commit of a compiled pattern is prepared (PL §3.2, "Every
      // commit is prepared"), so every kept output it writes carries the
      // atom, a commit that read no labeled data included.
      const kept: CompiledPlan = {
        ...plan,
        outputs: [{ template: { op: "const" }, kept: true }],
      };
      const { error, derived } = await commitWrites(
        true,
        (tx, identity, target) => {
          tx.recordCfcWritePolicyInput(
            {
              kind: "plan-write",
              target: { ...target, path: ["a"] },
              compiledPattern: identity,
              record: { output: 0 },
              instance: target.id,
              keys: [],
              slots: {},
            },
            runtimeWritePolicyAuthorization,
          );
        },
        false,
        { plan: kept, readA: false, readB: false },
      );
      expect(error).toBeUndefined();
      expect(JSON.stringify(derived["value /a"])).toContain(
        CFC_ATOM_TYPE.TransformedBy,
      );
    });

    describe("for changes of the members of a list in place", () => {
      /**
       * Seeds three sources labeled `secret-a`, `secret-b` and `secret-c`
       * and a target, enrolled as a store the runtime owns, and commits
       * three transactions on it, each recording what the executor records
       * for it. The first reads `a` and writes the list `["x", "y", "z"]`
       * whole. The second reads `b` and appends `"w"`. The third reads `c`,
       * compares the first two members and removes the second, which moves
       * the two members behind it. With `again`, a fourth reads `b` and
       * appends `"v"`, at the position the removal left without a member.
       * Returns the confidentiality of each derived entry of the target as
       * `observes /path`, and of each `structure` entry as
       * `structure observes /path`.
       */
      const changed = async (again = false) => {
        let derived: Record<string, unknown[]> = {};
        await withRuntime(true, async (runtime) => {
          const seed = runtime.edit();
          writeSeedEnvelopeDoc(seed, space);
          for (const name of ["a", "b", "c"]) {
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
          const targetCell = runtime.getCell(
            space,
            "plan-list-target",
            undefined,
            seed,
          );
          targetCell.set({ list: [] });
          const link = targetCell.getAsNormalizedFullLink();
          const target: CfcAddress = {
            space: link.space,
            id: link.id,
            scope: "space",
            path: [],
          };
          seed.enrollRuntimeOwnedStore(
            target,
            "plan-labels-test",
            runtimeWritePolicyAuthorization,
          );
          expect((await seed.commit().settled).error).toBeUndefined();
          const identity = runtime.compiledPlans.register(
            plan,
            "code",
            runtimeWritePolicyAuthorization,
          );
          const at = (...path: string[]): CfcAddress => ({ ...target, path });
          const membership = [
            {
              address: at("list", "length"),
              observes: "value" as const,
              alone: true as const,
            },
            { address: at("list"), observes: "shape" as const },
          ];
          const commit = async (
            source: string,
            writes: [string[], FabricValue][],
            records: (
              record: (
                path: string[],
                more?: Partial<
                  Extract<WritePolicyInput, { kind: "plan-write" }>
                >,
              ) => void,
            ) => void,
          ) => {
            const tx = runtime.edit();
            tx.readOrThrow(memoryAddress(`of:src-${source}`, ["value"]));
            for (const [path, value] of writes) {
              tx.writeValueOrThrow({ ...link, path }, value);
            }
            const write = ["a", "b", "c"].indexOf(source);
            records((path, more = {}) =>
              tx.recordCfcWritePolicyInput(
                {
                  ...planWrite(
                    identity,
                    at(...path),
                    write,
                    address(`of:src-${source}`),
                  ),
                  ...more,
                },
                runtimeWritePolicyAuthorization,
              )
            );
            expect((await tx.commit().settled).error).toBeUndefined();
          };
          await commit("a", [[["list"], ["x", "y", "z"]]], (record) => {
            record(["list"]);
          });
          await commit(
            "b",
            [[["list", "length"], 4], [["list", "3"], "w"]],
            (record) => {
              record(["list", "3"], { observed: membership });
              record(["list", "length"], { observed: membership });
              record(["list"], { observed: membership, enumeration: true });
            },
          );
          const decided = [
            { address: at("list"), observes: "shape" as const },
            { address: at("list", "0"), observes: "value" as const },
            { address: at("list", "1"), observes: "value" as const },
          ];
          await commit(
            "c",
            [
              [["list", "length"], 3],
              [["list", "1"], "z"],
              [["list", "2"], "w"],
            ],
            (record) => {
              record(["list", "length"], { decided, observed: membership });
              record(["list"], {
                decided,
                observed: membership,
                enumeration: true,
                removes: true,
                moves: [{ from: 2, to: 1, count: 2 }],
                start: 1,
              });
            },
          );
          if (again) {
            await commit(
              "b",
              [[["list", "length"], 4], [["list", "3"], "v"]],
              (record) => {
                record(["list", "3"], { observed: membership });
                record(["list", "length"], { observed: membership });
                record(["list"], { observed: membership, enumeration: true });
              },
            );
          }
          const reader = runtime.edit();
          try {
            const metadata = readStoredCfcMetadata(reader, {
              space,
              id: target.id,
              scope: "space",
              type: "application/json",
            });
            derived = Object.fromEntries(
              (metadata?.labelMap.entries ?? [])
                .filter((entry) =>
                  entry.origin === "derived" || entry.origin === "structure"
                )
                .map((entry) => [
                  `${
                    entry.origin === "structure" ? "structure " : ""
                  }${entry.observes} /${entry.path.join("/")}`,
                  [...(entry.label.confidentiality ?? [])].sort(),
                ]),
            );
          } finally {
            reader.abort();
          }
        });
        return derived;
      };

      it("stores what the list stored of its membership joined with what decided each change as the `enumerate` entry of the list", async () => {
        const derived = await changed();
        expect(derived["enumerate /list"]).toEqual([
          "secret-a",
          "secret-b",
          "secret-c",
        ]);
        expect(derived["value /list/length"]).toEqual([
          "secret-a",
          "secret-b",
          "secret-c",
        ]);
      });

      it("leaves the entries of the list and of the member before the removed one as they were", async () => {
        const derived = await changed();
        expect(derived["value /list"]).toEqual(["secret-a"]);
        expect(derived["value /list/0"]).toBeUndefined();
      });

      it("moves the stored entries of a member the removal moved to the position it stands at, as they were", async () => {
        const derived = await changed();
        // The member appended under `b` stood at position 3, and the one
        // that stood at position 2 has no entry of its own.
        expect(derived["value /list/2"]).toEqual(["secret-a", "secret-b"]);
        expect(derived["value /list/1"]).toBeUndefined();
      });

      it("stores what decided the removal once, at the `*` path of the list, for a read of the value and of the existence of a position", async () => {
        const derived = await changed();
        // The comparison observed which positions the list has, so what
        // decided the removal holds what the list stored of its membership.
        const decision = ["secret-a", "secret-b", "secret-c"];
        expect(derived["structure value /list/*"]).toEqual(decision);
        expect(derived["structure shape /list/*"]).toEqual(decision);
      });

      it("stores no entry at the position the removal left without a member", async () => {
        const derived = await changed();
        expect(derived["value /list/3"]).toBeUndefined();
        expect(derived["shape /list/3"]).toBeUndefined();
      });

      it("mints the existence entry of that position again when a member is added there, with what the list stores of its membership by then", async () => {
        const derived = await changed(true);
        expect(derived["shape /list/3"]).toEqual([
          "secret-a",
          "secret-b",
          "secret-c",
        ]);
        expect(derived["value /list/3"]).toEqual([
          "secret-a",
          "secret-b",
          "secret-c",
        ]);
      });
    });

    describe("for a record given again because a label changed alone", () => {
      /**
       * Seeds sources labeled `secret-a` and `secret-b` and a target, and
       * commits a transaction that writes `{ x: "1" }` at `a` with a record
       * of `a` bound to source `a` and one of `a/x`, that of a kept output,
       * bound to source `b`.
       * Then commits a transaction that writes nothing and gives the record
       * of `a` again, bound to source `b`, as one that left the value as it
       * was; with `relabel`, as one whose label alone is formed again.
       * Returns the confidentiality of the target's derived `value` entries,
       * and the text of the integrity of the one at `a/x`.
       */
      const givenAgain = async (relabel: boolean) => {
        let value: Record<string, unknown[]> = {};
        let integrity = "";
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
          const cell = runtime.getCell(space, "plan-relabel", undefined, seed);
          cell.set({ a: {} });
          const link = cell.getAsNormalizedFullLink();
          const target: CfcAddress = {
            space: link.space,
            id: link.id,
            scope: "space",
            path: [],
          };
          seed.enrollRuntimeOwnedStore(
            target,
            "plan-labels-test",
            runtimeWritePolicyAuthorization,
          );
          expect((await seed.commit().settled).error).toBeUndefined();
          const identity = runtime.compiledPlans.register(
            {
              ...plan,
              outputs: [{ template: { op: "slot", slot: 1 }, kept: true }],
            },
            "code",
            runtimeWritePolicyAuthorization,
          );
          const first = runtime.edit();
          first.readOrThrow(memoryAddress("of:src-a", ["value"]));
          first.readOrThrow(memoryAddress("of:src-b", ["value"]));
          first.writeValueOrThrow({ ...link, path: ["a"] }, { x: "1" });
          first.recordCfcWritePolicyInput(
            planWrite(
              identity,
              { ...target, path: ["a"] },
              0,
              address("of:src-a"),
            ),
            runtimeWritePolicyAuthorization,
          );
          first.recordCfcWritePolicyInput(
            {
              ...planWrite(
                identity,
                { ...target, path: ["a", "x"] },
                1,
                address("of:src-b"),
              ),
              record: { output: 0 },
            },
            runtimeWritePolicyAuthorization,
          );
          expect((await first.commit().settled).error).toBeUndefined();
          const again = runtime.edit();
          again.readOrThrow(memoryAddress("of:src-b", ["value"]));
          again.recordCfcWritePolicyInput(
            {
              ...planWrite(
                identity,
                { ...target, path: ["a"] },
                1,
                address("of:src-b"),
              ),
              unchanged: true,
              ...(relabel ? { relabel: true as const } : {}),
            },
            runtimeWritePolicyAuthorization,
          );
          expect((await again.commit().settled).error).toBeUndefined();
          const reader = runtime.edit();
          try {
            const metadata = readStoredCfcMetadata(reader, {
              space,
              id: target.id,
              scope: "space",
              type: "application/json",
            });
            value = Object.fromEntries(
              (metadata?.labelMap.entries ?? [])
                .filter((entry) =>
                  entry.origin === "derived" && entry.observes === "value"
                )
                .map((entry) => [
                  `/${entry.path.join("/")}`,
                  [...(entry.label.confidentiality ?? [])].sort(),
                ]),
            );
            integrity = JSON.stringify(
              (metadata?.labelMap.entries ?? []).find((entry) =>
                entry.origin === "derived" && entry.observes === "value" &&
                entry.path.join("/") === "a/x"
              )?.label.integrity ?? [],
            );
          } finally {
            reader.abort();
          }
        });
        return { value, integrity };
      };

      it("stores the label of the record at its path and keeps the entries below it", async () => {
        const { value } = await givenAgain(true);
        expect(value["/a"]).toEqual(["secret-b"]);
        expect(value["/a/x"]).toEqual(["secret-b"]);
      });

      it("keeps the atom of a kept output below the path", async () => {
        const { integrity } = await givenAgain(true);
        expect(integrity).toContain(CFC_ATOM_TYPE.TransformedBy);
      });

      it("clears the entries below the path of a record that is one of a write that left the value as it was", async () => {
        const { value } = await givenAgain(false);
        expect(value["/a"]).toEqual(["secret-b"]);
        expect(value["/a/x"]).toBeUndefined();
      });
    });

    describe("for a write that left the value as it was", () => {
      /**
       * Seeds a source labeled `secret-a` and a target holding `{ a: "" }`,
       * then commits a transaction that reads the source, writes `""` at
       * `a` again and records the write as one that left the value as it
       * was. With `again`, that transaction was committed once before. A
       * sink reads `a` and another transaction read `a` before the commit;
       * the other transaction then writes a document of its own.
       */
      const commitUnchanged = async (again = false) => {
        let outcome:
          | {
            error: unknown;
            value: unknown;
            wrote: string[];
            sinkCalls: { before: number; after: number };
            otherError: unknown;
          }
          | undefined;
        await withRuntime(true, async (runtime) => {
          const seed = runtime.edit();
          writeSeedEnvelopeDoc(seed, space);
          seedStoredEnvelope(seed, memoryAddress("of:src-a", []), {
            value: { text: "a" },
            cfc: {
              version: 1,
              schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
              labelMap: {
                version: 1,
                entries: [{
                  path: [],
                  label: { confidentiality: ["secret-a"] },
                }],
              },
            },
          });
          const targetCell = runtime.getCell(
            space,
            "plan-target-unchanged",
            undefined,
            seed,
          );
          targetCell.set({ a: "" });
          const link = targetCell.getAsNormalizedFullLink();
          const target: CfcAddress = {
            space: link.space,
            id: link.id,
            scope: "space",
            path: ["a"],
          };
          seed.enrollRuntimeOwnedStore(
            { ...target, path: [] },
            "plan-labels-test",
            runtimeWritePolicyAuthorization,
          );
          // The document the other transaction writes takes its join.
          const otherCell = runtime.getCell(
            space,
            "plan-other-document",
            undefined,
            seed,
          );
          otherCell.set("");
          seed.enrollRuntimeOwnedStore(
            {
              space,
              id: otherCell.getAsNormalizedFullLink().id,
              scope: "space",
              path: [],
            },
            "plan-labels-test",
            runtimeWritePolicyAuthorization,
          );
          expect((await seed.commit().settled).error).toBeUndefined();
          const identity = runtime.compiledPlans.register(
            plan,
            "code",
            runtimeWritePolicyAuthorization,
          );
          /** The transaction that leaves `a` as it was, prepared. */
          const leaving = () => {
            const tx = runtime.edit();
            tx.readOrThrow(memoryAddress("of:src-a", ["value"]));
            tx.writeValueOrThrow({ ...link, path: ["a"] }, "");
            tx.recordCfcWritePolicyInput(
              {
                ...planWrite(identity, target, 0, address("of:src-a")),
                unchanged: true,
              },
              runtimeWritePolicyAuthorization,
            );
            runtime.prepareTxForCommit(tx);
            return tx;
          };
          if (again) {
            expect((await leaving().commit().settled).error).toBeUndefined();
          }
          let calls = 0;
          const cancel = runtime.getCell(space, "plan-target-unchanged").key(
            "a",
          ).sink(() => {
            calls++;
          });
          await runtime.idle();
          const before = calls;
          const other = runtime.edit();
          runtime.getCell(space, "plan-target-unchanged", undefined, other)
            .key("a").get();

          const tx = leaving();
          const wrote = [...(tx.getWriteDetails?.(space) ?? [])].filter((
            write,
          ) => write.address.id === link.id).map((write) =>
            write.address.path.join("/")
          );
          const { error } = await tx.commit().settled;
          await runtime.idle();
          const after = calls;
          cancel();

          runtime.getCell(space, "plan-other-document", undefined, other).set(
            "written",
          );
          const otherError = (await other.commit().settled).error;
          const reader = runtime.edit();
          try {
            const metadata = readStoredCfcMetadata(reader, {
              space,
              id: link.id,
              scope: "space",
              type: "application/json",
            });
            outcome = {
              error,
              value: (metadata?.labelMap.entries ?? []).filter((entry) =>
                entry.origin === "derived" && entry.observes === "value"
              ).map((entry) => [
                `/${entry.path.join("/")}`,
                entry.label.confidentiality,
              ]),
              wrote,
              sinkCalls: { before, after },
              otherError,
            };
          } finally {
            reader.abort();
          }
        });
        return outcome!;
      };

      it("stores the label of the write at its path", async () => {
        const { error, value } = await commitUnchanged();
        expect(error).toBeUndefined();
        expect(value).toEqual([["/a", ["secret-a"]]]);
      });

      it("writes the stored labels of the document and no value", async () => {
        const { wrote } = await commitUnchanged();
        expect(wrote).toEqual(["cfc"]);
      });

      // The labels of a document are stored in the document, and a read
      // of a labeled value consumes them: a change of the label a reader
      // consumed is a change of what the reader read.
      it("runs a reader of the value again, whose consumed label changed", async () => {
        const { sinkCalls } = await commitUnchanged();
        expect(sinkCalls.after).toBe(sinkCalls.before + 1);
      });

      it("conflicts with a transaction that read the value under the label it had before", async () => {
        const { otherError } = await commitUnchanged();
        expect((otherError as Error | undefined)?.name).toBe(
          "StorageTransactionInconsistent",
        );
      });

      describe("where the path stores that label already", () => {
        it("writes nothing", async () => {
          const { error, wrote } = await commitUnchanged(true);
          expect(error).toBeUndefined();
          expect(wrote).toEqual([]);
        });

        it("does not run a reader of the value again", async () => {
          const { sinkCalls } = await commitUnchanged(true);
          expect(sinkCalls.after).toBe(sinkCalls.before);
        });

        it("does not conflict with a transaction that read the value before", async () => {
          const { otherError } = await commitUnchanged(true);
          expect(otherError).toBeUndefined();
        });
      });
    });

    it("stores the transaction's join on both paths with the option off", async () => {
      const { error, value } = await commitWrites(false, recordBoth);
      expect(error).toBeUndefined();
      expect(value["/a"]).toEqual(["secret-a", "secret-b"]);
      expect(value["/b"]).toEqual(["secret-a", "secret-b"]);
    });

    it("stores the join for writes recorded without the runtime's authorization", async () => {
      const { error, value } = await commitWrites(
        true,
        (tx, identity, target) => {
          for (const [write, name] of [[0, "a"], [1, "b"]] as const) {
            tx.recordCfcWritePolicyInput(
              planWrite(
                identity,
                { ...target, path: [name] },
                write,
                address(`of:src-${name}`),
              ),
            );
          }
        },
      );
      expect(error).toBeUndefined();
      expect(value["/a"]).toEqual(["secret-a", "secret-b"]);
      expect(value["/b"]).toEqual(["secret-a", "secret-b"]);
    });

    it("commits a slot bound to an address the transaction did not read with the label stored there", async () => {
      const { error, value } = await commitWrites(
        true,
        (tx, identity, target) => {
          tx.recordCfcWritePolicyInput(
            planWrite(
              identity,
              { ...target, path: ["a"] },
              0,
              address("of:src-b"),
            ),
            runtimeWritePolicyAuthorization,
          );
        },
        false,
        { readB: false },
      );
      expect(error).toBeUndefined();
      expect(value["/a"]).toEqual(["secret-b"]);
    });

    it("stores, for a slot bound to an address the transaction did not read, the label stored there at the commit and not one from before a change of it", async () => {
      // The label of `of:src-b`, which the transaction does not read here,
      // changes after the transaction recorded the write and before it
      // commits. The commit observes the label of the address: it stores
      // the label after the change, or it conflicts, and never stores the
      // label from before.
      const relabel = async (runtime: Runtime) => {
        const change = runtime.edit();
        seedStoredEnvelope(change, memoryAddress("of:src-b", []), {
          value: { text: "b" },
          cfc: {
            version: 1,
            schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
            labelMap: {
              version: 1,
              entries: [{ path: [], label: { confidentiality: ["secret-d"] } }],
            },
          },
        });
        expect((await change.commit().settled).error).toBeUndefined();
      };
      const { error, value } = await commitWrites(
        true,
        (tx, identity, target) => {
          tx.recordCfcWritePolicyInput(
            planWrite(
              identity,
              { ...target, path: ["a"] },
              0,
              address("of:src-b"),
            ),
            runtimeWritePolicyAuthorization,
          );
        },
        false,
        { readB: false, beforeCommit: relabel },
      );
      if (error === undefined) {
        expect(value["/a"]).toEqual(["secret-d"]);
      } else {
        expect(value["/a"] ?? []).not.toContain("secret-b");
      }
    });

    for (const enabled of [true, false]) {
      it(
        `${
          enabled ? "prepares" : "does not prepare"
        } a transaction that reads nothing labeled and records an authorized plan-write, with the option ${
          enabled ? "on" : "off"
        }`,
        async () => {
          await withRuntime(enabled, async (runtime) => {
            const seed = runtime.edit();
            const targetCell = runtime.getCell(
              space,
              "plan-target",
              undefined,
              seed,
            );
            targetCell.set({ a: "" });
            const link = targetCell.getAsNormalizedFullLink();
            expect((await seed.commit().settled).error).toBeUndefined();
            const identity = runtime.compiledPlans.register(
              plan,
              "code",
              runtimeWritePolicyAuthorization,
            );
            const tx = runtime.edit();
            runtime.getCell(space, "plan-target", undefined, tx).key("a").set(
              "x",
            );
            tx.recordCfcWritePolicyInput(
              {
                kind: "plan-write",
                target: { space, id: link.id, scope: "space", path: ["a"] },
                compiledPattern: identity,
                record: { body: 0, write: 5 },
                instance: link.id,
                keys: [],
                slots: {},
              },
              runtimeWritePolicyAuthorization,
            );
            expect(tx.getCfcState().relevant).toBe(enabled);
            runtime.prepareTxForCommit(tx);
            expect(tx.getCfcState().prepare.status).toBe(
              enabled ? "prepared" : "unprepared",
            );
            expect((await tx.commit().settled).error).toBeUndefined();
          });
        },
      );
    }

    it("refuses the commit for a plan-write recorded after preparation", async () => {
      const { error } = await commitWrites(
        true,
        (tx, identity, target, runtime) => {
          runtime.prepareTxForCommit(tx);
          expect(tx.getCfcState().prepare.status).toBe("prepared");
          recordBoth(tx, identity, target);
          expect(tx.getCfcState().prepare.status).toBe("invalidated");
        },
      );
      expect(error).toBeDefined();
    });
  });

  // The labels of a document are stored in the document, so a commit that
  // changes one of them and no value is a change of the document: whoever
  // read a value of the document read it under the labels it had (CFC
  // §8.10.1, label reads are commit dependencies). A label derived from the
  // earlier one by a computation that does not run again keeps what it had
  // (§8.9.4, point-in-time semantics).
  for (const enabled of [false, true]) {
    describe(`a commit that changes a declared label and no value, with \`compiledPatterns\` ${enabled ? "on" : "off"}`, () => {
      /**
       * Seeds a target holding `{ a: "", b: "" }` with no label, a sink that
       * reads `a`, and a transaction that read `a`. Then commits a write of
       * the same value under a schema that declares a clause on `at`, and
       * lets the earlier transaction write another document and commit.
       */
      const relabeled = async (at: "a" | "b") => {
        let outcome:
          | {
            wrote: string[];
            declared: unknown;
            sinkCalls: { before: number; after: number };
            otherError: unknown;
          }
          | undefined;
        await withRuntime(enabled, async (runtime) => {
          const seed = runtime.edit();
          const cell = runtime.getCell(
            space,
            "relabel-target",
            undefined,
            seed,
          );
          cell.set({ a: "", b: "" });
          const link = cell.getAsNormalizedFullLink();
          runtime.getCell(space, "relabel-other", undefined, seed).set("");
          expect((await seed.commit().settled).error).toBeUndefined();
          let calls = 0;
          const cancel = runtime.getCell(space, "relabel-target").key("a")
            .sink(() => {
              calls++;
            });
          await runtime.idle();
          const before = calls;
          const other = runtime.edit();
          runtime.getCell(space, "relabel-target", undefined, other).key("a")
            .get();

          const tx = runtime.edit();
          const labeled = {
            type: "string",
            ifc: { confidentiality: ["declared-x"] },
          } as const;
          runtime.getCell(
            space,
            "relabel-target",
            {
              type: "object",
              properties: {
                a: at === "a" ? labeled : { type: "string" },
                b: at === "b" ? labeled : { type: "string" },
              },
            },
            tx,
          ).set({ a: "", b: "" });
          const wrote = [...(tx.getWriteDetails?.(space) ?? [])].filter((
            write,
          ) => write.address.id === link.id).map((write) =>
            write.address.path.join("/")
          );
          expect((await tx.commit().settled).error).toBeUndefined();
          await runtime.idle();
          const after = calls;
          cancel();

          runtime.getCell(space, "relabel-other", undefined, other).set(
            "written",
          );
          const otherError = (await other.commit().settled).error;
          const reader = runtime.edit();
          try {
            const metadata = readStoredCfcMetadata(reader, {
              space,
              id: link.id,
              scope: "space",
              type: "application/json",
            });
            outcome = {
              wrote,
              declared: (metadata?.labelMap.entries ?? []).filter((entry) =>
                entry.origin === "declared"
              ).map((entry) => [
                `/${entry.path.join("/")}`,
                entry.label.confidentiality,
              ]),
              sinkCalls: { before, after },
              otherError,
            };
          } finally {
            reader.abort();
          }
        });
        return outcome!;
      };

      it("stores the label and writes no value", async () => {
        const { wrote, declared } = await relabeled("a");
        expect(wrote.filter((path) => path.startsWith("value"))).toEqual([]);
        expect(declared).toEqual([["/a", ["declared-x"]]]);
      });

      it("runs a sink that read the value again", async () => {
        const { sinkCalls } = await relabeled("a");
        expect(sinkCalls.after).toBe(sinkCalls.before + 1);
      });

      it("conflicts with a transaction that read the value before it", async () => {
        const { otherError } = await relabeled("a");
        expect((otherError as Error | undefined)?.name).toBe(
          "StorageTransactionInconsistent",
        );
      });

      it("runs the sink again and conflicts alike where the label is that of another value of the document", async () => {
        const { sinkCalls, otherError } = await relabeled("b");
        expect(sinkCalls.after).toBe(sinkCalls.before + 1);
        expect((otherError as Error | undefined)?.name).toBe(
          "StorageTransactionInconsistent",
        );
      });
    });
  }

  describe("a label observed from another session's storage", () => {
    let server: MemoryV2Server.Server;
    let managers: EmulatedStorageManager[];
    let runtimes: Runtime[];
    beforeEach(() => {
      // Fan-out is manual: a runtime sees another's commit only at
      // `flushSessions()`, so its replica is stale until then.
      server = newSharedServer({ subscriptionRefreshDelayMs: "manual" });
      managers = [];
      runtimes = [];
    });
    afterEach(async () => {
      for (const runtime of runtimes) await runtime.dispose();
      for (const manager of managers) await manager.close();
      await server.close();
    });

    const session = (): Runtime => {
      const manager = EmulatedStorageManager.connectTo(server, { as: signer });
      managers.push(manager);
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: manager,
        experimental: { compiledPatterns: true },
        servingPosture: true,
      });
      runtimes.push(runtime);
      return runtime;
    };

    /** Writes the document `id` with the one clause `clause` at its root. */
    const labelSource = async (
      runtime: Runtime,
      clause: string,
      id = "of:src-b",
    ) => {
      const tx = runtime.edit();
      writeSeedEnvelopeDoc(tx, space);
      seedStoredEnvelope(tx, memoryAddress(id, []), {
        value: { text: id },
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{ path: [], label: { confidentiality: [clause] } }],
          },
        },
      });
      expect(
        (await tx.commit({ holdSyncedUntilCovered: false }).verdict).error,
      ).toBeUndefined();
      await runtime.storageManager.synced();
    };

    /**
     * Writes `plan-target/a` in a transaction of `runtime` that reads the
     * labeled `of:src-a`, which makes it relevant to CFC, and not
     * `of:src-b`, and records the write bound to `of:src-b`; prepares it,
     * runs `afterPreparation`, and commits it. Returns the commit's error and
     * the confidentiality stored at `/a`.
     */
    const commitBoundToSource = async (
      runtime: Runtime,
      afterPreparation: () => Promise<void> = () => Promise.resolve(),
    ) => {
      const seed = runtime.edit();
      const targetCell = runtime.getCell(space, "plan-target", undefined, seed);
      targetCell.set({ a: "" });
      const link = targetCell.getAsNormalizedFullLink();
      const target: CfcAddress = {
        space: link.space,
        id: link.id,
        scope: "space",
        path: [],
      };
      seed.enrollRuntimeOwnedStore(
        target,
        "plan-labels-test",
        runtimeWritePolicyAuthorization,
      );
      expect(
        (await seed.commit({ holdSyncedUntilCovered: false }).verdict).error,
      ).toBeUndefined();
      const identity = runtime.compiledPlans.register(
        plan,
        "code",
        runtimeWritePolicyAuthorization,
      );
      await labelSource(runtime, "secret-a", "of:src-a");
      const tx = runtime.edit();
      tx.readOrThrow(memoryAddress("of:src-a", ["value"]));
      runtime.getCell(space, "plan-target", undefined, tx).key("a").set("x");
      tx.recordCfcWritePolicyInput(
        planWrite(identity, { ...target, path: ["a"] }, 0, address("of:src-b")),
        runtimeWritePolicyAuthorization,
      );
      runtime.prepareTxForCommit(tx);
      await afterPreparation();
      const { error } = await tx.commit({ holdSyncedUntilCovered: false })
        .verdict;
      const reader = runtime.edit();
      try {
        const metadata = readStoredCfcMetadata(reader, {
          space,
          id: target.id,
          scope: "space",
          type: "application/json",
        });
        const stored = (metadata?.labelMap.entries ?? []).find((entry) =>
          entry.origin === "derived" && entry.observes === "value" &&
          entry.path.join("/") === "a"
        );
        return { error, stored: stored?.label.confidentiality };
      } finally {
        reader.abort();
      }
    };

    it("conflicts where the label a slot observed changes after the preparation and before the store validates the commit", async () => {
      const writer = session();
      const other = session();
      await labelSource(other, "secret-b");
      // The writer's replica holds `of:src-b` under `secret-b`.
      await writer.getCellFromLink({
        space,
        id: "of:src-b",
        path: [],
        scope: "space",
      }).sync();
      const { error } = await commitBoundToSource(
        writer,
        // Another session relabels the source; the writer does not hear of
        // it before its commit reaches the store.
        () => labelSource(other, "secret-d"),
      );
      expect(error?.name).toBe("ConflictError");
    });

    it("never stores the label of a document the writer has not loaded as if it had none", async () => {
      const writer = session();
      const other = session();
      await labelSource(other, "secret-b");
      // The writer never loads `of:src-b`.
      const { error, stored } = await commitBoundToSource(writer);
      if (error === undefined) {
        expect(stored).toContain("secret-b");
      } else {
        expect(stored ?? []).toEqual([]);
      }
    });
  });

  describe("fold", () => {
    /**
     * Seeds a list of `size` items under `secret-a`, its last item also
     * under `secret-b`, reads the last item (the one changed element) and
     * `of:src-a`, writes the target, records a fold write whose elements are
     * given by `elements`, and returns the plan counters the pre-pass added.
     */
    const foldCounters = async (
      size: number,
      elements: (list: string, last: string) => PlanElements,
      over: { write: number; collection: number; slots?: SlotBindings } = {
        write: 4,
        collection: 0,
      },
    ) => {
      let counters: Record<string, number> = {};
      await withRuntime(true, async (runtime) => {
        const list = `of:list-${size}`;
        const last = String(size - 1);
        const seed = runtime.edit();
        writeSeedEnvelopeDoc(seed, space);
        seedStoredEnvelope(seed, memoryAddress("of:src-a", []), {
          value: { text: "a" },
          cfc: {
            version: 1,
            schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
            labelMap: {
              version: 1,
              entries: [{ path: [], label: { confidentiality: ["secret-a"] } }],
            },
          },
        });
        seedStoredEnvelope(seed, memoryAddress(list, []), {
          value: { items: Array.from({ length: size }, (_, n) => `item ${n}`) },
          cfc: {
            version: 1,
            schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
            labelMap: {
              version: 1,
              entries: [
                {
                  path: ["items", "*"],
                  label: { confidentiality: ["secret-a"] },
                },
                {
                  path: ["items", last],
                  label: { confidentiality: ["secret-b"] },
                },
              ],
            },
          },
        });
        expect((await seed.commit().settled).error).toBeUndefined();
        const identity = runtime.compiledPlans.register(
          plan,
          "code",
          runtimeWritePolicyAuthorization,
        );
        const tx = runtime.edit();
        try {
          tx.readOrThrow(memoryAddress("of:src-a", ["value"]));
          tx.readOrThrow(memoryAddress(list, ["value", "items", last]));
          const cell = runtime.getCell(space, "plan-target", undefined, tx);
          cell.set({ total: size });
          const link = cell.getAsNormalizedFullLink();
          tx.recordCfcWritePolicyInput(
            {
              kind: "plan-write",
              target: { space, id: link.id, scope: "space", path: ["total"] },
              compiledPattern: identity,
              record: { body: 0, write: over.write },
              instance: link.id,
              keys: [],
              slots: over.slots ?? {},
              elements: { [over.collection]: elements(list, last) },
            },
            runtimeWritePolicyAuthorization,
          );
          const before = runtime.getCfcStats();
          const labels = planLabelsFor(tx, deriveFlowJoin(tx));
          expect(labels.reasons).toEqual([]);
          const label = [...labels.byTarget.values()][0].get("/total")!;
          expect([...label.confidentiality].sort()).toEqual([
            "secret-a",
            "secret-b",
          ]);
          const after = runtime.getCfcStats();
          counters = Object.fromEntries(
            (
              [
                "planTemplatesInstantiated",
                "planTemplateNodes",
                "planSlotLabels",
                "planLabelMemoHits",
                "planLabelBounds",
              ] as const
            ).map((kind) => [kind, after[kind] - before[kind]]),
          );
        } finally {
          tx.abort();
        }
      });
      return counters;
    };

    /**
     * Registers a plan whose one write is a derivation of `nodes` `shared`
     * nodes that each name the template of slot 0, records a write of it,
     * and returns the content keys of inputs the pre-pass formed.
     */
    const inputKeysFor = async (nodes: number): Promise<number> => {
      let formed = -1;
      await withRuntime(true, (runtime) => {
        const identity = runtime.compiledPlans.register(
          {
            ...plan,
            templates: [{ op: "slot", slot: 0 }],
            bodies: [{
              writes: [{
                template: {
                  op: "derive",
                  by: { expression: true },
                  inputs: Array.from(
                    { length: nodes },
                    () => ({ op: "shared", template: 0 }) as const,
                  ),
                },
              }],
            }],
          },
          "code",
          runtimeWritePolicyAuthorization,
        );
        const tx = runtime.edit();
        try {
          const cell = runtime.getCell(space, "shared-target", undefined, tx);
          cell.set({ total: 1 });
          const link = cell.getAsNormalizedFullLink();
          tx.recordCfcWritePolicyInput(
            planWrite(
              identity,
              { space, id: link.id, scope: "space", path: ["total"] },
              0,
              address("of:nothing"),
            ),
            runtimeWritePolicyAuthorization,
          );
          const before = runtime.getCfcStats().planInputKeys;
          expect(planLabelsFor(tx, deriveFlowJoin(tx)).reasons).toEqual([]);
          formed = runtime.getCfcStats().planInputKeys - before;
        } finally {
          tx.abort();
        }
      });
      return formed;
    };

    it("forms the content key of a place's inputs once, however many `shared` nodes its template has", async () => {
      const two = await inputKeysFor(2);

      expect(two).toBeGreaterThan(0);
      expect(await inputKeysFor(40)).toBe(two);
    });

    it("counts the same work for one changed element among 10 and among 1,000 in the uniform form", async () => {
      // An array of plain values in place: one set of bindings at `*`.
      const uniform = (list: string): PlanElements => ({
        uniform: {
          slots: {
            3: {
              chain: [address(list, ["items", "*"])],
              observes: "value",
            },
          },
        },
      });
      const small = await foldCounters(10, uniform);
      expect(small.planTemplatesInstantiated).toBeGreaterThan(0);
      expect(await foldCounters(1000, uniform)).toEqual(small);
    });

    it("counts the same work for one changed element among 10 and among 1,000 in the groups form", async () => {
      // An array of references: one group per distinct label, with counts.
      const groups = (size: number) => (list: string, last: string) => ({
        groups: [
          {
            slots: {
              3: {
                chain: [address("of:src-a")],
                observes: "value" as const,
              },
            },
            count: size - 1,
          },
          {
            slots: {
              3: {
                chain: [address(list, ["items", last])],
                observes: "value" as const,
              },
            },
            count: 1,
          },
        ],
      });
      const small = await foldCounters(10, groups(10));
      expect(small.planTemplatesInstantiated).toBeGreaterThan(0);
      expect(await foldCounters(1000, groups(1000))).toEqual(small);
    });

    it("takes as the membership of a filter, whose membership template is its own fold, the label of its source", async () => {
      // The membership a `filter` iterates is its source's, slot 0 here,
      // bound to `of:src-a`.
      const counters = await foldCounters(
        10,
        (list) => ({
          uniform: {
            slots: {
              3: {
                chain: [address(list, ["items", "*"])],
                observes: "value",
              },
            },
          },
        }),
        {
          write: 6,
          collection: 1,
          slots: {
            0: { chain: [address("of:src-a")], observes: "value" },
          },
        },
      );
      expect(counters.planTemplatesInstantiated).toBeGreaterThan(0);
    });

    it("takes for a slot bound to an output the label of that output, from the inputs its group reports", async () => {
      // The result of another per-element construct: the element's slot
      // reads output 0 of the upstream element, whose own slot read the
      // changed element.
      await foldCounters(10, (list, last) => ({
        groups: [
          {
            slots: { 3: { chain: [address("of:src-a")], observes: "value" } },
            count: 9,
          },
          {
            slots: { 3: { output: 0 } },
            outputs: {
              0: {
                slots: {
                  0: {
                    chain: [address(list, ["items", last])],
                    observes: "value",
                  },
                },
              },
            },
            count: 1,
          },
        ],
      }));
    });
  });
});
