/**
 * The reads a replica builds from a transaction for its commit: how a
 * recursive ancestor read compacts the reads beneath it, which reads stay
 * out of the commit's dependencies, and what `excludeReadFromConflict`
 * takes out of the conflict set while leaving it in the reactivity log.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { toDocumentPath } from "@commonfabric/memory/v2";
import { dataUriFromValue } from "@commonfabric/data-model/codec-data-uri";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { SpaceReplica } from "../src/storage/v2.ts";
import { Runtime } from "../src/runtime.ts";
import { excludeReadFromConflict } from "../src/storage/reactivity-log.ts";
import { txToReactivityLog } from "../src/scheduler.ts";

const DOCUMENT_ADDRESS = {
  id: "bench:read-compaction" as const,
  type: "application/json" as const,
  scope: "space" as const,
  path: [] as string[],
};

const createRuntime = async (label: string) => {
  const signer = await Identity.fromPassphrase(label);
  const storage = StorageManager.emulate({
    as: signer,
  });
  const runtime = new Runtime({
    storageManager: storage,
    apiUrl: new URL(import.meta.url),
  });
  return { signer, storage, runtime };
};

describe("memory-v2-read-compaction", () => {
  describe("compacting a transaction's reads", () => {
    it("compacts descendant confirmed reads under a recursive ancestor", async () => {
      const { signer, storage, runtime } = await createRuntime(
        "memory-v2-read-compaction-recursive",
      );
      const space = signer.did();

      const seed = runtime.edit();
      seed.writeValueOrThrow(
        { ...DOCUMENT_ADDRESS, space },
        {
          section0: { field0: "value0", field1: "value1" },
          section1: { field0: "value2" },
        },
      );
      expect((await seed.commit().settled).ok).toEqual({});

      const tx = runtime.edit();
      tx.readValueOrThrow({ ...DOCUMENT_ADDRESS, space, path: [] });
      tx.readValueOrThrow({ ...DOCUMENT_ADDRESS, space, path: ["section0"] });
      tx.readValueOrThrow({
        ...DOCUMENT_ADDRESS,
        space,
        path: ["section0", "field0"],
      });

      const replica = storage.open(space).replica as SpaceReplica;
      const reads = replica.accessForTestingOnly.buildReads(tx.tx, 1);

      expect(reads.pending).toEqual([]);
      expect(reads.confirmed.length).toBe(1);
      expect(reads.confirmed[0].path).toEqual(["value"]);

      await runtime.dispose();
      await storage.close();
    });

    it("keeps descendant reads when the ancestor is non-recursive", async () => {
      const { signer, storage, runtime } = await createRuntime(
        "memory-v2-read-compaction-non-recursive",
      );
      const space = signer.did();

      const seed = runtime.edit();
      seed.writeValueOrThrow(
        { ...DOCUMENT_ADDRESS, space },
        {
          section0: { field0: "value0", field1: "value1" },
          section1: { field0: "value2" },
        },
      );
      expect((await seed.commit().settled).ok).toEqual({});

      const tx = runtime.edit();
      tx.readValueOrThrow(
        { ...DOCUMENT_ADDRESS, space, path: [] },
        { nonRecursive: true },
      );
      tx.readValueOrThrow({
        ...DOCUMENT_ADDRESS,
        space,
        path: ["section0", "field0"],
      });

      const replica = storage.open(space).replica as SpaceReplica;
      const reads = replica.accessForTestingOnly.buildReads(tx.tx, 1);

      expect(reads.pending).toEqual([]);
      expect(
        reads.confirmed.map((read) => read.path).toSorted((left, right) =>
          JSON.stringify(left).localeCompare(JSON.stringify(right))
        ),
      ).toEqual([
        ["value"],
        ["value", "section0", "field0"],
      ].toSorted((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right))
      ));

      await runtime.dispose();
      await storage.close();
    });

    it("excludes inline data URI reads from tracked commit dependencies", async () => {
      const { signer, storage, runtime } = await createRuntime(
        "memory-v2-read-compaction-inline-data",
      );
      const space = signer.did();
      const dataUri = dataUriFromValue({ inline: true });

      const seed = runtime.edit();
      seed.writeValueOrThrow(
        { ...DOCUMENT_ADDRESS, space },
        { live: { nested: "value" } },
      );
      expect((await seed.commit().settled).ok).toEqual({});

      const tx = runtime.edit();
      tx.readValueOrThrow({ ...DOCUMENT_ADDRESS, space, path: ["live"] });
      tx.readValueOrThrow({
        ...DOCUMENT_ADDRESS,
        space,
        scope: "space",
        id: dataUri,
        path: [],
      });

      const replica = storage.open(space).replica as SpaceReplica;
      const directReads = [...(tx.tx.getReadActivities?.() ?? [])];
      const reads = replica.accessForTestingOnly.buildReads(tx.tx, 1);

      expect(directReads.map((read) => ({ id: read.id, path: read.path })))
        .toEqual([{
          id: DOCUMENT_ADDRESS.id,
          path: toDocumentPath(["value", "live"]),
        }]);
      expect(reads.pending).toEqual([]);
      expect(reads.confirmed.map((read) => ({ id: read.id, path: read.path })))
        .toEqual([{
          id: DOCUMENT_ADDRESS.id,
          path: toDocumentPath(["value", "live"]),
        }]);

      await runtime.dispose();
      await storage.close();
    });
  });

  describe("excludeReadFromConflict", () => {
    it("drops only reads marked `excludeReadFromConflict` and `nonRecursive` from the conflict set, keeping by-value reads", async () => {
      const { signer, storage, runtime } = await createRuntime(
        "memory-v2-read-compaction-exclude-conflict",
      );
      const space = signer.did();

      const seed = runtime.edit();
      seed.writeValueOrThrow(
        { ...DOCUMENT_ADDRESS, space },
        { refShape: { a: 1, b: 2 }, scalar: 5, other: 7 },
      );
      expect((await seed.commit().settled).ok).toEqual({});

      const tx = runtime.edit();
      // (1) marked + nonRecursive: an asCell reference-resolution shape read;
      //     excluded.
      tx.readValueOrThrow(
        { ...DOCUMENT_ADDRESS, space, path: ["refShape"] },
        { meta: excludeReadFromConflict, nonRecursive: true },
      );
      // (2) marked + RECURSIVE: the nonRecursive guard keeps it (defense for
      //     value reads).
      tx.readValueOrThrow(
        { ...DOCUMENT_ADDRESS, space, path: ["other"] },
        { meta: excludeReadFromConflict },
      );
      // (3) UNMARKED + nonRecursive: a by-value scalar argument read -> KEPT.
      //     This is the closed hole: the over-broad scoping used to drop this.
      tx.readValueOrThrow(
        { ...DOCUMENT_ADDRESS, space, path: ["scalar"] },
        { nonRecursive: true },
      );

      const replica = storage.open(space).replica as SpaceReplica;
      const reads = replica.accessForTestingOnly.buildReads(tx.tx, 1);
      const paths = reads.confirmed.map((read) => read.path.join("."));

      expect(
        paths,
        "marked nonRecursive reference read should be excluded",
      ).not.toContain("value.refShape");
      expect(
        paths,
        "marked RECURSIVE read must be kept (value dependency)",
      ).toContain("value.other");
      expect(
        paths,
        "unmarked nonRecursive by-value read must be kept",
      ).toContain("value.scalar");

      await runtime.dispose();
      await storage.close();
    });

    it("keeps an `excludeReadFromConflict` read in the reactivity log, so a repointed link still re-triggers the holder", async () => {
      // excludeReadFromConflict removes a read from the COMMIT-CONFLICT set
      // only; it must NOT remove it from the reactivity log. The asCell
      // reference-resolution read (the link read) therefore remains a reactive
      // dependency, so if the link is repointed the holder is reader-dirtied
      // and re-runs — it just no longer collides with disjoint writers under
      // the referent. This pins the reactivity half (the conflict half is
      // covered by the test above).

      const { signer, storage, runtime } = await createRuntime(
        "memory-v2-read-compaction-exclude-reactivity",
      );
      const space = signer.did();

      const seed = runtime.edit();
      seed.writeValueOrThrow(
        { ...DOCUMENT_ADDRESS, space },
        { refShape: { a: 1, b: 2 } },
      );
      expect((await seed.commit().settled).ok).toEqual({});

      const tx = runtime.edit();
      // The link read: a marked, nonRecursive reference-resolution shape read.
      tx.readValueOrThrow(
        { ...DOCUMENT_ADDRESS, space, path: ["refShape"] },
        { meta: excludeReadFromConflict, nonRecursive: true },
      );

      const replica = storage.open(space).replica as SpaceReplica;

      // Conflict set DROPS the link read (no spurious collision with disjoint
      // writers).
      const conflictPaths = replica.accessForTestingOnly.buildReads(tx.tx, 1)
        .confirmed.map((read) => read.path.join("."));
      expect(
        conflictPaths.some((p) => p.endsWith("refShape")),
        `reference read must be excluded from the conflict set; got ${conflictPaths}`,
      ).toBe(false);

      // Reactivity log KEEPS the link read (as a shallow/nonRecursive read) —
      // this is what makes a repointed link re-trigger the holder.
      const log = txToReactivityLog(tx);
      const reactivePaths = [...log.reads, ...log.shallowReads].map((address) =>
        address.path.join(".")
      );
      expect(
        reactivePaths.some((p) => p.endsWith("refShape")),
        `reference read must stay a reactive dependency; got reads=${
          log.reads.map((a) => a.path.join("."))
        } shallowReads=${log.shallowReads.map((a) => a.path.join("."))}`,
      ).toBe(true);

      await runtime.dispose();
      await storage.close();
    });
  });
});
