import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import type { Cell } from "../../src/cell.ts";
import { collectionKeyBucket } from "../../src/builtins/collection-index-key.ts";
import type {
  CollectionIndexMembership,
  MaintainedCollectionIndex,
} from "../../src/builtins/collection-index-membership.ts";
import { ownedCell } from "../../src/builtins/runtime-owned-store.ts";
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";
import type { IExtendedStorageTransaction } from "../../src/storage/interface.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "../cfc-seed-envelope.ts";

/**
 * Every member of a collection index writes into one shared index document,
 * and each write stamps that document's CFC label map. A member that resolves
 * the index and state documents as ordinary dependencies then wakes on every
 * other member's stamp, so one added source element re-runs every member the
 * index already has. The sources must carry labels for the stamps to exist,
 * which is why an unlabeled fixture never shows this.
 */
describe("collection-index-label-fanout", () => {
  for (const method of ["groupBy", "keyBy"] as const) {
    it(`a ${method} member does not re-run when another member's write stamps the index`, async () => {
      const signer = await Identity.fromPassphrase(
        `index-label-fanout-${method}`,
      );
      const space = signer.did();
      const storage = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL("https://example.com"),
        storageManager: storage,
        cfcFlowLabels: "persist",
      });
      let cancel: (() => void) | undefined;
      try {
        const compiled = await runtime.patternManager.compilePattern({
          main: "/main.tsx",
          files: [{
            name: "/main.tsx",
            contents: `
              import { pattern, Writable } from "commonfabric";
              export default pattern<{rows: Writable<{label: string}[]>}>(({rows}) => {
                const index = rows.${method}(row => row.label);
                return {index, selected: index.lookup("a")};
              });`,
          }],
        });
        const rows = runtime.getCell<{ label: string }[]>(space, "rows");
        const rowLinks: unknown[] = [];
        /** Appends a labeled row; the label is what makes member writes stamp the index. */
        const addRow = async (cause: string, label: string) => {
          const seed = runtime.edit();
          const row = runtime.getCell<{ label: string }>(
            space,
            cause,
            undefined,
            seed,
          );
          const id = row.getAsNormalizedFullLink().id;
          writeSeedEnvelopeDoc(seed, space);
          seedStoredEnvelope(seed, { space, scope: "space", id, path: [] }, {
            value: { label },
            cfc: {
              version: 1,
              schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
              labelMap: {
                version: 1,
                entries: [{
                  path: [],
                  label: { confidentiality: ["row-secret"] },
                }],
              },
            },
          });
          rowLinks.push({ "/": { "link@1": { id, path: [] } } });
          seedStoredEnvelope(seed, {
            space,
            scope: "space",
            id: rows.getAsNormalizedFullLink().id,
            path: [],
          }, {
            value: rowLinks as never,
            cfc: {
              version: 1,
              schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
              labelMap: { version: 1, entries: [] },
            },
          });
          expect((await seed.commit().settled).error).toBeUndefined();
          await runtime.idle();
        };
        await addRow("row-0", "a");
        await addRow("row-1", "b");
        await addRow("row-2", "c");
        const tx = runtime.edit();
        const result = runtime.run(
          tx,
          compiled,
          { rows },
          runtime.getCell<
            { index: MaintainedCollectionIndex; selected: unknown }
          >(space, "result", compiled.resultSchema, tx),
        );
        runtime.prepareTxForCommit(tx);
        expect((await tx.commit().settled).error).toBeUndefined();
        cancel = result.key("selected").sink(() => {});
        await runtime.idle();
        /** Run count per member action, keyed by the action's node id. */
        const memberRuns = () =>
          new Map(
            runtime.scheduler.getGraphSnapshot().nodes
              .filter((node) =>
                node.id.startsWith("raw:collectionIndexMember:")
              )
              .map((node) => [node.id, node.stats?.runCount ?? 0] as const),
          );
        const index = result.key("index").resolveAsCell();
        const indexId = index.getAsNormalizedFullLink().id;
        type Stamp = { path: string[]; label: { confidentiality?: unknown[] } };
        /** The label-map entries the member writes have left on the index document. */
        const stamps = (): Stamp[] => {
          const replica = (storage.open(space) as unknown as {
            replica: {
              getDocument(
                id: string,
              ): { cfc?: { labelMap?: { entries: Stamp[] } } } | undefined;
            };
          }).replica;
          return replica.getDocument(indexId)?.cfc?.labelMap?.entries ?? [];
        };
        /** Every stamp on `label`'s bucket carries the source row's secret. */
        const expectBucketKeepsSecret = (label: string) => {
          const bucket = collectionKeyBucket({ kind: "string", value: label });
          const onBucket = stamps().filter((stamp) =>
            stamp.path[0] === "buckets" && stamp.path[1] === bucket
          );
          expect(onBucket.length).toBeGreaterThan(0);
          for (const stamp of onBucket) {
            expect(stamp.label.confidentiality).toContain("row-secret");
          }
        };
        const before = memberRuns();
        expect(before.size).toBe(3);
        // The fixture is only a reproduction when the writes stamp the index.
        expect(stamps().length).toBeGreaterThan(0);
        await addRow("row-3", "d");
        await addRow("row-4", "e");
        // The machinery-read scope changes scheduling only: the stamps the
        // members leave still carry the source rows' labels, on the buckets
        // present before the additions and on the ones they created.
        for (const label of ["a", "b", "c", "d", "e"]) {
          expectBucketKeepsSecret(label);
        }
        const after = memberRuns();
        expect(after.size).toBe(5);
        // The three original members did not run again; the two new members
        // each ran, and the stamps their writes left on the index woke no one.
        for (const [id, runs] of before) {
          expect([id, after.get(id)]).toEqual([id, runs]);
        }
        for (const [id, runs] of after) {
          if (!before.has(id)) expect([id, runs]).toEqual([id, 1]);
        }
        expect(result.key("selected").get()).toEqual(
          method === "groupBy" ? [{ label: "a" }] : { label: "a" },
        );
      } finally {
        cancel?.();
        await storage.synced();
        await runtime.dispose({ closeStorage: false });
        await storage.close();
      }
    });
  }

  /**
   * Runs `body` against a `groupBy` index over one labeled row, settled, with
   * the member's argument document, which names the state and index it
   * maintains, and a reader of that member's scheduler node.
   */
  async function withIndexMember(
    passphrase: string,
    body: (fixture: {
      runtime: Runtime;
      space: ReturnType<Identity["did"]>;
      result: Cell<{ index: MaintainedCollectionIndex; selected: unknown }>;
      argument: Cell<unknown>;
      member: () => ReturnType<
        Runtime["scheduler"]["getGraphSnapshot"]
      >["nodes"][number];
    }) => Promise<void>,
  ): Promise<void> {
    const signer = await Identity.fromPassphrase(passphrase);
    const space = signer.did();
    const storage = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager: storage,
      cfcFlowLabels: "persist",
    });
    let cancel: (() => void) | undefined;
    try {
      const compiled = await runtime.patternManager.compilePattern({
        main: "/main.tsx",
        files: [{
          name: "/main.tsx",
          contents: `
            import { pattern, Writable } from "commonfabric";
            export default pattern<{rows: Writable<{label: string}[]>}>(({rows}) => {
              const index = rows.groupBy(row => row.label);
              return {index, selected: index.lookup("a")};
            });`,
        }],
      });
      const rows = runtime.getCell<{ label: string }[]>(space, "rows");
      const seed = runtime.edit();
      const row = runtime.getCell<{ label: string }>(
        space,
        "row-0",
        undefined,
        seed,
      );
      const rowId = row.getAsNormalizedFullLink().id;
      writeSeedEnvelopeDoc(seed, space);
      seedStoredEnvelope(seed, { space, scope: "space", id: rowId, path: [] }, {
        value: { label: "a" },
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{ path: [], label: { confidentiality: ["row-secret"] } }],
          },
        },
      });
      seedStoredEnvelope(seed, {
        space,
        scope: "space",
        id: rows.getAsNormalizedFullLink().id,
        path: [],
      }, {
        value: [{ "/": { "link@1": { id: rowId, path: [] } } }] as never,
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: { version: 1, entries: [] },
        },
      });
      expect((await seed.commit().settled).error).toBeUndefined();
      const tx = runtime.edit();
      const result = runtime.run(
        tx,
        compiled,
        { rows },
        runtime.getCell<
          { index: MaintainedCollectionIndex; selected: unknown }
        >(space, "result", compiled.resultSchema, tx),
      );
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit().settled).error).toBeUndefined();
      cancel = result.key("selected").sink(() => {});
      await runtime.idle();
      const member = () =>
        runtime.scheduler.getGraphSnapshot().nodes
          .find((node) => node.id.startsWith("raw:collectionIndexMember:"))!;
      expect(member().stats?.runCount ?? 0).toBeGreaterThan(0);
      // The member's argument document is the one it reads its key from.
      const reads = member().reads as string[];
      const argumentRead = reads.find((read) =>
        read.includes("/value/extracted")
      );
      if (argumentRead === undefined) {
        throw new Error(`no argument read among ${JSON.stringify(reads)}`);
      }
      const argumentId = argumentRead.match(/(of:fid1:[A-Za-z0-9_-]+)/)![1];
      const argument = runtime.getCellFromLink({
        space,
        id: argumentId as `${string}:${string}`,
        path: [],
      });
      await body({ runtime, space, result, argument, member });
    } finally {
      cancel?.();
      await storage.synced();
      await runtime.dispose({ closeStorage: false });
      await storage.close();
    }
  }

  /** A store the member may write into: enrolled as runtime-owned, as the coordinator's own state is. */
  const emptyMembershipStore = (
    runtime: Runtime,
    tx: IExtendedStorageTransaction,
    owner: Cell<unknown>,
    cause: string,
  ): Cell<CollectionIndexMembership> => {
    const store = ownedCell<CollectionIndexMembership>(
      runtime,
      tx,
      owner,
      { [cause]: true },
      undefined,
      "space",
    );
    store.set({ assignments: {}, members: {}, occupied: {} });
    return store;
  };

  it("runs a member again when the reference in its own state slot is replaced", async () => {
    // The member's argument document names the shared state and index it
    // maintains. Resolving those documents is plumbing and wakes no member
    // when another member's write stamps them, but which document a slot
    // names stays the member's own dependency: a write that retargets the
    // slot runs the member again, against the document it now names.
    await withIndexMember(
      "index-label-fanout-retarget",
      async ({ runtime, result, argument, member }) => {
        const before = member().stats?.runCount ?? 0;
        const retarget = runtime.edit();
        const replacement = emptyMembershipStore(
          runtime,
          retarget,
          result,
          "replacementState",
        );
        argument.withTx(retarget).key("state").set(replacement);
        expect((await retarget.commit().settled).error).toBeUndefined();
        await runtime.idle();
        expect(member().stats?.runCount).toBe(before + 1);
        // The member maintained the document its slot now names.
        expect(Object.keys(replacement.key("assignments").get() ?? {}))
          .toHaveLength(1);
      },
    );
  });

  it("runs a member again when a link along its state slot's chain is replaced", async () => {
    // A slot may name its document through further links. Every link the
    // member follows on the way is its own dependency, not only the first:
    // replacing one partway along the chain runs the member again, against
    // the document the chain now reaches.
    await withIndexMember(
      "index-label-fanout-retarget-chain",
      async ({ runtime, space, result, argument, member }) => {
        // Route the slot through an intermediate link to the state it names.
        const reroute = runtime.edit();
        const via = runtime.getCell<CollectionIndexMembership>(
          space,
          "state-via",
          undefined,
          reroute,
        );
        via.set(argument.withTx(reroute).key("state").resolveAsCell());
        argument.withTx(reroute).key("state").set(via);
        expect((await reroute.commit().settled).error).toBeUndefined();
        await runtime.idle();
        const rerouted = member().stats?.runCount ?? 0;
        // Replace the link partway along the chain; the slot itself is untouched.
        const retarget = runtime.edit();
        const replacement = emptyMembershipStore(
          runtime,
          retarget,
          result,
          "replacementStateViaChain",
        );
        via.withTx(retarget).set(replacement);
        expect((await retarget.commit().settled).error).toBeUndefined();
        await runtime.idle();
        expect(member().stats?.runCount).toBe(rerouted + 1);
        // The member maintained the document the chain now reaches.
        expect(Object.keys(replacement.key("assignments").get() ?? {}))
          .toHaveLength(1);
      },
    );
  });
});
