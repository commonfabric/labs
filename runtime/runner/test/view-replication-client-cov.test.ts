import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import { Identity } from "@commonfabric/identity";
import type { ViewInterest, ViewPlan } from "@commonfabric/memory/v2";

import type { Cell } from "../src/cell.ts";
import { rawMetaWriteAuthorization } from "../src/meta-seam.ts";
import { patternIdentityKey } from "../src/runner.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { viewInputFingerprint } from "../src/view-input-basis.ts";

const signer = await Identity.fromPassphrase("view replication client cov");
const space = signer.did();
const source = { identity: "client-cov-fixture", symbol: "default" };
const identity = patternIdentityKey(source);

/**
 * A runtime requesting view-scoped replication over an emulated replica whose
 * view negotiation, plans and interests are the test's to drive.
 */
const harness = () => {
  const storage = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: storage,
    clientClass: "web",
    experimental: { serverExecution: true, viewScopedReplication: true },
  });
  const replica = storage.accessForTestingOnly.openReplica(space);
  const fixture = {
    runtime,
    replica,
    emit: (_plans: readonly ViewPlan[]) => {},
    interests: [] as ViewInterest[],
    interestRequests: 0,
    onInterests: (_views: ViewInterest[]): Promise<boolean> =>
      Promise.resolve(true),
    restore: [] as (() => void)[],

    /** Mounts `root` as the view `screen`, and returns its cancel. */
    async mount(root: Cell<unknown>): Promise<() => void> {
      const cancel = await runtime.viewReplication.mount(root, "screen");
      if (cancel === undefined) {
        throw new Error("The mount returned no cancel.");
      }
      return cancel;
    },

    async dispose() {
      await runtime.dispose({ closeStorage: false });
      for (const undo of fixture.restore.reverse()) undo();
      await storage.close();
    },
  };
  fixture.restore.push(
    stub(replica, "supportsViewReplication", () => Promise.resolve(true))
      .restore,
    stub(replica, "viewReplicationSupported", () => true).restore,
    stub(replica, "subscribeViewPlans", (observer) => {
      fixture.emit = observer;
      observer([]);
      return () => {};
    }).restore,
    stub(replica, "setViewInterests", (views) => {
      fixture.interests = views;
      fixture.interestRequests++;
      return fixture.onInterests(views);
    }).restore,
  );
  return fixture;
};

