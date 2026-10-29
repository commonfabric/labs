import type { GithubClient } from "@commonfabric/github-connector/client";
import type { GithubFabricTarget } from "@commonfabric/github-connector/fabric";
import type {
  GithubPullRequest,
  GithubPullRequestCollection,
} from "@commonfabric/github-connector/types";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { GithubHost } from "../src/host.ts";

class FakeTarget {
  readonly collections: GithubPullRequestCollection[] = [];
  readonly healthValues: object[] = [];
  priorPullRequests: GithubPullRequest[] = [];
  priorLastComplete?: { completedAt: string; pullRequestCount: number };
  nextCompletedAt = "2026-08-21T00:00:00.000Z";

  readPullRequests(): Promise<GithubPullRequest[]> {
    return Promise.resolve(structuredClone(this.priorPullRequests));
  }

  publish(collection: GithubPullRequestCollection) {
    this.collections.push(structuredClone(collection));
    return Promise.resolve({
      completedAt: this.nextCompletedAt,
      pullRequestCount: collection.pullRequests.length,
    });
  }

  publishHealth(value: object): Promise<void> {
    this.healthValues.push(structuredClone(value));
    return Promise.resolve();
  }

  readLastComplete() {
    return Promise.resolve(structuredClone(this.priorLastComplete));
  }

  indexCellId(): string {
    return "index";
  }

  healthCellId(): string {
    return "health";
  }
}

describe("GithubHost", () => {
  describe("instance members", () => {
    describe("synchronize()", () => {
      it("publishes a complete collection and ready health", async () => {
        const collection: GithubPullRequestCollection = {
          viewer: "ianh",
          observedAt: "2026-08-21T00:00:00.000Z",
          pullRequests: [],
        };
        const target = new FakeTarget();
        target.nextCompletedAt = "2026-08-21T00:05:00.000Z";
        target.priorPullRequests = [{ id: "prior" }] as GithubPullRequest[];
        target.priorLastComplete = {
          completedAt: "2026-08-20T00:00:00.000Z",
          pullRequestCount: 1,
        };
        let prior: ReadonlyArray<GithubPullRequest> | undefined;
        const client = {
          collectOpenPullRequests: (
            _signal?: AbortSignal,
            previouslyKnown?: ReadonlyArray<GithubPullRequest>,
          ) => {
            prior = previouslyKnown;
            return Promise.resolve(collection);
          },
        } as unknown as GithubClient;
        const host = new GithubHost({
          client,
          target: target as unknown as GithubFabricTarget,
          spaceDid: "did:key:test",
          clock: () => new Date("2026-08-21T00:00:00.000Z"),
        });

        await host.start();
        expect(target.healthValues[0]).toMatchObject({
          status: "starting",
          lastComplete: target.priorLastComplete,
        });
        expect(await host.synchronize("initial")).toBe(0);

        expect(target.collections).toEqual([collection]);
        expect(prior).toEqual(target.priorPullRequests);
        expect(host.health().status).toBe("ready");
        expect(host.health().sync?.status).toBe("complete");
        expect(host.health().sync?.completedAt).toBe(target.nextCompletedAt);
        expect(target.healthValues.at(-1)).toMatchObject({
          status: "ready",
          sync: { status: "complete" },
          lastComplete: {
            completedAt: target.nextCompletedAt,
            pullRequestCount: 0,
          },
        });
      });

      it("retains the last index when GitHub collection fails", async () => {
        const prior = [{ id: "prior" }] as GithubPullRequest[];
        let collectionCount = 0;
        const client = {
          collectOpenPullRequests: () => {
            collectionCount++;
            return collectionCount === 1
              ? Promise.resolve({
                viewer: "ianh",
                observedAt: "2026-08-20T00:00:00.000Z",
                pullRequests: prior,
              })
              : Promise.reject(new Error("offline"));
          },
        } as unknown as GithubClient;
        const target = new FakeTarget();
        target.priorPullRequests = prior;
        const host = new GithubHost({
          client,
          target: target as unknown as GithubFabricTarget,
          spaceDid: "did:key:test",
          clock: () => new Date("2026-08-21T00:00:00.000Z"),
        });

        await host.start();
        await host.synchronize("initial");
        await expect(host.synchronize("periodic")).rejects.toThrow("offline");

        expect(target.collections).toHaveLength(1);
        expect(target.priorPullRequests).toEqual(prior);
        expect(host.health().status).toBe("degraded");
        expect(host.health().sync?.status).toBe("failed");
        expect(host.health().sync?.error).toBe("offline");
        expect(host.health().lastComplete).toEqual({
          completedAt: "2026-08-21T00:00:00.000Z",
          pullRequestCount: 1,
        });
        expect(target.healthValues.at(-1)).toMatchObject({
          status: "degraded",
          sync: { status: "failed", error: "offline" },
          lastComplete: { pullRequestCount: 1 },
        });
      });

      it("restores last-complete health before an offline startup", async () => {
        const target = new FakeTarget();
        target.priorLastComplete = {
          completedAt: "2026-08-20T00:00:00.000Z",
          pullRequestCount: 3,
        };
        const client = {
          collectOpenPullRequests: () => Promise.reject(new Error("offline")),
        } as unknown as GithubClient;
        const host = new GithubHost({
          client,
          target: target as unknown as GithubFabricTarget,
          spaceDid: "did:key:test",
          clock: () => new Date("2026-08-21T00:00:00.000Z"),
        });

        await host.start();
        await expect(host.synchronize("initial")).rejects.toThrow("offline");

        expect(target.healthValues.at(-1)).toMatchObject({
          status: "degraded",
          sync: { status: "failed", error: "offline" },
          lastComplete: target.priorLastComplete,
        });
      });

      it("reports collection and degraded-health failures together", async () => {
        const target = new FakeTarget();
        let healthPublications = 0;
        target.publishHealth = (value: object) => {
          target.healthValues.push(structuredClone(value));
          healthPublications++;
          return healthPublications === 3
            ? Promise.reject(new Error("health cell unavailable"))
            : Promise.resolve();
        };
        const client = {
          collectOpenPullRequests: () => Promise.reject(new Error("offline")),
        } as unknown as GithubClient;
        const host = new GithubHost({
          client,
          target: target as unknown as GithubFabricTarget,
          spaceDid: "did:key:test",
          clock: () => new Date("2026-08-21T00:00:00.000Z"),
        });

        await host.start();
        await expect(host.synchronize("initial")).rejects.toThrow(
          "GitHub collection and health publication failed",
        );
        expect(target.healthValues.at(-1)).toMatchObject({
          status: "degraded",
          sync: { status: "failed", error: "offline" },
        });
      });
    });
  });
});
