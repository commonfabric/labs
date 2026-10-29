import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { defer } from "@commonfabric/utils/defer";

import {
  createDocumentReadiness,
  DocumentLoadError,
  DocumentPending,
} from "../src/document-readiness.ts";
import { Runtime } from "../src/runtime.ts";
import type { Action } from "../src/scheduler.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";

const user = await Identity.fromPassphrase("document readiness recovery");

describe("document-readiness", () => {
  it("exempts only completed failures of explicitly optional documents", async () => {
    const manager = EmulatedStorageManager.emulate({ as: user });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.invalid"),
      storageManager: manager,
    });
    const otherSpace =
      (await Identity.fromPassphrase("required document space"))
        .did();
    const optional = runtime.getCell(user.did(), "same document id");
    const required = runtime.getCell(otherSpace, "same document id");
    expect(optional.getAsNormalizedFullLink().id)
      .toBe(required.getAsNormalizedFullLink().id);
    const cancels: (() => void)[] = [];
    const readiness = createDocumentReadiness(
      runtime,
      (cancel) => cancels.push(cancel),
    );
    const originalSync = manager.syncCell.bind(manager);
    manager.syncCell = async (cell, options) => {
      await originalSync(cell, options);
      throw new Error("Document load failed");
    };
    let tx = runtime.edit();
    try {
      expect(() => readiness.requireDocument(optional, tx))
        .toThrow(DocumentPending);
      expect(() => readiness.requireLoadedReads(tx, [optional]))
        .toThrow(DocumentPending);
      expect(() => readiness.requireDocument(required, tx))
        .toThrow(DocumentPending);
      tx.abort();
      await manager.crossSpaceSettled();

      tx = runtime.edit();
      expect(() => readiness.requireDocument(optional, tx))
        .toThrow(DocumentLoadError);
      expect(() => readiness.requireLoadedReads(tx)).toThrow(DocumentLoadError);
      expect(() => readiness.requireLoadedReads(tx, [optional])).not.toThrow();

      // The same id in a different space remains a required failed read.
      expect(() => readiness.requireDocument(required, tx))
        .toThrow(DocumentLoadError);
      expect(() => readiness.requireLoadedReads(tx, [optional]))
        .toThrow(DocumentLoadError);
    } finally {
      tx.abort();
      cancels.forEach((cancel) => cancel());
      manager.syncCell = originalSync;
      await runtime.dispose();
    }
  });

  for (const outcome of ["failed", "pending"] as const) {
    it(`rechecks absence after presence supersedes a ${outcome} load`, async () => {
      const manager = EmulatedStorageManager.emulate({ as: user });
      const runtime = new Runtime({
        apiUrl: new URL("https://example.invalid"),
        storageManager: manager,
      });
      const cell = runtime.getCell(user.did(), "recovering-document");
      const address = { ...cell.getAsNormalizedFullLink(), path: [] };
      const cancels: (() => void)[] = [];
      const readiness = createDocumentReadiness(
        runtime,
        (cancel) => cancels.push(cancel),
      );
      const read = () => {
        const tx = runtime.edit();
        try {
          return readiness.requireDocument(cell, tx);
        } finally {
          tx.abort();
        }
      };
      const release = defer<void>();
      const originalSync = manager.syncCell.bind(manager);
      let loads = 0;
      manager.syncCell = async (target, options) => {
        if (
          target.getAsNormalizedFullLink().id === address.id && ++loads === 1
        ) {
          await release.promise;
          throw new Error("Initial load failed");
        }
        return originalSync(target, options);
      };
      try {
        expect(read).toThrow(DocumentPending);
        if (outcome === "failed") {
          release.resolve();
          await manager.crossSpaceSettled();
          expect(read).toThrow("Could not load document");
        }

        // Storage delivers the document independently of the held load.
        const arrived = manager.edit();
        expect(arrived.write(address, { value: "Recovered" }).error)
          .toBeUndefined();
        expect((await arrived.commit().settled).error).toBeUndefined();
        expect(read()).toBe(true);
        release.resolve();
        await manager.crossSpaceSettled();

        const removed = manager.edit();
        expect(removed.write(address, undefined, { delete: true }).error)
          .toBeUndefined();
        expect((await removed.commit().settled).error).toBeUndefined();
        expect(read).toThrow(DocumentPending);
        await manager.crossSpaceSettled();
        expect(read()).toBe(false);
        expect(loads).toBe(2);
      } finally {
        release.resolve();
        cancels.forEach((cancel) => cancel());
        manager.syncCell = originalSync;
        await runtime.dispose();
      }
    });
  }

  describe("requireSettled()", () => {
    /**
     * A readiness object over an action whose re-arms land in `rearms`, and
     * work that `start` begins at most once, counting its starts.
     */
    function settledFixture() {
      const runtime = new Runtime({
        apiUrl: new URL("https://example.invalid"),
        storageManager: EmulatedStorageManager.emulate({ as: user }),
      });
      const cancels: (() => void)[] = [];
      const readiness = createDocumentReadiness(
        runtime,
        (cancel) => cancels.push(cancel),
      );
      const action = (() => {}) as Action;
      readiness.onActionRegistered(action);
      const rearmed = defer<unknown>();
      runtime.scheduler.invalidateAction = (target, options) => {
        expect(target).toBe(action);
        rearmed.resolve(options);
      };
      const work = defer<void>();
      let starts = 0;
      const start = () => {
        starts++;
        return work.promise;
      };
      return {
        readiness,
        work,
        start,
        rearmed: rearmed.promise,
        starts: () => starts,
        dispose: async () => {
          cancels.forEach((cancel) => cancel());
          await runtime.dispose();
        },
      };
    }

    it("throws `DocumentPending` until the work resolves, re-arms the action, then returns", async () => {
      const fixture = settledFixture();
      try {
        expect(() => fixture.readiness.requireSettled("k", fixture.start))
          .toThrow(DocumentPending);
        expect(() => fixture.readiness.requireSettled("k", fixture.start))
          .toThrow(DocumentPending);
        expect(fixture.starts()).toBe(1);

        fixture.work.resolve();
        expect(await fixture.rearmed).toEqual({ retry: true });
        expect(() => fixture.readiness.requireSettled("k", fixture.start))
          .not.toThrow();
        expect(fixture.starts()).toBe(1);
      } finally {
        await fixture.dispose();
      }
    });

    it("re-arms the action once the work rejects, then throws its reason on every call", async () => {
      const fixture = settledFixture();
      try {
        expect(() => fixture.readiness.requireSettled("k", fixture.start))
          .toThrow(DocumentPending);

        fixture.work.reject(new Error("the work failed"));
        expect(await fixture.rearmed).toEqual({ retry: true });
        expect(() => fixture.readiness.requireSettled("k", fixture.start))
          .toThrow("the work failed");
        expect(() => fixture.readiness.requireSettled("k", fixture.start))
          .toThrow("the work failed");
        expect(fixture.starts()).toBe(1);
      } finally {
        await fixture.dispose();
      }
    });
  });
});