describe("ViewReplicationClient", () => {
  describe("mount()", () => {
    it("returns `undefined`, and registers no view, when the client is disposed while the mount negotiates", async () => {
      const fixture = harness();
      try {
        const { runtime } = fixture;
        const root = runtime.getCell(space, "disposed mount", undefined);
        expect(await runtime.viewReplication.enable(space)).toBe(true);

        const mounting = runtime.viewReplication.mount(root, "screen");
        runtime.viewReplication.dispose();

        expect(await mounting).toBeUndefined();
        expect(fixture.interests).toEqual([]);
      } finally {
        await fixture.dispose();
      }
    });

    it("returns a cancel that requests nothing when the client is disposed while the mount's interest is sent", async () => {
      const fixture = harness();
      try {
        const { runtime } = fixture;
        const root = runtime.getCell(space, "late disposal", undefined);
        expect(await runtime.viewReplication.enable(space)).toBe(true);
        fixture.onInterests = (views) => {
          if (views.length > 0) runtime.viewReplication.dispose();
          return Promise.resolve(true);
        };

        const cancel = await fixture.mount(root);
        const requests = fixture.interestRequests;
        cancel();
        await runtime.idle();

        expect(fixture.interestRequests).toBe(requests);
      } finally {
        await fixture.dispose();
      }
    });

    it("returns a cancel that withdraws the view's interest when the client stays live", async () => {
      const fixture = harness();
      try {
        const { runtime } = fixture;
        const root = runtime.getCell(space, "live mount", undefined);

        const cancel = await fixture.mount(root);
        expect(fixture.interests.map((view) => view.id)).toEqual(["screen"]);
        cancel();
        await runtime.idle();

        expect(fixture.interests).toEqual([]);
      } finally {
        await fixture.dispose();
      }
    });
  });

  describe("enable()", () => {
    it("rejects, and leaves the owner that replaced it current, when its first interest fails after another owner took the replica", async () => {
      const fixture = harness();
      try {
        const { runtime, replica } = fixture;
        let replacement: ReturnType<typeof replica.acquireViewInterests>;
        fixture.onInterests = () => {
          replacement = replica.acquireViewInterests(() => {});
          return Promise.reject(new Error("Interest refused"));
        };

        await expect(runtime.viewReplication.enable(space)).rejects.toThrow(
          "Interest refused",
        );

        expect(runtime.viewReplication.active(space)).toBe(false);
        expect(replacement!.isCurrent()).toBe(true);
        replacement!.release();
      } finally {
        await fixture.dispose();
      }
    });
  });

  describe("piece installation", () => {
    it("starts no further piece of a plan that a newer plan replaced while an earlier piece started", async () => {
      const fixture = harness();
      try {
        const { runtime } = fixture;
        const first = runtime.getCell(space, "first piece", undefined);
        const second = runtime.getCell(space, "second piece", undefined);
        let cancellations = 0;
        const started: string[] = [];
        const emitted: ViewPlan[] = [];
        fixture.restore.push(
          stub(runtime.runner, "startViewPiece", (cell) => {
            started.push(cell.getAsNormalizedFullLink().id);
            fixture.emit([{ ...emitted[0], generation: 2, pieces: [] }]);
            return Promise.resolve(Object.assign(() => cancellations++, {
              graphIsInstalled: () => true,
              resume: () => true,
            }));
          }).restore,
        );
        const cancel = await fixture.mount(first);
        const plan: ViewPlan = {
          id: "screen",
          revision: fixture.interests[0].revision,
          generation: 1,
          eligibleActions: [],
          pieces: [first, second].map((cell) => ({
            id: cell.getAsNormalizedFullLink().id,
            scope: "space" as const,
            patternIdentity: "piece#default",
          })),
        };

        emitted.push(plan);
        fixture.emit([plan]);
        await runtime.idle();

        expect(started).toEqual([first.getAsNormalizedFullLink().id]);
        expect(cancellations).toBe(1);
        cancel();
        await runtime.idle();
      } finally {
        await fixture.dispose();
      }
    });
  });

  describe("with a planned piece and its producers", () => {
    // `visible` reads `left` and `right`; `leftWriter` and `rightWriter`
    // write those and both read `shared`, which `sharedWriter` writes.

    const plannedHarness = async () => {
      const fixture = harness();
      const { runtime, replica } = fixture;
      const cell = (name: string) =>
        runtime.getCell<number>(space, `planned ${name}`, { type: "number" });
      const root = runtime.getCell(space, "planned root", undefined);
      const cells = {
        left: cell("left"),
        right: cell("right"),
        shared: cell("shared"),
        output: cell("output"),
      };
      await runtime.editWithRetry((tx) => {
        root.withTx(tx).setMetaRaw(
          "patternIdentity",
          source,
          rawMetaWriteAuthorization,
        );
        for (const each of Object.values(cells)) each.withTx(tx).set(1);
      });
      await runtime.storageManager.synced();
      const uncovered = new Set<string>();
      const hasCoverage = replica.hasLocalDocumentCoverage.bind(replica);
      fixture.restore.push(
        stub(
          replica,
          "hasLocalDocumentCoverage",
          (id, scope) => !uncovered.has(id) && hasCoverage(id, scope),
        ).restore,
        stub(runtime.runner, "startViewPiece", () => Promise.resolve(undefined))
          .restore,
      );
      await runtime.viewReplication.mount(root, "screen");
      const basis = (of: Cell<number>) => {
        const link = of.getAsNormalizedFullLink();
        const path = ["value", ...link.path];
        return {
          id: link.id,
          scope: link.scope,
          path,
          fingerprint: viewInputFingerprint(
            replica.getDocument(link.id, link.scope),
            path,
          ),
        };
      };
      fixture.emit([{
        id: "screen",
        revision: fixture.interests[0].revision,
        generation: 1,
        eligibleActions: ["visible"],
        inputs: [cells.left, cells.right, cells.output].map((each) =>
          each.getAsNormalizedFullLink()
        ),
        pieces: [{
          ...root.getAsNormalizedFullLink(),
          patternIdentity: identity,
        }],
        producers: [{
          id: "visible",
          writes: [basis(cells.output)],
          basis: {
            reads: [basis(cells.left), basis(cells.right)],
            outputs: [basis(cells.output)],
          },
        }, {
          id: "leftWriter",
          writes: [basis(cells.left)],
          basis: { reads: [basis(cells.shared)], outputs: [basis(cells.left)] },
        }, {
          id: "rightWriter",
          writes: [basis(cells.right)],
          basis: {
            reads: [basis(cells.shared)],
            outputs: [basis(cells.right)],
          },
        }, {
          id: "sharedWriter",
          writes: [basis(cells.shared)],
          basis: { reads: [], outputs: [basis(cells.shared)] },
        }],
      }]);
      await runtime.idle();
      return { fixture, root, cells, uncovered };
    };

    it("collects the basis of a producer two ancestors share once", async () => {
      const { fixture, root, cells } = await plannedHarness();
      try {
        const dependencies = fixture.runtime.viewReplication
          .initialViewDependencies(
            root.getAsNormalizedFullLink(),
            "visible",
            identity,
          );

        const shared = cells.shared.getAsNormalizedFullLink().id;
        const left = cells.left.getAsNormalizedFullLink().id;
        const count = (id: string) =>
          dependencies!.reads.filter((read) => read.id === id).length;
        // `shared` is read by both writers and written by `sharedWriter`.
        expect(count(shared)).toBe(3);
        // `left` is read by `visible` and written by `leftWriter`.
        expect(count(left)).toBe(2);
      } finally {
        await fixture.dispose();
      }
    });

    describe("pieceCurrent()", () => {
      it("returns `true` for a planned piece whose document the replica holds with the planned source", async () => {
        const { fixture, root } = await plannedHarness();
        try {
          expect(
            fixture.runtime.viewReplication.pieceCurrent(
              root.getAsNormalizedFullLink(),
              identity,
            ),
          ).toBe(true);
        } finally {
          await fixture.dispose();
        }
      });

      it("returns `false` for a planned piece whose document the replica does not hold", async () => {
        const { fixture, root, uncovered } = await plannedHarness();
        try {
          uncovered.add(root.getAsNormalizedFullLink().id);

          expect(
            fixture.runtime.viewReplication.pieceCurrent(
              root.getAsNormalizedFullLink(),
              identity,
            ),
          ).toBe(false);
        } finally {
          await fixture.dispose();
        }
      });
    });
  });
});
