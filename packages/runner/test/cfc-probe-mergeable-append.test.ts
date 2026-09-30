import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { cfcAtom } from "@commonfabric/api/cfc";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";

import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { Runtime } from "../src/runtime.ts";
import { isStaleReadConflict } from "../src/storage/rejection.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("cfc-probe-mergeable-append");
const space = signer.did();
const CAUSE = "probe-mergeable-append-list";
const LABELED_CAUSE = "probe-mergeable-append-labeled-list";
const LINK_SOURCE_CAUSE = "probe-mergeable-append-link-source";
const LINK_TARGET_CAUSE = "probe-mergeable-append-link-target";

const stringListSchema = {
  type: "array",
  items: { type: "string" },
  // deno-lint-ignore no-explicit-any
} as any;

// The same list shape with a schema-declared element label. Writes through this
// schema record a schema write-policy input and mark the transaction
// CFC-relevant, so the prepare pass runs and persists label metadata onto the
// document's `["cfc"]` envelope.
const labeledListSchema = {
  type: "array",
  items: {
    type: "string",
    ifc: { confidentiality: [cfcAtom.resource("Secret")] },
  },
  // deno-lint-ignore no-explicit-any
} as any;

// Read the durable array from a fresh session that pulls it straight off the
// shared server, so the assertion reflects committed/durable state rather than
// any one writer's optimistic local view.
async function readDurable(
  server: MemoryV2Server.Server,
  cause: string,
  // deno-lint-ignore no-explicit-any
  schema: any,
): Promise<string[]> {
  const storage = EmulatedStorageManager.connectTo(server, { as: signer });
  const rt = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: storage,
  });
  try {
    const cell = rt.getCell<string[]>(space, cause, schema);
    await cell.sync();
    await cell.pull();
    return (cell.get() ?? []) as string[];
  } finally {
    await rt.dispose();
    await storage.close();
  }
}

