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
 * to a staged label in the cases that use it), a selection between slots 0
 * and 1 on slot 2, a fold of slot 3 over the elements of collection 0, and
 * a constant; and one output, of slot 0.
 */
const plan: CompiledPlan = {
  outputs: [{ template: { op: "slot", slot: 0 } }],
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
    ],
  }],
  cones: [],
  templates: [],
  collections: [{ membership: { op: "const" } }],
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
      writeRoot = false,
    ) => {
      let outcome:
        | {
          error: unknown;
          value: Record<string, unknown[]>;
          shape: Record<string, unknown[]>;
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
          plan,
          "code",
          runtimeWritePolicyAuthorization,
        );
        const tx = runtime.edit();
        tx.readOrThrow(memoryAddress("of:src-a", ["value"]));
        tx.readOrThrow(memoryAddress("of:src-b", ["value"]));
        const cell = runtime.getCell(space, "plan-target", undefined, tx);
        if (writeRoot) {
          tx.writeValueOrThrow({ ...link, path: [] }, {
            a: "x",
            b: "y",
            c: "z",
          });
        } else {
          cell.key("a").set("x");
          cell.key("b").set("y");
        }
        record(tx, identity, target, runtime);
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
          outcome = { error, value: at("value"), shape: at("shape") };
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

    it("refuses the commit for a slot bound to an address the transaction did not read", async () => {
      const { error } = await commitWrites(true, (tx, identity, target) => {
        tx.recordCfcWritePolicyInput(
          planWrite(
            identity,
            { ...target, path: ["a"] },
            0,
            address("of:never-read"),
          ),
          runtimeWritePolicyAuthorization,
        );
      });
      expect(error).toBeDefined();
    });

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
              record: { body: 0, write: 4 },
              instance: link.id,
              keys: [],
              slots: {},
              elements: { 0: elements(list, last) },
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
