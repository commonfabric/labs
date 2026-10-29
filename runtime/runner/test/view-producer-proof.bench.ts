/** Measures freshness proofs over a graph with shared upstream producers. */

import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";

import { Identity } from "@commonfabric/identity";
import type { ViewInterest, ViewPlan } from "@commonfabric/memory/v2";

import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { ISpaceReplica } from "../src/storage/interface.ts";
import { viewInputFingerprint } from "../src/view-input-basis.ts";

const signer = await Identity.fromPassphrase("view producer proof benchmark");
const space = signer.did();

for (const size of [10, 14, 18, 36]) {
  Deno.bench({
    name: `${size} producers with shared ancestors`,
    group: "view producer proof",
    n: 10,
    warmup: 1,
    async fn(b) {
      const storage = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: storage,
        clientClass: "web",
        experimental: { serverExecution: true, viewScopedReplication: true },
      });
      const replica = storage.open(space).replica as Required<ISpaceReplica>;
      let emit!: (plans: readonly ViewPlan[]) => void;
      let interests: ViewInterest[] = [];
      using _supports = stub(
        replica,
        "supportsViewReplication",
        () => Promise.resolve(true),
      );
      using _capable = stub(replica, "viewReplicationSupported", () => true);
      using _plans = stub(replica, "subscribeViewPlans", (observer) => {
        emit = observer;
        observer([]);
        return () => {};
      });
      using _views = stub(replica, "setViewInterests", (next) => {
        interests = next;
        return Promise.resolve(true);
      });
      using _coverage = stub(replica, "hasLocalDocumentCoverage", () => true);
      const getDocument = replica.getDocument.bind(replica);
      using _document = stub(
        replica,
        "getDocument",
        (id, scope, identity) =>
          id.startsWith("of:producer-")
            ? { value: 1 }
            : getDocument(id, scope, identity),
      );
      const basis = (index: number) => ({
        id: `of:producer-${index}`,
        scope: "space" as const,
        path: ["value"],
        fingerprint: viewInputFingerprint({ value: 1 }, ["value"]),
      });
      try {
        await runtime.viewReplication.mount(
          runtime.getCell(space, "proof", undefined),
          "screen",
        );
        emit([{
          id: "screen",
          revision: interests[0].revision,
          generation: 1,
          eligibleActions: [],
          pieces: [],
          producers: Array.from({ length: size }, (_, index) => ({
            id: `producer-${index}`,
            writes: [basis(index)],
            basis: {
              reads: [index - 1, index - 2].filter((i) => i >= 0).map(basis),
              outputs: [basis(index)],
            },
          })),
        }]);
        await runtime.idle();
        await storage.synced();
        b.start();
        const current = runtime.viewReplication.producerCurrent(
          space,
          `producer-${size - 1}`,
          () => false,
          () => {},
        );
        b.end();
        expect(current).toBe(true);
      } finally {
        await runtime.dispose({ closeStorage: false });
        await storage.close();
      }
    },
  });
}