describe("CFC metadata probes under mergeable appends", () => {
  // The CFC prepare pass reads a document's stored label metadata through
  // `storedMetadataFor`, and its result schema through `setupResultSchemaFor`.
  // Both read the member surface they want — `["cfc"]` and `["schema"]` —
  // rather than the document root. Incidental probes and mergeable operations'
  // own value reads do not constrain admission; authorization reads retain
  // their revision basis. A stable wildcard label therefore permits both
  // appends, while changed per-slot reference metadata requires a conflict
  // and a refreshed write (covered by cfc-array-concurrency.test.ts).

  let server: MemoryV2Server.Server;
  let storage1: EmulatedStorageManager;
  let storage2: EmulatedStorageManager;

  beforeEach(() => {
    // Manual fan-out: controlled staleness is a gated state, not a timing
    // accident.
    server = newSharedServer({ subscriptionRefreshDelayMs: "manual" });
    storage1 = EmulatedStorageManager.connectTo(server, { as: signer });
    storage2 = EmulatedStorageManager.connectTo(server, { as: signer });
  });
  afterEach(async () => {
    await storage1?.close();
    await storage2?.close();
    await server?.close();
  });

  const runtimes = () =>
    [
      new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: storage1,
        cfcFlowLabels: "persist",
      }),
      new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: storage2,
        cfcFlowLabels: "persist",
      }),
    ] as const;

  it("commits both of two concurrent appends while the flow-labels probe runs", async () => {
    // The shape that reaches every document once the flow dial defaults on: the
    // list carries no labels at all, but the relevance probe still reads its
    // metadata on every commit.

    const [rt1, rt2] = runtimes();
    try {
      // Seed the list with one element and get it durable on the server.
      const tx0 = rt1.edit();
      rt1.getCell<string[]>(space, CAUSE, stringListSchema, tx0).set(["seed"]);
      await tx0.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();

      // Both sessions load the seeded list, so both replicas hold ["seed"] at
      // the same basis sequence.
      const cell2 = rt2.getCell<string[]>(space, CAUSE, stringListSchema);
      await cell2.sync();
      await cell2.pull();
      expect(cell2.get()).toEqual(["seed"]);

      // Session 1 appends "A".
      const txA = rt1.edit();
      rt1.getCell<string[]>(space, CAUSE, stringListSchema, txA).push("A");
      await txA.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();

      // Session 2 appends "B" WITHOUT having observed session 1's "A": its
      // replica still holds ["seed"] at the pre-"A" basis. The probe's
      // metadata read of the concurrently bumped document must not conflict
      // this commit.
      const txB = rt2.edit();
      rt2.getCell<string[]>(space, CAUSE, stringListSchema, txB).push("B");
      const result = await txB.commit({ resolveAt: "verdict" });
      await rt2.storageManager.synced();

      expect(result.error).toBeUndefined();
      const durable = await readDurable(server, CAUSE, stringListSchema);
      expect(durable.length).toBe(3);
      expect(durable).toContain("seed");
      expect(durable).toContain("A");
      expect(durable).toContain("B");
    } finally {
      await rt2.dispose();
      await rt1.dispose();
    }
  });

  it("commits both of two concurrent appends to a labeled list", async () => {
    // The same loss on a list whose schema declares an element label: the write
    // marks the transaction CFC-relevant on its own, and the prepare pass reads
    // the document's stored metadata.

    const [rt1, rt2] = runtimes();
    try {
      // Seed through the labeled schema; the prepare pass persists the derived
      // label metadata onto the document.
      const tx0 = rt1.edit();
      rt1.getCell<string[]>(space, LABELED_CAUSE, labeledListSchema, tx0)
        .set(["seed"]);
      tx0.prepareCfc();
      const result0 = await tx0.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();
      expect(result0.error).toBeUndefined();

      // The document really does carry persisted CFC metadata, so this
      // scenario is the labeled one rather than a copy of the case above.
      const labeledId = rt1
        .getCell<string[]>(space, LABELED_CAUSE, labeledListSchema)
        .getAsNormalizedFullLink().id;
      const replica = storage1.open(space).replica as unknown as {
        getDocument(
          id: string,
        ): { cfc?: { labelMap?: { entries: unknown[] } } } | undefined;
      };
      expect(replica.getDocument(labeledId)?.cfc?.labelMap?.entries.length ?? 0)
        .toBeGreaterThan(0);

      const cell2 = rt2.getCell<string[]>(
        space,
        LABELED_CAUSE,
        labeledListSchema,
      );
      await cell2.sync();
      await cell2.pull();
      expect(cell2.get()).toEqual(["seed"]);

      // Session 1 appends "A" through the prepare pass.
      const txA = rt1.edit();
      rt1.getCell<string[]>(space, LABELED_CAUSE, labeledListSchema, txA)
        .push("A");
      txA.prepareCfc();
      const resultA = await txA.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();
      expect(resultA.error).toBeUndefined();

      // Session 2 appends "B" against the pre-"A" basis, again through the
      // prepare pass. The pass's metadata reads must not conflict this commit.
      const txB = rt2.edit();
      rt2.getCell<string[]>(space, LABELED_CAUSE, labeledListSchema, txB)
        .push("B");
      txB.prepareCfc();
      const resultB = await txB.commit({ resolveAt: "verdict" });
      await rt2.storageManager.synced();

      expect(resultB.error).toBeUndefined();
      const durable = await readDurable(
        server,
        LABELED_CAUSE,
        labeledListSchema,
      );
      expect(durable.length).toBe(3);
      expect(durable).toContain("seed");
      expect(durable).toContain("A");
      expect(durable).toContain("B");
    } finally {
      await rt2.dispose();
      await rt1.dispose();
    }
  });

  it("commits a link write whose source a concurrent append targets", async () => {
    // Independently acquired reference identities do not consume their target
    // contents. Appending to that target may also change its metadata, but
    // neither change invalidates this reference-only write.

    const [rt1, rt2] = runtimes();
    try {
      // The target has content labels, so this also checks that creating the
      // reference does not acquire those content restrictions.
      const tx0 = rt1.edit();
      rt1.getCell<string[]>(space, LINK_SOURCE_CAUSE, labeledListSchema, tx0)
        .set(["seed"]);
      tx0.prepareCfc();
      expect((await tx0.commit({ resolveAt: "verdict" })).error)
        .toBeUndefined();
      await rt1.storageManager.synced();

      const sourceId = rt1
        .getCell<string[]>(space, LINK_SOURCE_CAUSE, labeledListSchema)
        .getAsNormalizedFullLink().id;

      // Session 2 appends to that list, durably.
      const cell2 = rt2.getCell<string[]>(
        space,
        LINK_SOURCE_CAUSE,
        labeledListSchema,
      );
      await cell2.sync();
      await cell2.pull();
      const txA = rt2.edit();
      rt2.getCell<string[]>(space, LINK_SOURCE_CAUSE, labeledListSchema, txA)
        .push("A");
      txA.prepareCfc();
      expect((await txA.commit({ resolveAt: "verdict" })).error)
        .toBeUndefined();
      await rt2.storageManager.synced();

      // Session 1, still at the pre-append basis, writes a link whose source
      // is that list. Only the source's `cfc` and `schema` meta are
      // consulted, neither of which describes the appended element, so the
      // concurrent append must not conflict this commit.
      const txB = rt1.edit();
      const target = rt1.getCell(space, LINK_TARGET_CAUSE, undefined, txB);
      const source = rt1.getCellFromEntityId(
        space,
        sourceId,
        [],
        labeledListSchema,
      );
      target.key("field").set(source.getAsLink());
      txB.prepareCfc();
      const result = await txB.commit({ resolveAt: "verdict" });

      expect(result.error).toBeUndefined();
    } finally {
      await rt2.dispose();
      await rt1.dispose();
    }
  });

  it("returns a conflict error for a conditional push racing a concurrent append", async () => {
    // The opposite direction: the surface read is exempt, but a handler's own
    // explicit read of the list is not, so the dedup-then-push shape still
    // conflicts and retries.

    const [rt1, rt2] = runtimes();
    try {
      const tx0 = rt1.edit();
      rt1.getCell<string[]>(space, CAUSE, stringListSchema, tx0).set(["seed"]);
      await tx0.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();

      const cell2 = rt2.getCell<string[]>(space, CAUSE, stringListSchema);
      await cell2.sync();
      await cell2.pull();

      const txA = rt1.edit();
      rt1.getCell<string[]>(space, CAUSE, stringListSchema, txA).push("A");
      await txA.commit({ resolveAt: "verdict" });
      await rt1.storageManager.synced();

      // Session 2, still at the pre-"A" basis, reads the list explicitly and
      // then pushes — the dedup-then-push shape. The explicit read is
      // retained, so the commit conflicts with session 1's append.
      const txB = rt2.edit();
      const cellB = rt2.getCell<string[]>(space, CAUSE, stringListSchema, txB);
      cellB.get();
      cellB.push("B");
      const result = await txB.commit({ resolveAt: "verdict" });

      expect(isStaleReadConflict(result.error)).toBe(true);
      const durable = await readDurable(server, CAUSE, stringListSchema);
      expect(durable).toEqual(["seed", "A"]);
    } finally {
      await rt2.dispose();
      await rt1.dispose();
    }
  });
});
