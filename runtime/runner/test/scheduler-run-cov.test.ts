import { expect } from "@std/expect";

import { resolveScopeKey, type ScopeKey } from "@commonfabric/memory/v2";
import { describe, it } from "@commonfabric/test-support/test";

import { invalidCauseKey } from "../src/scheduler/keys.ts";
import { causesForInstance } from "../src/scheduler/run.ts";
import type { Action } from "../src/scheduler/types.ts";
import { restrictToLocalReads } from "../src/storage/local-read-policy.ts";
import {
  createSchedulerTestRuntime,
  disposeSchedulerTestRuntime,
  space as testSpace,
} from "./scheduler-test-utils.ts";
import type { IMemorySpaceAddress } from "../src/storage/interface.ts";

const space = "did:key:causes" as IMemorySpaceAddress["space"];
const userP = resolveScopeKey("user", { principal: "did:key:p" });
const userQ = resolveScopeKey("user", { principal: "did:key:q" });
const sessionP1 = resolveScopeKey("session", {
  principal: "did:key:p",
  sessionId: "s1",
});
const sessionP2 = resolveScopeKey("session", {
  principal: "did:key:p",
  sessionId: "s2",
});

/** A cause naming the instance `scopeKey`, or no instance. */
function cause(id: string, scopeKey?: ScopeKey): IMemorySpaceAddress {
  return {
    space,
    id: `of:${id}`,
    path: [],
    ...(scopeKey === undefined ? {} : { scopeKey }),
  };
}

const untargeted = cause("untargeted");
const spaceKeyed = cause("space", "space");
const causes = [
  untargeted,
  spaceKeyed,
  cause("user-p", userP),
  cause("user-q", userQ),
  cause("session-p1", sessionP1),
  cause("session-p2", sessionP2),
];

/**
 * The ids of the causes an instance run carries, where the instance read the
 * documents of the causes `read` that name no instance.
 */
function carried(
  identity: Parameters<typeof resolveScopeKey>[1],
  read: readonly IMemorySpaceAddress[] = [],
): string[] {
  return causesForInstance(
    causes,
    { identity, key: "space" },
    new Set(read.map(invalidCauseKey)),
  ).map((address) => address.id);
}

describe("scheduler run", () => {
  describe("causesForInstance()", () => {
    it("returns the causes keyed to the instance identity's user and session, and those naming no instance whose documents the instance read", () => {
      expect(
        carried({ principal: "did:key:p", sessionId: "s1" }, [
          untargeted,
          spaceKeyed,
        ]),
      ).toEqual([
        "of:untargeted",
        "of:space",
        "of:user-p",
        "of:session-p1",
      ]);
    });

    it("returns none of the causes naming no instance for an instance that read none of their documents", () => {
      expect(carried({ principal: "did:key:p", sessionId: "s1" })).toEqual([
        "of:user-p",
        "of:session-p1",
      ]);
      expect(
        causesForInstance(causes, {
          identity: { principal: "did:key:p", sessionId: "s1" },
          key: "space",
        }, undefined).map((address) => address.id),
      ).toEqual(["of:user-p", "of:session-p1"]);
    });

    it("returns only the cause naming no instance whose document the instance read", () => {
      expect(carried({ principal: "did:key:q" }, [spaceKeyed])).toEqual([
        "of:space",
        "of:user-q",
      ]);
    });

    it("returns the causes keyed to the principal's user instance and none of its sessions for an identity with no session", () => {
      expect(carried({ principal: "did:key:p" }, [untargeted, spaceKeyed]))
        .toEqual([
          "of:untargeted",
          "of:space",
          "of:user-p",
        ]);
    });

    it("returns only the causes naming no instance for an identity with no principal", () => {
      expect(carried({}, [untargeted, spaceKeyed])).toEqual([
        "of:untargeted",
        "of:space",
      ]);
    });
  });

  describe("a run whose local read is unavailable", () => {
    it("leaves an action that retired as its transaction aborted unregistered, and does not run it again", async () => {
      const fixture = createSchedulerTestRuntime(import.meta.url);
      const { runtime } = fixture;
      try {
        const input = runtime.getCell<number>(testSpace, "retiring input");
        await runtime.editWithRetry((tx) => input.withTx(tx).set(1));
        await input.sync();

        let runs = 0;
        const action: Action = (tx) => {
          runs++;
          restrictToLocalReads(tx.tx, () => () => false);
          tx.addCommitCallback(() => runtime.scheduler.unsubscribe(action));
          input.withTx(tx).get();
        };
        runtime.scheduler.subscribe(action, { isEffect: true });
        await runtime.idle();

        expect(runs).toBe(1);
        const { nodes } = runtime.scheduler.accessForTestingOnly;
        expect(nodes.effects.has(action)).toBe(false);
        expect(nodes.get(action)?.status).not.toBe("unavailable");

        await runtime.editWithRetry((tx) => input.withTx(tx).set(2));
        await runtime.idle();
        expect(runs).toBe(1);
      } finally {
        await disposeSchedulerTestRuntime(fixture);
      }
    });
  });
  describe("a direct run of an action subscribed while it runs", () => {
    it("counts as the subscription's first run, so the action runs once", async () => {
      const fixture = createSchedulerTestRuntime(import.meta.url);
      const { runtime } = fixture;
      try {
        const input = runtime.getCell<number>(testSpace, "direct run input");
        await runtime.editWithRetry((tx) => input.withTx(tx).set(1));

        const started = Promise.withResolvers<void>();
        const proceed = Promise.withResolvers<void>();
        const seen: number[] = [];
        const action: Action = async (tx) => {
          started.resolve();
          await proceed.promise;
          seen.push(input.withTx(tx).get());
        };
        const ran = runtime.scheduler.run(action);
        await started.promise;
        runtime.scheduler.subscribe(action, { isEffect: true });
        proceed.resolve();
        await ran;
        await runtime.idle();

        expect(seen).toEqual([1]);
        expect(runtime.scheduler.accessForTestingOnly.nodes.get(action)?.status)
          .toBe("clean");

        await runtime.editWithRetry((tx) => input.withTx(tx).set(2));
        await runtime.idle();
        expect(seen).toEqual([1, 2]);
      } finally {
        await disposeSchedulerTestRuntime(fixture);
      }
    });
  });
});
