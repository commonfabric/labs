import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { UnknownValue } from "@commonfabric/data-model/codec-common";
import { FabricError } from "@commonfabric/data-model/fabric-instances";
import {
  FabricBytes,
  FabricRegExp,
} from "@commonfabric/data-model/fabric-primitives";
import { Identity } from "@commonfabric/identity";
import type { MemorySpace, URI } from "@commonfabric/memory/interface";
import type { JSONSchema } from "../src/builder/types.ts";
import { immutableCellsFor } from "../src/immutable-cell.ts";
import { Runtime, type RuntimeOptions } from "../src/runtime.ts";
import {
  boundedCounts,
  CFC_REJECTION_REASON_LIMIT,
  CFC_REJECTION_REASON_OTHER,
  cfcRejectionReasonPrefix,
  CfcRejectionTally,
  SIZES_BY_KEY_LIMIT,
  SIZES_BY_KEY_OTHER,
} from "../src/runtime-sizes.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { prepareAndCommit, refuseAtCommitBoundary } from "./refused-commit.ts";
import type { SpaceReplica } from "../src/storage/v2.ts";

const signer = await Identity.fromPassphrase("runner-runtime-sizes");
const space: MemorySpace = signer.did();

describe("runtime-sizes", () => {
  describe("cfcRejectionReasonPrefix()", () => {
    it("returns the words ahead of the document a reason names after ` for `", () => {
      expect(cfcRejectionReasonPrefix(
        "missing link source metadata for of:fid1:abc at /, linked into computed:fid1:def at /0/",
      )).toBe("missing link source metadata");
      expect(cfcRejectionReasonPrefix(
        "writer-fit confidentiality misfit for of:fid1:abc at / (canWrite, §8.12.4)",
      )).toBe("writer-fit confidentiality misfit");
    });

    it("returns the words ahead of the path a reason names after ` at `", () => {
      expect(cfcRejectionReasonPrefix("writePolicyAnyOf failed at /title"))
        .toBe("writePolicyAnyOf failed");
      expect(cfcRejectionReasonPrefix("requiredIntegrity failed at /"))
        .toBe("requiredIntegrity failed");
    });

    it("returns the words ahead of a `:` detail", () => {
      expect(cfcRejectionReasonPrefix("CFC commit-prep crashed: boom"))
        .toBe("CFC commit-prep crashed");
      expect(cfcRejectionReasonPrefix(
        "sink-request confidentiality exceeds ceiling for llm: personal",
      )).toBe("sink-request confidentiality exceeds ceiling");
    });

    it("returns the words ahead of an identifier a reason names with no connective", () => {
      expect(cfcRejectionReasonPrefix(
        "unprivileged write to protected runtime surface of:fid1:abc at /",
      )).toBe("unprivileged write to protected runtime surface");
      expect(cfcRejectionReasonPrefix(
        "unprivileged write to protected runtime surface /secret/path",
      )).toBe("unprivileged write to protected runtime surface");
    });

    it("returns a reason that names nothing whole", () => {
      expect(cfcRejectionReasonPrefix("prepared digest changed"))
        .toBe("prepared digest changed");
      expect(cfcRejectionReasonPrefix("CFC commit preparation crashed: boom"))
        .toBe("CFC commit preparation crashed");
    });

    it("returns a placeholder for a reason with no words ahead of its detail", () => {
      expect(cfcRejectionReasonPrefix(": only detail")).toBe("(unclassified)");
    });

    it("returns at most 80 characters", () => {
      expect(cfcRejectionReasonPrefix("x".repeat(200))).toHaveLength(80);
    });
  });

  describe("CfcRejectionTally", () => {
    describe("add()", () => {
      it("counts a refusal once under each of its reasons' prefixes", () => {
        const tally = new CfcRejectionTally();
        tally.add([
          "writePolicyAnyOf failed at /a",
          "writePolicyAnyOf failed at /b",
          "requiredIntegrity failed at /c",
        ]);
        expect(tally.snapshot()).toEqual({
          "writePolicyAnyOf failed": 2,
          "requiredIntegrity failed": 1,
        });
      });

      it("counts prefixes past the limit under one shared key", () => {
        const tally = new CfcRejectionTally();
        for (let i = 0; i < CFC_REJECTION_REASON_LIMIT; i++) {
          tally.add([`rule ${i} refused at /`]);
        }
        tally.add(["one more rule refused at /"]);
        tally.add(["and another refused at /"]);
        tally.add(["rule 0 refused at /"]);

        const snapshot = tally.snapshot();
        expect(Object.keys(snapshot)).toHaveLength(
          CFC_REJECTION_REASON_LIMIT + 1,
        );
        expect(snapshot[CFC_REJECTION_REASON_OTHER]).toBe(2);
        expect(snapshot["rule 0 refused"]).toBe(2);
      });
    });
  });

  describe("boundedCounts()", () => {
    it("returns a map within the limit whole, largest first", () => {
      expect(boundedCounts(new Map([["a", 1], ["b", 3], ["c", 2]]))).toEqual({
        b: 3,
        c: 2,
        a: 1,
      });
    });

    it("adds the counts past the limit under `(other)`", () => {
      const counts = new Map<string, number>();
      for (let i = 0; i < SIZES_BY_KEY_LIMIT + 3; i++) {
        counts.set(`space-${i}`, SIZES_BY_KEY_LIMIT + 3 - i);
      }

      const bounded = boundedCounts(counts);

      expect(Object.keys(bounded)).toHaveLength(SIZES_BY_KEY_LIMIT + 1);
      expect(bounded["space-0"]).toBe(SIZES_BY_KEY_LIMIT + 3);
      expect(bounded[SIZES_BY_KEY_OTHER]).toBe(3 + 2 + 1);
    });
  });

  describe("Runtime.getSizes()", () => {
    let storageManager: ReturnType<typeof StorageManager.emulate> | undefined;
    let runtime: Runtime | undefined;

    const createRuntime = (
      options: Omit<RuntimeOptions, "storageManager"> = {
        apiUrl: new URL(import.meta.url),
      },
    ) => {
      storageManager = StorageManager.emulate({ as: signer });
      runtime = new Runtime({ ...options, storageManager });
      return runtime;
    };

    afterEach(async () => {
      await runtime?.dispose();
      await storageManager?.close();
      runtime = undefined;
      storageManager = undefined;
    });

    it("returns every size at zero for a runtime that has done nothing, with no reasons tallied", () => {
      const sizes = createRuntime().getSizes();

      expect(sizes.scheduler).toEqual({
        nodes: 0,
        invalidNodes: 0,
        eventQueue: 0,
        pendingActions: 0,
        backgroundTasks: 0,
        actionStats: 0,
      });
      expect(sizes.storage?.spaces).toBe(0);
      expect(sizes.storage?.documents).toBe(0);
      expect(sizes.storage?.bySpace).toEqual([]);
      expect(sizes.storage?.bySpaceOmitted).toEqual({
        spaces: 0,
        documents: 0,
        watched: 0,
        measuredDocuments: 0,
        truncatedDocuments: 0,
        approxBytes: 0,
      });
      expect(sizes.storage?.approxBytes).toBe(0);
      expect(sizes.patterns.compiledPrograms).toBe(0);
      expect(sizes.runtime.retryingEdits).toBe(0);
      expect(sizes.runtime.moduleDelegations).toEqual({
        spaces: 0,
        identities: 0,
        predecessors: 0,
        snapshotBuilds: 0,
      });
      expect(sizes.cfcRejectionsByReason).toEqual({});
    });

    it("counts the module delegations registered and the snapshots built for them, not the transactions handed one", () => {
      const runtime = createRuntime();
      runtime.registerModuleDelegations(
        space,
        new Map([
          ["successor", new Set(["predecessor", "other"])],
          ["predecessor", new Set(["ancestor"])],
        ]),
      );
      runtime.registerModuleDelegations(
        space,
        new Map([["successor", new Set(["predecessor"])]]),
      );
      runtime.registerModuleDelegations(
        "did:key:z6MkRuntimeSizesOtherSpace",
        new Map([["other", new Set(["elder"])]]),
      );
      runtime.edit().abort("sized");
      runtime.edit().abort("sized");

      expect(runtime.getSizes().runtime.moduleDelegations).toEqual({
        spaces: 2,
        identities: 3,
        predecessors: 4,
        snapshotBuilds: 2,
      });
    });

    it("counts a committed document and the space it opened", async () => {
      const runtime = createRuntime();
      const tx = runtime.edit();
      runtime.getCell<number>(space, "sized", { type: "number" }, tx).set(1);
      await tx.commit().settled;

      const sizes = runtime.getSizes();
      expect(sizes.storage?.spaces).toBe(1);
      expect(sizes.storage?.documents).toBe(1);
    });

    it("reports each open space's documents under `bySpace`, largest first, adding up to the manager's counts", async () => {
      // The manager's counts add every open space together, so they cannot
      // say which space holds what; the entries carry each space's share and
      // the approximate size of its documents, which is what ranks them.

      const runtime = createRuntime();
      const otherSpace: MemorySpace = "did:key:z6MkRuntimeSizesBySpace";
      const own = runtime.edit();
      runtime.getCell<number>(space, "sized-a", { type: "number" }, own).set(1);
      runtime.getCell<number>(space, "sized-b", { type: "number" }, own).set(2);
      await own.commit().settled;
      const other = runtime.edit();
      runtime.getCell<string>(otherSpace, "sized-c", { type: "string" }, other)
        .set("x".repeat(10_000));
      await other.commit().settled;
      await storageManager!.synced();

      const storage = runtime.getSizes().storage!;
      expect(storage.bySpace.map((entry) => entry.space)).toEqual([
        otherSpace,
        space,
      ]);
      expect(storage.bySpace.map((entry) => entry.documents)).toEqual([1, 2]);
      expect(
        storage.bySpace.reduce((sum, entry) => sum + entry.documents, 0) +
          storage.bySpaceOmitted.documents,
      ).toBe(storage.documents);
      expect(
        storage.bySpace.reduce((sum, entry) => sum + entry.watched, 0) +
          storage.bySpaceOmitted.watched,
      ).toBe(storage.watchedDocuments);
      expect(storage.bySpaceOmitted.spaces).toBe(0);
      expect(storage.measuredDocuments).toBe(storage.documents);
      expect(storage.bySpace[0].approxBytes).toBeGreaterThan(10_000);
      expect(storage.approxBytes).toBe(
        storage.bySpace.reduce((sum, entry) => sum + entry.approxBytes, 0),
      );
      // The emulated manager's sessions cross no socket.
      expect(storage.wire).toBeNull();
    });

    it("counts a stored byte payload's bytes in its space's approximate size", async () => {
      const runtime = createRuntime();
      const tx = runtime.edit();
      runtime.getCell(space, "sized-bytes", { type: "object" }, tx).set({
        payload: new FabricBytes(new Uint8Array(1_000_000)),
      });
      await tx.commit().settled;
      await storageManager!.synced();

      const storage = runtime.getSizes().storage!;
      expect(storage.measuredDocuments).toBe(storage.documents);
      expect(storage.approxBytes).toBeGreaterThanOrEqual(1_000_000);
    });

    it("counts a stored instance's private payload in its space's approximate size", async () => {
      const runtime = createRuntime();
      const tx = runtime.edit();
      runtime.getCell(space, "sized-error", { type: "object" }, tx).set({
        failure: new FabricError({
          type: "Error",
          message: "x".repeat(1_000_000),
          stack: undefined,
          cause: undefined,
        }),
      });
      await tx.commit().settled;
      await storageManager!.synced();

      const storage = runtime.getSizes().storage!;
      expect(storage.measuredDocuments).toBe(storage.documents);
      expect(storage.approxBytes).toBeGreaterThanOrEqual(1_000_000);
    });

    it("counts a stored unknown value's preserved state and a regular expression's source in its space's approximate size", async () => {
      const runtime = createRuntime();
      const tx = runtime.edit();
      runtime.getCell(space, "sized-unknown", { type: "object" }, tx).set({
        payload: new UnknownValue("FutureType@1", "x".repeat(1_000_000)),
      });
      runtime.getCell(space, "sized-regexp", { type: "object" }, tx).set({
        payload: new FabricRegExp("es2025", "y".repeat(1_000_000), ""),
      });
      await tx.commit().settled;
      await storageManager!.synced();

      const storage = runtime.getSizes().storage!;
      expect(storage.measuredDocuments).toBe(storage.documents);
      expect(storage.approxBytes).toBeGreaterThanOrEqual(2_000_000);
    });

    it("counts the snapshots read out of a space's documents under that space, and the rest under `(none)`", () => {
      // The table spans every store in the process, so each key is read as
      // a difference: what this runtime adds to whatever other stores hold.

      const runtime = createRuntime();
      const before = runtime.getSizes().runtime.immutableSnapshotsBySpace;
      const base = runtime.getCell(space, "elements-by-space", {
        type: "object",
      }).getAsNormalizedFullLink();
      immutableCellsFor(runtime).createElement({ name: "Ada" }, base);
      runtime.getImmutableCell(space, { value: 3 }, { type: "object" });

      const after = runtime.getSizes().runtime.immutableSnapshotsBySpace;
      expect((after[space] ?? 0) - (before[space] ?? 0)).toBe(1);
      expect((after["(none)"] ?? 0) - (before["(none)"] ?? 0)).toBe(1);
    });

    it("counts an element read out of an unstored snapshot under `(none)`, not the space its link names", () => {
      const runtime = createRuntime();
      const before = runtime.getSizes().runtime.immutableSnapshotsBySpace;
      const unstored = runtime.getImmutableCell(space, { items: [{ n: 4 }] }, {
        type: "object",
      }).getAsNormalizedFullLink();
      immutableCellsFor(runtime).createElement({ n: 4 }, {
        ...unstored,
        path: ["items", "0"],
      });

      const after = runtime.getSizes().runtime.immutableSnapshotsBySpace;
      expect((after[space] ?? 0) - (before[space] ?? 0)).toBe(0);
      expect((after["(none)"] ?? 0) - (before["(none)"] ?? 0)).toBe(2);
    });

    it("counts an element read out of an inline document under `(none)`", () => {
      const runtime = createRuntime();
      const before = runtime.getSizes().runtime.immutableSnapshotsBySpace;
      const inline = runtime.getCell(space, "inline-origin", { type: "object" })
        .getAsNormalizedFullLink();
      immutableCellsFor(runtime).createElement({ n: 5 }, {
        ...inline,
        id: "data:application/json,%7B%22n%22%3A5%7D" as URI,
      });

      const after = runtime.getSizes().runtime.immutableSnapshotsBySpace;
      expect((after[space] ?? 0) - (before[space] ?? 0)).toBe(0);
      expect((after["(none)"] ?? 0) - (before["(none)"] ?? 0)).toBe(1);
    });

    it("counts a sink's node while it is live and not after it is cancelled", async () => {
      const runtime = createRuntime();
      const cell = runtime.getCell<number>(space, "sunk", { type: "number" });
      const cancel = cell.sink(() => {});
      await runtime.idle();
      expect(runtime.getSizes().scheduler.nodes).toBe(1);

      cancel();
      await runtime.idle();
      expect(runtime.getSizes().scheduler.nodes).toBe(0);
    });

    it("counts the snapshots the immutable cell stores retain", () => {
      // The count spans every store in the process, so it is read as a
      // difference: what this runtime adds to whatever other stores hold.

      const runtime = createRuntime();
      const before = runtime.getSizes().runtime.immutableSnapshots;
      runtime.getImmutableCell(space, { value: 1 }, { type: "object" });
      runtime.getImmutableCell(space, { value: 2 }, { type: "object" });

      expect(runtime.getSizes().runtime.immutableSnapshots - before).toBe(2);
    });

    it("counts an element snapshot a child store retains", () => {
      // Element traversal retains its snapshots in a store of their own, not
      // in the runtime's root store, and the count includes them all the same.

      const runtime = createRuntime();
      const base = runtime.getCell(space, "elements", { type: "object" })
        .getAsNormalizedFullLink();
      const before = runtime.getSizes().runtime.immutableSnapshots;
      immutableCellsFor(runtime).createElement({ name: "Ada" }, base);

      expect(runtime.getSizes().runtime.immutableSnapshots - before).toBe(1);
    });

    it("counts a storage sink once however often it registers and cancels", () => {
      const runtime = createRuntime();
      const replica = storageManager!.open(space).replica as SpaceReplica;
      const uri = runtime.getCell(space, "sunk-document")
        .getAsNormalizedFullLink()
        .id as URI;
      const sink = () => {};
      const subscriptions = () => runtime.getSizes().storage?.subscriptions;

      const cancel = replica.sinkDocument(uri, sink);
      replica.sinkDocument(uri, sink);
      expect(subscriptions()).toBe(1);

      cancel();
      cancel();
      expect(subscriptions()).toBe(0);
    });

    it("tallies a commit CFC enforcement refused under its reason's prefix", async () => {
      // An ordinary write to a reserved grant document is refused by the
      // write chokepoint's gate, so the tally carries that gate's words.

      const runtime = createRuntime();
      const tx = runtime.edit();
      refuseAtCommitBoundary(tx, space, "tallied");
      const { reasons, result } = await prepareAndCommit(tx);

      expect(result.error?.name).toBe("CfcCommitRefusalError");
      expect(reasons).toHaveLength(1);
      expect(runtime.getSizes().cfcRejectionsByReason).toEqual({
        "unprivileged write to protected runtime surface": 1,
      });
    });

    it("tallies a commit whose CFC preparation crashed", async () => {
      // A stored envelope claiming a label under `candidate.name` beneath an
      // `anyOf` with two ifc-bearing branches makes the next writer's
      // preparation throw when it overlays that claim onto its own schema,
      // and that commit is refused before storage.

      const runtime = createRuntime();
      const profile: JSONSchema = {
        type: "object",
        properties: {
          name: { type: "string", ifc: { confidentiality: ["secret"] } },
        },
      };
      const ambiguous: JSONSchema = {
        type: "object",
        properties: {
          result: {
            anyOf: [
              profile,
              { type: "string", ifc: { confidentiality: ["other"] } },
            ],
          },
          candidate: profile,
        },
      };
      const seed = runtime.edit();
      runtime.getCell(space, "wish", ambiguous, seed).set({
        candidate: { name: "Bob" },
      });
      seed.prepareCfc();
      expect((await seed.commit().settled).error).toBeUndefined();

      const tx = runtime.edit();
      const resolved = runtime.getCell(space, "wish-resolved", profile, tx);
      resolved.set({ name: "Ada" });
      runtime.getCell(space, "wish", ambiguous, tx).set({
        candidate: resolved,
      });
      runtime.prepareTxForCommit(tx);
      const result = await tx.commit().settled;

      expect(result.error?.name).toBe("CommitPreparationError");
      expect(runtime.getSizes().cfcRejectionsByReason).toEqual({
        "CFC commit preparation crashed": 1,
      });
    });
  });
});
