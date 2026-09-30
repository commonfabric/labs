/// <reference path="./clock.d.ts" />

/** Verifies that concurrent array edits preserve each stored reference slot. */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";

import { readStoredCfcMetadata } from "../src/cfc/metadata.ts";
import { getCfcReferenceProvenance } from "../src/cfc/reference-provenance.ts";
import { Runtime } from "../src/runtime.ts";
import type { SealedCommitVerdict } from "../src/storage/interface.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import type { SpaceReplica } from "../src/storage/v2.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("cfc-array-concurrency");
const space = signer.did();

describe("cfc-array-concurrency", () => {
  for (const method of ["push", "removeByValue"] as const) {
    it(`keeps pending ${method} slots aligned with their labels when a peer append arrives`, async () => {
      const server = newSharedServer({ subscriptionRefreshDelayMs: "manual" });
      const storageA = EmulatedStorageManager.connectTo(server, { as: signer });
      const storageB = EmulatedStorageManager.connectTo(server, { as: signer });
      const a = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: storageA,
        cfcFlowLabels: "persist",
      });
      const b = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: storageB,
        cfcFlowLabels: "persist",
      });
      const target = (runtime: Runtime, key: string) =>
        runtime.getCell(space, key);
      const list = (runtime: Runtime) =>
        runtime.getCell(space, "list", { type: "array", items: {} });
      const verdict = Promise.withResolvers<SealedCommitVerdict>();
      let layer: ReturnType<SpaceReplica["sealNative"]> | undefined;
      try {
        const seed = a.edit();
        for (const key of ["a", "b", "c", "d"]) {
          target(a, key).withTx(seed).set(key);
        }
        list(a).withTx(seed).set([target(a, "a"), target(a, "b")]);
        expect((await seed.commit({ resolveAt: "verdict" })).error)
          .toBeUndefined();
        await server.flushSessions([space]);
        await storageA.synced();
        await list(b).sync();
        await list(b).pull();

        const pending = b.edit();
        const selected = method === "push" ? "d" : "b";
        list(b).withTx(pending)[method](target(b, selected));
        b.prepareTxForCommit(pending);
        const draft = pending.tx.getNativeCommit!(space)!;
        const replica = storageB.open(space).replica as SpaceReplica;
        layer = replica.sealNative(draft, pending.tx, verdict.promise);
        pending.abort();

        const peer = a.edit();
        list(a).withTx(peer).push(target(a, "c"));
        expect((await peer.commit({ resolveAt: "verdict" })).error)
          .toBeUndefined();
        await server.flushSessions([space]);
        await clock.settle();

        const read = b.edit();
        try {
          const stored = list(b).withTx(read);
          const expected = method === "push" ? ["a", "b", "d"] : ["a"];
          const actualLength = stored.key("length").get() as number;
          for (let index = 0; index < actualLength; index++) {
            expect(getCfcReferenceProvenance(stored.key(index).resolveAsCell()))
              .toBeDefined();
          }
          expect(actualLength).toBe(expected.length);
          for (const [index, key] of expected.entries()) {
            expect(
              stored.key(index).resolveAsCell().getAsNormalizedFullLink().id,
            )
              .toBe(target(b, key).getAsNormalizedFullLink().id);
          }
        } finally {
          read.abort();
        }
      } finally {
        verdict.resolve({ withdrawn: { message: "test complete" } });
        await layer?.settled;
        await server.flushSessions([space]);
        await a.dispose();
        await b.dispose();
        await storageA.close();
        await storageB.close();
        await server.close();
      }
    });

    it(`rejects stale slot metadata during ${method} and preserves acquisitions after a refreshed write`, async () => {
      const server = newSharedServer({ subscriptionRefreshDelayMs: "manual" });
      const storageA = EmulatedStorageManager.connectTo(server, { as: signer });
      const storageB = EmulatedStorageManager.connectTo(server, { as: signer });
      const a = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: storageA,
        cfcFlowLabels: "persist",
      });
      const b = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: storageB,
        cfcFlowLabels: "persist",
      });
      const target = (runtime: Runtime, key: string) =>
        runtime.getCell(space, key);
      const list = (runtime: Runtime) =>
        runtime.getCell(space, "list", { type: "array", items: {} });
      try {
        const seed = a.edit();
        for (const key of ["a", "b", "c"]) target(a, key).withTx(seed).set(key);
        list(a).withTx(seed).set([target(a, "a"), target(a, "b")]);
        expect((await seed.commit({ resolveAt: "verdict" })).error)
          .toBeUndefined();
        await server.flushSessions([space]);
        await storageA.synced();
        await list(b).sync();
        await list(b).pull();

        const first = a.edit();
        list(a).withTx(first).push(target(a, "c"));
        expect((await first.commit({ resolveAt: "verdict" })).error)
          .toBeUndefined();
        const stale = b.edit();
        list(b).withTx(stale)[method](target(b, "a"));
        const rejected = await stale.commit({ resolveAt: "verdict" });
        expect(rejected.error?.name).toBe("ConflictError");
        await server.flushSessions([space]);
        await clock.settle();

        const fresh = b.edit();
        list(b).withTx(fresh)[method](target(b, "a"));
        expect((await fresh.commit({ resolveAt: "verdict" })).error)
          .toBeUndefined();
        await server.flushSessions([space]);
        await storageA.synced();
        await storageB.synced();

        const read = b.edit();
        const stored = list(b).withTx(read);
        const expected = method === "push" ? ["a", "b", "c", "a"] : ["b", "c"];
        expect(stored.key("length").get()).toBe(expected.length);
        const metadata = readStoredCfcMetadata(
          read,
          stored.getAsNormalizedFullLink(),
        );
        for (const [index, key] of expected.entries()) {
          const acquired = stored.key(index).resolveAsCell();
          expect(getCfcReferenceProvenance(acquired)).toBeDefined();
          expect(acquired.getAsNormalizedFullLink().id).toBe(
            target(b, key).getAsNormalizedFullLink().id,
          );
          expect(
            metadata?.labelMap.entries.some((entry) =>
              entry.origin === "link" && entry.observes === "followRef" &&
              entry.path.join("/") === String(index)
            ),
          ).toBe(true);
        }
        read.abort();
      } finally {
        await server.flushSessions([space]);
        await a.dispose();
        await b.dispose();
        await storageA.close();
        await storageB.close();
        await server.close();
      }
    });
  }
});
