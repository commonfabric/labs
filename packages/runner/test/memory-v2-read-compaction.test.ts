/**
 * The reads a replica builds from a transaction for its commit: how a
 * recursive ancestor read compacts the reads beneath it, which reads stay
 * out of the commit's dependencies, and what `excludeReadFromConflict`
 * takes out of the conflict set while leaving it in the reactivity log.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { toDocumentPath } from "@commonfabric/memory/v2";
import {
  patchOverlapsNonRecursiveRead,
  patchOverlapsRead,
} from "@commonfabric/memory/v2/engine";
import { dataUriFromValue } from "@commonfabric/data-model/codec-data-uri";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { coarsenCommitReads, type SpaceReplica } from "../src/storage/v2.ts";
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

    it("states a subtree whose every member is read as one recursive read and one shallow read", async () => {
      const { signer, storage, runtime } = await createRuntime(
        "memory-v2-read-compaction-read-in-full",
      );
      const space = signer.did();

      const seed = runtime.edit();
      seed.writeValueOrThrow(
        { ...DOCUMENT_ADDRESS, space },
        {
          section0: { field0: "value0", field1: ["item0"] },
          section1: { field0: "value2" },
        },
      );
      expect((await seed.commit().settled).ok).toEqual({});

      const tx = runtime.edit();
      for (
        const path of [
          [],
          ["section0"],
          ["section0", "field1"],
          ["section0", "absent"],
          ["section1"],
          ["section1", "field0"],
        ]
      ) {
        tx.readValueOrThrow(
          { ...DOCUMENT_ADDRESS, space, path },
          { nonRecursive: true },
        );
      }
      tx.readValueOrThrow({
        ...DOCUMENT_ADDRESS,
        space,
        path: ["section0", "field0"],
      });
      tx.readValueOrThrow({
        ...DOCUMENT_ADDRESS,
        space,
        path: ["section0", "field1", "0"],
      });

      const replica = storage.open(space).replica as SpaceReplica;
      const reads = replica.accessForTestingOnly.buildReads(tx.tx, 1);

      const seq = reads.confirmed[0]?.seq;
      expect(reads.pending).toEqual([]);
      expect(reads.confirmed).toEqual([
        {
          id: DOCUMENT_ADDRESS.id,
          scope: "space",
          path: toDocumentPath(["value"]),
          seq,
          nonRecursive: true,
        },
        {
          id: DOCUMENT_ADDRESS.id,
          scope: "space",
          path: toDocumentPath(["value"]),
          seq,
        },
      ]);

      await runtime.dispose();
      await storage.close();
    });

    it("keeps the shape read of a container with a member nobody read", async () => {
      const { signer, storage, runtime } = await createRuntime(
        "memory-v2-read-compaction-member-unread",
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
      for (const path of [[], ["section0"], ["section0", "field0"]]) {
        tx.readValueOrThrow(
          { ...DOCUMENT_ADDRESS, space, path },
          { nonRecursive: true },
        );
      }
      tx.readValueOrThrow({
        ...DOCUMENT_ADDRESS,
        space,
        path: ["section0", "field1"],
      });

      const replica = storage.open(space).replica as SpaceReplica;
      const reads = replica.accessForTestingOnly.buildReads(tx.tx, 1);

      expect(
        reads.confirmed.map(({ path, nonRecursive }) => ({
          path,
          nonRecursive,
        })),
      ).toEqual([
        { path: toDocumentPath(["value"]), nonRecursive: true },
        { path: toDocumentPath(["value", "section0"]), nonRecursive: true },
        { path: toDocumentPath(["value", "section0"]) },
      ]);

      await runtime.dispose();
      await storage.close();
    });

    it("keeps member reads apart when nothing reads their container's shape", async () => {
      const { signer, storage, runtime } = await createRuntime(
        "memory-v2-read-compaction-shape-unread",
      );
      const space = signer.did();

      const seed = runtime.edit();
      seed.writeValueOrThrow(
        { ...DOCUMENT_ADDRESS, space },
        { section0: { field0: "value0", field1: "value1" } },
      );
      expect((await seed.commit().settled).ok).toEqual({});

      const tx = runtime.edit();
      for (const path of [["section0", "field0"], ["section0", "field1"]]) {
        tx.readValueOrThrow(
          { ...DOCUMENT_ADDRESS, space, path },
          { nonRecursive: true },
        );
      }

      const replica = storage.open(space).replica as SpaceReplica;
      const reads = replica.accessForTestingOnly.buildReads(tx.tx, 1);

      expect(reads.confirmed.map(({ path }) => path)).toEqual([
        toDocumentPath(["value", "section0", "field0"]),
        toDocumentPath(["value", "section0", "field1"]),
      ]);

      await runtime.dispose();
      await storage.close();
    });

    it("coarsens a wire group of more than sixteen reads of one document to its common prefix", async () => {
      // A pattern setup committed with its own reads (a source swap) read
      // fifty-odd paths of every member document; one recursive read at
      // the prefix is a coarser precondition and a message the server
      // takes (MAX_UNTRUSTED_MESSAGE_SLOTS).
      const { signer, storage, runtime } = await createRuntime(
        "memory-v2-read-compaction-coarsen-wide",
      );
      const space = signer.did();
      const members = Array.from({ length: 17 }, (_, i) => `member${i}`);

      const seed = runtime.edit();
      seed.writeValueOrThrow(
        { ...DOCUMENT_ADDRESS, space },
        {
          section: Object.fromEntries(members.map((m) => [m, { n: 1 }])),
          other: "unread",
        },
      );
      expect((await seed.commit().settled).ok).toEqual({});

      const tx = runtime.edit();
      for (const member of members) {
        tx.readValueOrThrow(
          { ...DOCUMENT_ADDRESS, space, path: ["section", member] },
          { nonRecursive: true },
        );
      }

      const replica = storage.open(space).replica as SpaceReplica;
      const built = replica.accessForTestingOnly.buildReads(tx.tx, 1);
      // The replica's own set stays lossless: seventeen shape reads.
      expect(built.confirmed).toHaveLength(17);
      const reads = coarsenCommitReads(built);

      expect(reads.pending).toEqual([]);
      // Two reads: the shallow one keeps the ancestor key-set guard the
      // member shape reads had (an indexed removal above the prefix injects
      // its parent as a touched path, which only the shallow rule matches).
      expect(reads.confirmed.map(({ path, nonRecursive }) => ({
        path,
        nonRecursive,
      }))).toEqual([
        { path: toDocumentPath(["value", "section"]), nonRecursive: true },
        { path: toDocumentPath(["value", "section"]), nonRecursive: undefined },
      ]);

      await runtime.dispose();
      await storage.close();
    });

    it("keeps a shallow read at the prefix, so an indexed removal above it still conflicts", async () => {
      // Seventeen shape reads of the members of `list[1]` coarsen to a
      // recursive read at `value/list/1` — and a shallow one beside it. A
      // concurrent removal at `list/0` shifts other data into `list[1]`; the
      // engine matches it against a shallow read through the removal's
      // injected parent `value/list`, which the recursive rule, on leaves
      // alone, does not reach. Without the shallow read a stale result
      // would commit (Astra, labs #8851).
      const { signer, storage, runtime } = await createRuntime(
        "memory-v2-read-compaction-shallow-guard",
      );
      const space = signer.did();
      const members = Array.from({ length: 17 }, (_, i) => `member${i}`);
      const element = Object.fromEntries(members.map((m) => [m, { n: 1 }]));

      const seed = runtime.edit();
      seed.writeValueOrThrow(
        { ...DOCUMENT_ADDRESS, space },
        { list: [element, element, element] },
      );
      expect((await seed.commit().settled).ok).toEqual({});

      const tx = runtime.edit();
      for (const member of members) {
        tx.readValueOrThrow(
          { ...DOCUMENT_ADDRESS, space, path: ["list", "1", member] },
          { nonRecursive: true },
        );
      }

      const replica = storage.open(space).replica as SpaceReplica;
      const reads = coarsenCommitReads(
        replica.accessForTestingOnly.buildReads(tx.tx, 1),
      );
      const prefix = toDocumentPath(["value", "list", "1"]);
      expect(reads.confirmed.map(({ path, nonRecursive }) => ({
        path,
        nonRecursive,
      }))).toEqual([
        { path: prefix, nonRecursive: true },
        { path: prefix, nonRecursive: undefined },
      ]);

      const removal = [{ op: "remove" as const, path: "/value/list/0" }];
      // The guard: the shallow read at the prefix catches the removal...
      expect(patchOverlapsNonRecursiveRead(removal, [...prefix])).toBe(true);
      // ...which the recursive read alone would not.
      expect(patchOverlapsRead(removal, [...prefix])).toBe(false);

      await runtime.dispose();
      await storage.close();
    });

    it("keeps sixteen reads of one document apart", async () => {
      const { signer, storage, runtime } = await createRuntime(
        "memory-v2-read-compaction-sixteen-apart",
      );
      const space = signer.did();
      const members = Array.from({ length: 16 }, (_, i) => `member${i}`);

      const seed = runtime.edit();
      seed.writeValueOrThrow(
        { ...DOCUMENT_ADDRESS, space },
        {
          section: Object.fromEntries(members.map((m) => [m, { n: 1 }])),
          other: "unread",
        },
      );
      expect((await seed.commit().settled).ok).toEqual({});

      const tx = runtime.edit();
      for (const member of members) {
        tx.readValueOrThrow(
          { ...DOCUMENT_ADDRESS, space, path: ["section", member] },
          { nonRecursive: true },
        );
      }

      const replica = storage.open(space).replica as SpaceReplica;
      const reads = replica.accessForTestingOnly.buildReads(tx.tx, 1);

      expect(reads.confirmed.length).toBe(16);
      expect(reads.confirmed.every((read) => read.nonRecursive === true))
        .toBe(true);
      // Sixteen is the bound: the wire set is the same object.
      expect(coarsenCommitReads(reads)).toBe(reads);

      await runtime.dispose();
      await storage.close();
    });

    it("keeps a shallow read where it merges an array element, so a shift of the array still conflicts", async () => {
      // An indexed removal before `list/1` shifts a different element into
      // it. The shallow read conflicts with that removal, and the recursive
      // read does not.

      const { signer, storage, runtime } = await createRuntime(
        "memory-v2-read-compaction-array-element",
      );
      const space = signer.did();

      const seed = runtime.edit();
      seed.writeValueOrThrow(
        { ...DOCUMENT_ADDRESS, space },
        { list: [["value0"], ["value1", "value2"]] },
      );
      expect((await seed.commit().settled).ok).toEqual({});

      const tx = runtime.edit();
      tx.readValueOrThrow({ ...DOCUMENT_ADDRESS, space, path: ["list", "1"] });
      for (const path of [["list", "1", "0"], ["list", "1", "1"]]) {
        tx.readValueOrThrow(
          { ...DOCUMENT_ADDRESS, space, path },
          { nonRecursive: true },
        );
      }

      const replica = storage.open(space).replica as SpaceReplica;
      const reads = replica.accessForTestingOnly.buildReads(tx.tx, 1);

      expect(
        reads.confirmed.map(({ path, nonRecursive }) => ({
          path,
          nonRecursive,
        })),
      ).toEqual([
        { path: toDocumentPath(["value", "list", "1"]), nonRecursive: true },
        { path: toDocumentPath(["value", "list", "1"]) },
      ]);

      await runtime.dispose();
      await storage.close();
    });

    it("keeps both a shallow and a recursive read of one path", async () => {
      // A removal before `list/1` shifts a different element into it. The
      // shallow read conflicts with that removal, and the recursive read does
      // not.

      const { signer, storage, runtime } = await createRuntime(
        "memory-v2-read-compaction-both-kinds",
      );
      const space = signer.did();

      const seed = runtime.edit();
      seed.writeValueOrThrow(
        { ...DOCUMENT_ADDRESS, space },
        { list: ["value0", "value1"] },
      );
      expect((await seed.commit().settled).ok).toEqual({});

      const tx = runtime.edit();
      tx.readValueOrThrow(
        { ...DOCUMENT_ADDRESS, space, path: ["list", "1"] },
        { nonRecursive: true },
      );
      tx.readValueOrThrow({ ...DOCUMENT_ADDRESS, space, path: ["list", "1"] });

      const replica = storage.open(space).replica as SpaceReplica;
      const reads = replica.accessForTestingOnly.buildReads(tx.tx, 1);

      expect(
        reads.confirmed.map(({ path, nonRecursive }) => ({
          path,
          nonRecursive,
        })),
      ).toEqual([
        { path: toDocumentPath(["value", "list", "1"]), nonRecursive: true },
        { path: toDocumentPath(["value", "list", "1"]) },
      ]);

      await runtime.dispose();
      await storage.close();
    });

    it("counts an array's `length` read as none of its elements", async () => {
      const { signer, storage, runtime } = await createRuntime(
        "memory-v2-read-compaction-array-length",
      );
      const space = signer.did();

      const seed = runtime.edit();
      seed.writeValueOrThrow(
        { ...DOCUMENT_ADDRESS, space },
        { list: ["value0", "value1"] },
      );
      expect((await seed.commit().settled).ok).toEqual({});

      const tx = runtime.edit();
      tx.readValueOrThrow(
        { ...DOCUMENT_ADDRESS, space, path: ["list"] },
        { nonRecursive: true },
      );
      for (const path of [["list", "0"], ["list", "length"]]) {
        tx.readValueOrThrow({ ...DOCUMENT_ADDRESS, space, path });
      }

      const replica = storage.open(space).replica as SpaceReplica;
      const reads = replica.accessForTestingOnly.buildReads(tx.tx, 1);

      expect(
        reads.confirmed.map(({ path, nonRecursive }) => ({
          path,
          nonRecursive,
        })),
      ).toEqual([
        { path: toDocumentPath(["value", "list"]), nonRecursive: true },
        { path: toDocumentPath(["value", "list", "0"]) },
        { path: toDocumentPath(["value", "list", "length"]) },
      ]);

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
